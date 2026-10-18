# 0049. Release on merge via GitHub Actions trusted publishing

Status: Accepted (release)

## Context

v1 is complete. 1.0.0 should reach npm without a long-lived npm token anywhere and with provenance. npm trusted publishing exchanges a GitHub Actions OIDC token for a short-lived publish credential. The repository is public. A first design staged each version (`npm stage publish`) behind a pushed signed tag and a 2FA approval; the owner found that too manual. A release should be a merged pull request, nothing more.

## Decision

- **Trigger.** `.github/workflows/publish.yml` runs on every push to `main` (the owner merges with rebase-and-merge), on `ubuntu-latest` (trusted publishing needs GitHub-hosted runners). It is triggered directly, never through `workflow_call` or `workflow_dispatch`, because npm validates the calling workflow's filename. Concurrency group `publish` with `cancel-in-progress: false` serialises runs and never cancels a publish mid-way.
- **Gate: the version is not on npm.** `node scripts/release-check.ts plan` reads `name` and `version` from `package.json` and runs `npm view <name>@<version> version --json`. E404 (version or whole package missing) means "not published"; any other error fails the run. If the version is already on npm, every later step is skipped and the run succeeds with "version X already on npm; nothing to publish", so ordinary merges are no-ops. A version lower than the registry's `latest` fails the run. Semver comparison is in the script, with no dependencies.
- **Publish.** If the gate passes: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:pack`, `pnpm build`, then `npm publish --ignore-scripts --tag <tag>`. `--ignore-scripts` skips `prepublishOnly`, which would repeat check and build; it stays for manual publishes. Provenance is generated automatically for a trusted publish from a public repository, so there is no `--provenance` flag. `publishConfig.access` is `public`. The workflow checks npm ≥ 11.5.1 (the trusted-publishing minimum) and runs `npm install -g npm@^11` only if the bundled npm is older.
- **Dist-tags.** Plain `X.Y.Z` publishes under `latest`; a prerelease (`X.Y.Z-beta.1`, anything with `-`) under `next`, so it never becomes the default install. `npm publish --tag` does not need the dist-tag permission; "Allow npm dist-tag" is enabled so a future workflow step can move tags.
- **GitHub Release.** A second job, which runs only if the publish job published, creates the GitHub Release and tag `v<version>` on the published commit with `gh release create --generate-notes` (`--prerelease` for `next`). It skips if the release exists.
- **Least privilege.** The workflow grants nothing by default. The publish job has only `id-token: write` and `contents: read`; the release job has only `contents: write` and no OIDC token. No `NODE_AUTH_TOKEN` and no secrets.
- **Pinned actions.** Every action in `publish.yml` and `ci.yml` is pinned to a full commit SHA with a `# vX.Y.Z` comment. Nobody approves a publish any more, so a moved action tag must not be able to inject code into it.
- **Trusted publisher on npmjs.com.** GitHub Actions, user `nikovirtala`, repository `artifact`, workflow `publish.yml`, no environment, "Allow npm publish" and "Allow npm dist-tag" checked.
- **Toolchain.** `pnpm/action-setup` reads pnpm from `packageManager`. `actions/setup-node` installs Node `24`, the major pinned in `mise.toml` (0001); it cannot read `mise.toml`. The publish job sets `registry-url: https://registry.npmjs.org` and `package-manager-cache: false`, as in npm's example. CI (`ci.yml`) runs `pnpm check` and `pnpm test:pack` on pull requests and pushes to `main`.
- **Package metadata.** `repository.url` is `git+https://github.com/nikovirtala/artifact.git`; npm rejects a trusted publish when it does not match the repository.
- **Versions.** Manual. A release is a pull request with a `chore(release): X.Y.Z` commit bumping `package.json`. Merging it publishes. No release tooling.
- **Placeholder.** The owner published `@nikovirtala/artifact@0.0.0` by hand so the package existed before the trusted publisher was registered. 1.0.0 is the first real release.

### What still protects releases

- Only `publish.yml` in this repository, on a GitHub-hosted runner, can publish; there is no token to leak.
- Publishing access on npmjs.com is set to "Require two-factor authentication and disallow tokens": no publish token can be used, and trusted publishing (OIDC) keeps working.
- Actions are pinned to commit SHAs; jobs have the least permissions they need.
- Only what reaches `main` publishes. Branch protection on `main` (required CI, no direct pushes) is recommended.
- Every version carries provenance linking it to the commit and workflow run.

### Exception: unsigned release tags

AGENTS.md says all commits and tags are signed. Release tags `vX.Y.Z` are created by GitHub Actions through the API and are not GPG-signed. This is a deliberate exception owned by the owner; the commit they point at is the reviewed commit on `main`, and npm provenance links each version to it.

The steps are in [RELEASING.md](../../RELEASING.md).

## Consequences

Merging a version bump publishes it with no further step, so review of the release pull request is the release approval. Merges that do not change the version run the workflow and skip. If several pushes to `main` queue up, GitHub keeps only the newest pending run, which publishes the version at its own commit; of two version bumps merged in quick succession, only the later one may publish. Changing the Node major means editing `mise.toml` and both workflows; renaming `publish.yml` breaks publishing until the trusted publisher is recreated. Updating an action means resolving its new commit SHA.
