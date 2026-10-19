// BlobStore + PointerStore on one S3 bucket (docs/decisions/0060). Conditional writes are the
// lock: `If-None-Match: *` for claims and create-if-absent, `If-Match: <etag>` for the pointer
// compare-and-swap. A lost condition is a normal `precondition_failed` result; every other
// error throws. Etags are S3's, passed back verbatim (quotes included).
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assertValidKey, assertValidPrefix, byKey } from "../../adapters/keys.ts";
import type {
  BlobStore,
  ListedObject,
  ListOptions,
  ListResult,
  PointerObject,
  PointerStore,
  WriteCondition,
  WriteResult,
} from "../../core/ports.ts";

export type S3StoreOptions = {
  client: Pick<S3Client, "send">;
  bucket: string;
  /** Key space inside the bucket: `""` or a valid prefix ending in `/`. */
  prefix?: string;
};

export type S3Store = BlobStore & PointerStore;

const preconditionFailed: WriteResult = { ok: false, reason: "precondition_failed" };

type S3Error = { name?: unknown; $metadata?: { httpStatusCode?: unknown } };

function errorParts(error: unknown): { status: unknown; name: unknown } {
  if (typeof error !== "object" || error === null) return { status: undefined, name: undefined };
  const e = error as S3Error;
  return { status: e.$metadata?.httpStatusCode, name: e.name };
}

/**
 * Whether an S3 error means the write's condition did not hold:
 * 412 (the condition failed), 409 `ConditionalRequestConflict` (a concurrent conditional write
 * or delete won), and for `ifMatch` only, 404 on the key (there is no object to match).
 */
export function isConditionFailure(error: unknown, condition: "ifNoneMatch" | "ifMatch"): boolean {
  const { status, name } = errorParts(error);
  if (status === 412) return true;
  if (status === 409) return name === "ConditionalRequestConflict";
  if (status === 404) return condition === "ifMatch" && name !== "NoSuchBucket";
  return false;
}

/** An absent key on GetObject: 404 `NoSuchKey`. A missing bucket still throws. */
function isNoSuchKey(error: unknown): boolean {
  const { status, name } = errorParts(error);
  return status === 404 && name === "NoSuchKey";
}

function checkedPrefix(prefix: string): string {
  if (prefix !== "" && !prefix.endsWith("/")) {
    throw new TypeError(`invalid S3 store prefix ${JSON.stringify(prefix)}: must end with "/"`);
  }
  try {
    assertValidPrefix(prefix);
  } catch {
    throw new TypeError(`invalid S3 store prefix ${JSON.stringify(prefix)}`);
  }
  return prefix;
}

/** The bucket, prefix and requests both stores share. */
class S3Keyspace {
  readonly #client: Pick<S3Client, "send">;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(options: S3StoreOptions) {
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#prefix = checkedPrefix(options.prefix ?? "");
  }

  /** Body and etag of `key`, or `undefined` if absent. */
  async get(key: string): Promise<PointerObject | undefined> {
    assertValidKey(key);
    try {
      const out = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: this.#prefix + key }),
      );
      // transformToByteArray returns a fresh array, so callers' mutations stay isolated.
      const body = (await out.Body?.transformToByteArray()) ?? new Uint8Array();
      return { body, etag: requireEtag(out.ETag, key) };
    } catch (error) {
      if (isNoSuchKey(error)) return undefined;
      throw error;
    }
  }

  async put(key: string, body: Uint8Array, condition?: WriteCondition): Promise<WriteResult> {
    assertValidKey(key);
    const kind = condition && ("ifNoneMatch" in condition ? "ifNoneMatch" : "ifMatch");
    try {
      const out = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: this.#prefix + key,
          Body: body,
          ...(condition && "ifNoneMatch" in condition
            ? { IfNoneMatch: condition.ifNoneMatch }
            : {}),
          ...(condition && "ifMatch" in condition ? { IfMatch: condition.ifMatch } : {}),
        }),
      );
      return { ok: true, etag: requireEtag(out.ETag, key) };
    } catch (error) {
      if (kind && isConditionFailure(error, kind)) return preconditionFailed;
      throw error;
    }
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    assertValidPrefix(prefix);
    const strip = this.#prefix.length;
    const objects: ListedObject[] = [];
    const commonPrefixes = new Set<string>();
    let token: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this.#prefix + prefix,
          Delimiter: options?.delimiter,
          ContinuationToken: token,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key === undefined || item.LastModified === undefined) continue;
        objects.push({ key: item.Key.slice(strip), lastModified: new Date(item.LastModified) });
      }
      for (const item of page.CommonPrefixes ?? []) {
        if (item.Prefix !== undefined) commonPrefixes.add(item.Prefix.slice(strip));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    // S3 orders by UTF-8 bytes; the stores order by UTF-16 code units (keys.ts byKey).
    objects.sort(byKey);
    return { keys: objects.map((o) => o.key), objects, commonPrefixes: [...commonPrefixes].sort() };
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#prefix + key }),
    );
  }
}

function requireEtag(etag: string | undefined, key: string): string {
  if (etag === undefined) throw new Error(`S3 returned no ETag for ${JSON.stringify(key)}`);
  return etag;
}

export class S3BlobStore implements BlobStore {
  readonly #keys: S3Keyspace;

  constructor(options: S3StoreOptions) {
    this.#keys = new S3Keyspace(options);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return (await this.#keys.get(key))?.body;
  }

  put(key: string, body: Uint8Array, options?: { ifNoneMatch?: "*" }): Promise<WriteResult> {
    return this.#keys.put(key, body, options?.ifNoneMatch ? { ifNoneMatch: "*" } : undefined);
  }

  list(prefix: string, options?: ListOptions): Promise<ListResult> {
    return this.#keys.list(prefix, options);
  }

  delete(key: string): Promise<void> {
    return this.#keys.delete(key);
  }
}

export class S3PointerStore implements PointerStore {
  readonly #keys: S3Keyspace;

  constructor(options: S3StoreOptions) {
    this.#keys = new S3Keyspace(options);
  }

  read(key: string): Promise<PointerObject | undefined> {
    return this.#keys.get(key);
  }

  write(key: string, body: Uint8Array, condition: WriteCondition): Promise<WriteResult> {
    return this.#keys.put(key, body, condition);
  }

  delete(key: string): Promise<void> {
    return this.#keys.delete(key);
  }
}

/** One object implementing both ports on the same bucket and prefix, like the fs store. */
export function createS3Store(options: S3StoreOptions): S3Store {
  const blobs = new S3BlobStore(options);
  const pointers = new S3PointerStore(options);
  return {
    get: (key) => blobs.get(key),
    put: (key, body, putOptions) => blobs.put(key, body, putOptions),
    list: (prefix, listOptions) => blobs.list(prefix, listOptions),
    delete: (key) => blobs.delete(key),
    read: (key) => pointers.read(key),
    write: (key, body, condition) => pointers.write(key, body, condition),
  };
}
