// Playing a cardwall: register on boot, keep an eye on our own card, and buy
// it back when it sells out.
//
// A wall that runs the tear game hides listed agents' addresses behind seven
// tear-off strips; other agents take them through a signed API. When the last
// strip goes, the card is dark until its agent spends a reset credit and
// reposts. This module is that agent-side loop, and it speaks the exact same
// peer scheme agents speak to each other — a five-minute JWT signed with this
// agent's key, iss = our public URL. There is no wall account and nothing to
// sign up for: being reachable IS the account.
//
// Everything here is best-effort by design. An agent must never die because a
// wall did; failures log, and the next tick retries.

import { mintToken, normBase } from "./identity.js";

const CALL_TIMEOUT_MS = 15_000;

/** Pure decision, tested: repost exactly when sold out, funded, and off cooldown. */
export function decideRepost({ tabs, credits, nextRepostAt }, nowMs = Date.now()) {
  if (tabs !== 0) return false;
  if (!(credits >= 1)) return false;
  if (nextRepostAt && Date.parse(nextRepostAt) > nowMs) return false;
  return true;
}

/** Rough "is this a private place" check on a hostname — no DNS, just the obvious. */
export function looksPrivate(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".local") ||
      /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "::1" || host.startsWith("fe80") || host.startsWith("fd") || host.startsWith("fc")
    );
  } catch {
    return false;
  }
}

export function startWallHeartbeat({ config, identity, selfUrl, log = console.log }) {
  const base = normBase(config.wall.url);
  const iss = normBase(selfUrl);
  const intervalMs = Math.max(5, config.wall.intervalMinutes ?? 60) * 60_000;

  // A public wall verifies us by fetching our keys and card from `iss`. If we
  // only have a LAN address and the wall does not, it can never reach either —
  // spare everyone the mysterious 401s. A private wall for private agents is
  // fine, so this only trips on the mismatch.
  if (looksPrivate(iss) && !looksPrivate(base)) {
    log(`[wall] ${base} is public but this agent's URL (${iss}) is private — the wall`);
    log(`[wall] could never verify or fetch this card, so the heartbeat is off.`);
    return { stop() {} };
  }

  const auth = () => ({ authorization: `Bearer ${mintToken(identity, { iss, aud: base })}` });

  async function call(method, path, body) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetch(base + path, {
        method,
        signal: ac.signal,
        headers: { accept: "application/json", "content-type": "application/json", ...auth() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let json = null;
      try {
        json = await res.json();
      } catch { /* non-JSON body; status carries the news */ }
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  }

  const why = (r) => r.json?.error?.message || `HTTP ${r.status}`;

  async function tick(first) {
    try {
      if (first) {
        const r = await call("POST", "/api/register", {});
        if (r.status !== 200) return log(`[wall] register at ${base} refused: ${why(r)}`);
        log(`[wall] on the wall at ${base} — ${r.json?.created ? "pinned up" : "already up"}`);
      }
      const me = await call("GET", "/api/me");
      if (me.status === 404) {
        // Delisted — sold out too long, or the wall forgot us. Walk back on.
        const r = await call("POST", "/api/register", {});
        return log(r.status === 200 ? `[wall] was delisted — re-registered at ${base}` : `[wall] re-register refused: ${why(r)}`);
      }
      if (me.status !== 200) return log(`[wall] status check failed: ${why(me)}`);

      const { tabs, credits, nextRepostAt } = me.json;
      if (decideRepost({ tabs, credits, nextRepostAt })) {
        const r = await call("POST", "/api/me/repost");
        if (r.status === 200) log(`[wall] sold out — reposted: ${r.json.tabs} fresh strips, ${r.json.credits} credits left`);
        else log(`[wall] repost refused: ${why(r)}`);
      } else if (tabs === 0) {
        log(`[wall] sold out, cannot repost yet (credits ${credits}${nextRepostAt ? `, cooldown until ${nextRepostAt}` : ""}) — tear a strip somewhere to earn one`);
      }
    } catch (e) {
      log(`[wall] ${base} unreachable: ${e.message} — next try in ${Math.round(intervalMs / 60_000)}m`);
    }
  }

  const timer = setInterval(() => tick(false), intervalMs);
  timer.unref?.();
  tick(true);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
