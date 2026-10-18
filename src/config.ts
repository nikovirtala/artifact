// `artifact serve` configuration: flags (node:util parseArgs, ADR 0007) > env > defaults.
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Isolation } from "./http/urls.ts";

export const DEFAULT_PORT = 4400;

export type ServeConfig = {
  port: number;
  /** Absolute storage root. */
  root: string;
  /** Bind exactly this address instead of 127.0.0.1 + ::1. */
  host?: string;
  isolation: Isolation;
  csp?: string;
  token?: string;
  /** Open new artifacts in the browser (docs/decisions/0040). */
  open: boolean;
};

export type ServeConfigResult =
  | { ok: true; help: true }
  | { ok: true; help?: false; config: ServeConfig; warnings: string[] }
  | { ok: false; message: string };

export type Env = Readonly<Record<string, string | undefined>>;

export const SERVE_USAGE = `Usage: artifact serve [options]

Options:
  --port <n>                  Port (default ${DEFAULT_PORT}; env ARTIFACT_PORT)
  --root <dir>                Storage root (default ~/.artifacts)
  --host <addr>               Bind only this address (default 127.0.0.1 and ::1);
                              a non-loopback address requires ARTIFACT_TOKEN
  --isolation subdomain|path  URL style returned by the API and gallery (default subdomain)
  --csp <policy>              Content-Security-Policy for artifact pages (env ARTIFACT_CSP)
  --no-open                   Do not open new artifacts in the browser
  -h, --help                  Show this help

Environment:
  ARTIFACT_TOKEN              If set, /api and /mcp require "Authorization: Bearer <token>"
  ARTIFACT_OPEN=0, BROWSER=none
                              Do not open new artifacts in the browser (also skipped over
                              SSH, without a display, and with a non-loopback --host)
`;

/** `localhost`, `::1` or any 127.0.0.0/8 address. */
export function isLoopback(host: string): boolean {
  if (host.toLowerCase() === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith("127.");
  if (family === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

const OFF: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/** Whether `serve` opens new artifacts in the browser (docs/decisions/0040). */
export function autoOpen(options: {
  noOpen: boolean;
  host?: string;
  env: Env;
  platform: NodeJS.Platform;
}): boolean {
  const { noOpen, host, env, platform } = options;
  if (noOpen) return false;
  if (OFF.has(envValue(env, "ARTIFACT_OPEN")?.toLowerCase() ?? "")) return false;
  if (env.BROWSER === "none") return false;
  if (envValue(env, "SSH_CONNECTION") !== undefined) return false;
  const desktop = platform === "darwin" || platform === "win32";
  const display = envValue(env, "DISPLAY") ?? envValue(env, "WAYLAND_DISPLAY");
  if (!desktop && display === undefined) return false;
  return host === undefined || isLoopback(host);
}

/** Empty strings count as unset. */
function envValue(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function parsePort(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : undefined;
}

export function resolveServeConfig(
  args: readonly string[],
  env: Env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): ServeConfigResult {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: "string" },
        root: { type: "string" },
        host: { type: "string" },
        isolation: { type: "string" },
        csp: { type: "string" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    return { ok: false, message: `artifact serve: ${(error as Error).message}` };
  }
  if (values.help) return { ok: true, help: true };
  const str = (name: string) => values[name] as string | undefined;

  const portSource = str("port") !== undefined ? "--port" : "ARTIFACT_PORT";
  const rawPort = str("port") ?? envValue(env, "ARTIFACT_PORT");
  const port = rawPort === undefined ? DEFAULT_PORT : parsePort(rawPort);
  if (port === undefined) {
    return {
      ok: false,
      message: `artifact serve: ${portSource} must be an integer from 1 to 65535, got ${JSON.stringify(rawPort)}`,
    };
  }

  const isolation = str("isolation") ?? "subdomain";
  if (isolation !== "subdomain" && isolation !== "path") {
    return {
      ok: false,
      message: `artifact serve: --isolation must be "subdomain" or "path", got ${JSON.stringify(isolation)}`,
    };
  }

  const rawRoot = str("root");
  const root =
    rawRoot === undefined
      ? join(home, ".artifacts")
      : resolve(
          rawRoot === "~" || rawRoot.startsWith("~/") ? join(home, rawRoot.slice(1)) : rawRoot,
        );

  const token = envValue(env, "ARTIFACT_TOKEN");
  const host = str("host");
  const warnings: string[] = [];
  if (host !== undefined && !isLoopback(host)) {
    if (token === undefined) {
      return {
        ok: false,
        message: `artifact: --host ${host} is not a loopback address; set ARTIFACT_TOKEN to serve on it`,
      };
    }
    warnings.push(
      `artifact: warning: listening on non-loopback address ${host}; /api and /mcp require ARTIFACT_TOKEN, but artifact pages and the gallery are readable by anyone who can reach it`,
    );
  }

  const open = autoOpen({ noOpen: values["no-open"] === true, host, env, platform });
  const config: ServeConfig = { port, root, isolation, open };
  if (host !== undefined) config.host = host;
  const csp = str("csp") ?? envValue(env, "ARTIFACT_CSP");
  if (csp !== undefined) config.csp = csp;
  if (token !== undefined) config.token = token;
  return { ok: true, config, warnings };
}
