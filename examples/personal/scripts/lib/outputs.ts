// Stack outputs of `ArtifactHosting`, matched by `<constructId><Name><8 hex>` (docs/decisions/0071).
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { InputError } from "./cli.ts";

export const OUTPUT_NAMES = [
  "ApiUrl",
  "ViewUrl",
  "TokenSecretArn",
  "BucketName",
  "ControlLogGroupName",
  "AccessLogGroupName",
  "SweepFunctionName",
  "PruneScheduleName",
  "DistributionId",
  "DistributionDomainName",
  "ViewFunctionUrl",
  "ViewLogGroupName",
  "ViewerRequestFunctionName",
  "KeyValueStoreArn",
  "SessionSecretArn",
  "SessionKeysLogGroupName",
  "UserPoolId",
  "UserPoolClientId",
  "LoginDomainUrl",
] as const;
export type OutputName = (typeof OUTPUT_NAMES)[number];

export type StackOutput = { OutputKey?: string; OutputValue?: string };

/** Exactly one output per needed name, else an `InputError` (exit 2) naming the missing ones. */
export function matchOutputs<N extends OutputName>(
  outputs: readonly StackOutput[],
  constructId: string,
  needed: readonly N[],
): Record<N, string> {
  const found = {} as Record<N, string>;
  const missing: string[] = [];
  for (const name of needed) {
    const pattern = new RegExp(`^${constructId}${name}[0-9A-F]{8}$`);
    const matches = outputs.filter((o) => pattern.test(o.OutputKey ?? "") && o.OutputValue);
    if (matches.length === 1) found[name] = matches[0].OutputValue as string;
    else missing.push(`${constructId}${name}`);
  }
  if (missing.length > 0) {
    throw new InputError(`the stack has no single output ${missing.join(", ")}`);
  }
  return found;
}

/** All outputs of `stackName`; a missing stack is an `InputError`. */
export async function stackOutputs(region: string, stackName: string): Promise<StackOutput[]> {
  const client = new CloudFormationClient({ region });
  try {
    const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    return Stacks?.[0]?.Outputs ?? [];
  } catch (error) {
    const { name, message } = error as Error;
    if (name === "ValidationError")
      throw new InputError(`stack ${stackName} in ${region}: ${message}`);
    throw error;
  }
}
