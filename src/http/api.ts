// JSON API under /api (spec "HTTP: JSON API"; docs/decisions/0021–0023).
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { LIMITS } from "../core/artifact-service.ts";
import type { ArtifactError, Result } from "../core/errors.ts";
import {
  DEFAULT_LIST_LIMIT,
  decodeFiles,
  MAX_BODY_BYTES,
  PublishBodySchema,
  RollbackBodySchema,
} from "../schemas.ts";
import type { AppDeps } from "./app.ts";
import { badRequest, httpError, jsonError } from "./errors.ts";
import { type AppEnv, browserGuard, parseIfMatch, tokenGuard } from "./guards.ts";
import { API_FILE_CSP } from "./headers.ts";
import { artifactUrl } from "./urls.ts";

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function coreError(error: ArtifactError): Response {
  return jsonError(error);
}

const etag = (version: number) => `"${version}"`;

/** One optional positive-integer query param; repeated or malformed → `undefined` + error. */
function queryInt(c: Context<AppEnv>, name: string, max: number): Parsed<number | undefined> {
  const values = c.req.queries(name);
  if (values === undefined) return { ok: true, value: undefined };
  const [value] = values;
  const n = Number(value);
  if (values.length !== 1 || !POSITIVE_INTEGER.test(value) || !(n <= max)) {
    return {
      ok: false,
      response: badRequest(`query parameter ${name} must be one integer from 1 to ${max}`),
    };
  }
  return { ok: true, value: n };
}

async function jsonBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<Parsed<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text());
  } catch {
    return { ok: false, response: badRequest("request body is not valid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(
        httpError("invalid_request", "request body does not match the schema", {
          issues: parsed.error.issues,
        }),
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

/** Decoded path segments after `/api/artifacts/<id>/files/`. */
function filePath(c: Context<AppEnv>): string {
  const segments = new URL(c.req.url).pathname.split("/").slice(5);
  return segments.map((s) => decodeURIComponent(s)).join("/");
}

export function createApi(deps: AppDeps): Hono<AppEnv> {
  const { service, config, opener } = deps;
  const urlFor = (id: string) => artifactUrl(id, config);
  /** `open`: a publish that may open the browser (`true` only on create); rollback omits it. */
  const published = (
    c: Context<AppEnv>,
    result: Result<{ id: string; version: number; project?: string }>,
    status: 200 | 201,
    open?: boolean,
  ) => {
    if (!result.ok) return coreError(result.error);
    const { id, version, project } = result.value;
    const url = urlFor(id);
    c.header("ETag", etag(version));
    if (status === 201) c.header("Location", `/api/artifacts/${id}`);
    const opened = open && opener ? opener(url) : false;
    return c.json(
      {
        id,
        version,
        url,
        ...(project === undefined ? {} : { project }),
        ...(open === undefined ? {} : { opened }),
      },
      status,
    );
  };

  const api = new Hono<AppEnv>();
  api.use(browserGuard());
  api.use(tokenGuard(config.token));
  api.use(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });
  api.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () =>
        jsonError(
          httpError("too_large", `publish exceeds the limit of ${LIMITS.maxPublishBytes} bytes`, {
            subject: "publish",
            limit: LIMITS.maxPublishBytes,
          }),
        ),
    }),
  );

  api.get("/artifacts", async (c) => {
    const limit = queryInt(c, "limit", LIMITS.maxListLimit);
    if (!limit.ok) return limit.response;
    const projects = c.req.queries("project");
    if (projects !== undefined && projects.length !== 1) {
      return badRequest("query parameter project must be given at most once");
    }
    const list = await service.list({
      limit: limit.value ?? DEFAULT_LIST_LIMIT,
      project: projects?.[0],
    });
    if (!list.ok) return coreError(list.error);
    return c.json({
      artifacts: list.value.map((a) => ({
        id: a.id,
        ...(a.title === undefined ? {} : { title: a.title }),
        ...(a.project === undefined ? {} : { project: a.project }),
        currentVersion: a.currentVersion,
        updatedAt: a.updatedAt,
        url: urlFor(a.id),
      })),
    });
  });

  api.get("/artifacts/:id", async (c) => {
    const details = await service.read(c.req.param("id"));
    if (!details.ok) return coreError(details.error);
    c.header("ETag", etag(details.value.currentVersion));
    return c.json({ ...details.value, url: urlFor(details.value.id) });
  });

  api.get("/artifacts/:id/versions/:version", async (c) => {
    const raw = c.req.param("version");
    const version = Number(raw);
    if (!POSITIVE_INTEGER.test(raw) || !Number.isSafeInteger(version)) {
      return badRequest("version must be a positive integer");
    }
    const manifest = await service.readManifest(c.req.param("id"), version);
    if (!manifest.ok) return coreError(manifest.error);
    const { id, createdAt, label, files } = manifest.value;
    return c.json({ id, version, createdAt, ...(label === undefined ? {} : { label }), files });
  });

  api.get("/artifacts/:id/files/*", async (c) => {
    const version = queryInt(c, "version", Number.MAX_SAFE_INTEGER);
    if (!version.ok) return version.response;
    const file = await service.readFile(c.req.param("id"), {
      path: filePath(c),
      version: version.value,
    });
    if (!file.ok) return coreError(file.error);
    return new Response(file.value.body as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": file.value.contentType,
        "X-Artifact-Version": String(file.value.version),
        "Content-Security-Policy": API_FILE_CSP,
        "Cache-Control": "no-store",
      },
    });
  });

  api.post("/artifacts", async (c) => {
    const body = await jsonBody(c, PublishBodySchema);
    if (!body.ok) return body.response;
    const { title, label, project, files, open } = body.value;
    return published(
      c,
      await service.publish({ title, label, project, files: decodeFiles(files) }),
      201,
      open !== false,
    );
  });

  api.put("/artifacts/:id", async (c) => {
    const header = c.req.header("If-Match");
    const ifMatch = header === undefined ? undefined : parseIfMatch(header);
    if (ifMatch && !ifMatch.ok) {
      return badRequest('If-Match must be one version number, like 3 or "3"');
    }
    const body = await jsonBody(c, PublishBodySchema);
    if (!body.ok) return body.response;
    const { title, label, project, files, if_version } = body.value;
    if (ifMatch && if_version !== undefined && ifMatch.value !== if_version) {
      return badRequest("If-Match and if_version disagree");
    }
    const ifVersion = ifMatch?.value ?? if_version;
    return published(
      c,
      await service.publish({
        id: c.req.param("id"),
        title,
        label,
        project,
        ifVersion,
        files: decodeFiles(files),
      }),
      200,
      false,
    );
  });

  api.post("/artifacts/:id/rollback", async (c) => {
    const body = await jsonBody(c, RollbackBodySchema);
    if (!body.ok) return body.response;
    return published(c, await service.rollback(c.req.param("id"), body.value.version), 200);
  });

  api.delete("/artifacts/:id", async (c) => {
    const result = await service.delete(c.req.param("id"));
    if (!result.ok) return coreError(result.error);
    return c.body(null, 204);
  });

  api.all("*", () => jsonError(httpError("not_found", "no such API route")));

  return api;
}
