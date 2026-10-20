// The Lambda environment the construct writes (docs/decisions/0066, 0067). `src/runtime/env.ts`
// parses it; the two never import each other, and test/cdk/env-contract.test.ts feeds the
// synthesized environment through the runtime parser.
import type { ResolvedLimits } from "./validate.ts";

/** `ARTIFACT_LIMITS`: the core limits the functions enforce (all three, resolved). */
function limitsJson(limits: ResolvedLimits): string {
  const { maxFileBytes, maxPublishBytes, maxFiles } = limits;
  return JSON.stringify({ maxFileBytes, maxPublishBytes, maxFiles });
}

export function sweepEnvironment(options: {
  bucket: string;
  limits: ResolvedLimits;
}): Record<string, string> {
  return { ARTIFACT_BUCKET: options.bucket, ARTIFACT_LIMITS: limitsJson(options.limits) };
}

export function controlEnvironment(options: {
  bucket: string;
  viewDomain: string;
  tokenSecretArn: string;
  limits: ResolvedLimits;
}): Record<string, string> {
  return {
    ARTIFACT_BUCKET: options.bucket,
    ARTIFACT_VIEW_DOMAIN: options.viewDomain,
    ARTIFACT_TOKEN_SECRET_ARN: options.tokenSecretArn,
    ARTIFACT_LIMITS: limitsJson(options.limits),
    ARTIFACT_MAX_BODY_BYTES: String(options.limits.maxBodyBytes),
  };
}
