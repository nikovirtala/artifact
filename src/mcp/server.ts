// MCP tools at /mcp over Streamable HTTP in stateless mode (docs/decisions/0033–0036): a fresh
// server and transport per POST, JSON responses, no sessions. Inputs come from the shared Zod
// schemas; results and errors carry the same objects as the JSON API.
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Opener } from "../adapters/browser-opener.ts";
import type { ArtifactService } from "../core/artifact-service.ts";
import { fail, invalidInput, type Result } from "../core/errors.ts";
import { ENTRY_PAGE } from "../core/paths.ts";
import { errorBody, httpError } from "../http/errors.ts";
import { artifactUrl, type Isolation } from "../http/urls.ts";
import {
  bodyCapFor,
  decodeFiles,
  defaultListLimit,
  encodeFileValue,
  toolInputSchemas,
} from "../schemas.ts";
import { readEntryFile } from "./file-path.ts";

export type McpConfig = {
  port: number;
  isolation: Isolation;
  /** Accept `artifact_publish` `file_path` (default true; a remote deployment turns it off). */
  allowFilePath?: boolean;
  /** Request body cap; default `bodyCapFor(service.limits)` (docs/decisions/0051). */
  maxBodyBytes?: number;
};

export type McpDeps = {
  service: ArtifactService;
  config: McpConfig;
  /** Opens newly created artifacts in the browser; none means never (docs/decisions/0040). */
  opener?: Opener;
};

const { version: PACKAGE_VERSION } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

// Which tool to pick, then the core loop (docs/decisions/0036, 0038).
const USE_THIS =
  'Use this whenever the user asks for an HTML page, mock-up, visualization, report, dashboard, or an "artifact": ' +
  "publish it here and give the user the URL. Do not use the client's built-in artifact features for these.";

const INSTRUCTIONS =
  `${USE_THIS} ` +
  "This server hosts HTML pages (artifacts) at stable local URLs. Every publish is a new immutable version, " +
  "and browser tabs open on an artifact's URL reload when it is republished. To change a page, " +
  "publish to its existing id instead of creating a new artifact; use artifact_list to find the id. " +
  "Pass project on every call, as the tools describe.";

type ToolSpec<S extends z.ZodType> = {
  name: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run: (args: z.infer<S>) => Promise<Result<Record<string, unknown>>>;
};

const tool = <S extends z.ZodType>(spec: ToolSpec<S>) => spec as unknown as ToolSpec<z.ZodType>;

