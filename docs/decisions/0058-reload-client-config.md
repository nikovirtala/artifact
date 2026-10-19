# 0058. Reload client config prefix

Status: Accepted (M7)

## Context

The reload client (0031) hard-codes the local platform: SSE, the `.localhost` subdomain suffix and `/a/<id>/` path mode. On AWS the view domain differs, path mode does not exist and the transport becomes AppSync Events in M11 (`docs/01-plan-aws.md`, code change 6): `/__artifact/reload.js` is a one-line config prefix plus the shared client. Locally the served bytes must stay exactly the file, as `test/http/reload.test.ts` asserts.

## Decision

- Line 1 of `src/http/reload-client.js` is the local config: `const __artifactReloadConfig = { transport: "sse", viewSuffix: ".localhost", pathMode: true };`. It is written the way the formatter prints it (not as raw JSON), so `biome check` leaves the file alone and `renderReloadConfig` reproduces it exactly.
- `src/http/reload.ts`: `ReloadTransport = "sse"`, `ReloadClientConfig = {transport, viewSuffix, pathMode}`, `LOCAL_RELOAD_CONFIG`, `renderReloadConfig(config)` (string values through `JSON.stringify`), `reloadScript(config)` = the rendered line + `\n` + the file without its first line, and `reloadClient(config = LOCAL_RELOAD_CONFIG)`. Module load throws if line 1 does not start with `const __artifactReloadConfig = `, so a stray edit cannot silently ship two configs.
- The client reads `__artifactReloadConfig` (with a `typeof` fallback to the local values), matches subdomains against `viewSuffix`, parses `/a/<id>/` only when `pathMode` is set and dispatches through a transport table (`sse` → `connectSse`). An unknown transport leaves the page inert.
- `ViewingAppDeps.reload?` and `AppDeps.reload?` select the config for `/__artifact/reload.js`; the default is `LOCAL_RELOAD_CONFIG`. Path mode is mounted in every local isolation mode, so the local config is a constant.

## Consequences

Locally `reloadScript(LOCAL_RELOAD_CONFIG)` is byte-identical to the file, so the existing reload tests run unchanged.

This amends 0031's "no globals on the page", and the trade-off is accepted. The top-level `const` is a global lexical binding, not a property of the global object, so the page gets no new `window` property. Page scripts can still see the binding. Artifact scripts run before the deferred client, so an artifact that declares `__artifactReloadConfig` itself (`var`, `let`, `const`, `function` or `class`) makes the client throw a redeclaration `SyntaxError`, and live reload stops on that page. A second copy of the tag fails the same way, but publish injects exactly one. The name is prefixed to make a collision unlikely, and the artifact still renders: only the live reload is lost. M11 adds `appsync` to `ReloadTransport` and the transport table; the `node:vm` tests then run once per transport.
