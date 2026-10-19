# 0055. Raw request target through a server-adapter hook

Status: Accepted (M7)

## Context

The traversal guard (0027) must see the request target before URL normalisation, which resolves `%2e%2e` and `..`. It read `c.env.incoming.url`, which only `@hono/node-server` provides. On AWS (`docs/01-plan-aws.md`, code change 5) the raw target is the Lambda event's `rawPath` + `rawQueryString`. The control app will also run without a host guard in front of it.

## Decision

- `src/http/raw-target.ts`: `type RawTargetHook = (c) => string | undefined` and the default `nodeServerRawTarget`, which reads `c.env.incoming.url`.
- `rawTarget(c, hook = nodeServerRawTarget)` falls back to the parsed URL's `pathname + search` when the hook returns `undefined`, as before. `traversalGuard(csp?, hook?)` uses it.
- Without a `host` variable (no host guard in front), the traversal guard treats the request as the main host, so an unsafe `/api` path still gets the JSON `bad_request`.
- `AppDeps.rawTarget?` reaches the guard. `artifact serve` passes `nodeServerRawTarget` explicitly next to `getRequestListener`, so the hook and the adapter sit side by side; it is the same as the default.

## Consequences

Local behaviour is unchanged. Each server adapter supplies its own hook; a hook that returns `undefined` degrades to the parsed URL, where `..` and `%2e%2e` are already resolved (encoded separators and control characters are still caught), so every adapter must provide one.
