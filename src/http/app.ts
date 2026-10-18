// The Hono app: guards, then dispatch by Host (docs/decisions/0024, 0027).
//   any host        → platform routes under /__artifact/ (live reload, docs/decisions/0028)
//   <id>.localhost  → subdomain viewing only
//   localhost etc.  → /api, /mcp (docs/decisions/0033), the gallery at /, and path-mode viewing
//                     under /a/<id>/
import { Hono } from "hono";
import type { ArtifactService } from "../core/artifact-service.ts";
import { isArtifactId } from "../core/paths.ts";
import { createMcpHandler } from "../mcp/server.ts";
import { createApi } from "./api.ts";
import { httpError, jsonError } from "./errors.ts";
import { renderGallery } from "./gallery.ts";
import {
  type AppEnv,
  browserGuard,
  hostGuard,
  isApiPath,
  tokenGuard,
  traversalGuard,
} from "./guards.ts";
import { GALLERY_CSP, plainText, securityHeaders } from "./headers.ts";
import { reloadClient } from "./reload.ts";
import { type ArtifactEvents, eventStream } from "./sse.ts";
import { artifactUrl, type Isolation } from "./urls.ts";
import { notFound, redirect, serveArtifact } from "./viewing.ts";

export type AppConfig = {
  port: number;
  isolation: Isolation;
  /** Exact `Content-Security-Policy` for artifact pages; none when unset. */
  csp?: string;
  /** Bearer token required on /api and /mcp when set. */
  token?: string;
  /** Accept `file_path` in the MCP publish tool (default true; off where there is no local disk). */
  allowFilePath?: boolean;
  /** Interval between SSE heartbeat comments; default 20 s (tests inject a short one). */
  heartbeatMs?: number;
};

export type AppDeps = { service: ArtifactService; events: ArtifactEvents; config: AppConfig };

const MCP_PATH = "/mcp";
const VIEW_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { service, events, config } = deps;
  const { csp } = config;
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    console.error(error);
    return isApiPath(c.req.path) || c.req.path === MCP_PATH
      ? jsonError(httpError("internal", "internal server error"))
      : plainText(500, "internal server error\n", csp);
  });
  app.notFound(() => notFound(csp));

  app.use(hostGuard(config.port, csp));
  app.use(traversalGuard(csp));

  // Platform routes, on every host. On <id>.localhost only that artifact's events are served.
  app.get("/__artifact/reload.js", () => reloadClient());
  app.get("/__artifact/events", async (c) => {
    // Hono answers HEAD from the GET handler and drops the body, which would leave the stream
    // (and its subscription) open.
    if (c.req.method !== "GET") {
      return new Response(null, {
        status: 405,
        headers: { ...securityHeaders(csp), Allow: "GET" },
      });
    }
    const id = c.req.query("id")?.toLowerCase() ?? "";
    const host = c.get("host");
    if (!isArtifactId(id) || (host.kind === "artifact" && host.id !== id)) return notFound(csp);
    if (!(await service.read(id)).ok) return notFound(csp);
    return eventStream(c, { service, events, heartbeatMs: config.heartbeatMs }, id);
  });

  // Subdomain mode: every path on <id>.localhost belongs to the artifact.
  app.use(async (c, next) => {
    const host = c.get("host");
    if (host.kind === "main") return next();
    if (!VIEW_METHODS.has(c.req.method)) return notFound(csp);
    const url = new URL(c.req.url);
    return serveArtifact(
      { service, csp },
      { id: host.id, base: "", segments: url.pathname.slice(1).split("/"), search: url.search },
    );
  });

  app.route("/api", createApi(deps));

  // MCP behind the same browser and token guards as /api (docs/decisions/0027, 0037).
  const mcp = createMcpHandler({ service, config });
  app.use(MCP_PATH, browserGuard(), tokenGuard(config.token));
  app.all(MCP_PATH, (c) => mcp(c.req.raw));

  app.get("/", async () => {
    const list = await service.list();
    if (!list.ok) throw new Error(list.error.message);
    const html = renderGallery(list.value, (id) => artifactUrl(id, config));
    return new Response(html, {
      headers: {
        ...securityHeaders(GALLERY_CSP),
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  // Path mode, mounted in every isolation mode: /a/<id>/…
  app.get("/a/*", (c) => {
    const url = new URL(c.req.url);
    const [, , rawId, ...segments] = url.pathname.split("/");
    // `/a/*` also matches `/a` itself.
    if (rawId === undefined || !isArtifactId(rawId.toLowerCase())) return notFound(csp);
    const base = `/a/${rawId}`;
    if (segments.length === 0) {
      return redirect(`${base}/${url.search}`, csp);
    }
    return serveArtifact({ service, csp }, { id: rawId, base, segments, search: url.search });
  });

  return app;
}
