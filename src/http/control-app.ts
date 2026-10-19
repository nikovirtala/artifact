// The control app (docs/decisions/0056): /api (docs/decisions/0021–0023) and /mcp
// (docs/decisions/0033), both behind the browser and token guards (docs/decisions/0027, 0037).
// No host guard: locally the viewing app in front of it checks the Host.
import { Hono } from "hono";
import type { Opener } from "../adapters/browser-opener.ts";
import type { ArtifactService } from "../core/artifact-service.ts";
import { createMcpHandler } from "../mcp/server.ts";
import { createApi } from "./api.ts";
import type { AppConfig } from "./app.ts";
import { appErrorHandler, MCP_PATH } from "./errors.ts";
import { type AppEnv, browserGuard, tokenGuard, traversalGuard } from "./guards.ts";
import { type HostPolicy, LocalHostPolicy } from "./host-policy.ts";
import type { RawTargetHook } from "./raw-target.ts";
import { localTokenVerifier, type TokenVerifier } from "./token.ts";
import { notFound } from "./viewing.ts";

export type ControlAppDeps = {
  service: ArtifactService;
  config: AppConfig;
  /** Opens newly created artifacts in the browser; none means never (docs/decisions/0040). */
  opener?: Opener;
  /** The URLs handed out; default `LocalHostPolicy(config)` (docs/decisions/0053). */
  hosts?: HostPolicy;
  /** Bearer check on /api and /mcp; default `localTokenVerifier(config.token)` (0054). */
  verifyToken?: TokenVerifier;
  /** Reads the raw request target; default `nodeServerRawTarget` (docs/decisions/0055). */
  rawTarget?: RawTargetHook;
};

export function createControlApp(deps: ControlAppDeps): Hono<AppEnv> {
  const { service, config } = deps;
  const { csp } = config;
  const hosts = deps.hosts ?? new LocalHostPolicy(config);
  const verifyToken = deps.verifyToken ?? localTokenVerifier(config.token);
  const app = new Hono<AppEnv>();

  app.onError(appErrorHandler(csp));
  app.notFound(() => notFound(csp));

  app.use(traversalGuard(csp, deps.rawTarget));

  app.route("/api", createApi({ ...deps, hosts, verifyToken }));

  // MCP behind the same browser and token guards as /api (docs/decisions/0027, 0037).
  const mcp = createMcpHandler({ service, config, opener: deps.opener, hosts });
  app.use(MCP_PATH, browserGuard(), tokenGuard(verifyToken));
  app.all(MCP_PATH, (c) => mcp(c.req.raw));

  return app;
}
