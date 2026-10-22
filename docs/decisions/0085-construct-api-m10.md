# 0085. Construct API for M10

Status: Accepted (M10)

## Context

0071 shaped the M9 construct API as a subset of M10/M11, and it promised that `viewDomain.certificate` (optional and unused in M9) would carry the CloudFront certificate. M10 adds the viewing plane (0079–0084). Facts and constraints:

- CloudFront takes certificates from us-east-1 only, and the certificate must cover every alias ([Alternate domain names](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html)) (F5).
- The edge function holds no environment. The view domain is substituted into its code at synth (0080), so it must be a literal.
- Lambda keeps at least 100 concurrency unreserved, so a reserved cap of N needs an account limit of at least 100 + N. New accounts can start at 10 (F8 and its note: `GetAccountSettings` shows 1000 in this account).
- `v1.1.0` already publishes `src/cdk/`. Breaking changes need a major release (RELEASING.md, AGENTS.md).

## Decision

- **`viewDomain.name` must be a literal:** a token is the synth error `viewDomain.name must be a literal domain name (the edge function embeds it)`.
- **The certificate rule**, checked in this order:
  1. A given certificate whose ARN is a literal must contain `:us-east-1:` (`viewDomain.certificate must be in us-east-1 (CloudFront)`). A token ARN, for example a parameter or a cross-Region reference, is accepted unchecked: CloudFront rejects another Region at deploy time, and CDK's own check skips tokens too.
  2. Without a certificate, a stack whose Region is the literal us-east-1 gets `ViewCertificate` for the apex and `*.<view>`, DNS-validated in the view zone.
  3. Otherwise, including an environment-agnostic stack (it could deploy anywhere), the error is `viewDomain.certificate is required unless the stack is in us-east-1`.

  `CLOUDFRONT_REGION` is exported from `certificate.ts` for this check, and it is not re-exported from the package. `viewCertificate` becomes a non-optional `ICertificate`.
- **`viewing?: ArtifactViewing`:**
  - `reservedConcurrency` is an integer from 1 to 1000, or `false` for no cap; default 20.
  - `provisionedConcurrency` is a positive integer, at most the cap; it puts the function URL on a `live` alias.
  - `sessionKeyRotation` matches `[A-Za-z0-9._-]{1,64}`; default `"1"` (0079).
  - The viewing environment must fit in 3500 bytes, counting tokens at fixed upper bounds (0082).

  Every error names the prop path.
- **Deviation from requirement 11** ("reserved concurrency default fits new accounts"): no capped default fits an account at the initial limit of 10. The default stays 20, because the plan wants a cap as a runaway-bill guard, and needs an account limit of at least 120. Smaller accounts set `viewing: { reservedConcurrency: false }`. This is stated in the prop's TSDoc, in `examples/personal/README.md` "Before you start", and in the guide's known limits.
- **`buildViewingPlane(hosting, props)`** in `src/cdk/viewing.ts` creates the viewing plane. It is a function, not a construct, and every resource and output has scope `hosting`. So logical ids are `Artifacts<Id><hash>` with no intermediate segment, and output ids are `Artifacts<Name><8 hex>`, which the scripts match as in 0076.
- **New properties:** `distribution`, `viewFunction`, `viewFunctionUrl`, `viewAlias?`, `viewLogGroup`, `viewerRequestFunction`, `keyValueStore`, `sessionSecret`, `sessionKeysFunction`, `viewCachePolicy`, `viewOriginRequestPolicy` and `loginOriginRequestPolicy`. `identity` gains the fields of 0084. `viewUrl` is unchanged.
- **New outputs:** `DistributionId`, `DistributionDomainName`, `ViewFunctionUrl`, `ViewLogGroupName`, `ViewerRequestFunctionName`, `KeyValueStoreArn`, `SessionSecretArn`, `SessionKeysLogGroupName`, `UserPoolId`, `UserPoolClientId`, `LoginDomainUrl`. The M9 outputs keep their ids.
- **Rules kept:** no physical names, except the four CloudFront names of 0083 (unique id + part + Region) and the Cognito prefix of 0084. Every resource is under the construct, and two instances in one stack synthesize without clashes. Safe defaults: viewing is behind login from the first deploy, the viewing role is read-only, and the cap is on.
- **Tarball app (amends 0074 and 0076):** the guide's `tarball-app` and pack test (b3) move to us-east-1, so the construct creates the view certificate there and the owner has no certificate step. Apps (b) and (b2) stay in eu-north-1 and pass an imported us-east-1 certificate, which exercises the given-certificate path.
- **SemVer: 2.0.0.** Under 1.x, a stack outside us-east-1 synthesizes without a certificate and a token view domain is accepted. Both are now errors, and upgrading creates the viewing plane and invites the owners. The commit that introduces the rule is `feat(cdk)!` with a `BREAKING CHANGE:` footer.

## Consequences

Consumers upgrading from 1.x must pass a us-east-1 certificate (or deploy in us-east-1) and a literal view domain, and they get a distribution and Cognito invitations on the next deploy. The release is 2.0.0. Accounts below a concurrency limit of 120 must opt out of the cap. Switching `provisionedConcurrency` on or off replaces the function URL, and the distribution follows in place.
