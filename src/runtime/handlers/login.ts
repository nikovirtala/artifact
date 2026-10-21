// The login routes of the viewing Lambda (docs/decisions/0081), on the view domain's main host:
//   GET /__artifact/login?return=<url>   → 302 to the IdP with PKCE, sets the transaction cookie
//   GET /__artifact/callback?code&state  → verifies, sets the session cookie, 302 to the return
//   GET /__artifact/logout               → clears both cookies, 302 to the IdP logout
// Anything but GET is refused first: Hono answers HEAD from GET handlers, and a link prefetcher's
// HEAD must not spend the single-use code. Logs carry fixed fields only: never an email, code,
// token, cookie, state or nonce.
import { timingSafeEqual } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../../http/guards.ts";
import { securityHeaders } from "../../http/headers.ts";
import type { HostPolicy } from "../../http/host-policy.ts";
import { notFound } from "../../http/viewing.ts";
import {
  authorizeUrl,
  createJwksCache,
  exchangeCode,
  type Fetch,
  type OidcConfig,
  pkceChallenge,
  randomToken,
  verifyIdToken,
} from "../auth/oidc.ts";
import { validateReturn } from "../auth/return-url.ts";
import {
  type KeySet,
  SESSION_COOKIE,
  SESSION_TTL_S,
  sessionKeys,
  signSession,
  signTransaction,
  TRANSACTION_COOKIE,
  TRANSACTION_TTL_S,
  verifyTransaction,
} from "../auth/session.ts";
import type { KeyCache } from "../auth/session-keys-loader.ts";

export const LOGIN_PATHS = [
  "/__artifact/login",
  "/__artifact/callback",
  "/__artifact/logout",
] as const;

export type LoginDeps = {
  hosts: HostPolicy;
  /** Lowercase; the session cookie's `Domain`. */
  viewDomain: string;
  keys: KeyCache;
  oidc: OidcConfig;
  /** Lowercase emails allowed to sign in. */
  owners: readonly string[];
  fetch: Fetch;
  now?: () => number;
};

/** The JSON-escaped length of a `return` kept in the transaction cookie (bounds its size). */
const MAX_STORED_RETURN = 1024;
const CODE = /^[A-Za-z0-9._~-]{1,2048}$/;
const TX_KID = /^t1\.([0-9a-f]{16})\./;
const PAGE_CSP = "default-src 'none'";
const NO_STORE = { "Cache-Control": "no-store" };
const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

type LogFields = Record<string, string | number>;
const log = (fields: LogFields) => console.log(`artifact login ${JSON.stringify(fields)}`);

