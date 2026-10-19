# 0054. `TokenVerifier` port for bearer tokens

Status: Accepted (M7)

## Context

`/api` and `/mcp` compared the bearer token with `ARTIFACT_TOKEN` inside `tokenGuard` (0027). On AWS (`docs/01-plan-aws.md`, code change 4) the check is against a cached list of SHA-256 digests from Secrets Manager, which is asynchronous. The header parsing and the 401 response must stay the same everywhere.

## Decision

- `src/http/token.ts`: `type TokenVerifier = (presented: string) => Promise<boolean>` and `localTokenVerifier(token)`, which holds the SHA-256 + `timingSafeEqual` comparison moved from `guards.ts`. Without a token it returns `undefined`: no check, as before.
- `tokenGuard(verifier | token | undefined)`: a string is wrapped with `localTokenVerifier`, so existing calls keep working. The guard keeps the header regex, the 401 `unauthorized` body and `WWW-Authenticate: Bearer`. The verifier sees only the presented token and is never called when the header is missing or malformed.
- `AppDeps.verifyToken?` (default `localTokenVerifier(config.token)`) guards both `/api` and `/mcp`; when given, it replaces `config.token`.

## Consequences

Local behaviour is unchanged. A deployment plugs in its own verifier without touching the guard, and the 401 contract stays in one place.
