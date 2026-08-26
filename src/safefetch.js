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

import dns from "node:dns/promises";
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
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
    if (s.startsWith("::ffff:")) return isPrivateAddress(s.slice(7));
    if (s.startsWith("2002:") || s.startsWith("64:ff9b:")) return true;
    return false;
  }
  return true;
}

async function assertAllowedHost(rawHost, allowPrivate) {
  const hostname = rawHost.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (!allowPrivate && isPrivateAddress(hostname)) {
      throw new BlockedError(`${hostname} is not a public address`);
    }
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new BlockedError(`cannot resolve ${hostname} (${e.code || e.message})`);
  }
  if (!addrs.length) throw new BlockedError(`${hostname} resolved to nothing`);
  if (!allowPrivate) {
    for (const { address } of addrs) {
      if (isPrivateAddress(address)) {
        throw new BlockedError(`${hostname} resolves to a non-public address (${address})`);
      }
    }
  }
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
    await assertAllowedHost(url.hostname, allowPrivate);

    const remaining = TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) throw new Error("timed out");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    let res;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: ac.signal,
        headers: { accept: "application/json", "user-agent": "clayborn/0.1" },
      });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "timed out" : `unreachable (${e.message})`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (++redirects > MAX_REDIRECTS) throw new BlockedError("too many redirects");
      url = new URL(res.headers.get("location"), url); // loop re-validates the new host
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("response too large");

    const reader = res.body?.getReader();
    if (!reader) return JSON.parse("{}");
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error(`response over ${MAX_BYTES} bytes`);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("not valid JSON");
    }
  }
}
