# 0070. Bucket settings, bucket policy and least-privilege IAM

Status: Accepted (M9)

## Context

The plan's rules for the construct ask for safe defaults: a private bucket, retained data, publishing only through IAM, and least privilege (`docs/01-plan-aws.md`, "Rules for the construct" and "Resources the construct creates"). CDK's `grant*` helpers add more than the handlers need (`grantReadWrite` adds `GetBucket*`, `List*`, `*Tagging` and `Abort*`).

## Decision

- **Bucket:** `BlockPublicAccess.BLOCK_ALL`, SSE-S3, `enforceSSL`, `minimumTLSVersion: 1.2`, no versioning, `BucketOwnerEnforced`, a lifecycle rule that aborts incomplete multipart uploads after one day, no name. `dataRetention.onDestroy` sets the removal policy (`RETAIN` by default); only `DESTROY` adds `autoDeleteObjects`.
- **Bucket policy:** exactly the two denies CDK writes for those settings, `aws:SecureTransport = false` and `s3:TlsVersion < 1.2` (TLS-only through the `aws:SecureTransport` condition, as in [S3 bucket policy examples](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html), A8 in the M9 AWS facts). **No `Allow`**, so access is IAM-only, except the statement CDK adds for its auto-delete provider role under `DESTROY`.
- **Roles,** each owned by the construct, with explicit `PolicyStatement`s, no managed policies and no `*` actions:

  | Principal | Allow | Resource |
  | --- | --- | --- |
  | Control function role | `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` | `<bucket>/*` |
  | | `s3:ListBucket` | `<bucket>` |
  | | `secretsmanager:GetSecretValue` | the token secret |
  | | `logs:CreateLogStream`, `logs:PutLogEvents` | its log group |
  | Sweep function role | the same S3 statements (prune rewrites pointers and deletes versions; sweep lists and deletes) | same |
  | | `logs:CreateLogStream`, `logs:PutLogEvents` | its log group |
  | Scheduler role (`scheduler.amazonaws.com`, condition `aws:SourceAccount` = the stack's account) | `lambda:InvokeFunction` | the sweep function and its versions (`:*`) |

- **No KMS grant:** the token secret uses the AWS managed `aws/secretsmanager` key, which principals of the account may use through Secrets Manager (`kms:ViaService`) without an IAM `kms:Decrypt` grant ([Secret encryption and decryption](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html), A9).
- **The one resource outside the construct scope:** under `DESTROY`, CDK's `autoDeleteObjects` uses a stack-level singleton provider (`Custom::S3AutoDeleteObjectsCustomResourceProvider`, one role and one function), shared by every instance in the stack. That is CDK's design and is accepted.

## Consequences

The function roles cannot read bucket configuration, tags or other buckets; adding a feature that needs more (M10's viewing role, M11's `appsync:EventPublish`) means adding an explicit statement and its test. Construct tests compare the expanded `(Effect, Action, Resource)` triples per role, so CDK merging statements (`@aws-cdk/aws-iam:minimizePolicies`) does not change the result, and run under the `cdk init` recommended feature flags too.
