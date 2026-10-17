# 0032. Events for unknown ids

Status: Accepted (M3)

## Decision

- `GET /__artifact/events` returns the plain `404 not found` of the viewing routes (0024), and opens no stream and no subscription, when `id` is missing, malformed, or names no artifact (never existed or deleted).
- On `<id>.localhost`, `id` must be that host's id (case-insensitive); another id is 404. An artifact origin only learns about itself.
- On the main hosts (path mode), any existing id is accepted.

## Consequences

An `EventSource` that gets a 404 closes for good instead of retrying, so a tab on a deleted artifact or a mistyped id does not reconnect forever. Subscriptions exist only for artifacts that existed at connect time; there is no way to hold a listener open for an arbitrary id.
