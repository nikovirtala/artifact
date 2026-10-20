# 0076. Smoke and retention scripts, CloudShell deploy guide, and the runtime SDK log line

Status: Accepted (M9)

## Context

The agent cannot deploy (read-only AWS access); the owner deploys `examples/personal` from AWS CloudShell (owner decision 5). Every deployed M9 acceptance criterion that can be automated therefore needs a script the owner runs with the stack outputs as input, printing a pass/fail table and exiting non-zero on failure. M8 left one residual (V2): the exact `@aws-sdk/client-s3` version in the managed `nodejs24.x` runtime in eu-north-1 is not documented, so the deployment must log it without leaking secrets.

## Decision

- **Runtime line (V2 residual).** At cold start both functions log `artifact runtime {"node","clientS3","clientSecretsManager"?,"package"}`: fixed fields only, the client versions read with `import("@aws-sdk/<client>/package.json", { with: { type: "json" } })`, which is the way AWS documents for an ES-module handler to read the runtime's SDK version ([Building Lambda functions with Node.js](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html), A14). A failed import reads `unknown`.
- **Scripts** in `examples/personal/scripts/` use only the examples' devDependencies and Node 24, so they run in CloudShell after the toolchain step; the CLI runs as `node <repo>/dist/cli/main.js` (exit 2 if not built). Outputs come from `DescribeStacks`, matched by `^<constructId>(ApiUrl|…)[0-9A-F]{8}$`. Each check catches its own errors; tokens and cookie markers are redacted from every detail. Exit 0 when nothing failed, 1 when a check failed, 2 on bad input.
- **`pnpm smoke [--stage prod] [--skip-revoke-check] [--keep]`** (needs `ARTIFACT_TOKEN`):

  | Check | What | Covers |
  | --- | --- | --- |
  | S1 | `GET /api` → 200 `{version}`, same major as the repo | `GET /api` rule |
  | S2, S3 | `artifact publish page.html --server <api> --json --no-open --no-project` → `{id, version: 1, url: https://<id>.<view domain>/}`; `--id` → version 2 | C6 |
  | S4, S5 | no / wrong token → 401 `unauthorized` | C8 |
  | S6 | valid token + `Origin` → 403 `forbidden` | C8 |
  | S7 | MCP `artifact_publish` with `file_path` → tool error `invalid_input` | C8 |
  | S8 | 3.5 MiB `index.html` → 413 `too_large` (`file`, 3,145,728) | C8 as restated in 0066 |
  | S9 | the control log's `artifact request` line of the JSON publish: prints `isBase64Encoded` and `contentType` | V3 follow-up (0066) |
  | S11 | MCP SDK client over Streamable HTTP with the bearer header: publish, list, read, roll back to v1 | C7 |
  | S12 | four requests carrying `Cookie: __Secure-artifact_session=<marker>`; once positive controls show all of them in both log groups (a path marker in the access log, `POST /mcp` and `POST /api/artifacts`, and the control lines on `ANY /mcp` and `ANY /api/{proxy+}`), the marker must be absent from every event | C2 |
  | S13 | `artifact token create` → the new token answers `GET /api` (polled up to 315 s) | C9 |
  | S14 | `artifact token revoke` → 401 within 315 s (on by default; `--skip-revoke-check` reports SKIP, pending) | C9 |
  | S15, S16 | unsigned `GET` of the bucket over https and http → 403 | C10 |
  | S17, S18 | signed `ListObjectsV2` path-style over http → 403 `AccessDenied`; over https → 200, so S17 is the TLS deny | C10 |
  | S19 | the `artifact runtime` line of the last 24 h (Node and SDK versions); FAIL on `Runtime.ImportModuleError` or a missing `@aws-sdk` package | V2 residual, A14 |

  Cleanup deletes the smoke artifacts and revokes the smoke token unless `--keep`.
- **`pnpm retention-check prune --stack <name> --region <r>`** (C3 on the tarball app with `DESTROY` and `keepLast: 2`): a temporary token, 4 versions, rollback to v1, the prune schedule's exact `Target.Input` from `GetSchedule`, `Invoke` of the sweep function with it (no `FunctionError`, the `{artifacts, versions, skipped}` result with `skipped: 0`), then versions `[1,3,4]` with v1 current and `read --version 2` → `not_found`. **`bucket --bucket <name> --region <r> --expect present|absent`**: `HeadBucket` without Region redirects; 200/404 against the expectation, 301 or `PermanentRedirect` → "bucket is in another Region", 403 → "cannot tell".
- **`pnpm check:dns [--stage prod]`**: the view domain's NS records through 1.1.1.1 and 8.8.8.8 (`node:dns` `Resolver`, 5 s timeout) compared as normalised sets with the DNS stack's `NameServers` output.
- **Log reads** go through one helper: `FilterLogEvents` without a filter pattern, which returns all events ([`FilterLogEvents`](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_FilterLogEvents.html), A18), following `nextToken` for at most 50 pages; all matching is local. The parsers never throw (an access line may not be valid JSON if an error message holds a `"`), and the marker check scans the raw message of every event. Correlation uses a path marker and method + path in the access log and method + route key + time (5 s skew) in the control log; it does not rely on the `apigw-requestid` header equalling `$context.requestId` (A16, cannot be confirmed) nor on the exact `$context.path` form (A19): a POST control matches `path === P` or `path.endsWith(P)`, and a missing control prints the pairs it saw.
- **Deploy guide** (`examples/personal/README.md`): exact CloudShell commands. CloudShell keeps only 1 GB of `$HOME` per Region and recycles everything else per session ([AWS CloudShell](https://docs.aws.amazon.com/cloudshell/latest/userguide/welcome.html), A13), so the guide works under `/tmp` and reinstalls the pinned Node and pnpm per session. One `cdk bootstrap` without arguments bootstraps every environment the app targets, eu-north-1 and us-east-1 ([`cdk bootstrap`](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-bootstrap.html), A15).

## Consequences

The pure parts (output matching, argument parsing, table and exit codes, parsers and predicates on real-shaped lines, pagination, schedule input, HeadBucket mapping, NS normalisation) are unit-tested in `pnpm check`; the AWS calls run only when the owner runs the scripts. The first deployed run shows the real `isBase64Encoded` (which decides whether limits can be raised, 0066), the real `$context.path` form and the runtime's SDK versions.
