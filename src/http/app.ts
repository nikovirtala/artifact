// The local app: the viewing app (platform routes, artifact viewing, gallery, path mode) and the
// control app (/api, /mcp) composed on one port (docs/decisions/0056, 0024, 0027).
import { Hono } from "hono";
import type { Opener } from "../adapters/browser-opener.ts";
import type { ArtifactService } from "../core/artifact-service.ts";
import { createControlApp } from "./control-app.ts";
import { appErrorHandler } from "./errors.ts";
import type { AppEnv } from "./guards.ts";
import { type HostPolicy, LocalHostPolicy } from "./host-policy.ts";
import { nodeServerRawTarget, type RawTargetHook } from "./raw-target.ts";
import type { ArtifactEvents } from "./sse.ts";
import { localTokenVerifier, type TokenVerifier } from "./token.ts";
import type { Isolation } from "./urls.ts";
import { notFound } from "./viewing.ts";
import { createViewingApp } from "./viewing-app.ts";

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
  /** Request body cap on /api and /mcp; default `bodyCapFor(service.limits)` (0051). */
  maxBodyBytes?: number;
};

export type AppDeps = {
  service: ArtifactService;
  events: ArtifactEvents;
  config: AppConfig;
  /** Opens newly created artifacts in the browser; none means never (docs/decisions/0040). */
  opener?: Opener;
  /** Accepted hosts and the URLs handed out; default `LocalHostPolicy(config)` (0053). */
  hosts?: HostPolicy;
  /** Bearer check on /api and /mcp; default `localTokenVerifier(config.token)` (0054). */
  verifyToken?: TokenVerifier;
  /** Reads the raw request target; default `nodeServerRawTarget` (docs/decisions/0055). */
  rawTarget?: RawTargetHook;
};

/**
 * The local app: the viewing app, then the control app, on one port (docs/decisions/0056).
 * Viewing goes first, so its host guard and the `<id>.localhost` catch-all run before any
 * control route, and one error handler renders errors the same whichever app throws.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { config } = deps;
  const resolved = {
    ...deps,
    hosts: deps.hosts ?? new LocalHostPolicy(config),
    verifyToken: deps.verifyToken ?? localTokenVerifier(config.token),
    rawTarget: deps.rawTarget ?? nodeServerRawTarget,
  };
  const app = new Hono<AppEnv>();
  app.onError(appErrorHandler(config.csp));
  app.notFound(() => notFound(config.csp));
  app.route("/", createViewingApp(resolved));
  app.route("/", createControlApp(resolved));
  return app;
}
