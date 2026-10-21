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

## Pull requests

- Open a **draft** pull request as soon as your branch has its first commit: push the branch and open the PR against `main` right away. Don't wait until the work is finished.
- Push after every new commit (including `fixup!` commits and rebases, using `--force-with-lease`), so the PR always matches your local branch.
- Keep the PR description up to date as the work changes: what the change does, why, what's still left, and how it was tested.
- Mark the PR **ready for review** (remove draft status) only when all of these are true:
  - the work is complete, with nothing left to do;
  - the branch is rebased onto the latest `origin/main`, and every commit passes `git rebase --exec "<test command>" origin/main`;
  - all `fixup!`/`squash!` commits are squashed;
  - CI is green;
  - the PR description is final.
- To mark a PR ready, use `gh pr ready <number>` or the GraphQL `markPullRequestReadyForReview` mutation. The REST API can't remove draft status. If your environment can't run either, say so explicitly when you hand off, and ask the maintainer to click "Ready for review".
- If more work is needed after review, you can move the PR back to draft while you make the changes, then mark it ready again.
