// Peer authentication: deciding whether "the agent at URL X is calling" is true,
// and whether X is welcome.
//
// Inbound requests may carry a bearer JWT minted by src/identity.js on another
// machine. Verification is: read the token's `iss` (a base URL), apply POLICY
// first, then fetch that base's /.well-known/jwks.json, check the signature,
// the audience, the clock, and the jti. Policy before fetch, because in
// allowlist mode a stranger's token must cost us nothing — not even a network
// round trip.
//
// Modes:
//   off        — no peer auth; only the static token (if any) applies
//   allowlist  — only base URLs the owner listed may call. Fetching THEIR keys
//                may touch private addresses: the owner typed the URL, LAN
//                peers are this repo's normal case.
//   anyone     — any agent that can prove control of a URL may call. Key
//                fetches then follow the SSRF rule: private destinations are
//                refused unless this agent is itself LAN-only (ingress none),
//                where "private" is simply where its world is.
//
// What this buys: identity without distribution. There is no secret to hand
// out — being callable comes from your card being public, being believed comes
// from your signature. Revocation is deleting a line from the allowlist.

import { decodeToken, verifySignature, checkTimes, normBase, thumbprint, CLOCK_SKEW_S } from "./identity.js";
import { fetchJson, BlockedError } from "./safefetch.js";

const JWKS_TTL_MS = 5 * 60_000;
const MAX_REPLAY_ENTRIES = 8192;

