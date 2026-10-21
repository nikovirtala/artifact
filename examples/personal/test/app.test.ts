// The reference deployment (docs/decisions/0075): its synthesized templates against a snapshot,
// and the rules for what may be committed (account id only in lib/stages.ts, no owner email).
import assert from "node:assert/strict";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { App, type Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { tarballAppFiles } from "../../../scripts/lib/tarball-app.ts";
import { buildApp } from "../lib/app.ts";
import { ownersFromEnv } from "../lib/config.ts";
import { stages } from "../lib/stages.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const examples = join(here, "..");
const repo = join(examples, "..");
const snapshotFile = join(here, "test", "__snapshots__", "prod.json");
const m9File = join(here, "test", "__snapshots__", "m9-platform.json");
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

  it("keeps every M9 resource", () => {
    // m9-platform.json is prod.json as deployed by M9 (55a26c0), never regenerated. Each M9
    // resource must keep its Type and its Properties, DeletionPolicy and UpdateReplacePolicy,
    // so the update of the live stacks replaces nothing. IN_PLACE lists the resources whose
    // Properties may change in place, with the reason.
    const IN_PLACE: Record<string, Record<string, string>> = {
      platform: {
        // M10: the cross-Region reader also reads the view certificate's ARN for the
        // distribution (docs/decisions/0083); a custom resource, modified in place.
        ExportsReader8B249524: "reads one more cross-Region import",
      },
    };
    type Resource = Record<
      "Type" | "Properties" | "DeletionPolicy" | "UpdateReplacePolicy",
      unknown
    >;
    type Templates = Record<string, { Resources: Record<string, Resource> }>;
    const m9 = JSON.parse(readFileSync(m9File, "utf8")) as Templates;
    const actual = JSON.parse(normalised(synth().stacks)) as Templates;
    assert.deepEqual(Object.keys(m9), ["dns", "certificate", "platform"]);
    for (const [stack, template] of Object.entries(m9)) {
      for (const [id, before] of Object.entries(template.Resources)) {
        const after = actual[stack].Resources[id];
        assert.ok(after, `${stack}: ${id} is gone`);
        assert.equal(after.Type, before.Type, `${stack}: ${id} Type`);
        for (const key of ["DeletionPolicy", "UpdateReplacePolicy"] as const) {
          assert.deepEqual(after[key], before[key], `${stack}: ${id} ${key}`);
        }
        if (IN_PLACE[stack]?.[id] === undefined) {
          assert.deepEqual(after.Properties, before.Properties, `${stack}: ${id} Properties`);
        }
      }
    }
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

  it("passes the stage's viewing options to the construct; prod sets none", () => {
    assert.equal(stages.prod.viewing, undefined);
    const viewing = { reservedConcurrency: 5, sessionKeyRotation: "2" } as const;
    const { prod } = buildApp(new App(), { prod: { ...stages.prod, viewing } }, [OWNER]);
    const template = Template.fromStack(prod.platform);
    template.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 5 });
    template.hasResourceProperties("Custom::ArtifactSessionKeys", { Rotation: "2" });
  });

  it("keeps the prod viewing environment within 3500 bytes (the synth succeeds)", () => {
    // viewingEnvironment throws at synth above 3500 bytes, counting tokens at their bound.
    const { prod } = synth();
    const view = Template.fromStack(prod.platform).findResources("AWS::Lambda::Function", {
      Properties: { Environment: { Variables: { ARTIFACT_OWNERS: `["${OWNER}"]` } } },
    });
    assert.equal(Object.keys(view).length, 1);
  });

  it("contains no email but the placeholder owner", () => {
    // M10 creates a Cognito user per owner, so the placeholder now appears in the templates.
    const text = normalised(synth().stacks);
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? [];
    assert.deepEqual([...new Set(emails)], [OWNER]);
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

describe("README (the CloudShell guide)", () => {
  const readme = readFileSync(join(here, "README.md"), "utf8");

  it("shows exactly the tarball app that pack-test (b3) synthesizes", () => {
    const step = readme.slice(
      readme.indexOf("3. Replace `bin/tarball-app.ts`"),
      readme.indexOf("4. Deploy"),
    );
    const blocks = [...step.matchAll(/^ {3}```ts\n([\s\S]*?)^ {3}```$/gm)].map((m) =>
      m[1].replace(/^ {3}/gm, ""),
    );
    const { bin, stack } = tarballAppFiles("tarball-app");
    assert.deepEqual(blocks, [bin.text, stack.text]);
  });

  it("holds no account id, email address or GitHub token", () => {
    assert.doesNotMatch(readme, TWELVE_DIGITS);
    assert.doesNotMatch(readme, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    assert.match(readme, /ARTIFACT_OWNERS=<email>/);
    assert.doesNotMatch(readme, /ghp_|github_pat_/);
  });

  it("names only pnpm scripts that exist", () => {
    const scripts = (dir: string) =>
      Object.keys(
        (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: object })
          .scripts,
      );
    const known = new Set([
      ...scripts(here),
      ...scripts(repo),
      "install",
      "exec",
      "config",
      "pack",
      "--version",
    ]);
    const named = [...readme.matchAll(/\bpnpm ([a-z:-]+)/g)].map((m) => m[1]);
    assert.ok(named.includes("smoke") && named.includes("check:dns"));
    assert.deepEqual(
      named.filter((n) => !known.has(n)),
      [],
    );
  });
});
