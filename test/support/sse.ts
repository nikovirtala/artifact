// A minimal SSE frame reader for tests, over any response body (in-process or fetch).

export type Frame = {
  event?: string;
  id?: string;
  data?: string;
  retry?: string;
  comment?: string;
};

export type SseReader = {
  /** The next frame; rejects after `timeoutMs`, resolves `undefined` when the stream ends. */
  next(timeoutMs?: number): Promise<Frame | undefined>;
  /** Cancel the body (the client disconnecting). */
  cancel(): Promise<void>;
};

export function sseReader(body: ReadableStream<Uint8Array> | null): SseReader {
  if (!body) throw new Error("response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  // A read still in flight after a timeout is kept, so its chunk is not lost.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  function parse(block: string): Frame {
    const frame: Frame = {};
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        frame.comment = line.slice(1).trim();
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "event" || field === "id" || field === "retry") frame[field] = value;
    }
    if (data.length > 0) frame.data = data.join("\n");
    return frame;
  }

  async function next(timeoutMs = 5000): Promise<Frame | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no SSE frame within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return parse(block);
        }
        if (done) return undefined;
        pending ??= reader.read();
        const chunk = await Promise.race([pending, timeout]);
        pending = undefined;
        if (chunk.done) done = true;
        else buffer += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { next, cancel: () => reader.cancel() };
}

/** Poll `check` until it is true; fails after `timeoutMs`. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
