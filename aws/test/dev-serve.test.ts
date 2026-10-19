// The S3 dev harness (docs/decisions/0062) runs the real `artifact serve` on S3 stores: here on
// the fake S3 endpoint, through the real SDK.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, freePort, runCli, serve, tempRoot } from "../../test/support/e2e.ts";
import { type FakeS3, startFakeS3 } from "../../test/support/fake-s3-server.ts";

const harness = fileURLToPath(new URL("../bin/artifact-s3.ts", import.meta.url));
process.env.ARTIFACT_CLI = harness;

const bucket = "artifact-e2e";

function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => {
        body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("pnpm --filter aws dev:serve", () => {
  let fake: FakeS3;
  let s3Env: Record<string, string>;

  before(async () => {
    fake = await startFakeS3();
    s3Env = {
      ARTIFACT_S3_ENDPOINT: fake.endpoint,
      ARTIFACT_S3_BUCKET: bucket,
      ARTIFACT_S3_PREFIX: "",
      AWS_ACCESS_KEY_ID: "fake",
      AWS_SECRET_ACCESS_KEY: "fake",
      AWS_SESSION_TOKEN: "",
      AWS_REGION: "eu-north-1",
    };
  });
  after(async () => {
    cleanup();
    await fake.close();
  });

  it("serves artifacts stored in S3, with no lockfile in the root", async () => {
    const port = await freePort();
    const root = tempRoot();
    const server = await serve(port, root, s3Env);
    const prefix = `${basename(root)}/`;
    assert.match(server.stdout(), new RegExp(`serving s3://${bucket}/${prefix} at `));

    const created = await fetch(`http://127.0.0.1:${port}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "index.html": "<body>from s3</body>" } }),
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };

    const page = await get(port, "/", `${id}.localhost:${port}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /^<body>from s3<script/);
    assert.ok(fake.objects(bucket).has(`${prefix}artifacts/${id}/meta.json`));
    assert.ok(fake.objects(bucket).has(`${prefix}artifacts/${id}/v/1/www/index.html`));
    assert.equal(existsSync(join(root, ".lock")), false);
    assert.deepEqual(existsSync(root) ? readdirSync(root) : [], []);

    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });

  it("refuses to serve without ARTIFACT_S3_BUCKET", async () => {
    const run = await runCli(["serve", "--port", String(await freePort())], {
      env: { ...s3Env, ARTIFACT_S3_BUCKET: "" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /ARTIFACT_S3_BUCKET is required for the S3 dev harness/);
  });

  it("prints the serve usage with --help, even without a bucket", async () => {
    const run = await runCli(["serve", "--help"], { env: { ARTIFACT_S3_BUCKET: "" } });
    assert.equal(run.status, 0);
    assert.match(run.stdout.toString(), /^Usage: artifact serve/);
  });

  it("delegates every other command to the normal CLI", async () => {
    const run = await runCli(["--version"]);
    assert.equal(run.status, 0);
    assert.match(run.stdout.toString(), /^\d+\.\d+\.\d+\n$/);
  });
});
