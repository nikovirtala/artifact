// Deterministic test doubles for the core ports, plus a ready-wired service.
import { createMemoryStore, type MemoryStore } from "../../src/adapters/memory-store.ts";
import { ArtifactService } from "../../src/core/artifact-service.ts";
import type {
  ArtifactEvent,
  BlobStore,
  Clock,
  IdGen,
  Notifier,
  PointerStore,
} from "../../src/core/ports.ts";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export type FakeClock = Clock & { advance(ms: number): void };

export function fakeClock(start = Date.UTC(2026, 9, 17, 12, 0, 0)): FakeClock {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}

/** Sequential ULID-shaped ids: 0000…0001, 0000…0002, … */
export function fakeIdGen(): IdGen {
  let n = 0;
  return {
    next() {
      let id = "";
      for (let v = ++n; v > 0; v = Math.floor(v / 32)) id = CROCKFORD[v % 32] + id;
      return id.padStart(26, "0");
    },
  };
}

export type RecordingNotifier = Notifier & { events: ArtifactEvent[] };

export function recordingNotifier(onNotify?: (event: ArtifactEvent) => void): RecordingNotifier {
  const events: ArtifactEvent[] = [];
  return {
    events,
    async notify(event) {
      events.push(event);
      onNotify?.(event);
    },
  };
}

export type Harness = {
  service: ArtifactService;
  store: MemoryStore;
  notifier: RecordingNotifier;
  clock: FakeClock;
};

export function harness(
  options: {
    blobs?: BlobStore;
    pointers?: PointerStore;
    notifier?: RecordingNotifier;
    maxAttempts?: number;
  } = {},
): Harness {
  const store = createMemoryStore();
  const notifier = options.notifier ?? recordingNotifier();
  const clock = fakeClock();
  const service = new ArtifactService({
    blobs: options.blobs ?? store,
    pointers: options.pointers ?? store,
    notifier,
    clock,
    ids: fakeIdGen(),
    maxAttempts: options.maxAttempts,
  });
  return { service, store, notifier, clock };
}

export const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Unwrap an ok result or fail the test with the error. */
export function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}
