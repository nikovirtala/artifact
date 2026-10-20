// Two `ArtifactHosting`s never collide (docs/decisions/0071): no physical names, distinct
// outputs, one shared CDK auto-delete provider; also two stacks; an env-agnostic template has
// no account or Region literal.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ArtifactHosting } from "../../src/cdk/index.ts";
import { baseProps, createdZone, resources, testStack, testZone, VIEW } from "./helpers.ts";

/** Properties that would give a resource a physical name. */
const NAME_PROPS: Record<string, string[]> = {
  "AWS::S3::Bucket": ["BucketName"],
  "AWS::Cognito::UserPool": ["UserPoolName"],
  "AWS::Lambda::Function": ["FunctionName"],
  "AWS::IAM::Role": ["RoleName"],
  "AWS::IAM::Policy": [],
  "AWS::Logs::LogGroup": ["LogGroupName"],
  "AWS::SecretsManager::Secret": ["Name"],
  "AWS::Scheduler::Schedule": ["Name"],
  "AWS::SNS::Topic": ["TopicName"],
  "AWS::CloudWatch::Alarm": ["AlarmName"],
};

function two(destroy: boolean) {
  const app = new App();
  const stack = testStack(app);
  const zone = testZone(stack);
  const dataRetention = destroy ? { onDestroy: RemovalPolicy.DESTROY } : undefined;
  new ArtifactHosting(stack, "One", {
    ...baseProps(zone),
    dataRetention,
    alarmEmail: "a@example.com",
  });
  new ArtifactHosting(stack, "Two", {
    ...baseProps(zone),
    viewDomain: { name: `two.${VIEW}`, hostedZone: zone },
    apiDomain: { name: `api.two.${VIEW}` },
    dataRetention,
  });
  return { app, template: Template.fromStack(stack) };
}

describe("two instances", () => {
  it("in one stack: no physical names, distinct outputs, one auto-delete provider", () => {
    for (const destroy of [false, true]) {
      const { app, template } = two(destroy);
      for (const [type, props] of Object.entries(NAME_PROPS)) {
        for (const [id, r] of resources(template, type)) {
          for (const prop of props) assert.equal(r.Properties?.[prop], undefined, `${id}.${prop}`);
        }
      }
      template.resourceCountIs("AWS::S3::Bucket", 2);
      template.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
      template.resourceCountIs("AWS::SecretsManager::Secret", 2);
      const outputs = Object.keys(template.toJSON().Outputs);
      assert.equal(new Set(outputs).size, outputs.length);
      assert.equal(outputs.filter((o) => o.startsWith("OneApiUrl")).length, 1);
      assert.equal(outputs.filter((o) => o.startsWith("TwoApiUrl")).length, 1);
      const providers = resources(template, "AWS::Lambda::Function").filter(([id]) =>
        id.startsWith("CustomS3AutoDeleteObjectsCustomResourceProvider"),
      );
      assert.equal(providers.length, destroy ? 1 : 0);
      template.resourceCountIs("Custom::S3AutoDeleteObjects", destroy ? 2 : 0);
      assert.doesNotThrow(() => app.synth());
    }
  });

  it("in two stacks of one app both synthesize", () => {
    const app = new App();
    for (const id of ["A", "B"]) {
      const stack = testStack(app, id);
      new ArtifactHosting(stack, "Artifacts", baseProps(createdZone(stack)));
    }
    const assembly = app.synth();
    assert.equal(assembly.stacks.length, 2);
  });
});

describe("environment-agnostic", () => {
  const regionLiteral =
    /\b[a-z]{2}(-gov)?-(north|south|east|west|central|northeast|southeast|northwest|southwest)-\d\b/;

  it("synthesizes a template without account or Region literals", () => {
    const stack = new Stack(new App(), "Agnostic");
    new ArtifactHosting(stack, "Artifacts", baseProps(createdZone(stack)));
    const text = JSON.stringify(Template.fromStack(stack).toJSON());
    assert.doesNotMatch(text, /\b\d{12}\b/);
    assert.doesNotMatch(text, regionLiteral);
  });

  it("src/cdk has no account or Region literal except us-east-1 in certificate.ts", () => {
    const dir = fileURLToPath(new URL("../../src/cdk/", import.meta.url));
    for (const file of globSync("**/*.ts", { cwd: dir })) {
      const source = readFileSync(join(dir, file), "utf8");
      assert.doesNotMatch(source, /\b\d{12}\b/, file);
      const regions = source.match(new RegExp(regionLiteral.source, "g")) ?? [];
      assert.deepEqual([...new Set(regions)], file === "certificate.ts" ? ["us-east-1"] : [], file);
    }
  });
});
