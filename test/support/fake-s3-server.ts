// An in-process HTTP server speaking the S3 REST subset the S3 stores use (path-style object
// GET/HEAD/PUT/DELETE with If-None-Match / If-Match, ListObjectsV2), so adapter tests go through
// the real @aws-sdk/client-s3: header serialisation, XML error parsing and exception classes.
// Every operation is atomic: the body is read first, then the check and the write run without
// an await in between.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

export type FakeObject = { body: Uint8Array; etag: string; lastModified: Date };

export type FakeRequest = {
  method: string;
  bucket: string;
  key?: string;
  query: Record<string, string>;
  ifMatch?: string;
  ifNoneMatch?: string;
  status: number;
};

export type FakeS3Options = {
  /** Page size cap for ListObjectsV2 (S3's is 1,000). */
  maxKeys?: number;
  /** When a conditional PUT loses, answer 409 ConditionalRequestConflict instead of 412: at this rate (seeded), or when the predicate says so. */
  conflictOnLoss?: number | ((request: FakeRequest) => boolean);
  /** Seed of the PRNG behind a numeric `conflictOnLoss`. */
  seed?: number;
};

export type FakeS3 = {
  /** `http://127.0.0.1:<port>`, for an S3Client with `forcePathStyle: true`. */
  endpoint: string;
  /** Every request handled, in arrival order. */
  requests: FakeRequest[];
  /** Answer the next request matching `match` with this error, without applying it. */
  failNext(match: { method?: string; key?: string }, status: number, code: string): void;
  /** The live object map of `bucket`. */
  objects(bucket: string): Map<string, FakeObject>;
  close(): Promise<void>;
};

