// Key and prefix checks shared by the store adapters. The core only builds well-formed keys, so
// a malformed one is a programming error and throws.
import type { ListedObject, ListResult } from "../core/ports.ts";

function hasBadChar(s: string): boolean {
  return s.includes("\\") || s.includes("\0");
}

/** Non-empty `/`-separated segments, none empty, `.` or `..`; no backslash or NUL. */
export function assertValidKey(key: string): void {
  if (
    key === "" ||
    hasBadChar(key) ||
    key.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new TypeError(`invalid store key ${JSON.stringify(key)}`);
  }
}

/** Like a key, but may be empty or end with `/`. */
export function assertValidPrefix(prefix: string): void {
  if (prefix === "") return;
  assertValidKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

/** S3 ListObjectsV2 grouping of objects sorted by key. */
export function groupByDelimiter(
  prefix: string,
  sortedObjects: readonly ListedObject[],
  delimiter: string | undefined,
): ListResult {
  const objects: ListedObject[] = [];
  const commonPrefixes = new Set<string>();
  for (const object of sortedObjects) {
    const at = delimiter ? object.key.indexOf(delimiter, prefix.length) : -1;
    if (at < 0) objects.push(object);
    else commonPrefixes.add(object.key.slice(0, at + (delimiter?.length ?? 0)));
  }
  return { keys: objects.map((o) => o.key), objects, commonPrefixes: [...commonPrefixes].sort() };
}

/** Order listed objects by key, as S3 does (UTF-16 code unit order, like `Array#sort`). */
export function byKey(a: ListedObject, b: ListedObject): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
