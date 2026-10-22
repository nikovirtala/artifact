// Shared fixtures for the construct tests: a stack in a placeholder account with a created zone.
import { App, Stack, type StackProps } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Certificate, type ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone, type IHostedZone, PublicHostedZone } from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import {
  ArtifactHosting,
  type ArtifactHostingProps,
  ArtifactIdentity,
} from "../../src/cdk/index.ts";

export const ACCOUNT = "123456789012";
export const ZONE = "example.dev";
export const VIEW = `art.${ZONE}`;
export const API = `api.${VIEW}`;
export const OWNER = "owner@example.com";

export function testStack(
  app = new App(),
  id = "Test",
  props: StackProps = { env: { account: ACCOUNT, region: "eu-north-1" } },
) {
  return new Stack(app, id, props);
}

export function testZone(stack: Stack, id = "Zone"): IHostedZone {
  return HostedZone.fromHostedZoneAttributes(stack, id, {
    hostedZoneId: "Z0000000000000000000",
    zoneName: ZONE,
  });
}

export function createdZone(stack: Stack, id = "Zone"): IHostedZone {
  return new PublicHostedZone(stack, id, { zoneName: ZONE });
}

export const VIEW_CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000";

const viewCertificates = new WeakMap<Stack, ICertificate>();

/** An imported us-east-1 view certificate, one per stack, so baseProps can be called twice. */
export function viewCertificate(scope: Construct): ICertificate {
  const stack = Stack.of(scope);
  let certificate = viewCertificates.get(stack);
  if (certificate === undefined) {
    certificate = Certificate.fromCertificateArn(stack, "ViewCert", VIEW_CERTIFICATE_ARN);
    viewCertificates.set(stack, certificate);
  }
  return certificate;
}

export function baseProps(zone: IHostedZone, overrides: Partial<ArtifactHostingProps> = {}) {
  return {
    viewDomain: overrides.viewDomain ?? {
      name: VIEW,
      hostedZone: zone,
      certificate: viewCertificate(zone),
    },
    apiDomain: { name: API },
    identity: ArtifactIdentity.cognito({ owners: [OWNER] }),
    ...overrides,
  } satisfies ArtifactHostingProps;
}

/** One `ArtifactHosting` with id `Artifacts` in a fresh stack, and its template. */
export function hosting(overrides: Partial<ArtifactHostingProps> = {}, app = new App()) {
  const stack = testStack(app);
  const construct = new ArtifactHosting(stack, "Artifacts", baseProps(testZone(stack), overrides));
  return { app, stack, construct, template: Template.fromStack(stack) };
}

type Resource = { Type: string; Properties?: Record<string, unknown>; [k: string]: unknown };

export function resources(template: Template, type?: string): [string, Resource][] {
  const all = template.toJSON().Resources as Record<string, Resource>;
  return Object.entries(all).filter(([, r]) => type === undefined || r.Type === type);
}
