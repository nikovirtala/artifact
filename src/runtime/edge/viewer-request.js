import cf from "cloudfront";
import crypto from "crypto";

const VIEW_DOMAIN = "__ARTIFACT_VIEW_DOMAIN__";

// CloudFront viewer-request function, cloudfront-js-2.0 (docs/decisions/0080, 0078). It
// classifies the Host as DomainHostPolicy does, verifies the session cookie with the key its
// KeyValueStore holds under the cookie's kid, copies the Host into x-artifact-host and removes
// every cookie. Lines 1-3 are fixed, and the construct substitutes the VIEW_DOMAIN line at synth.
// The runtime supports no async closures or arguments, so only handler is async and every helper
// is synchronous.

const SESSION = "__Secure-artifact_session";
const TX = "__Host-artifact_login";
const LOGIN = { "/__artifact/login": 1, "/__artifact/callback": 1, "/__artifact/logout": 1 };
const ID = /^[0-9a-hjkmnp-tv-z]{26}$/;
const COOKIE = /^v1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/;
const kvsHandle = cf.kvs();

function text(statusCode, statusDescription, data) {
  return {
    statusCode: statusCode,
    statusDescription: statusDescription,
    headers: {
      "cache-control": { value: "no-store" },
      "content-type": { value: "text/plain; charset=utf-8" },
    },
    body: { encoding: "text", data: data },
  };
}

function redirect(location) {
  const res = text(302, "Found", "sign in required\n");
  res.headers.location = { value: location };
  return res;
}

// {kid, input, sig, exp} for a well-formed cookie whose payload holds an integer exp, else null.
function parseSession(value) {
  const m = COOKIE.exec(value);
  if (m === null) return null;
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(m[2], "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (typeof payload !== "object" || payload === null || !Number.isInteger(payload.exp)) {
    return null;
  }
  return { kid: m[1], input: `v1.${m[1]}.${m[2]}`, sig: m[3], exp: payload.exp };
}

// Constant time for the 43-character signatures: XOR over every character, no early exit.
function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkSession(parsed, key, nowSeconds) {
  if (!(parsed.exp > nowSeconds)) return false;
  const sig = crypto.createHmac("sha256", key).update(parsed.input).digest("base64url");
  return equal(sig, parsed.sig);
}

function header(req, name) {
  const h = req.headers[name];
  return h ? h.value : "";
}

function isNavigation(req) {
  if (req.method !== "GET") return false;
  const mode = req.headers["sec-fetch-mode"];
  if (mode) return mode.value === "navigate";
  return header(req, "accept").indexOf("text/html") !== -1;
}

// The viewer's URL, with the query rebuilt in CloudFront's key order and encoding.
function returnUrl(host, req) {
  const pairs = [];
  const query = req.querystring || {};
  const names = Object.keys(query);
  for (let i = 0; i < names.length; i++) {
    const q = query[names[i]];
    if (q.multiValue) {
      for (let j = 0; j < q.multiValue.length; j++) {
        pairs.push(`${names[i]}=${q.multiValue[j].value}`);
      }
    } else {
      pairs.push(`${names[i]}=${q.value}`);
    }
  }
  return `https://${host}${req.uri}${pairs.length === 0 ? "" : `?${pairs.join("&")}`}`;
}

function cookie(req, name) {
  const cookies = req.cookies || {};
  return cookies[name];
}

function keepOnly(req, name) {
  const kept = {};
  const c = cookie(req, name);
  if (c) kept[name] = c;
  req.cookies = kept;
}

function setHost(req, host) {
  req.headers["x-artifact-host"] = { value: host };
}

async function handler(event) {
  const req = event.request;
  let host = header(req, "host").toLowerCase();
  if (host.endsWith(":443")) host = host.slice(0, -4);
  const main = host === VIEW_DOMAIN;
  const suffix = `.${VIEW_DOMAIN}`;
  if (!main && !(host.endsWith(suffix) && ID.test(host.slice(0, -suffix.length)))) {
    return text(403, "Forbidden", "forbidden: unexpected Host header\n");
  }
  if (main && LOGIN[req.uri] === 1) {
    keepOnly(req, TX);
    setHost(req, host);
    return req;
  }
  const session = cookie(req, SESSION);
  const parsed = parseSession(session ? session.value : "");
  let key = null;
  if (parsed) {
    try {
      key = await kvsHandle.get(parsed.kid);
    } catch (e) {
      key = null;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  if (!(parsed && typeof key === "string" && checkSession(parsed, key, now))) {
    if (!isNavigation(req)) return text(401, "Unauthorized", "unauthorized\n");
    const target = encodeURIComponent(returnUrl(host, req));
    return redirect(`https://${VIEW_DOMAIN}/__artifact/login?return=${target}`);
  }
  req.cookies = {};
  setHost(req, host);
  return req;
}
