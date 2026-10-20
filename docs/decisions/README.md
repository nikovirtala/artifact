# Decision records

One short file per decision, numbered in order. Status is **Accepted** (in effect), **Proposed** (pending owner decision), or **Superseded by NNNN**. Add a new record rather than rewriting an accepted one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-toolchain-pinning.md) | Pin Node 24 and pnpm with mise and `packageManager` | Accepted |
| [0002](0002-typescript-7.md) | TypeScript 7 from the `typescript` package; `types: ["node"]` | Accepted |
| [0003](0003-test-runner.md) | `node --test` with a quoted glob, running `.ts` directly | Accepted |
| [0004](0004-core-import-boundary.md) | Enforce the core import boundary with a test | Accepted |
| [0005](0005-build-and-assets.md) | Build script, strict asset copy, no reload-client placeholder | Accepted |
| [0006](0006-package-entry.md) | Empty library entry `src/index.ts`; CLI-only package from M2 | Accepted |
| [0007](0007-cli-m0-behaviour.md) | M0 CLI: usage only, no argument-parsing dependency | Accepted |
| [0008](0008-npm-name.md) | npm package name `@nikovirtala/artifact` | Accepted |
| [0009](0009-default-port.md) | Default port 4400 | Accepted |
| [0010](0010-safari-localhost.md) | Safari and `*.localhost`: works (verified), path routes still mounted, no UA switch | Accepted |
| [0011](0011-artifact-token-default.md) | `ARTIFACT_TOKEN` optional on loopback, required off loopback | Accepted |
| [0012](0012-gallery-in-v1.md) | Gallery page in v1 | Accepted |
| [0013](0013-version-retention.md) | Version retention: keep all versions | Accepted |
| [0014](0014-port-shapes.md) | S3-shaped ports and typed error results | Accepted |
| [0015](0015-publish-protocol-and-conflicts.md) | Publish protocol: claim by `src/index.html`, retry without `ifVersion` | Accepted |
| [0016](0016-hashing.md) | SHA-256 via Web Crypto in the core | Accepted |
| [0017](0017-ulid-local-implementation.md) | Local lowercase ULID implementation instead of the `ulid` package | Accepted |
| [0018](0018-fs-store-atomicity-and-locking.md) | Filesystem store: exclusive create, rename-based CAS, in-process lock | Accepted |
| [0019](0019-path-rules-and-extensions.md) | Path rules and disallowed extensions | Accepted |
| [0020](0020-reload-injection.md) | Reload-snippet injection on bytes, replacing earlier injected tags | Accepted |
| [0021](0021-api-file-encoding.md) | API file encoding (`string` or `{"base64"}`) and the shared Zod schema | Accepted |
| [0022](0022-if-match-and-etag.md) | `If-Match`, `if_version` and `ETag` | Accepted |
| [0023](0023-http-errors-and-list-limit.md) | HTTP status codes, error body and the list limit | Accepted |
| [0024](0024-viewing-routes.md) | Viewing routes, 308 redirects, reserved paths | Accepted |
| [0025](0025-security-headers-and-csp.md) | Security headers and CSP | Accepted |
| [0026](0026-single-server-lockfile.md) | One server per root: `<root>/.lock` | Accepted |
| [0027](0027-listeners-host-token-guards.md) | Listeners, `--host`, token and request guards | Accepted |
| [0028](0028-sse-handshake-and-reconnect.md) | SSE events: current version on every connect | Accepted |
| [0029](0029-deleted-event.md) | `deleted` event and banner | Accepted |
| [0030](0030-heartbeat-and-listener-lifecycle.md) | SSE heartbeat and listener lifecycle | Accepted |
| [0031](0031-reload-client.md) | Reload client: mode and pinning from the page URL | Accepted |
| [0032](0032-events-unknown-id.md) | Events for unknown ids: plain 404, no stream | Accepted |
| [0033](0033-mcp-transport-and-sdk.md) | MCP: stateless Streamable HTTP, low-level SDK `Server`, Zod 4 | Accepted |
| [0034](0034-mcp-tool-results-and-errors.md) | MCP tool results and errors: the API's objects, `isError` | Accepted |
| [0035](0035-file-path.md) | `file_path`: absolute `.html` as `index.html`, siblings via `files`, can be disabled | Accepted |
| [0036](0036-mcp-tool-descriptions.md) | Tool descriptions are the agent contract | Accepted |
| [0037](0037-no-browser-requests-to-api-and-mcp.md) | Browser requests (`Origin` or `Sec-Fetch-Site`) to `/api` and `/mcp` get 403 | Accepted |
| [0038](0038-tool-selection-wording.md) | Tool-selection wording and the CLAUDE.md snippet | Accepted |
| [0039](0039-project-identifier-and-filtering.md) | Project identifier and list filtering; users and sessions deferred | Accepted |
| [0040](0040-auto-open-new-artifacts.md) | Open new artifacts in the browser | Accepted |
| [0041](0041-cli-client-conventions.md) | CLI client conventions: server, token, output, `--json`, exit codes | Accepted |
| [0042](0042-cli-project-derivation.md) | Project derivation in the CLI, shared by publish, list and init | Accepted |
| [0043](0043-cli-publish-and-read.md) | `artifact publish` and `artifact read` (`--out`, manifest route) | Accepted |
| [0044](0044-cli-open-rollback-rm.md) | `artifact open`, `rollback`, `rm`; `ARTIFACT_OPENER_LOG` | Accepted |
| [0045](0045-stdio-mcp-bridge.md) | `artifact mcp`: stdio bridge over SDK transports | Accepted |
| [0046](0046-artifact-init.md) | `artifact init`: snippet block, project pin, settings merge | Accepted |
| [0047](0047-orphan-sweep.md) | Orphan sweep on startup; `lastModified` in `BlobStore.list` | Accepted |
| [0048](0048-packaging-and-pack-test.md) | Packaging and the `test:pack` tarball test | Accepted |
| [0049](0049-release-via-trusted-publishing.md) | Release on merge via GitHub Actions trusted publishing | Accepted |
| [0050](0050-v2-import-boundaries.md) | Import boundaries for `src/cdk/`, `src/runtime/`, `aws-cdk-lib` and `@aws-sdk/*` | Accepted |
| [0051](0051-injectable-limits.md) | Injectable limits owned by the service; body cap 1.5× with an override | Accepted |
| [0052](0052-version-pruning.md) | `pruneVersions`: keepLast AND olderThan; current and latest kept; pointer CAS first | Accepted |
| [0053](0053-host-policy.md) | `HostPolicy` port: `LocalHostPolicy` and `DomainHostPolicy` (port and label rules) | Accepted |
| [0054](0054-token-verifier.md) | `TokenVerifier` port for bearer tokens | Accepted |
| [0055](0055-raw-target-hook.md) | Raw request target through a server-adapter hook | Accepted |
| [0056](0056-viewing-and-control-apps.md) | Viewing and control apps; local composition order and shared error handler | Accepted |
| [0057](0057-version-route.md) | `GET /__artifact/version` on every artifact origin | Accepted |
| [0058](0058-reload-client-config.md) | Reload client config prefix; the local prefix is line 1 of the client file | Accepted |
| [0059](0059-aws-layout.md) | S3 adapter in `src/runtime/`, dev tooling in a private `aws/` workspace | Accepted |
| [0060](0060-s3-stores.md) | `S3BlobStore` / `S3PointerStore`: conditional writes, error mapping, key prefix | Accepted |
| [0061](0061-list-cost-and-index-threshold.md) | `list` on S3: one LIST page per 1,000 artifacts plus one `GET meta.json` per artifact; index threshold | Accepted |
| [0062](0062-s3-dev-harness.md) | Dev harness: `pnpm --filter aws dev:serve` runs `artifact serve` on S3 stores | Accepted |
| [0063](0063-test-resources-stack.md) | Test resources stack: contract bucket + GitHub OIDC role | Accepted |
| [0064](0064-api-version-route.md) | `GET /api` returns the server version; the CLI warns on a major mismatch | Accepted |
