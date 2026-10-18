# 0038. Tool-selection wording and the CLAUDE.md snippet

Status: Accepted (M4 follow-up)

## Context

In the owner's Claude Code test the agent used the client's built-in Artifacts until told to use this server. Tool descriptions only say what a tool does; the agent also needs to know when to pick it over a built-in feature.

## Decision

- The server `instructions` and the first sentences of the `artifact_publish` description say: use this whenever the user asks for an HTML page, mock-up, visualization, report, dashboard or an "artifact"; publish it here and give the user the URL; do not use the client's built-in artifact features for these. The rules of 0036 stay, and `test/mcp/tools.test.ts` checks the new sentence too.
- The README gives a short snippet to paste into `CLAUDE.md` (project or `~/.claude/CLAUDE.md`) or `AGENTS.md`, because user-level instructions outweigh tool descriptions in most clients. It points at the `project` rule (0039). The server name stays `artifacts` in the `claude mcp add` line.
- **Verified by the owner (Claude Code 2.1.292):** the tool wording alone does not win. Claude Code has a native `Artifact` tool (publishes to claude.ai, with its own guidance and skills) that a third-party MCP description cannot outrank. With the snippet in `~/.claude/CLAUDE.md`, naming "the built-in Artifact tool", Claude used `artifact_publish` and the page opened in the browser. So the snippet is a required setup step for Claude Code, not an optional extra. The stronger fallback is a permission deny rule (`"deny": ["Artifact"]` in `settings.json`); it is documented but unverified, and was not needed.
- `artifact init` (M5) will write that snippet: it updates `CLAUDE.md` and `AGENTS.md` in the working directory if present, else creates `CLAUDE.md`; the block sits between `<!-- artifact:start -->` and `<!-- artifact:end -->` so reruns replace it; `--dry-run` prints instead of writing; `--global` targets `~/.claude/CLAUDE.md`; it prints the `claude mcp add` line; and it pins the exact normalised `project` value in the snippet. An opt-in `--deny-builtin` adds the `Artifact` deny rule to `.claude/settings.json` (with `--global`, `~/.claude/settings.json`); never by default, since it changes how Claude Code itself behaves.

## Consequences

The wording costs a few sentences of context per session. Clients with a native artifact tool, Claude Code included, still need the snippet; the wording helps in clients without one.
