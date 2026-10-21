// The viewing Lambda (docs/decisions/0082): the v1 viewing app (0056) behind CloudFront on a
// function URL that only the distribution can call (AWS_IAM + OAC). The viewer's host arrives in
// x-artifact-host, set by the edge function (0080), and is trusted only because of that; the
// session cookie never gets this far, and the Lambda strips cookies again anyway. Only pinned
// files are cacheable: every response without its own Cache-Control gets no-store.
import { Hono, type MiddlewareHandler } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import type { ArtifactService } from "../../core/artifact-service.ts";
import { appErrorHandler } from "../../http/errors.ts";
import { type AppEnv, hostGuard, traversalGuard } from "../../http/guards.ts";
import { securityHeaders } from "../../http/headers.ts";
import { DomainHostPolicy } from "../../http/host-policy.ts";
import type { ReloadClientConfig } from "../../http/reload.ts";
import { notFound } from "../../http/viewing.ts";
import { createViewingApp } from "../../http/viewing-app.ts";
import { noopEvents } from "../adapters/noop-events.ts";
import type { Fetch, OidcConfig } from "../auth/oidc.ts";
import { TRANSACTION_COOKIE } from "../auth/session.ts";
import type { KeyCache } from "../auth/session-keys-loader.ts";
import { type HttpApiEvent, keepCookies, lambdaRawTarget, stripCookies } from "./lambda-event.ts";
import { createLoginApp, LOGIN_PATHS } from "./login.ts";

export type ViewingHandlerDeps = {
  service: ArtifactService;
  viewDomain: string;
  loadKeys: KeyCache;
  /** The IdP endpoints; the redirect URI and scopes follow from the view domain. */
  oidc: Omit<OidcConfig, "redirectUri" | "scopes">;
  /** Lowercase emails allowed to sign in. */
  owners: readonly string[];
  fetch: Fetch;
  now?: () => number;
};

type LambdaResult = {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
  cookies?: string[];
};

const HOST_HEADER = "x-artifact-host";
const MAX_LOGGED_PATH = 256;
const LOGIN: ReadonlySet<string> = new Set(LOGIN_PATHS);

/** No live reload before M11: the client opens no connection (0058's inert unknown transport). */
export function awsReloadConfig(viewDomain: string): ReloadClientConfig {
  return { transport: "none", viewSuffix: `.${viewDomain}`, pathMode: false };
}

function header(headers: Record<string, string | undefined> | undefined, name: string) {
  const entry = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === name);
  return entry?.[1];
}

/** Cookies as received: the `cookies` array plus the pairs of any `Cookie` header. */
function cookieCount(event: HttpApiEvent): number {
  const array = Array.isArray(event.cookies) ? event.cookies.length : 0;
  const inHeaders = Object.entries(event.headers ?? {})
    .filter(([k]) => k.toLowerCase() === "cookie")
    .flatMap(([, v]) => String(v ?? "").split(";"))
    .filter((p) => p.trim() !== "").length;
  return array + inHeaders;
}

/**
 * The event as the app sees it, or `undefined` when x-artifact-host is missing or rejected: the
 * host in `headers.host` and `requestContext.domainName` (hono/aws-lambda builds the URL from the
 * latter), only the transaction cookie on the main host's login paths, no cookie elsewhere.
 */
export function viewingEvent(
  event: HttpApiEvent,
  hosts: DomainHostPolicy,
): HttpApiEvent | undefined {
  const host = header(event.headers, HOST_HEADER);
  if (host === undefined || host === "") return undefined;
  const kind = hosts.classify(host).kind;
  if (kind === "reject") return undefined;
  const rewritten: HttpApiEvent = {
    ...event,
    headers: { ...event.headers, host },
    requestContext: { ...event.requestContext, domainName: host },
  };
  return kind === "main" && LOGIN.has(event.rawPath)
    ? keepCookies(rewritten, [TRANSACTION_COOKIE])
    : stripCookies(rewritten);
}

function forbidden(): LambdaResult {
  const headers = Object.fromEntries(
    Object.entries(securityHeaders()).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    statusCode: 403,
    headers: {
      ...headers,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
    body: "forbidden: unexpected Host header\n",
    isBase64Encoded: false,
  };
}

export function createViewingHandler(deps: ViewingHandlerDeps) {
  const viewDomain = deps.viewDomain.toLowerCase();
  const now = deps.now ?? Date.now;
  const hosts = new DomainHostPolicy({ viewDomain });
  // No ARTIFACT_CSP on AWS in M10: artifact pages carry no CSP (0025's default).
  const csp = undefined;
  const app = new Hono<AppEnv>();
  app.onError(appErrorHandler(csp));
  app.notFound(() => notFound(csp));
  app.use(hostGuard(hosts, csp));
  app.use(traversalGuard(csp, lambdaRawTarget));
  app.route(
    "/",
    createLoginApp({
      hosts,
      viewDomain,
      keys: deps.loadKeys,
      oidc: {
        ...deps.oidc,
        redirectUri: `https://${viewDomain}/__artifact/callback`,
        scopes: ["openid", "email"],
      },
      owners: deps.owners,
      fetch: deps.fetch,
      now,
    }),
  );
  // No SSE on Lambda.
  app.all("/__artifact/events", () => notFound(csp));
  // Path mode would serve every artifact on the gallery origin and break per-artifact isolation.
  const noPathMode: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("host").kind === "main") return notFound(csp);
    await next();
  };
  app.use("/a", noPathMode);
  app.use("/a/*", noPathMode);
  app.route(
    "/",
    createViewingApp({
      service: deps.service,
      events: noopEvents,
      config: { port: 443, isolation: "subdomain", allowFilePath: false },
      hosts,
      rawTarget: lambdaRawTarget,
      reload: awsReloadConfig(viewDomain),
    }),
  );
  const inner = handle(app);

  return async (event: HttpApiEvent, context: LambdaContext): Promise<LambdaResult> => {
    const started = now();
    const forApp = viewingEvent(event, hosts);
    let result: LambdaResult;
    if (forApp === undefined) {
      result = forbidden();
    } else {
      result = (await inner(forApp as unknown as LambdaEvent, context)) as LambdaResult;
      const headers = result.headers ?? {};
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "cache-control")) {
        headers["cache-control"] = "no-store";
      }
      result.headers = headers;
    }
    console.log(
      `artifact view ${JSON.stringify({
        requestId: event.requestContext?.requestId,
        method: event.requestContext?.http?.method,
        host: String(header(event.headers, HOST_HEADER) ?? "").slice(0, MAX_LOGGED_PATH),
        path: String(event.rawPath ?? "").slice(0, MAX_LOGGED_PATH),
        status: result.statusCode,
        cookies: cookieCount(event),
        ms: now() - started,
      })}`,
    );
    return result;
  };
}
