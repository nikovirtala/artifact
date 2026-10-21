// The viewing plane of `ArtifactHosting` (docs/decisions/0079, 0080, 0082, 0083, 0085): the
// viewing Lambda behind an AWS_IAM function URL and OAC, one CloudFront distribution for
// `<view>` and `*.<view>` with the viewer-request function and its KeyValueStore, the session
// keys and their custom resource, and the records. A function, not a construct: every resource
// and output has scope `hosting`, so logical ids stay `Artifacts<Id><hash>`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CfnOutput,
  CustomResource,
  Duration,
  Names,
  RemovalPolicy,
  SecretValue,
  Stack,
} from "aws-cdk-lib";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  type BehaviorOptions,
  CacheCookieBehavior,
  CachedMethods,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  Function as EdgeFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  FunctionUrlOriginAccessControl,
  HttpVersion,
  KeyValueStore,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { FunctionUrlOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import type { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Alias,
  Architecture,
  CfnPermission,
  Code,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, type RetentionDays } from "aws-cdk-lib/aws-logs";
import { AaaaRecord, ARecord, type IHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { ArtifactHosting } from "./artifact-hosting.ts";
import { assetDir } from "./assets.ts";
import { renderEdgeFunction } from "./edge.ts";
import { viewingEnvironment } from "./env.ts";
import type { ArtifactIdentityBinding } from "./identity.ts";
import type { ResolvedViewing } from "./validate.ts";

/** The resolved inputs of the viewing plane. */
export interface ViewingPlaneProps {
  readonly viewDomain: string;
  readonly hostedZone: IHostedZone;
  readonly certificate: ICertificate;
  readonly bucket: Bucket;
  readonly identity: ArtifactIdentityBinding;
  readonly viewing: ResolvedViewing;
  readonly logRetention: RetentionDays;
  /** Only with `alarmEmail`. */
  readonly alarmAction?: SnsAction;
}

/** What `buildViewingPlane` created, for the construct's public properties. */
export interface ViewingPlane {
  readonly distribution: Distribution;
  readonly viewFunction: LambdaFunction;
  readonly viewFunctionUrl: FunctionUrl;
  readonly viewAlias?: Alias;
  readonly viewLogGroup: LogGroup;
  readonly viewerRequestFunction: EdgeFunction;
  readonly keyValueStore: KeyValueStore;
  readonly sessionSecret: Secret;
  readonly sessionKeysFunction: LambdaFunction;
  readonly viewCachePolicy: CachePolicy;
  readonly viewOriginRequestPolicy: OriginRequestPolicy;
  readonly loginOriginRequestPolicy: OriginRequestPolicy;
}

/** The placeholder key set (docs/decisions/0078); not key material. */
const EMPTY_SESSION_KEYS = '{"version":1,"current":null,"keys":{}}';

const LOGIN_PATHS = ["/__artifact/login", "/__artifact/callback", "/__artifact/logout"];

/** CloudFront caches these errors for 10 s by default; never cache them (F7). */
const ERROR_STATUSES = [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504];

/**
 * An account-global CloudFront name: unique for the scope (the hash survives truncation), a
 * per-resource part so names of one instance differ, and the stack's Region.
 */
const regionalName = (scope: Construct, part: string, maxLength: number) =>
  `${Names.uniqueResourceName(scope, { maxLength })}-${part}-${Stack.of(scope).region}`;

export function buildViewingPlane(
  hosting: ArtifactHosting,
  props: ViewingPlaneProps,
): ViewingPlane {
  const { viewDomain, bucket, identity, viewing } = props;
  const logGroup = (name: string) =>
    new LogGroup(hosting, name, {
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

  // A CloudFormation update of this resource would re-apply SecretString and wipe the keys the
  // custom resource wrote: keep it exactly as it is; a construct test pins it (0079).
  const sessionSecret = new Secret(hosting, "SessionSecret", {
    secretStringValue: SecretValue.unsafePlainText(EMPTY_SESSION_KEYS),
    removalPolicy: RemovalPolicy.DESTROY,
  });
  // Created empty: keys are written at deploy time and never appear in a template (0079).
  const keyValueStore = new KeyValueStore(hosting, "KeyValueStore", {
    keyValueStoreName: regionalName(hosting, "Kvs", 40),
  });

  // Read-only: no write permission of any kind; the session key is for signing (0082).
  const viewLogGroup = logGroup("ViewLogGroup");
  const viewRole = new Role(hosting, "ViewRole", {
    assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  });
  for (const statement of [
    new PolicyStatement({ actions: ["s3:GetObject"], resources: [bucket.arnForObjects("*")] }),
    new PolicyStatement({ actions: ["s3:ListBucket"], resources: [bucket.bucketArn] }),
    new PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [sessionSecret.secretArn],
    }),
    new PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [viewLogGroup.logGroupArn],
    }),
  ]) {
    viewRole.addToPrincipalPolicy(statement);
  }
  const viewFunction = new LambdaFunction(hosting, "ViewFunction", {
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: 512,
    timeout: Duration.seconds(10),
    code: Code.fromAsset(assetDir("viewing")),
    handler: "index.handler",
    logGroup: viewLogGroup,
    role: viewRole,
    reservedConcurrentExecutions: viewing.reservedConcurrency,
    environment: viewingEnvironment({
      bucket: bucket.bucketName,
      viewDomain,
      sessionSecretArn: sessionSecret.secretArn,
      oidc: identity.oidc,
      owners: identity.owners,
    }),
  });
  const viewAlias =
    viewing.provisionedConcurrency === undefined
      ? undefined
      : new Alias(hosting, "ViewAlias", {
          aliasName: "live",
          version: viewFunction.currentVersion,
          provisionedConcurrentExecutions: viewing.provisionedConcurrency,
        });
  // Only this distribution can call it (OAC signs every request), so the origin may trust the
  // x-artifact-host header the edge sets (0082). Not "ViewFunctionUrl": that is the output's id,
  // and one scope cannot hold two children with one id.
  const viewFunctionUrl = new FunctionUrl(hosting, "ViewFunctionUrlResource", {
    function: viewAlias ?? viewFunction,
    authType: FunctionUrlAuthType.AWS_IAM,
    invokeMode: InvokeMode.BUFFERED,
  });

  // Keys: written to the KVS first, then (15 s later) to the secret, by a Lambda-backed custom
  // resource without the Provider framework (0079).
  const sessionKeysLogGroup = logGroup("SessionKeysLogGroup");
  const sessionKeysRole = new Role(hosting, "SessionKeysRole", {
    assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  });
  for (const statement of [
    new PolicyStatement({
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
      resources: [sessionSecret.secretArn],
    }),
    new PolicyStatement({
      actions: [
        "cloudfront-keyvaluestore:DescribeKeyValueStore",
        "cloudfront-keyvaluestore:ListKeys",
        "cloudfront-keyvaluestore:UpdateKeys",
      ],
      resources: [keyValueStore.keyValueStoreArn],
    }),
    new PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [sessionKeysLogGroup.logGroupArn],
    }),
  ]) {
    sessionKeysRole.addToPrincipalPolicy(statement);
  }
  const sessionKeysFunction = new LambdaFunction(hosting, "SessionKeysFunction", {
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: 256,
    // Worst case: a 60 s READY poll, the 15 s propagation wait and the API calls.
    timeout: Duration.seconds(120),
    code: Code.fromAsset(assetDir("session-keys")),
    handler: "index.handler",
    logGroup: sessionKeysLogGroup,
    role: sessionKeysRole,
  });
  const sessionKeys = new CustomResource(hosting, "SessionKeys", {
    serviceToken: sessionKeysFunction.functionArn,
    resourceType: "Custom::ArtifactSessionKeys",
    serviceTimeout: Duration.minutes(5),
    properties: {
      SecretArn: sessionSecret.secretArn,
      KeyValueStoreArn: keyValueStore.keyValueStoreArn,
      Rotation: viewing.sessionKeyRotation,
    },
  });

  const viewerRequestFunction = new EdgeFunction(hosting, "ViewerRequestFunction", {
    runtime: FunctionRuntime.JS_2_0,
    keyValueStore,
    code: FunctionCode.fromInline(
      renderEdgeFunction(
        readFileSync(join(assetDir("edge", "viewer-request.js"), "viewer-request.js"), "utf8"),
        viewDomain,
      ),
    ),
  });
  // The cache key: the viewer's host (set by the edge), path, query and encoding; no cookie.
  const viewCachePolicy = new CachePolicy(hosting, "ViewCachePolicy", {
    headerBehavior: CacheHeaderBehavior.allowList("x-artifact-host"),
    queryStringBehavior: CacheQueryStringBehavior.all(),
    cookieBehavior: CacheCookieBehavior.none(),
    // A response without Cache-Control is never cached; pinned files say a year themselves.
    minTtl: Duration.seconds(0),
    defaultTtl: Duration.seconds(0),
    maxTtl: Duration.days(365),
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
  });
  const originRequestPolicy = (id: string, part: string, cookies: OriginRequestCookieBehavior) =>
    new OriginRequestPolicy(hosting, id, {
      originRequestPolicyName: regionalName(hosting, part, 100),
      headerBehavior: OriginRequestHeaderBehavior.allowList("x-artifact-host"),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cookies,
    });
  const viewOriginRequestPolicy = originRequestPolicy(
    "ViewOriginRequestPolicy",
    "View",
    OriginRequestCookieBehavior.none(),
  );
  // Only the login-transaction cookie, so the callback's Set-Cookie gets through (0081, F6).
  const loginOriginRequestPolicy = originRequestPolicy(
    "LoginOriginRequestPolicy",
    "Login",
    OriginRequestCookieBehavior.allowList("__Host-artifact_login"),
  );

  const origin = FunctionUrlOrigin.withOriginAccessControl(viewFunctionUrl, {
    originAccessControl: new FunctionUrlOriginAccessControl(hosting, "ViewOriginAccessControl", {
      originAccessControlName: regionalName(hosting, "Oac", 40),
    }),
  });
  const behavior = {
    origin,
    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
    cachedMethods: CachedMethods.CACHE_GET_HEAD,
    functionAssociations: [
      { function: viewerRequestFunction, eventType: FunctionEventType.VIEWER_REQUEST },
    ],
  } satisfies BehaviorOptions;
  const loginBehavior: BehaviorOptions = {
    ...behavior,
    cachePolicy: CachePolicy.CACHING_DISABLED,
    originRequestPolicy: loginOriginRequestPolicy,
    compress: false,
  };
  const distribution = new Distribution(hosting, "Distribution", {
    domainNames: [viewDomain, `*.${viewDomain}`],
    certificate: props.certificate,
    minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
    httpVersion: HttpVersion.HTTP2_AND_3,
    enableIpv6: true,
    defaultBehavior: {
      ...behavior,
      cachePolicy: viewCachePolicy,
      originRequestPolicy: viewOriginRequestPolicy,
      compress: true,
    },
    additionalBehaviors: Object.fromEntries(LOGIN_PATHS.map((path) => [path, loginBehavior])),
    errorResponses: ERROR_STATUSES.map((httpStatus) => ({ httpStatus, ttl: Duration.seconds(0) })),
  });
  // Never serve traffic from an edge without keys: a failed provisioning fails the deploy first.
  distribution.node.addDependency(sessionKeys);

  // CDK grants on the URL's FunctionArn; whether that is alias-qualified is not stated (F12), so
  // with an alias the alias ARN gets its own two permissions as well.
  if (viewAlias !== undefined) {
    const permission = {
      functionName: viewAlias.functionArn,
      principal: "cloudfront.amazonaws.com",
      sourceArn: distribution.distributionArn,
    };
    new CfnPermission(hosting, "ViewAliasInvokeUrlPermission", {
      ...permission,
      action: "lambda:InvokeFunctionUrl",
      functionUrlAuthType: FunctionUrlAuthType.AWS_IAM,
    });
    new CfnPermission(hosting, "ViewAliasInvokePermission", {
      ...permission,
      action: "lambda:InvokeFunction",
      invokedViaFunctionUrl: true,
    });
  }

  // The apex needs its own record; the specific api record keeps precedence over the wildcard.
  const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
  const zone = props.hostedZone;
  new ARecord(hosting, "ViewAliasRecord", { zone, recordName: viewDomain, target });
  new AaaaRecord(hosting, "ViewAliasRecordAaaa", { zone, recordName: viewDomain, target });
  new ARecord(hosting, "ViewWildcardRecord", { zone, recordName: `*.${viewDomain}`, target });
  new AaaaRecord(hosting, "ViewWildcardRecordAaaa", {
    zone,
    recordName: `*.${viewDomain}`,
    target,
  });

  // CloudFront's metrics live in its own Region only, so this stack alarms on the function.
  if (props.alarmAction !== undefined) {
    new Alarm(hosting, "ViewErrorsAlarm", {
      metric: viewFunction.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.alarmAction);
  }

  const output = (name: string, value: string) => new CfnOutput(hosting, name, { value });
  output("DistributionId", distribution.distributionId);
  output("DistributionDomainName", distribution.distributionDomainName);
  output("ViewFunctionUrl", viewFunctionUrl.url);
  output("ViewLogGroupName", viewLogGroup.logGroupName);
  output("ViewerRequestFunctionName", viewerRequestFunction.functionName);
  output("KeyValueStoreArn", keyValueStore.keyValueStoreArn);
  output("SessionSecretArn", sessionSecret.secretArn);
  output("SessionKeysLogGroupName", sessionKeysLogGroup.logGroupName);
  output("UserPoolId", identity.userPool.userPoolId);
  output("UserPoolClientId", identity.userPoolClient.userPoolClientId);
  output("LoginDomainUrl", identity.userPoolDomain.baseUrl());

  return {
    distribution,
    viewFunction,
    viewFunctionUrl,
    viewAlias,
    viewLogGroup,
    viewerRequestFunction,
    keyValueStore,
    sessionSecret,
    sessionKeysFunction,
    viewCachePolicy,
    viewOriginRequestPolicy,
    loginOriginRequestPolicy,
  };
}
