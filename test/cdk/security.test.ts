// Least privilege and the construct-scope rule (docs/decisions/0070, 0071), under default
// feature flags and under the `cdk init` recommended flags with strict CloudFormation Validate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { App, CfnResource, RemovalPolicy } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { hosting } from "./helpers.ts";
import { assertSecurityShape } from "./security-shape.ts";

const flags = JSON.parse(
  readFileSync(new URL("./fixtures/recommended-feature-flags.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const retentions = [
  ["default retention", {}],
  ["DESTROY", { dataRetention: { onDestroy: RemovalPolicy.DESTROY } }],
] as const;

describe("security shape", () => {
  for (const [name, props] of retentions) {
    it(`is least privilege with default flags (${name})`, () => {
      const { template, construct } = hosting(props);
      assertSecurityShape(template, construct, { destroy: name === "DESTROY" });
    });

    it(`is the same under the recommended flags, and strict validation passes (${name})`, () => {
      const app = new App({
        context: { ...flags, "@aws-cdk/core:strictCfnValidateErrors": true },
      });
      const { template, construct } = hosting(props, app);
      assertSecurityShape(template, construct, { destroy: name === "DESTROY" });
      assert.doesNotThrow(() => app.synth());
    });
  }

  it("keeps every role and function under the construct, except CDK's auto-delete provider", () => {
    for (const [name, props] of retentions) {
      const { stack } = hosting(props);
      const outside = stack.node
        .findAll()
        .filter(
          (c): c is CfnResource =>
            CfnResource.isCfnResource(c) &&
            ["AWS::IAM::Role", "AWS::Lambda::Function"].includes(c.cfnResourceType),
        )
        .map((c) => c.node.path)
        .filter((path) => !path.startsWith("Test/Artifacts/"));
      assert.deepEqual(
        outside,
        name === "DESTROY"
          ? [
              "Test/Custom::S3AutoDeleteObjectsCustomResourceProvider/Role",
              "Test/Custom::S3AutoDeleteObjectsCustomResourceProvider/Handler",
            ].filter((p) => outside.includes(p))
          : [],
        name,
      );
      if (name === "DESTROY") assert.ok(outside.length > 0);
    }
  });

  it("deletes all three log groups with the stack and keeps them 30 days by default", () => {
    const { template } = hosting();
    const groups = Object.values(template.findResources("AWS::Logs::LogGroup"));
    assert.equal(groups.length, 3);
    for (const group of groups) {
      assert.equal(group.DeletionPolicy, "Delete");
      assert.equal(group.UpdateReplacePolicy, "Delete");
      assert.equal(group.Properties.RetentionInDays, 30);
      assert.equal(group.Properties.LogGroupName, undefined);
    }
    Template.fromStack(hosting({ logRetention: 7 }).stack).allResourcesProperties(
      "AWS::Logs::LogGroup",
      { RetentionInDays: 7 },
    );
  });
});
