// The Lambda environment (docs/decisions/0066, 0067): `src/cdk/env.ts` writes it, this module
// parses it at init. Errors name the variable and never echo the bucket or the ARN; an invalid
// environment fails the init, which is fatal until redeployed.
import { DomainHostPolicy } from "../http/host-policy.ts";

export type Env = Record<string, string | undefined>;

export type RuntimeLimits = { maxFileBytes: number; maxPublishBytes: number; maxFiles: number };

export type SweepEnv = { bucket: string; limits: RuntimeLimits };

export type ControlEnv = SweepEnv & {
  viewDomain: string;
  tokenSecretArn: string;
  maxBodyBytes: number;
};

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;
const LIMIT_KEYS = ["maxFileBytes", "maxPublishBytes", "maxFiles"] as const;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`artifact: ${name} is not set`);
  return value;
}

function positiveInteger(env: Env, name: string): number {
  const value = required(env, name);
  const n = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n)) {
    throw new Error(`artifact: ${name} must be a positive integer`);
  }
  return n;
}

function limits(env: Env): RuntimeLimits {
  const name = "ARTIFACT_LIMITS";
  const invalid = () =>
    new Error(
      `artifact: ${name} must be a JSON object with exactly ${LIMIT_KEYS.join(", ")} as positive integers`,
    );
  let value: unknown;
  try {
    value = JSON.parse(required(env, name));
  } catch (error) {
    if ((error as Error).message.startsWith("artifact:")) throw error;
    throw invalid();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== LIMIT_KEYS.length || !LIMIT_KEYS.every((k) => keys.includes(k))) {
    throw invalid();
  }
  for (const key of LIMIT_KEYS) {
    const n = record[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw invalid();
  }
  return record as RuntimeLimits;
}

export type ViewingEnv = {
  bucket: string;
  /** Lowercase. */
  viewDomain: string;
  sessionSecretArn: string;
  oidc: {
    issuer: string;
    authorizeUrl: string;
    tokenUrl: string;
    logoutUrl: string;
    clientId: string;
  };
  /** Lowercase emails. */
  owners: string[];
};

const CLIENT_ID = /^[A-Za-z0-9_+-]{1,128}$/;
const OWNER_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_OWNERS = 50;

function httpsUrl(env: Env, name: string): string {
  const value = required(env, name);
  let protocol = "";
  try {
    protocol = new URL(value).protocol;
  } catch {
    // Reported below.
  }
  if (protocol !== "https:") throw new Error(`artifact: ${name} must be an https URL`);
  return value;
}

function owners(env: Env): string[] {
  const name = "ARTIFACT_OWNERS";
  const invalid = () =>
    new Error(`artifact: ${name} must be a JSON array of 1 to ${MAX_OWNERS} lowercase emails`);
  let value: unknown;
  try {
    value = JSON.parse(required(env, name));
  } catch (error) {
    if ((error as Error).message.startsWith("artifact:")) throw error;
    throw invalid();
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OWNERS) throw invalid();
  for (const owner of value) {
    if (typeof owner !== "string" || owner !== owner.toLowerCase() || !OWNER_EMAIL.test(owner)) {
      throw invalid();
    }
  }
  return value as string[];
}

/** The viewing Lambda (docs/decisions/0082): read-only S3, the session secret and the OIDC client. */
export function parseViewingEnv(env: Env): ViewingEnv {
  const bucket = required(env, "ARTIFACT_BUCKET");
  const viewDomain = required(env, "ARTIFACT_VIEW_DOMAIN");
  try {
    new DomainHostPolicy({ viewDomain });
  } catch {
    throw new Error("artifact: ARTIFACT_VIEW_DOMAIN must be a bare domain name");
  }
  const sessionSecretArn = required(env, "ARTIFACT_SESSION_SECRET_ARN");
  if (!SECRET_ARN.test(sessionSecretArn)) {
    throw new Error("artifact: ARTIFACT_SESSION_SECRET_ARN must be a Secrets Manager secret ARN");
  }
  const oidc = {
    issuer: httpsUrl(env, "ARTIFACT_OIDC_ISSUER"),
    authorizeUrl: httpsUrl(env, "ARTIFACT_OIDC_AUTHORIZE_URL"),
    tokenUrl: httpsUrl(env, "ARTIFACT_OIDC_TOKEN_URL"),
    logoutUrl: httpsUrl(env, "ARTIFACT_OIDC_LOGOUT_URL"),
    clientId: required(env, "ARTIFACT_OIDC_CLIENT_ID"),
  };
  if (!CLIENT_ID.test(oidc.clientId)) {
    throw new Error("artifact: ARTIFACT_OIDC_CLIENT_ID must be 1 to 128 of [A-Za-z0-9_+-]");
  }
  return {
    bucket,
    viewDomain: viewDomain.toLowerCase(),
    sessionSecretArn,
    oidc,
    owners: owners(env),
  };
}

export function parseSweepEnv(env: Env): SweepEnv {
  return { bucket: required(env, "ARTIFACT_BUCKET"), limits: limits(env) };
}

export function parseControlEnv(env: Env): ControlEnv {
  const bucket = required(env, "ARTIFACT_BUCKET");
  const viewDomain = required(env, "ARTIFACT_VIEW_DOMAIN");
  try {
    new DomainHostPolicy({ viewDomain });
  } catch {
    throw new Error("artifact: ARTIFACT_VIEW_DOMAIN must be a bare domain name");
  }
  const tokenSecretArn = required(env, "ARTIFACT_TOKEN_SECRET_ARN");
  if (!SECRET_ARN.test(tokenSecretArn)) {
    throw new Error("artifact: ARTIFACT_TOKEN_SECRET_ARN must be a Secrets Manager secret ARN");
  }
  return {
    bucket,
    viewDomain,
    tokenSecretArn,
    limits: limits(env),
    maxBodyBytes: positiveInteger(env, "ARTIFACT_MAX_BODY_BYTES"),
  };
}