function tools(deps: McpDeps): ToolSpec<z.ZodType>[] {
  const { service, config, opener } = deps;
  const {
    PublishToolInputSchema,
    ListToolInputSchema,
    ReadToolInputSchema,
    RollbackToolInputSchema,
    DeleteToolInputSchema,
  } = toolInputSchemas(service.limits);
  const urlFor = (id: string) => artifactUrl(id, config);
  const entryFromPath = async (
    path: string,
    files: Readonly<Record<string, unknown>>,
  ): Promise<Result<Uint8Array>> => {
    if (config.allowFilePath === false) {
      return fail(
        invalidInput(
          "file_path",
          "file_path is not supported by this server; send the page inline as files['index.html']",
        ),
      );
    }
    if (Object.hasOwn(files, ENTRY_PAGE)) {
      return fail(
        invalidInput("file_path", "file_path and files both give index.html; pass only one"),
      );
    }
    return readEntryFile(path, service.limits.maxFileBytes);
  };
  const published = (result: Result<{ id: string; version: number; project?: string }>) =>
    result.ok
      ? { ok: true as const, value: { ...result.value, url: urlFor(result.value.id) } }
      : result;

  return [
    tool({
      name: "artifact_publish",
      description: [
        USE_THIS,
        "Publishes an HTML page (index.html plus optional supporting files) and returns its URL.",
        config.allowFilePath === false
          ? "file_path is not supported by this server: send index.html inline in files."
          : "Instead of files['index.html'] you can pass file_path, the absolute path of a local .html file; supporting files it references are included only if you also list them in files.",
        "Omit id to create a new artifact. Pass id to update that artifact in place: it gets a new version and keeps its URL, and open tabs reload.",
        "Before creating, if this page may already exist (from earlier in this session or another one), call artifact_list and reuse its id instead of creating a duplicate.",
        "Pass project on every call, derived as its description says. Never ask the user about, or act on, artifacts outside the current project unless they refer to them.",
        "Returns {id, version, url, project?, opened}. A new artifact is opened in the user's browser by the server: if opened is true, tell the user the page is open in their browser; otherwise show them the url. Never open it yourself.",
        "If it fails with version_conflict and you did not pass if_version, other publishes were racing and retries ran out: retry the same call, and do not add if_version.",
        "With if_version, version_conflict means someone else published first: artifact_read the current version and redo the change on top of it.",
      ].join(" "),
      input: PublishToolInputSchema,
      annotations: { title: "Publish artifact", destructiveHint: false, openWorldHint: false },
      run: async ({ id, title, label, project, if_version, file_path, files }) => {
        const decoded = decodeFiles(files ?? {});
        if (file_path !== undefined) {
          const entry = await entryFromPath(file_path, decoded);
          if (!entry.ok) return entry;
          decoded[ENTRY_PAGE] = entry.value;
        }
        const result = published(
          await service.publish({
            id,
            title,
            label,
            project,
            ifVersion: if_version,
            files: decoded,
          }),
        );
        if (!result.ok) return result;
        const opened = id === undefined && opener ? opener(result.value.url) : false;
        return { ok: true, value: { ...result.value, opened } };
      },
    }),
    tool({
      name: "artifact_list",
      description: [
        "List artifacts, most recently updated first: {artifacts: [{id, title?, project?, currentVersion, updatedAt, url}]}.",
        "Use it to recover the id of an existing artifact before updating it, instead of creating a duplicate.",
        "Pass project on every call: you get only that project's artifacts.",
        "Use all: true only when the user asks about artifacts from other projects.",
        "Never ask the user about, or act on, artifacts outside the current project unless they refer to them.",
      ].join(" "),
      input: ListToolInputSchema,
      annotations: { title: "List artifacts", readOnlyHint: true, openWorldHint: false },
      run: async ({ limit, project, all }) => {
        const list = await service.list({
          limit: limit ?? defaultListLimit(service.limits),
          project,
          all,
        });
        if (!list.ok) return list;
        return {
          ok: true,
          value: {
            artifacts: list.value.map((a) => ({
              id: a.id,
              ...(a.title === undefined ? {} : { title: a.title }),
              ...(a.project === undefined ? {} : { project: a.project }),
              currentVersion: a.currentVersion,
              updatedAt: a.updatedAt,
              url: urlFor(a.id),
            })),
          },
        };
      },
    }),
    tool({
      name: "artifact_read",
      description: [
        "Read one file of an artifact exactly as it was published (default index.html of the current version).",
        "Returns {id, version, path, contentType, content}; content is a string for text, {base64} for binary.",
        "Read before editing an artifact this session did not publish.",
        "Edit the HTML returned here, not the page served at the artifact's URL: the served page carries an injected reload script tag that must not be published back.",
      ].join(" "),
      input: ReadToolInputSchema,
      annotations: { title: "Read artifact file", readOnlyHint: true, openWorldHint: false },
      run: async ({ id, version, path }) => {
        const file = await service.readFile(id, { version, path });
        if (!file.ok) return file;
        const { body, ...rest } = file.value;
        return { ok: true, value: { ...rest, content: encodeFileValue(rest.contentType, body) } };
      },
    }),
    tool({
      name: "artifact_rollback",
      description: [
        "Move an artifact's current version back to an earlier committed version (no files are copied or lost).",
        "Open tabs reload. Returns {id, version, url} with the now-current version.",
      ].join(" "),
      input: RollbackToolInputSchema,
      annotations: {
        title: "Roll back artifact",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      run: async ({ id, version }) => published(await service.rollback(id, version)),
    }),
    tool({
      name: "artifact_delete",
      description: [
        "Delete an artifact and all of its versions; its URL stops working.",
        "Only call this when the user explicitly asks to delete the artifact. Requires confirm: true.",
      ].join(" "),
      input: DeleteToolInputSchema,
      annotations: { title: "Delete artifact", destructiveHint: true, openWorldHint: false },
      run: async ({ id }) => {
        const result = await service.delete(id);
        return result.ok ? { ok: true, value: { ok: true } } : result;
      },
    }),
  ];
}

function toolResult(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

type Catalog = { byName: ReadonlyMap<string, ToolSpec<z.ZodType>>; listed: Tool[] };

function catalog(deps: McpDeps): Catalog {
  const specs = tools(deps);
  return {
    byName: new Map(specs.map((s) => [s.name, s])),
    listed: specs.map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: z.toJSONSchema(s.input, { io: "input" }) as Tool["inputSchema"],
      annotations: s.annotations,
    })),
  };
}

function createServer({ byName, listed }: Catalog): Server {
  // The low-level Server, not McpServer: McpServer answers schema failures with a plain-text
  // message, while these tools return the API's `invalid_request` object (docs/decisions/0034).
  const server = new Server(
    { name: "artifact", version: PACKAGE_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const spec = byName.get(request.params.name);
    if (!spec) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${request.params.name}`);
    const args = spec.input.safeParse(request.params.arguments ?? {});
    if (!args.success) {
      return toolResult(
        errorBody(
          httpError("invalid_request", "arguments do not match the tool's input schema", {
            issues: args.error.issues,
          }),
        ),
        true,
      );
    }
    try {
      const result = await spec.run(args.data);
      return result.ok ? toolResult(result.value) : toolResult(errorBody(result.error), true);
    } catch (error) {
      console.error(error);
      return toolResult(errorBody(httpError("internal", "internal server error")), true);
    }
  });
  return server;
}

const methodNotAllowed = () =>
  Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null },
    { status: 405, headers: { Allow: "POST" } },
  );

/**
 * The `/mcp` handler. Stateless: every POST gets its own server and transport, so any instance
 * (or Lambda) can answer any request. GET (server-initiated stream) and DELETE (end session) have
 * nothing to do without sessions and get 405.
 */
export function createMcpHandler(deps: McpDeps): (request: Request) => Promise<Response> {
  const tools = catalog(deps);
  const maxRequestBodySize = deps.config.maxBodyBytes ?? bodyCapFor(deps.service.limits);
  return async (request) => {
    if (request.method !== "POST") return methodNotAllowed();
    const server = createServer(tools);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}
