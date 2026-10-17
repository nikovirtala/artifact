# 0009. Default port 4400

Status: Proposed (pending owner decision)

## Question

Is 4400 the right default port?

## Recommendation

Keep 4400. No common dev server uses it by default, and it is easy to remember. Make it overridable with `--port` and an env var, and on `EADDRINUSE` print a clear message that names the flag instead of silently picking another port. The URLs agents return have to stay stable, so the port must not change on its own.
