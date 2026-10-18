# Local Artifact Server — Spec & Build Plan

Oct 17, 2026 · @Niko Virtala

## Overview

Build a local server that hosts HTML artifacts at stable URLs, keeps every publish as an immutable version, and reloads open browser tabs the moment an agent republishes. Agents publish through an MCP server; storage uses an S3-shaped key layout so the same core can later run on AWS with only the adapters swapped.

The loop it enables: ask an agent for a change → it edits the HTML and calls `publish` with the same id → the tab you have open reloads on its own.

**Goals (v1)**

- Publish a page (single file or a set of files) and get a stable URL back.
- Republish to the same id creates a new version; the URL stays the same.
- Open tabs on the current URL reload within 1 s of a publish; pinned version URLs never reload.
- Agents (Claude Code or any MCP client) can create, update, list, read and roll back artifacts.
- Runs locally with one command on Node.js 24; no external services. Published to npm, so a fresh repo or machine starts it with npx @nikovirtala/artifact serve.
- Core logic is independent of transport and storage, behind ports, so AWS adapters slot in later.

**Non-goals (v1)**

- Multi-user auth, sharing, comments, permissions.
- Runtime capabilities for pages (shared database, asking the model, connected data).
- In-browser editing of artifacts.
- Building or bundling artifacts: the server hosts what it is given, as is.

## Concepts and storage layout

An artifact is an id plus an ordered list of immutable versions and one pointer to the current version. Every publish writes a new version directory first, then moves the pointer with a conditional write. Rollback only moves the pointer.

| Concept | Definition |
| --- | --- |
| Artifact id | 26-char lowercase ULID (Crockford base32). Lowercase so it is valid as a DNS label for `<id>.localhost` origins. |
| Version | Integer from 1, strictly increasing per artifact. Immutable once written. Gaps are expected (a lost race or a crash leaves an uncommitted number behind). |
| Pointer | `meta.json` holding `currentVersion`, `title`, `createdAt`, `updatedAt` and the committed `versions: [{version, createdAt, label?}]`. The only mutable object per artifact. Its etag is store-derived (content hash locally, the S3 ETag on AWS), not stored in the file. |
| Entry page | `index.html` at the version root. Required. |
| Supporting files | Any other relative paths in the same version (css, js, json, images, fonts). |
| Label | Optional short name for a publish (≤ 60 chars), stored in the manifest and in `meta.json` `versions`. |
| Project | Optional identifier of the codebase an artifact was made in, passed by the agent: a git remote URL or `local:<absolute path>`, normalised (for example `github.com/nikovirtala/artifact`). Set on create, never changed; `list` filters by it. See [0039](decisions/0039-project-identifier-and-filtering.md). |

Key layout, identical on local disk and in S3 (local root defaults to `~/.artifacts/`):

```
artifacts/<id>/meta.json                      # pointer: currentVersion, title, project?, createdAt, updatedAt, versions[{version, createdAt, label?}]
artifacts/<id>/v/<n>/manifest.json            # files[{path, size, sha256, contentType}], label, createdAt
artifacts/<id>/v/<n>/src/<path>               # files exactly as published (returned by read)
artifacts/<id>/v/<n>/www/<path>               # served tree: html with the reload snippet injected, other files copied
```

Rules:

- Writes go `src/index.html` (create-only; it claims the version number) → rest of `src/` → `www/` → `manifest.json` → pointer. A crash before the pointer move leaves an orphaned version that is never served; a sweep can remove it later.
- The pointer update is a compare-and-swap on the store-derived etag (local: write to temp file + rename under a per-id lock; S3: `If-Match` conditional `PutObject`). A mismatch returns `version_conflict` with the current version.
- The reload snippet is injected at publish time into `www/`, not at serve time. This keeps serving a dumb static read, which maps directly to S3 + CloudFront later.
- Version numbers are allocated from the pointer read at publish start. The create-only `src/index.html` claims the number, and the conditional pointer write commits it, so no two publishes share a number. Use `If-None-Match: *` semantics when creating `v/<n>/src/index.html` and `v/<n>/manifest.json`. See [0015](decisions/0015-publish-protocol-and-conflicts.md).

## Architecture

One process hosts everything: the MCP endpoint, the JSON API and the viewing routes all call a single core service, which talks to storage and notifications only through ports.

&#91;embedded content: local architecture · 3 entry points, 1 core, 2 ports\]