export function createPeerVerifier({ config, getSelfUrl, log = console.log, fetchJwks }) {
  const mode = config.peers?.mode || "off";
  if (mode === "off") return null;
  if (mode !== "allowlist" && mode !== "anyone") {
    throw new Error(`unknown peers.mode: ${mode} (expected off | allowlist | anyone)`);
  }

  const allow = new Set();
  if (mode === "allowlist") {
    for (const u of config.peers?.allow || []) {
      try {
        allow.add(normBase(u));
      } catch {
        throw new Error(`peers.allow contains an invalid URL: ${u}`);
      }
    }
    if (!allow.size) {
      throw new Error(
        'peers.mode is "allowlist" but peers.allow is empty — that locks every peer out. ' +
          'List their base URLs, or use "anyone".'
      );
    }
  }

  // In anyone mode, may we fetch keys from private addresses? Only if this
  // agent is itself LAN-only — a public agent fetching attacker-chosen private
  // URLs is the SSRF we refuse.
  const anyonePrivateOk =
    config.peers?.allowPrivateNetwork ?? (config.ingress?.mode || "quick") === "none";

  const jwksCache = new Map(); // base -> { keys, at }
  const seenJti = new Map();   // `${iss}#${jti}` -> expMs
  const MAX_JWKS_ENTRIES = 512;

  // Cache keys ONLY once a signature has verified against them. Otherwise a
  // stranger in "anyone" mode who names a fresh iss on every call — each
  // serving a large, nonempty JWKS and a bad signature — would grow this map
  // without bound. LRU-cap it too, so even verified issuers can't exhaust us.
  function cacheKeys(base, keys) {
    jwksCache.delete(base); // re-insert => newest
    jwksCache.set(base, { keys, at: Date.now() });
    while (jwksCache.size > MAX_JWKS_ENTRIES) jwksCache.delete(jwksCache.keys().next().value);
  }

  const fetchUncached = fetchJwks
    ? (base) => Promise.resolve(fetchJwks(base))
    : async (base, allowPrivate) => {
        const doc = await fetchJson(`${base}/.well-known/jwks.json`, { allowPrivate });
        return Array.isArray(doc?.keys) ? doc.keys : [];
      };

  // Admission control for outbound key fetches, same reasoning as the wall: in
  // "anyone" mode any syntactically valid JWT triggers a fetch of its claimed
  // issuer before the signature is known. Coalesce concurrent fetches for one
  // issuer into a single request, and cap the total in flight — past the cap we
  // fail fast rather than open another socket a slow issuer can hold.
  const MAX_INFLIGHT = 6;
  let inflightCount = 0;
  const inflight = new Map(); // base -> Promise<keys>

  async function getKeys(base, allowPrivate, { refresh = false } = {}) {
    if (!refresh) {
      const cached = jwksCache.get(base);
      if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
    }
    const shared = inflight.get(base);
    if (shared) return shared;
    if (inflightCount >= MAX_INFLIGHT) throw new Error("key-fetch capacity reached — retry shortly");
    inflightCount++;
    const p = Promise.resolve()
      .then(() => fetchUncached(base, allowPrivate)) // committed to cache only on a verified signature
      .finally(() => { inflightCount--; inflight.delete(base); });
    inflight.set(base, p);
    return p;
  }

  // Returns "ok" | "replay" | "full". Fails closed at saturation: it never
  // evicts an unexpired marker (forgetting a live jti is the replay it guards
  // against), and the prune scan runs only when at cap — steady state is a
  // plain has/set, never an O(n) sweep that grows the map on every call.
  function reserveJti(key, expS) {
    if (seenJti.has(key)) return "replay";
    if (seenJti.size >= MAX_REPLAY_ENTRIES) {
      // Fixed TTL ⇒ the oldest-INSERTED entry expires first. Check only that
      // one: expired → evict, O(1); still live → the map is full of live
      // markers, so fail closed. No O(n) sweep per request at saturation.
      const oldestKey = seenJti.keys().next().value;
      if (seenJti.get(oldestKey) <= Date.now()) seenJti.delete(oldestKey);
      else return "full";
    }
    // Keep the marker strictly LONGER than the token is accepted. checkTimes
    // admits it through the whole second at exp + CLOCK_SKEW_S (compare is `<`),
    // so a marker expiring exactly there could be evicted during that final
    // accepting second. The +1 closes that one-second replay window.
    seenJti.set(key, (expS + CLOCK_SKEW_S + 1) * 1000);
    return "ok";
  }

  return {
    mode,
    async verify(token) {
      const decoded = decodeToken(token);
      if (!decoded) return { ok: false, reason: "not a JWT" };
      if (decoded.header.alg !== "EdDSA") return { ok: false, reason: `alg ${decoded.header.alg} not accepted` };

      const p = decoded.payload;
      let iss;
      try {
        iss = normBase(p.iss);
      } catch {
        return { ok: false, reason: "iss is not a URL" };
      }

      // Policy first: strangers must cost nothing.
      if (mode === "allowlist" && !allow.has(iss)) {
        return { ok: false, reason: `${iss} is not on the allowlist` };
      }

      // A public agent in "anyone" mode fetches an unknown stranger's keys from
      // their iss. Over http that fetch is on-path-attackable: a MITM swaps in
      // their own JWKS and the signature then "proves" they are the stranger.
      // Require https for the identity — a LAN agent (allowPrivate) is exempt,
      // its world is http by nature and off the public path.
      if (mode === "anyone" && !anyonePrivateOk) {
        try {
          if (new URL(iss).protocol !== "https:") return { ok: false, reason: "iss must be https" };
        } catch {
          return { ok: false, reason: "iss is not a URL" };
        }
      }

      const timeErr = checkTimes(p);
      if (timeErr) return { ok: false, reason: timeErr };

      const self = getSelfUrl();
      if (!self) return { ok: false, reason: "not ready" };
      let aud;
      try {
        aud = normBase(p.aud);
      } catch {
        return { ok: false, reason: "aud is not a URL" };
      }
      if (aud !== normBase(self)) {
        return { ok: false, reason: `aud ${aud} is not this agent` };
      }

      const allowPrivate = mode === "allowlist" ? true : anyonePrivateOk;
      let keys;
      try {
        keys = await getKeys(iss, allowPrivate);
      } catch (e) {
        const why = e instanceof BlockedError ? `refused to fetch keys: ${e.message}` : `keys unreachable: ${e.message}`;
        return { ok: false, reason: `${iss} — ${why}` };
      }

      // Prefer the claimed kid; on a miss, re-fetch once in case they rotated.
      const pick = (ks) => ks.find((k) => k.kid === decoded.header.kid) || null;
      let jwk = pick(keys);
      if (!jwk && decoded.header.kid && !fetchJwks) {
        try { keys = await getKeys(iss, allowPrivate, { refresh: true }); jwk = pick(keys); }
        catch { /* keep the keys we have */ }
      }
      // A kid miss is not "no key": try every published Ed25519 key rather than
      // trusting the header's claim about which one signed it.
      const candidates = jwk ? [jwk] : keys.filter((k) => k.crv === "Ed25519" || k.kty === "OKP");
      const good = candidates.find((k) => verifySignature(decoded, k));
      if (!good) return { ok: false, reason: `${iss} — signature does not verify against its published keys` };

      // jti is required: a token without one could be replayed forever.
      if (!p.jti || typeof p.jti !== "string") return { ok: false, reason: "missing jti" };
      const reserved = reserveJti(`${iss}#${p.jti}`, p.exp);
      if (reserved === "replay") return { ok: false, reason: "token replayed" };
      if (reserved === "full") return { ok: false, reason: "replay cache saturated — retry shortly" };

      cacheKeys(iss, keys); // only a verified issuer earns a place in the cache
      return { ok: true, iss, kid: good.kid || thumbprint(good) };
    },
  };
}
