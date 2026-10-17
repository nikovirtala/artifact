// BlobStore + PointerStore on local disk. Key `a/b/c` lives at `<root>/a/b/c`, so the tree under
// the root is the same layout as the S3 bucket. Scratch files go to `<root>/.tmp/`, which is
// never a key; neither is the server lock `<root>/.lock` (docs/decisions/0026). Conditional writes:
// - create-only (`ifNoneMatch: "*"`): exclusive open with the `wx` flag;
// - pointer compare-and-swap: under a per-key lock, compare the etag (sha256 of the bytes),
//   write a temp file and rename it over the target, so readers see old or new, never partial.
// The lock is in-process; one server process per root is assumed (see docs/decisions).
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  BlobStore,
  ListOptions,
  ListResult,
  PointerObject,
  PointerStore,
  WriteCondition,
  WriteResult,
} from "../core/ports.ts";
import { assertValidKey, assertValidPrefix, groupByDelimiter } from "./keys.ts";

export type FsStore = BlobStore & PointerStore;

export type FsStoreOptions = {
  /** Directory holding the key tree; created on first write. */
  root: string;
};

const TMP = ".tmp";
const LOCK = ".lock";

/** Root entries that are not part of the key tree. */
const isReserved = (name: string) => name === TMP || name === LOCK;
const RETRIES = 5;

const preconditionFailed: WriteResult = { ok: false, reason: "precondition_failed" };

// Per-file lock chains, shared by every store instance in the process.
const locks = new Map<string, Promise<void>>();

async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const tail = previous.then(() => held);
  locks.set(file, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(file) === tail) locks.delete(file);
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function etagOf(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createFsStore(options: FsStoreOptions): FsStore {
  const root = resolve(options.root);
  const tmpDir = join(root, TMP);

  function fileFor(key: string): string {
    assertValidKey(key);
    if (isReserved(key.split("/", 1)[0])) {
      throw new TypeError(`invalid store key ${JSON.stringify(key)}`);
    }
    return join(root, ...key.split("/"));
  }

  async function readBytes(file: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(file));
    } catch (error) {
      if (["ENOENT", "EISDIR", "ENOTDIR"].includes(code(error) ?? "")) return undefined;
      throw error;
    }
  }

  // Retries cover a concurrent delete pruning the parent directory between mkdir and use.
  async function inParentDir<T>(file: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await mkdir(dirname(file), { recursive: true });
      try {
        return await fn();
      } catch (error) {
        if (code(error) !== "ENOENT" || attempt >= RETRIES) throw error;
      }
    }
  }

  async function replace(file: string, body: Uint8Array): Promise<void> {
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomUUID());
    await writeFile(tmp, body);
    try {
      await inParentDir(file, () => rename(tmp, file));
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async function createExclusive(file: string, body: Uint8Array): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await inParentDir(file, () => open(file, "wx"));
    } catch (error) {
      if (code(error) === "EEXIST") return false;
      throw error;
    }
    try {
      await handle.writeFile(body);
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(file).catch(() => {});
      throw error;
    }
    return true;
  }

  async function remove(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch (error) {
      if (!["ENOENT", "EISDIR", "ENOTDIR"].includes(code(error) ?? "")) throw error;
    }
    // Prune empty parents so deleted prefixes do not linger as directories.
    for (let dir = dirname(file); dir !== root && dir.startsWith(root); dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
    }
  }

  async function entries(dir: string): Promise<Dirent[]> {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(code(error) ?? "")) return [];
      throw error;
    }
  }

  async function walk(dir: string, keyPrefix: string, out: string[]): Promise<void> {
    for (const entry of await entries(dir)) {
      if (keyPrefix === "" && isReserved(entry.name)) continue;
      const key = keyPrefix + entry.name;
      if (entry.isFile()) out.push(key);
      else if (entry.isDirectory()) await walk(join(dir, entry.name), `${key}/`, out);
    }
  }

  async function hasFile(dir: string): Promise<boolean> {
    for (const entry of await entries(dir)) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && (await hasFile(join(dir, entry.name)))) return true;
    }
    return false;
  }

  return {
    async get(key: string): Promise<Uint8Array | undefined> {
      return readBytes(fileFor(key));
    },

    async put(key: string, body: Uint8Array, opts?: { ifNoneMatch?: "*" }): Promise<WriteResult> {
      const file = fileFor(key);
      if (opts?.ifNoneMatch === "*") {
        if (!(await createExclusive(file, body))) return preconditionFailed;
      } else {
        await replace(file, body);
      }
      return { ok: true, etag: etagOf(body) };
    },

    async list(prefix: string, opts?: ListOptions): Promise<ListResult> {
      assertValidPrefix(prefix);
      const dirKey = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      const namePrefix = prefix.slice(dirKey.length);
      const dir = join(root, ...dirKey.split("/").filter(Boolean));
      if (opts?.delimiter === "/") {
        // One directory level: files are keys, non-empty directories are common prefixes.
        const keys: string[] = [];
        const commonPrefixes: string[] = [];
        for (const entry of await entries(dir)) {
          if (!entry.name.startsWith(namePrefix) || (dirKey === "" && isReserved(entry.name)))
            continue;
          if (entry.isFile()) keys.push(dirKey + entry.name);
          else if (entry.isDirectory() && (await hasFile(join(dir, entry.name)))) {
            commonPrefixes.push(`${dirKey}${entry.name}/`);
          }
        }
        return { keys: keys.sort(), commonPrefixes: commonPrefixes.sort() };
      }
      const all: string[] = [];
      await walk(dir, dirKey, all);
      const keys = all.filter((k) => k.startsWith(prefix)).sort();
      return groupByDelimiter(prefix, keys, opts?.delimiter);
    },

    async delete(key: string): Promise<void> {
      const file = fileFor(key);
      await withLock(file, () => remove(file));
    },

    async read(key: string): Promise<PointerObject | undefined> {
      const body = await readBytes(fileFor(key));
      return body && { body, etag: etagOf(body) };
    },

    async write(key: string, body: Uint8Array, condition: WriteCondition): Promise<WriteResult> {
      const file = fileFor(key);
      return withLock(file, async () => {
        const current = await readBytes(file);
        const matches =
          "ifNoneMatch" in condition
            ? current === undefined
            : current !== undefined && etagOf(current) === condition.ifMatch;
        if (!matches) return preconditionFailed;
        await replace(file, body);
        return { ok: true, etag: etagOf(body) };
      });
    },
  };
}
