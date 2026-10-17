// Request guards (docs/decisions/0027), applied in order: Host and traversal on every route,
// then Origin and bearer token on /api and /mcp.
import { createHash, timingSafeEqual } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import type { Context, MiddlewareHandler } from "hono";
import { isArtifactId } from "../core/paths.ts";
import { badRequest, httpError, jsonError } from "./errors.ts";
import { plainText } from "./headers.ts";

export type HostKind = { kind: "main" } | { kind: "artifact"; id: string };

export type AppEnv = {
  /** Set by `@hono/node-server`; absent for in-process `app.request()` unless a test passes it. */
  Bindings: Partial<HttpBindings>;
  Variables: { host: HostKind };
};

const MAIN_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ARTIFACT_HOST_SUFFIX = ".localhost";

/** Classify a URL `host` (`name[:port]`); `undefined` means the request must be refused. */
export function classifyHost(host: string, port: number): HostKind | undefined {
  const lower = host.toLowerCase();
  // URL parsing drops the default port, so port 80 arrives without one.
  const suffix = port === 80 ? "" : `:${port}`;
  if (!lower.endsWith(suffix)) return undefined;
  const name = lower.slice(0, lower.length - suffix.length);
  if (MAIN_HOSTS.has(name)) return { kind: "main" };
  if (name.endsWith(ARTIFACT_HOST_SUFFIX)) {
    const id = name.slice(0, -ARTIFACT_HOST_SUFFIX.length);
    if (isArtifactId(id)) return { kind: "artifact", id };
  }
  return undefined;
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

export function hostGuard(port: number, csp?: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const host = classifyHost(new URL(c.req.url).host, port);
    if (!host) return plainText(403, "forbidden: unexpected Host header\n", csp);
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

export function originGuard(port: number): MiddlewareHandler<AppEnv> {
  const allowed = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]);
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin !== undefined && !allowed.has(origin)) {
      return jsonError(httpError("forbidden", `origin ${JSON.stringify(origin)} is not allowed`));
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
