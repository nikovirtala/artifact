# 0039. Project identifier and list filtering; users and sessions deferred

Status: Accepted (M4 follow-up)

## Context

`artifact_list` returned every artifact on the machine, and the agent asked the user about artifacts from unrelated codebases. The server cannot tell which codebase a call comes from: it does not share the agent's working directory, and MCP over stateless HTTP has no session. The agent can tell, so it passes a project identifier, and that identifier must be precise enough that two codebases never share it.

## Decision

- **`project`** is an optional string on publish (API body, `artifact_publish`) and a filter on list (`GET /api/artifacts?project=`, `artifact_list` `project`, plus `all: true` on `artifact_list`).
- **Derivation, told to the agent** in the field description: pass `git remote get-url origin` as-is; else `local:` + `git rev-parse --show-toplevel`; else `local:` + the absolute working directory. A value stated in the user's instructions (`CLAUDE.md`) wins. Use the same value for every call in the session.
- **Normalisation** (`src/core/project.ts`, pure, shared with the M5 CLI):
  - Remote URLs become `<host>/<path>`, lowercased: the scheme (`https`, `http`, `ssh`, `git`), userinfo, port, trailing `/` and trailing `.git` are removed, and scp-style `host:path` becomes `host/path`. `git@github.com:nikovirtala/artifact.git`, `https://github.com/NikoVirtala/artifact`, `https://github.com/NikoVirtala/artifact.git/` and `ssh://git@github.com/nikovirtala/artifact.git` all become `github.com/nikovirtala/artifact`. The normalised form is accepted as input too, so normalising is idempotent and a pinned value (M5 `init`) works.
  - **Port is dropped**: the same repository is often reached over SSH on one port and HTTPS on another, and two different git servers on one host are rare.
  - `local:` + an absolute path keeps its case and loses trailing `/` (except the root). POSIX `/…` and Windows drive paths `C:\…` or `C:/…` are accepted; Windows paths use `/` and an upper-case drive letter, so both spellings match. Relative paths and backslash UNC paths (`\\server\share`) are rejected.
  - Surrounding whitespace is trimmed (`git` output ends in a newline). Empty values, control characters, more than 255 characters after normalisation and unrecognised forms → `invalid_input` (`field: "project"`, 422).
- **Storage.** `meta.json` gets `project` (normalised) when the artifact is created with one; it is never changed in v1. An update that passes a different (valid) project keeps the stored one silently and returns the stored `project` in its result, so the agent sees the truth. Existing artifacts have no project.
- **List.** With `project`: only artifacts whose stored project equals the normalised value exactly (no prefix matching); artifacts without a project are hidden. With `all: true`: everything, `project` ignored. With neither: everything, as before. The limit rules are unchanged and apply after filtering.
- **Results.** Publish results and list items include `project` when set; `GET /api/artifacts/:id` includes it via the meta.
- **Not a permission.** Read, update, rollback and delete accept any id regardless of project.
- **Gallery** shows each artifact's project and filters with `/?project=` (server-rendered, escaped, no JS).
- **Users and sessions are deferred.** Real user and session management is a planned later design change; the v1 non-goal (no multi-user auth) stands. Sessions alone would not solve this: a new session must find artifacts from earlier sessions in the same codebase, which is exactly what a project filter gives.

## Consequences

- Agents that ignore the rule (or pass nothing) see everything, as before. A wrong but valid `project` hides the right artifacts; `all: true` recovers them.
- A repository with no remote, cloned to two paths, is two projects; adding a remote later starts a new project for new artifacts.
