// The Hono app: guards, then dispatch by Host (docs/decisions/0024, 0027).
//   <id>.localhost  → subdomain viewing only
//   localhost etc.  → /api, and path-mode viewing under /a/<id>/
import { Hono } from "hono";
import type { ArtifactService } from "../core/artifact-service.ts";
import { isArtifactId } from "../core/paths.ts";
import { createApi } from "./api.ts";
import { httpError, jsonError } from "./errors.ts";
import { type AppEnv, hostGuard, isApiPath, traversalGuard } from "./guards.ts";
import { plainText } from "./headers.ts";
import type { Isolation } from "./urls.ts";
import { notFound, redirect, serveArtifact } from "./viewing.ts";

export type AppConfig = {
  port: number;
  isolation: Isolation;
  /** Exact `Content-Security-Policy` for artifact pages; none when unset. */
  csp?: string;
  /** Bearer token required on /api when set. */
  token?: string;
};

export type AppDeps = { service: ArtifactService; config: AppConfig };

const VIEW_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { service, config } = deps;
  const { csp } = config;
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    console.error(error);
    return isApiPath(c.req.path)
      ? jsonError(httpError("internal", "internal server error"))
      : plainText(500, "internal server error\n", csp);
  });
  app.notFound(() => notFound(csp));

  app.use(hostGuard(config.port, csp));
  app.use(traversalGuard(csp));

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
