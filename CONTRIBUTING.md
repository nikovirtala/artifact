# Contributing

Thanks for your interest in improving `@nikovirtala/artifact`. This guide covers the setup, the checks, and the git workflow. For the authoritative git, commit, and pull request rules, read [AGENTS.md](AGENTS.md); this guide summarizes them and points back there.

## Prerequisites

- Node 24. The repo pins the toolchain in [`mise.toml`](mise.toml) (Node 24, pnpm 12.14.0). You can use [mise](https://mise.jdx.dev/) to match it, or install Node 24 yourself.
- pnpm. The version is declared in `package.json` under `packageManager`, so Corepack can provide it (`corepack pnpm ...`); you do not need a separate global install.

## Set up

```sh
pnpm install
```

## Run the server

There is no build step for development; the CLI runs directly on Node 24.

```sh
node src/cli/main.ts serve                     # keep running: http://localhost:4400/
node src/cli/main.ts publish page.html         # in another terminal; prints the URL
```

Every command has `--help`. See the README [CLI](README.md#cli) and [Serve](README.md#serve) sections for the flags and environment variables.

## Check your work

Run the full check before you push. It runs the TypeScript typecheck, the Biome lint, the asset bundle, the `node:test` suite, and the sub-package checks:

```sh
pnpm check
```

You can also run the pieces on their own while iterating:

```sh
pnpm typecheck    # tsc
pnpm lint         # biome check
pnpm test         # node:test
```

To apply formatting and safe fixes:

```sh
pnpm format       # biome check --write
```

## Commits and pull requests

The rules in [AGENTS.md](AGENTS.md) are authoritative. In short:

- Keep a linear history: rebase your branch onto `origin/main` before you start and before you merge.
- Make atomic commits, each one self-contained and passing the checks on its own.
- Write [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) messages: `<type>(<optional scope>): <description>`, imperative mood, lowercase, no trailing period, 72 characters or fewer. The body explains why. Documentation changes use the `docs` type.
- Open a draft pull request against `main` as soon as your branch has its first commit, keep its description current, and mark it ready for review only when the work is complete, the branch is rebased, the fixups are squashed, and CI is green.

## Releases and changelog

Releases are automated: a push to `main` computes the next version from the Conventional Commits since the last tag and publishes it. There is no hand-maintained changelog; read the [GitHub Releases](https://github.com/nikovirtala/artifact/releases) page for the history. See [RELEASING.md](RELEASING.md) for details.

## Questions

Ask in [GitHub Discussions](https://github.com/nikovirtala/artifact/discussions), or open a [GitHub issue](https://github.com/nikovirtala/artifact/issues) for bugs and feature requests.

## A good first contribution

A documentation fix, a clarifying test, or a small bug fix is a good way to start. Read [docs/00-plan.md](docs/00-plan.md) for the spec and [docs/decisions/](docs/decisions/) for the decision records, then open a draft pull request early so you can get feedback while you work.
