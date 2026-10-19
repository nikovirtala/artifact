// Every real-bucket test in one command (docs/decisions/0063): the store contract and the
// two-instance concurrency test, then the e2e suite through the dev harness. Requires
// ARTIFACT_TEST_BUCKET, so a run never passes by silently skipping.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.ARTIFACT_TEST_BUCKET) {
  console.error("ARTIFACT_TEST_BUCKET is required");
  process.exit(1);
}

const repo = fileURLToPath(new URL("../../", import.meta.url));
const e2e = fileURLToPath(new URL("./e2e.ts", import.meta.url));
const run = (args: string[]) =>
  spawnSync(process.execPath, args, { cwd: repo, stdio: "inherit" }).status ?? 1;

const tests = run([
  "--test",
  "test/contract/s3-store.test.ts",
  "test/runtime/s3-concurrency.test.ts",
]);
const suite = run([e2e]);
process.exitCode = tests || suite;
