// Reload-snippet injection, done once at publish time into www/ html (src/ keeps the bytes as
// published). The script reads `data-version` to compare against `published` events.

export const RELOAD_SCRIPT_PATH = "/__artifact/reload.js";

export function reloadScriptTag(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new RangeError(`bad version ${version}`);
  return `<script src="${RELOAD_SCRIPT_PATH}" data-version="${version}" defer></script>`;
}

// A tag this module produced earlier, e.g. when html copied from a served page is republished.
const injectedTag = /<script src="\/__artifact\/reload\.js" data-version="\d+" defer><\/script>/gi;
const bodyClose = /<\/body\s*>/gi;

/**
 * Insert exactly one reload script tag before the last `</body>` (case-insensitive), or at the
 * end if there is none. Tags injected earlier are removed first, so the result never has two.
 */
export function injectReloadScript(html: string, version: number): string {
  const tag = reloadScriptTag(version);
  let stripped = html;
  for (let prev = ""; stripped !== prev; ) {
    prev = stripped;
    stripped = stripped.replace(injectedTag, "");
  }
  let last = -1;
  for (const match of stripped.matchAll(bodyClose)) last = match.index;
  if (last < 0) return stripped + tag;
  return stripped.slice(0, last) + tag + stripped.slice(last);
}

/**
 * Byte-level variant for stored files. Bytes map 1:1 to chars (latin1-style), so any
 * ASCII-compatible encoding (UTF-8, windows-1252, …) passes through unchanged apart from the tag.
 */
export function injectReloadScriptBytes(html: Uint8Array, version: number): Uint8Array {
  return binaryToBytes(injectReloadScript(bytesToBinary(html), version));
}

function bytesToBinary(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

function binaryToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