/** Mulberry32: a small seeded PRNG, so conflict injection is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Order as S3 does: by the UTF-8 bytes of the key. */
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Decode an `aws-chunked` body: `<hex size>[;ext]\r\n<data>\r\n` … `0\r\n<trailers>\r\n\r\n`. */
function decodeAwsChunked(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = raw.indexOf("\r\n", at);
    if (eol < 0) throw new Error("fake-s3: truncated aws-chunked body");
    const size = Number.parseInt(raw.subarray(at, eol).toString("latin1").split(";")[0], 16);
    if (size === 0) return Buffer.concat(parts);
    parts.push(raw.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  const encoding = req.headers["content-encoding"] ?? "";
  return req.headers["x-amz-decoded-content-length"] !== undefined ||
    encoding.includes("aws-chunked")
    ? decodeAwsChunked(raw)
    : raw;
}

function errorXml(code: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(code)} (fake)</Message><RequestId>fake</RequestId></Error>`;
}

export async function startFakeS3(options: FakeS3Options = {}): Promise<FakeS3> {
  const buckets = new Map<string, Map<string, FakeObject>>();
  const requests: FakeRequest[] = [];
  const failures: { match: { method?: string; key?: string }; status: number; code: string }[] = [];
  const random = prng(options.seed ?? 1);
  const conflict =
    typeof options.conflictOnLoss === "function"
      ? options.conflictOnLoss
      : (() => {
          const rate = options.conflictOnLoss ?? 0;
          return () => rate > 0 && random() < rate;
        })();

  const objects = (bucket: string) => {
    let map = buckets.get(bucket);
    if (!map) {
      map = new Map();
      buckets.set(bucket, map);
    }
    return map;
  };

  function send(
    res: ServerResponse,
    record: FakeRequest,
    status: number,
    headers: Record<string, string> = {},
    body?: string | Uint8Array,
  ) {
    record.status = status;
    res.writeHead(status, headers);
    res.end(body);
  }

  function fail(res: ServerResponse, record: FakeRequest, status: number, code: string) {
    if (record.method === "HEAD") return send(res, record, status);
    send(res, record, status, { "content-type": "application/xml" }, errorXml(code));
  }

  function list(
    res: ServerResponse,
    record: FakeRequest,
    map: Map<string, FakeObject>,
    query: Record<string, string>,
  ) {
    const prefix = query.prefix ?? "";
    const delimiter = query.delimiter || undefined;
    const pageSize = Math.min(Number(query["max-keys"] ?? 1000), options.maxKeys ?? 1000);
    const after =
      query["continuation-token"] !== undefined
        ? Buffer.from(query["continuation-token"], "base64").toString("utf8")
        : undefined;
    // The S3-ordered sequence: keys, and each common prefix once at its first key.
    const items: { key?: string; prefix?: string; sort: string }[] = [];
    const seen = new Set<string>();
    for (const key of [...map.keys()].filter((k) => k.startsWith(prefix)).sort(byBytes)) {
      const at = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
      if (at < 0) items.push({ key, sort: key });
      else {
        const common = key.slice(0, at + (delimiter?.length ?? 0));
        if (!seen.has(common)) {
          seen.add(common);
          items.push({ prefix: common, sort: common });
        }
      }
    }
    const remaining = after === undefined ? items : items.filter((i) => byBytes(i.sort, after) > 0);
    const page = remaining.slice(0, pageSize);
    const truncated = remaining.length > page.length;
    const contents = page.flatMap((i) => {
      if (i.key === undefined) return [];
      const object = map.get(i.key) as FakeObject;
      return [
        `<Contents><Key>${xmlEscape(i.key)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>${xmlEscape(object.etag)}</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      ];
    });
    const commons = page.flatMap((i) =>
      i.prefix === undefined
        ? []
        : [`<CommonPrefixes><Prefix>${xmlEscape(i.prefix)}</Prefix></CommonPrefixes>`],
    );
    const next = truncated
      ? `<NextContinuationToken>${Buffer.from(page[page.length - 1].sort).toString("base64")}</NextContinuationToken>`
      : "";
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${xmlEscape(record.bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>`,
      delimiter ? `<Delimiter>${xmlEscape(delimiter)}</Delimiter>` : "",
      `<KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys>`,
      `<IsTruncated>${truncated}</IsTruncated>`,
      ...contents,
      ...commons,
      next,
      "</ListBucketResult>",
    ].join("");
    send(res, record, 200, { "content-type": "application/xml" }, xml);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const [bucketPart, ...keyParts] = url.pathname.slice(1).split("/");
    const bucket = decodeURIComponent(bucketPart);
    const key = keyParts.length > 0 ? keyParts.map(decodeURIComponent).join("/") : undefined;
    const query = Object.fromEntries(url.searchParams);
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value.join(",") : value;
    };
    const record: FakeRequest = {
      method: req.method ?? "GET",
      bucket,
      key: key === "" ? undefined : key,
      query,
      ifMatch: header("if-match"),
      ifNoneMatch: header("if-none-match"),
      status: 0,
    };
    const body = await readBody(req);
    // Synchronous from here on: check and apply without an await.
    requests.push(record);
    const injected = failures.findIndex(
      ({ match }) =>
        (match.method === undefined || match.method === record.method) &&
        (match.key === undefined || match.key === record.key),
    );
    if (injected >= 0) {
      const [{ status, code }] = failures.splice(injected, 1);
      return fail(res, record, status, code);
    }
    const map = objects(bucket);
    if (record.key === undefined) {
      if (record.method === "GET" && query["list-type"] === "2")
        return list(res, record, map, query);
      return fail(res, record, 501, "NotImplemented");
    }
    const current = map.get(record.key);
    switch (record.method) {
      case "GET":
      case "HEAD": {
        if (!current) return fail(res, record, 404, "NoSuchKey");
        const headers = {
          etag: current.etag,
          "last-modified": current.lastModified.toUTCString(),
          "content-length": String(current.body.length),
          "content-type": "application/octet-stream",
        };
        return send(res, record, 200, headers, record.method === "GET" ? current.body : undefined);
      }
      case "PUT": {
        if (record.ifMatch !== undefined && !current) return fail(res, record, 404, "NoSuchKey");
        const lost =
          (record.ifNoneMatch === "*" && current !== undefined) ||
          (record.ifMatch !== undefined && current?.etag !== record.ifMatch);
        if (lost) {
          return conflict(record)
            ? fail(res, record, 409, "ConditionalRequestConflict")
            : fail(res, record, 412, "PreconditionFailed");
        }
        const etag = `"${createHash("md5").update(body).digest("hex")}"`;
        const lastModified = new Date(Math.floor(Date.now() / 1000) * 1000);
        map.set(record.key, { body: new Uint8Array(body), etag, lastModified });
        return send(res, record, 200, { etag });
      }
      case "DELETE":
        map.delete(record.key);
        return send(res, record, 204);
      default:
        return fail(res, record, 405, "MethodNotAllowed");
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      res.writeHead(500, { "content-type": "application/xml" });
      res.end(errorXml(`InternalError: ${error.message}`));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    failNext: (match, status, code) => failures.push({ match, status, code }),
    objects,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** An S3Client for the fake: path style, a fixed region and fake static credentials. */
export function fakeS3Client(endpoint: string, extra: Partial<S3ClientConfig> = {}): S3Client {
  return new S3Client({
    endpoint,
    forcePathStyle: true,
    region: "eu-north-1",
    credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
    ...extra,
  });
}
