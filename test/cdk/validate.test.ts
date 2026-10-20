// Synth-time validation of the construct's props (docs/decisions/0071): domains, zones, the API
// host rule, AWS limits with their ceilings and binary headroom, throttle and alarm email.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { App, Lazy, type Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import {
  ArtifactHosting,
  type ArtifactHostingProps,
  AWS_LIMIT_CEILINGS,
  AWS_LIMIT_DEFAULTS,
} from "../../src/cdk/index.ts";
import { API, baseProps, hosting, testStack, testZone, VIEW } from "./helpers.ts";

const MIB = 1024 * 1024;

/** Build one construct with the base props changed by `change`. */
function build(change: (props: ArtifactHostingProps, stack: Stack) => ArtifactHostingProps) {
  const stack = testStack();
  const props = change(baseProps(testZone(stack)), stack);
  return new ArtifactHosting(stack, "Artifacts", props);
}

const withNames = (view: string, api: string) =>
  build((p) => ({
    ...p,
    viewDomain: { ...p.viewDomain, name: view },
    apiDomain: { ...p.apiDomain, name: api },
  }));

describe("domain names", () => {
  it("accepts bare names, lowercased, and the URLs follow them", () => {
    const construct = withNames("ART.Example.dev", "API.art.example.dev");
    assert.equal(construct.viewUrl, `https://${VIEW}/`);
    assert.equal(construct.apiUrl, `https://${API}`);
  });

  it("rejects schemes, ports, paths, trailing dots, single labels and bad labels", () => {
    for (const bad of [
      `https://${VIEW}`,
      `${VIEW}:443`,
      `${VIEW}/x`,
      `${VIEW}.`,
      "localhost",
      `-a.${VIEW}`,
      `a-.${VIEW}`,
      `a_b.${VIEW}`,
      `${"a".repeat(64)}.example.dev`,
      "",
    ]) {
      assert.throws(() => withNames(bad, API), /viewDomain.name must be a bare domain name/, bad);
      assert.throws(() => withNames(VIEW, bad), /apiDomain.name must be a bare domain name/, bad);
    }
  });

  it("accepts tokens unchecked", () => {
    const stack = testStack();
    const zone = HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z0000000000000000000",
      zoneName: Lazy.string({ produce: () => "example.dev" }),
    });
    const name = Lazy.string({ produce: () => VIEW });
    const construct = new ArtifactHosting(stack, "Artifacts", {
      ...baseProps(zone),
      viewDomain: { name, hostedZone: zone },
    });
    assert.ok(construct.viewUrl.includes("${Token["));
  });
});

describe("the API host", () => {
  it("must differ from the view domain", () => {
    assert.throws(() => withNames(VIEW, VIEW), /apiDomain.name must differ from viewDomain.name/);
  });

  it("must not be a 26-character artifact id label directly below the view domain", () => {
    assert.throws(
      () => withNames(VIEW, `01hzx3k4m5n6p7q8r9s0t1v2w3.${VIEW}`),
      /must not be a 26-character artifact id label/,
    );
    for (const ok of [
      `api.${VIEW}`,
      `a.b.${VIEW}`,
      `01hzx3k4m5n6p7q8r9s0t1v2w3.x.${VIEW}`,
      "artifact-api.example.dev",
    ]) {
      assert.equal(withNames(VIEW, ok).apiUrl, `https://${ok}`);
    }
  });
});

describe("hosted zones", () => {
  it("need their zoneName", () => {
    assert.throws(
      () =>
        build((p, stack) => ({
          ...p,
          viewDomain: {
            ...p.viewDomain,
            hostedZone: HostedZone.fromHostedZoneId(stack, "Id", "Z1"),
          },
        })),
      /viewDomain.hostedZone must carry its zoneName \(use HostedZone.fromHostedZoneAttributes, fromLookup or a created zone\)/,
    );
    assert.throws(
      () =>
        build((p, stack) => ({
          ...p,
          apiDomain: { ...p.apiDomain, hostedZone: HostedZone.fromHostedZoneId(stack, "Id", "Z1") },
        })),
      /apiDomain.hostedZone must carry its zoneName/,
    );
  });

  it("must hold the names", () => {
    assert.throws(
      () => withNames("art.other.dev", API),
      /viewDomain.name must be inside its hosted zone example.dev/,
    );
    assert.throws(
      () => withNames(VIEW, "api.other.dev"),
      /apiDomain.name must be inside its hosted zone/,
    );
    const other = build((p, stack) => ({
      ...p,
      apiDomain: {
        name: "api.other.dev",
        hostedZone: HostedZone.fromHostedZoneAttributes(stack, "Other", {
          hostedZoneId: "Z2",
          zoneName: "other.dev",
        }),
      },
    }));
    assert.equal(other.apiUrl, "https://api.other.dev");
  });
});

