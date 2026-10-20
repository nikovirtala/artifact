// The platform: `ArtifactHosting` with the stage's domains, owners and retention.

import { ArtifactHosting, ArtifactIdentity } from "@nikovirtala/artifact/cdk";
import { Stack, type StackProps } from "aws-cdk-lib";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import type { IHostedZone } from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import type { StageConfig } from "./config.ts";

export type PlatformStackProps = StackProps & {
  config: StageConfig;
  hostedZone: IHostedZone;
  viewCertificate: ICertificate;
  owners: string[];
  alarmEmail?: string;
};

export class PlatformStack extends Stack {
  readonly artifacts: ArtifactHosting;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const { config } = props;
    this.artifacts = new ArtifactHosting(this, "Artifacts", {
      viewDomain: {
        name: config.viewDomain,
        hostedZone: props.hostedZone,
        certificate: props.viewCertificate,
      },
      apiDomain: { name: config.apiDomain },
      identity: ArtifactIdentity.cognito({ owners: props.owners }),
      dataRetention: { onDestroy: config.removalPolicy, versions: config.versions },
      logRetention: config.logRetention,
      limits: config.limits,
      alarmEmail: props.alarmEmail,
    });
  }
}
