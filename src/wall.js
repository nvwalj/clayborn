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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CALL_TIMEOUT_MS = 15_000;
const STROLL_GAP_MS = 20 * 3600_000; // "daily", with slack for uneven heartbeats

/** Pure decision, tested: repost exactly when sold out, funded, and off cooldown. */
export function decideRepost({ tabs, credits, nextRepostAt }, nowMs = Date.now()) {
  if (tabs !== 0) return false;
  if (!(credits >= 1)) return false;
  if (nextRepostAt && Date.parse(nextRepostAt) > nowMs) return false;
  return true;
}

/** Pure and tested: who to meet today. Prefer who the wall matched us with. */
export function pickStranger({ agents, myId, met, preferIds = [] }, rand = Math.random) {
  const unmet = agents.filter((a) => a.id !== myId && a.alive && !met[a.id]);
  if (!unmet.length) return null;
  const preferred = unmet.filter((a) => preferIds.includes(a.id));
  const pool = preferred.length ? preferred : unmet;
  return pool[Math.floor(rand() * pool.length)];
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

      const { tabs, credits, nextRepostAt, matches, soughtBy } = me.json;
      // The wall's matchmaking, surfaced where the owner will see it. Only
      // logs — whether to spend a tear on a match stays the owner's call.
      if (soughtBy?.length) {
        log(`[wall] ${soughtBy.length} agent(s) on the wall are seeking what you offer: ${soughtBy.map((m) => m.name).join(", ")}`);
      }
      if (matches?.length) {
        log(`[wall] ${matches.length} agent(s) match what you seek: ${matches.map((m) => `${m.name} (${m.tags.join("/")})`).join(", ")}`);
      }
      if (config.wall.stroll !== false) {
        await stroll(me.json).catch((e) => log(`[stroll] went badly, will retry tomorrow: ${e.message}`));
      }
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

  // ── the stroll ────────────────────────────────────────────────────────────
  // Once a day, meet ONE agent this one has never met: tear its strip, bump
  // fists on its anonymous echo, and write the owner a line about who it was.
  // The friends file is the agent's social life, kept next to its identity.
  const friendsFile = path.join(path.dirname(path.resolve(config.identityFile || "clayborn.identity.json")), "clayborn.friends.json");
  const loadFriends = () => {
    try {
      return existsSync(friendsFile) ? JSON.parse(readFileSync(friendsFile, "utf8")) : { met: {}, lastStrollAt: 0 };
    } catch {
      return { met: {}, lastStrollAt: 0 };
    }
  };
  const saveFriends = (f) => writeFileSync(friendsFile, JSON.stringify(f, null, 2) + "\n");

  async function stroll(meState) {
    const friends = loadFriends();
    if (Date.now() - (friends.lastStrollAt || 0) < STROLL_GAP_MS) return;
    friends.lastStrollAt = Date.now(); // whatever happens next, one attempt per day

    const listRes = await fetch(`${base}/agents.json`, { headers: { accept: "application/json" } });
    if (!listRes.ok) return saveFriends(friends);
    const { agents } = await listRes.json();
    const preferIds = [...(meState.matches || []), ...(meState.soughtBy || [])].map((m) => m.id);
    const pick = pickStranger({ agents: agents || [], myId: meState.id, met: friends.met, preferIds });
    if (!pick) {
      saveFriends(friends);
      return log(`[stroll] no one new on the wall today — met everyone`);
    }

    const torn = await call("POST", `/api/agents/${pick.id}/tear`);
    if (torn.status !== 200) {
      saveFriends(friends);
      return log(`[stroll] wanted to meet ${pick.name}, but the wall said no: ${why(torn)}`);
    }

    const friend = {
      name: pick.name,
      endpoint: torn.json.endpoint,
      cardUrl: torn.json.url,
      skills: (pick.skills || []).map((s) => s.id || s.name),
      metAt: new Date().toISOString(),
    };
    const bump = await fistBump(torn.json.endpoint);
    Object.assign(friend, bump);
    friends.met[pick.id] = friend;
    saveFriends(friends);

    const skillsNote = friend.skills.length ? ` — it can: ${friend.skills.join(", ")}` : "";
    if (bump.echoMs != null) log(`[stroll] met ${pick.name}${skillsNote}; fist bump answered in ${(bump.echoMs / 1000).toFixed(1)}s`);
    else log(`[stroll] met ${pick.name}${skillsNote}; it keeps its door locked (${bump.shy}) — address saved anyway`);
  }

  /** Anonymous echo against a fresh acquaintance. No credentials — that is the point. */
  async function fistBump(endpoint) {
    if (!endpoint) return { shy: "no endpoint in its card" };
    const t0 = Date.now();
    try {
      const post = (bodyObj) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(bodyObj),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

      const sent = await post({
        jsonrpc: "2.0", id: randomUUID(), method: "SendMessage",
        params: {
          metadata: { skillId: "echo" },
          message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: `first contact — hello from ${config.name || "a fellow agent"} off the wall` }] },
        },
      });
      if (sent.status === 401) return { shy: "requires credentials" };
      const taskId = sent.json?.result?.id;
      if (!taskId) return { shy: `odd reply (HTTP ${sent.status})` };
      let state = sent.json.result.status?.state || "";
      for (let i = 0; i < 5 && !/COMPLETED|FAILED|CANCELED|REJECTED/.test(state); i++) {
        await new Promise((r) => setTimeout(r, 600));
        const got = await post({ jsonrpc: "2.0", id: randomUUID(), method: "GetTask", params: { id: taskId } });
        state = got.json?.result?.status?.state || state;
      }
      return /COMPLETED/.test(state) ? { echoMs: Date.now() - t0 } : { shy: `echo ended ${state || "nowhere"}` };
    } catch (e) {
      return { shy: e.name === "TimeoutError" ? "timed out" : e.message.slice(0, 60) };
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
