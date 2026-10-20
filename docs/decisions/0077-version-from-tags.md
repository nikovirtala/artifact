# 0077. Version releases from git tags and Conventional Commits

Status: Accepted (release)

## Context

Under [0049](0049-release-via-trusted-publishing.md) the publish workflow published the `package.json` version, and a release was a pull request bumping it. Nobody bumped it, so every push to `main` after 1.0.0 skipped with "version 1.0.0 already on npm; nothing to publish". The owner wants semantic-release-style versioning without rewriting commits after the merge and without adding a commit to `main` after the merge. Commits already follow Conventional Commits (AGENTS.md), and every release is already tagged `vX.Y.Z` on its commit.

## Decision

This supersedes 0049's **Versions** bullet and its "only the later one may publish" consequence. Everything else in 0049 stands.

- **Tags are the source of truth.** The base is the highest stable `vX.Y.Z` tag merged into HEAD (`git tag --merged HEAD --list "v*"`, semver max). Prerelease tags are never a base. The checkout uses `fetch-depth: 0` and `fetch-tags: true`.
- **Bump rules.** Over the messages of `<tag>..HEAD`, the highest of: `type!:` / `type(scope)!:` or a `BREAKING CHANGE: ` / `BREAKING-CHANGE: ` footer line → major; `feat` → minor; `fix`, `perf` → patch. Types match case-insensitively; the BREAKING token must be uppercase. Everything else, including `revert`, merges and unparseable headers, releases nothing (unlike semantic-release, `revert` is not a patch). Pre-1.0 semantics are not needed.
- **Nothing to release.** No releasing commit since the tag: `publish=false` and "no feat, fix, perf or breaking commits since vX.Y.Z; nothing to release".
- **No tag fails.** No reachable release tag, or a shallow clone, fails the run. Falling back to npm `latest` would make npm the source of truth again and could silently skip history.
- **Placeholder.** `package.json` on `main` holds `0.0.0-development`. Locally, `artifact --version` prints it. The publish job runs `pnpm install --frozen-lockfile` on the committed file (the lockfile holds no root version), then `npm version "$VERSION" --no-git-tag-version --ignore-scripts` in its checkout only, then check, pack test, build and publish. Nothing is committed or tagged by that step.
- **Guards kept.** `plan()` is unchanged: a computed version already on npm skips, and one lower than `latest` fails. Skipping on npm now also warns, because it means the version's tag is missing (see below).
- **Prereleases are not automated.** Computed versions are always stable. The `next` dist-tag and `--prerelease` logic stay for a follow-up, for example a `workflow_dispatch` input on `publish.yml` itself (trusted publishing validates the filename, so that is allowed, but 0049's "never `workflow_dispatch`" wording would need revisiting). Until then a prerelease is a manual publish with the owner's login (RELEASING.md).
- **Subcommands of `scripts/release-check.ts`.** `next` prints the computed version from git only; `plan` adds the npm check and writes the step outputs; `guard` (in `prepublishOnly`) fails when `package.json` holds the placeholder, so a manual `npm publish` cannot ship it; `commits <base> <head>` lints commit messages.
- **Pull request check.** Commit messages now drive releases, so a `commits` job in `ci.yml` lints every pull request commit against AGENTS.md: allowed type, lowercase description of at most 72 characters without a trailing period, `!` only with a `BREAKING CHANGE:` footer, and no `fixup!`, `squash!` or merge commits.

## Consequences

- **Concurrency.** `concurrency: publish` is workflow-level, so a run holds the group through both the publish and the release job. The next run checks out only after the previous run created its tag, so two quick merges cannot both compute the same version. The group must stay at workflow level.
- **Queued pushes aggregate.** GitHub keeps only the newest pending run per group. That run computes over `<last tag>..its commit`, which includes every skipped push, so no bump is lost (under 0049, an intermediate bump could be).
- **Publish succeeded, tag missing.** If the release job fails after npm publish, no tag exists. "Re-run failed jobs" repairs it with the publish job's outputs. A full re-run or a later merge recomputes the same or a higher version; if that version is on npm, the run skips with a warning naming the repair (`gh release create vX.Y.Z --target <sha>` on the commit from `npm view <pkg>@X.Y.Z gitHead`). It never tags a different commit. Creating the tag before publishing was rejected: it needs `contents: write` in the OIDC job, breaking 0049's least-privilege split, and a failed publish would leave a tag for a version that never shipped.
- **Re-runs.** Re-running a fully successful run finds its own tag on HEAD, so `<tag>..HEAD` is empty and it skips without asking npm.
- **Tags must be right.** The tags (unsigned, the exception in 0049) decide the version. A stray `vX.Y.Z` pushed by hand moves the base; deleting tags breaks releases until one is restored.
- **Commit types matter.** A `feat` mislabelled `chore` does not release; a stray `!` ships a major. The pull request check catches malformed messages, not wrong types. Release tooling changes use non-releasing types (`ci`, `build`, `docs`, `test`).
