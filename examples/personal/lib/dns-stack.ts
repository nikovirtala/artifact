// The view domain's hosted zone (owner decision 3): the parent zone is in another account, so
// this stack creates the zone, keeps it on destroy, and prints the name servers to delegate to.
import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { PublicHostedZone } from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";

export class DnsStack extends Stack {
  readonly zone: PublicHostedZone;

  constructor(scope: Construct, id: string, props: StackProps & { zoneName: string }) {
    super(scope, id, props);
    this.zone = new PublicHostedZone(this, "Zone", { zoneName: props.zoneName });
    this.zone.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, "NameServers", {
      value: Fn.join(",", this.zone.hostedZoneNameServers ?? []),
      description: "Delegate the zone with an NS record of these servers in the parent zone",
    });
    new CfnOutput(this, "HostedZoneId", { value: this.zone.hostedZoneId });
  }
}
