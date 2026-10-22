// The guide's pre-deploy gate (docs/decisions/0083, design §8), offline: `cdk diff` of the M10
// synth against the M9 templates (m9-platform.json with the account put back) must show no
// resource-level removal or replacement, only the in-place cross-Region reader change in
// Platform and the export writer in Certificate, nothing in Dns; and the gate must fire on a
// removal (the negative control). No AWS access: --template, --no-notices, no telemetry.
//
// The fixture keeps `<asset-hash>` (only the account is put back, design §8 step 2), so every
// Lambda in it shows a `[~] Code.S3Key` change from `<asset-hash>.zip` to the real hash. That is
// a normalisation artefact, not a change; against the deployed template it does not appear. In
// Dns it is the only change allowed, checked line by line, so no second property slips through.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { buildApp } from "../lib/app.ts";
import { stages } from "../lib/stages.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "owner@example.com";
/** The guide's gate, unchanged: resource-level removals and replacements only. */
const GATE = /requires replacement|may be replaced|^\[-\] |^\[~\] .* replace$/m;
const ADD_OR_REMOVE = /^\[[-+]\] /m;
/** The property lines of a normalisation-only change: Code.S3Key from the placeholder. */
const S3KEY_ONLY = [
  /^└─ \[~\] Code$/,
  /^└─ \[~\] \.S3Key:$/,
  /^├─ \[-\] <asset-hash>\.zip$/,
  /^└─ \[\+\] [0-9a-f]{64}\.zip$/,
];

/**
 * Every `[~]` resource of a diff report whose property lines (up to the next unindented line)
 * are anything but exactly the `<asset-hash>` → real hash `Code.S3Key` change.
 */
function nonArtefactChanges(report: string): string[] {
  const lines = report.split("\n");
  const problems: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith("[~] ")) continue;
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === "" || !/^\s/.test(next)) break;
      body.push(next.trim());
    }
    const ok = body.length === S3KEY_ONLY.length && body.every((l, j) => S3KEY_ONLY[j].test(l));
    if (!ok) problems.push(`${line}\n${body.join("\n")}`);
  }
  return problems;
}

type Templates = Record<string, { Resources: Record<string, unknown> }>;
const m9 = JSON.parse(
  readFileSync(join(here, "test", "__snapshots__", "m9-platform.json"), "utf8").replaceAll(
    "<account>",
    stages.prod.account,
  ),
) as Templates;

describe("the cdk diff gate against the M9 templates", () => {
  let tmp: string;
  let assembly: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "artifact-diff-gate-"));
    assembly = join(tmp, "cdk.out");
    const app = new App({ outdir: assembly });
    buildApp(app, stages, [OWNER]);
    app.synth();
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  /** The diff report (stdout and stderr: cdk diff writes it to stderr). */
  function run(stack: string, template: unknown): string {
    const file = join(tmp, `${stack.replace("/", "-")}.json`);
    writeFileSync(file, JSON.stringify(template));
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "cdk",
        "diff",
        "--no-color",
        "--no-notices",
        "--exclusively",
        "--app",
        assembly,
        "--template",
        file,
        stack,
      ],
      {
        cwd: here,
        encoding: "utf8",
        env: {
          ...process.env,
          ARTIFACT_OWNERS: OWNER,
          AWS_EC2_METADATA_DISABLED: "true",
          CDK_DISABLE_CLI_TELEMETRY: "true",
        },
      },
    );
    const out = `${result.stdout}${result.stderr}`;
    // A report, not a CLI failure: it names the stack it compared.
    assert.match(out, new RegExp(`^Stack ${stack.replace("/", "\\/")}`, "m"), out);
    return out;
  }

  it("Platform: no removal or replacement; the cross-Region reader changes in place", () => {
    const out = run("prod/Platform", m9.platform);
    assert.doesNotMatch(out, GATE, out);
    assert.match(out, /^\[~\] Custom::CrossRegionExportReader \S+ ExportsReader8B249524$/m, out);
  });

  it("Certificate: only the cross-Region export writer is added", () => {
    const out = run("prod/Certificate", m9.certificate);
    assert.doesNotMatch(out, GATE, out);
    assert.match(out, /^\[\+\] Custom::CrossRegionExportWriter /m, out);
  });

  it("Dns: no resource changes beyond the <asset-hash> artefact", () => {
    const out = run("prod/Dns", m9.dns);
    assert.doesNotMatch(out, GATE, out);
    assert.doesNotMatch(out, ADD_OR_REMOVE, out);
    assert.deepEqual(nonArtefactChanges(out), []);
  });

  it("Dns: a second changed property under the artefact's [~] is caught (negative control)", () => {
    const handler = "CustomCrossRegionExportWriterCustomResourceProviderHandlerD8786E8A";
    const resources = m9.dns.Resources as Record<string, { Properties: Record<string, unknown> }>;
    const changed = {
      ...m9.dns,
      Resources: {
        ...resources,
        [handler]: {
          ...resources[handler],
          Properties: { ...resources[handler].Properties, Timeout: 1 },
        },
      },
    };
    const problems = nonArtefactChanges(run("prod/Dns", changed));
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /Timeout/);
  });

  it("fires on a removed M9 resource (negative control)", () => {
    const { ArtifactsBucket88671897: bucket, ...rest } = m9.platform.Resources;
    const renamed = {
      ...m9.platform,
      Resources: { ...rest, ArtifactsBucketRenamed: bucket },
    };
    const out = run("prod/Platform", renamed);
    assert.match(out, GATE, out);
  });
});
