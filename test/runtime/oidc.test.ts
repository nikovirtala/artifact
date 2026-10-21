// The OIDC client of the login routes (docs/decisions/0081): authorize URL and PKCE, the token
// exchange, the JWKS cache and ID-token verification, against a local RSA key, a fake fetch and
// a fake clock. Every claim failure has its own denial reason.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, it } from "node:test";
import {
  authorizeUrl,
  createJwksCache,
  exchangeCode,
  JwksError,
  type OidcConfig,
  pkceChallenge,
  randomToken,
  verifyIdToken,
} from "../../src/runtime/auth/oidc.ts";

const ISSUER = "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Test";
const CONFIG: OidcConfig = {
  issuer: ISSUER,
  clientId: "client123",
  authorizeUrl: "https://login.auth.eu-north-1.amazoncognito.com/oauth2/authorize",
  tokenUrl: "https://login.auth.eu-north-1.amazoncognito.com/oauth2/token",
  logoutUrl: "https://login.auth.eu-north-1.amazoncognito.com/logout",
  redirectUri: "https://art.example.dev/__artifact/callback",
  scopes: ["openid", "email"],
};
const OWNER = "owner@example.com";
const NONCE = "n".repeat(43);
const NOW = 1_790_000_000;

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_1 = rsa();
const KEY_2 = rsa();

