// HTTP client for the JSON API (docs/decisions/0041). Node fetch sends neither Origin nor
// Sec-Fetch-Site, so the API's browser guard (0037) lets it through; never add them.
import { type Env, envValue } from "../config.ts";
import { type CliContext, CliError, UsageError } from "./output.ts";
import { checkServerVersion, isLoopbackServer } from "./version-check.ts";

export const DEFAULT_SERVER = "http://localhost:4400";

/** `--server` > `ARTIFACT_SERVER` > the default; an http(s) URL without the trailing `/`. */
export function resolveServer(flag: string | undefined, env: Env): string {
  const fromEnv = envValue(env, "ARTIFACT_SERVER");
  const source = flag !== undefined ? "--server" : "ARTIFACT_SERVER";
  const raw = flag ?? fromEnv ?? DEFAULT_SERVER;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new UsageError(`${source} must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  return raw.replace(/\/+$/, "");
}

export type JsonResponse = { status: number; headers: Headers; body: unknown };
export type BytesResponse = { status: number; headers: Headers; body: Uint8Array };

export type Client = {
  readonly server: string;
  json(
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<JsonResponse>;
  bytes(path: string): Promise<BytesResponse>;
};

type Fetch = typeof globalThis.fetch;

/** The low-level cause of a fetch rejection (`ECONNREFUSED`, `ENOTFOUND`, …). */
export function networkCause(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause as
    | { code?: unknown; message?: unknown; errors?: { code?: unknown }[] }
    | undefined;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  if (typeof code === "string") return code;
  if (typeof cause?.message === "string") return cause.message;
  return (error as Error).message;
}

export function createClient(options: {
  server: string;
  token?: string;
  fetch?: Fetch;
  /** Runs once, before the client's first request (the version check, 0064); never throws. */
  beforeFirstRequest?: () => Promise<void>;
}): Client {
  const { server, token, fetch: fetchImpl = globalThis.fetch, beforeFirstRequest } = options;
  let first: Promise<void> | undefined;

  const send = async (url: string, init: RequestInit): Promise<Response> => {
    if (beforeFirstRequest) {
      first ??= beforeFirstRequest();
      await first;
    }
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      throw new CliError(
        "no_server",
        `no artifact server answered at ${server} (${networkCause(error)}); start one with \`artifact serve\`, or set --server / ARTIFACT_SERVER`,
      );
    }
    if (!response.ok) throw await apiError(response, url);
    return response;
  };
  const auth = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

  return {
    server,
    async json(method, path, { body, headers = {} } = {}) {
      const url = `${server}${path}`;
      const response = await send(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...auth(),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text === "" ? undefined : JSON.parse(text);
      } catch {
        throw badResponse(response.status, url);
      }
      return { status: response.status, headers: response.headers, body: parsed };
    },
    async bytes(path) {
      const url = `${server}${path}`;
      const response = await send(url, { method: "GET", headers: auth() });
      return {
        status: response.status,
        headers: response.headers,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

/**
 * A client for `ctx`: the server from `--server` or the env, the token from `ARTIFACT_TOKEN`.
 * A command makes one client, so a remote server's version is checked once per process (0064);
 * loopback servers are never checked.
 */
export function connect(
  ctx: CliContext,
  serverFlag: string | undefined,
  options: { fetch?: Fetch } = {},
): Client {
  const server = resolveServer(serverFlag, ctx.env);
  const token = envValue(ctx.env, "ARTIFACT_TOKEN");
  const { fetch } = options;
  return createClient({
    server,
    token,
    fetch,
    beforeFirstRequest: isLoopbackServer(server)
      ? undefined
      : async () => {
          const warning = await checkServerVersion({ server, token, fetch });
          if (warning !== undefined) ctx.stderr.write(`${warning}\n`);
        },
  });
}

/** `/api/artifacts/<id>` with `id` escaped; extra segments are escaped one by one. */
export function artifactPath(id: string, ...segments: string[]): string {
  return ["/api/artifacts", id, ...segments]
    .map((s, i) => (i ? encodeURIComponent(s) : s))
    .join("/");
}

function badResponse(status: number, url: string): CliError {
  return new CliError("bad_response", `unexpected HTTP ${status} from ${url}`);
}

async function apiError(response: Response, url: string): Promise<CliError> {
  try {
    const { error, message, ...details } = (await response.json()) as Record<string, unknown>;
    if (typeof error === "string" && typeof message === "string") {
      return new CliError(error, message, details);
    }
  } catch {
    // Not the API's JSON error body.
  }
  return badResponse(response.status, url);
}
