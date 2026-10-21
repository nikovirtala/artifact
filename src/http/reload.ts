// `GET /__artifact/reload.js`: the platform's live-reload client (docs/decisions/0031). It is not
// stored in artifacts, so each deployment ships the client for its own transport: a one-line
// config prefix plus the shared client (docs/decisions/0058). Line 1 of the file is the local
// prefix, so the local script is the file as-is. The build copies the file next to this module
// (docs/decisions/0005).
import { readFileSync } from "node:fs";
import { securityHeaders } from "./headers.ts";

/** `none` has no entry in the client's transport table, so the page stays inert (0058, 0082). */
export type ReloadTransport = "sse" | "none";

export type ReloadClientConfig = {
  readonly transport: ReloadTransport;
  /** Host suffix of artifact subdomains, e.g. `.localhost`. */
  readonly viewSuffix: string;
  /** Whether `/a/<id>/` on the main host is an artifact page. */
  readonly pathMode: boolean;
};

/** The local server: SSE, `<id>.localhost`, path mode mounted in every isolation mode. */
export const LOCAL_RELOAD_CONFIG: ReloadClientConfig = Object.freeze({
  transport: "sse",
  viewSuffix: ".localhost",
  pathMode: true,
});

const CONFIG_PREFIX = "const __artifactReloadConfig = ";

const FILE = readFileSync(new URL("./reload-client.js", import.meta.url), "utf8");
const NEWLINE = FILE.indexOf("\n");
if (NEWLINE < 0 || !FILE.slice(0, NEWLINE).startsWith(CONFIG_PREFIX)) {
  throw new Error(`reload-client.js: line 1 must start with "${CONFIG_PREFIX}"`);
}
/** The client without its config line. */
const SHARED = FILE.slice(NEWLINE + 1);

/** The config line, as the formatter writes line 1 of the client file. */
export function renderReloadConfig(config: ReloadClientConfig): string {
  const { transport, viewSuffix, pathMode } = config;
  const fields = [
    `transport: ${JSON.stringify(transport)}`,
    `viewSuffix: ${JSON.stringify(viewSuffix)}`,
    `pathMode: ${JSON.stringify(pathMode)}`,
  ];
  return `${CONFIG_PREFIX}{ ${fields.join(", ")} };`;
}

/** The served script: the config line, then the shared client. */
export function reloadScript(config: ReloadClientConfig): string {
  return `${renderReloadConfig(config)}\n${SHARED}`;
}

export function reloadClient(config: ReloadClientConfig = LOCAL_RELOAD_CONFIG): Response {
  return new Response(reloadScript(config), {
    headers: {
      ...securityHeaders(),
      "Content-Type": "text/javascript; charset=utf-8",
      // Never reused without asking the server, so a server upgrade takes effect at once.
      "Cache-Control": "no-cache",
    },
  });
}