A publish from either entry point writes a new version, moves the pointer, then emits an event; the SSE stream turns that event into a reload in every tab open on that artifact's current URL.

## Interfaces

Three entry points share one core service: the HTTP server (viewing + JSON API), the MCP endpoint (agents), and a CLI (humans and scripts). The CLI and MCP never touch storage directly; they call the core or the JSON API.

**HTTP: viewing** (default port 4400, bound to 127.0.0.1 and ::1; see [0024](decisions/0024-viewing-routes.md))

| Route | Returns |
| --- | --- |
| `GET http://<id>.localhost:4400/` | Current version's `www/index.html` (subdomain mode, default) |
| `GET http://<id>.localhost:4400/<path>` | Supporting file from current version's `www/` |
| `GET http://<id>.localhost:4400/v/<n>/…` | Pinned version; reload snippet stays inert |
| `GET http://localhost:4400/a/<id>/…` | Same as above in path mode, including `/a/<id>/v/<n>/…`; always mounted (fallback when `*.localhost` does not resolve) |
| `GET /__artifact/reload.js` | The reload client script, on every allowed host ([0031](decisions/0031-reload-client.md)) |
| `GET /__artifact/events?id=<id>` | SSE stream for one artifact; on `<id>.localhost` only that id; plain 404 for unknown ids ([0028](decisions/0028-sse-handshake-and-reconnect.md)–[0032](decisions/0032-events-unknown-id.md)) |
| `GET http://localhost:4400/` | Gallery: artifacts newest first, title, project, version, updated, link; `?project=` filters ([0012](decisions/0012-gallery-in-v1.md), [0039](decisions/0039-project-identifier-and-filtering.md)) |

**HTTP: JSON API** (`/api`, same port)

| Method + path | Body / headers | Result |
| --- | --- | --- |
| `GET /api/artifacts` | `?limit=` (1..500, default 50), `?project=` | `{artifacts: [{id, title?, project?, currentVersion, updatedAt, url}]}`; with `project`, only that project's |
| `GET /api/artifacts/:id` | — | Meta + version list + `url`; `ETag: "<currentVersion>"` |
| `GET /api/artifacts/:id/files/*` | `?version=` | One `src/` file |
| `POST /api/artifacts` | `{title?, label?, project?, open?, files: {path: "<utf8>" or {"base64": "<data>"}}}` | 201 `{id, version: 1, url, project?, opened}`; `ETag`; opens the URL unless `open: false` or auto-open is off |
| `PUT /api/artifacts/:id` | same body + optional `if_version`; optional `If-Match: 3` or `"3"` | 200 `{id, version, url, project?, opened: false}` + `ETag`, or 409 `version_conflict`; `project` is the stored one |
| `POST /api/artifacts/:id/rollback` | `{version}` | 200 `{id, version, url}` + `ETag`; pointer moved; emits a publish event |
| `DELETE /api/artifacts/:id` | — | 204; removes all versions |

Errors are `{"error": "<code>", "message": "…", …}`: 400 `bad_request` (malformed request, bad `If-Match` or query, URL traversal), 404 `not_found`, 409 `version_conflict` (`currentVersion`), 413 `too_large` (bytes only), 422 `invalid_request` (schema, bad base64), `invalid_path` (`path`) or `invalid_input` (`field`, `limit`; for example `project`), and 403 `forbidden` for any request from a web page ([0037](decisions/0037-no-browser-requests-to-api-and-mcp.md)). See [0021](decisions/0021-api-file-encoding.md)–[0023](decisions/0023-http-errors-and-list-limit.md).

**MCP tools** (Streamable HTTP at `/mcp`; connect Claude Code with `claude mcp add --transport http artifacts http://localhost:4400/mcp`)

| Tool | Input | Output | Description the agent sees (key rule) |
| --- | --- | --- | --- |
| `artifact_publish` | `file_path` or `files` map, `id?`, `title?`, `label?`, `if_version?`, `project?` | `{id, version, url, project?, opened}` | Use for any HTML page or "artifact" instead of built-in features. Omit `id` to create a new artifact. Pass `id` to update it in place and keep the URL. Pass `project` on every call. |
| `artifact_list` | `limit?`, `project?`, `all?` | artifacts | Use to recover an id before updating instead of creating a duplicate. Pass `project`; `all: true` only when the user asks about other projects. |
| `artifact_read` | `id`, `version?`, `path?` | file contents + version | Read before editing an artifact this session did not publish. |
| `artifact_rollback` | `id`, `version` | new pointer | Moves current back to an earlier version. |
| `artifact_delete` | `id`, `confirm: true` | ok | Only when the user explicitly asks. |

