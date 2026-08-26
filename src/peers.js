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

import { decodeToken, verifySignature, checkTimes, normBase, thumbprint } from "./identity.js";
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

  const getKeys = fetchJwks || (async (base, allowPrivate) => {
    const cached = jwksCache.get(base);
    if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
    const doc = await fetchJson(`${base}/.well-known/jwks.json`, { allowPrivate });
    const keys = Array.isArray(doc?.keys) ? doc.keys : [];
    jwksCache.set(base, { keys, at: Date.now() });
    return keys;
  });

  function replaySeen(key, expS) {
    if (seenJti.has(key)) return true;
    seenJti.set(key, expS * 1000);
    if (seenJti.size > MAX_REPLAY_ENTRIES) {
      const now = Date.now();
      for (const [k, exp] of seenJti) {
        if (exp < now) seenJti.delete(k);
        if (seenJti.size <= MAX_REPLAY_ENTRIES / 2) break;
      }
    }
    return false;
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

      // Try the claimed kid first; on a miss re-fetch once, in case they rotated.
      let jwk = keys.find((k) => k.kid === decoded.header.kid) || keys.find((k) => k.crv === "Ed25519");
      if (jwk && jwk.kid && decoded.header.kid && jwk.kid !== decoded.header.kid && !fetchJwks) {
        jwksCache.delete(iss);
        try {
          keys = await getKeys(iss, allowPrivate);
          jwk = keys.find((k) => k.kid === decoded.header.kid) || jwk;
        } catch { /* keep the cached candidate */ }
      }
      if (!jwk) return { ok: false, reason: `${iss} publishes no usable key` };

      if (!verifySignature(decoded, jwk)) return { ok: false, reason: "signature check failed" };

      if (p.jti && replaySeen(`${iss}#${p.jti}`, p.exp)) {
        return { ok: false, reason: "token replayed" };
      }

      return { ok: true, iss, kid: jwk.kid || thumbprint(jwk) };
    },
  };
}
