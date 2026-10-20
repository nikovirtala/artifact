# 0071. `ArtifactHosting` API, the M9 subset of the M10/M11 props, and the construct-scope rule

Status: Accepted (M9)

## Context

`docs/01-plan-aws.md` ("Construct API") defines `ArtifactHosting` with props and properties that belong to M10 (viewing plane, login) and M11 (live reload). M9 builds only the control plane, but the API should not change shape when those milestones land. The plan's rules for the construct: no hard-coded physical names, accounts or Regions; two instances in one stack or account never collide; every resource under the construct's scope; the main resources exposed as properties; `CfnOutput`s for the API URL, the view URL and the token secret; safe defaults.

## Decision

- **Exports of `@nikovirtala/artifact/cdk`:** `ArtifactHosting`, `ArtifactCertificate`, `ArtifactIdentity`, `CONTROL_ROUTE_KEYS` (the HTTP API route keys, as they appear in `$context.routeKey` and `requestContext.routeKey`), `AWS_LIMIT_DEFAULTS`, `AWS_LIMIT_CEILINGS` and the prop types. `src/cdk/` imports only `aws-cdk-lib`, `constructs`, `node:*` and itself (import-boundary test), so its declarations are self-contained.
- **The M9 subset:**

  | Prop / property | M9 behaviour | Later |
  | --- | --- | --- |
  | `viewDomain.name` | Required. Drives `DomainHostPolicy` in the control Lambda (artifact URLs `https://<id>.<name>/`), `viewUrl` and the API-host validation | M10 adds the distribution and alias records |
  | `viewDomain.hostedZone` | Required and must carry its `zoneName`; holds the created API certificate's validation records and the API alias record (`apiDomain.hostedZone` defaults to it) | M10 adds apex and wildcard aliases |
  | `viewDomain.certificate` | **Optional** in M9; accepted and stored as `viewCertificate`, referenced by no resource, so no cross-Region reference is created | M10 requires it unless the stack is in us-east-1 (then it creates one) |
  | `identity: ArtifactIdentity.cognito({owners})` | Creates the user pool; owners validated and normalised, exposed as `identity.owners`; **no users** (0069) | M10 creates owner users, the app client and managed login |
  | `distribution`, `eventApi` properties | Not declared (additive later) | M10 / M11 |
  | `viewUrl` | `https://<viewDomain.name>/` (what `DomainHostPolicy.galleryUrl()` gives) | Unchanged; reachable from M10 |
  | `alarmEmail` | Alarms on control errors (sum ≥ 1 in 5 minutes), sweep errors (≥ 1 in an hour) and API 5xx (≥ 5 in 5 minutes) to an SNS topic, only when set | M11 adds authorizer errors |

- **Other props:** `apiDomain {name, hostedZone?, certificate?}`, `limits` (0066), `dataRetention` (0067), `logRetention` (default one month), `throttle` (default 20 requests per second, bursts of 40). All are validated at synth time with the prop path in the error.
- **Properties:** `apiUrl`, `viewUrl`, `bucket`, `tokenSecret`, `httpApi`, `apiDomainName`, `apiCertificate`, `controlFunction`, `sweepFunction`, `schedulerRole`, `sweepSchedule`, `pruneSchedule?`, `accessLogGroup`, `identity`, `viewCertificate?`, `alarmTopic?`.
- **Outputs** (ids under the construct, e.g. `ArtifactsApiUrl<hash>`): `ApiUrl`, `ViewUrl`, `TokenSecretArn`, `BucketName`, `ControlLogGroupName`, `AccessLogGroupName`, `SweepFunctionName`, and `PruneScheduleName` only when the prune schedule exists.
- **Construct scope:** every resource is created under the construct, including the Scheduler execution role (`LambdaInvoke` without a role would create one at the stack root). No resource gets a physical name. The only exception is CDK's stack-level auto-delete provider under `onDestroy: DESTROY` (0070), shared by all instances in a stack.

## Consequences

Two instances in one stack differ only by their construct ids and domains (an API host is a DNS name, so it cannot be shared). The template carries no account or Region literal; the construct code holds none except `us-east-1` in `ArtifactCertificate`'s Region check. M10 and M11 add props and properties without renaming any.