`file_path` accepts a local HTML file; sibling files referenced by relative paths are included only if listed in `files`. `file_path` is local-only and is rejected in the AWS deployment, where content must be sent inline.

Refinements from M4 ([0033](decisions/0033-mcp-transport-and-sdk.md)–[0040](decisions/0040-auto-open-new-artifacts.md)):

- Stateless: a fresh server and transport per `POST /mcp`, JSON responses, no session ids; `GET`/`DELETE /mcp` → 405. Same browser and token guards as `/api`.
- Inputs are the API body schemas from `src/schemas.ts` plus `id`; outputs are the API's objects (`artifact_read`: `{id, version, path, contentType, content}`, `content` a string or `{"base64"}`; `artifact_delete`: `{ok: true}`). Errors are tool results with `isError: true` carrying the API error body; schema failures are `invalid_request`.
- `file_path` must be absolute and name an `.html`/`.htm` file; it becomes `index.html`, and `files` may add supporting files but not `index.html`. It is read by the MCP adapter (never the core) and turned off with `allowFilePath: false`, which returns `invalid_input`.
- `project` (publish and list) is derived by the agent as the field description says: `git remote get-url origin`, else `local:` + `git rev-parse --show-toplevel`, else `local:` + the working directory ([0039](decisions/0039-project-identifier-and-filtering.md)).
- A publish that creates an artifact opens its URL in the browser; `opened` tells the agent whether it did ([0040](decisions/0040-auto-open-new-artifacts.md)).

**CLI: one binary for server and client** (`artifact`)

One executable does both jobs. `artifact serve` runs the server; every other command is a thin client of the running server's JSON API (default `http://localhost:4400`, override with `--server` or `ARTIFACT_SERVER`). Client commands never touch storage directly; if no server answers, they exit non-zero and suggest `artifact serve`.

| Command | Role | Does |
| --- | --- | --- |
| `artifact serve [--port 4400] [--root ~/.artifacts] [--host] [--isolation subdomain or path] [--csp] [--no-open]` | server | Viewing routes, `/api`, `/mcp`, SSE; opens new artifacts in the browser. Env: `ARTIFACT_PORT`, `ARTIFACT_CSP`, `ARTIFACT_TOKEN`, `ARTIFACT_OPEN=0`, `BROWSER=none` |
| `artifact publish <file or dir> [--id] [--title] [--label]` | client | Creates or updates; prints the URL |
| `artifact list`, `artifact read <id> [--version]`, `artifact open <id>` | client | Inspect; `open` launches the browser |
| `artifact rollback <id> <version>`, `artifact rm <id>` | client | Move the pointer; delete |
| `artifact mcp` | client | stdio MCP bridge to the running server, for MCP clients that cannot use HTTP |

## Tech stack and repo layout

Node.js 24 runs the TypeScript sources directly through native type stripping; TypeScript 7 is used only for type-checking. Use pnpm for packages and mise (mise.toml) to pin Node 24 and pnpm. Keep runtime dependencies to the five in this table (Hono, its Node server, the MCP SDK, Zod, ulid).

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 24 LTS, ESM only | Native type stripping, no build step locally |
| Types | TypeScript 7, `tsc --noEmit` | Fast native checker; code must use erasable syntax only |
| HTTP | Hono + `@hono/node-server` | Same app runs on Lambda via `hono/aws-lambda`; built-in SSE streaming |
| MCP | `@modelcontextprotocol/sdk` | Streamable HTTP server transport, stateless mode |
| Validation | Zod | MCP tool schemas and API bodies from one definition |
| IDs | `ulid` (or a 20-line local impl) | Sortable, lowercase-able |
| Tests | `node:test` + `node:assert`, `fast-check` (dev) | No test runner dependency; property tests for paths and versioning |
| Lint/format | Biome (dev) | One tool, fast |

`tsconfig.json` essentials: `"module": "nodenext"`, `"target": "esnext"`, `"strict": true`, `"erasableSyntaxOnly": true`, `"verbatimModuleSyntax": true`, `"allowImportingTsExtensions": true`, `"noEmit": true`, `"types": ["node"]`, and `"include": ["src", "test", "scripts"]`. No enums, namespaces or parameter properties (Node cannot strip them). Imports use `.ts` extensions.

