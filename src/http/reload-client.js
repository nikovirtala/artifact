const __artifactReloadConfig = { transport: "sse", viewSuffix: ".localhost", pathMode: true };
// Live-reload client, served by the platform at /__artifact/reload.js (docs/decisions/0031).
// Plain JS, no build. Loaded by the tag inject.ts adds at publish time:
//   <script src="/__artifact/reload.js" data-version="<n>" defer></script>
// Current-version pages reload when the server reports another version; pinned /v/<n>/ pages
// stay inert. A deleted artifact gets a small banner instead of a reload into a 404.
// Line 1 is the deployment's config; the server swaps it for its own (docs/decisions/0058).
(() => {
  const ID = /^[0-9a-hjkmnp-tv-z]{26}$/;
  const VERSION = /^[1-9][0-9]*$/;
  const config =
    typeof __artifactReloadConfig === "object"
      ? __artifactReloadConfig
      : { transport: "sse", viewSuffix: ".localhost", pathMode: true };
  const SUFFIX = config.viewSuffix;

  /** `{id, pinned}` for an artifact page URL, or `undefined` for any other page. */
  function parsePage(hostname, pathname) {
    const host = hostname.toLowerCase();
    const segments = pathname.split("/").slice(1);
    let id;
    let rest;
    if (host.endsWith(SUFFIX) && ID.test(host.slice(0, -SUFFIX.length))) {
      id = host.slice(0, -SUFFIX.length);
      rest = segments;
    } else if (
      config.pathMode &&
      segments[0] === "a" &&
      ID.test((segments[1] ?? "").toLowerCase())
    ) {
      id = segments[1].toLowerCase();
      rest = segments.slice(2);
    } else {
      return undefined;
    }
    return { id, pinned: rest[0] === "v" && VERSION.test(rest[1] ?? "") };
  }

  function showDeleted() {
    const banner = document.createElement("div");
    banner.setAttribute("role", "status");
    banner.textContent = "This artifact was deleted.";
    // CSSOM assignments are not blocked by a style-src CSP, unlike a style attribute.
    Object.assign(banner.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483647",
      padding: "8px 12px",
      font: "13px/1.4 system-ui, sans-serif",
      color: "#fff",
      background: "rgba(32, 32, 32, 0.9)",
      borderRadius: "6px",
      pointerEvents: "none",
    });
    (document.body ?? document.documentElement).appendChild(banner);
  }

  // Server-sent events: the server sends the current version first on every (re)connect
  // (docs/decisions/0028).
  function connectSse(page, loaded) {
    if (typeof EventSource !== "function") return;
    const source = new EventSource(`/__artifact/events?id=${page.id}`);
    source.addEventListener("published", (event) => {
      let version;
      try {
        version = JSON.parse(event.data).version;
      } catch {
        return;
      }
      if (!Number.isSafeInteger(version) || version === loaded) return;
      source.close();
      location.reload();
    });
    source.addEventListener("deleted", () => {
      source.close();
      showDeleted();
    });
  }

  // An unknown transport leaves the page inert.
  const transports = new Map([["sse", connectSse]]);

  const script = document.currentScript;
  const loaded = Number(script?.getAttribute("data-version"));
  const page = parsePage(location.hostname, location.pathname);
  if (!page || page.pinned || !Number.isSafeInteger(loaded) || loaded < 1) return;
  transports.get(config.transport)?.(page, loaded);
})();
