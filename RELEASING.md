# Releasing

Releases are automatic. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on every push to `main`, computes the next version from the highest `vX.Y.Z` tag reachable from the pushed commit plus the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) since it, publishes it to npm through trusted publishing (no npm token), and creates the GitHub Release and tag `vX.Y.Z` on that commit. Why: [ADR 0049](docs/decisions/0049-release-via-trusted-publishing.md), [ADR 0077](docs/decisions/0077-version-from-tags.md).

Git tags are the source of truth for the version. `package.json` on `main` holds the placeholder `0.0.0-development`; CI stamps the computed version into its own checkout only, so nothing is committed after the merge.

## Release

1. Merge pull requests whose commits follow AGENTS.md (the CI `commits` job checks them).
2. Since the last tag, the highest of these wins:
   - `feat` → minor (`1.0.0` → `1.1.0`)
   - `fix`, `perf` → patch (`1.0.0` → `1.0.1`)
   - a breaking change → major (`1.0.0` → `2.0.0`)
   - anything else (`docs`, `ci`, `chore`, `refactor`, `test`, `build`, `style`, `revert`) → no release
3. The **Publish** workflow runs check, the pack test and the build, publishes `X.Y.Z` with provenance under `latest`, then creates the GitHub Release and tag `vX.Y.Z`.

Preview the next release from a full clone with tags (git only, no npm):

```sh
git fetch --tags && node scripts/release-check.ts next
```

### Force a major

Add `!` after the type or scope and a `BREAKING CHANGE:` footer (uppercase) explaining the impact and migration:

```text
feat(cli)!: drop the --legacy flag

BREAKING CHANGE: --legacy is gone; use --mode legacy instead.
```

### Prereleases

Not automated: computed versions are always stable. To publish one by hand with your own npm login (2FA, no provenance), from a clean checkout of the commit:

```sh
npm version 1.2.0-beta.1 --no-git-tag-version
npm publish --tag next
git checkout -- package.json
```

`--tag next` keeps it off `latest`. A follow-up can add a `workflow_dispatch` input to `publish.yml` (ADR 0077). Do not push a `v1.2.0-beta.1` tag expecting a release; prerelease tags are never used as the base.

## Verify

- `npm view @nikovirtala/artifact version` prints `X.Y.Z` (`npm view @nikovirtala/artifact dist-tags` for prereleases).
- The version page on npmjs.com shows the provenance badge, linking to the commit and workflow run.

## Already in place on npmjs.com

- Trusted publisher: GitHub Actions, `nikovirtala` / `artifact` / `publish.yml`, no environment, "Allow npm publish" and "Allow npm dist-tag" checked.
- Publishing access: "Require two-factor authentication and disallow tokens". No publish token can be used; trusted publishing keeps working because it uses OIDC.

Optional, once, with your own npm login (OIDC cannot deprecate):

```sh
npm deprecate @nikovirtala/artifact@0.0.0 "placeholder, use 1.0.0 or later"
```

## Try the CLI locally before a release

```sh
pnpm build && npm install -g "$(pnpm pack --pack-destination /tmp | tail -1)"
artifact --version   # prints the placeholder 0.0.0-development
npm uninstall -g @nikovirtala/artifact
```

`pnpm link --global` does not work: pnpm 12's `link` has no `--global` flag.

## Troubleshooting

- **"no feat, fix, perf or breaking commits since vX.Y.Z; nothing to release".** Expected for merges of only non-releasing commits. To ship, merge a `feat`, `fix` or `perf` commit (or a breaking change).
- **"vX.Y.Z is on npm but no tag vX.Y.Z is reachable".** An earlier run published but did not create the tag. Find the published commit with `npm view @nikovirtala/artifact@X.Y.Z gitHead` and create the release there: `gh release create vX.Y.Z --target <sha> --title vX.Y.Z --generate-notes`. The next push then computes from it.
- **"no release tag vX.Y.Z reachable from HEAD".** The tags are missing from the checkout or were deleted. Restore the latest release tag on its commit (`gh release create vX.Y.Z --target <sha>`, or `git tag vX.Y.Z <sha> && git push origin vX.Y.Z`). "shallow clone" means the checkout lost `fetch-depth: 0`.
- **"package.json version is the placeholder" from `npm publish`.** Releases publish from CI; for a manual prerelease, stamp the version first (see Prereleases).
- **`ENEEDAUTH` / "Unable to authenticate" in the publish step.** The trusted publisher must match `publish.yml` exactly: user `nikovirtala`, repository `artifact`, workflow filename `publish.yml` (case-sensitive, with the extension), no environment. Also check that it has not expired (a new configuration expires without a successful publish within 2 days; delete and recreate it), that the job runs on a GitHub-hosted runner with `id-token: write`, and that `repository.url` in `package.json` is `git+https://github.com/nikovirtala/artifact.git`.
- **Published, but no GitHub Release.** Re-run only the **failed** `release` job, so it reuses the published version; it skips a release that already exists. Re-running all jobs skips with the "on npm but no tag" warning above instead.
