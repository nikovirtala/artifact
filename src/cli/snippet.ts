// The agent instructions `artifact init` writes (docs/decisions/0038, 0046). This is the single
// source: test/cli/snippet.test.ts asserts the README contains the same text.

export const AGENT_SNIPPET =
  'For HTML pages, mock-ups, visualizations, reports, dashboards and "artifacts", use the `artifacts` MCP server (`artifact_publish`) instead of the built-in Artifact tool, and give me the URL. Reuse ids via `artifact_list` instead of creating duplicates. Pass `project` on every call, derived as the tool describes (`git remote get-url origin`, else `local:` + the git toplevel, else `local:` + the working directory).';

export const START = "<!-- artifact:start -->";
export const END = "<!-- artifact:end -->";

/** The line that pins a codebase's project, so agents pass exactly the CLI's value. */
export function projectPin(project: string): string {
  return `For this codebase, pass exactly \`project: ${JSON.stringify(project)}\` on every artifacts tool call.`;
}

/** The marked block, without a trailing newline; the pin only when `project` is given. */
export function snippetBlock(project?: string): string {
  const pin = project === undefined ? [] : ["", projectPin(project)];
  return [START, AGENT_SNIPPET, ...pin, END].join("\n");
}

/** The command that connects Claude Code to `server`; the token stays a shell variable. */
export function mcpAddCommand(server: string, withToken: boolean): string {
  const header = withToken ? ' --header "Authorization: Bearer $ARTIFACT_TOKEN"' : "";
  return `claude mcp add --scope user --transport http artifacts ${server}/mcp${header}`;
}
