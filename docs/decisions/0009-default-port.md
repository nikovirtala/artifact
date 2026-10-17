# 0009. Default port 4400

Status: Accepted (M2)

## Question

Is 4400 the right default port?

## Decision

- The default port is 4400. No common dev server uses it by default, and it is easy to remember.
- Override it with `--port <n>` or the env var `ARTIFACT_PORT` (the flag wins).
- The server never picks another port on its own, because the URLs agents return have to stay stable. On `EADDRINUSE` it exits non-zero with:
  `artifact: port <P> is already in use; pick another with --port <n> or ARTIFACT_PORT=<n>`.
