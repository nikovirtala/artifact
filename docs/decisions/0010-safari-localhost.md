# 0010. Safari and `*.localhost`

Status: Accepted (M2; manual Safari check pending)

## Question

Does Safari resolve `<id>.localhost` with no `/etc/hosts` entries? If not, should Safari fall back to path mode automatically, or should the hosts entry be documented?

## Notes

Not yet verified on a real Safari. `/etc/hosts` has no wildcard support, so "document the hosts entry" would mean one line per artifact id. That is not a workable default.

## Decision

- Path-mode routes (`/a/<id>/…`, including `/a/<id>/v/<n>/…`) are **always** mounted, whatever `--isolation` says. They work in every browser.
- The default isolation stays `subdomain`. `--isolation path` only changes which URL form the API and the gallery return.
- No `User-Agent` based switch for now. The owner runs a manual Safari check (start the server, publish, open `http://<id>.localhost:4400/` in Safari). The switch is reconsidered only if that check fails.
- Path mode shares one origin (`localhost:<port>`), so its storage is not isolated per artifact. This is documented in the README.
