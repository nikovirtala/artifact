# 0034. MCP tool results and errors

Status: Accepted (M4)

## Decision

- **Success.** `structuredContent` is the result object and `content` is one text block with the same object as JSON (for clients that only read text). The objects match the JSON API:

  | Tool | Result |
  | --- | --- |
  | `artifact_publish` | `{id, version, url}` |
  | `artifact_list` | `{artifacts: [{id, title?, currentVersion, updatedAt, url}]}` |
  | `artifact_read` | `{id, version, path, contentType, content}` |
  | `artifact_rollback` | `{id, version, url}` (the now-current version) |
  | `artifact_delete` | `{ok: true}` |

- `url` is the artifact's current URL in the configured isolation mode (`src/http/urls.ts`).
- `artifact_read` returns the `src/` file (as published, no reload tag). `content` uses the publish encoding (0021): a string for UTF-8 text (`text/*`, JSON, SVG), `{"base64": …}` otherwise or when the bytes are not valid UTF-8. Text read back can be published unchanged.
- **Errors** are tool results with `isError: true`, not JSON-RPC errors, so the agent sees them and can react. `structuredContent` and the text block carry the API's error body (0023): `{"error": "<code>", "message", ...extra}`.
  - Core errors pass through: `not_found`, `version_conflict` (`currentVersion`), `too_large` (`subject`, `limit`, `path?`), `invalid_path` (`path`), `invalid_input` (`field`, `limit?`; for example a malformed id or `limit`).
  - Arguments that fail the input schema → `invalid_request` with the Zod `issues`, as in the API. This includes a missing or false `confirm`, unknown keys and `limit` outside 1..500.
  - An unexpected exception → `internal`, logged on the server.
- An unknown tool name is a JSON-RPC `InvalidParams` error: it is a client bug, not something the agent can fix by changing arguments.
- **No `outputSchema`.** The SDK client validates any `structuredContent` against a declared output schema, even on `isError` results, so declaring one would make error results fail on the client. The result shapes are in the tool descriptions instead.
- The input schemas are built in `src/schemas.ts` from the API body schemas (`PublishBodySchema`, `RollbackBodySchema`, `FilesSchema`), adding only what the API carries in the URL (`id`) or query (`limit`, `version`, `path`). `artifact_list` defaults to 50 (`DEFAULT_LIST_LIMIT`, shared with `/api`).

## Consequences

Agents and scripts get one error vocabulary across the API and MCP. The MCP `limit` is a JSON number, so its range is a schema rule (`invalid_request`), where the API's query string answers `bad_request`.