**Packaging.** Node.js does not strip types from files inside `node_modules`, so the published package must ship JavaScript. Development keeps running `.ts` directly; only the package is built.

- `tsconfig.build.json` extends the base config, drops `noEmit` and `allowImportingTsExtensions`, sets `"outDir": "dist"`, `"declaration": true` and `"rewriteRelativeImportExtensions": true` so `.ts` imports become `.js`.
- `package.json`: `"name": "@nikovirtala/artifact"`, `"bin": {"artifact": "dist/cli/main.js"}`, `"exports"` only `./package.json` (CLI-only in v1, [0006](decisions/0006-package-entry.md)), `"license": "MIT"`, `"files": ["dist", "README.md", "LICENSE"]`, `"engines": {"node": ">=24"}`.
- `reload-client.js` is copied to `dist/http/` by the build script, since `tsc` does not copy non-TS files. The copy is strict: a missing asset fails the build ([0005](decisions/0005-build-and-assets.md)).
- `prepublishOnly` runs `check` then `build`.

```
artifact/
  mise.toml                 # pins node 24 and pnpm
  package.json              # "type": "module", "bin": {"artifact": "dist/cli/main.js"}, "files": ["dist"]
  tsconfig.json
  biome.json
  src/
    core/                   # pure domain: no node:fs, no hono
      artifact-service.ts   # publish, list, read, rollback, delete
      ports.ts              # BlobStore, PointerStore, Notifier, Clock, IdGen interfaces
      inject.ts             # reload-snippet injection into html
      paths.ts              # path normalisation + validation
      errors.ts             # typed error results (version_conflict, not_found, invalid_path, invalid_input, too_large)
    adapters/
      fs-store.ts           # BlobStore + PointerStore on local disk
      memory-store.ts       # for tests
      memory-notifier.ts    # in-process EventEmitter
    http/
      app.ts                # Hono app: viewing routes, /api, /__artifact/*
      sse.ts                # /__artifact/events stream
      reload.ts             # serves reload-client.js
      reload-client.js      # served as /__artifact/reload.js (plain JS, no build)
    mcp/
      server.ts             # tool definitions mounted at /mcp
    cli/
      main.ts
    schemas.ts              # Zod request schemas shared by http/ and mcp/
    config.ts
  test/
    contract/blob-store.contract.ts   # shared suite every store adapter must pass
    core/ http/ mcp/ e2e/
```

The `core/` folder must not import from `adapters/`, `http/` or `mcp/`. Enforce it with a Biome rule or a tiny test that scans imports.

## Security and isolation

The server only ever listens on loopback, and each artifact gets its own browser origin so pages cannot read each other's storage.

- **Loopback only.** Bind `127.0.0.1` and `::1` (IPv4-only with a warning if `::1` is unavailable). `--host <addr>` binds exactly that address; a non-loopback one requires `ARTIFACT_TOKEN` (otherwise the server refuses to start) and prints a warning. See [0027](decisions/0027-listeners-host-token-guards.md).
- **DNS-rebinding guard.** Reject (403) requests whose `Host` is not `localhost`, `127.0.0.1`, `[::1]` or `<id>.localhost` (valid ULID id) on the configured port.
- **No web pages on `/api` and `/mcp`.** Reject (403 `forbidden`) every request that carries an `Origin` header (any value) or a `Sec-Fetch-Site` other than `none`, with or without `ARTIFACT_TOKEN`. Path-mode pages are same-origin with the API, so an Origin allowlist is not enough; the CLI, scripts and MCP clients send neither header (the MCP spec asks servers to validate `Origin`). See [0037](decisions/0037-no-browser-requests-to-api-and-mcp.md).
- **Origin per artifact.** Default `isolation: subdomain` serves each artifact from `http://<id>.localhost:<port>`, so localStorage, IndexedDB and cookies are per artifact. Path mode shares one origin and is a documented fallback only.
- **Optional token.** If `ARTIFACT_TOKEN` is set, `/api` and `/mcp` require `Authorization: Bearer <token>` (constant-time compare). Viewing routes stay open on loopback.
- **Auto-open.** `serve` launches the browser with `spawn` and the URL as a separate argument, never through a shell; it is skipped over SSH, without a display and with a non-loopback `--host` ([0040](decisions/0040-auto-open-new-artifacts.md)).
- **One server per root.** `serve` holds `<root>/.lock` (`{pid, port, startedAt}`); a live holder makes a second `serve` exit non-zero, a dead one is taken over. See [0026](decisions/0026-single-server-lockfile.md).
- **Path safety.** Normalise every file path; reject absolute paths, `..` segments, backslashes, NUL, and anything that resolves outside the version directory; the first segments `v` and `__artifact` are reserved. Max 255 files per publish (`invalid_input`).
- **Size limits.** 16 MB per file, 64 MB per publish. Return `too_large` with the limit; `too_large` is for bytes only, while file counts and label length return `invalid_input`.
- **Content types.** Derive from extension against an allowlist (html, htm, css, js, mjs, json, svg, png, jpg, jpeg, gif, webp, avif, ico, woff, woff2, txt, md, csv, pdf, mp4, webm). Send `X-Content-Type-Options: nosniff`.
- **Headers on artifact pages.** `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`. No restrictive CSP by default, since artifacts may load from CDNs; `--csp`/`ARTIFACT_CSP` sets one. The gallery gets `default-src 'none'; style-src 'unsafe-inline'`. See [0025](decisions/0025-security-headers-and-csp.md).
- **Delete is explicit.** `artifact_delete` requires `confirm: true`; the tool description tells the agent to call it only when the user asks.

