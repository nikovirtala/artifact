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
