// The view certificate for CloudFront (used from M10), in us-east-1 next to the zone.

import { ArtifactCertificate } from "@nikovirtala/artifact/cdk";
import { Stack, type StackProps } from "aws-cdk-lib";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import type { IHostedZone } from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";

export class CertificateStack extends Stack {
  readonly certificate: ICertificate;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { viewDomain: string; hostedZone: IHostedZone },
  ) {
    super(scope, id, props);
    this.certificate = new ArtifactCertificate(this, "ViewCertificate", {
      viewDomain: props.viewDomain,
      hostedZone: props.hostedZone,
    }).certificate;
  }
}
