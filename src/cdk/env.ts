// The Lambda environment the construct writes (docs/decisions/0066, 0067, 0082).
// `src/runtime/env.ts` parses it; the two never import each other, and
// test/cdk/env-contract.test.ts feeds the synthesized environment through the runtime parser.
import { Token } from "aws-cdk-lib";
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

/** Lambda allows 4 KB of environment in all; this leaves headroom. */
const MAX_VIEWING_ENVIRONMENT_BYTES = 3500;

/** The most a token value can resolve to, for the size check. */
const TOKEN_BOUNDS: Record<string, number> = {
  ARTIFACT_BUCKET: 63,
  ARTIFACT_SESSION_SECRET_ARN: 256,
  ARTIFACT_OIDC_CLIENT_ID: 128,
  // https://cognito-idp.<region>.amazonaws.com/<pool id>
  ARTIFACT_OIDC_ISSUER: 160,
  // https://<prefix ≤ 63>.auth.<region>.amazoncognito.com/oauth2/authorize is ≤ 140
  ARTIFACT_OIDC_AUTHORIZE_URL: 160,
  ARTIFACT_OIDC_TOKEN_URL: 160,
  ARTIFACT_OIDC_LOGOUT_URL: 160,
};

const bytes = (key: string, value: string): number => {
  if (!Token.isUnresolved(value)) return Buffer.byteLength(value, "utf8");
  const bound = TOKEN_BOUNDS[key];
  if (bound === undefined) throw new Error(`artifact: ${key} must not be a token`);
  return bound;
};

export function viewingEnvironment(options: {
  bucket: string;
  viewDomain: string;
  sessionSecretArn: string;
  oidc: {
    issuer: string;
    clientId: string;
    authorizeUrl: string;
    tokenUrl: string;
    logoutUrl: string;
  };
  owners: readonly string[];
}): Record<string, string> {
  const { oidc } = options;
  const environment: Record<string, string> = {
    ARTIFACT_BUCKET: options.bucket,
    ARTIFACT_VIEW_DOMAIN: options.viewDomain,
    ARTIFACT_SESSION_SECRET_ARN: options.sessionSecretArn,
    ARTIFACT_OIDC_ISSUER: oidc.issuer,
    ARTIFACT_OIDC_AUTHORIZE_URL: oidc.authorizeUrl,
    ARTIFACT_OIDC_TOKEN_URL: oidc.tokenUrl,
    ARTIFACT_OIDC_LOGOUT_URL: oidc.logoutUrl,
    ARTIFACT_OIDC_CLIENT_ID: oidc.clientId,
    ARTIFACT_OWNERS: JSON.stringify(options.owners),
  };
  const total = Object.entries(environment).reduce(
    (sum, [key, value]) => sum + key.length + bytes(key, value),
    0,
  );
  if (total > MAX_VIEWING_ENVIRONMENT_BYTES) {
    const owners = bytes("ARTIFACT_OWNERS", environment.ARTIFACT_OWNERS);
    throw new Error(
      `viewing environment exceeds ${MAX_VIEWING_ENVIRONMENT_BYTES} bytes (owners use ${owners}); use fewer owners or a shorter view domain`,
    );
  }
  return environment;
}
