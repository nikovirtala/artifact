// Response headers for artifact pages, the gallery and API file reads (docs/decisions/0025).

export const GALLERY_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** HTML read back through the API sits on the API origin and must never run. */
export const API_FILE_CSP = "default-src 'none'; sandbox";

/** Always sent on artifact pages; `csp` only when configured (`--csp` / `ARTIFACT_CSP`). */
export function securityHeaders(csp?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (csp !== undefined) headers["Content-Security-Policy"] = csp;
  return headers;
}

export function plainText(status: number, text: string, csp?: string): Response {
  return new Response(text, {
    status,
    headers: { ...securityHeaders(csp), "Content-Type": "text/plain; charset=utf-8" },
  });
}
