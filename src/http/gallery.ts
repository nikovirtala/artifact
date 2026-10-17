// Read-only gallery at http://localhost:<port>/ (docs/decisions/0012): server-rendered, no JS.
import type { ArtifactSummary } from "../core/artifact-service.ts";

const entities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => entities[c]);
}

/** `2026-10-17T12:00:00.000Z` → `2026-10-17 12:00 UTC`. */
function displayTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** `items` in display order (the core lists newest first). */
export function renderGallery(
  items: readonly ArtifactSummary[],
  urlFor: (id: string) => string,
): string {
  const rows = items.map((a) => {
    const url = escapeHtml(urlFor(a.id));
    const title = a.title === undefined ? "<em>untitled</em>" : escapeHtml(a.title);
    const updated = escapeHtml(a.updatedAt);
    return `<li><a href="${url}">${title}</a> <span>v${a.currentVersion}</span> <time datetime="${updated}">${escapeHtml(displayTime(a.updatedAt))}</time></li>`;
  });
  const body = rows.length === 0 ? "<p>No artifacts yet.</p>" : `<ul>\n${rows.join("\n")}\n</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacts</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}
ul{list-style:none;padding:0}li{padding:.4rem 0;border-bottom:1px solid #8884}
span,time{color:#888;margin-left:.5rem;font-size:.9em}
</style>
</head>
<body>
<h1>Artifacts</h1>
${body}
</body>
</html>
`;
}
