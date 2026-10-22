# 0087. Serving latency: Lambda origin or KVS fallback

Status: Draft (awaiting the owner's M10 latency numbers)

This ADR holds **no decision** yet. It is completed in a follow-up once the owner's numbers arrive.

## Context

M10 serves every current-version request through CloudFront → the viewing Lambda (function URL, OAC) → S3 ([0082](0082-viewing-lambda.md), [0083](0083-distribution-and-live-update.md)). That costs one invocation and two sequential S3 reads per uncached request; pinned `/v/<n>/` URLs are edge hits after their first request. The plan's "Serving: cost and fallback" estimates the added time to first byte at about 30–80 ms warm near eu-north-1 and about 250–600 ms on a cold start, and keeps a KVS-pointer design (edge function → S3 origin for found ids) as the documented fallback. The fallback trades away read-after-publish consistency and adds a second source of truth. Its facts (V10) are not checked, because the fallback has not been triggered (owner decision 4).

The owner measures with `pnpm latency` from CloudShell in eu-north-1 ([0086](0086-m10-smoke-latency-guide.md)).

## Decision rule (from the plan)

Switch to the KVS fallback only if the M10 p95 for a warm 10-asset page, or the cold first view, is worse than the owner accepts. Otherwise keep the Lambda origin. Either way, record the numbers here.

## Measurements (to be filled in from `pnpm latency report`)

| case | n | p50 TTFB ms | p95 TTFB ms | notes |
| --- | --- | --- | --- | --- |
| HTML, current, warm | 20 | … | … | POP, first-request DNS/TCP/TLS |
| 10-asset page, warm (HTML / slowest asset / complete) | 20 | … | … | |
| HTML, current, after ≥ 30 min idle | k | … | … | Init Duration |
| 10-asset page, after ≥ 30 min idle | k | … | … | |
| Pinned `/v/1/` | 20 | … | … | x-cache hits m/20 |
| Edge function compute utilization | 1 | — | — | % |

## Open question to the owner

With these numbers, are the warm 10-asset p95 and the cold first view acceptable? If yes, this ADR keeps the Lambda origin (optionally with `viewing.provisionedConcurrency` for the cold case). If not, it triggers the KVS fallback, whose facts (V10) are then checked before any design.
