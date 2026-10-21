// The session-keys custom resource (docs/decisions/0079): generates the session key set at deploy
// time and writes it to the KeyValueStore (the edge verifies with it) and then to the session
// secret (the viewing Lambda signs with it), so no key is ever in a template or an asset.
// The rotation label selects the current key: a new label generates one, a label already in the
// set makes that key current again, so a CloudFormation rollback restores the old key instead of
// rotating twice. Delete touches nothing. Any failure answers FAILED with a fixed reason and the
// deployment rolls back; the response PUT is what cfn-response does, as there is no Provider.
import { type KeySet, parseKeySet } from "../auth/session.ts";

export type SecretsPort = {
  /** The `SecretString`. */
  read(arn: string): Promise<string>;
  write(arn: string, value: string): Promise<void>;
};

export type KvsPort = {
  describe(arn: string): Promise<{ status: string; etag: string }>;
  /** Every key and value (all pages). */
  list(arn: string): Promise<Record<string, string>>;
  update(
    arn: string,
    input: { ifMatch: string; puts: { key: string; value: string }[]; deletes: string[] },
  ): Promise<void>;
};

export type EnsureDeps = {
  secrets: SecretsPort;
  kvs: KvsPort;
  randomBytes: (size: number) => Buffer;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type SessionKeysProps = { secretArn: string; kvsArn: string; rotation: string };

const POLL_MS = 2000;
const READY_TIMEOUT_MS = 60_000;
/** KVS edge propagation is "within seconds" with no stated bound (F11). */
const PROPAGATION_MS = 15_000;
const UPDATE_ATTEMPTS = 3;
const MAX_REASON = 256;
const RESPONSE_TIMEOUT_MS = 10_000;
const PHYSICAL_ID = "session-keys";
const NOT_READY: ReadonlySet<string> = new Set(["ConflictException", "ResourceNotFoundException"]);
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;
const KVS_ARN = /^arn:aws[a-z-]*:cloudfront::\d{12}:key-value-store\/[A-Za-z0-9-]+$/;
const ROTATION = /^[A-Za-z0-9._-]{1,64}$/;

/** A failure with `reason` = `<error name>: <fixed message>`; the SDK's message is never kept. */
export class SessionKeysError extends Error {
  override name = "SessionKeysError";
  readonly reason: string;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.reason = `${cause === undefined ? this.name : errorName(cause)}: ${message}`;
  }
}

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && ERROR_NAME.test(name) ? name : "Error";
}

async function call<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new SessionKeysError(message, error);
  }
}

const isConflict = (error: unknown) =>
  errorName(error) === "ConflictException" ||
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412;

/** The label's key as current and the other key (if any) as previous; a new key for a new label. */
function select(old: KeySet, rotation: string, randomBytes: EnsureDeps["randomBytes"]): KeySet {
  const entries = Object.entries(old.keys);
  const match = entries.find(([, entry]) => entry.rotation === rotation);
  let current: [string, KeySet["keys"][string]];
  let previous: [string, KeySet["keys"][string]] | undefined;
  if (match !== undefined) {
    current = match;
    previous = entries.find(([kid]) => kid !== match[0]);
  } else {
    let kid: string;
    do kid = randomBytes(8).toString("hex");
    while (Object.hasOwn(old.keys, kid));
    current = [kid, { key: randomBytes(32).toString("base64url"), rotation }];
    previous = old.current === null ? undefined : [old.current, old.keys[old.current]];
  }
  const keys = Object.fromEntries(previous === undefined ? [current] : [current, previous]);
  return { version: 1, current: current[0], keys };
}

function sameSet(a: KeySet, b: KeySet): boolean {
  const kids = Object.keys(a.keys);
  return (
    a.current === b.current &&
    kids.length === Object.keys(b.keys).length &&
    kids.every(
      (kid) =>
        Object.hasOwn(b.keys, kid) &&
        a.keys[kid].key === b.keys[kid].key &&
        a.keys[kid].rotation === b.keys[kid].rotation,
    )
  );
}

/** Polls every 2 s until the store is READY (F10); returns its ETag. */
async function waitReady(deps: EnsureDeps, arn: string): Promise<string> {
  const start = deps.now();
  for (;;) {
    try {
      const { status, etag } = await deps.kvs.describe(arn);
      const upper = status.toUpperCase();
      if (upper === "READY") return etag;
      // The docs say IMPORT_FAILED, the SDK's example IMPORT_FAILURE; either fails at once.
      if (upper.includes("FAIL")) throw new SessionKeysError("key value store not ready");
    } catch (error) {
      if (error instanceof SessionKeysError) throw error;
      if (!NOT_READY.has(errorName(error))) {
        throw new SessionKeysError("cannot describe the key value store", error);
      }
    }
    if (deps.now() - start >= READY_TIMEOUT_MS) {
      throw new SessionKeysError("key value store not ready");
    }
    await deps.sleep(POLL_MS);
  }
}

