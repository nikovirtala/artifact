# 0011. `ARTIFACT_TOKEN` default

Status: Accepted (M2)

## Question

Should `ARTIFACT_TOKEN` be required by default, or is loopback-only binding enough on its own?

## Decision

- The token is optional while the server is on loopback. The Host and Origin guards (0027) already block DNS rebinding and cross-site browser calls, and a required token would complicate the one-line `claude mcp add` setup.
- If `ARTIFACT_TOKEN` is set, `/api` (and `/mcp` from M4) require `Authorization: Bearer <token>`, compared in constant time. Viewing routes and the gallery stay open.
- `--host` with a non-loopback address and no token: the server refuses to start (non-zero exit, message names `ARTIFACT_TOKEN`). With a token it starts and prints a warning.

Details of the guards and listeners are in 0027.
