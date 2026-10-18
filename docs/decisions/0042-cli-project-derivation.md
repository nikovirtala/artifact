# 0042. Project derivation in the CLI

Status: Accepted (M5)

## Context

Agents derive `project` themselves (0039). The CLI must arrive at the same value from the same working directory, so `artifact publish`, `artifact list` and an agent in that repo see the same artifacts, and `artifact init` must pin it.

## Decision

- `src/cli/project.ts` `deriveProject(cwd)`: 1. `git remote get-url origin`; 2. else `local:` + `git rev-parse --show-toplevel`; 3. else `local:` + `cwd`. Each `git` call goes through `child_process.execFile` (no shell) with `cwd`, a 5 s timeout and `windowsHide`. A non-zero exit, a missing `git` binary or a timeout moves to the next rule. Every candidate is normalised with `src/core/project.ts`.
- **Fallback on an unnormalisable remote.** If a step's output does not normalise (for example `origin` is a filesystem path, which is what `git clone /some/dir` produces), the CLI falls through to the next rule instead of failing. An agent passing that remote as-is would get `invalid_input`; `artifact init` pins the CLI's value so agents use it.
- **Who uses it.** `publish` sends it only when creating, because an update keeps the stored project (0039). `list` filters by it by default (`--all` for everything). `init` pins it. `--project <value>` overrides the derived value everywhere and is sent as given (the server normalises it). `publish --no-project` creates without one. An empty `--project ''` is a usage error pointing to `--no-project`.
- `list` prints the filter it used as its first line (`project: github.com/you/repo` or `all projects`), so a surprising empty list explains itself.
- **Hidden-artifacts hint.** When the project filter is active and `--json` is not given, `list` makes one more request, `GET /api/artifacts?limit=500` (unfiltered, the API maximum), and counts the artifacts whose project differs from the filter. Counting by project, not against the filtered page, keeps `--limit` from making the project's own artifacts look hidden. If any are hidden it prints `<n> more in other projects (or without a project); use --all` to stderr (`at least <n>` when the 500 cap is reached). No hint with `--all`, with `--json`, or when nothing is hidden. If that request fails, the hint is skipped and the command still succeeds.

## Consequences

The CLI and agents agree whenever the remote is a URL git hosts understand. With a path remote they differ unless the agent follows the pinned value written by `init`. Listing by project stays the default (owner decision); the hint says when it hides anything, and `--all` is one flag away. The hint costs one extra request per human `list`.
