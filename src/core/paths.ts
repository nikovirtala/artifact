// File-path normalisation and validation, content types, and the storage key layout:
//   artifacts/<id>/meta.json
//   artifacts/<id>/v/<n>/manifest.json
//   artifacts/<id>/v/<n>/src/<path>
//   artifacts/<id>/v/<n>/www/<path>

import { fail, type InvalidPath, invalidPath, ok, type Result } from "./errors.ts";

export const MAX_FILES_PER_PUBLISH = 255;

export const ENTRY_PAGE = "index.html";

const contentTypes: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** Content type for an allowlisted extension (case-insensitive), or `undefined`. */
export function contentTypeFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(contentTypes, ext) ? contentTypes[ext] : undefined;
}

export function isHtml(path: string): boolean {
  return contentTypeFor(path)?.startsWith("text/html") === true;
}

/**
 * Normalise a relative file path: drop `.` segments and the empty segments left by repeated
 * `/`. Rejects empty paths, absolute paths, drive letters, backslashes, NUL and other control
 * characters, `..` segments and directory paths (trailing `/`). The result never resolves
 * outside the directory it is joined to.
 */
export function normalizePath(path: string): Result<string, InvalidPath> {
  if (path.length === 0) return fail(invalidPath(path, "empty"));
  if (hasControlCharacter(path)) return fail(invalidPath(path, "control character"));
  if (path.includes("\\")) return fail(invalidPath(path, "backslash"));
  if (path.startsWith("/")) return fail(invalidPath(path, "absolute path"));
  if (/^[a-zA-Z]:/.test(path)) return fail(invalidPath(path, "drive letter"));
  if (path.endsWith("/")) return fail(invalidPath(path, "directory, not a file"));
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return fail(invalidPath(path, "'..' segment"));
  if (segments.length === 0) return fail(invalidPath(path, "empty"));
  const normalized = segments.join("/");
  // Dropping a leading `./` can expose a drive prefix (`./c:x` → `c:x`).
  if (/^[a-zA-Z]:/.test(normalized)) return fail(invalidPath(path, "drive letter"));
  return ok(normalized);
}

function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export type ValidFile = { path: string; contentType: string };

/** Normalise `path` and require an allowlisted extension. */
export function validateFilePath(path: string): Result<ValidFile, InvalidPath> {
  const normalized = normalizePath(path);
  if (!normalized.ok) return normalized;
  const contentType = contentTypeFor(normalized.value);
  if (contentType === undefined) return fail(invalidPath(path, "file type not allowed"));
  return ok({ path: normalized.value, contentType });
}

const artifactIdPattern = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** 26-char lowercase Crockford base32 (ULID alphabet). */
export function isArtifactId(id: string): boolean {
  return artifactIdPattern.test(id);
}

export const ARTIFACTS_PREFIX = "artifacts/";

export function artifactPrefix(id: string): string {
  return `${ARTIFACTS_PREFIX}${id}/`;
}

export function metaKey(id: string): string {
  return `${artifactPrefix(id)}meta.json`;
}

export function versionPrefix(id: string, version: number): string {
  return `${artifactPrefix(id)}v/${version}/`;
}

export function manifestKey(id: string, version: number): string {
  return `${versionPrefix(id, version)}manifest.json`;
}

/** `path` must already be normalised by `normalizePath`. */
export function srcKey(id: string, version: number, path: string): string {
  return `${versionPrefix(id, version)}src/${path}`;
}

/** `path` must already be normalised by `normalizePath`. */
export function wwwKey(id: string, version: number, path: string): string {
  return `${versionPrefix(id, version)}www/${path}`;
}
