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
