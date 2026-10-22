// The login routes of the viewing Lambda (docs/decisions/0081) against a fake IdP: an injected
// fetch serves the token endpoint and the JWKS, ID tokens are RS256-signed with a test key, and
// the PKCE verifier is checked against the challenge of the authorize redirect.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { type AppEnv, hostGuard } from "../../src/http/guards.ts";
import { DomainHostPolicy } from "../../src/http/host-policy.ts";
import { notFound } from "../../src/http/viewing.ts";
import type { OidcConfig } from "../../src/runtime/auth/oidc.ts";
import {
  type KeySet,
  SESSION_COOKIE,
  sessionKeys,
  signTransaction,
  TRANSACTION_COOKIE,
  verifySession,
  verifyTransaction,
} from "../../src/runtime/auth/session.ts";
import { createKeyCache } from "../../src/runtime/auth/session-keys-loader.ts";
import { createLoginApp, LOGIN_PATHS } from "../../src/runtime/handlers/login.ts";

const VIEW = "art.example.dev";
const ID = "01m55g1mv87q1zb2gpj07jz10e";
const GALLERY = `https://${VIEW}/`;
const OWNER = "owner@example.com";
const ISSUER = "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Test";
const OIDC: OidcConfig = {
  issuer: ISSUER,
  clientId: "client123",
  authorizeUrl: "https://login.auth.eu-north-1.amazoncognito.com/oauth2/authorize",
  tokenUrl: "https://login.auth.eu-north-1.amazoncognito.com/oauth2/token",
  logoutUrl: "https://login.auth.eu-north-1.amazoncognito.com/logout",
  redirectUri: `https://${VIEW}/__artifact/callback`,
  scopes: ["openid", "email"],
};
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const KID_A = "0123456789abcdef";
const KID_C = "fedcba9876543210";
const KEY_A = "test-only-login-key-A-not-for-any-use-00000";
const KEY_C = "test-only-login-key-C-not-for-any-use-11111";
const START = 1_790_000_000_000;
const CODE = "code-0123.abc_~XYZ";

const SET_A: KeySet = {
  version: 1,
  current: KID_A,
  keys: { [KID_A]: { key: KEY_A, rotation: "a" } },
};
const SET_CA: KeySet = {
  version: 1,
  current: KID_C,
  keys: { [KID_C]: { key: KEY_C, rotation: "c" }, [KID_A]: { key: KEY_A, rotation: "a" } },
};

const IDP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

type Idp = {
  /** Set from the authorize redirect; the token endpoint checks the verifier against it. */
  challenge?: string;
  nonce?: string;
  claims: Record<string, unknown>;
  signer: typeof IDP_KEY.privateKey;
  token?: (body: URLSearchParams) => Response | Promise<Response>;
  jwks?: () => Response;
  calls: string[];
  tokenBodies: URLSearchParams[];
};

function idToken(idp: Idp): string {
  const payload = {
    sub: "sub-1",
    iss: ISSUER,
    aud: OIDC.clientId,
    token_use: "id",
    exp: START / 1000 + 3600,
    iat: START / 1000,
    nonce: idp.nonce,
    email: "Owner@Example.com",
    email_verified: true,
    ...idp.claims,
  };
  const input = `${b64({ alg: "RS256", kid: "idp-1" })}.${b64(payload)}`;
  return `${input}.${sign("sha256", Buffer.from(input), idp.signer).toString("base64url")}`;
}

function setup(options: { loads?: (KeySet | Error)[]; logoutUrl?: boolean } = {}) {
  let t = START;
  const loads = options.loads ?? [SET_A];
  const loader = { calls: 0 };
  const load = async () => {
    const next = loads[Math.min(loader.calls, loads.length - 1)];
    loader.calls++;
    if (next instanceof Error) throw next;
    return next;
  };
  const idp: Idp = { claims: {}, signer: IDP_KEY.privateKey, calls: [], tokenBodies: [] };
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    idp.calls.push(href);
    if (href === OIDC.tokenUrl) {
      const body = new URLSearchParams(String(init?.body));
      idp.tokenBodies.push(body);
      if (idp.token) return idp.token(body);
      const verifier = body.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (idp.challenge !== undefined && challenge !== idp.challenge) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ id_token: idToken(idp), access_token: "ACCESSTOKEN" });
    }
    if (href === JWKS_URL) {
      if (idp.jwks) return idp.jwks();
      const jwk = { ...IDP_KEY.publicKey.export({ format: "jwk" }), kid: "idp-1", use: "sig" };
      return Response.json({ keys: [jwk] });
    }
    throw new TypeError("fetch failed");
  }) as typeof globalThis.fetch;
  const hosts = new DomainHostPolicy({ viewDomain: VIEW });
  const keys = createKeyCache(load, { now: () => t });
  const oidc = options.logoutUrl === false ? { ...OIDC, logoutUrl: undefined } : OIDC;
  const app = new Hono<AppEnv>();
  app.notFound(() => notFound());
  app.use(hostGuard(hosts));
  app.route(
    "/",
    createLoginApp({ hosts, viewDomain: VIEW, keys, oidc, owners: [OWNER], fetch, now: () => t }),
  );
  return {
    app,
    idp,
    loader,
    keys,
    advance: (ms: number) => {
      t += ms;
    },
    nowSeconds: () => Math.floor(t / 1000),
  };
}

