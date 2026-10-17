// `GET /__artifact/events?id=<id>`: the live-reload stream for one artifact (docs/decisions/0028
// to 0030, 0032). On every (re)connect the current version is sent first, so a tab that missed a
// publish while disconnected learns about it; then `published` and `deleted` events follow.
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ArtifactService } from "../core/artifact-service.ts";
import type { ArtifactEvent } from "../core/ports.ts";
import { securityHeaders } from "./headers.ts";

/** Per-artifact subscriptions; the in-process notifier provides this locally. */
export type ArtifactEvents = {
  /** Returns the unsubscribe function. */
  subscribe(id: string, listener: (event: ArtifactEvent) => void): () => void;
};

export type SseDeps = {
  service: ArtifactService;
  events: ArtifactEvents;
  /** Interval between heartbeat comments (default 20 s). */
  heartbeatMs?: number;
};

export const HEARTBEAT_MS = 20_000;
/** EventSource reconnect delay, sent with the first event. */
export const RETRY_MS = 1000;

const published = (version: number) => ({
  event: "published",
  id: String(version),
  data: JSON.stringify({ version }),
});
const deleted = { event: "deleted", data: "{}" };

/**
 * Stream events for artifact `id` (already lowercased). The caller has checked that it exists;
 * a delete between that check and the subscription is reported as `deleted`.
 */
export function eventStream(c: Context, deps: SseDeps, id: string): Response {
  const { service, events } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  for (const [name, value] of Object.entries(securityHeaders())) c.header(name, value);
  return streamSSE(c, async (stream) => {
    const aborted = new Promise<void>((resolve) => stream.onAbort(resolve));
    let end = () => {};
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    // Writes are chained so events keep their order and never interleave.
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = (write: () => Promise<unknown>) => {
      chain = chain.then(write).catch(() => {});
    };
    const sendDeleted = () => {
      enqueue(() => stream.writeSSE(deleted));
      enqueue(async () => end());
    };

    // Subscribe before reading the current version, so no publish falls in between.
    const unsubscribe = events.subscribe(id, (event) => {
      if (event.type === "published") enqueue(() => stream.writeSSE(published(event.version)));
      else sendDeleted();
    });
    const heartbeat = setInterval(
      () => enqueue(() => stream.write(": heartbeat\n\n")),
      heartbeatMs,
    );
    try {
      const current = await service.read(id);
      if (current.ok) {
        enqueue(() =>
          stream.writeSSE({ ...published(current.value.currentVersion), retry: RETRY_MS }),
        );
      } else {
        sendDeleted();
      }
      await Promise.race([aborted, ended]);
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
}
