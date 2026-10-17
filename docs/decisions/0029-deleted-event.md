# 0029. `deleted` event

Status: Accepted (M3)

## Context

Without it, a tab on a deleted artifact either keeps a dead stream or reloads into a 404. 0015 left this to M3.

## Decision

- `ArtifactEvent` becomes `{type: "published", id, version} | {type: "deleted", id}`. `ArtifactService.delete` notifies `deleted` right after the pointer is removed (the artifact is gone for viewers from then on), before the blob cleanup. As with publish, a failing notifier does not fail the delete.
- The SSE stream sends `event: deleted` with `data: {}` and then ends. If the artifact disappears between the 404 check and the subscription (0032), the stream sends `deleted` instead of a version.
- The client closes its `EventSource` and shows a small fixed banner, "This artifact was deleted.", bottom right, with `pointer-events: none` so it never blocks the page. It does not reload. Styles are set through CSSOM, which a `style-src` CSP does not block.

## Consequences

A tab that was disconnected while the artifact was deleted reconnects into a 404, and `EventSource` gives up without a banner. That is accepted: the page stays as it was, and a manual reload shows the 404.