type Setup = ReturnType<typeof setup>;

const cookieValue = (header: string, name: string) =>
  header.startsWith(`${name}=`) ? header.slice(name.length + 1).split(";", 1)[0] : undefined;

async function startLogin(s: Setup, ret?: string) {
  const query = ret === undefined ? "" : `?return=${encodeURIComponent(ret)}`;
  const res = await s.app.request(`https://${VIEW}/__artifact/login${query}`);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location") ?? "");
  const setCookies = res.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  const tx = cookieValue(setCookies[0], TRANSACTION_COOKIE);
  assert.ok(tx);
  const state = location.searchParams.get("state") ?? "";
  s.idp.nonce = location.searchParams.get("nonce") ?? "";
  s.idp.challenge = location.searchParams.get("code_challenge") ?? "";
  return { res, location, setCookie: setCookies[0], tx, state };
}

async function callback(
  s: Setup,
  options: { tx?: string; state?: string; code?: string; extra?: string; host?: string } = {},
) {
  const params = new URLSearchParams();
  if (options.code !== undefined) params.set("code", options.code);
  if (options.state !== undefined) params.set("state", options.state);
  const query = [params.toString(), options.extra].filter(Boolean).join("&");
  return s.app.request(`https://${options.host ?? VIEW}/__artifact/callback?${query}`, {
    headers: options.tx === undefined ? {} : { cookie: `${TRANSACTION_COOKIE}=${options.tx}` },
  });
}

/** Console output written while `fn` runs. */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const lines: string[] = [];
  const methods = ["log", "error", "warn", "info"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    return { value: await fn(), output: lines.join("\n") };
  } finally {
    methods.forEach((m, i) => {
      console[m] = originals[i];
    });
  }
}

const loginLines = (output: string) =>
  output
    .split("\n")
    .filter((l) => l.startsWith("artifact login "))
    .map((l) => JSON.parse(l.slice("artifact login ".length)));

async function signIn(s: Setup, ret?: string) {
  const started = await startLogin(s, ret);
  const res = await callback(s, { tx: started.tx, state: started.state, code: CODE });
  return { started, res };
}

describe("GET /__artifact/login", () => {
  it("redirects to the authorize endpoint with PKCE and sets the transaction cookie", async () => {
    const s = setup();
    const { res, location, setCookie, tx, state } = await startLogin(s, `https://${ID}.${VIEW}/p`);
    assert.equal(`${location.origin}${location.pathname}`, OIDC.authorizeUrl);
    const raw = res.headers.get("location") ?? "";
    assert.match(raw, /&redirect_uri=https%3A%2F%2Fart\.example\.dev%2F__artifact%2Fcallback&/);
    assert.match(raw, /&scope=openid%20email&/);
    assert.deepEqual(
      [...location.searchParams.keys()],
      [
        "response_type",
        "client_id",
        "redirect_uri",
        "scope",
        "state",
        "nonce",
        "code_challenge",
        "code_challenge_method",
      ],
    );
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("client_id"), "client123");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      setCookie,
      `${TRANSACTION_COOKIE}=${tx}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const opened = verifyTransaction(sessionKeys(SET_A), tx, s.nowSeconds());
    assert.ok(opened);
    assert.equal(opened.kid, KID_A);
    assert.equal(opened.tx.s, state);
    assert.equal(opened.tx.n, s.idp.nonce);
    assert.equal(createHash("sha256").update(opened.tx.v).digest("base64url"), s.idp.challenge);
    assert.equal(opened.tx.r, `https://${ID}.${VIEW}/p`);
    assert.equal(opened.tx.exp, s.nowSeconds() + 600);
    for (const v of [opened.tx.s, opened.tx.n, opened.tx.v]) assert.match(v, /^[\w-]{43}$/);
    assert.equal(s.idp.calls.length, 0);
  });

  it("stores the gallery for a missing, foreign or too long return", async () => {
    const s = setup();
    const r = async (ret?: string) => {
      const { tx } = await startLogin(s, ret);
      return verifyTransaction(sessionKeys(SET_A), tx, s.nowSeconds())?.tx.r;
    };
    assert.equal(await r(), GALLERY);
    assert.equal(await r("https://example.com/"), GALLERY);
    assert.equal(await r(`http://${ID}.${VIEW}/`), GALLERY);
    const base = `https://${ID}.${VIEW}/`;
    assert.equal(
      await r(base + "a".repeat(1024 - base.length)),
      base + "a".repeat(1024 - base.length),
    );
    assert.equal(await r(base + "a".repeat(1025 - base.length)), GALLERY);
  });

  it("answers 503 when the session keys cannot be read or are not provisioned", async () => {
    const failure = new Error("SECRETMESSAGE");
    failure.name = "AccessDeniedException";
    for (const [load, name] of [
      [failure, "AccessDeniedException"],
      [{ version: 1, current: null, keys: {} } as KeySet, undefined],
    ] as const) {
      const s = setup({ loads: [load] });
      const { value: res, output } = await capture(async () =>
        s.app.request(`https://${VIEW}/__artifact/login`),
      );
      assert.equal(res.status, 503);
      assert.match(await res.text(), /login is unavailable/);
      assert.deepEqual(res.headers.getSetCookie(), []);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(loginLines(output), [
        { result: "error", reason: "session_keys", ...(name ? { name } : {}) },
      ]);
      assert.ok(!output.includes("SECRETMESSAGE"));
    }
  });
});

