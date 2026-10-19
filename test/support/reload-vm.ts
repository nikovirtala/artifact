// Runs a reload client script in a VM context with a fake document, location and EventSource.
import { runInNewContext } from "node:vm";

type Listener = (event: { data: string }) => void;

export class FakeEventSource {
  readonly url: string;
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

export type FakeElement = {
  attributes: Record<string, string>;
  textContent: string;
  style: object;
};

export type LoadedPage = {
  sources: FakeEventSource[];
  appended: FakeElement[];
  readonly reloads: number;
};

/** Loads `script` on the page at `url`, from a tag with `data-version` (none when `null`). */
export function load(script: string, url: string, version: string | null = "2"): LoadedPage {
  const { hostname, pathname } = new URL(url);
  const sources: FakeEventSource[] = [];
  const appended: FakeElement[] = [];
  let reloads = 0;
  const element = (): FakeElement & { setAttribute(k: string, v: string): void } => ({
    attributes: {},
    textContent: "",
    style: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
  });
  const context = {
    document: {
      currentScript:
        version === null
          ? null
          : { getAttribute: (k: string) => (k === "data-version" ? version : null) },
      createElement: element,
      body: { appendChild: (e: FakeElement) => appended.push(e) },
      documentElement: { appendChild: (e: FakeElement) => appended.push(e) },
    },
    location: {
      hostname,
      pathname,
      reload: () => {
        reloads++;
      },
    },
    EventSource: class extends FakeEventSource {
      constructor(u: string) {
        super(u);
        sources.push(this);
      }
    },
  };
  runInNewContext(script, context);
  return {
    sources,
    appended,
    get reloads() {
      return reloads;
    },
  };
}

/** Own properties the script left on its global object, besides the ones it was given. */
export function globalsAfter(script: string): string[] {
  const context: Record<string, unknown> = {
    document: { currentScript: null },
    location: { hostname: "localhost", pathname: "/" },
  };
  runInNewContext(script, context);
  return Object.keys(context)
    .filter((k) => k !== "document" && k !== "location")
    .sort();
}

export const published = (version: number): string => JSON.stringify({ version });
