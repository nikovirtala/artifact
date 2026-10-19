# 0057. `GET /__artifact/version` on every artifact origin

Status: Accepted (M7)

## Context

On AWS the reload client cannot trust a push alone: after the subscribe is acknowledged it asks for the current version and reloads if it differs from the page's `data-version` (`docs/01-plan-aws.md`, code change 7). The route has to exist on both platforms, so the local server gets it too, for parity and tests. Locally the SSE stream already starts with the current version (0028), so the local client does not call it.

## Decision

- `GET /__artifact/version` is a platform route in the viewing app, next to `/__artifact/events`, on every accepted host.
- On `<id>.localhost` it serves that id. On the main host, which is the path-mode artifact origin, `?id=<id>` names the artifact (any case). A subdomain request with a different `?id=` gets 404, as for the events.
- An invalid, unknown or deleted id gets the plain-text 404 used for viewing.
- The body is `{"version": <currentVersion>}` as `application/json`, with `Cache-Control: no-store` and the artifact security headers (`securityHeaders(csp)`, 0025). GET and HEAD only; other methods get 404. No token is needed, like the rest of viewing.

## Consequences

The route was a 404 before; nothing else changes. It follows rollback as well as publish, since it reads `currentVersion` from the pointer. Like the other platform routes it is registered before the `<id>.localhost` catch-all, so it wins over an artifact file at the same path; under `/a/<id>/` the path belongs to the artifact.