function page(status: number, message: string, signInLink: boolean): Response {
  const link = signInLink ? '<p><a href="/__artifact/login">Sign in</a></p>' : "";
  const html = `<!doctype html><meta charset="utf-8"><title>Sign-in</title><p>${message}</p>${link}\n`;
  return new Response(html, {
    status,
    headers: {
      ...securityHeaders(PAGE_CSP),
      ...NO_STORE,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

function found(location: string, cookies: string[]): Response {
  const headers = new Headers({ ...securityHeaders(), ...NO_STORE, Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

const unavailable = () => page(503, "login is unavailable", false);
const expired = () => page(400, "the sign-in expired; start again", true);

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const errorName = (error: unknown) => (error as Error | undefined)?.name ?? "Error";

export function createLoginApp(deps: LoginDeps): Hono<AppEnv> {
  const { hosts, viewDomain, keys, oidc, owners, fetch } = deps;
  const now = deps.now ?? Date.now;
  const nowSeconds = () => Math.floor(now() / 1000);
  const jwks = createJwksCache({ issuer: oidc.issuer, fetch, now });
  const sessionCookie = (value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; Domain=${viewDomain}; ${ATTRIBUTES}; Max-Age=${maxAge}`;
  const transactionCookie = (value: string, maxAge: number) =>
    `${TRANSACTION_COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${maxAge}`;

  /** The key set, or `undefined` (logged) when it cannot be read or holds no key yet. */
  const keySet = async (read: () => Promise<KeySet>): Promise<KeySet | undefined> => {
    try {
      const set = await read();
      if (set.current !== null) return set;
      log({ result: "error", reason: "session_keys" });
    } catch (error) {
      log({ result: "error", reason: "session_keys", name: errorName(error) });
    }
    return undefined;
  };

  const app = new Hono<AppEnv>();
  const onlyGet: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("host")?.kind === "main" && c.req.method !== "GET") {
      return new Response("method not allowed\n", {
        status: 405,
        headers: {
          ...securityHeaders(),
          ...NO_STORE,
          Allow: "GET",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
    await next();
  };
  for (const path of LOGIN_PATHS) app.use(path, onlyGet);
  const mainOnly =
    (handler: (c: Context<AppEnv>) => Promise<Response> | Response) => (c: Context<AppEnv>) =>
      c.get("host").kind === "main" ? handler(c) : notFound();

  app.get(
    "/__artifact/login",
    mainOnly(async (c) => {
      let r = validateReturn(c.req.query("return"), hosts);
      if (JSON.stringify(r).length - 2 > MAX_STORED_RETURN) r = hosts.galleryUrl();
      const set = await keySet(keys.get);
      if (set === undefined) return unavailable();
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken();
      const tx = signTransaction(sessionKeys(set), set.current as string, {
        s: state,
        n: nonce,
        v: verifier,
        r,
        exp: nowSeconds() + TRANSACTION_TTL_S,
      });
      const location = authorizeUrl(oidc, { state, nonce, challenge: pkceChallenge(verifier) });
      return found(location, [transactionCookie(tx, TRANSACTION_TTL_S)]);
    }),
  );

  app.get(
    "/__artifact/callback",
    mainOnly(async (c) => {
      const denied = (reason: string, response: Response) => {
        log({ result: "denied", reason });
        return response;
      };
      if (c.req.query("error") !== undefined) {
        return denied("idp_error", page(400, "sign-in did not complete", true));
      }
      const cookie = getCookie(c, TRANSACTION_COOKIE) ?? "";
      const kid = TX_KID.exec(cookie)?.[1];
      if (kid === undefined) return denied("transaction", expired());
      const set = await keySet(() => keys.forKid(kid));
      if (set === undefined) return unavailable();
      const opened = verifyTransaction(sessionKeys(set), cookie, nowSeconds());
      if (opened === null) return denied("transaction", expired());
      const { tx } = opened;
      const state = c.req.query("state");
      if (state === undefined || !equal(state, tx.s)) {
        return denied("state", page(400, "the sign-in did not match; start again", true));
      }
      const code = c.req.query("code");
      if (code === undefined || !CODE.test(code)) {
        return denied("code", page(400, "the sign-in did not return a valid code", true));
      }

      const token = await exchangeCode(oidc, { code, verifier: tx.v }, { fetch });
      if (!token.ok) {
        log({ result: "error", reason: "token_endpoint", status: token.status });
        return page(502, "sign-in failed; try again", true);
      }
      const verified = await verifyIdToken(token.idToken, {
        jwks,
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        nonce: tx.n,
        owners,
        nowSeconds: nowSeconds(),
      });
      if (!verified.ok) {
        if (verified.reason === "jwks") {
          log({ result: "error", reason: "jwks" });
          return page(502, "sign-in failed; try again", true);
        }
        return denied(verified.reason, page(403, "not allowed", false));
      }

      const iat = nowSeconds();
      const session = signSession(sessionKeys(set), set.current as string, {
        sub: verified.claims.sub,
        email: verified.claims.email,
        iat,
        exp: iat + SESSION_TTL_S,
      });
      log({ result: "ok" });
      return found(validateReturn(tx.r, hosts), [
        sessionCookie(session, SESSION_TTL_S),
        transactionCookie("", 0),
      ]);
    }),
  );

  app.get(
    "/__artifact/logout",
    mainOnly(() => {
      const gallery = hosts.galleryUrl();
      const location =
        oidc.logoutUrl === undefined
          ? gallery
          : `${oidc.logoutUrl}?client_id=${encodeURIComponent(oidc.clientId)}&logout_uri=${encodeURIComponent(gallery)}`;
      return found(location, [sessionCookie("", 0), transactionCookie("", 0)]);
    }),
  );

  return app;
}
