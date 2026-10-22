// The viewer-request function's code (docs/decisions/0080): the built asset with the view domain
// substituted at synth, so the function holds no token and no environment. Shared by the
// construct and the node:vm test harness, so the tests run exactly what is deployed.

/** The line of the edge source that renderEdgeFunction replaces. */
export const PLACEHOLDER_LINE = 'const VIEW_DOMAIN = "__ARTIFACT_VIEW_DOMAIN__";';

/** CloudFront Functions' maximum function size (not adjustable). */
const MAX_FUNCTION_BYTES = 10_240;

export function renderEdgeFunction(source: string, viewDomain: string): string {
  const lines = source.split("\n");
  const at = lines.flatMap((line, i) => (line === PLACEHOLDER_LINE ? [i] : []));
  if (at.length !== 1) {
    throw new Error(
      "artifact: the edge function must hold the view-domain placeholder line exactly once",
    );
  }
  lines[at[0]] = `const VIEW_DOMAIN = ${JSON.stringify(viewDomain)};`;
  const rendered = lines.join("\n");
  const bytes = Buffer.byteLength(rendered, "utf8");
  if (bytes >= MAX_FUNCTION_BYTES) {
    throw new Error(
      `artifact: the edge function is ${bytes} bytes; CloudFront Functions need it under ${MAX_FUNCTION_BYTES}`,
    );
  }
  return rendered;
}
