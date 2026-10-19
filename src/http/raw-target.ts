// The request target as the client sent it, read through a hook set by the server adapter
// (docs/decisions/0055): `@hono/node-server` locally, the Lambda event's `rawPath` +
// `rawQueryString` on AWS. The traversal guard needs it before any URL normalisation.
import type { Context } from "hono";
import type { AppEnv } from "./guards.ts";

/** The raw target (`/path?query`), or `undefined` to fall back to the parsed URL. */
export type RawTargetHook = (c: Context<AppEnv>) => string | undefined;

/** `@hono/node-server` exposes the Node request, whose `url` is the raw target. */
export const nodeServerRawTarget: RawTargetHook = (c) => {
  const raw = c.env?.incoming?.url;
  return typeof raw === "string" ? raw : undefined;
};
