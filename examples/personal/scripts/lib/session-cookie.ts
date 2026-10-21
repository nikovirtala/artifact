// Session cookies minted by the smoke and latency scripts from the session secret
// (docs/decisions/0078, 0086). An independent copy of the format, held to the same shared vectors
// (test/fixtures/session-vectors.json) as the Lambda and the edge, so a minted cookie is exactly
// what the viewing Lambda would sign. Keys and cookies are secrets: callers register them with
// `checks.secret()`, and no error here ever contains one.
import { createHmac, randomBytes } from "node:crypto";
import { InputError } from "./cli.ts";

export const SESSION_COOKIE = "__Secure-artifact_session";
export const TRANSACTION_COOKIE = "__Host-artifact_login";

export type SessionPayload = { sub: string; email: string; iat: number; exp: number };
/** The session secret: `kid` → key, the signing `kid`, and the other (previous) one if any. */
export type SessionSecret = {
  current: string;
  keys: Record<string, string>;
  previous: string | undefined;
};

const KID = /^[0-9a-f]{16}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

/** Parses the `SessionSecret` value; a malformed or still-empty set is bad input (exit 2). */
export function parseSessionSecret(text: string): SessionSecret {
  const malformed = (field: string) =>
    new InputError(`the session secret is not a usable key set: ${field}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed("not JSON");
  }
  const set = value as { version?: unknown; current?: unknown; keys?: unknown };
  if (typeof set !== "object" || set === null || set.version !== 1) throw malformed("version");
  if (typeof set.keys !== "object" || set.keys === null) throw malformed("keys");
  const keys: Record<string, string> = {};
  for (const [kid, entry] of Object.entries(set.keys)) {
    const key = (entry as { key?: unknown } | null)?.key;
    if (!KID.test(kid)) throw malformed("kid");
    if (typeof key !== "string" || !KEY.test(key)) throw malformed("key");
    keys[kid] = key;
  }
  const { current } = set;
  if (typeof current !== "string" || !Object.hasOwn(keys, current)) {
    throw malformed("current (no keys yet: is the stack deployed?)");
  }
  return { current, keys, previous: Object.keys(keys).find((kid) => kid !== current) };
}

const hmac = (key: string, input: string) =>
  createHmac("sha256", key).update(input).digest("base64url");

/** `v1.<kid>.<payload>.<sig>`, signed with the key string itself (as the edge verifies it). */
export function mintSession(key: string, kid: string, p: SessionPayload): string {
  const json = JSON.stringify({ sub: p.sub, email: p.email, iat: p.iat, exp: p.exp });
  const input = `v1.${kid}.${Buffer.from(json, "utf8").toString("base64url")}`;
  return `${input}.${hmac(key, input)}`;
}

/** The dot-separated segments of a `v1`/`t1` cookie value, for the leak needles. */
export function cookieSegments(cookie: string): {
  kid: string;
  payload: string;
  signature: string;
} {
  const parts = cookie.split(".");
  if (parts.length !== 4) throw new TypeError("not a four-segment cookie");
  return { kid: parts[1], payload: parts[2], signature: parts[3] };
}

/** The JSON payload of a `v1`/`t1` cookie (not secret to its holder), else `undefined`. */
export function decodePayload(cookie: string): Record<string, unknown> | undefined {
  const payload = cookie.split(".")[2];
  if (payload === undefined || !/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export const randomKid = () => randomBytes(8).toString("hex");
export const randomKey = () => randomBytes(32).toString("base64url");
