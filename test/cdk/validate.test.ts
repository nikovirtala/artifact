// Synth-time validation of the construct's props (docs/decisions/0071, 0085): domains, the
// literal view domain, the view certificate rule, zones, the API host rule, AWS limits with
// their ceilings and binary headroom, throttle and alarm email.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { App, CfnParameter, Lazy, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Certificate, type ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import {
  ArtifactHosting,
  type ArtifactHostingProps,
  AWS_LIMIT_CEILINGS,
  AWS_LIMIT_DEFAULTS,
} from "../../src/cdk/index.ts";
import {
  ACCOUNT,
  API,
  baseProps,
  hosting,
  resources,
  testStack,
  testZone,
  VIEW,
  VIEW_CERTIFICATE_ARN,
  viewCertificate,
} from "./helpers.ts";

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

  it("rejects a token view domain name: the edge function embeds it", () => {
    const stack = testStack();
    const zone = HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z0000000000000000000",
      zoneName: Lazy.string({ produce: () => "example.dev" }),
    });
    const name = Lazy.string({ produce: () => VIEW });
    assert.throws(
      () =>
        new ArtifactHosting(stack, "Artifacts", {
          ...baseProps(zone),
          viewDomain: { name, hostedZone: zone, certificate: viewCertificate(stack) },
        }),
      /^Error: viewDomain.name must be a literal domain name \(the edge function embeds it\)$/,
    );
  });
});

describe("the view certificate", () => {
  const inRegion = (region?: string) =>
    new Stack(new App(), "Test", region ? { env: { account: ACCOUNT, region } } : {});
  /** One construct in `stack` whose view domain has `certificate` (or none). */
  const withCertificate = (stack: Stack, certificate?: ICertificate) => {
    const hostedZone = testZone(stack);
    return new ArtifactHosting(
      stack,
      "Artifacts",
      baseProps(hostedZone, { viewDomain: { name: VIEW, hostedZone, certificate } }),
    );
  };

  it("is required unless the stack is in us-east-1, also in an environment-agnostic stack", () => {
    for (const region of ["eu-north-1", undefined]) {
      assert.throws(
        () => withCertificate(inRegion(region)),
        /^Error: viewDomain.certificate is required unless the stack is in us-east-1$/,
        String(region),
      );
    }
  });

  it("must be in us-east-1 when its ARN is a literal", () => {
    const stack = inRegion("eu-north-1");
    const arn = VIEW_CERTIFICATE_ARN.replace("us-east-1", "eu-north-1");
    assert.throws(
      () => withCertificate(stack, Certificate.fromCertificateArn(stack, "Cert", arn)),
      /^Error: viewDomain.certificate must be in us-east-1 \(CloudFront\)$/,
    );
  });

  it("is accepted unchecked when its ARN is a token, also in an environment-agnostic stack", () => {
    for (const region of ["eu-north-1", undefined]) {
      const stack = inRegion(region);
      const arn = new CfnParameter(stack, "CertArn").valueAsString;
      const certificate = Certificate.fromCertificateArn(stack, "Cert", arn);
      assert.equal(withCertificate(stack, certificate).viewCertificate, certificate);
    }
  });

  it("is kept when given", () => {
    const { construct, stack } = hosting();
    assert.equal(construct.viewCertificate, viewCertificate(stack));
  });

  it("is created for the apex and the wildcard in a us-east-1 stack without one", () => {
    const stack = inRegion("us-east-1");
    const construct = withCertificate(stack);
    const created = resources(
      Template.fromStack(stack),
      "AWS::CertificateManager::Certificate",
    ).filter(([id]) => id.startsWith("ArtifactsViewCertificate"));
    assert.equal(created.length, 1);
    const [[id, certificate]] = created;
    assert.equal(certificate.Properties?.DomainName, VIEW);
    assert.deepEqual(certificate.Properties?.SubjectAlternativeNames, [`*.${VIEW}`]);
    assert.equal(certificate.Properties?.ValidationMethod, "DNS");
    assert.deepEqual(stack.resolve(construct.viewCertificate.certificateArn), { Ref: id });
  });
});

describe("viewing", () => {
  const viewing = (v: ArtifactHostingProps["viewing"]) => build((p) => ({ ...p, viewing: v }));

  it("accepts the defaults, no cap, a cap with provisioned instances and a rotation label", () => {
    viewing(undefined);
    viewing({ reservedConcurrency: false, provisionedConcurrency: 3 });
    viewing({ reservedConcurrency: 1000, provisionedConcurrency: 1000 });
    viewing({ reservedConcurrency: 1, sessionKeyRotation: "2026-10-21.a_B" });
    viewing({ sessionKeyRotation: "x".repeat(64) });
  });

  it("rejects bad reserved and provisioned concurrency and rotation labels", () => {
    for (const reservedConcurrency of [0, 1001, 1.5, -1, true as unknown as number]) {
      assert.throws(
        () => viewing({ reservedConcurrency }),
        /^Error: viewing.reservedConcurrency must be an integer from 1 to 1000, or false$/,
        String(reservedConcurrency),
      );
    }
    for (const provisionedConcurrency of [0, 1.5, -1]) {
      assert.throws(
        () => viewing({ provisionedConcurrency }),
        /^Error: viewing.provisionedConcurrency must be a positive integer$/,
      );
    }
    assert.throws(
      () => viewing({ provisionedConcurrency: 21 }),
      /^Error: viewing.provisionedConcurrency must not exceed viewing.reservedConcurrency \(20\)$/,
    );
    for (const sessionKeyRotation of ["", "a b", "x".repeat(65), "ä"]) {
      assert.throws(
        () => viewing({ sessionKeyRotation }),
        /^Error: viewing.sessionKeyRotation must be 1 to 64 of \[A-Za-z0-9._-\]$/,
      );
    }
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
      viewDomain: { name: `two.${VIEW}`, hostedZone: zone, certificate: viewCertificate(stack) },
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
