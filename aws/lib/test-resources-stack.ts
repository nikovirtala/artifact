// Stage-independent test resources (docs/decisions/0063): the bucket the S3 contract, concurrency
// and e2e tests run against, and a role GitHub Actions assumes through OIDC to use it. Defined
// here; deployed by the owner only.
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  type IOidcProvider,
  OidcProviderNative,
  PolicyDocument,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
} from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
const STS_AUDIENCE = "sts.amazonaws.com";

export type TestResourcesStackProps = StackProps & {
  /** `owner/repo` whose workflows may assume the role. */
  githubRepository: string;
  /** GitHub environment the job must run in (default `s3-contract`). */
  githubEnvironment?: string;
  /** An existing GitHub OIDC provider; an account holds only one per URL. */
  githubOidcProviderArn?: string;
};

export class TestResourcesStack extends Stack {
  readonly bucket: Bucket;
  readonly role: Role;

  constructor(scope: Construct, id: string, props: TestResourcesStackProps) {
    super(scope, id, props);
    const environment = props.githubEnvironment ?? "s3-contract";

    // Test data only: every object expires after a day, so DESTROY works without
    // autoDeleteObjects (which would add a Lambda asset and need a bootstrap).
    this.bucket = new Bucket(this, "ContractBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [
        { expiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const provider: IOidcProvider = props.githubOidcProviderArn
      ? OidcProviderNative.fromOidcProviderArn(this, "GitHubOidc", props.githubOidcProviderArn)
      : new OidcProviderNative(this, "GitHubOidc", {
          url: GITHUB_OIDC_URL,
          clientIds: [STS_AUDIENCE],
        });

    this.role = new Role(this, "ContractRole", {
      description: `S3 contract tests from ${props.githubRepository} (environment ${environment})`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: STS_AUDIENCE,
          [`${GITHUB_OIDC_HOST}:sub`]: `repo:${props.githubRepository}:environment:${environment}`,
        },
      }),
      // Explicit, not bucket.grant*: If-Match writes need GetObject and PutObject (V1b), list
      // needs ListBucket, and nothing else is allowed.
      inlinePolicies: {
        ContractBucket: new PolicyDocument({
          statements: [
            new PolicyStatement({ actions: ["s3:ListBucket"], resources: [this.bucket.bucketArn] }),
            new PolicyStatement({
              actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
              resources: [this.bucket.arnForObjects("*")],
            }),
          ],
        }),
      },
    });

    new CfnOutput(this, "BucketName", { value: this.bucket.bucketName });
    new CfnOutput(this, "RoleArn", { value: this.role.roleArn });
  }
}
