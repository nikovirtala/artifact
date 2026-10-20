/**
 * The HTTP API route keys, as they appear in `$context.routeKey` and `requestContext.routeKey`:
 * API Gateway logs the selected route's key, so a `POST /api/artifacts` is `ANY /api/{proxy+}`.
 * The construct builds its routes from these; tests and the smoke script match logs on them.
 */
export const CONTROL_ROUTE_KEYS = {
  api: "ANY /api",
  apiProxy: "ANY /api/{proxy+}",
  mcp: "ANY /mcp",
} as const;