describe("GET /__artifact/callback", () => {
  it("signs the owner in: session cookie, cleared transaction, 302 to the return", async () => {
    const s = setup();
    const { value, output } = await capture(() => signIn(s, `https://${ID}.${VIEW}/p?q=1`));
    const { res } = value;
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `https://${ID}.${VIEW}/p?q=1`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const [session, cleared] = res.headers.getSetCookie();
    const value1 = cookieValue(session, SESSION_COOKIE) ?? "";
    assert.equal(
      session,
      `${SESSION_COOKIE}=${value1}; Domain=${VIEW}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    );
    assert.equal(
      cleared,
      `${TRANSACTION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    const verified = verifySession(sessionKeys(SET_A), value1, s.nowSeconds());
    assert.ok(verified);
    assert.equal(verified.kid, KID_A);
    const now = s.nowSeconds();
    assert.deepEqual(verified.claims, {
      sub: "sub-1",
      email: OWNER,
      iat: now,
      exp: now + 2_592_000,
    });
    assert.deepEqual(loginLines(output), [{ result: "ok" }]);
    const [body] = s.idp.tokenBodies;
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), CODE);
    assert.equal(body.get("redirect_uri"), OIDC.redirectUri);
    assert.equal(body.get("client_id"), "client123");
  });

  it("round-trips a 1024-character return and sends 1500 or backslash-inflated ones to the gallery", async () => {
    const base = `https://${ID}.${VIEW}/`;
    const at1024 = base + "a".repeat(1024 - base.length);
    assert.equal((await signIn(setup(), at1024)).res.headers.get("location"), at1024);
    const at1500 = base + "a".repeat(1500 - base.length);
    assert.equal((await signIn(setup(), at1500)).res.headers.get("location"), GALLERY);
    const slashes = `${base}?${"\\".repeat(400)}`;
    const inflated = slashes + "a".repeat(700 - slashes.length);
    assert.equal(inflated.length, 700);
    assert.equal((await signIn(setup(), inflated)).res.headers.get("location"), GALLERY);
  });

  /** Asserts a failed callback: status, no session cookie, and one log line with `fields`. */
  async function refused(
    send: () => Promise<Response>,
    status: number,
    fields: Record<string, unknown>,
    text?: RegExp,
  ) {
    const { value: res, output } = await capture(send);
    assert.equal(res.status, status, JSON.stringify(fields));
    for (const c of res.headers.getSetCookie()) assert.ok(!c.startsWith(`${SESSION_COOKIE}=`));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'");
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const body = await res.text();
    if (text) assert.match(body, text);
    assert.deepEqual(loginLines(output), [fields]);
    return { res, body, output };
  }

  it("refuses an IdP error before any work", async () => {
    const s = setup();
    const { tx, state } = await startLogin(s);
    const { body } = await refused(
      () => callback(s, { tx, state, extra: "error=access_denied" }),
      400,
      { result: "denied", reason: "idp_error" },
      /sign-in did not complete/,
    );
    assert.match(body, /href="\/__artifact\/login"/);
    assert.equal(s.idp.calls.length, 0);
  });

  it("refuses a missing, malformed, tampered, foreign-kid or expired transaction cookie", async () => {
    const expired = /the sign-in expired; start again/;
    const denied = { result: "denied", reason: "transaction" };
    {
      const s = setup();
      const { tx, state } = await startLogin(s);
      const [p, kid, payload, sig] = tx.split(".");
      const flip = (c: string) => (c === "A" ? "B" : "A");
      for (const bad of [
        undefined,
        "",
        "garbage",
        `v1.${kid}.${payload}.${sig}`,
        `${p}.${kid}.${payload}x.${sig}`,
        `${p}.${kid}.${payload}.${flip(sig[0])}${sig.slice(1)}`,
      ]) {
        await refused(() => callback(s, { tx: bad, state, code: CODE }), 400, denied, expired);
      }
      s.advance(600_000);
      await refused(() => callback(s, { tx, state, code: CODE }), 400, denied, expired);
      assert.equal(s.idp.calls.length, 0);
    }
  });

  it("refuses a forged 2049-character transaction payload, correctly signed", async () => {
    const s = setup();
    const { state } = await startLogin(s);
    const r = "x".repeat(2049);
    const forged = signTransaction(sessionKeys(SET_A), KID_A, {
      s: state,
      n: "n",
      v: "v",
      r,
      exp: s.nowSeconds() + 600,
    });
    assert.ok(forged.split(".")[2].length > 2048);
    await refused(() => callback(s, { tx: forged, state, code: CODE }), 400, {
      result: "denied",
      reason: "transaction",
    });
  });

  it("refuses a missing or different state and a missing or malformed code", async () => {
    const s = setup();
    const { tx, state } = await startLogin(s);
    const other = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    for (const st of [undefined, "", other, `${state}x`]) {
      await refused(() => callback(s, { tx, state: st, code: CODE }), 400, {
        result: "denied",
        reason: "state",
      });
    }
    for (const code of [undefined, "", "a b", "a/b", "ä", "x".repeat(2049)]) {
      await refused(() => callback(s, { tx, state, code }), 400, {
        result: "denied",
        reason: "code",
      });
    }
    assert.equal(s.idp.calls.length, 0);
    assert.equal((await callback(s, { tx, state, code: "x".repeat(2048) })).status, 302);
  });

  it("answers 502 when the token endpoint fails", async () => {
    const cases: [Idp["token"] | "pkce", number][] = [
      [() => Response.json({ error: "invalid_grant" }, { status: 400 }), 400],
      [() => new Response("not json"), 200],
      [() => Response.json({ access_token: "a" }), 200],
      [
        () => {
          throw new TypeError("fetch failed");
        },
        0,
      ],
      ["pkce", 400],
    ];
    for (const [token, status] of cases) {
      const s = setup();
      const { tx, state } = await startLogin(s);
      if (token === "pkce") s.idp.challenge = "wrong";
      else s.idp.token = token;
      await refused(
        () => callback(s, { tx, state, code: CODE }),
        502,
        { result: "error", reason: "token_endpoint", status },
        /sign-in failed; try again/,
      );
    }
  });

  it("answers 502 when the JWKS cannot be fetched and 403 on a bad signature", async () => {
    {
      const s = setup();
      const { tx, state } = await startLogin(s);
      s.idp.jwks = () => new Response("", { status: 500 });
      await refused(() => callback(s, { tx, state, code: CODE }), 502, {
        result: "error",
        reason: "jwks",
      });
    }
    {
      const s = setup();
      const { tx, state } = await startLogin(s);
      s.idp.signer = OTHER_KEY.privateKey;
      await refused(
        () => callback(s, { tx, state, code: CODE }),
        403,
        { result: "denied", reason: "signature" },
        /not allowed/,
      );
    }
  });

  it("answers 403 for each refused claim, including an email not on the allowlist", async () => {
    const now = START / 1000;
    const cases: [Record<string, unknown>, string][] = [
      [{ iss: "https://evil.example" }, "iss"],
      [{ aud: "other" }, "aud"],
      [{ token_use: "access" }, "token_use"],
      [{ exp: now - 60 }, "exp"],
      [{ iat: now + 61 }, "iat"],
      [{ nonce: "other" }, "nonce"],
      [{ email_verified: false }, "email_verified"],
      [{ email: "stranger@example.com" }, "not_owner"],
    ];
    for (const [claims, reason] of cases) {
      const s = setup();
      const { tx, state } = await startLogin(s);
      Object.assign(s.idp.claims, claims);
      await refused(() => callback(s, { tx, state, code: CODE }), 403, {
        result: "denied",
        reason,
      });
    }
  });

  it("reloads the keys once for a cookie signed with a kid the cache does not hold yet", async () => {
    const s = setup({ loads: [SET_A, SET_CA] });
    await s.keys.get();
    assert.equal(s.loader.calls, 1);
    const state = "s".repeat(43);
    s.idp.nonce = "n".repeat(43);
    const tx = signTransaction(sessionKeys(SET_CA), KID_C, {
      s: state,
      n: s.idp.nonce,
      v: "v".repeat(43),
      r: GALLERY,
      exp: s.nowSeconds() + 600,
    });
    const res = await callback(s, { tx, state, code: CODE });
    assert.equal(res.status, 302);
    assert.equal(s.loader.calls, 2);
    assert.equal(s.idp.tokenBodies.length, 1);
    const session = cookieValue(res.headers.getSetCookie()[0], SESSION_COOKIE) ?? "";
    assert.equal(verifySession(sessionKeys(SET_CA), session, s.nowSeconds())?.kid, KID_C);
  });

  it("refuses a random kid with exactly one extra load", async () => {
    const s = setup();
    await s.keys.get();
    const randomKid = "00ff00ff00ff00ff";
    const tx = signTransaction({ [randomKid]: KEY_C }, randomKid, {
      s: "s",
      n: "n",
      v: "v",
      r: GALLERY,
      exp: s.nowSeconds() + 600,
    });
    await refused(() => callback(s, { tx, state: "s", code: CODE }), 400, {
      result: "denied",
      reason: "transaction",
    });
    assert.equal(s.loader.calls, 2);
    await refused(() => callback(s, { tx, state: "s", code: CODE }), 400, {
      result: "denied",
      reason: "transaction",
    });
    assert.equal(s.loader.calls, 2);
  });

  it("never logs the email, code, tokens, state, nonce or cookies", async () => {
    const s = setup();
    const { value, output } = await capture(async () => {
      const ok = await signIn(s);
      const started = await startLogin(s);
      Object.assign(s.idp.claims, { email: "stranger@example.com" });
      await callback(s, { tx: started.tx, state: started.state, code: CODE });
      return { ok, started };
    });
    const session = cookieValue(value.ok.res.headers.getSetCookie()[0], SESSION_COOKIE) ?? "";
    for (const secret of [
      OWNER,
      "Owner@Example.com",
      "stranger",
      CODE,
      "ACCESSTOKEN",
      value.ok.started.state,
      value.started.state,
      value.ok.started.tx,
      value.started.tx,
      s.idp.nonce ?? "",
      session,
      session.split(".")[2],
      "eyJ",
    ]) {
      assert.ok(!output.includes(secret), secret);
    }
    assert.equal(loginLines(output).length, 2);
  });
});

