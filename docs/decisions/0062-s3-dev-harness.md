# 0062. Dev harness: `pnpm --filter aws dev:serve` runs `artifact serve` on S3 stores

Status: Accepted (M8)

## Context

M8 asks for a dev harness that runs the local server on S3 stores, with the v1 e2e suite passing through it. The plan's open question settled that it stays a dev harness; `artifact serve --store s3://…` as a supported mode is later work. The v1 CLI must not import `src/runtime/` (0050), and the e2e suite must run unchanged.

## Decision

- `runServe(args, env, deps)` gains an optional `openStore(config) → { store, location }`. With it, serve skips creating the fs root and the lockfile (0026): conditional writes are the lock on S3 (plan gap 7). It logs `artifact: serving <location> at …`. The orphan sweep still runs; its 10-minute age guard (0047) keeps in-flight publishes from other processes safe without the lock. Without `openStore` nothing changes.
- `aws/bin/artifact-s3.ts` (in the private `aws/` package, 0059) runs `serve` with `openStore` building an `S3Client` and `createS3Store`, and hands every other command to `src/cli/main.ts`. Environment:
  - `ARTIFACT_S3_BUCKET` (required for `serve`, except `serve --help`; otherwise exit 1 with a message);
  - `ARTIFACT_S3_PREFIX` (optional, `""` or ending in `/`);
  - `ARTIFACT_S3_ENDPOINT` (optional; path-style client for a non-AWS endpoint such as the fake);
  - credentials and region come from the default SDK chain.
- The store prefix is `ARTIFACT_S3_PREFIX + basename(--root) + "/"`, so each e2e temp root gets its own key space and a restarted server on the same root sees its state again. `--root` is otherwise unused.
- `pnpm --filter aws dev:serve [serve options]` starts it. `aws/scripts/e2e.ts` runs `test/e2e/*.test.ts` with `ARTIFACT_CLI` set to the harness: `--fake` (`pnpm --filter aws test:e2e:fake`, part of `pnpm check`) against an in-process fake S3 endpoint, or without it (`pnpm --filter aws test:e2e`) against `ARTIFACT_TEST_BUCKET` under a fresh `e2e-<run>/` prefix that it empties afterwards.
- **Deviation:** two e2e files are left out because they test the fs store, not the server: `serve.test.ts` asserts the `.lock` file and its takeover (0026), and `sweep.test.ts` plants files in the fs root. Everything else in `test/e2e/` runs through the harness.

## Consequences

The real serve path (config, sweep, app split, live reload, MCP, the CLI client commands) is exercised on S3 stores on every `pnpm check` via the fake, and against a real bucket once it exists. Over the network the live-reload checks that expect an update within 1 s may be tighter than on the fake.
