// The prebuilt Lambda assets (docs/decisions/0068): two ESM bundles with the runtime SDK
// external and the version inlined, importable with no package.json above them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type BundleReport, bundleAssets } from "../../scripts/bundle-assets.ts";
import { TS_SPECIFIER } from "../../scripts/lib/ts-specifier.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const VERSION = "9.8.7-test.1";

let dir: string;
let first: BundleReport;
let second: BundleReport;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "artifact-bundle-test-"));
  first = await bundleAssets({ outdir: join(dir, "a"), version: VERSION });
  second = await bundleAssets({ outdir: join(dir, "b"), version: VERSION });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const output = (name: string, run = "a") => readFileSync(join(dir, run, name, "index.mjs"), "utf8");

/** Import the bundle from a copy in an empty directory and return its stdout. */
function importBundle(name: string, env: Record<string, string>): string {
  const sandbox = mkdtempSync(join(tmpdir(), `artifact-bundle-${name}-`));
  try {
    copyFileSync(join(dir, "a", name, "index.mjs"), join(sandbox, "index.mjs"));
    symlinkSync(join(repo, "node_modules"), join(sandbox, "node_modules"), "dir");
    const script =
      'const m = await import("./index.mjs"); console.log("handler " + typeof m.handler);';
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: sandbox,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", AWS_EC2_METADATA_DISABLED: "true", ...env },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("bundleAssets", () => {
  it("builds the control and sweep bundles", () => {
    assert.deepEqual(
      first.entries.map((e) => e.name),
      ["control", "sweep"],
    );
    for (const name of ["control", "sweep"]) assert.ok(output(name).length > 0);
  });

  it("has no CDK, esbuild or src/cdk inputs and keeps @aws-sdk/* external", () => {
    for (const entry of first.entries) {
      for (const input of entry.inputs) {
        assert.doesNotMatch(input, /(^|\/)src\/cdk\//, input);
        assert.doesNotMatch(input, /node_modules\/(aws-cdk-lib|constructs|esbuild|@aws-sdk)\//);
      }
      assert.ok(entry.inputs.some((i) => i.endsWith("src/core/artifact-service.ts")));
    }
    const control = output("control");
    assert.match(control, /from\s*"@aws-sdk\/client-s3"/);
    assert.match(control, /from\s*"@aws-sdk\/client-secrets-manager"/);
    assert.match(output("sweep"), /from\s*"@aws-sdk\/client-s3"/);
    assert.doesNotMatch(output("sweep"), /client-secrets-manager"/);
  });

  it("keeps the JSON import attribute and inlines the version", () => {
    for (const name of ["control", "sweep"]) {
      assert.match(
        output(name),
        /import\(\s*"@aws-sdk\/client-s3\/package\.json"\s*,\s*\{\s*with\s*:\s*\{\s*type\s*:\s*"json"\s*\}\s*\}\s*\)/,
      );
      assert.ok(output(name).includes(JSON.stringify(VERSION)), name);
    }
  });

  it("names no .ts module (the pack test's rule)", () => {
    for (const name of ["control", "sweep"]) assert.doesNotMatch(output(name), TS_SPECIFIER);
  });

  it("control and sweep sources are unchanged (the M9 hashes at a pinned version)", () => {
    // Recorded at 55a26c0, the M9 state. The version is pinned, so this hashes sources only (a
    // hash of dist/assets would change with every release version); a deliberate change to
    // either bundle updates the fixture and says so in the commit.
    const fixture = JSON.parse(
      readFileSync(join(repo, "test", "fixtures", "m9-bundle-hashes.json"), "utf8"),
    ) as { version: string; control: string; sweep: string };
    assert.equal(VERSION, fixture.version);
    const sha256 = (name: "control" | "sweep") =>
      createHash("sha256")
        .update(readFileSync(join(dir, "a", name, "index.mjs")))
        .digest("hex");
    assert.deepEqual(
      { control: sha256("control"), sweep: sha256("sweep") },
      { control: fixture.control, sweep: fixture.sweep },
    );
  });

  it("is deterministic", () => {
    for (const name of ["control", "sweep"]) assert.equal(output(name, "a"), output(name, "b"));
    assert.equal(first.entries.length, second.entries.length);
  });

  it("imports without a package.json above it and logs one runtime line", () => {
    const env = {
      ARTIFACT_BUCKET: "b",
      ARTIFACT_VIEW_DOMAIN: "art.example.dev",
      ARTIFACT_TOKEN_SECRET_ARN: "arn:aws:secretsmanager:eu-north-1:000000000000:secret:x-AbCdEf",
      ARTIFACT_LIMITS: '{"maxFileBytes":3145728,"maxPublishBytes":3145728,"maxFiles":500}',
      ARTIFACT_MAX_BODY_BYTES: "4500000",
      AWS_REGION: "eu-north-1",
    };
    for (const name of ["control", "sweep"]) {
      const stdout = importBundle(name, env);
      const lines = stdout.split("\n").filter((l) => l.startsWith("artifact runtime "));
      assert.equal(lines.length, 1, stdout);
      const info = JSON.parse(lines[0].slice("artifact runtime ".length));
      assert.equal(info.package, VERSION);
      assert.equal(info.node, process.version);
      assert.match(info.clientS3, /^\d+\.\d+\.\d+/);
      if (name === "control") assert.match(info.clientSecretsManager, /^\d+\.\d+\.\d+/);
      else assert.equal(info.clientSecretsManager, undefined);
      assert.match(stdout, /^handler function$/m);
    }
  });
});