## Build plan

Seven milestones (M0–M6), each shippable and verified before the next starts. M1–M4 make the end-to-end loop work; M5 polishes; M6 is the later AWS move.

1. **M0 — Scaffold.** Package, tsconfig, Biome, `node:test` wiring, npm scripts `check` (typecheck + lint + test) and build (emit to dist/ with tsconfig.build.json).
   - [ ] `pnpm check` passes on an empty project with TS 7.
   - [ ] `node src/cli/main.ts --help` runs with no build step.
2. **M1 — Core + storage.** Ports, `ArtifactService`, `paths.ts`, `inject.ts`, memory and filesystem adapters, contract test suite.
   - [ ] Both store adapters pass the same contract suite.
   - [ ] Publish → new version; republish → version + 1; pointer moves last.
   - [ ] Concurrent publishes to one id: exactly one wins per version number, the other gets `version_conflict` or the next number; never a lost or duplicated version.
   - [ ] Property tests: any path accepted by `paths.ts` stays inside the version directory; versions are strictly increasing.
   - [ ] Injection adds exactly one `<script src="/__artifact/reload.js" defer>` before `</body>` (or at end if absent); `src/` stays byte-identical.
3. **M2 — HTTP serving + API.** Hono app with viewing routes (both isolation modes), JSON API, gallery, security headers, Host/Origin guard.
   - [ ] `curl` on the current URL returns the latest version; `/v/<n>/` returns that version.
   - [ ] Traversal attempts (`../`, encoded `%2e%2e`, `%2f`) return 400.
   - [ ] A request with `Host: evil.example` returns 403.
4. **M3 — Live reload.** SSE endpoint, in-process notifier, `reload-client.js`.
   - [ ] A tab open on the current URL reloads within 1 s of a publish or rollback.
   - [ ] A pinned `/v/<n>/` tab never reloads.
   - [ ] After the server restarts or the connection drops, the client reconnects and reloads if it missed a publish (it sends `Last-Event-ID` = its version; the server replies with the current version immediately).
   - [ ] Heartbeat comment every 20 s; no leaked listeners after 1,000 connect/disconnect cycles.
   - Notes: a `deleted` event tells open tabs their artifact is gone ([0029](decisions/0029-deleted-event.md)); the `reload-client.js` copy in the build is strict ([0005](decisions/0005-build-and-assets.md)).
