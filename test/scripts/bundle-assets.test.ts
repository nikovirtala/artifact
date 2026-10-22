// The prebuilt Lambda assets (docs/decisions/0068, 0079, 0082): four ESM bundles with the version
// inlined, each with its own checks — the runtime SDK external except in session-keys, which
// bundles only the KeyValueStore client and the SigV4A signer — importable from a copy of their
// directory with no package.json above it, plus the edge function copied as it is.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type BundleReport,
  bundleAssets,
  copyEdge,
  EDGE,
  ENTRIES,
  entryProblems,
} from "../../scripts/bundle-assets.ts";
import { TS_SPECIFIER } from "../../scripts/lib/ts-specifier.ts";
import { PLACEHOLDER_LINE } from "../../src/cdk/edge.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const VERSION = "9.8.7-test.1";
const NAMES = ["control", "sweep", "viewing", "session-keys"] as const;
const EXTERNAL_SDK = ["control", "sweep", "viewing"] as const;

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
const inputsOf = (name: string) => first.entries.find((e) => e.name === name)?.inputs ?? [];

/** Import the bundle from a copy of its whole directory in an empty one; return its stdout. */
function importBundle(name: string, env: Record<string, string>): string {
  const sandbox = mkdtempSync(join(tmpdir(), `artifact-bundle-${name}-`));
  try {
    cpSync(join(dir, "a", name), sandbox, { recursive: true });
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
  it("builds the control, sweep, viewing and session-keys bundles", () => {
    assert.deepEqual(Object.keys(ENTRIES), [...NAMES]);
    assert.deepEqual(
      first.entries.map((e) => e.name),
      [...NAMES],
    );
    for (const name of NAMES) assert.ok(output(name).length > 0);
  });

  it("has no CDK, esbuild or src/cdk inputs in any bundle", () => {
    for (const entry of first.entries) {
      for (const input of entry.inputs) {
        assert.doesNotMatch(input, /(^|\/)src\/cdk\//, input);
        assert.doesNotMatch(input, /node_modules\/(aws-cdk-lib|constructs|esbuild)\//);
      }
    }
  });

  it("keeps @aws-sdk/* external in control, sweep and viewing", () => {
    for (const name of EXTERNAL_SDK) {
      for (const input of inputsOf(name)) assert.doesNotMatch(input, /node_modules\/@aws-sdk\//);
      assert.match(output(name), /from\s*"@aws-sdk\/client-s3"/);
    }
    for (const name of ["control", "sweep", "viewing"]) {
      assert.ok(
        inputsOf(name).some((i) => i.endsWith("src/core/artifact-service.ts")),
        name,
      );
    }
    for (const name of ["control", "viewing"]) {
      assert.match(output(name), /from\s*"@aws-sdk\/client-secrets-manager"/, name);
    }
    assert.doesNotMatch(output("sweep"), /client-secrets-manager"/);
  });

  it("bundles only the KVS client, the SigV4A signer and their allowlisted helpers in session-keys", () => {
    const packages = new Set(
      inputsOf("session-keys").flatMap((i) => {
        const m = /node_modules\/@aws-sdk\/([^/]+)\//.exec(i);
        return m ? [m[1]] : [];
      }),
    );
    assert.ok(packages.has("client-cloudfront-keyvaluestore"));
    assert.ok(packages.has("signature-v4a"));
    for (const pkg of packages) {
      assert.ok(pkg === "client-cloudfront-keyvaluestore" || !pkg.startsWith("client-"), pkg);
    }
    assert.match(output("session-keys"), /from\s*"@aws-sdk\/client-secrets-manager"/);
    assert.doesNotMatch(output("session-keys"), /from\s*"@aws-sdk\/client-s3"/);
    assert.deepEqual(
      entryProblems("session-keys", inputsOf("session-keys"), output("session-keys")),
      [],
    );
  });

  it("keeps viewing small: no MCP, zod, node-server, API or control app, under 200 KB", () => {
    const inputs = inputsOf("viewing");
    for (const input of inputs) {
      assert.doesNotMatch(
        input,
        /node_modules\/(@modelcontextprotocol|zod|@hono\/node-server)\/|(^|\/)src\/mcp\/|(^|\/)src\/http\/(api|control-app)\.ts$/,
        input,
      );
    }
    assert.ok(inputs.some((i) => i.endsWith("src/runtime/handlers/login.ts")));
    assert.ok(inputs.some((i) => i.endsWith("src/http/viewing-app.ts")));
    assert.ok(Buffer.byteLength(output("viewing")) < 200 * 1024);
  });

  it("ships reload-client.js next to the viewing bundle, byte for byte", () => {
    assert.deepEqual(readdirSync(join(dir, "a", "viewing")).sort(), [
      "index.mjs",
      "reload-client.js",
    ]);
    const shipped = readFileSync(join(dir, "a", "viewing", "reload-client.js"));
    assert.ok(shipped.equals(readFileSync(join(repo, "src", "http", "reload-client.js"))));
    for (const name of ["control", "sweep", "session-keys"]) {
      assert.deepEqual(readdirSync(join(dir, "a", name)), ["index.mjs"], name);
    }
  });

  it("keeps the JSON import attribute and inlines the version", () => {
    for (const name of ["control", "sweep", "viewing"]) {
      assert.match(
        output(name),
        /import\(\s*"@aws-sdk\/client-s3\/package\.json"\s*,\s*\{\s*with\s*:\s*\{\s*type\s*:\s*"json"\s*\}\s*\}\s*\)/,
      );
      assert.ok(output(name).includes(JSON.stringify(VERSION)), name);
    }
  });

  it("names no .ts module (the pack test's rule)", () => {
    for (const name of NAMES) assert.doesNotMatch(output(name), TS_SPECIFIER);
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

  it("copies the edge function byte for byte (docs/decisions/0080)", () => {
    const source = readFileSync(join(repo, EDGE.source));
    assert.equal(first.edge, join(dir, "a", EDGE.out));
    assert.ok(readFileSync(first.edge).equals(source));
  });

  it("refuses an edge function whose first lines or placeholder were rewritten", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "artifact-edge-"));
    try {
      const good = readFileSync(join(repo, EDGE.source), "utf8");
      const lines = good.split("\n");
      const bad = [
        good.replace('import crypto from "crypto";', 'import crypto from "node:crypto";'),
        [lines[1], lines[0], ...lines.slice(2)].join("\n"),
        [lines[0], lines[1], ...lines.slice(3)].join("\n"),
        good.replace(`${PLACEHOLDER_LINE}\n`, ""),
        `${good}${PLACEHOLDER_LINE}\n`,
      ];
      for (const [i, text] of bad.entries()) {
        const file = join(sandbox, `bad-${i}.js`);
        writeFileSync(file, text);
        assert.throws(
          () => copyEdge(join(sandbox, `out-${i}`), file),
          /^Error: bundle-assets: edge /,
        );
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is deterministic", () => {
    for (const name of NAMES) assert.equal(output(name, "a"), output(name, "b"), name);
    assert.equal(
      readFileSync(join(dir, "a", "viewing", "reload-client.js"), "utf8"),
      readFileSync(join(dir, "b", "viewing", "reload-client.js"), "utf8"),
    );
    assert.equal(first.entries.length, second.entries.length);
  });

  it("imports from a copy of its directory and logs one runtime line (session-keys none)", () => {
    const env = {
      ARTIFACT_BUCKET: "b",
      ARTIFACT_VIEW_DOMAIN: "art.example.dev",
      ARTIFACT_TOKEN_SECRET_ARN: "arn:aws:secretsmanager:eu-north-1:000000000000:secret:x-AbCdEf",
      ARTIFACT_LIMITS: '{"maxFileBytes":3145728,"maxPublishBytes":3145728,"maxFiles":500}',
      ARTIFACT_MAX_BODY_BYTES: "4500000",
      ARTIFACT_SESSION_SECRET_ARN: "arn:aws:secretsmanager:eu-north-1:000000000000:secret:s-AbCdEf",
      ARTIFACT_OIDC_ISSUER: "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Test",
      ARTIFACT_OIDC_AUTHORIZE_URL: "https://x.auth.eu-north-1.amazoncognito.com/oauth2/authorize",
      ARTIFACT_OIDC_TOKEN_URL: "https://x.auth.eu-north-1.amazoncognito.com/oauth2/token",
      ARTIFACT_OIDC_LOGOUT_URL: "https://x.auth.eu-north-1.amazoncognito.com/logout",
      ARTIFACT_OIDC_CLIENT_ID: "client123",
      ARTIFACT_OWNERS: '["owner@example.com"]',
      AWS_REGION: "eu-north-1",
    };
    for (const name of NAMES) {
      const stdout = importBundle(name, env);
      const lines = stdout.split("\n").filter((l) => l.startsWith("artifact runtime "));
      assert.match(stdout, /^handler function$/m, name);
      if (name === "session-keys") {
        assert.deepEqual(lines, [], stdout);
        continue;
      }
      assert.equal(lines.length, 1, stdout);
      const info = JSON.parse(lines[0].slice("artifact runtime ".length));
      assert.equal(info.package, VERSION);
      assert.equal(info.node, process.version);
      assert.match(info.clientS3, /^\d+\.\d+\.\d+/);
      if (name === "sweep") assert.equal(info.clientSecretsManager, undefined);
      else assert.match(info.clientSecretsManager, /^\d+\.\d+\.\d+/);
    }
  });

  it("fails the viewing import when reload-client.js is missing", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "artifact-bundle-noreload-"));
    try {
      cpSync(join(dir, "a", "viewing", "index.mjs"), join(sandbox, "index.mjs"));
      symlinkSync(join(repo, "node_modules"), join(sandbox, "node_modules"), "dir");
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            ["--input-type=module", "-e", 'await import("./index.mjs")'],
            {
              cwd: sandbox,
              stdio: "pipe",
              env: { PATH: process.env.PATH ?? "" },
            },
          ),
        /ENOENT/,
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("entryProblems (the per-entry checks)", () => {
  const sdk = (pkg: string) => `node_modules/.pnpm/x/node_modules/@aws-sdk/${pkg}/dist-es/index.js`;
  const JSON_LINE = 'import("@aws-sdk/client-s3/package.json",{with:{type:"json"}})';
  const KVS_OK = [sdk("client-cloudfront-keyvaluestore"), sdk("signature-v4a"), sdk("core")];
  const SECRETS = 'import{GetSecretValueCommand as a}from"@aws-sdk/client-secrets-manager";';

  it("passes clean inputs", () => {
    assert.deepEqual(entryProblems("control", ["src/core/x.ts"], JSON_LINE), []);
    assert.deepEqual(entryProblems("viewing", ["node_modules/hono/dist/index.js"], JSON_LINE), []);
    assert.deepEqual(entryProblems("session-keys", KVS_OK, SECRETS), []);
  });

  it("fires on forbidden inputs in every entry", () => {
    for (const name of Object.keys(ENTRIES) as (keyof typeof ENTRIES)[]) {
      for (const input of [
        "src/cdk/index.ts",
        "node_modules/aws-cdk-lib/x.js",
        "node_modules/esbuild/x.js",
      ]) {
        const problems = entryProblems(name, [...KVS_OK, input], `${JSON_LINE}${SECRETS}`);
        assert.ok(
          problems.some(
            (p) => p.startsWith(`bundle-assets: ${name} bundles `) && p.includes(input),
          ),
          `${name} ${input}`,
        );
      }
    }
  });

  it("fires on a bundled SDK in the external entries", () => {
    for (const name of ["control", "sweep", "viewing"] as const) {
      const problems = entryProblems(name, [sdk("client-s3")], JSON_LINE);
      assert.ok(
        problems.some((p) => p.includes("@aws-sdk/client-s3")),
        name,
      );
    }
  });

  it("fires on a lost runtime-line JSON import, except in session-keys", () => {
    for (const name of ["control", "sweep", "viewing"] as const) {
      assert.deepEqual(entryProblems(name, [], "import('x')"), [
        `bundle-assets: ${name} lost the JSON import attribute of the runtime line`,
      ]);
    }
  });

  it("fires on the session-keys allowlist, a missing signer and a missing external import", () => {
    assert.deepEqual(entryProblems("session-keys", [...KVS_OK, sdk("client-s3")], SECRETS), [
      "bundle-assets: session-keys bundles @aws-sdk/client-s3",
    ]);
    assert.deepEqual(entryProblems("session-keys", [...KVS_OK, sdk("client-sso")], SECRETS), [
      "bundle-assets: session-keys bundles @aws-sdk/client-sso",
    ]);
    assert.deepEqual(entryProblems("session-keys", [...KVS_OK, sdk("something-new")], SECRETS), [
      "bundle-assets: session-keys bundles @aws-sdk/something-new",
    ]);
    for (const pkg of [
      "middleware-x",
      "util-y",
      "credential-provider-z",
      "nested-clients",
      "xml-builder",
    ]) {
      assert.deepEqual(entryProblems("session-keys", [...KVS_OK, sdk(pkg)], SECRETS), [], pkg);
    }
    assert.deepEqual(
      entryProblems("session-keys", [sdk("client-cloudfront-keyvaluestore")], SECRETS),
      ["bundle-assets: session-keys lacks @aws-sdk/signature-v4a"],
    );
    assert.deepEqual(entryProblems("session-keys", KVS_OK, ""), [
      'bundle-assets: session-keys lacks the external "@aws-sdk/client-secrets-manager" import',
    ]);
  });

  it("fires on the viewing exclusions and size", () => {
    for (const input of [
      "node_modules/.pnpm/a/node_modules/@modelcontextprotocol/sdk/x.js",
      "node_modules/.pnpm/a/node_modules/zod/x.js",
      "node_modules/.pnpm/a/node_modules/@hono/node-server/x.js",
      "src/mcp/server.ts",
      "src/http/api.ts",
      "src/http/control-app.ts",
    ]) {
      assert.deepEqual(entryProblems("viewing", [input], JSON_LINE), [
        `bundle-assets: viewing bundles ${input}`,
      ]);
      assert.deepEqual(entryProblems("control", [input], JSON_LINE), []);
    }
    const big = JSON_LINE + "x".repeat(200 * 1024);
    assert.deepEqual(entryProblems("viewing", [], big), [
      `bundle-assets: viewing is ${Buffer.byteLength(big)} bytes; the limit is 204800`,
    ]);
  });
});
