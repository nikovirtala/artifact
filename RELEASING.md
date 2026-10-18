# Releasing

Merging a version bump to `main` publishes it. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on every push to `main`, publishes the `package.json` version to npm through trusted publishing (no npm token) if that version is not on npm yet, and creates the GitHub Release. Why: [ADR 0049](docs/decisions/0049-release-via-trusted-publishing.md).

## Release

1. Open a pull request with one commit `chore(release): X.Y.Z` that sets `version` in `package.json` (`artifact --version` prints it).
2. Merge it. The **Publish** workflow runs check, the pack test and the build, publishes `X.Y.Z` with provenance, then creates the GitHub Release and tag `vX.Y.Z` on the merged commit.

A prerelease version such as `1.1.0-beta.1` publishes under the `next` dist-tag (`npm install @nikovirtala/artifact@next`) and is marked as a prerelease on GitHub; `latest` is unchanged. A version lower than the current `latest` fails the workflow.

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
artifact --version
npm uninstall -g @nikovirtala/artifact
```

`pnpm link --global` does not work: pnpm 12's `link` has no `--global` flag.

## Troubleshooting

- **"version X already on npm; nothing to publish".** Expected for every merge that does not bump `version`. To release, bump it.
- **`ENEEDAUTH` / "Unable to authenticate" in the publish step.** The trusted publisher must match `publish.yml` exactly: user `nikovirtala`, repository `artifact`, workflow filename `publish.yml` (case-sensitive, with the extension), no environment. Also check that it has not expired (a new configuration expires without a successful publish within 2 days; delete and recreate it), that the job runs on a GitHub-hosted runner with `id-token: write`, and that `repository.url` in `package.json` is `git+https://github.com/nikovirtala/artifact.git`.
- **Published, but no GitHub Release.** Re-run the failed `release` job; it skips a release that already exists.
