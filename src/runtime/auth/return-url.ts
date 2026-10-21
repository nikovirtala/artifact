// Where the login sends the browser afterwards (docs/decisions/0081): only https URLs on the view
// domain or one of its artifact subdomains, so the login can never be used as an open redirect.
import type { HostPolicy } from "../../http/host-policy.ts";

const MAX_RETURN = 2048;
// C0 controls, DEL and C1 controls. The URL parser would silently drop tabs and newlines.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * `value` as a normalised `href` if it is a string of at most 2048 characters without control
 * characters that parses as an absolute URL (no base, so relative and protocol-relative values
 * fail) with `https:`, no userinfo, no port, and a host `hosts` accepts. Otherwise the gallery.
 */
export function validateReturn(value: unknown, hosts: HostPolicy): string {
  const gallery = hosts.galleryUrl();
  if (typeof value !== "string" || value.length > MAX_RETURN || CONTROL.test(value)) {
    return gallery;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return gallery;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return gallery;
  }
  return hosts.classify(url.hostname).kind === "reject" ? gallery : url.href;
}
