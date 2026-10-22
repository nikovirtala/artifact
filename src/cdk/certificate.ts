// The view domain's certificate for CloudFront (M10): the apex plus `*.<viewDomain>`, validated
// through DNS. CloudFront takes certificates from us-east-1 only, so another resolved Region is
// an error and an environment-agnostic stack gets a warning.
import { Annotations, Stack, Token } from "aws-cdk-lib";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import type { IHostedZone } from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { checkInZone, domainName, zoneNameOf } from "./validate.ts";

/** CloudFront takes certificates from this Region only (internal; not re-exported). */
export const CLOUDFRONT_REGION = "us-east-1";

export interface ArtifactCertificateProps {
  /** The view domain, e.g. `artifact.example.com`. */
  readonly viewDomain: string;
  /** The zone that holds the view domain; the DNS validation records go here. */
  readonly hostedZone: IHostedZone;
}

export class ArtifactCertificate extends Construct {
  readonly certificate: Certificate;

  constructor(scope: Construct, id: string, props: ArtifactCertificateProps) {
    super(scope, id);
    const { region } = Stack.of(this);
    if (Token.isUnresolved(region)) {
      Annotations.of(this).addWarning(
        `CloudFront needs the certificate in ${CLOUDFRONT_REGION}; give this stack an explicit env`,
      );
    } else if (region !== CLOUDFRONT_REGION) {
      throw new Error(
        `ArtifactCertificate must be in a ${CLOUDFRONT_REGION} stack (CloudFront), not ${region}`,
      );
    }
    const viewDomain = domainName("viewDomain", props.viewDomain);
    checkInZone("viewDomain", viewDomain, zoneNameOf("hostedZone", props.hostedZone));
    this.certificate = new Certificate(this, "Certificate", {
      domainName: viewDomain,
      subjectAlternativeNames: [`*.${viewDomain}`],
      validation: CertificateValidation.fromDns(props.hostedZone),
    });
  }
}
