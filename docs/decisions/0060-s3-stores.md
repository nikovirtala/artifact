# 0060. `S3BlobStore` / `S3PointerStore`: conditional writes, error mapping, key prefix

Status: Accepted (M8)

## Context

M8 of `docs/01-plan-aws.md` implements the `BlobStore` / `PointerStore` ports (`src/core/ports.ts`) on S3, so the publish protocol (claims with `If-None-Match: *`, pointer compare-and-swap with `If-Match`, 0015) runs unchanged on a bucket. The plan's facts V1 and V2 had to be checked first; the fallbacks were a DynamoDB pointer (V1) and a bundled SDK (V2).

## Decision

- `src/runtime/adapters/s3-store.ts` (placed per 0059) exports `S3BlobStore`, `S3PointerStore`, `createS3Store(options)` (one object implementing both, like the memory and fs stores) and `isConditionFailure`. Options: an injected `client` (`Pick<S3Client, "send">`), `bucket`, and an optional `prefix` that is `""` or a valid prefix ending in `/` (else `TypeError`). Keys are sent as `prefix + key`; listed keys and common prefixes come back without it.
- Writes are `PutObject` with `IfNoneMatch: "*"` or `IfMatch: <etag>`. Etags are S3's, opaque and passed back verbatim, quotes included. They are MD5-based, so identical bytes give the same etag; that is harmless because every pointer move changes `updatedAt`.
- Reads are `GetObject`; `Body.transformToByteArray()` gives a fresh array. `list` loops `ListObjectsV2` with `Prefix`, `Delimiter` and `ContinuationToken`, then re-sorts by UTF-16 code units (`byKey`, like the other stores), because S3 orders by UTF-8 bytes. `delete` is an unconditional `DeleteObject`.
- Malformed keys and prefixes throw `TypeError` before any request (`assertValidKey` / `assertValidPrefix`).

### Error mapping

| S3 response | `put`/`write` with `ifNoneMatch: "*"` | `write` with `ifMatch` | unconditional `put`, `get`, `read`, `list`, `delete` |
| --- | --- | --- | --- |
| 412 `PreconditionFailed` | `precondition_failed` | `precondition_failed` | throw |
| 409 `ConditionalRequestConflict` | `precondition_failed` | `precondition_failed` | throw |
| 409, any other code (e.g. `OperationAborted`) | throw | throw | throw |
| 404 `NoSuchKey` | throw | `precondition_failed` (V1f) | `get`/`read` → `undefined`; others throw |
| 404 `NoSuchBucket` | throw | throw | throw |
| anything else (403, 400, 5xx after SDK retries, network) | throw | throw | throw |

After `precondition_failed` the protocol re-reads the pointer and retries (0015), which is what S3 recommends after a 409. A 404 on `If-Match` means there is no pointer to swap, as on the v1 stores: the protocol then finds it absent and returns `not_found`.

### No conditional delete (V1g)

`DeleteObject` supports `If-Match`, but the protocol does not need it. The port's deletes are unconditional and deleting an absent key is not an error (S3 returns 204). `service.delete` removes the pointer first. A publish racing a delete sees 404 or 409 on its CAS or claim, maps it to `precondition_failed`, re-reads and gets `not_found`; its leftover objects are orphans for the sweep (0047). `pruneVersions` moves the pointer by CAS before deleting objects (0052).

### No lockfile

The single-server lockfile (0026) is not used on S3 (plan gap 7): conditional writes are the lock, so any number of processes may publish to one bucket.

### Residue

If a conditional write succeeds but its response is lost, the SDK's retry sees 412. For a claim this leaves an orphan for the sweep. For a pointer CAS the version did commit; without `ifVersion` the publish then commits the same files again under the next number, and with `ifVersion` it reports `version_conflict` for a publish that landed. Version numbers are never duplicated or lost. This is rare (a lost response on a successful write), and S3 offers no idempotency key for `PutObject` to close it.

## AWS facts

**V1 holds.** On a general purpose bucket:

- `PutObject` supports `If-None-Match: *` and `If-Match: <etag>`; a mismatch returns 412 ([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)). `If-Match` needs `s3:PutObject` and `s3:GetObject`.
- Of concurrent conditional writes to one key, the first to finish wins and the rest get 412 ([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)).
- A conflicting operation during the upload returns 409 `ConditionalRequestConflict`; S3 says to fetch the ETag and retry ([PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)).
- Reads and lists after a write are strongly consistent; single-key updates are atomic ([consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)).
- V1f: `If-Match` on a key with no current object fails with 404 ([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)), hence the extra mapping above.
- V1g: `DeleteObject` supports `If-Match` ([DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)); not used.

**V2 holds.** `IfNoneMatch` on `PutObject` arrived in `@aws-sdk/client-s3` 3.635.0 and `IfMatch` in 3.700.0 ([client-s3 CHANGELOG](https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-s3/CHANGELOG.md)). The Lambda docs do not list the bundled SDK version, only that each runtime includes a specific minor version ([Node.js runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)). The AWS-published base image of the same runtime, `public.ecr.aws/lambda/nodejs:24` (linux/arm64), ships client-s3 3.1105.0, whose `PutObject` schema has both parameters. M9's first deployed smoke test logs the managed runtime's version in eu-north-1 to confirm it.

## Consequences

The v1 contract suite runs against the S3 stores over a fake endpoint through the real SDK (also with 409 on lost races) and against a real bucket when `ARTIFACT_TEST_BUCKET` is set (`test/contract/s3-store.test.ts`). `test/runtime/s3-store.test.ts` covers every cell of the error table. No DynamoDB and no bundled SDK are needed.
