// The current URL of an artifact, in the configured isolation mode (docs/decisions/0010).

export type Isolation = "subdomain" | "path";

export function artifactUrl(id: string, options: { port: number; isolation: Isolation }): string {
  return options.isolation === "subdomain"
    ? `http://${id}.localhost:${options.port}/`
    : `http://localhost:${options.port}/a/${id}/`;
}
