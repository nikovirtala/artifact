# 0028. SSE events: current version on every connect

Status: Accepted (M3)

## Context

A tab must reload if it missed a publish while disconnected (server restart, dropped connection). `EventSource` sends `Last-Event-ID` only on reconnects, and only once it has received an event with an `id`. On the first connect the client cannot send its loaded version in a header.

Options: the client passes its version (`?v=<n>`) and the server compares, or the server always sends the current version and the client compares.

## Decision

- `GET /__artifact/events?id=<id>` (Hono `streamSSE`). Every event is `event: published`, `id: <version>`, `data: {"version": n}`. Publish and rollback both emit it (rollback is a pointer move like any other).
- **On every connect and reconnect, the server first sends the current version** (with `retry: 1000`, so browsers reconnect after about a second instead of their default of a few seconds). The client compares it with its `data-version` and reloads if they differ. No `?v=` parameter.
- `Last-Event-ID` is accepted and not needed: the reply is the same whatever it says (stale, current, malformed or absent). Its value is still meaningful, because after the first event it equals the loaded version (a client that saw another version has already reloaded).
- The subscription is made **before** the current version is read, and writes are queued in order. A publish that lands during connect is therefore sent after the initial event, never lost. A duplicate of the current version is possible and harmless.

## Consequences

The server keeps no per-client state, and the same rule covers the first connect, a dropped connection and a server restart. The cost is one pointer read per connect. The AWS transport (AppSync) can follow the same contract: send the current version on subscribe.