5. **M4 — MCP.** Five tools at `/mcp`, stateless Streamable HTTP, Zod schemas shared with the API.
   - [ ] From Claude Code: "make an HTML page …" creates an artifact and returns its URL.
   - [ ] "Change the heading" in the same session republishes to the same id; the open tab reloads.
   - [ ] In a new session, the agent finds the artifact via `artifact_list` and updates it instead of creating a duplicate.
   - Notes: the `artifact_publish` description says that a conflict after exhausted retries means "retry the same request without `if_version`"; the `artifact_read` description tells agents to edit the HTML returned by `artifact_read`, not the served page (which carries the injected reload tag).
   - **M4 follow-up** (from the owner's Claude Code test, [0037](decisions/0037-no-browser-requests-to-api-and-mcp.md)–[0040](decisions/0040-auto-open-new-artifacts.md)):
     - [ ] A path-mode page cannot call `/api` or `/mcp` (403 on `Origin` or `Sec-Fetch-Site` other than `none`); CLI and MCP SDK clients still work.
     - [ ] The tool descriptions steer agents to publish HTML pages and "artifacts" here instead of built-in features; the README has a CLAUDE.md/AGENTS.md snippet.
     - [ ] With `project` passed, `artifact_list` returns only that project's artifacts; a new session with the same project (any URL spelling) finds and updates the artifact without a duplicate.
     - [ ] A publish that creates an artifact opens it in the browser (not updates or rollbacks), unless turned off or skipped; results say `opened`.
6. **M5 — CLI + polish.** CLI commands, rollback, delete, labels, orphan sweep on startup, npm packaging, README with the npx quick start and the Claude Code setup line.
   - [ ] Every CLI command has an e2e test against a temp root.
   - [ ] README quick start works from a clean clone in under 2 minutes.
   - [ ] `pnpm pack` tarball installed into a temp directory passes the e2e suite (catches anything still pointing at `.ts`).
   - [ ] `npx @nikovirtala/artifact serve` starts the server from the tarball with no other setup.
   - `artifact init` writes the agent snippet ([0038](decisions/0038-tool-selection-wording.md)): updates `CLAUDE.md` and `AGENTS.md` in the working directory if present, else creates `CLAUDE.md`; an idempotent block between `<!-- artifact:start -->` and `<!-- artifact:end -->`; `--dry-run`; `--global` targets `~/.claude/CLAUDE.md`; prints the `claude mcp add` line; pins the exact normalised `project` value in the snippet; opt-in `--deny-builtin` adds Claude Code's `"deny": ["Artifact"]` permission rule.
   - `artifact publish --no-open` suppresses the browser for one call (sends `open: false`, [0040](decisions/0040-auto-open-new-artifacts.md)).
   - Note: the orphan sweep also removes `artifacts/<id>/` folders without `meta.json`, skipping folders modified in the last few minutes ([0015](decisions/0015-publish-protocol-and-conflicts.md)).
7. **M6 — AWS adapters (later).** See AWS migration path.

### How live reload works

The client script reads its artifact id and pinned/current state from its own page URL (`<id>.localhost` host, or `/a/<id>/` in path mode; pinned if the path below the artifact root starts with `v/<n>/`). If pinned, it does nothing. Otherwise it opens `EventSource('/__artifact/events?id=<id>')`. The server sends `event: published` with `id: <version>` and `data: {"version": n}`. The client compares `n` to the version it loaded (embedded by `inject.ts` as `data-version` on the script tag) and calls `location.reload()` when `n` differs. Rollback emits the same event.

Refinements from M3:

- On every connect and reconnect the server first sends the current version (with `retry: 1000`), so the first connect needs no version parameter and a tab that missed a publish reloads as soon as it reconnects. `Last-Event-ID` is accepted but does not change the reply ([0028](decisions/0028-sse-handshake-and-reconnect.md)).
- Delete emits `event: deleted` and ends the stream; the client closes the `EventSource` and shows a small banner instead of reloading ([0029](decisions/0029-deleted-event.md)).
- A `: heartbeat` comment every 20 s; each stream unsubscribes from the notifier when the client disconnects ([0030](decisions/0030-heartbeat-and-listener-lifecycle.md)).
- Missing, malformed or unknown ids get a plain 404 instead of a stream, so `EventSource` stops retrying ([0032](decisions/0032-events-unknown-id.md)).

## Testing and verification

The contract suite is the most important test asset: it is what lets the S3 adapter replace the filesystem adapter without touching the core.

| Layer | What | How |
| --- | --- | --- |
| Contract | `BlobStore` / `PointerStore` behaviour: get, put, list by prefix, conditional put (`If-Match`, `If-None-Match: *`), conflict errors | One suite in `test/contract/`, run against memory, fs, and later S3 (LocalStack or a real test bucket) |
| Core | Service rules: versioning, pointer last, rollback, conflicts, limits | Memory adapters + fake clock and id generator; `fast-check` for paths and concurrent publish ordering |
| HTTP | Routes, headers, guards, SSE framing | `app.request()` in-process, no sockets |
| MCP | Tool schemas, results, errors | MCP SDK client against the in-process server |
| E2E | Real server on a random port + temp root | Spawn the CLI, publish via API, assert an SSE `published` event arrives; one optional Playwright smoke test that a real tab reloads |

Definition of done for every milestone: `pnpm check` green, acceptance boxes ticked, README updated for anything user-visible, no new runtime dependency without a note in the PR.

## AWS migration path

The move to AWS swaps adapters and the reload transport; the core, the key layout, the API shapes and the MCP tool schemas stay the same. Infrastructure in CDK (TypeScript).

| Port / concern | Local (v1) | AWS (M6) |
| --- | --- | --- |
| `BlobStore` | Filesystem under `~/.artifacts/` | S3 bucket, same keys; `If-None-Match: *` on manifests |
| `PointerStore` | `meta.json` + temp-file rename under a per-id lock | `meta.json` in S3 with `If-Match` conditional writes (or DynamoDB if listing/querying needs grow) |
| Serving | Hono static read from `www/` | CloudFront in front of S3 (OAC). Wildcard cert `*.art.<domain>`; a CloudFront Function maps `Host` → `artifacts/<id>/v/<n>/www/…`, reading `<id> → n` from CloudFront KeyValueStore |
| Pointer → edge | n/a | Publish updates the KeyValueStore entry after the S3 pointer write; HTML served with short TTL, assets long TTL (versioned keys are immutable) |
| `Notifier` + reload | In-process EventEmitter → SSE | AppSync Events channel `/artifacts/<id>`; publish Lambda posts the event; the AWS `reload.js` subscribes over WebSocket |
| API + MCP | Hono on `@hono/node-server` | Same Hono app on Lambda (`hono/aws-lambda`) behind a Function URL or API Gateway; MCP stays stateless Streamable HTTP |
| Auth | Loopback + optional bearer token | Cognito/OIDC for API and MCP; viewing gated per artifact (private by default) |
| `file_path` input | Allowed | Rejected; inline `files` only |
| Auto-open | New artifacts open in the local browser ([0040](decisions/0040-auto-open-new-artifacts.md)) | Off: `opened` is always `false` |
| `project` filter | `meta.json` field; `list` filters by it | The same |

What to keep true locally so the move stays cheap:

- The core never knows whether it is on disk or S3; every storage call goes through the ports.
- Serving stays a static read of precomputed `www/` files; no per-request HTML rewriting.
- `reload.js` is served by the platform, not stored in artifacts, so each deployment can ship its own transport.
- The contract suite runs against the S3 adapter in CI before M6 is called done.

## Agent instructions and open questions

Hand this document to the building agent with the brief below.

```
Build the artifact server described in this spec, milestone by milestone (M0 → M5).
- Before each milestone, restate its acceptance criteria as failing tests, then implement until they pass.
- Write the store contract suite before either store adapter.
- Node.js 24, TypeScript 7, ESM, erasable syntax only (no enums, namespaces, parameter properties).
- Run .ts directly in development; the npm package ships built JS from dist/ (Node does not strip types in node_modules).
- Runtime deps limited to: hono, @hono/node-server, @modelcontextprotocol/sdk, zod, ulid. Ask before adding any other.
- core/ must not import from adapters/, http/, mcp/ or node:fs.
- Stop after each milestone: run `pnpm check`, summarise what changed, list any deviation from the spec and why.
- Do not build M6 (AWS) or anything listed under non-goals.
```

Open questions to settle before or during M2 (all resolved in M2):

- [x] npm name: `@nikovirtala/artifact` ([0008](decisions/0008-npm-name.md)).
- [x] Default port: 4400, override with `--port` / `ARTIFACT_PORT`, never auto-picked ([0009](decisions/0009-default-port.md)).
- [x] Safari: resolves `<id>.localhost` without `/etc/hosts` (verified manually), so no `User-Agent` switch; path-mode routes stay mounted as a fallback ([0010](decisions/0010-safari-localhost.md)).
- [x] `ARTIFACT_TOKEN`: optional on loopback, required for a non-loopback `--host` ([0011](decisions/0011-artifact-token-default.md)).
- [x] Gallery: minimal read-only page in v1 ([0012](decisions/0012-gallery-in-v1.md)).
- [x] Retention: keep all versions; maybe an explicit `artifact prune` later ([0013](decisions/0013-version-retention.md)).
