# 0010. Safari and `*.localhost`

Status: Accepted (M2; Safari verified by the owner in M3)

## Question

Does Safari resolve `<id>.localhost` with no `/etc/hosts` entries? If not, should Safari fall back to path mode automatically, or should the hosts entry be documented?

## Notes

The owner opened `http://<id>.localhost:4400/` in Safari with no `/etc/hosts` entries, and it loaded. Safari resolves `*.localhost` to loopback like Chrome and Firefox. (`/etc/hosts` has no wildcard support, so a hosts-file workaround would have needed one line per artifact id.)

## Decision

- Subdomain mode works in Safari. The default isolation stays `subdomain`.
- No `User-Agent` based switch. The manual check passed, so none is needed.
- Path-mode routes (`/a/<id>/…`, including `/a/<id>/v/<n>/…`) stay **always** mounted, whatever `--isolation` says, as a fallback for any environment where `*.localhost` does not resolve. `--isolation path` only changes which URL form the API and the gallery return.
- Path mode shares one origin (`localhost:<port>`), so its storage is not isolated per artifact. This is documented in the README.
