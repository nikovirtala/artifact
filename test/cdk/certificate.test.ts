// The view certificate for CloudFront: apex + wildcard, DNS-validated, us-east-1 only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { ArtifactCertificate } from "../../src/cdk/index.ts";
import { ACCOUNT, createdZone, VIEW } from "./helpers.ts";

const inRegion = (region?: string) =>
  new Stack(new App(), "Cert", region ? { env: { account: ACCOUNT, region } } : {});

describe("ArtifactCertificate", () => {
  it("covers the view domain and its wildcard with DNS validation in us-east-1", () => {
    const stack = inRegion("us-east-1");
    const zone = createdZone(stack);
    const { certificate } = new ArtifactCertificate(stack, "View", {
      viewDomain: VIEW,
      hostedZone: zone,
    });
    assert.ok(certificate);
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: VIEW,
      SubjectAlternativeNames: [`*.${VIEW}`],
      ValidationMethod: "DNS",
      DomainValidationOptions: Match.arrayWith([
        Match.objectLike({ DomainName: VIEW, HostedZoneId: Match.anyValue() }),
      ]),
    });
  });

  it("throws in another Region and warns in an environment-agnostic stack", () => {
    const north = inRegion("eu-north-1");
    assert.throws(
      () =>
        new ArtifactCertificate(north, "View", {
          viewDomain: VIEW,
          hostedZone: createdZone(north),
        }),
      /must be in a us-east-1 stack \(CloudFront\), not eu-north-1/,
    );
    const agnostic = inRegion();
    new ArtifactCertificate(agnostic, "View", {
      viewDomain: VIEW,
      hostedZone: createdZone(agnostic),
    });
    Annotations.fromStack(agnostic).hasWarning(
      "/Cert/View",
      Match.stringLikeRegexp("CloudFront needs the certificate in us-east-1"),
    );
  });

  it("needs a zone that carries its name, holding the view domain", () => {
    const stack = inRegion("us-east-1");
    const byId = HostedZone.fromHostedZoneId(stack, "ById", "Z0000000000000000000");
    assert.throws(
      () => new ArtifactCertificate(stack, "A", { viewDomain: VIEW, hostedZone: byId }),
      /hostedZone must carry its zoneName/,
    );
    assert.throws(
      () =>
        new ArtifactCertificate(stack, "B", {
          viewDomain: "art.other.dev",
          hostedZone: createdZone(stack, "Z2"),
        }),
      /must be inside its hosted zone example.dev/,
    );
  });
});
