// Run the v1 e2e suite through the S3 dev harness (docs/decisions/0062), with
// ARTIFACT_CLI=aws/bin/artifact-s3.ts. `--fake` uses an in-process fake S3 endpoint; otherwise
// ARTIFACT_TEST_BUCKET names the real bucket, a fresh prefix scopes the run, and the prefix is
// emptied at the end. serve.test.ts (the fs lockfile, 0026) and sweep.test.ts (files planted in
// the fs root) do not apply to S3 stores and are left out.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Store } from "../../src/runtime/adapters/s3-store.ts";
import { startFakeS3 } from "../../test/support/fake-s3-server.ts";
import { emptyPrefix, runPrefix } from "../../test/support/s3-bucket.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const harness = fileURLToPath(new URL("../bin/artifact-s3.ts", import.meta.url));
const excluded = new Set(["serve.test.ts", "sweep.test.ts"]);
const tests = readdirSync(new URL("../../test/e2e/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts") && !excluded.has(name))
  .sort()
  .map((name) => `test/e2e/${name}`);

const fakeMode = process.argv.includes("--fake");
const bucket = fakeMode ? "artifact-e2e" : process.env.ARTIFACT_TEST_BUCKET;
if (!bucket) {
  console.error("e2e: ARTIFACT_TEST_BUCKET is required (or pass --fake)");
  process.exit(1);
}

const fake = fakeMode ? await startFakeS3() : undefined;
const prefix = fakeMode ? "" : runPrefix().replace(/[^/]+\/$/, (run) => `e2e-${run}`);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ARTIFACT_CLI: harness,
  ARTIFACT_S3_BUCKET: bucket,
  ARTIFACT_S3_PREFIX: prefix,
  ...(fake && {
    ARTIFACT_S3_ENDPOINT: fake.endpoint,
    AWS_ACCESS_KEY_ID: "fake",
    AWS_SECRET_ACCESS_KEY: "fake",
    AWS_SESSION_TOKEN: "",
    AWS_REGION: "eu-north-1",
  }),
};

console.log(`e2e: ${tests.length} files through the S3 dev harness on s3://${bucket}/${prefix}`);
const status = await new Promise<number>((resolve) => {
  const child = spawn(process.execPath, ["--test", ...tests], { cwd: repo, env, stdio: "inherit" });
  child.once("exit", (code) => resolve(code ?? 1));
});

if (fake) await fake.close();
else {
  const client = new S3Client({});
  try {
    await emptyPrefix(createS3Store({ client, bucket, prefix }));
  } finally {
    client.destroy();
  }
}
process.exitCode = status;
