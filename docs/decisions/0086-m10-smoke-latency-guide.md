# 0086. M10 smoke checks, latency script and CloudShell guide

Status: Accepted (M10)

## Context

The owner deploys from AWS CloudShell; the agent cannot deploy (owner decision 1, as in [0076](0076-smoke-and-deploy-guide.md)). The viewing plane's deployed criteria (D1–D15) need real CloudFront, KeyValueStore propagation and Cognito, so they must be scripted for the owner, with cookies minted from the stage's session key read with the owner's credentials and never printed (owner decision 2). Browser-only checks get a manual checklist (decision 3). Latency is recorded, not gated, and the ADR that keeps the Lambda origin or triggers the KVS fallback comes after the numbers (decision 4; draft ADR 0087). Three facts stay open until a deploy: whether CloudFront passes a `Set-Cookie` for a name outside the login behaviour's cookie allowlist (F6, [Cache content based on cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Cookies.html)); how OAC signing treats percent-encoded paths (F4 residual, [OAC for function URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)); and the `api` host next to the wildcard records (V5, [DNS domain name format](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DomainNameFormat.html)).

## Decision

- **`pnpm smoke` gains S20–S41**, each mapped to one criterion; `--view-only` runs S1 and S20–S41, `--skip-view` runs S1–S19. The session secret is read with `GetSecretValue`; `scripts/lib/session-cookie.ts` mints cookies with its own copy of the format, held to the shared vectors of [0078](0078-session-cookie-and-keys.md). The key, every minted cookie, its payload and signature segments and every marker go to `checks.secret()`. Requests whose path must stay exact use `node:https.request`, because `fetch` normalises `%2e%2e`.

  | Check | Covers | Check |
  | --- | --- | --- |
  | S20 | D11 | Route 53: `api.<view>` A alias → `*.execute-api.<region>.amazonaws.com.`, no AAAA; 1.1.1.1: AAAA `api` → `ENODATA`, apex A resolves |
  | S21, S22 | D1 | no cookie: navigation → 302 to login with the exact `return`; `/__artifact/version` → 401 |
  | S23 | D2 | minted cookie: page `data-version="1"`, gallery HTML, `reload.js` with `transport: "none"` |
  | S24 | D10 | HEAD with cookie → 200 without a body; without → 401 |
  | S25 | D3 | republish, then one GET shows version 2 (no retry) |
  | S26, S27 | D4, D5 | pinned `/v/1/` → `Hit from cloudfront` and immutable; another cookie still hits |
  | S28, S29 | D5, D14 | a fresh cookie and marker on an artifact path and on `/__artifact/login`: after the control access line with `cookies: 0`, no viewing log event holds the payload segment, the signature segment or the marker |
  | S30–S32 | D6 | tampered, expired, unknown `kid` → 302 to login |
  | S33 | D13 | `/login` → the authorize URL (client id, S256, `code`, `state`, `nonce`, callback) and `__Host-artifact_login` with `Secure`, `HttpOnly`, `Path=/`, `Max-Age=600` through CloudFront |
  | S34 | D6 | a foreign or `http:` return is stored as the gallery (decoded transaction payload) |
  | S35 | D7 | `/x%2f..%2fy`, `/..%5cx` → 400; a 403 FAILs with a fixed text (F4 residual) |
  | S36, S37 | D7, D9 | unknown host → 403; unsigned function URL → 403 |
  | S38 | D15 | after a rotation, cookies signed with the previous and the current key → 200; SKIP before |
  | S39 | V2 residual | the viewing log's runtime line; FAIL only on an init error (S19's pattern plus `ENOENT`) newer than the newest runtime line |
  | S40 | D13 | `/logout` clears `__Secure-artifact_session` with `Domain=<view>`, `Path=/`, `Max-Age=0`; FAIL reads `STOP: …` (F6) |
  | S41 | D15 | `/login` signs the transaction cookie with the secret's `current` `kid`, retried for up to 6 minutes (the key cache) |

- **S40 stop rule.** If S40 fails, login cannot set the session cookie. The owner stops, changes no allowlist or policy, and reports the row; the choice between a viewer-response function and another option is the owner's ([0081](0081-login-oidc-pkce.md)).
- **`pnpm latency warm|idle|report`.** `warm` publishes a 20 KB page and a page with 10 assets, then measures TTFB (request written → first byte, on a keep-alive agent; DNS/TCP/TLS of the first request apart), the 10-asset page (HTML, slowest asset, complete, at most 6 connections), pinned `/v/1/` with its hit ratio, and the edge function's compute utilization through `DescribeFunction` (stage `LIVE`, for the ETag) and `TestFunction` with `IfMatch`; an error there prints `—` and the error name. `idle` refuses to run until 30 minutes after the last request, then measures one cold round on fresh connections and reads `Init Duration` from the `REPORT` lines. `report` prints the Markdown table (nearest-rank p50/p95) and deletes the two artifacts. The state, `$HOME/.artifact-latency.json`, holds no secret and survives CloudShell sessions.
- **Guide.** `examples/personal/README.md` gains (j) the update with a resource-level diff gate (the same pattern as the offline gate of [0083](0083-distribution-and-live-update.md)), (k) sign-in from the invitation within 7 days and the resend command as the owner's write, (l) smoke, (m) latency, (n) browser checks B1–B6, (o) rotation, plus the tarball-app, teardown, account-concurrency and known-limits notes.

## Consequences

The pure parts (minting against the vectors, the leak and `kid` predicates, the S39 verdict, arguments, percentiles, the table and the idle rule) are unit-tested in `pnpm check`; the AWS calls run only when the owner runs the scripts, and `--help` makes none. The first deployed run settles F6 (S40), the F4 residual (S35) and V5 (S20). The latency table feeds ADR 0087.
