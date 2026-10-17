# 0010. Safari and `*.localhost`

Status: Proposed (pending owner decision; needs verification in M2)

## Question

Does Safari resolve `<id>.localhost` with no `/etc/hosts` entries? If not, should Safari fall back to path mode automatically, or should the hosts entry be documented?

## Notes

Not yet verified on a real Safari. `/etc/hosts` has no wildcard support, so "document the hosts entry" would mean one line per artifact id. That is not a workable default.

## Recommendation

Test it manually during M2. If Safari does not resolve the subdomains:

1. Keep path-mode routes (`/a/<id>/…`) mounted in every mode.
2. Have the gallery and `artifact open` use path-mode URLs for Safari, detected from the `User-Agent` on the gallery request and with a `--isolation path` override.
3. Document that path mode shares one origin, so its storage is not isolated.