const jwk = (key: KeyObject, kid: string, extra: Record<string, unknown> = {}) => ({
  ...key.export({ format: "jwk" }),
  kid,
  use: "sig",
  alg: "RS256",
  ...extra,
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function idToken(
  claims: Record<string, unknown> = {},
  options: { header?: Record<string, unknown>; key?: KeyObject } = {},
): string {
  const header = options.header ?? { alg: "RS256", kid: "k1", typ: "JWT" };
  const payload = {
    sub: "sub-1",
    iss: ISSUER,
    aud: CONFIG.clientId,
    token_use: "id",
    exp: NOW + 3600,
    iat: NOW,
    nonce: NONCE,
    email: OWNER,
    email_verified: true,
    ...claims,
  };
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = sign("sha256", Buffer.from(input), options.key ?? KEY_1.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

type Call = { url: string; init?: RequestInit };

/** A fetch that answers from `routes` (URL → response factory) and records every call. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    const route = routes[href];
    if (route === undefined) throw new TypeError(`fetch failed: ${href}`);
    return route(init);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const jwksResponse =
  (...keys: object[]) =>
  () =>
    Response.json({ keys });

function clock(start = NOW * 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function verifier(fetch: typeof globalThis.fetch, now = () => NOW * 1000) {
  const jwks = createJwksCache({ issuer: ISSUER, fetch, now });
  return (token: string, nonce = NONCE) =>
    verifyIdToken(token, {
      jwks,
      issuer: ISSUER,
      clientId: CONFIG.clientId,
      nonce,
      owners: [OWNER],
      nowSeconds: NOW,
    });
}

describe("authorize URL and PKCE", () => {
  it("builds the code + S256 request with every parameter encoded", () => {
    const url = authorizeUrl(CONFIG, { state: "st", nonce: "no", challenge: "ch" });
    assert.equal(
      url,
      `${CONFIG.authorizeUrl}?response_type=code&client_id=client123` +
        "&redirect_uri=https%3A%2F%2Fart.example.dev%2F__artifact%2Fcallback" +
        "&scope=openid%20email&state=st&nonce=no&code_challenge=ch&code_challenge_method=S256",
    );
  });

  it("derives the challenge as base64url(sha256(verifier)) (RFC 7636 appendix B)", () => {
    assert.equal(
      pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const v = randomToken();
    assert.equal(pkceChallenge(v), createHash("sha256").update(v).digest("base64url"));
  });

  it("makes 43-character base64url tokens from 32 random bytes", () => {
    const a = randomToken();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, randomToken());
  });
});

describe("exchangeCode", () => {
  const input = { code: "the-code", verifier: "the-verifier" };

  it("posts the form and returns the id_token", async () => {
    const token = idToken();
    const { fetch, calls } = fakeFetch({
      [CONFIG.tokenUrl]: () => Response.json({ id_token: token, access_token: "a" }),
    });
    assert.deepEqual(await exchangeCode(CONFIG, input, { fetch }), { ok: true, idToken: token });
    assert.equal(calls.length, 1);
    const { init } = calls[0];
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("content-type"),
      "application/x-www-form-urlencoded",
    );
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), {
      grant_type: "authorization_code",
      client_id: "client123",
      code: "the-code",
      redirect_uri: CONFIG.redirectUri,
      code_verifier: "the-verifier",
    });
  });

  it("fails with the status on non-2xx, non-JSON, no or oversized id_token", async () => {
    const cases: [() => Response, number][] = [
      [() => Response.json({ error: "invalid_grant" }, { status: 400 }), 400],
      [() => new Response("oops", { status: 500 }), 500],
      [() => new Response("not json", { status: 200 }), 200],
      [() => Response.json({ access_token: "a" }), 200],
      [() => Response.json({ id_token: 42 }), 200],
      [() => Response.json({ id_token: "x".repeat(16 * 1024 + 1) }), 200],
      [() => Response.json(["id_token"]), 200],
    ];
    for (const [respond, status] of cases) {
      const { fetch } = fakeFetch({ [CONFIG.tokenUrl]: respond });
      assert.deepEqual(await exchangeCode(CONFIG, input, { fetch }), { ok: false, status });
    }
  });

  it("accepts an id_token of exactly 16 KB", async () => {
    const token = "x".repeat(16 * 1024);
    const { fetch } = fakeFetch({ [CONFIG.tokenUrl]: () => Response.json({ id_token: token }) });
    assert.deepEqual(await exchangeCode(CONFIG, input, { fetch }), { ok: true, idToken: token });
  });

  it("fails with status 0 on a network error and on a timeout", async () => {
    const { fetch } = fakeFetch({});
    assert.deepEqual(await exchangeCode(CONFIG, input, { fetch }), { ok: false, status: 0 });
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    const started = Date.now();
    assert.deepEqual(await exchangeCode(CONFIG, input, { fetch: hanging, timeoutMs: 20 }), {
      ok: false,
      status: 0,
    });
    assert.ok(Date.now() - started < 2000);
  });
});

describe("JWKS cache", () => {
  it("fetches lazily once and keeps RSA signing keys only", async () => {
    const { fetch, calls } = fakeFetch({
      [JWKS_URL]: jwksResponse(
        jwk(KEY_1.publicKey, "k1"),
        jwk(KEY_2.publicKey, "enc", { use: "enc" }),
        { kty: "EC", kid: "ec", crv: "P-256", x: "AA", y: "AA" },
        { kty: "RSA", kid: "broken", n: 5, e: "AQAB" },
        { kty: "RSA", n: "AA", e: "AQAB" },
      ),
    });
    const jwks = createJwksCache({ issuer: ISSUER, fetch, now: () => 0 });
    assert.equal(calls.length, 0);
    assert.ok(await jwks.key("k1"));
    assert.ok(await jwks.key("k1"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, JWKS_URL);
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
    assert.equal(await jwks.key("enc"), undefined);
    assert.equal(await jwks.key("ec"), undefined);
    assert.equal(await jwks.key("broken"), undefined);
  });

  it("refetches on an unknown kid at most once per 60 s and after 24 h", async () => {
    let keys = [jwk(KEY_1.publicKey, "k1")];
    const { fetch, calls } = fakeFetch({ [JWKS_URL]: () => Response.json({ keys }) });
    const c = clock();
    const jwks = createJwksCache({ issuer: ISSUER, fetch, now: c.now });
    assert.ok(await jwks.key("k1"));
    assert.equal(await jwks.key("k2"), undefined);
    assert.equal(calls.length, 2);
    keys = [jwk(KEY_1.publicKey, "k1"), jwk(KEY_2.publicKey, "k2")];
    c.advance(59_999);
    assert.equal(await jwks.key("k2"), undefined);
    assert.equal(calls.length, 2);
    c.advance(1);
    assert.ok(await jwks.key("k2"));
    assert.equal(calls.length, 3);
    c.advance(24 * 3600 * 1000 - 1);
    assert.ok(await jwks.key("k1"));
    assert.equal(calls.length, 3);
    c.advance(1);
    assert.ok(await jwks.key("k1"));
    assert.equal(calls.length, 4);
  });

  it("is single-flight and caches no failure", async () => {
    let fail = true;
    const { fetch, calls } = fakeFetch({
      [JWKS_URL]: async () => {
        await new Promise((r) => setImmediate(r));
        return fail
          ? new Response("no", { status: 503 })
          : jwksResponse(jwk(KEY_1.publicKey, "k1"))();
      },
    });
    const jwks = createJwksCache({ issuer: ISSUER, fetch, now: () => 0 });
    const results = await Promise.allSettled([jwks.key("k1"), jwks.key("k1"), jwks.key("k1")]);
    assert.equal(calls.length, 1);
    for (const r of results) {
      assert.equal(r.status, "rejected");
      assert.ok((r as PromiseRejectedResult).reason instanceof JwksError);
    }
    fail = false;
    assert.ok(await jwks.key("k1"));
    assert.equal(calls.length, 2);
  });

  it("fails with JwksError on a network error, non-JSON or no keys array", async () => {
    for (const respond of [
      undefined,
      () => new Response("x"),
      () => Response.json({ keys: "nope" }),
      () => Response.json([]),
    ]) {
      const { fetch } = fakeFetch(respond === undefined ? {} : { [JWKS_URL]: respond });
      const jwks = createJwksCache({ issuer: ISSUER, fetch, now: () => 0 });
      await assert.rejects(jwks.key("k1"), JwksError);
    }
  });
});

describe("verifyIdToken", () => {
  const jwks = () => fakeFetch({ [JWKS_URL]: jwksResponse(jwk(KEY_1.publicKey, "k1")) });

  it("accepts a valid token and returns sub and the lowercased email", async () => {
    const verify = verifier(jwks().fetch);
    assert.deepEqual(await verify(idToken()), {
      ok: true,
      claims: { sub: "sub-1", email: OWNER },
    });
    assert.deepEqual(await verify(idToken({ email: "Owner@Example.COM" })), {
      ok: true,
      claims: { sub: "sub-1", email: OWNER },
    });
    for (const claims of [
      { aud: ["other", CONFIG.clientId] },
      { email_verified: "true" },
      { exp: NOW - 59 },
      { iat: NOW + 60 },
    ]) {
      assert.equal((await verify(idToken(claims))).ok, true, JSON.stringify(claims));
    }
  });

  it("gives each claim failure its own reason", async () => {
    const verify = verifier(jwks().fetch);
    const cases: [Record<string, unknown>, string][] = [
      [{ iss: "https://cognito-idp.eu-north-1.amazonaws.com/other" }, "iss"],
      [{ iss: undefined }, "iss"],
      [{ aud: "other" }, "aud"],
      [{ aud: ["other"] }, "aud"],
      [{ aud: undefined }, "aud"],
      [{ token_use: "access" }, "token_use"],
      [{ exp: NOW - 60 }, "exp"],
      [{ exp: "9999999999" }, "exp"],
      [{ exp: undefined }, "exp"],
      [{ iat: NOW + 61 }, "iat"],
      [{ iat: undefined }, "iat"],
      [{ nonce: "other" }, "nonce"],
      [{ nonce: undefined }, "nonce"],
      [{ email_verified: false }, "email_verified"],
      [{ email_verified: "false" }, "email_verified"],
      [{ email_verified: undefined }, "email_verified"],
      [{ email: "stranger@example.com" }, "not_owner"],
      [{ email: undefined }, "not_owner"],
      [{ email: ["owner@example.com"] }, "not_owner"],
      [{ sub: undefined }, "sub"],
      [{ sub: "" }, "sub"],
    ];
    for (const [claims, reason] of cases) {
      assert.deepEqual(
        await verify(idToken(claims)),
        { ok: false, reason },
        JSON.stringify(claims),
      );
    }
  });

  it("refuses a bad shape, alg or signature with reason signature", async () => {
    const verify = verifier(jwks().fetch);
    const good = idToken();
    const [h, p, s] = good.split(".");
    const tampered = `${h}.${b64({ ...JSON.parse(Buffer.from(p, "base64url").toString()), email: "x@example.com" })}.${s}`;
    const cases = [
      "",
      "a.b",
      `${good}.x`,
      `${h}.${p}.`,
      `${h}.${p}.${s}=`,
      tampered,
      idToken({}, { key: KEY_2.privateKey }),
      idToken({}, { header: { alg: "HS256", kid: "k1" } }),
      idToken({}, { header: { alg: "none", kid: "k1" } }),
      idToken({}, { header: { alg: "RS256" } }),
      idToken({}, { header: { alg: "RS256", kid: 1 } }),
      `${Buffer.from("not json").toString("base64url")}.${p}.${s}`,
      idToken({}, { header: { alg: "RS256", kid: "unknown" } }),
    ];
    for (const token of cases) {
      assert.deepEqual(await verify(token), { ok: false, reason: "signature" }, token.slice(0, 40));
    }
  });

  it("refuses a validly signed payload that is not a JSON object", async () => {
    const verify = verifier(jwks().fetch);
    const header = b64({ alg: "RS256", kid: "k1" });
    for (const body of [b64([1]), b64("x"), Buffer.from("{").toString("base64url")]) {
      const input = `${header}.${body}`;
      const sig = sign("sha256", Buffer.from(input), KEY_1.privateKey).toString("base64url");
      assert.deepEqual(await verify(`${input}.${sig}`), { ok: false, reason: "signature" });
    }
  });

  it("refetches the JWKS once for a token with a new kid", async () => {
    let keys = [jwk(KEY_1.publicKey, "k1")];
    const { fetch, calls } = fakeFetch({ [JWKS_URL]: () => Response.json({ keys }) });
    const verify = verifier(fetch);
    assert.equal((await verify(idToken())).ok, true);
    keys = [jwk(KEY_1.publicKey, "k1"), jwk(KEY_2.publicKey, "k2")];
    const rotated = idToken({}, { header: { alg: "RS256", kid: "k2" }, key: KEY_2.privateKey });
    assert.equal((await verify(rotated)).ok, true);
    assert.equal(calls.length, 2);
  });

  it("reports a JWKS failure as reason jwks", async () => {
    const verify = verifier(
      fakeFetch({ [JWKS_URL]: () => new Response("", { status: 500 }) }).fetch,
    );
    assert.deepEqual(await verify(idToken()), { ok: false, reason: "jwks" });
  });
});
