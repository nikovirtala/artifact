// The reference deployment (docs/decisions/0075): its synthesized templates against a snapshot,
// and the rules for what may be committed (account id only in lib/stages.ts, no owner email).
import assert from "node:assert/strict";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { App, type Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildApp } from "../lib/app.ts";
import { ownersFromEnv } from "../lib/config.ts";
import { stages } from "../lib/stages.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const examples = join(here, "..");
const repo = join(examples, "..");
const snapshotFile = join(here, "test", "__snapshots__", "prod.json");
const OWNER = "owner@example.com";
const TWELVE_DIGITS = /\b\d{12}\b/;

function synth() {
  const { prod } = buildApp(new App(), stages, [OWNER]);
  const stacks: [string, Stack][] = [
    ["dns", prod.dns],
    ["certificate", prod.certificate],
    ["platform", prod.platform],
  ];
  return { prod, stacks };
}

/** The templates, serialised, with asset hashes and the stage's account replaced. */
function normalised(stacks: [string, Stack][]): string {
  const templates = Object.fromEntries(
    stacks.map(([name, stack]) => [name, Template.fromStack(stack).toJSON()]),
  );
  return `${JSON.stringify(templates, null, 2)
    .replace(/[0-9a-f]{64}/g, "<asset-hash>")
    .replaceAll(stages.prod.account, "<account>")}\n`;
}

describe("examples/personal", () => {
  it("matches the snapshot (UPDATE_SNAPSHOTS=1 rewrites it)", () => {
    const actual = normalised(synth().stacks);
    if (process.env.UPDATE_SNAPSHOTS === "1") writeFileSync(snapshotFile, actual);
    assert.equal(actual, readFileSync(snapshotFile, "utf8"));
    assert.doesNotMatch(actual, TWELVE_DIGITS);
  });

  it("derives stack names from the stage, in the right Regions, with cross-Region references", () => {
    const { prod, stacks } = synth();
    assert.equal(prod.stageName, "prod");
    assert.deepEqual(
      stacks.map(([, s]) => [s.stackName, s.region, s._crossRegionReferences]),
      [
        ["artifact-prod-dns", "us-east-1", true],
        ["artifact-prod-certificate", "us-east-1", true],
        ["artifact-prod-platform", "eu-north-1", true],
      ],
    );
  });

  it("retains the zone and the bucket and outputs the zone's name servers and id", () => {
    const { prod } = synth();
    const dns = Template.fromStack(prod.dns);
    dns.hasResource("AWS::Route53::HostedZone", {
      DeletionPolicy: "Retain",
      Properties: { Name: `${stages.prod.viewDomain}.` },
    });
    assert.deepEqual(
      Object.keys(dns.toJSON().Outputs).filter((o) => !o.startsWith("Exports")),
      ["NameServers", "HostedZoneId"],
    );
    Template.fromStack(prod.platform).hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });

  it("contains no owner but the placeholder", () => {
    const text = normalised(synth().stacks);
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? [];
    assert.deepEqual([...new Set(emails)], []);
    const owners = synth().prod.platform.artifacts.identity.owners;
    assert.deepEqual(owners, [OWNER]);
  });

  it("keeps a 12-digit number only in lib/stages.ts", () => {
    const files = globSync("**/*", { cwd: examples, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .filter((f) => !/[\\/](node_modules|cdk\.out[^\\/]*)[\\/]/.test(f));
    const holders = files.filter((file) => {
      const matches = readFileSync(file, "utf8").match(new RegExp(TWELVE_DIGITS, "g")) ?? [];
      const inTest = relative(here, file).startsWith("test");
      return inTest
        ? matches.some((m) => m !== "123456789012" && m !== "000000000000")
        : matches.length > 0;
    });
    assert.deepEqual(
      holders.map((f) => relative(repo, f)),
      ["examples/personal/lib/stages.ts"],
    );
  });

  it("reads the stage config without ARTIFACT_OWNERS and without building an app", () => {
    const source = readFileSync(join(here, "lib", "stages.ts"), "utf8");
    assert.doesNotMatch(source, /new App|buildApp|ownersFromEnv/);
    assert.equal(process.env.ARTIFACT_OWNERS, undefined);
    assert.deepEqual(Object.keys(stages), ["prod"]);
  });

  it("requires ARTIFACT_OWNERS for the app", () => {
    for (const env of [{}, { ARTIFACT_OWNERS: "" }, { ARTIFACT_OWNERS: " , " }]) {
      assert.throws(() => ownersFromEnv(env), {
        message: "set ARTIFACT_OWNERS to the owner email(s), comma-separated",
      });
    }
    assert.deepEqual(ownersFromEnv({ ARTIFACT_OWNERS: "a@example.com, b@example.com" }), [
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("has the root's feature-flag fixture equal to the installed aws-cdk's", () => {
    const fixture = join(repo, "test", "cdk", "fixtures", "recommended-feature-flags.json");
    const installed = join(
      here,
      "node_modules",
      "aws-cdk",
      "lib",
      "init-templates",
      ".recommended-feature-flags.json",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(fixture, "utf8")),
      JSON.parse(readFileSync(installed, "utf8")),
    );
  });
});
