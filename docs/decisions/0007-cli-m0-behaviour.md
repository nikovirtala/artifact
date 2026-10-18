# 0007. M0 CLI: usage only, no argument-parsing dependency

Status: Accepted (M0)

## Context

M0 only requires `node src/cli/main.ts --help` to work with no build step.

## Decision

- `--help`, `-h` and `help` print usage listing serve, publish, list, read, open, rollback, rm and mcp to stdout, then exit 0.
- Running with no command prints usage to stderr and exits 1. A planned but unbuilt command prints "not implemented yet" and exits 1. An unknown command prints an error plus usage and exits 1.
- The file starts with `#!/usr/bin/env node`. `tsc` keeps the shebang, so `dist/cli/main.js` works as the `artifact` bin.
- No argument-parsing library. When flags arrive (M2/M5), `node:util` `parseArgs` covers them without adding a dependency.

## Consequences

The usage text is the CLI's contract until M5 and is asserted by `test/cli/main.test.ts`.

## Update (M5)

The CLI conventions are in [0041](0041-cli-client-conventions.md): usage errors (no or unknown command, bad flags) now exit 2, not 1; `--version` prints the package version; per-command `--help`; and "not implemented yet" is gone because every command exists. Flags still use `node:util` `parseArgs`.
