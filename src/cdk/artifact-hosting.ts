// `ArtifactHosting` (docs/decisions/0071): artifact hosting on AWS under one construct scope. No
// physical names, accounts or Regions, so two instances in one stack or account never collide;
// safe defaults (private bucket, retained data, publish only through IAM).
import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import type { RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IHostedZone } from "aws-cdk-lib/aws-route53";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { ArtifactIdentity, type ArtifactIdentityBinding } from "./identity.ts";
import {
  checkAlarmEmail,
  checkApiHost,
  checkInZone,
  domainName,
  type ResolvedLimits,
  type ResolvedRetention,
  resolveLimits,
  resolveRetention,
  resolveThrottle,
  zoneNameOf,
} from "./validate.ts";

export interface ArtifactViewDomain {
  /** Where artifacts are viewed: `https://<id>.<name>/`; the gallery is `https://<name>/`. */
  readonly name: string;
  /** Holds `name`; must carry its `zoneName`. The API's records go here by default. */
  readonly hostedZone: IHostedZone;
  /** The us-east-1 certificate for CloudFront (`ArtifactCertificate`); unused until M10. */
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
  alarmEmail?: string;
};

function validate(props: ArtifactHostingProps): Config {
  if (!(props?.identity instanceof ArtifactIdentity)) {
    throw new Error(
      "identity must be an ArtifactIdentity, e.g. ArtifactIdentity.cognito({owners})",
    );
  }
  const viewDomain = domainName("viewDomain.name", props.viewDomain?.name);
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
  return {
    viewDomain,
    apiDomain,
    viewZone,
    apiZone,
    limits: resolveLimits(props.limits),
    retention: resolveRetention(props.dataRetention),
    throttle: resolveThrottle(props.throttle),
    alarmEmail: checkAlarmEmail(props.alarmEmail),
  };
}

export class ArtifactHosting extends Construct {
  /** `https://<apiDomain.name>`: the CLI's `--server` and the MCP base URL. */
  readonly apiUrl: string;
  /** `https://<viewDomain.name>/`: the gallery (served from M10). */
  readonly viewUrl: string;
  readonly bucket: Bucket;
  readonly identity: ArtifactIdentityBinding;
  /** `viewDomain.certificate`, kept for M10's distribution. */
  readonly viewCertificate?: ICertificate;

  constructor(scope: Construct, id: string, props: ArtifactHostingProps) {
    super(scope, id);
    const config = validate(props);
    this.apiUrl = `https://${config.apiDomain}`;
    this.viewUrl = `https://${config.viewDomain}/`;
    this.viewCertificate = props.viewDomain.certificate;

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

    this.identity = props.identity._bind(this);

    new CfnOutput(this, "BucketName", { value: this.bucket.bucketName });
    new CfnOutput(this, "ViewUrl", { value: this.viewUrl });
  }
}
