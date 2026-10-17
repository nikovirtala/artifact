# 0030. SSE heartbeat and listener lifecycle

Status: Accepted (M3)

## Decision

- **Heartbeat.** A comment line `: heartbeat` every 20 s per stream, so idle connections are not dropped by proxies or OS timeouts and dead sockets are noticed. The interval is `AppConfig.heartbeatMs` (default `HEARTBEAT_MS = 20_000`); tests inject a short one. It is not a CLI flag.
- **One subscription per stream.** The handler subscribes to the in-process notifier for that id. `subscribe` is not part of the `Notifier` port (0014); the app takes it as a separate `events` dependency (`{subscribe(id, listener) → unsubscribe}`), which the memory notifier provides.
- **Cleanup.** The stream callback waits until the client disconnects (the response stream is cancelled, which Hono reports as `onAbort`) or the stream ends after `deleted`. Then it clears the heartbeat timer and unsubscribes, in a `finally`, so an error cannot skip it.
- **HEAD → 405.** Hono answers `HEAD` from the `GET` handler and discards the body, which would leave the stream and its listener open. The events route returns `405` with `Allow: GET` for anything but `GET`.

## Consequences

Tests check that the notifier's listener count returns to 0 after 1,000 in-process connect/disconnect cycles, after 100 streams open at once, and after 100 real-socket disconnects.