/** Create and Update: KVS first, the propagation wait if `current` changes, then the secret. */
export async function ensureSessionKeys(
  deps: EnsureDeps,
  props: SessionKeysProps,
): Promise<{ currentKid: string }> {
  const text = await call("cannot read the session secret", () =>
    deps.secrets.read(props.secretArn),
  );
  let old: KeySet;
  try {
    old = parseKeySet(text);
  } catch {
    throw new SessionKeysError("the session secret is malformed");
  }
  const next = select(old, props.rotation, deps.randomBytes);

  let etag = await waitReady(deps, props.kvsArn);
  for (let attempt = 1; ; attempt++) {
    const present = await call("cannot list the key value store", () =>
      deps.kvs.list(props.kvsArn),
    );
    const puts = Object.entries(next.keys).map(([key, { key: value }]) => ({ key, value }));
    const deletes = Object.keys(present).filter((key) => !Object.hasOwn(next.keys, key));
    if (deletes.length === 0 && puts.every(({ key, value }) => present[key] === value)) break;
    try {
      await deps.kvs.update(props.kvsArn, { ifMatch: etag, puts, deletes });
      break;
    } catch (error) {
      if (!isConflict(error))
        throw new SessionKeysError("cannot update the key value store", error);
      if (attempt >= UPDATE_ATTEMPTS) {
        throw new SessionKeysError("key value store update conflicts", error);
      }
    }
    etag = await waitReady(deps, props.kvsArn);
  }

  // The edge must have had time to see a new current kid before any Lambda signs with it (F11).
  if (next.current !== old.current) await deps.sleep(PROPAGATION_MS);
  if (!sameSet(next, old)) {
    await call("cannot write the session secret", () =>
      deps.secrets.write(props.secretArn, JSON.stringify(next)),
    );
  }
  return { currentKid: next.current as string };
}

type CfnEvent = {
  RequestType?: unknown;
  ResponseURL?: unknown;
  StackId?: unknown;
  RequestId?: unknown;
  LogicalResourceId?: unknown;
  PhysicalResourceId?: unknown;
  ResourceProperties?: Record<string, unknown>;
};

const REQUESTS: ReadonlySet<string> = new Set(["Create", "Update", "Delete"]);

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function properties(event: CfnEvent): SessionKeysProps {
  const p = event.ResourceProperties ?? {};
  const { SecretArn, KeyValueStoreArn, Rotation } = p;
  if (
    typeof SecretArn !== "string" ||
    !SECRET_ARN.test(SecretArn) ||
    typeof KeyValueStoreArn !== "string" ||
    !KVS_ARN.test(KeyValueStoreArn) ||
    typeof Rotation !== "string" ||
    !ROTATION.test(Rotation)
  ) {
    throw new SessionKeysError("invalid resource properties");
  }
  return { secretArn: SecretArn, kvsArn: KeyValueStoreArn, rotation: Rotation };
}

const log = (fields: Record<string, string>) =>
  console.log(`artifact session-keys ${JSON.stringify(fields)}`);

export function createSessionKeysHandler(deps: EnsureDeps & { fetch: typeof globalThis.fetch }) {
  return async (input: unknown): Promise<void> => {
    const event = (typeof input === "object" && input !== null ? input : {}) as CfnEvent;
    const request =
      typeof event.RequestType === "string" && REQUESTS.has(event.RequestType)
        ? event.RequestType
        : "unknown";
    if (!httpsUrl(event.ResponseURL)) {
      log({ request, result: "failed", name: "SessionKeysError" });
      throw new Error("artifact session-keys: the event has no https ResponseURL");
    }
    const physical =
      typeof event.PhysicalResourceId === "string" && event.PhysicalResourceId !== ""
        ? event.PhysicalResourceId
        : PHYSICAL_ID;

    let status: "SUCCESS" | "FAILED";
    let reason: string;
    let data: Record<string, string> = {};
    try {
      if (request === "unknown") throw new SessionKeysError("invalid request");
      if (request === "Delete") {
        reason = "nothing to delete";
      } else {
        const { currentKid } = await ensureSessionKeys(deps, properties(event));
        data = { CurrentKid: currentKid };
        reason = "session keys ensured";
      }
      status = "SUCCESS";
      log({ request, result: "ok" });
    } catch (error) {
      const failure =
        error instanceof SessionKeysError ? error : new SessionKeysError("unexpected error", error);
      status = "FAILED";
      reason = failure.reason;
      log({ request, result: "failed", name: failure.reason.split(":", 1)[0] });
    }

    const body = JSON.stringify({
      Status: status,
      Reason: reason.slice(0, MAX_REASON),
      PhysicalResourceId: request === "Create" && status === "SUCCESS" ? PHYSICAL_ID : physical,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      NoEcho: true,
      Data: data,
    });
    let code = 0;
    try {
      const res = await deps.fetch(event.ResponseURL, {
        method: "PUT",
        // The presigned S3 URL signs no content type.
        headers: { "content-type": "" },
        body,
        signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
      });
      code = res.status;
      if (res.ok) return;
    } catch {
      // Reported below with status 0.
    }
    console.log(`artifact session-keys response failed ${JSON.stringify({ status: code })}`);
    throw new Error(`artifact session-keys: the response PUT failed (status ${code})`);
  };
}
