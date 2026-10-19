# 0056. Split into viewing and control apps

Status: Accepted (M7)

## Context

One Hono app served viewing, `/api` and `/mcp` on one port (0024, 0027). On AWS (`docs/01-plan-aws.md`, code change 3) viewing and control run as separate Lambdas behind different origins, so each half must run on its own. Locally the composed app must keep today's route order, guards and error rendering exactly.

## Decision

- `createViewingApp(deps)` in `src/http/viewing-app.ts`: host guard, traversal guard, `/__artifact/reload.js`, `/__artifact/events`, the `<id>.localhost` catch-all, the gallery at `/` and path mode under `/a/*`, moved verbatim from `app.ts`.
- `createControlApp(deps)` in `src/http/control-app.ts`: traversal guard, `/api` (`createApi` now takes `ControlAppDeps`) and `/mcp`, both behind the browser and token guards. It has no host guard; with no `host` variable the traversal guard treats requests as the main host (0055).
- Both are real Hono apps with their own `onError` and `notFound`, so each runs standalone. The error handler is one function, `appErrorHandler(csp)` in `src/http/errors.ts`: today's JSON `internal` on `/api` and `/mcp`, plain-text 500 elsewhere. `isApiPath` moved there with it and is re-exported from `guards.ts`.
- `createApp` resolves the defaults once (`hosts`, `verifyToken`, `rawTarget`), then is `new Hono()` + the shared `onError`/`notFound` + `route("/", viewing)` + `route("/", control)`. Viewing is mounted first, so its host guard and the `<id>.localhost` catch-all run before any control route, as before. `AppConfig` and `AppDeps` stay exported from `app.ts`.

## Consequences

The existing HTTP, MCP and end-to-end tests pass unchanged against the composed app. In the composed app the traversal guard runs twice on control routes; the second run is a no-op. Hono wraps each mounted handler with its sub-app's error handler, and since that handler is shared, an error renders the same whichever app throws.
