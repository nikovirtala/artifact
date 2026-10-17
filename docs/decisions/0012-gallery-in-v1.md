# 0012. Gallery page in v1

Status: Proposed (pending owner decision)

## Question

Should the gallery page at `http://localhost:4400/` ship in v1, or is `artifact list` enough?

## Recommendation

Ship a minimal gallery in M2: one server-rendered HTML list (newest first, with title, version, updated time and link) built from the same `list` core call, with no client JS. It is cheap to build, gives humans a way to find artifacts without the CLI, and is the natural place for a Safari path-mode fallback (see 0010).
