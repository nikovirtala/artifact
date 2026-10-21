// `ArtifactHosting` (docs/decisions/0071): artifact hosting on AWS under one construct scope. No
// physical names, accounts or Regions, so two instances in one stack or account never collide;
// safe defaults (private bucket, retained data, publish only through IAM).
import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  DomainName,
  EndpointType,
  HttpApi,
  type HttpMethod,
  HttpStage,
  LogGroupLogDestination,
  PayloadFormatVersion,
  SecurityPolicy,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from "aws-cdk-lib/aws-certificatemanager";
import type {
  CachePolicy,
  Function as CloudFrontFunction,
  Distribution,
  KeyValueStore,
  OriginRequestPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import {
  Alarm,
  ComparisonOperator,
  type IMetric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  type Alias,
  Architecture,
  Code,
  type FunctionUrl,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { ARecord, type IHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { Schedule, ScheduleExpression, ScheduleTargetInput } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import { assetDir } from "./assets.ts";
import { controlEnvironment, sweepEnvironment } from "./env.ts";
import { ArtifactIdentity, type ArtifactIdentityBinding } from "./identity.ts";
import { CONTROL_ROUTE_KEYS } from "./routes.ts";
import {
  checkAlarmEmail,
  checkApiHost,
  checkInZone,
  checkViewCertificate,
  domainName,
  literalDomainName,
  type ResolvedLimits,
  type ResolvedRetention,
  type ResolvedViewing,
  resolveLimits,
  resolveRetention,
  resolveThrottle,
  resolveViewing,
  zoneNameOf,
} from "./validate.ts";
import { buildViewingPlane } from "./viewing.ts";

export interface ArtifactViewDomain {
  /** Where artifacts are viewed: `https://<id>.<name>/`; the gallery is `https://<name>/`. */
  readonly name: string;
  /** Holds `name`; must carry its `zoneName`. The API's records go here by default. */
  readonly hostedZone: IHostedZone;
  /**
   * The view certificate for CloudFront (`ArtifactCertificate`) for the apex and `*.<name>`, in
   * US East (N. Virginia), the only Region CloudFront takes certificates from. Required unless
   * this stack's Region is literally that Region, where one is created (also required in an
   * environment-agnostic stack).
   */
  readonly certificate?: ICertificate;
}

export interface ArtifactApiDomain {
  /** The API host for `/api` and `/mcp`, e.g. `api.<view domain>`. */
  readonly name: string;
  /** Default: the view domain's zone. */
  readonly hostedZone?: IHostedZone;
  /** A certificate in this stack's Region; default: one is created and DNS-validated. */
  readonly certificate?: ICertificate;
}

export interface ArtifactViewing {
  /**
   * Cap on concurrent viewing invocations (a guard against a runaway bill); default 20.
   * Needs an account concurrency limit of at least 100 + the cap (Lambda keeps 100 unreserved),
   * so the default needs ≥ 120; use `false` (no cap) on accounts below that, including new
   * accounts that start at a concurrency limit of 10 (no cap of any size fits those).
   */
  readonly reservedConcurrency?: number | false;
  /**
   * Pre-warmed instances on a `live` alias; default none. Switching it on or off replaces the
   * function URL; the distribution updates its origin in place.
   */
  readonly provisionedConcurrency?: number;
  /** Session-key rotation label; change it and deploy to rotate (docs/decisions/0079); default "1". */
  readonly sessionKeyRotation?: string;
}

export interface ArtifactLimits {
  /** Default 3 MiB (3,145,728); at most 4 MiB. */
  readonly maxFileBytes?: number;
  /** Default 3 MiB; at most 4 MiB. */
  readonly maxPublishBytes?: number;
  /** Request body cap; default 4,500,000, at most 6,000,000, and ≥ ceil(maxPublishBytes × 4/3) + 65,536. */
  readonly maxBodyBytes?: number;
  /** Default and maximum 500. */
  readonly maxFiles?: number;
}

export interface ArtifactDataRetention {
  /** What `cdk destroy` does with the bucket: RETAIN (default) or DESTROY (emptied and deleted). */
  readonly onDestroy?: RemovalPolicy;
  /** Prune old versions daily; default: keep every version. The current and latest stay. */
  readonly versions?: { readonly keepLast?: number; readonly olderThan?: Duration };
}

export interface ArtifactHostingProps {
  /** `name` must be a literal: the edge function embeds it. */
  readonly viewDomain: ArtifactViewDomain;
  readonly apiDomain: ArtifactApiDomain;
  readonly identity: ArtifactIdentity;
  readonly limits?: ArtifactLimits;
  readonly dataRetention?: ArtifactDataRetention;
  /** Retention of the function and access logs; default one month. */
  readonly logRetention?: RetentionDays;
  /** API throttling; default 20 requests per second, bursts of 40. */
  readonly throttle?: { readonly rateLimit?: number; readonly burstLimit?: number };
  /** Alarms on errors go to this address through an SNS topic; default: no alarms. */
  readonly alarmEmail?: string;
  /** The viewing plane: concurrency and session-key rotation. */
  readonly viewing?: ArtifactViewing;
}

/** The validated props. */
type Config = {
  viewDomain: string;
  apiDomain: string;
  viewZone: IHostedZone;
  apiZone: IHostedZone;
  limits: ResolvedLimits;
  retention: ResolvedRetention;
  throttle: { rateLimit: number; burstLimit: number };
  logRetention: RetentionDays;
  alarmEmail?: string;
  viewing: ResolvedViewing;
};

function validate(props: ArtifactHostingProps, region: string): Config {
  if (!(props?.identity instanceof ArtifactIdentity)) {
    throw new Error(
      "identity must be an ArtifactIdentity, e.g. ArtifactIdentity.cognito({owners})",
    );
  }
  const viewDomain = literalDomainName("viewDomain.name", props.viewDomain?.name);
  const apiDomain = domainName("apiDomain.name", props.apiDomain?.name);
  checkApiHost(apiDomain, viewDomain);
  const viewZone = props.viewDomain.hostedZone;
  const apiZone = props.apiDomain.hostedZone ?? viewZone;
  const viewZoneName = zoneNameOf("viewDomain.hostedZone", viewZone);
  const apiZoneName =
    props.apiDomain.hostedZone === undefined
      ? viewZoneName
      : zoneNameOf("apiDomain.hostedZone", apiZone);
  checkInZone("viewDomain.name", viewDomain, viewZoneName);
  checkInZone("apiDomain.name", apiDomain, apiZoneName);
  checkViewCertificate(props.viewDomain.certificate, region);
  return {
    viewDomain,
    apiDomain,
    viewZone,
    apiZone,
    limits: resolveLimits(props.limits),
    retention: resolveRetention(props.dataRetention),
    throttle: resolveThrottle(props.throttle),
    logRetention: props.logRetention ?? RetentionDays.ONE_MONTH,
    alarmEmail: checkAlarmEmail(props.alarmEmail),
    viewing: resolveViewing(props.viewing),
  };
}

/** The access log of the HTTP API: named `$context` fields only, never a header (A5). */
const ACCESS_LOG_FORMAT = JSON.stringify({
  requestId: "$context.requestId",
  time: "$context.requestTimeEpoch",
  method: "$context.httpMethod",
  path: "$context.path",
  routeKey: "$context.routeKey",
  protocol: "$context.protocol",
  status: "$context.status",
  responseLength: "$context.responseLength",
  latency: "$context.responseLatency",
  integrationLatency: "$context.integrationLatency",
  integrationStatus: "$context.integrationStatus",
  integrationError: "$context.integrationErrorMessage",
  error: "$context.error.message",
  sourceIp: "$context.identity.sourceIp",
  domain: "$context.domainName",
});

/** The empty token list (docs/decisions/0065); not a secret. */
const EMPTY_TOKEN_SECRET = '{"version":1,"tokens":[]}';

export class ArtifactHosting extends Construct {
  /** `https://<apiDomain.name>`: the CLI's `--server` and the MCP base URL. */
  readonly apiUrl: string;
  /** `https://<viewDomain.name>/`: the gallery. */
  readonly viewUrl: string;
  readonly bucket: Bucket;
  /** The SHA-256 hashes of the API tokens (`artifact token`). */
  readonly tokenSecret: Secret;
  readonly httpApi: HttpApi;
  readonly apiDomainName: DomainName;
  readonly apiCertificate: ICertificate;
  readonly controlFunction: LambdaFunction;
  readonly sweepFunction: LambdaFunction;
  /** Assumed by EventBridge Scheduler to invoke the sweep function. */
  readonly schedulerRole: Role;
  readonly sweepSchedule: Schedule;
  /** Only with `dataRetention.versions`. */
  readonly pruneSchedule?: Schedule;
  readonly accessLogGroup: LogGroup;
  readonly identity: ArtifactIdentityBinding;
  /** The distribution's certificate: `viewDomain.certificate`, or the one created here. */
  readonly viewCertificate: ICertificate;
  /** Only with `alarmEmail`. */
  readonly alarmTopic?: Topic;
  /** Serves `<view>` and `*.<view>` from the viewing function, behind the session check. */
  readonly distribution: Distribution;
  readonly viewFunction: LambdaFunction;
  /** `AWS_IAM`: only the distribution (OAC) can call it. */
  readonly viewFunctionUrl: FunctionUrl;
  /** Only with `viewing.provisionedConcurrency`. */
  readonly viewAlias?: Alias;
  readonly viewLogGroup: LogGroup;
  readonly viewerRequestFunction: CloudFrontFunction;
  /** The session keys the edge verifies with, by `kid`. */
  readonly keyValueStore: KeyValueStore;
  /** The session key set the viewing function signs with. */
  readonly sessionSecret: Secret;
  /** Provisions and rotates the session keys (the `SessionKeys` custom resource). */
  readonly sessionKeysFunction: LambdaFunction;
  readonly viewCachePolicy: CachePolicy;
  readonly viewOriginRequestPolicy: OriginRequestPolicy;
  readonly loginOriginRequestPolicy: OriginRequestPolicy;

  constructor(scope: Construct, id: string, props: ArtifactHostingProps) {
    super(scope, id);
    const config = validate(props, Stack.of(this).region);
    this.apiUrl = `https://${config.apiDomain}`;
    this.viewUrl = `https://${config.viewDomain}/`;
    // Only a stack in CloudFront's certificate Region gets here without one (checkViewCertificate).
    this.viewCertificate =
      props.viewDomain.certificate ??
      new Certificate(this, "ViewCertificate", {
        domainName: config.viewDomain,
        subjectAlternativeNames: [`*.${config.viewDomain}`],
        validation: CertificateValidation.fromDns(config.viewZone),
      });

    const destroy = config.retention.onDestroy === RemovalPolicy.DESTROY;
    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: false,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: config.retention.onDestroy,
      autoDeleteObjects: destroy,
    });

    this.identity = props.identity._bind(this, { viewDomain: config.viewDomain });

    // A CloudFormation update of this resource may re-apply SecretString and wipe the stored
    // tokens (0065): keep it exactly as it is; a construct test pins it.
    this.tokenSecret = new Secret(this, "TokenSecret", {
      secretStringValue: SecretValue.unsafePlainText(EMPTY_TOKEN_SECRET),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = (name: string) =>
      new LogGroup(this, name, {
        retention: config.logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    // Explicit statements, no grant*: those add bucket-level reads, tagging and more (0070).
    const functionRole = (name: string, group: LogGroup, extra: PolicyStatement[]) => {
      const role = new Role(this, name, {
        assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      });
      for (const statement of [
        new PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [this.bucket.arnForObjects("*")],
        }),
        new PolicyStatement({ actions: ["s3:ListBucket"], resources: [this.bucket.bucketArn] }),
        new PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [group.logGroupArn],
        }),
        ...extra,
      ]) {
        role.addToPrincipalPolicy(statement);
      }
      return role;
    };

    const controlLogGroup = logGroup("ControlLogGroup");
    this.controlFunction = new LambdaFunction(this, "ControlFunction", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(30),
      code: Code.fromAsset(assetDir("control")),
      handler: "index.handler",
      logGroup: controlLogGroup,
      role: functionRole("ControlRole", controlLogGroup, [
        new PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [this.tokenSecret.secretArn],
        }),
      ]),
      environment: controlEnvironment({
        bucket: this.bucket.bucketName,
        viewDomain: config.viewDomain,
        tokenSecretArn: this.tokenSecret.secretArn,
        limits: config.limits,
      }),
    });

    const sweepLogGroup = logGroup("SweepLogGroup");
    this.sweepFunction = new LambdaFunction(this, "SweepFunction", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      code: Code.fromAsset(assetDir("sweep")),
      handler: "index.handler",
      logGroup: sweepLogGroup,
      role: functionRole("SweepRole", sweepLogGroup, []),
      environment: sweepEnvironment({ bucket: this.bucket.bucketName, limits: config.limits }),
    });

    this.apiCertificate =
      props.apiDomain.certificate ??
      new Certificate(this, "ApiCertificate", {
        domainName: config.apiDomain,
        validation: CertificateValidation.fromDns(config.apiZone),
      });
    this.apiDomainName = new DomainName(this, "ApiDomainName", {
      domainName: config.apiDomain,
      certificate: this.apiCertificate,
      endpointType: EndpointType.REGIONAL,
      securityPolicy: SecurityPolicy.TLS_1_2,
    });
    new ARecord(this, "ApiAliasRecord", {
      zone: config.apiZone,
      recordName: config.apiDomain,
      target: RecordTarget.fromAlias(
        new ApiGatewayv2DomainProperties(
          this.apiDomainName.regionalDomainName,
          this.apiDomainName.regionalHostedZoneId,
        ),
      ),
    });

    // The custom domain is the only way in, so the control app only ever sees the API host.
    this.httpApi = new HttpApi(this, "HttpApi", {
      createDefaultStage: false,
      disableExecuteApiEndpoint: true,
    });
    const integration = new HttpLambdaIntegration("ControlIntegration", this.controlFunction, {
      payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
    });
    for (const key of Object.values(CONTROL_ROUTE_KEYS)) {
      const [method, path] = key.split(" ");
      this.httpApi.addRoutes({ path, methods: [method as HttpMethod], integration });
    }
    this.accessLogGroup = logGroup("AccessLogGroup");
    new HttpStage(this, "DefaultStage", {
      httpApi: this.httpApi,
      stageName: "$default",
      autoDeploy: true,
      throttle: config.throttle,
      // Mapped at the root, so the event's rawPath is the full path (A4).
      domainMapping: { domainName: this.apiDomainName },
      accessLogSettings: {
        destination: new LogGroupLogDestination(this.accessLogGroup),
        format: AccessLogFormat.custom(ACCESS_LOG_FORMAT),
      },
    });

    this.schedulerRole = new Role(this, "SchedulerRole", {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": Stack.of(this).account } },
      }),
    });
    const daily = (name: string, input: Record<string, unknown>) =>
      new Schedule(this, name, {
        schedule: ScheduleExpression.rate(Duration.days(1)),
        target: new LambdaInvoke(this.sweepFunction, {
          role: this.schedulerRole,
          input: ScheduleTargetInput.fromObject(input),
          retryAttempts: 2,
          maxEventAge: Duration.hours(1),
        }),
      });
    this.sweepSchedule = daily("SweepSchedule", { task: "sweep" });
    const { versions } = config.retention;
    if (versions !== undefined) {
      this.pruneSchedule = daily("PruneSchedule", { task: "prune", ...versions });
    }

    let alarmAction: SnsAction | undefined;
    if (config.alarmEmail !== undefined) {
      this.alarmTopic = new Topic(this, "AlarmTopic");
      this.alarmTopic.addSubscription(new EmailSubscription(config.alarmEmail));
      const action = new SnsAction(this.alarmTopic);
      alarmAction = action;
      const alarm = (name: string, metric: IMetric, threshold: number) =>
        new Alarm(this, name, {
          metric,
          threshold,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(action);
      alarm(
        "ControlErrorsAlarm",
        this.controlFunction.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
        1,
      );
      alarm(
        "SweepErrorsAlarm",
        this.sweepFunction.metricErrors({ period: Duration.hours(1), statistic: "Sum" }),
        1,
      );
      alarm(
        "ApiServerErrorsAlarm",
        this.httpApi.metricServerError({ period: Duration.minutes(5), statistic: "Sum" }),
        5,
      );
    }

    const plane = buildViewingPlane(this, {
      viewDomain: config.viewDomain,
      hostedZone: config.viewZone,
      certificate: this.viewCertificate,
      bucket: this.bucket,
      identity: this.identity,
      viewing: config.viewing,
      logRetention: config.logRetention,
      alarmAction,
    });
    this.distribution = plane.distribution;
    this.viewFunction = plane.viewFunction;
    this.viewFunctionUrl = plane.viewFunctionUrl;
    this.viewAlias = plane.viewAlias;
    this.viewLogGroup = plane.viewLogGroup;
    this.viewerRequestFunction = plane.viewerRequestFunction;
    this.keyValueStore = plane.keyValueStore;
    this.sessionSecret = plane.sessionSecret;
    this.sessionKeysFunction = plane.sessionKeysFunction;
    this.viewCachePolicy = plane.viewCachePolicy;
    this.viewOriginRequestPolicy = plane.viewOriginRequestPolicy;
    this.loginOriginRequestPolicy = plane.loginOriginRequestPolicy;

    const output = (name: string, value: string) => new CfnOutput(this, name, { value });
    output("ApiUrl", this.apiUrl);
    output("ViewUrl", this.viewUrl);
    output("TokenSecretArn", this.tokenSecret.secretArn);
    output("BucketName", this.bucket.bucketName);
    output("ControlLogGroupName", controlLogGroup.logGroupName);
    output("AccessLogGroupName", this.accessLogGroup.logGroupName);
    output("SweepFunctionName", this.sweepFunction.functionName);
    if (this.pruneSchedule !== undefined) {
      output("PruneScheduleName", this.pruneSchedule.scheduleName);
    }
  }
}
