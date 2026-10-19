// Request guards (docs/decisions/0027), applied in order: Host and traversal on every route,
// then browser requests (docs/decisions/0037) and bearer token on /api and /mcp.
import { createHash, timingSafeEqual } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import type { Context, MiddlewareHandler } from "hono";
import { badRequest, httpError, jsonError } from "./errors.ts";
import { plainText } from "./headers.ts";
import { type AcceptedHost, type HostPolicy, LocalHostPolicy } from "./host-policy.ts";

export type { AcceptedHost, HostKind } from "./host-policy.ts";

export type AppEnv = {
  /** Set by `@hono/node-server`; absent for in-process `app.request()` unless a test passes it. */
  Bindings: Partial<HttpBindings>;
  Variables: { host: AcceptedHost };
};

/** Classify a URL `host` (`name[:port]`) by the local rules; `undefined` means refuse it. */
export function classifyHost(host: string, port: number): AcceptedHost | undefined {
  const kind = new LocalHostPolicy({ port, isolation: "subdomain" }).classify(host);
  return kind.kind === "reject" ? undefined : kind;
}

/**
 * True if a raw request path could escape or confuse path resolution: a `\`, an undecodable
 * escape, or a segment that decodes to `.`, `..`, or contains `/`, `\` or a control character.
 */
export function hasUnsafeSegment(rawPath: string): boolean {
  const path = rawPath.split(/[?#]/, 1)[0];
  if (path.includes("\\")) return true;
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === "." || decoded === "..") return true;
    for (let i = 0; i < decoded.length; i++) {
      const c = decoded.charCodeAt(i);
      if (c < 0x20 || c === 0x7f || c === 0x2f || c === 0x5c) return true;
    }
  }
  return false;
}

/** `If-Match: 3` or `If-Match: "3"`; anything else (`*`, lists, `W/`, `0`) is an error. */
export function parseIfMatch(value: string): { ok: true; value: number } | { ok: false } {
  const match = /^\s*(?:"([1-9][0-9]*)"|([1-9][0-9]*))\s*$/.exec(value);
  const version = match ? Number(match[1] ?? match[2]) : Number.NaN;
  return Number.isSafeInteger(version) ? { ok: true, value: version } : { ok: false };
}

/** The request target as the client sent it, before any URL normalisation. */
export function rawTarget(c: Context<AppEnv>): string {
  const raw = c.env?.incoming?.url;
  if (typeof raw === "string") return raw;
  const url = new URL(c.req.url);
  return url.pathname + url.search;
}

export function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/** Refuse hosts the policy rejects (a port number means the local policy on that port). */
export function hostGuard(policy: HostPolicy | number, csp?: string): MiddlewareHandler<AppEnv> {
  const hosts =
    typeof policy === "number"
      ? new LocalHostPolicy({ port: policy, isolation: "subdomain" })
      : policy;
  return async (c, next) => {
    const host = hosts.classify(new URL(c.req.url).host);
    if (host.kind === "reject") return plainText(403, "forbidden: unexpected Host header\n", csp);
    c.set("host", host);
    await next();
  };
}

export function traversalGuard(csp?: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const target = rawTarget(c);
    if (!hasUnsafeSegment(target)) return next();
    if (c.get("host").kind === "main" && isApiPath(target.split(/[?#]/, 1)[0])) {
      return badRequest("unsafe path in request URL");
    }
    return plainText(400, "bad request: unsafe path\n", csp);
  };
}

/**
 * True if a web page made the request (docs/decisions/0037): browsers send `Origin` on
 * cross-origin and non-GET requests and `Sec-Fetch-Site` on every request to localhost;
 * `Sec-Fetch-Site: none` is the user typing the URL. Non-browser clients send neither (Node's
 * fetch sends only `Sec-Fetch-Mode: cors`, which does not count).
 */
export function isBrowserRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  return headers.has("origin") || (site !== null && site !== "none");
}

/** `/api` and `/mcp` are for the CLI, scripts and MCP clients; web pages get 403. */
export function browserGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isBrowserRequest(c.req.raw.headers)) {
      return jsonError(
        httpError(
          "forbidden",
          "the API is not available to web pages; use the CLI or an MCP client",
        ),
      );
    }
    await next();
  };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** With a token configured, require `Authorization: Bearer <token>` (constant-time compare). */
export function tokenGuard(token: string | undefined): MiddlewareHandler<AppEnv> {
  const expected = token === undefined ? undefined : digest(token);
  return async (c, next) => {
    if (expected === undefined) return next();
    const given = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    if (given === undefined || !timingSafeEqual(digest(given), expected)) {
      return jsonError(httpError("unauthorized", "missing or invalid bearer token"), {
        "WWW-Authenticate": "Bearer",
      });
    }
    await next();
  };
}
