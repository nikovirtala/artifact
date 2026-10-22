// Session and login-transaction cookies (docs/decisions/0078). The key set lives in the session
// secret; the edge function verifies the same session cookie with the same key read from its
// KeyValueStore, so both sides use the 43-character key string itself as the HMAC key (the edge
// passes the KVS string straight to createHmac) and the same format, checked by one vector file.
import { createHmac } from "node:crypto";

export const SESSION_COOKIE = "__Secure-artifact_session";
export const TRANSACTION_COOKIE = "__Host-artifact_login";
/** Session lifetime: 30 days. */
export const SESSION_TTL_S = 2_592_000;
/** Login-transaction lifetime: 10 minutes. */
export const TRANSACTION_TTL_S = 600;

export type KeySet = {
  version: 1;
  /** `null` only for the empty set (the template's placeholder). */
  current: string | null;
  keys: Record<string, { key: string; rotation: string }>;
};

/** `kid` → HMAC key string. */
export type SessionKeys = Readonly<Record<string, string>>;

export type SessionPayload = { sub: string; email: string; iat: number; exp: number };
export type TransactionPayload = { s: string; n: string; v: string; r: string; exp: number };

const KID = /^[0-9a-f]{16}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const ROTATION = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_KEYS = 2;
const SESSION = /^v1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/;
const TRANSACTION = /^t1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/;
const TX_KEY_LABEL = "artifact login transaction v1";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses the session secret. Errors name the field only, never a value. */
export function parseKeySet(text: string): KeySet {
  const malformed = (field: string) => new TypeError(`malformed session key set: ${field}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed("not JSON");
  }
  if (!isObject(value)) throw malformed("not an object");
  if (value.version !== 1) throw malformed("version");
  if (!isObject(value.keys)) throw malformed("keys");
  const entries = Object.entries(value.keys);
  if (entries.length > MAX_KEYS) throw malformed("keys");
  const keys: KeySet["keys"] = {};
  for (const [kid, entry] of entries) {
    if (!KID.test(kid)) throw malformed("kid");
    if (!isObject(entry) || typeof entry.key !== "string" || !KEY.test(entry.key)) {
      throw malformed("key");
    }
    if (typeof entry.rotation !== "string" || !ROTATION.test(entry.rotation)) {
      throw malformed("rotation");
    }
    keys[kid] = { key: entry.key, rotation: entry.rotation };
  }
  const { current } = value;
  if (entries.length === 0 ? current !== null : typeof current !== "string" || !(current in keys)) {
    throw malformed("current");
  }
  return { version: 1, current: current as string | null, keys };
}

export function sessionKeys(set: KeySet): SessionKeys {
  return Object.fromEntries(Object.entries(set.keys).map(([kid, { key }]) => [kid, key]));
}

const hmac = (key: string, input: string) =>
  createHmac("sha256", key).update(input).digest("base64url");

/** Constant time for equal lengths: XOR over every character, no early exit. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The transaction key, derived from the session key so neither cookie verifies as the other. */
const txKey = (key: string) => hmac(key, TX_KEY_LABEL);

function keyFor(keys: SessionKeys, kid: string): string {
  const key = Object.hasOwn(keys, kid) ? keys[kid] : undefined;
  if (key === undefined) throw new TypeError("no session key for the kid");
  return key;
}

function sign(prefix: "v1" | "t1", key: string, kid: string, json: string): string {
  const input = `${prefix}.${kid}.${Buffer.from(json, "utf8").toString("base64url")}`;
  return `${input}.${hmac(key, input)}`;
}

/** The decoded payload of a well-formed, correctly signed cookie, or `null`. */
function open(
  format: RegExp,
  keys: SessionKeys,
  cookie: string,
  derive: (key: string) => string,
): { kid: string; payload: Record<string, unknown> } | null {
  const match = format.exec(cookie);
  if (match === null) return null;
  const [, kid, body, sig] = match;
  if (!Object.hasOwn(keys, kid)) return null;
  const input = cookie.slice(0, cookie.length - sig.length - 1);
  if (!equal(hmac(derive(keys[kid]), input), sig)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return isObject(payload) ? { kid, payload } : null;
}

const live = (exp: unknown, nowSeconds: number) =>
  Number.isInteger(exp) && (exp as number) > nowSeconds;

export function signSession(keys: SessionKeys, kid: string, p: SessionPayload): string {
  const json = JSON.stringify({ sub: p.sub, email: p.email, iat: p.iat, exp: p.exp });
  return sign("v1", keyFor(keys, kid), kid, json);
}

/**
 * Accepts exactly what the edge accepts: the format, a known `kid`, the signature and an integer
 * `exp` later than `nowSeconds`. The other claims are returned as they are, unchecked.
 */
export function verifySession(
  keys: SessionKeys,
  cookie: string,
  nowSeconds: number,
): { kid: string; claims: Record<string, unknown> } | null {
  const opened = open(SESSION, keys, cookie, (key) => key);
  if (opened === null || !live(opened.payload.exp, nowSeconds)) return null;
  return { kid: opened.kid, claims: opened.payload };
}

export function signTransaction(keys: SessionKeys, kid: string, t: TransactionPayload): string {
  const json = JSON.stringify({ s: t.s, n: t.n, v: t.v, r: t.r, exp: t.exp });
  return sign("t1", txKey(keyFor(keys, kid)), kid, json);
}

/** A transaction signed with any key of the set (current or previous) and not yet expired. */
export function verifyTransaction(
  keys: SessionKeys,
  cookie: string,
  nowSeconds: number,
): { kid: string; tx: TransactionPayload } | null {
  const opened = open(TRANSACTION, keys, cookie, txKey);
  if (opened === null) return null;
  const { s, n, v, r, exp } = opened.payload;
  const strings = [s, n, v, r].every((x) => typeof x === "string");
  if (!strings || !live(exp, nowSeconds)) return null;
  return { kid: opened.kid, tx: { s, n, v, r, exp } as TransactionPayload };
}