describe("limits", () => {
  const limits = (l: ArtifactHostingProps["limits"]) => build((p) => ({ ...p, limits: l }));

  it("default to option B and accept the ceilings", () => {
    assert.deepEqual(AWS_LIMIT_DEFAULTS, {
      maxFileBytes: 3_145_728,
      maxPublishBytes: 3_145_728,
      maxBodyBytes: 4_500_000,
      maxFiles: 500,
    });
    assert.deepEqual(AWS_LIMIT_CEILINGS, {
      maxFileBytes: 4 * MIB,
      maxPublishBytes: 4 * MIB,
      maxBodyBytes: 6_000_000,
      maxFiles: 500,
    });
    limits(undefined);
    limits({ ...AWS_LIMIT_CEILINGS });
  });

  it("reject one byte over a ceiling, non-integers and zero", () => {
    for (const key of Object.keys(AWS_LIMIT_CEILINGS) as (keyof typeof AWS_LIMIT_CEILINGS)[]) {
      const over = { ...AWS_LIMIT_CEILINGS, [key]: AWS_LIMIT_CEILINGS[key] + 1 };
      assert.throws(() => limits(over), RangeError, key);
      assert.throws(
        () => limits({ [key]: 0 }),
        new RegExp(`limits.${key} must be a positive integer`),
      );
      assert.throws(() => limits({ [key]: 1.5 }), RangeError);
    }
    assert.throws(
      () => limits({ maxFileBytes: 2 * MIB, maxPublishBytes: MIB }),
      /maxFileBytes must not exceed limits.maxPublishBytes/,
    );
  });

  it("keep binary headroom: body ≥ ceil(publish × 4/3) + 65,536", () => {
    const publish = { maxFileBytes: 4 * MIB, maxPublishBytes: 4 * MIB };
    assert.throws(
      () => limits({ ...publish, maxBodyBytes: 5_657_941 }),
      /maxBodyBytes must be at least ceil\(maxPublishBytes × 4\/3\) \+ 65536 = 5657942/,
    );
    limits({ ...publish, maxBodyBytes: 5_657_942 });
  });
});

describe("throttle and alarmEmail", () => {
  it("throttle limits are positive integers", () => {
    build((p) => ({ ...p, throttle: { rateLimit: 1, burstLimit: 1 } }));
    for (const throttle of [
      { rateLimit: 0 },
      { burstLimit: 0 },
      { rateLimit: 1.5 },
      { burstLimit: -1 },
    ]) {
      assert.throws(() => build((p) => ({ ...p, throttle })), RangeError);
    }
  });

  it("alarmEmail must be an email address", () => {
    build((p) => ({ ...p, alarmEmail: "ops@example.com" }));
    assert.throws(() => build((p) => ({ ...p, alarmEmail: "ops" })), /alarmEmail must be an email/);
  });
});

describe("construct rules", () => {
  const NAME_PROPS: Record<string, string> = {
    "AWS::S3::Bucket": "BucketName",
    "AWS::Cognito::UserPool": "UserPoolName",
  };

  it("sets no physical names", () => {
    const { template } = hosting();
    for (const [type, prop] of Object.entries(NAME_PROPS)) {
      for (const [, r] of Object.entries(template.findResources(type))) {
        assert.equal((r as { Properties?: Record<string, unknown> }).Properties?.[prop], undefined);
      }
    }
  });

  it("two instances in one stack synthesize with distinct ids and outputs", () => {
    const app = new App();
    const stack = testStack(app);
    const zone = testZone(stack);
    new ArtifactHosting(stack, "One", baseProps(zone));
    new ArtifactHosting(stack, "Two", {
      ...baseProps(zone),
      viewDomain: { name: `two.${VIEW}`, hostedZone: zone },
      apiDomain: { name: `api.two.${VIEW}` },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::S3::Bucket", 2);
    template.resourceCountIs("AWS::Cognito::UserPool", 2);
    const outputs = Object.keys(template.toJSON().Outputs);
    assert.equal(new Set(outputs).size, outputs.length);
    assert.ok(outputs.some((o) => o.startsWith("OneBucketName")));
    assert.ok(outputs.some((o) => o.startsWith("TwoBucketName")));
    app.synth();
  });
});
