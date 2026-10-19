// The viewing app (docs/decisions/0056): guards, then dispatch by Host (docs/decisions/0024, 0027).
//   any host        → platform routes under /__artifact/ (live reload, docs/decisions/0028)
//   <id>.localhost  → subdomain viewing only
//   localhost etc.  → the gallery at /, and path-mode viewing under /a/<id>/
import { Hono } from "hono";
import type { ArtifactService } from "../core/artifact-service.ts";
import { isArtifactId } from "../core/paths.ts";
import { normalizeProject } from "../core/project.ts";
import type { AppConfig } from "./app.ts";
import { appErrorHandler } from "./errors.ts";
import { renderGallery } from "./gallery.ts";
import { type AppEnv, hostGuard, traversalGuard } from "./guards.ts";
import { GALLERY_CSP, plainText, securityHeaders } from "./headers.ts";
import { type HostPolicy, LocalHostPolicy } from "./host-policy.ts";
import type { RawTargetHook } from "./raw-target.ts";
import { reloadClient } from "./reload.ts";
import { type ArtifactEvents, eventStream } from "./sse.ts";
import { notFound, redirect, serveArtifact } from "./viewing.ts";

export type ViewingAppDeps = {
  service: ArtifactService;
  events: ArtifactEvents;
  config: AppConfig;
  /** Accepted hosts and the URLs handed out; default `LocalHostPolicy(config)` (0053). */
  hosts?: HostPolicy;
  /** Reads the raw request target; default `nodeServerRawTarget` (docs/decisions/0055). */
  rawTarget?: RawTargetHook;
};

const VIEW_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export function createViewingApp(deps: ViewingAppDeps): Hono<AppEnv> {
  const { service, events, config } = deps;
  const { csp } = config;
  const hosts = deps.hosts ?? new LocalHostPolicy(config);
  const app = new Hono<AppEnv>();

  app.onError(appErrorHandler(csp));
  app.notFound(() => notFound(csp));

  app.use(hostGuard(hosts, csp));
  app.use(traversalGuard(csp, deps.rawTarget));

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

  app.get("/", async (c) => {
    const raw = c.req.query("project");
    const project = raw === undefined ? undefined : normalizeProject(raw);
    if (project && !project.ok)
      return plainText(400, "bad request: invalid project\n", GALLERY_CSP);
    const list = await service.list({ project: project?.value });
    if (!list.ok) throw new Error(list.error.message);
    const html = renderGallery(list.value, (id) => hosts.artifactUrl(id), project?.value);
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
