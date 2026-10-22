// The OIDC client of the login routes (docs/decisions/0081): authorization code with PKCE (S256)
// against any issuer that publishes a JWKS, Cognito in the construct. The ID token is verified
// with node:crypto only: RS256 over the JWKS key named by the header's kid, then each claim, and
// every refusal has its own reason so the login log can say which check failed.
import { createHash, createPublicKey, type KeyObject, randomBytes, verify } from "node:crypto";

export type OidcConfig = {
  issuer: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Ends the IdP session; without it logout only clears the cookies. */
  logoutUrl?: string;
  redirectUri: string;
  scopes: readonly string[];
};

export type Fetch = typeof globalThis.fetch;

const TIMEOUT_MS = 5000;
const MAX_ID_TOKEN = 16 * 1024;
const JWKS_TTL_MS = 24 * 3600 * 1000;
const JWKS_MISS_REFETCH_MS = 60_000;
/** Clock skew allowed on `exp` and `iat`, in seconds. */
const SKEW_S = 60;

/** 32 random bytes, base64url: a `state`, `nonce` or PKCE verifier. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizeUrl(
  config: OidcConfig,
  request: { state: string; nonce: string; challenge: string },
): string {
  const params: [string, string][] = [
    ["response_type", "code"],
    ["client_id", config.clientId],
    ["redirect_uri", config.redirectUri],
    ["scope", config.scopes.join(" ")],
    ["state", request.state],
    ["nonce", request.nonce],
    ["code_challenge", request.challenge],
    ["code_challenge_method", "S256"],
  ];
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${config.authorizeUrl}?${query}`;
}

/** `status` is the token endpoint's HTTP status, or 0 for a network error or timeout. */
export type TokenResult = { ok: true; idToken: string } | { ok: false; status: number };

export async function exchangeCode(
  config: OidcConfig,
  grant: { code: string; verifier: string },
  options: { fetch: Fetch; timeoutMs?: number },
): Promise<TokenResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: grant.code,
    redirect_uri: config.redirectUri,
    code_verifier: grant.verifier,
  });
  let status = 0;
  try {
    const res = await options.fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    if (!res.ok) return { ok: false, status };
    const json: unknown = JSON.parse(text);
    const idToken = isObject(json) ? json.id_token : undefined;
    if (typeof idToken !== "string" || idToken.length > MAX_ID_TOKEN) return { ok: false, status };
    return { ok: true, idToken };
  } catch {
    return { ok: false, status };
  }
}

/** The JWKS could not be fetched or was not a key set; nothing was cached. */
export class JwksError extends Error {
  override name = "JwksError";
}

export type Jwks = {
  /** The RSA signing key `kid`, or `undefined`; rejects with `JwksError` if a fetch fails. */
  key(kid: string): Promise<KeyObject | undefined>;
};

/**
 * `<issuer>/.well-known/jwks.json`, fetched lazily and kept for 24 hours. An unknown `kid`
 * refetches at most once per 60 seconds (a rotated IdP key, without letting forged kids fetch on
 * every request). Fetches are single-flight; a failed fetch caches nothing.
 */
export function createJwksCache(options: {
  issuer: string;
  fetch: Fetch;
  now?: () => number;
  ttlMs?: number;
  missRefetchMs?: number;
  timeoutMs?: number;
}): Jwks {
  const { issuer, now = Date.now } = options;
  const ttlMs = options.ttlMs ?? JWKS_TTL_MS;
  const missRefetchMs = options.missRefetchMs ?? JWKS_MISS_REFETCH_MS;
  const url = `${issuer}/.well-known/jwks.json`;
  let cache: { keys: Map<string, KeyObject>; at: number } | undefined;
  let inFlight: Promise<Map<string, KeyObject>> | undefined;
  let lastMiss: number | undefined;

  const fetchKeys = async (): Promise<Map<string, KeyObject>> => {
    let json: unknown;
    try {
      const res = await options.fetch(url, {
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
      if (!res.ok) throw new JwksError(`jwks status ${res.status}`);
      json = await res.json();
    } catch (error) {
      if (error instanceof JwksError) throw error;
      throw new JwksError("jwks unavailable");
    }
    if (!isObject(json) || !Array.isArray(json.keys)) throw new JwksError("jwks malformed");
    const keys = new Map<string, KeyObject>();
    for (const jwk of json.keys) {
      if (!isObject(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
      } catch {
        // Not a usable RSA key; ignored.
      }
    }
    cache = { keys, at: now() };
    return keys;
  };

  const refresh = (): Promise<Map<string, KeyObject>> => {
    inFlight ??= fetchKeys().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    async key(kid) {
      let keys: Map<string, KeyObject>;
      let fresh = false;
      if (cache === undefined || now() - cache.at >= ttlMs) {
        keys = await refresh();
        fresh = true;
      } else {
        keys = cache.keys;
      }
      const found = keys.get(kid);
      if (found !== undefined || fresh) return found;
      if (lastMiss !== undefined && now() - lastMiss < missRefetchMs) return undefined;
      lastMiss = now();
      return (await refresh()).get(kid);
    },
  };
}

export type DenialReason =
  | "signature"
  | "jwks"
  | "iss"
  | "aud"
  | "token_use"
  | "sub"
  | "exp"
  | "iat"
  | "nonce"
  | "email_verified"
  | "not_owner";

export type IdTokenResult =
  | { ok: true; claims: { sub: string; email: string } }
  | { ok: false; reason: DenialReason };

const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Verifies an ID token: three base64url segments, header `alg` RS256 with a string `kid`, the
 * JWKS key, the RSA-SHA256 signature, then `iss`, `aud` (string or array), `token_use` id, `sub`,
 * `exp` and `iat` (60 s skew), `nonce`, `email_verified` and an `email` among `owners`.
 */
export async function verifyIdToken(
  token: string,
  options: {
    jwks: Jwks;
    issuer: string;
    clientId: string;
    nonce: string;
    /** Lowercase emails. */
    owners: readonly string[];
    nowSeconds: number;
  },
): Promise<IdTokenResult> {
  const deny = (reason: DenialReason): IdTokenResult => ({ ok: false, reason });
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return deny("signature");
  const header = decodeJson(parts[0]);
  if (!isObject(header) || header.alg !== "RS256" || typeof header.kid !== "string") {
    return deny("signature");
  }
  let key: KeyObject | undefined;
  try {
    key = await options.jwks.key(header.kid);
  } catch {
    return deny("jwks");
  }
  if (key === undefined) return deny("signature");
  const input = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!verify("sha256", input, key, Buffer.from(parts[2], "base64url"))) return deny("signature");
  const claims = decodeJson(parts[1]);
  if (!isObject(claims)) return deny("signature");

  const { aud, exp, iat, email } = claims;
  const now = options.nowSeconds;
  if (claims.iss !== options.issuer) return deny("iss");
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(options.clientId)) return deny("aud");
  if (claims.token_use !== "id") return deny("token_use");
  if (typeof claims.sub !== "string" || claims.sub === "") return deny("sub");
  if (typeof exp !== "number" || !(exp + SKEW_S > now)) return deny("exp");
  if (typeof iat !== "number" || !(iat <= now + SKEW_S)) return deny("iat");
  if (claims.nonce !== options.nonce) return deny("nonce");
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    return deny("email_verified");
  }
  if (typeof email !== "string" || !options.owners.includes(email.toLowerCase())) {
    return deny("not_owner");
  }
  return { ok: true, claims: { sub: claims.sub, email: email.toLowerCase() } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
