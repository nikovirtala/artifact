# 0051. Injectable limits and the request body cap

Status: Accepted (M7)

## Context

`LIMITS` (16 MiB per file, 64 MiB per publish, 500 files, 60-character labels, list limit 500) and `MAX_BODY_BYTES` (96 MiB) were constants sized for loopback. The AWS deployment (`docs/01-plan-aws.md`, code change 1) needs 4 MiB per file and per publish, and a request cap below Lambda's synchronous limit of about 6 MB. If each layer read its own constant, a deployment could change one number and leave the API, the MCP schemas or `file_path` checking another.

## Decision

- **The service owns the limits.** `ArtifactServiceDeps.limits?: Partial<Limits>`. The constructor resolves `{...LIMITS, ...limits}` (undefined entries keep the default) and throws a `RangeError` unless every value is a positive safe integer. The result is exposed as `readonly limits: Limits`. `LIMITS` stays exported unchanged as the defaults.
- **Every layer reads `service.limits`.** The core's publish checks and the `list` bound; `/api` (`?limit=` bound and the 413 `too_large` body); the MCP tool schemas; `file_path` (`readEntryFile(path, maxFileBytes = LIMITS.maxFileBytes)`).
- **Schemas from a factory.** `toolInputSchemas(limits)` builds the five tool input schemas; the label description and the list `maximum` print the configured numbers. The existing exports are `toolInputSchemas(LIMITS)` members, so the default JSON schemas and the tool descriptions (0036) are unchanged.
- **Body cap.** `bodyCapFor(limits) = ceil(1.5 × maxPublishBytes)`: base64 (×4/3) plus JSON overhead. `MAX_BODY_BYTES = bodyCapFor(LIMITS)` is still 96 MiB. `AppConfig.maxBodyBytes` and `McpConfig.maxBodyBytes` override it, because 1.5 × 4 MiB exceeds what Lambda accepts. Above the cap, `/api` answers 413 `too_large` with the publish limit; `/mcp` answers the SDK's own 413.

## Consequences

Local behaviour is unchanged: `serve` passes no limits, so every number, message and schema is the same as before. A deployment sets one `limits` object and every layer follows it. A request between the core's publish limit and the body cap still reaches the core and gets its precise `too_large` (file or publish).
