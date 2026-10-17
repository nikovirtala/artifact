// Listeners (docs/decisions/0027): 127.0.0.1 and ::1 on one port, or exactly `--host`.
import { createServer, type RequestListener, type Server } from "node:http";

export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(
      `artifact: port ${port} is already in use; pick another with --port <n> or ARTIFACT_PORT=<n>`,
    );
    this.name = "PortInUseError";
    this.port = port;
  }
}

export type Listening = { servers: Server[]; close(): Promise<void> };

export type ListenOptions = {
  port: number;
  /** Bind exactly this address instead of both loopbacks. */
  host?: string;
  warn: (message: string) => void;
};

const IPV6_UNAVAILABLE: ReadonlySet<string> = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function bind(
  handler: RequestListener,
  port: number,
  host: string,
  ipv6Only = false,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    const onError = (error: Error) => {
      server.close();
      reject(code(error) === "EADDRINUSE" ? new PortInUseError(port) : error);
    };
    server.once("error", onError);
    server.listen({ port, host, ipv6Only }, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

function closeAll(servers: Server[]): Promise<void> {
  return Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  ).then(() => {});
}

export async function listen(handler: RequestListener, options: ListenOptions): Promise<Listening> {
  const { port, host, warn } = options;
  const servers: Server[] = [];
  if (host !== undefined) {
    servers.push(await bind(handler, port, host));
  } else {
    servers.push(await bind(handler, port, "127.0.0.1"));
    try {
      servers.push(await bind(handler, port, "::1", true));
    } catch (error) {
      if (!IPV6_UNAVAILABLE.has(code(error) ?? "")) {
        await closeAll(servers);
        throw error;
      }
      warn(`artifact: IPv6 loopback ::1 unavailable (${code(error)}); listening on 127.0.0.1 only`);
    }
  }
  return { servers, close: () => closeAll(servers) };
}
