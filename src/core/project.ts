// Project identifiers (docs/decisions/0039): what the agent passes so `list` can return only the
// artifacts of the codebase it works in. Pure string handling, shared with the CLI.
//   git remote URL        → `<host>/<path>`, lowercased (scheme, userinfo, port, `.git` dropped)
//   `local:<absolute path>` → `local:<path>`, case kept, trailing `/` dropped
import { fail, invalidInput, ok, type Result } from "./errors.ts";

export const MAX_PROJECT_CHARS = 255;

const LOCAL = "local:";
const SCHEMES: ReadonlySet<string> = new Set(["https", "http", "ssh", "git"]);
// A DNS name or IPv4 address, or a bracketed IPv6 address.
const HOST = /^(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/;
const WINDOWS_DRIVE = /^([a-zA-Z]):[\\/]/;

const invalid = (raw: string, reason: string) =>
  fail(
    invalidInput(
      "project",
      `invalid project ${JSON.stringify(raw)}: ${reason}; pass the output of \`git remote get-url origin\`, or local: + an absolute path`,
    ),
  );

/** Normalise a project identifier; equal results mean the same project. Idempotent. */
export function normalizeProject(raw: string): Result<string> {
  const value = raw.trim();
  if (value === "") return invalid(raw, "empty");
  if (hasControl(value)) return invalid(raw, "contains a control character");
  const normalized = value.startsWith(LOCAL) ? localPath(value.slice(LOCAL.length)) : remote(value);
  if (normalized === undefined) return invalid(raw, "not a git remote URL or local: path");
  if (normalized.length > MAX_PROJECT_CHARS) {
    return fail(
      invalidInput(
        "project",
        `project exceeds ${MAX_PROJECT_CHARS} characters after normalisation`,
        MAX_PROJECT_CHARS,
      ),
    );
  }
  return ok(normalized);
}

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** POSIX `/…` or Windows `C:\…` / `C:/…` (as `C:/…`); trailing slashes dropped, root kept. */
function localPath(path: string): string | undefined {
  let p: string;
  let root: string;
  const drive = WINDOWS_DRIVE.exec(path);
  if (drive) {
    p = `${drive[1].toUpperCase()}:${path.slice(2).replaceAll("\\", "/")}`;
    root = `${drive[1].toUpperCase()}:/`;
  } else if (path.startsWith("/")) {
    p = path;
    root = "/";
  } else {
    return undefined;
  }
  p = p.replace(/\/+$/, "");
  return `${LOCAL}${p.length < root.length ? root : p}`;
}

/** `scheme://[user@]host[:port]/path`, scp-style `[user@]host:path`, or normalised `host/path`. */
function remote(url: string): string | undefined {
  let host: string;
  let path: string;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(url);
  if (scheme) {
    if (!SCHEMES.has(scheme[1].toLowerCase())) return undefined;
    const rest = scheme[2];
    const slash = rest.indexOf("/");
    if (slash < 0) return undefined;
    const authority = rest.slice(0, slash);
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    const port = /^(\[[^\]]*\]|[^:[\]]*)(?::[0-9]*)?$/.exec(hostPort);
    if (!port) return undefined;
    host = port[1];
    path = rest.slice(slash + 1);
  } else {
    // The first `/` or `:` outside a bracketed host decides: `/` is the normalised form, `:` scp.
    const at = url.indexOf("@");
    const slash0 = url.indexOf("/");
    const hostStart = at >= 0 && (slash0 < 0 || at < slash0) ? at + 1 : 0;
    const from = url[hostStart] === "[" ? url.indexOf("]", hostStart) + 1 : hostStart;
    if (from === 0 && hostStart > 0) return undefined; // unclosed `[`
    const sep = url.slice(from).search(/[/:]/);
    if (sep < 0) return undefined;
    const sepAt = from + sep;
    host = url.slice(hostStart, sepAt);
    path = url.slice(sepAt + 1);
    if (url[sepAt] === "/") {
      if (hostStart > 0) return undefined; // `user@host/path` is no git form
    } else if (host.length < 2) {
      return undefined; // `C:…` is a Windows path, not a host
    }
  }
  host = host.toLowerCase();
  if (!HOST.test(host)) return undefined;
  path = path.toLowerCase().replace(/^\/+/, "");
  for (let prev = ""; prev !== path; ) {
    prev = path;
    path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  }
  return path === "" ? undefined : `${host}/${path}`;
}
