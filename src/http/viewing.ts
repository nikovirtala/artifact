// Viewing routes (docs/decisions/0024): the current version at `<base>/`, pinned versions at
// `<base>/v/<n>/`, where base is `` on `<id>.localhost` and `/a/<id>` in path mode.
import type { ArtifactService } from "../core/artifact-service.ts";
import { plainText, securityHeaders } from "./headers.ts";

export type ViewingDeps = { service: ArtifactService; csp?: string };

const CANONICAL_VERSION = /^[1-9][0-9]*$/;
const CURRENT_CACHE = "no-cache";
const PINNED_CACHE = "public, max-age=31536000, immutable";

export function notFound(csp?: string): Response {
  return plainText(404, "not found\n", csp);
}

export function redirect(location: string, csp?: string): Response {
  return new Response(null, {
    status: 308,
    headers: { ...securityHeaders(csp), Location: location, "Cache-Control": "no-store" },
  });
}

/**
 * Serve `segments` (the raw, still percent-encoded path segments after `base`, so `/` is `[""]`)
 * of artifact `id`. The traversal guard has already rejected unsafe segments.
 */
export async function serveArtifact(
  deps: ViewingDeps,
  request: { id: string; base: string; segments: string[]; search: string },
): Promise<Response> {
  const { service, csp } = deps;
  const { id, base, search } = request;
  let segments = request.segments;
  let version: number | undefined;
  let prefix = base;
  if (segments[0] === "v") {
    const n = segments[1];
    if (n === undefined || !CANONICAL_VERSION.test(n) || !Number.isSafeInteger(Number(n))) {
      return notFound(csp);
    }
    prefix = `${base}/v/${n}`;
    if (segments.length === 2) return redirect(`${prefix}/${search}`, csp);
    version = Number(n);
    segments = segments.slice(2);
  }
  if (segments[0] === "__artifact") return notFound(csp); // platform assets, M3

  const decoded = segments.map((s) => decodeURIComponent(s));
  const last = decoded.at(-1) ?? "";
  if (last === "") {
    decoded[decoded.length - 1] = "index.html";
  } else if (!last.includes(".")) {
    // `/docs` → `/docs/` when that directory has an index page in this version.
    const index = await service.readServed(id, {
      version,
      path: `${decoded.join("/")}/index.html`,
    });
    return index.ok ? redirect(`${prefix}/${segments.join("/")}/${search}`, csp) : notFound(csp);
  }

  const file = await service.readServed(id, { version, path: decoded.join("/") });
  if (!file.ok) return notFound(csp);
  return new Response(file.value.body as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      ...securityHeaders(csp),
      "Content-Type": file.value.contentType,
      "Cache-Control": version === undefined ? CURRENT_CACHE : PINNED_CACHE,
    },
  });
}
