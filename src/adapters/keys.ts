// Key and prefix checks shared by the store adapters. The core only builds well-formed keys, so
// a malformed one is a programming error and throws.

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

/** S3 ListObjectsV2 grouping of sorted keys. */
export function groupByDelimiter(
  prefix: string,
  sortedKeys: readonly string[],
  delimiter: string | undefined,
): { keys: string[]; commonPrefixes: string[] } {
  if (delimiter === undefined || delimiter === "")
    return { keys: [...sortedKeys], commonPrefixes: [] };
  const keys: string[] = [];
  const commonPrefixes = new Set<string>();
  for (const key of sortedKeys) {
    const at = key.indexOf(delimiter, prefix.length);
    if (at < 0) keys.push(key);
    else commonPrefixes.add(key.slice(0, at + delimiter.length));
  }
  return { keys, commonPrefixes: [...commonPrefixes].sort() };
}
