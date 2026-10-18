// In-memory BlobStore + PointerStore for tests. One key space, like a single S3 bucket.
// Each operation is atomic: the check and the write happen without an intervening await.
import type {
  BlobStore,
  ListOptions,
  ListResult,
  PointerObject,
  PointerStore,
  WriteCondition,
  WriteResult,
} from "../core/ports.ts";
import { assertValidKey, assertValidPrefix, byKey, groupByDelimiter } from "./keys.ts";

export type MemoryStore = BlobStore & PointerStore;

export type MemoryStoreOptions = {
  /** Source of `lastModified` for each write; tests pass the fake clock. */
  now?: () => Date;
};

type Entry = { body: Uint8Array; etag: string; lastModified: Date };

const preconditionFailed: WriteResult = { ok: false, reason: "precondition_failed" };

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const now = options.now ?? (() => new Date());
  const entries = new Map<string, Entry>();
  let counter = 0;

  function set(key: string, body: Uint8Array): WriteResult {
    const etag = `"${++counter}"`;
    entries.set(key, { body: body.slice(), etag, lastModified: new Date(now()) });
    return { ok: true, etag };
  }

  async function remove(key: string): Promise<void> {
    assertValidKey(key);
    entries.delete(key);
  }

  return {
    async get(key: string): Promise<Uint8Array | undefined> {
      assertValidKey(key);
      return entries.get(key)?.body.slice();
    },

    async put(
      key: string,
      body: Uint8Array,
      options?: { ifNoneMatch?: "*" },
    ): Promise<WriteResult> {
      assertValidKey(key);
      if (options?.ifNoneMatch === "*" && entries.has(key)) return preconditionFailed;
      return set(key, body);
    },

    async list(prefix: string, options?: ListOptions): Promise<ListResult> {
      assertValidPrefix(prefix);
      const objects = [...entries]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({ key, lastModified: new Date(entry.lastModified) }))
        .sort(byKey);
      return groupByDelimiter(prefix, objects, options?.delimiter);
    },

    async read(key: string): Promise<PointerObject | undefined> {
      assertValidKey(key);
      const entry = entries.get(key);
      return entry && { body: entry.body.slice(), etag: entry.etag };
    },

    async write(key: string, body: Uint8Array, condition: WriteCondition): Promise<WriteResult> {
      assertValidKey(key);
      const current = entries.get(key);
      if (
        "ifNoneMatch" in condition ? current !== undefined : current?.etag !== condition.ifMatch
      ) {
        return preconditionFailed;
      }
      return set(key, body);
    },

    delete: remove,
  };
}
