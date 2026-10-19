// JSON error responses for /api: `{"error": code, "message", ...extra}` (docs/decisions/0023).
import type { ErrorHandler } from "hono";
import type { ArtifactError } from "../core/errors.ts";
import type { AppEnv } from "./guards.ts";
import { plainText } from "./headers.ts";

export type HttpErrorCode =
  | ArtifactError["code"]
  | "invalid_request"
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "internal";

export type HttpError = { code: HttpErrorCode; message: string; [extra: string]: unknown };

const statuses: Readonly<Record<HttpErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  too_large: 413,
  invalid_request: 422,
  invalid_path: 422,
  invalid_input: 422,
  internal: 500,
};

export function statusFor(code: HttpErrorCode): number {
  return statuses[code];
}

export function httpError(
  code: HttpErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpError {
  return { ...extra, code, message };
}

/** The wire shape: `code` becomes `error`; every other field is kept. */
export function errorBody(error: HttpError): Record<string, unknown> {
  const { code, message, ...extra } = error;
  return { error: code, message, ...extra };
}

export function jsonError(error: HttpError, headers: Record<string, string> = {}): Response {
  return Response.json(errorBody(error), {
    status: statusFor(error.code),
    headers: { "X-Content-Type-Options": "nosniff", ...headers },
  });
}

export function badRequest(message: string, extra?: Record<string, unknown>): Response {
  return jsonError(httpError("bad_request", message, extra));
}

export const MCP_PATH = "/mcp";

export function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * The 500 for an uncaught error, shared by every app (docs/decisions/0056): JSON on /api and
 * /mcp, plain text elsewhere.
 */
export function appErrorHandler(csp?: string): ErrorHandler<AppEnv> {
  return (error, c) => {
    console.error(error);
    return isApiPath(c.req.path) || c.req.path === MCP_PATH
      ? jsonError(httpError("internal", "internal server error"))
      : plainText(500, "internal server error\n", csp);
  };
}
