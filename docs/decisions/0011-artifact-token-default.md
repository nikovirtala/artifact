# 0011. `ARTIFACT_TOKEN` default

Status: Proposed (pending owner decision)

## Question

Should `ARTIFACT_TOKEN` be required by default, or is loopback-only binding enough on its own?

## Recommendation

Keep the token optional while the server is on loopback. The spec's Host/Origin guard already blocks DNS rebinding and cross-site browser calls to `/api` and `/mcp`, and a required token would complicate the one-line `claude mcp add` setup. Require the token, or refuse to start, whenever `--host` binds a non-loopback address.
