// The API token list of an AWS deployment (docs/decisions/0065): one Secrets Manager secret
// holding SHA-256 hashes, never the tokens. Shared by `artifact token` and the control Lambda;
// no AWS imports, so the v1 package can carry it.
import { createHash, randomBytes } from "node:crypto";

export type TokenEntry = { name: string; sha256: string; createdAt: string };
export type TokenSecret = { version: 1; tokens: TokenEntry[] };

export const MAX_TOKENS = 100;
export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse and validate the secret string; a `TypeError` that never quotes the text otherwise. */
export function parseTokenSecret(text: string): TokenSecret {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("token secret is not valid JSON");
  }
  if (!isObject(value)) throw new TypeError("token secret is not a JSON object");
  if (value.version !== 1) throw new TypeError("token secret version must be 1");
  const { tokens } = value;
  if (!Array.isArray(tokens)) throw new TypeError("token secret tokens must be an array");
  if (tokens.length > MAX_TOKENS) {
    throw new TypeError(`token secret holds more than ${MAX_TOKENS} tokens`);
  }
  const names = new Set<string>();
  const parsed = tokens.map((token, i): TokenEntry => {
    if (!isObject(token)) throw new TypeError(`token ${i} is not an object`);
    const { name, sha256, createdAt } = token;
    if (typeof name !== "string" || !TOKEN_NAME.test(name)) {
      throw new TypeError(`token ${i} has an invalid name`);
    }
    if (names.has(name)) throw new TypeError(`token ${i} repeats a name`);
    names.add(name);
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
      throw new TypeError(`token ${i} has an invalid sha256`);
    }
    if (typeof createdAt !== "string") throw new TypeError(`token ${i} has an invalid createdAt`);
    return { name, sha256, createdAt };
  });
  return { version: 1, tokens: parsed };
}

export function serializeTokenSecret(secret: TokenSecret): string {
  return JSON.stringify({ version: 1, tokens: secret.tokens });
}

/** SHA-256 of the token as lowercase hex: what the secret stores. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** `art_` + 32 random bytes as base64url (43 characters). */
export function newToken(): string {
  return `art_${randomBytes(32).toString("base64url")}`;
}
