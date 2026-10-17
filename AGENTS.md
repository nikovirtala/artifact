# AGENTS.md

## Git history

Linear history is required.

- Before starting work and again before merging, run `git fetch` and rebase your branch onto `origin/main`.
- After rebasing, verify every commit: `git rebase --exec "<test command>" origin/main`.
- Merge only via fast-forward, so the commits on `main` are exactly the reviewed and signed commits; no merge commits, no squash or rebase merges.
- Never force-push `main`. On your own branches, use `git push --force-with-lease`, never `--force`.
- Undo changes on `main` with `git revert`, never by rewriting history.
- All commits and tags are signed.

## Commits

- Each commit is atomic: one logical change, self-contained.
- Each commit builds and passes tests on its own, so `git bisect` works at every point in history.
- To amend an earlier commit on your branch, use `git commit --fixup=<sha>` rather than piling on "address review" commits.
- Squash fixups before merging: `git rebase -i --autosquash origin/main`. `fixup!` and `squash!` commits must **never** reach `main`.

## Commit messages

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

    <type>(<optional scope>): <description>

    [optional body]

    [optional footer(s)]

- Types: `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `style`, `test`.
- Description: imperative mood, lowercase, no trailing period, ≤72 characters.
- Breaking changes: add `!` after the type/scope and a `BREAKING CHANGE:` footer explaining the impact and migration.
- The body explains *why*, not *what*.
