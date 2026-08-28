// Fetching a URL that arrived over the network.
//
// Ported from cardwall's fetcher — same reasoning, one difference. Peer
// verification fetches the JWKS of whoever a token CLAIMS to be from, and on a
// public agent in "anyone" mode that claim is attacker-controlled, which is
// textbook SSRF: they don't need to reach our private network, they need US to
// reach it. So private destinations are refused by default.
//
// The difference: `allowPrivate`. A LAN peer is the NORMAL case for this repo
// (an agent with no ingress at all), so the caller may open private
// destinations when the URL came from the owner's own allowlist — the owner
// typed it — or when the agent itself is LAN-only and has no public exposure
// to lose. The flag is per-call and the policy for it lives in peers.js, next
// to the reasoning.
//
// Resolution is pinned: the address we VALIDATE is the exact address the socket
// CONNECTS to, because both come from one dns.lookup passed as the request's
// `lookup` option. A separate "check the host, then fetch the host" would
// re-resolve between the two and let a name answer public for the check and
// 127.0.0.1 for the connection (DNS rebinding). Native fetch cannot pin a
// lookup, so this is built on node:http/https directly.

import http from "node:http";
import https from "node:https";
import dnscb from "node:dns";
import net from "node:net";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 2;

export class BlockedError extends Error {}

export function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;               // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("::ffff:")) return isPrivateAddress(s.slice(7)); // v4-mapped
    if (s.startsWith("2002:")) return true;                          // 6to4, can encode a v4 target
    if (s.startsWith("64:ff9b:")) return true;                       // NAT64
    // Keyed on the first hextet, so the WHOLE range is caught — not just the
    // fe80 literal, which left fe90::/fec0::/multicast reachable.
    const h = parseInt(s.split(":")[0] || "0", 16);
    if (!Number.isNaN(h)) {
      if (h >= 0xfc00 && h <= 0xfdff) return true; // ULA        fc00::/7
      if (h >= 0xfe80 && h <= 0xfebf) return true; // link-local fe80::/10
      if (h >= 0xfec0 && h <= 0xfeff) return true; // site-local fec0::/10 (deprecated)
      if (h >= 0xff00) return true;                // multicast  ff00::/8
    }
    return false;
  }
  return true;
}

/**
 * A `lookup` for http/https.request that resolves and validates in one step —
 * the addresses checked here are exactly the ones the socket will use, so there
 * is no rebinding window. Refuses the whole request if ANY candidate is private
 * (unless allowPrivate).
 */
function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dnscb.lookup(hostname, { all: true, ...(options || {}) }, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
      if (!list.length) return cb(new BlockedError(`${hostname} resolved to nothing`));
      if (!allowPrivate) {
        for (const a of list) {
          if (isPrivateAddress(a.address)) {
            return cb(new BlockedError(`${hostname} resolves to a non-public address (${a.address})`));
          }
        }
      }
      if (options && options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

/** One request, no redirect following (the caller decides what a 3xx means). */
function httpOnce(url, { method = "GET", body = null, allowPrivate, timeoutMs, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    let req;
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(hardStop); fn(v); };
    // Absolute deadline. The request `timeout` option is an INACTIVITY timer, so
    // a server dripping one byte before each idle window could hold the socket
    // open forever. This fires once on total elapsed time, whatever arrives.
    const hardStop = setTimeout(() => {
      try { req?.destroy(new Error("timed out")); } catch { /* already gone */ }
      done(reject, new Error("timed out"));
    }, timeoutMs);
    try {
      req = mod.request(
        url,
        {
          method,
          lookup: guardedLookup(allowPrivate),
          headers: {
            accept: "application/json",
            "user-agent": "clayborn/0.1",
            ...(body != null ? { "content-type": "application/json" } : {}),
            ...extraHeaders,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode || 0;
          const location = res.headers.location || null;
          if (status >= 300 && status < 400 && location) {
            // Do NOT drain a redirect body — a hostile server could drip it
            // forever after we've already cleared the deadline, leaking a live
            // background socket. Tear it down; the caller's loop makes a fresh,
            // separately-bounded request to `location`.
            try { req.destroy(); } catch { /* already gone */ }
            return done(resolve, { status, location });
          }
          const chunks = [];
          let total = 0;
          res.on("data", (c) => {
            total += c.length;
            if (total > MAX_BYTES) req.destroy(new Error(`response over ${MAX_BYTES} bytes`));
            else chunks.push(c);
          });
          res.on("end", () => done(resolve, { status, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", (e) => done(reject, e));
        }
      );
    } catch (e) {
      return done(reject, e);
    }
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => done(reject, e));
    if (body != null) req.write(body);
    req.end();
  });
}

/** GET a small JSON document with the whole SSRF battery applied. */
export async function fetchJson(rawUrl, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedError("not a valid URL");
  }

  let redirects = 0;
  const started = Date.now();

  while (true) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new BlockedError(`${url.protocol} is not allowed`);
    }
    // A literal private IP is refused up front; hostnames are validated at
    // connect time by guardedLookup, which is where rebinding would strike.
    const bareHost = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(bareHost) && !allowPrivate && isPrivateAddress(bareHost)) {
      throw new BlockedError(`${bareHost} is not a public address`);
    }

    const remaining = TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) throw new Error("timed out");

    const res = await httpOnce(url, { allowPrivate, timeoutMs: remaining });

    if (res.status >= 300 && res.status < 400 && res.location) {
      if (++redirects > MAX_REDIRECTS) throw new BlockedError("too many redirects");
      const next = new URL(res.location, url);
      // Never let an https origin walk down to http via a redirect. Key material
      // (JWKS) is fetched this way, and an http hop is on-path-swappable — an
      // attacker could serve their own key and forge the issuer's identity.
      if (url.protocol === "https:" && next.protocol !== "https:") {
        throw new BlockedError("refusing to downgrade https → http on redirect");
      }
      url = next; // loop re-validates the new host
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    try {
      return JSON.parse(res.body || "{}");
    } catch {
      throw new Error("not valid JSON");
    }
  }
}

/**
 * POST a JSON body through the same SSRF battery — used for the stroll's
 * anonymous fist bump, which POSTs to an endpoint copied verbatim from a
 * stranger's card. Resolution is pinned exactly like fetchJson, so a hostname
 * that resolves to loopback/LAN is refused at connect. No redirects: a POST
 * that gets redirected is a POST about to be replayed somewhere unvalidated.
 * Returns { status, json } — a 401 is information, not a failure.
 */
export async function postJson(rawUrl, body, { allowPrivate = false, headers = {} } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedError("not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedError(`${url.protocol} is not allowed`);
  }
  const bareHost = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bareHost) && !allowPrivate && isPrivateAddress(bareHost)) {
    throw new BlockedError(`${bareHost} is not a public address`);
  }
  const res = await httpOnce(url, {
    method: "POST",
    body: JSON.stringify(body),
    allowPrivate,
    timeoutMs: TIMEOUT_MS,
    extraHeaders: headers,
  });
  if (res.status >= 300 && res.status < 400) throw new BlockedError("redirected — refused");
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* non-JSON body; caller sees status and null */
  }
  return { status: res.status, json };
}
