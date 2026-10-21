// The typed stage config of the reference deployment (docs/decisions/0075). Owners and the
// alarm address come from the environment, so no email is ever committed.

import type { ArtifactLimits, ArtifactViewing } from "@nikovirtala/artifact/cdk";
import type { Duration, RemovalPolicy } from "aws-cdk-lib";
import type { RetentionDays } from "aws-cdk-lib/aws-logs";

export type StageConfig = {
  /** Stack names and the stage id derive from it: `artifact-<name>-dns`, … */
  name: string;
  account: string;
  /** Where the platform (API, functions, bucket) runs. */
  region: string;
  /** CloudFront takes certificates from us-east-1 only; the DNS stack lives there too. */
  certificateRegion: "us-east-1";
  viewDomain: string;
  apiDomain: string;
  /** What `cdk destroy` does with the bucket. */
  removalPolicy: RemovalPolicy;
  versions?: { keepLast?: number; olderThan?: Duration };
  logRetention?: RetentionDays;
  limits?: ArtifactLimits;
  /** Viewing concurrency and the session-key rotation label (rotate: change it and deploy). */
  viewing?: ArtifactViewing;
};

/** `ARTIFACT_OWNERS`: comma-separated owner emails, required for any synth of the app. */
export function ownersFromEnv(env: Record<string, string | undefined>): string[] {
  const owners = (env.ARTIFACT_OWNERS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
  if (owners.length === 0)
    throw new Error("set ARTIFACT_OWNERS to the owner email(s), comma-separated");
  return owners;
}
