# 0012. Gallery page in v1

Status: Accepted (M2)

## Question

Should the gallery page at `http://localhost:4400/` ship in v1, or is `artifact list` enough?

## Decision

Ship a minimal gallery in M2 at `GET http://localhost:<port>/`:

- one read-only, server-rendered HTML list built from the core `list` call, newest first;
- each row shows the title (or `untitled`), the current version, the updated time, and a link to the artifact's current URL in the configured isolation mode;
- all user content is HTML-escaped; no client JS and no auto-refresh;
- strict CSP `default-src 'none'; style-src 'unsafe-inline'`, plus the security headers from 0025.
