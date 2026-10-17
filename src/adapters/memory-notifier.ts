// In-process Notifier on an EventEmitter. The SSE endpoint (M3) subscribes per artifact id.
import { EventEmitter } from "node:events";
import type { ArtifactEvent, Notifier } from "../core/ports.ts";

export type ArtifactListener = (event: ArtifactEvent) => void;

export type MemoryNotifier = Notifier & {
  /** Listen for events of one artifact; returns the unsubscribe function. */
  subscribe(id: string, listener: ArtifactListener): () => void;
  listenerCount(id: string): number;
};

export function createMemoryNotifier(): MemoryNotifier {
  const emitter = new EventEmitter();
  // One listener per open tab; the default cap of 10 would warn spuriously.
  emitter.setMaxListeners(0);
  return {
    async notify(event) {
      emitter.emit(event.id, event);
    },
    subscribe(id, listener) {
      emitter.on(id, listener);
      return () => {
        emitter.off(id, listener);
      };
    },
    listenerCount: (id) => emitter.listenerCount(id),
  };
}
