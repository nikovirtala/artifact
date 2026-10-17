// Ports the core talks through. Shapes follow S3 semantics (string keys, opaque etags,
// If-None-Match / If-Match preconditions, prefix + delimiter listing) so an S3 adapter can
// implement them without changing the core. Adapters throw only on I/O failures; a failed
// precondition is a normal result.

/** Write precondition: create-only (`If-None-Match: *`) or compare-and-swap (`If-Match: <etag>`). */
export type WriteCondition = { ifNoneMatch: "*" } | { ifMatch: string };

export type WriteResult = { ok: true; etag: string } | { ok: false; reason: "precondition_failed" };

export type ListOptions = {
  /** Group keys sharing `prefix + … + delimiter` into `commonPrefixes`, like S3 ListObjectsV2. */
  delimiter?: string;
};

export type ListResult = {
  /** Keys starting with the prefix (and, with a delimiter, not containing it after the prefix), sorted. */
  keys: string[];
  /** With a delimiter: distinct `prefix + segment + delimiter` values that have at least one key, sorted. */
  commonPrefixes: string[];
};

/** Immutable-by-convention objects: version files and manifests. */
export interface BlobStore {
  /** Bytes stored under `key`, or `undefined` if absent. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Store `body` under `key`. With `ifNoneMatch: "*"` the put only succeeds if the key is absent. */
  put(key: string, body: Uint8Array, options?: { ifNoneMatch?: "*" }): Promise<WriteResult>;
  /** Keys starting with `prefix` (plain string prefix, as in S3). */
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
  /** Remove `key`; removing an absent key is not an error. */
  delete(key: string): Promise<void>;
}

export type PointerObject = { body: Uint8Array; etag: string };

/** The single mutable object per artifact (`meta.json`), written only with a precondition. */
export interface PointerStore {
  /** Current body and etag, or `undefined` if absent. */
  read(key: string): Promise<PointerObject | undefined>;
  /** Create-if-absent (`ifNoneMatch: "*"`) or compare-and-swap on the etag from `read` (`ifMatch`). */
  write(key: string, body: Uint8Array, condition: WriteCondition): Promise<WriteResult>;
  /** Remove `key`; removing an absent key is not an error. */
  delete(key: string): Promise<void>;
}

/** `published` after the pointer moves (publish or rollback); `deleted` after a delete. */
export type ArtifactEvent =
  | { type: "published"; id: string; version: number }
  | { type: "deleted"; id: string };

export interface Notifier {
  notify(event: ArtifactEvent): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGen {
  /** A new artifact id: 26-char lowercase ULID. */
  next(): string;
}
