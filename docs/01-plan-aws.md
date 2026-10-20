# artifact v2 — AWS deployment: spec & build plan

Oct 18, 2026 · @Niko Virtala

## Overview

v2 runs the same `artifact` core on AWS: S3 holds the exact v1 key layout, two Lambdas serve the control plane (`/api`, `/mcp`) and the viewing plane, CloudFront gates every page behind a login, and AppSync Events replaces SSE for live reload. The local `artifact serve` keeps working unchanged; the CLI and MCP tools gain a remote server as a second target.

Starting point: [nikovirtala/artifact](https://github.com/nikovirtala/artifact) v1.0.0 (M0–M5 done, 49 ADRs). Milestones here continue the numbering at M7; ADRs continue at 0050.

**Goals (v2)**

- A CDK construct in the same package, `@nikovirtala/artifact/cdk`: anyone deploys their own private artifact host by adding one construct to their CDK app.
- Same CLI commands, MCP tools, API shapes and key layout as v1; `artifact --server https://<api host>` plus a token is the only difference for clients.
- Pages served at `https://<id>.<view domain>/`, one origin per artifact, as `<id>.localhost` is today.
- Viewing requires a signed-in owner; API and MCP require a bearer token.
- Open tabs reload within 2 s of a publish (p95), with the v1 rule that a reconnect always learns the current version.
- Local mode stays byte-for-byte compatible: every v1 test passes unchanged after each milestone.

**Non-goals (v2)**

- Multi-tenant hosting: each deployment serves its own owners; no teams, sharing or per-artifact permissions.
- Public or unlisted links (listed under later work).
- OAuth 2.1 for MCP clients; static bearer tokens are enough for one owner.
- Publishes larger than the Lambda request limit (about 6 MB); staged uploads are later work.
- Runtime capabilities for pages (shared data, asking a model).

## What v1 already gives us, and the gaps

Most of the AWS move is already paid for: the ports follow S3 semantics, the publish protocol is safe under concurrent writers, and MCP is stateless on Web `Request`/`Response`. Seven things in the code are local-only and need work first.

**Reused as is**

- `core/ports.ts`: `BlobStore` and `PointerStore` speak S3 (string keys, opaque etags, `If-None-Match: *`, `If-Match`, prefix + delimiter listing).
- Publish protocol ([0015](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0015-publish-protocol-and-conflicts.md)): claim by create-only `src/index.html`, pointer CAS last. Correct across processes once the store gives real conditional writes, which S3 does.
- Contract suite `test/contract/blob-store.contract.ts`: the S3 adapter's acceptance test.
- MCP on `WebStandardStreamableHTTPServerTransport`, stateless ([0033](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0033-mcp-transport-and-sdk.md)): runs on Lambda without a session store.
- Reload injection at publish time ([0020](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0020-reload-injection.md)): the tag points at `/__artifact/reload.js`, which the platform serves, so AWS ships its own client without republishing anything.
- SSE contract ([0028](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0028-sse-handshake-and-reconnect.md)): "current version on every connect" carries over to AppSync.
- `allowFilePath` and `Opener` are already optional, so AWS turns them off by configuration.

**Gaps to close**

| # | Where | What is local-only | Fix (milestone) |
| --- | --- | --- | --- |
| 1 | `core/artifact-service.ts` `LIMITS`, `schemas.ts` `MAX_BODY_BYTES` (96 MiB) | Limits are constants sized for loopback; Lambda takes about 6 MB per request | Inject limits per deployment (M7) |
| 2 | `http/guards.ts` host guard, `http/urls.ts` | Hosts are hard-coded to `localhost` and `<id>.localhost` | A `HostPolicy` port with local and domain implementations (M7) |
| 3 | `http/app.ts` | One app serves viewing, API and MCP on one port | Split into a viewing app and a control app; local composes both (M7) |
| 4 | `http/reload-client.js` | Parses `.localhost` and speaks SSE only | Served with a config object; SSE and AppSync transports (M7, M11) |
| 5 | Traversal guard | Reads the raw target from `@hono/node-server` | Raw path from an adapter hook (Lambda event `rawPath`) (M7) |
| 6 | `service.list()` | Lists prefixes, then reads every `meta.json` | Fine on S3 at personal scale; documented threshold, index later (M8) |
| 7 | `lockfile.ts` ([0026](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0026-single-server-lockfile.md)), fs in-process lock | One server per root | Not needed on S3: conditional writes are the lock (M8) |

## Target architecture

The control plane (left) is the only writer; the viewing plane (right) only reads; AppSync carries reload events from one to the other.

&#91;embedded content: AWS architecture · control plane left, viewing plane right, reload events between\]

A publish goes CLI or agent → HTTP API → control Lambda, which writes the version to S3, moves the pointer, then publishes to the artifact's AppSync channel. Every open tab subscribed to that channel reloads through CloudFront, and the viewing Lambda serves the new version from S3.

## Key decisions

The biggest change from the v1 plan's AWS sketch: pages are served by a Lambda behind CloudFront, not by a CloudFront Function that reads the current version from KeyValueStore. The Lambda reads `meta.json` from S3, so it is correct by construction and reuses `serveArtifact` as is; the KVS design is faster but trades away read-your-writes and adds a sync path. It stays the documented fallback, chosen only if the M10 measurements call for it (see Serving: cost and fallback, below).

| Decision | Choice | Why | Rejected |
| --- | --- | --- | --- |
| Serving pages | CloudFront → viewing Lambda (function URL, OAC) → S3 | Strong read-after-publish consistency; v1 viewing code unchanged; pinned versions still cached at the edge for a year | CloudFront Function + KVS pointer (stale reads after publish, second source of truth; kept as the M10 fallback), S3 origin direct (no extensionless redirects, no gallery) |
| Control plane | API Gateway HTTP API → control Lambda (Hono via `hono/aws-lambda`) | Custom domain, throttling; POST bodies work without the payload-hash header that OAC on a function URL requires | Function URL behind CloudFront OAC (clients would need `x-amz-content-sha256`) |
| Two Lambdas | Viewing: S3 read-only. Control: S3 read/write + AppSync publish | Least privilege; a bug in page serving cannot write | One Lambda for everything |
| State | S3 only, same keys as `~/.artifacts/` | Conditional writes give the CAS the core needs; nothing new to keep in sync | DynamoDB pointer table (add only if `list` gets slow) |
| Live reload | AppSync Events channel per artifact, Lambda authorizer | Managed WebSockets with fan-out; publish over HTTP with IAM | API Gateway WebSockets (own connection table), SSE from Lambda (no fan-out across instances) |
| Viewer auth | OIDC login against a Cognito user pool (IdP federation later) → HMAC-signed session cookie, checked by a CloudFront Function on every request | Runs before the cache, so cached pages stay private; no Lambda@Edge | Lambda@Edge (slower, regional replicas), CloudFront signed cookies (key pairs, no login flow) |
| Agent auth | Static bearer tokens, stored as SHA-256 hashes in Secrets Manager | Same model as v1's `ARTIFACT_TOKEN`; works with `claude mcp add --header` | OAuth 2.1 for MCP (later work) |
| Limits on AWS | 4 MiB per file and per publish (decoded), 6 MB request | Lambda's synchronous request limit is about 6 MB including JSON and base64 | Presigned staged uploads (later work) |
| Region | eu-north-1, certificate in us-east-1 | Closest region; CloudFront certificates must be in us-east-1 | — |
| Runtime | Lambda `nodejs24.x`, ESM bundles built with esbuild | Matches the repo's Node 24 ([AWS announcement](https://aws.amazon.com/blogs/compute/node-js-24-runtime-now-available-in-aws-lambda)) | Container images |

### Serving: cost and fallback

The Lambda origin costs one invocation and two sequential S3 reads (`meta.json`, then the file) for every request to a current-version URL, assets included; pinned `/v/<n>/` URLs are edge hits after their first request. Dollars are negligible at personal scale; latency is the cost.

| Case | Estimated added time-to-first-byte vs an edge hit |
| --- | --- |
| Warm, viewer near eu-north-1 | \~30–80 ms |
| Cold start after idle (Node 24, arm64, small bundle) | \~250–600 ms |
| Viewer far from the region | + one long round trip per uncached request |

Estimates, not measurements; M10 measures them. It hurts most on the first view after idle and on pages with many assets under the current URL.

**Mitigations that keep consistency:** a small viewing bundle (no MCP SDK, lazy imports, arm64); an optional `provisionedConcurrency` prop on the construct (a few dollars a month).

**Why KVS serving was not the default.** The reload loop it seemed to cause is fixable in the client, so that alone was not the reason. The real costs:

- Stale reads outside an open tab: until KVS reaches every edge, a new artifact can 404 and a hard refresh can show the previous version right after an agent reports the update. There is no per-key "propagated" signal `publish` could wait for.
- Two sources of truth: S3 `meta.json` stays the pointer, KVS becomes a copy that publish, rollback and delete must also write. A failed KVS write after the S3 commit needs retries and a reconciliation job. KVS updates are conditioned on the whole store's ETag, so concurrent publishes to different artifacts contend.
- Duplicated viewing logic in a constrained runtime: the edge function would reimplement path rewriting, `index.html` and traversal rules within CloudFront Functions' small size and CPU budget, and it cannot check whether an object exists. The gallery, login, extensionless redirects, `/__artifact/version` and the events token still need the Lambda origin anyway.

**Fallback design (if M10 says so):**

1. The edge function looks up `<id>` in KVS. Found → rewrite to `artifacts/<id>/v/<n>/www/<path>` on an S3 origin (OAC), cached as immutable. Not found, or a platform route → the Lambda origin (CloudFront Functions can select the origin per request). This removes the new-artifact 404.
2. The control Lambda writes KVS after the S3 pointer CAS, with retries; a scheduled job reconciles KVS against every `meta.json`.
3. The reload client, on `published n`, polls the current HTML with `fetch(…, {cache: "no-store"})` until it sees `data-version="n"`, then reloads: no loop, no flicker, a delay equal to KVS propagation.
4. Accepted residue: a hard refresh within seconds of an update can still show the previous version.

Decision rule: switch only if the M10 p95 for a warm 10-asset page, or the cold first view, is worse than the owner accepts; record it in an ADR with the numbers.

Each row becomes an ADR (0050 onward) when its milestone starts; the agent may overturn a row with evidence, in an ADR.

## Domains, authentication and isolation

Artifacts live on their own subdomain of a view domain; the API may live under it (reference: api.artifact.nikovirtala.dev) or outside it. Under it, the browser also sends the session cookie to the API; that is harmless because the API authenticates only by bearer token and refuses browser requests, but the API must never log the Cookie header.

| Host | Serves | Auth |
| --- | --- | --- |
| `<id>.<view domain>` (e.g. `01k…z.art.example.dev`) | One artifact: current, `/v/<n>/`, `/__artifact/*` | Session cookie at the edge |
| `<view domain>` | Gallery, `/__artifact/login`, `/__artifact/callback`, `/__artifact/logout` | Session cookie, except the login routes |
| `<api host>` (e.g. `artifact-api.example.dev`; reference: api.artifact.nikovirtala.dev) | `/api/*`, `/mcp` | `Authorization: Bearer <token>`; browser requests refused as in [0037](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0037-no-browser-requests-to-api-and-mcp.md) |

**Edge function** (CloudFront Functions, `cloudfront-js-2.0`, viewer request, every request including cache hits):

1. Classify `Host`: the view domain, or `<26-char Crockford ULID>.<view domain>`; anything else → 403.
2. Login routes on the view domain pass through. Otherwise verify the `__Secure-artifact_session` cookie: format `v1.<kid>.<payload>.<sig>`, HMAC-SHA256 with the key named `kid` read from the function's KeyValueStore, `exp` in the future. HMAC verification in a CloudFront Function with the key in KVS is a known pattern ([example](https://dev.classmethod.jp/articles/cloudfront-functions-jwt-verification/)).
3. No valid cookie: a `GET` navigation → 302 to `https://<view domain>/__artifact/login?return=<url>`; anything else → 401.
4. Copy `Host` into `x-artifact-host` (the function URL origin needs its own Host) and remove the `Cookie` header so it never reaches the origin or the cache key.

**Login** (viewing Lambda, view domain only): OIDC authorization code + PKCE against the construct's Cognito user pool (self-sign-up off; the login code stays issuer-generic so federation can come later). The callback checks `state`, verifies the ID token, requires `sub` (in v2: the verified email) to be on the owner allowlist, then sets the cookie: `Domain=<view domain>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000` (30 days). `return` must be an `https` URL on the view domain or one of its artifact subdomains; anything else falls back to the gallery.

**Keys.** Session-signing keys live in Secrets Manager (for the Lambda) and in the KVS (for the edge function), rotated with a new `kid`; the edge accepts the current and previous `kid`. The events token (Live reload) uses a separate key.

**Isolation.**

- One origin per artifact, as in v1: storage, IndexedDB and non-domain cookies stay per artifact.
- Artifact pages are same-site with each other and with the view domain. A page's JS cannot read the `HttpOnly` session cookie, but it can overwrite cookies on the view domain (cookie tossing): worst case it logs the owner out. It cannot forge a session without the key.
- Choosing the view domain (`viewDomain` prop; the construct README carries this guidance). **Your own pages only** (personal or dev use): a subdomain of a domain you own is fine; the reference deployment uses `artifact.nikovirtala.dev`. Artifacts are then same-site with the rest of that domain, so keep other sites on it from setting cookies on the parent domain. **Other people's or untrusted HTML** (artifact as a service): a dedicated registrable domain that nothing else lives on, ideally on the Public Suffix List so each `<id>.<view domain>` is its own site. A PSL domain cannot share one session cookie across subdomains, so that needs per-artifact sessions (later work), not the v2 login.
- The origin trusts `x-artifact-host` only because the function URL uses `AWS_IAM` auth with OAC: only this distribution can invoke it.

## Live reload on AWS

The v1 contract stays: on every (re)connect the client learns the current version and reloads if it differs from the one it loaded. Only the transport changes, from SSE to an AppSync Events WebSocket, and "send the current version on connect" becomes "subscribe, then fetch it".

**Server side**

- Event API with one channel namespace, `artifacts`; channel `/artifacts/<id>`. Event payloads match v1: `{"type":"published","version":n}` and `{"type":"deleted"}`.
- Publish auth: `AWS_IAM` only, for the control Lambda. Connect and subscribe auth: `AWS_LAMBDA`. AppSync lets each channel namespace override the API's default auth modes, and the authorizer receives the token plus the operation and channel ([docs](https://docs.aws.amazon.com/appsync/latest/eventapi/configure-event-api-auth.html)).
- `AppSyncNotifier` (the `Notifier` port) posts events over HTTPS signed with SigV4. A failed notify is swallowed, as in [0015](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0015-publish-protocol-and-conflicts.md): clients recover on reconnect.
- Events token: `GET /__artifact/events-token` on `<id>.<view domain>` (behind the edge cookie check) returns `{endpoint, channel, token}`. The token is HMAC-signed with its own key: `{ch:"/artifacts/<id>", exp: now + 10 min}`.
- Authorizer Lambda: `EVENT_CONNECT` needs any valid, unexpired token; `EVENT_SUBSCRIBE` also needs `ch` to equal the requested channel; `EVENT_PUBLISH` is never authorized for this mode. A token for artifact A cannot subscribe to B.
- `GET /__artifact/version` on `<id>.<view domain>` returns `{"version": n}` with `Cache-Control: no-store`. Add it locally too, for parity and tests.

**Client side** (`reload.js`, AppSync transport; plain JS, no library, no build):

1. Read the id from the host (view domain suffix comes from the served config) and skip pinned pages, as v1 does.
2. Fetch the events token, open the WebSocket to the realtime endpoint with the token in the connection header, subscribe to the channel.
3. After the subscribe is acknowledged, fetch `/__artifact/version`; reload if it differs from `data-version`.
4. On `published` with another version → reload. On `deleted` → the v1 banner.
5. On close or error: back off 1 s, 2 s, 4 s up to 30 s, then repeat from step 2. An expired token is fetched again.

Subscribing before reading the version keeps v1's no-lost-publish guarantee: a publish that lands in between arrives as an event.

## Code changes to the v1 codebase

All of these land in the published package with no new runtime dependency, and none of them changes local behaviour: the existing suite is the regression test.

1. **Injectable limits.** `ArtifactServiceDeps.limits?: Partial<Limits>` (default = today's `LIMITS`). `schemas.ts` and the MCP transport take the body cap from config instead of `MAX_BODY_BYTES`. Tool descriptions and `too_large` messages print the configured numbers.
2. **`HostPolicy` port** (in `http/`, not `core/`):

   ```ts
   type HostKind = { kind: "main" } | { kind: "artifact"; id: string } | { kind: "reject" };
   interface HostPolicy {
     classify(host: string): HostKind;
     artifactUrl(id: string): string;
     galleryUrl(): string;
   }
   ```

   `LocalHostPolicy` reproduces today's guard and `artifactUrl` exactly (subdomain and path modes, port rules). `DomainHostPolicy` takes the view domain; AWS has subdomain mode only.
3. **Split the app.** `createViewingApp(deps)` (platform routes, artifact viewing, gallery, path mode) and `createControlApp(deps)` (`/api`, `/mcp`, their browser and token guards). Local `createApp` mounts both behind the same host dispatch as today.
4. **Token check as a port.** `TokenVerifier = (presented: string) => Promise<boolean>`. Local wraps `ARTIFACT_TOKEN` (timing-safe, as in [0027](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0027-listeners-host-token-guards.md)); AWS checks the SHA-256 against a cached list from Secrets Manager.
5. **Raw request target.** The traversal guard reads the raw target through a hook set by the server adapter: `@hono/node-server` locally, the Lambda event's `rawPath` + `rawQueryString` on AWS.
6. **Reload client config.** `/__artifact/reload.js` = a one-line config prefix (`{transport, viewSuffix, pathMode}`) + the shared client. Transports: `sse` (today) and `appsync` (M11). The `node:vm` tests ([0031](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0031-reload-client.md)) run once per transport.
7. **`/__artifact/version`** on every artifact origin, both platforms.
8. **Import boundaries.** Extend `test/core/import-boundary.test.ts`: `core/`, `http/`, `mcp/`, `cli/` and `adapters/` never import `src/cdk/`, `src/runtime/`, `aws-cdk-lib` or `@aws-sdk/*` (except `cli/token.ts`, through a dynamic import); `src/cdk/` never imports `src/runtime/` (it references the built assets only); `core/` still imports no I/O.
9. **Version pruning in the core.** `service.pruneVersions({keepLast?, olderThan?})`: per artifact, it removes chosen versions from `meta.json` `versions` with the usual pointer CAS (retrying on conflict), then deletes their objects. It never prunes the current version and does not emit events. It is tested on the memory and fs stores. Local `serve` does not call it in v2, so local behaviour is unchanged.

## Construct library and infrastructure

The AWS deployment ships as a CDK construct inside the same npm package: `import { ArtifactHosting } from "@nikovirtala/artifact/cdk"`. Anyone adds it to their own CDK app and gets a private artifact host in their own account; one name and one version cover the CLI, the server and the construct, so there is no compatibility matrix. The owner's own deployment is just one consumer, kept in `examples/personal/`.

**Package shape**

- `exports`: `"./cdk"` → `dist/cdk/index.js` (+ types) beside the existing entries; `bin` stays `artifact`.
- `peerDependencies`: `aws-cdk-lib ^2`, `constructs ^10`, `@aws-sdk/client-secrets-manager ^3`, all marked optional in `peerDependenciesMeta`. `npx @nikovirtala/artifact serve` installs none of them; a CDK app already has the first two.
- `dependencies`: unchanged (the four v1 runtime deps).
- Lambda and edge code is prebuilt into `dist/assets/<name>/` at build time. Bundles mark `@aws-sdk/*` as external and use the SDK v3 that the `nodejs24.x` runtime provides, which keeps the CLI download small; the cost is that the SDK version follows AWS's runtime updates rather than the lockfile.

**Repo layout**

```
artifact/
  pnpm-workspace.yaml          # packages: ["examples/*"]
  package.json                 # @nikovirtala/artifact: CLI + server + construct
  src/
    core/ http/ mcp/ cli/ adapters/   # v1
    cdk/                       # the construct; imports aws-cdk-lib, constructs
      index.ts                 # ArtifactHosting, ArtifactCertificate, ArtifactIdentity, props types
      artifact-hosting.ts, certificate.ts, identity.ts
    runtime/                   # Lambda + edge sources; bundled, never imported at runtime by the package
      adapters/s3-store.ts, adapters/appsync-notifier.ts
      auth/session.ts, auth/oidc.ts
      handlers/control.ts, viewing.ts, events-authorizer.ts, sweep.ts
      edge/viewer-request.js
    cli/token.ts               # artifact token create | revoke | list --secret <arn>
  scripts/bundle-assets.ts     # esbuild each handler → dist/assets/<name>/index.mjs
  examples/personal/           # private CDK app, depends on workspace:*, the reference deployment
```

**Construct API** (shape to refine in an ADR; names are proposals):

```ts
import { ArtifactCertificate, ArtifactIdentity, ArtifactHosting } from "@nikovirtala/artifact/cdk";

const cert = new ArtifactCertificate(usEast1Stack, "Cert", { viewDomain, hostedZone });

const artifacts = new ArtifactHosting(this, "Artifacts", {
  viewDomain: { name: "art.example.dev", hostedZone, certificate: cert.certificate },
  apiDomain: { name: "artifact-api.example.dev", hostedZone },
  identity: ArtifactIdentity.cognito({ owners: ["me@example.dev"] }),
  // IdP federation (ArtifactIdentity.federated) is later work
  limits: { maxPublishBytes: 4 * 1024 * 1024 },      // optional, defaults per Key decisions
  dataRetention: {                                    // optional
    onDestroy: RemovalPolicy.RETAIN,                  // default RETAIN
    versions: { keepLast: 20, olderThan: Duration.days(90) }, // default: keep all
  },
  logRetention: RetentionDays.ONE_MONTH,              // optional
  alarmEmail: "me@example.dev",                       // optional
});

artifacts.apiUrl; artifacts.viewUrl; artifacts.tokenSecret;
artifacts.bucket; artifacts.distribution; artifacts.httpApi; artifacts.eventApi;
```

The example uses placeholders. `examples/personal` passes the real reference names: `viewDomain` `artifact.nikovirtala.dev` (pages at `<id>.artifact.nikovirtala.dev`) and `apiDomain` `api.artifact.nikovirtala.dev`, in eu-north-1.

**Rules for the construct**

- Assets ship prebuilt in the package (`Code.fromAsset` on `dist/assets/…`), so consumers need no esbuild, Docker or repo checkout, and a package version always deploys the core of the same commit.
- No hard-coded physical names, accounts or regions: two instances in one stack, or in one account, never collide.
- Every resource sits under the construct's scope; the main resources are exposed as properties for escape hatches; `CfnOutput`s for the API URL, view URL and token secret.
- Safe defaults: private bucket, retained data, viewing behind login, publish only through IAM.
- Certificate: CloudFront needs one in us-east-1. `ArtifactCertificate` creates it in a us-east-1 stack (the example uses `crossRegionReferences`); consumers may pass their own instead; a platform deployed in us-east-1 may create it itself.
- With the built-in Cognito pool, owners are emails: the construct creates those users (Cognito sends the invite) and the allowlist matches the verified `email` claim. Later, a federated IdP will allowlist `sub` values or emails.
- Tokens: `artifact token create <name> --secret <arn>` prints a random token once and stores its SHA-256; `revoke` removes it. It loads `@aws-sdk/client-secrets-manager` on demand and, if the peer is missing, exits with the install command. Lambdas cache the list for 5 minutes.
- Compatibility: `GET /api` returns `{version}`; the CLI warns when its major version differs from the server's.

**Stages.** v2 deploys one stage, built so more can be added without restructuring:

- `examples/personal` defines an `ArtifactStage extends Stage` holding the certificate stack and the platform stack, built only from a typed `StageConfig` (`{name, env: {account, region}, viewDomain, apiDomain, owners, removalPolicy, …}`).
- `bin/app.ts` instantiates it once from a `stages` map (`{ prod: {...} }`). Adding a stage means one more map entry, for example `test` in another account, with nothing else changing.
- No account ids, domains or names outside that config; stack names and SSM/secret paths derive from the stage name.
- Stage-independent test resources (the contract-test bucket and its GitHub OIDC role) live in their own stack, outside `ArtifactStage`.

**Data retention.** Configurable through the `dataRetention` prop; the defaults keep everything:

- `onDestroy`: what `cdk destroy` does to the bucket. Default `RETAIN`; `DESTROY` empties and removes it (auto-delete objects).
- `versions`: pruning of non-current versions. Default: keep all, as v1 does ([0013](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0013-version-retention.md)). With `keepLast: n` and/or `olderThan: duration`, a version is pruned only when it is outside the newest n **and** older than the duration (either alone works too). The current version is never pruned, even after a rollback.
- S3 lifecycle rules cannot tell the current version from the others, so pruning runs in the scheduled sweep Lambda, through a new core method (below), not as a bucket lifecycle rule.
- A pruned version's pinned URL (`/v/<n>/`) returns 404; CloudFront may serve its cached copy until expiry. The README says so.
- Log retention stays its own prop (`logRetention`).

**Resources the construct creates**

| Resource | Settings that matter |
| --- | --- |
| S3 bucket | Block all public access, SSE-S3, enforce TLS, no versioning (versions are already immutable keys), lifecycle: abort incomplete uploads after 1 day |
| Viewing Lambda | `nodejs24.x`, arm64, 512 MB; S3 `GetObject` + `ListBucket` only; function URL `AWS_IAM` + OAC; reserved concurrency cap |
| Control Lambda | `nodejs24.x`, arm64, 1024 MB, 30 s; S3 read/write/delete; `appsync:EventPublish`; Secrets Manager read |
| API Gateway HTTP API | Custom domain, default throttling (e.g. 20 rps, burst 40), access logs |
| CloudFront distribution | Alternate names `<view domain>` and `*.<view domain>`; viewer-request function; cache policy keyed on `x-artifact-host` + path + query, no cookies; honour origin `Cache-Control`; origin request policy forwards `x-artifact-host` only |
| CloudFront KeyValueStore | Session-signing keys by `kid` |
| AppSync Event API | Namespace `artifacts`; publish `AWS_IAM`, connect/subscribe `AWS_LAMBDA` |
| Authorizer Lambda | Verifies events tokens; result cache off or ≤ 60 s |
| Cognito user pool | Self-sign-up off, owners created from props, one public PKCE client, hosted login |
| Secrets Manager | API token hashes; session key; events key |
| EventBridge Scheduler | Daily `sweepOrphans`, plus `pruneVersions` when `dataRetention.versions` is set |
| Route 53 records + regional ACM cert | Alias records for both domains (an explicit API record overrides the view domain's wildcard); regional cert for the API host, with a regional (not edge-optimized) API custom domain so it cannot clash with the distribution's wildcard; the edge function never routes the API label |
| CloudWatch | Log retention from props; alarms on Lambda errors, 5xx rate, authorizer errors, to an SNS topic when `alarmEmail` is set |

## Build plan

Six milestones. M7 and M8 touch no AWS account beyond a test bucket; nothing is reachable from the internet until M10, and viewing ships behind login from its first deploy.

1. **M7 — Seams in v1 (local only).** Code changes 1–8 above.
   - [ ] Every v1 test passes unchanged; `pnpm test:pack` passes.
   - [ ] `pruneVersions` on the memory and fs stores: `keepLast` and `olderThan` alone and combined; the current version survives, also after a rollback to an old version; a concurrent publish during pruning is never lost (pointer CAS retry); pruned versions' objects are gone and `read` reports them as not found.
   - [ ] Limits injected at 1 KiB make the core, `/api` and `/mcp` return `too_large` / 413 with that number.
   - [ ] `DomainHostPolicy` table tests: apex, valid id, uppercase id, unknown label, foreign domain, IP literal, port forms.
   - [ ] `reload.js` vm tests pass for the `sse` transport with the new config prefix; `/__artifact/version` returns the current version.
2. **M8 — S3 adapters.** `aws/` workspace, `S3BlobStore` + `S3PointerStore`, test bucket stack.
   - [ ] The v1 contract suite passes against a real bucket (skipped without `ARTIFACT_TEST_BUCKET`).
   - [ ] Conditional writes: 412 → `precondition_failed`; 409 `ConditionalRequestConflict` → `precondition_failed` (the protocol then retries); other errors throw.
   - [ ] `test/core/concurrency.test.ts` runs against S3 with two service instances (two "processes"): no lost or duplicated version.
   - [ ] Dev harness `pnpm --filter aws dev:serve` runs the local server on S3 stores; the v1 e2e suite passes through it.
   - [ ] ADR records the `list` cost (one `GET` per artifact) and the threshold for an index.
3. **M9 — Construct + control plane.** `src/cdk/` with `ArtifactHosting`, `ArtifactCertificate` and `ArtifactIdentity`; asset bundling; bucket, control Lambda, HTTP API, tokens, sweep schedule; `examples/personal` consumes it.
   - [ ] Construct tests with `aws-cdk-lib/assertions` cover the Cognito identity, given and created certificates, and two instances in one stack with no name clashes.
   - [ ] No Cookie header in logs: the session cookie also reaches `api.artifact.nikovirtala.dev`, so a request to `/api` and `/mcp` that carries a session cookie leaves no trace of the cookie in the control Lambda's logs or the HTTP API access logs (the access log format lists fields explicitly, no headers).
   - [ ] `dataRetention`: with the defaults, the bucket survives `cdk destroy` and every version stays. With `keepLast: 2`, the scheduled sweep prunes older versions but keeps the current one after a rollback to v1. With `onDestroy: DESTROY`, teardown removes the bucket.
   - [ ] A fresh `cdk init` app outside the repo deploys it from the `pnpm pack` tarball with under 20 lines of stack code, and needs no esbuild, Docker or repo checkout.
   - [ ] The same tarball installed with no peers: `artifact serve` and every CLI command still work, and nothing from `aws-cdk-lib` is installed.
   - [ ] `ARTIFACT_TOKEN=… artifact publish page.html --server https://<api host>` returns `{id, version, url}` with a `<view domain>` URL; republish increments the version.
   - [ ] Claude Code connected with `claude mcp add --transport http artifacts https://<api host>/mcp --header "Authorization: Bearer $ARTIFACT_TOKEN"` can publish, list, read, roll back.
   - [ ] No token / wrong token → 401; a request with `Origin` → 403; `file_path` → `invalid_input`; a 5 MiB file → `too_large`.
   - [ ] `artifact token create` prints a working token once; `revoke` stops it within 5 minutes; without the SDK peer it exits with the install command.
   - [ ] The bucket denies anonymous and non-TLS access (checked with an unsigned request).
4. **M10 — Viewing plane + login.** Viewing Lambda, function URL with OAC, distribution, edge function, KVS, Cognito, login routes.
   - [ ] Without a cookie: a page → 302 to login; `/__artifact/version` → 401; after login the page loads.
   - [ ] Right after a publish, a hard refresh of the current URL shows the new version (no stale edge copy).
   - [ ] A pinned `/v/<n>/` asset is a cache hit on its second request (`x-cache: Hit from cloudfront`); the cookie never reaches the origin (origin logs) and is not in the cache key.
   - [ ] A tampered, expired or unknown-`kid` cookie → login; a `return` to another domain → gallery.
   - [ ] Traversal attempts → 400; an unknown host → 403; artifact A's page cannot read B's `localStorage`.
   - [ ] Calling the function URL directly → 403.
   - [ ] Latency recorded, not gated: p50 and p95 time-to-first-byte from a nearby client for an HTML page and a 10-asset page, warm and after 30 min idle, plus a pinned-version page; numbers go in an ADR that confirms the Lambda origin or triggers the KVS fallback.
5. **M11 — Live reload.** Event API, authorizer, `AppSyncNotifier`, events token, `appsync` transport in `reload.js`.
   - [ ] A tab on the current URL reloads within 2 s (p95 of 20 publishes) of a publish or rollback; a pinned tab never reloads.
   - [ ] Network dropped for 60 s while a publish lands: the tab reloads within 5 s of reconnecting.
   - [ ] A token for A cannot subscribe to B; nobody but the control Lambda can publish.
   - [ ] Delete shows the v1 banner.
6. **M12 — CLI, docs, release.**
   - [ ] Named servers: `ARTIFACT_SERVER` / `--server` as today, plus optional profiles in `~/.config/artifact/config.json` (`{"default":"aws","servers":{"aws":{"url":…}}}`); tokens stay in env vars.
   - [ ] `artifact init --server https://<api host>` writes the snippet and prints the `claude mcp add` line with the header (variable name, never the secret), as in [0046](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0046-artifact-init.md).
   - [ ] `artifact publish` against a non-loopback server opens new artifacts in the local browser (same opt-outs as [0040](https://github.com/nikovirtala/artifact/blob/main/docs/decisions/0040-auto-open-new-artifacts.md)).
   - [ ] README: "Deploy to AWS" from zero to a reloading tab in under 30 minutes, plus teardown.
   - [ ] Release one package, `@nikovirtala/artifact`, with the construct included, through the existing trusted-publishing workflow; minor if no client-visible break, else major with a migration note. The README's Deploy to AWS section covers construct props, outputs, costs and teardown.

## Testing, operations and cost

The contract suite against a real bucket is the gate for M8; a deployed stage with a smoke test is the gate for M9–M11.

| Layer | What | How |
| --- | --- | --- |
| Unit | Host policy, limits, session and events tokens, OIDC checks, authorizer decisions | `node:test`, fake clock; tokens checked against shared test vectors |
| Edge function | `viewer-request.js` | Run in `node:vm` with fake events and a fake KVS, the same vectors as the Lambda side, so both sides of the HMAC agree |
| Contract | `S3BlobStore`, `S3PointerStore` | v1 suite against a real test bucket in CI, through a GitHub OIDC role scoped to that bucket |
| Handlers | Control and viewing Lambdas | Hono `app.request()` with Lambda-shaped events, in-memory stores |
| Smoke (stage) | Publish → view → reload → delete against a deployed stage | A script using the CLI, a session cookie minted with the stage key, and a WebSocket subscriber; manual trigger only |
| Infra | Stack shape | Construct assertions over prop combinations (IAM, public access, cache policy) + a snapshot of `examples/personal` |

CI runs unit, edge, handler and `cdk synth` on every PR; contract and smoke run on demand with the OIDC role. The agent never deploys the owner's stage without being asked.

`pnpm test:pack` grows two checks: the tarball installed with no peers runs the CLI and local server, and a throwaway CDK app imports `@nikovirtala/artifact/cdk` from it and synthesises.

**Operations.** Logs kept 30 days; alarms on Lambda errors, 5xx rate and authorizer errors to an SNS topic (email). Teardown: `cdk destroy` keeps the bucket by default (`RemovalPolicy.RETAIN`); a flag empties and removes it.

**Cost.** At one owner's scale, expect a few US dollars a month, mostly fixed items: the hosted zone and three secrets. Lambda, API Gateway, CloudFront, S3 and AppSync are per request and should stay near zero. This is an estimate; check Cost Explorer after the first week.

## AWS facts to verify

The plan rests on the AWS behaviours below. They come from documentation read while planning, or from memory, and have not been tried. **Implementer: verify each one before building on it, at the start of the milestone named, against current AWS documentation or with a small spike in the test account.**

- **It holds:** record it in that milestone's ADR with the source link (or the spike result) and continue.
- **It does not hold, or only partly:** stop that piece of work. Write down what you found and the options, using the last column as a starting point, and **ask the owner before choosing**. Do not pick a workaround silently.
- **Either way:** list every checked fact and its result in the milestone summary.

| # | Fact to verify | Milestone | The plan relies on it for | If it does not hold |
| --- | --- | --- | --- | --- |
| V1 | S3 `PutObject` supports `If-None-Match: *` and `If-Match: <etag>` on a general purpose bucket; a lost race returns 412, a concurrent conditional write can return 409 `ConditionalRequestConflict`; reads after a write are strongly consistent | M8 | The publish protocol (claims, pointer CAS) on S3 | Pointer and claims in a DynamoDB table with conditional writes; objects stay in S3 |
| V2 | The AWS SDK v3 shipped in the `nodejs24.x` Lambda runtime (eu-north-1, arm64) includes the S3 conditional-write parameters | M8 | Using the runtime's SDK instead of bundling one | Bundle a pinned `@aws-sdk/client-s3` for the Lambdas (the fallback already agreed) |
| V3 | Lambda's synchronous request limit is about 6 MB, and an HTTP API passes bodies of that size to Lambda | M9 | `too_large` limits of 4 MiB per file and per publish | Adjust the limits to what holds, or pull staged uploads forward |
| V4 | A Lambda function URL behind CloudFront with OAC needs `x-amz-content-sha256` from the client on `POST`/`PUT` | M9 | Choosing API Gateway over a function URL for `/api` and `/mcp` | API Gateway may be unnecessary: ask before removing it |
| V5 | A regional API Gateway custom domain `api.artifact.nikovirtala.dev` coexists with a CloudFront distribution whose alternate names include `*.artifact.nikovirtala.dev`, with an explicit Route 53 record overriding the wildcard | M9 | The chosen API host name | Move the API host outside the view domain (for example `artifact-api.nikovirtala.dev`) |
| V6 | CloudFront Functions (`cloudfront-js-2.0`, viewer request) can read KeyValueStore and verify HMAC-SHA256 with the `crypto` module within their size and CPU limits | M10 | The session-cookie check at the edge | Lambda@Edge for the check, or the check in the viewing Lambda (pages behind login lose edge caching) |
| V7 | A viewer-request function can set `x-artifact-host`; a cache policy can key on it; an origin request policy forwards it to a function URL origin while the Host header is replaced | M10 | One distribution serving every `<id>` subdomain from one origin | Another way to pass the host, decided with the owner |
| V8 | Cognito supports a public app client with authorization code + PKCE and the managed login pages, and CDK can create owner users so that Cognito sends their invites | M10 | Login with no self-sign-up | Owners created by a post-deploy script; ask the owner |
| V9 | AppSync Events: per-namespace auth (publish `AWS_IAM`, connect and subscribe `AWS_LAMBDA`); a browser can pass the Lambda authorizer token in the WebSocket handshake; authorizer caching can be off or short; `aws-cdk-lib` has a usable `EventApi` construct | M11 | Live reload on AWS | API Gateway WebSockets with a connection table; ask the owner first |
| V10 | Only if the KVS fallback is triggered: CloudFront Functions can choose the origin per request; KVS updates use a store-wide ETag; how long propagation takes | M10 (fallback only) | The KVS serving fallback | Revisit the fallback design with the owner |

Already checked while planning: the `nodejs24.x` runtime exists ([AWS](https://aws.amazon.com/blogs/compute/node-js-24-runtime-now-available-in-aws-lambda)), and AppSync Events lets each channel namespace override the default auth modes, with a Lambda authorizer that sees the operation and the channel ([AWS](https://docs.aws.amazon.com/appsync/latest/eventapi/configure-event-api-auth.html)). Confirm them in the ADRs anyway.

## Agent brief, later work and open questions

Save this document as `docs/01-plan-aws.md` in the repo and hand the agent the brief below.

```
Build artifact v2 (AWS deployment) as described in docs/01-plan-aws.md, milestone by milestone (M7 → M12).
- Follow AGENTS.md (linear history, signed atomic commits, Conventional Commits).
- Before each milestone, restate its acceptance criteria as failing tests, then implement until they pass.
- Record each decision in docs/decisions/, continuing at 0050. Overturning a decision in the plan needs an ADR with the evidence.
- M7 must not change local behaviour: every existing test passes unchanged after every commit.
- One package: the construct ships as @nikovirtala/artifact/cdk. aws-cdk-lib, constructs and @aws-sdk/client-secrets-manager are optional peer dependencies; the runtime dependencies stay the v1 four.
- The construct is a library: no hard-coded names, accounts or regions; prebuilt assets ship in the package; examples/personal is only a consumer.
- Respect the import boundaries in the plan; core/ still imports no I/O.
- Verify every item in "AWS facts to verify" (V1–V10) at the start of its milestone. If it holds, record it in the ADR with its source. If it does not hold, stop that piece and ask the owner with the options; never pick a workaround silently. Report each result in the milestone summary. Treat any other AWS detail in the plan the same way.
- Never deploy to the owner's account or rotate secrets unless asked; tests use the test bucket role only.
- Stop after each milestone: run pnpm check, summarise what changed, list deviations from the plan and why.
```

**Later work** (not in v2):

- Public or unlisted links per artifact: a `visibility` field in `meta.json`, mirrored to a KVS allowlist the edge function checks.
- **Recommended next step after v2.** Staged uploads for publishes over the AWS limits (3 MiB by default, see [0066](decisions/0066-control-lambda.md)): presigned `PUT`s to a staging prefix, then a publish that references them, lifting the ~6 MB Lambda ceiling.
- OAuth 2.1 for MCP clients (protected resource metadata, an authorization server), replacing static tokens.
- A `DynamoDB` index for `list` if one `GET` per artifact becomes slow.
- Other languages (Python, Java, …) and a Construct Hub listing through jsii, only if someone asks for it.
- Artifact as a service: a dedicated view domain on the Public Suffix List, with per-artifact sessions (central login hands each `<id>` subdomain its own host-only cookie).
- IdP federation for login (Google, GitHub through an OIDC bridge, SAML) as an `ArtifactIdentity` option on the Cognito pool.
- `artifact serve --store s3://<bucket>` as a supported local mode (the S3 SDK as another optional peer), promoted from the M8 dev harness.

**Open questions** (settle before M9):

- [x] View domain: decided: artifact.nikovirtala.dev for the reference deployment (pages at \<id>.artifact.nikovirtala.dev; a subdomain of your own domain suits personal use under `nikovirtala.dev`); a dedicated domain only for hosting others' HTML (see Isolation). API host: api.artifact.nikovirtala.dev (see Domains).
- [x] Identity provider: decided: Cognito user pool in v2; IdP federation is later work.
- [x] Session length: decided: 30 days.
- [x] Account and environments: decided: a single stage for now, structured so separate stages can be added later (see Stages).
- [x] Bucket on `cdk destroy`: decided: retain by default, with data retention configurable (see Data retention).
- [x] Should `artifact serve --store s3://…` become a supported local mode? Decided: it stays a dev harness in v2; a supported mode is later work.
- [x] TypeScript only, or jsii for other languages? jsii compiles with its own TypeScript 5.x and restricts the public API's types, so it would pin the package off TypeScript 7 (and would likely force the construct back into a separate package). Decided: TypeScript only; reconsider jsii if someone asks for another language.
- [x] Names: subpath `@nikovirtala/artifact/cdk` and construct `ArtifactHosting`, decided (`ArtifactService` was taken by the core.)
- [x] Lambda bundles: use the runtime's AWS SDK (smaller download, SDK version drifts with AWS) or bundle a pinned SDK (reproducible, a few MB more for CLI users)? Decided: the runtime's SDK; switch to a pinned SDK if runtime updates ever cause problems.
