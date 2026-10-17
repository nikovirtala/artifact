# @nikovirtala/artifact

Local server that hosts HTML artifacts at stable URLs, keeps every publish as an immutable version, and live-reloads open tabs when an agent republishes. See [docs/00-plan.md](docs/00-plan.md) for the spec and [docs/decisions/](docs/decisions/) for decision records.

**Status: M1 (core + storage).** The core service (publish, list, read, rollback, delete) and the memory and filesystem stores are done and tested. Nothing is served yet, and the CLI only prints usage.

## Development

Requires [mise](https://mise.jdx.dev) (pins Node 24 and pnpm via `mise.toml`).

```sh
mise install
pnpm install
pnpm check                    # typecheck (tsc 7) + lint (biome) + test (node:test)
node src/cli/main.ts --help   # runs TypeScript directly, no build step
pnpm build                    # emit dist/ for the npm package
pnpm format                   # apply biome formatting and fixes
```
