# 0046. `artifact init`

Status: Accepted (M5)

## Context

0038 makes the CLAUDE.md snippet a required setup step for Claude Code and sketches `artifact init`. The details below make it safe to run repeatedly.

## Decision

- **One source.** `src/cli/snippet.ts` holds the snippet paragraph, the project pin line (`` For this codebase, pass exactly `project: "<value>"` on every artifacts tool call. ``), the markers and the `claude mcp add` line. `test/cli/snippet.test.ts` asserts that the README contains them, so the README and `init` cannot drift.
- **Targets.** By default, `CLAUDE.md` and `AGENTS.md` in the working directory if either exists, else a new `CLAUDE.md`. With `--global`, `~/.claude/CLAUDE.md` (the directory is created if needed).
- **Block.** The block is `<!-- artifact:start -->`, the snippet, the pin line, and `<!-- artifact:end -->`. If a file already has a start marker followed by an end marker, the text from the first start through its end is replaced. Otherwise the block is appended after one blank line (adding a final newline first if the file lacks one). Every other byte is kept. A start marker without an end, or an end marker with no start before it, is an error and that file is left alone. Each file is reported as `created`, `updated` or `unchanged`. A re-run is byte-identical.
- **Project.** The pin uses the CLI's derived value (0042) or `--project`, normalised. With `--global` nothing is pinned (the rule in the snippet applies per repo), and `--global --project` is a usage error.
- **`--deny-builtin`** (opt-in only) adds `"Artifact"` to `permissions.deny` in `.claude/settings.json`, or `~/.claude/settings.json` with `--global`. A missing file is created as `{"permissions": {"deny": ["Artifact"]}}`. An existing one keeps all other keys and gets no duplicate entry. It is rewritten as 2-space JSON only when something changes. A file that is not valid JSON, is not an object, or whose `permissions`/`deny` have the wrong type is refused with `error: invalid_input: …`. All targets are checked before any file is written, so a refusal writes nothing.
- **`--dry-run`** prints each target with its status and the resulting block (and settings JSON), and writes nothing.
- It finally prints `claude mcp add --scope user --transport http artifacts <server>/mcp` (`<server>` is resolved as in 0041), plus `--header "Authorization: Bearer $ARTIFACT_TOKEN"` (the literal variable, never the secret) when `ARTIFACT_TOKEN` is set. `init` needs no running server and never runs `claude`.

## Consequences

Re-running `init` after an upgrade refreshes the snippet in place. Settings formatting is normalised when `init` changes the file.
