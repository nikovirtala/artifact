# 0036. Tool descriptions are the agent contract

Status: Accepted (M4)

## Decision

The tool descriptions (and the input field descriptions in `src/schemas.ts`) are the only instructions an agent gets, so the rules agents must follow live there, and `test/mcp/tools.test.ts` checks that each one is present:

- `artifact_publish`: omit `id` to create; pass `id` to update in place and keep the URL; before creating, call `artifact_list` and reuse an existing id instead of creating a duplicate; show the returned `url`. A `version_conflict` without `if_version` means retries ran out under concurrent publishes: retry the same call and do not add `if_version` (owner decision, 0015). With `if_version` it means someone else published first: read and redo the change. `file_path` is described as absolute, `.html`, with supporting files only via `files` (or, when disabled, as unsupported).
- `artifact_list`: use it to recover an id before updating, instead of creating a duplicate.
- `artifact_read`: read before editing an artifact this session did not publish; edit the HTML returned here, not the served page, which carries the injected reload tag (owner decision).
- `artifact_rollback`: moves current back to an earlier version; nothing is lost; tabs reload.
- `artifact_delete`: only when the user explicitly asks; requires `confirm: true`.
- Annotations: `readOnlyHint` on list and read, `destructiveHint` only on delete, `openWorldHint: false` on all.
- The server's `instructions` (sent on `initialize`) repeat the core loop: publish to the existing id, find it with `artifact_list`.

## Consequences

Changing a rule means changing a description and its test together. Descriptions are kept to a few sentences each so they cost little context.
