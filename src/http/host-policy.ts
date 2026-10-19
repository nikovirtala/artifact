// Which origin a request is for, and the URLs handed out (docs/decisions/0053). The local policy
// is today's loopback rules (docs/decisions/0027, 0010); the domain policy is `<viewDomain>` and
// `<id>.<viewDomain>` over https, for a deployment behind a real domain.
import { isArtifactId } from "../core/paths.ts";
import { artifactUrl, type Isolation } from "./urls.ts";

export type HostKind = { kind: "main" } | { kind: "artifact"; id: string } | { kind: "reject" };

/** A host the guard let through; downstream routes never see `reject`. */
export type AcceptedHost = Exclude<HostKind, { kind: "reject" }>;

export interface HostPolicy {
  /** Classify a URL `host` (`name[:port]`). */
  classify(host: string): HostKind;
  artifactUrl(id: string): string;
  galleryUrl(): string;
}

const MAIN_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ARTIFACT_HOST_SUFFIX = ".localhost";

/** `localhost`, `127.0.0.1`, `[::1]` and `<id>.localhost`, on the configured port only. */
export class LocalHostPolicy implements HostPolicy {
  readonly #options: { port: number; isolation: Isolation };

  constructor(options: { port: number; isolation: Isolation }) {
    this.#options = { port: options.port, isolation: options.isolation };
  }

  classify(host: string): HostKind {
    const lower = host.toLowerCase();
    // URL parsing drops the default port, so port 80 arrives without one.
    const suffix = this.#options.port === 80 ? "" : `:${this.#options.port}`;
    if (!lower.endsWith(suffix)) return { kind: "reject" };
    const name = lower.slice(0, lower.length - suffix.length);
    if (MAIN_HOSTS.has(name)) return { kind: "main" };
    if (name.endsWith(ARTIFACT_HOST_SUFFIX)) {
      const id = name.slice(0, -ARTIFACT_HOST_SUFFIX.length);
      if (isArtifactId(id)) return { kind: "artifact", id };
    }
    return { kind: "reject" };
  }

  artifactUrl(id: string): string {
    return artifactUrl(id, this.#options);
  }

  galleryUrl(): string {
    return `http://localhost:${this.#options.port}/`;
  }
}

const DOMAIN_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const HTTPS_PORT = ":443";

/**
 * `<viewDomain>` (main) and `<id>.<viewDomain>` (artifact), with no port or `:443`. Everything
 * else is rejected: other or empty ports, a trailing dot, IP literals, unknown or nested labels,
 * and foreign or look-alike domains. Subdomain isolation only.
 */
export class DomainHostPolicy implements HostPolicy {
  readonly #domain: string;

  constructor(options: { viewDomain: string }) {
    const domain = options.viewDomain.toLowerCase();
    if (!DOMAIN_NAME.test(domain)) {
      throw new RangeError(
        `viewDomain must be a bare domain name like art.example.com, got ${JSON.stringify(options.viewDomain)}`,
      );
    }
    this.#domain = domain;
  }

  classify(host: string): HostKind {
    const lower = host.toLowerCase();
    const name = lower.endsWith(HTTPS_PORT) ? lower.slice(0, -HTTPS_PORT.length) : lower;
    if (name.includes(":")) return { kind: "reject" };
    if (name === this.#domain) return { kind: "main" };
    const suffix = `.${this.#domain}`;
    if (name.endsWith(suffix)) {
      const id = name.slice(0, -suffix.length);
      if (isArtifactId(id)) return { kind: "artifact", id };
    }
    return { kind: "reject" };
  }

  artifactUrl(id: string): string {
    return `https://${id}.${this.#domain}/`;
  }

  galleryUrl(): string {
    return `https://${this.#domain}/`;
  }
}
