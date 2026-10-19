# 0053. `HostPolicy` port: local and domain host rules

Status: Accepted (M7)

## Context

The host guard and the artifact URLs were hard-coded to `localhost` and `<id>.localhost` on the configured port (0027, 0010). The AWS deployment (`docs/01-plan-aws.md`, code change 2) serves the same app on `<viewDomain>` and `<id>.<viewDomain>` over https, subdomain mode only. The routes downstream of the guard must not change.

## Decision

- `src/http/host-policy.ts` defines `HostKind = {kind:"main"} | {kind:"artifact", id} | {kind:"reject"}`, `AcceptedHost` (`HostKind` without `reject`, the type of the Hono `host` variable, so route narrowing is unchanged) and `interface HostPolicy { classify(host); artifactUrl(id); galleryUrl() }`.
- `LocalHostPolicy({port, isolation})` holds today's rules, moved from `guards.ts`: loopback names and `<id>.localhost`, on the configured port only (no port when it is 80), ids lowercased. `artifactUrl` delegates to `urls.ts`; `galleryUrl()` is `http://localhost:<port>/`.
- `DomainHostPolicy({viewDomain})` accepts `<viewDomain>` (main) and `<id>.<viewDomain>` (artifact) with no port or `:443` (URL parsing drops `:443` for https; a literal one is also accepted). Any other or empty port, a trailing dot, IP literals, unknown or nested labels, and foreign or look-alike domains are rejected. Ids are lowercased. URLs are `https://<id>.<viewDomain>/` and `https://<viewDomain>/`. The constructor lowercases `viewDomain` and throws a `RangeError` unless it is a bare domain name (no scheme, port, path, empty label or leading/trailing dot).
- `classifyHost(host, port)` stays in `guards.ts` with the same signature and results, through `LocalHostPolicy` (`reject` → `undefined`). `hostGuard` takes a policy or, as before, a port.
- `AppDeps.hosts?` and `McpDeps.hosts?` default to `new LocalHostPolicy(config)`. The gallery, `/api` and the MCP tools take their URLs from it.

## Consequences

Locally nothing changes: the default policy is the old code, and a parity test checks it against `classifyHost` for every host the guard tests use. A deployment passes a `DomainHostPolicy` and gets its host checks and URLs from one object.
