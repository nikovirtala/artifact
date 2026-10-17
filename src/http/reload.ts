// `GET /__artifact/reload.js`: the platform's live-reload client (docs/decisions/0031). It is not
// stored in artifacts, so each deployment ships the client for its own transport. The build
// copies the file next to this module (docs/decisions/0005).
import { readFileSync } from "node:fs";
import { securityHeaders } from "./headers.ts";

const RELOAD_CLIENT: Uint8Array<ArrayBuffer> = new Uint8Array(
  readFileSync(new URL("./reload-client.js", import.meta.url)),
);

export function reloadClient(): Response {
  return new Response(RELOAD_CLIENT, {
    headers: {
      ...securityHeaders(),
      "Content-Type": "text/javascript; charset=utf-8",
      // Never reused without asking the server, so a server upgrade takes effect at once.
      "Cache-Control": "no-cache",
    },
  });
}