describe("GET /__artifact/logout", () => {
  it("clears both cookies and redirects to the Cognito logout", async () => {
    const s = setup();
    const res = await s.app.request(`https://${VIEW}/__artifact/logout`);
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("location"),
      `${OIDC.logoutUrl}?client_id=client123&logout_uri=https%3A%2F%2Fart.example.dev%2F`,
    );
    assert.deepEqual(res.headers.getSetCookie(), [
      `${SESSION_COOKIE}=; Domain=${VIEW}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      `${TRANSACTION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("redirects to the gallery without a logout URL", async () => {
    const s = setup({ logoutUrl: false });
    const res = await s.app.request(`https://${VIEW}/__artifact/logout`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), GALLERY);
  });
});

describe("login routes: methods and hosts", () => {
  it("answers anything but GET with 405 before any work", async () => {
    for (const path of LOGIN_PATHS) {
      for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
        const s = setup();
        const res = await s.app.request(`https://${VIEW}${path}?code=${CODE}&state=s`, {
          method,
          headers: { cookie: `${TRANSACTION_COOKIE}=t1.x` },
        });
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get("allow"), "GET");
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.deepEqual(res.headers.getSetCookie(), []);
        assert.equal(s.idp.calls.length, 0);
        assert.equal(s.loader.calls, 0);
      }
    }
  });

  it("serves the routes on the main host only", async () => {
    for (const path of LOGIN_PATHS) {
      const s = setup();
      const res = await s.app.request(`https://${ID}.${VIEW}${path}`);
      assert.equal(res.status, 404, path);
      assert.deepEqual(res.headers.getSetCookie(), []);
      assert.equal(s.loader.calls, 0);
    }
  });
});
