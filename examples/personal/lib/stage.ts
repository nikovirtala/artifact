// One deployment stage (docs/decisions/0075): the DNS and certificate stacks in us-east-1, the
// platform in the stage's Region. Cross-Region references flow one way, us-east-1 → platform.
import { Stage, type StageProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { CertificateStack } from "./certificate-stack.ts";
import type { StageConfig } from "./config.ts";
import { DnsStack } from "./dns-stack.ts";
import { PlatformStack } from "./platform-stack.ts";

export type ArtifactStageProps = StageProps & {
  config: StageConfig;
  owners: string[];
  alarmEmail?: string;
};

export class ArtifactStage extends Stage {
  readonly dns: DnsStack;
  readonly certificate: CertificateStack;
  readonly platform: PlatformStack;

  constructor(scope: Construct, props: ArtifactStageProps) {
    const { config } = props;
    super(scope, config.name, {
      ...props,
      env: { account: config.account, region: config.region },
    });
    const stackName = (part: string) => `artifact-${config.name}-${part}`;
    const certificateEnv = { account: config.account, region: config.certificateRegion };
    this.dns = new DnsStack(this, "Dns", {
      stackName: stackName("dns"),
      env: certificateEnv,
      crossRegionReferences: true,
      zoneName: config.viewDomain,
    });
    this.certificate = new CertificateStack(this, "Certificate", {
      stackName: stackName("certificate"),
      env: certificateEnv,
      crossRegionReferences: true,
      viewDomain: config.viewDomain,
      hostedZone: this.dns.zone,
    });
    this.platform = new PlatformStack(this, "Platform", {
      stackName: stackName("platform"),
      env: { account: config.account, region: config.region },
      crossRegionReferences: true,
      config,
      hostedZone: this.dns.zone,
      viewCertificate: this.certificate.certificate,
      owners: props.owners,
      alarmEmail: props.alarmEmail,
    });
  }
}
