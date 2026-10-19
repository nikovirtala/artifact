# 0063. Test resources stack: contract bucket + GitHub OIDC role

Status: Accepted (M8)

## Context

M8's gate is the contract suite against a real bucket (`docs/01-plan-aws.md`, "Testing, operations and cost"). The plan asks for stage-independent test resources: the contract-test bucket and a GitHub OIDC role scoped to it. The owner deploys them; agents only define and synthesize them, and the sandbox's AWS access is read-only.

## Decision

- `aws/lib/test-resources-stack.ts` defines `TestResourcesStack` (props `githubRepository`, `githubEnvironment` default `s3-contract`, `githubOidcProviderArn` optional). `aws/bin/test-resources.ts` is the CDK app (`aws/cdk.json`), stack id `ArtifactTestResources`, region `CDK_DEFAULT_REGION` or `eu-north-1`, with context `githubRepository` (default `nikovirtala/artifact`), `githubEnvironment` and `githubOidcProviderArn`. No names, accounts or regions are hard-coded in the stack.
- **Bucket:** all public access blocked, SSE-S3, TLS enforced by bucket policy, no versioning, objects and incomplete uploads expire after 1 day, `RemovalPolicy.DESTROY` without `autoDeleteObjects` (that would add a Lambda asset; the expiry empties the bucket).
- **OIDC:** a native `AWS::IAM::OIDCProvider` for `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`, or the existing one imported by ARN, since an account holds only one provider per URL.
- **Role:** trusted only through `sts:AssumeRoleWithWebIdentity` with `aud = sts.amazonaws.com` and `sub = repo:<repo>:environment:<environment>`, so only jobs in that GitHub environment can assume it. Maximum session 1 hour. An inline policy allows `s3:ListBucket` on the bucket and `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on its objects, nothing else (`If-Match` writes need both Get and Put, V1b in 0060).
- **Outputs:** `BucketName`, `RoleArn`.
- **No bootstrap:** the stack has no assets, so it uses `BootstraplessSynthesizer` and deploys without `cdk bootstrap`. `pnpm --filter aws synth` synthesizes it locally; the template is tested with `aws-cdk-lib/assertions` (`aws/test/test-resources-stack.test.ts`).

### Owner's commands

```sh
# deploy once (owner only; no bootstrap needed)
pnpm --filter aws exec cdk deploy ArtifactTestResources [-c githubOidcProviderArn=<existing provider ARN>]
# run the real-bucket tests with credentials that can use the bucket
export ARTIFACT_TEST_BUCKET=<BucketName output> AWS_REGION=eu-north-1
node --test test/contract/s3-store.test.ts test/runtime/s3-concurrency.test.ts
pnpm --filter aws test:e2e
```

## Consequences

The bucket and the role exist only once the owner deploys them. Until then the real-bucket suites are skipped and the fake endpoint stands in. The role can do nothing outside this bucket, and nothing outside the named environment can assume it.
