// The two files of a `cdk init` app that deploys `ArtifactHosting` from the tarball
// (docs/decisions/0074): pack-test (b3) synthesizes it offline as `init-app`, and the CloudShell
// guide deploys it as `tarball-app` (examples/personal/README.md, whose blocks must equal these).
// The zone comes from context (`-c zoneId=… -c zoneName=…`), so no domain is written here. The
// stack is in us-east-1, so the construct creates its own view certificate (docs/decisions/0085).
// It reserves no viewing concurrency: an account's us-east-1 limit can be 10, too small for any cap.

/** `tarball-app` → `TarballApp`. */
function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export type TarballAppFiles = {
  /** `bin/<name>.ts` */
  bin: { path: string; text: string };
  /** `lib/<name>-stack.ts` (under 20 lines of stack code) */
  stack: { path: string; text: string };
  /** The stack class name, also the stack id. */
  stackId: string;
};

export function tarballAppFiles(name: string): TarballAppFiles {
  const stackId = `${pascalCase(name)}Stack`;
  const bin = [
    "#!/usr/bin/env node",
    'import * as cdk from "aws-cdk-lib";',
    `import { ${stackId} } from "../lib/${name}-stack";`,
    "const app = new cdk.App();",
    `new ${stackId}(app, "${stackId}", { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" } });`,
    "",
  ].join("\n");
  const stack = [
    'import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";',
    'import { HostedZone } from "aws-cdk-lib/aws-route53";',
    'import type { Construct } from "constructs";',
    'import { ArtifactHosting, ArtifactIdentity } from "@nikovirtala/artifact/cdk";',
    `export class ${stackId} extends Stack {`,
    "  constructor(scope: Construct, id: string, props?: StackProps) {",
    "    super(scope, id, props);",
    '    const zoneName = this.node.getContext("zoneName");',
    '    const hostedZone = HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: this.node.getContext("zoneId"), zoneName });',
    '    new ArtifactHosting(this, "Artifacts", {',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated source has a template literal
    "      viewDomain: { name: `tarball.${zoneName}`, hostedZone },",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated source has a template literal
    "      apiDomain: { name: `api.tarball.${zoneName}` },",
    '      identity: ArtifactIdentity.cognito({ owners: (process.env.ARTIFACT_OWNERS ?? "").split(",") }),',
    "      dataRetention: { onDestroy: RemovalPolicy.DESTROY, versions: { keepLast: 2 } },",
    "      viewing: { reservedConcurrency: false },",
    "    });",
    "  }",
    "}",
    "",
  ].join("\n");
  return {
    bin: { path: `bin/${name}.ts`, text: bin },
    stack: { path: `lib/${name}-stack.ts`, text: stack },
    stackId,
  };
}
