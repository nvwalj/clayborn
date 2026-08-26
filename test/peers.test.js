// Peer auth: the crypto, the policy, and the ways a token must die.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadIdentity,
  jwks,
  mintToken,
  decodeToken,
  verifySignature,
  normBase,
} from "../src/identity.js";
import { createPeerVerifier } from "../src/peers.js";

const dir = mkdtempSync(path.join(tmpdir(), "clayborn-id-"));
const caller = loadIdentity(path.join(dir, "caller.json"), () => {});
const stranger = loadIdentity(path.join(dir, "stranger.json"), () => {});

const CALLER = "https://caller.test";
const ME = "https://me.test";

/** A verifier whose key lookups are injected, so no test touches the network. */
function makeVerifier({ mode = "allowlist", allow = [CALLER], keysFor = {} } = {}) {
  const calls = { fetches: 0 };
  const verifier = createPeerVerifier({
    config: { peers: { mode, allow }, ingress: { mode: "quick" } },
    getSelfUrl: () => ME,
    log: () => {},
    fetchJwks: async (base) => {
      calls.fetches++;
      const doc = keysFor[base];
      if (!doc) throw new Error("no such issuer");
      return doc.keys;
    },
  });
  return { verifier, calls };
}

test("identity file roundtrips and jwks has the right shape", () => {
  const again = loadIdentity(path.join(dir, "caller.json"), () => {});
  assert.equal(again.kid, caller.kid, "same file, same key, same kid");
  const doc = jwks(caller);
  assert.equal(doc.keys[0].kty, "OKP");
  assert.equal(doc.keys[0].crv, "Ed25519");
  assert.equal(doc.keys[0].alg, "EdDSA");
});

test("mint → verify roundtrip", async () => {
  const { verifier } = makeVerifier({ keysFor: { [CALLER]: jwks(caller) } });
  const r = await verifier.verify(mintToken(caller, { iss: CALLER, aud: ME }));
  assert.equal(r.ok, true);
  assert.equal(r.iss, CALLER);
});

test("a stranger not on the allowlist is refused before any key fetch", async () => {
  const { verifier, calls } = makeVerifier({ keysFor: { [CALLER]: jwks(caller) } });
  const r = await verifier.verify(mintToken(stranger, { iss: "https://stranger.test", aud: ME }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /allowlist/);
  assert.equal(calls.fetches, 0, "policy must reject without spending a network round trip");
});

test("audience is bound: a token for someone else dies here", async () => {
  const { verifier } = makeVerifier({ keysFor: { [CALLER]: jwks(caller) } });
  const r = await verifier.verify(mintToken(caller, { iss: CALLER, aud: "https://other.test" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /aud/);
});

test("an expired token is dead", async () => {
  const { verifier } = makeVerifier({ keysFor: { [CALLER]: jwks(caller) } });
  const realNow = Date.now;
  Date.now = () => realNow() - 3600_000; // mint an hour in the past
  const stale = mintToken(caller, { iss: CALLER, aud: ME });
  Date.now = realNow;
  const r = await verifier.verify(stale);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/);
});

test("a tampered payload fails the signature, even with valid times and audience", async () => {
  const { verifier } = makeVerifier({ keysFor: { [CALLER]: jwks(caller) } });
  const token = mintToken(caller, { iss: CALLER, aud: ME });
  const [h, p, s] = token.split(".");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  payload.jti = "forged-" + payload.jti; // changes nothing checked before the signature
  const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
  const r = await verifier.verify(forged);
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature/);
});

test("the same token cannot be spent twice", async () => {
  const { verifier } = makeVerifier({ keysFor: { [CALLER]: jwks(caller) } });
  const token = mintToken(caller, { iss: CALLER, aud: ME });
  assert.equal((await verifier.verify(token)).ok, true);
  const again = await verifier.verify(token);
  assert.equal(again.ok, false);
  assert.match(again.reason, /replayed/);
});

test("a signature from the wrong key is refused even for an allowlisted issuer", async () => {
  // stranger forges iss=CALLER but signs with its own key; CALLER's jwks won't match
  const { verifier } = makeVerifier({ keysFor: { [CALLER]: jwks(caller) } });
  const r = await verifier.verify(mintToken(stranger, { iss: CALLER, aud: ME }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature/);
});

test("anyone mode admits any issuer that proves its key", async () => {
  const OTHER = "https://someone.else";
  const { verifier } = makeVerifier({
    mode: "anyone",
    allow: [],
    keysFor: { [OTHER]: jwks(stranger) },
  });
  const r = await verifier.verify(mintToken(stranger, { iss: OTHER, aud: ME }));
  assert.equal(r.ok, true);
});

test("allowlist mode with an empty list refuses to construct", () => {
  assert.throws(
    () =>
      createPeerVerifier({
        config: { peers: { mode: "allowlist", allow: [] } },
        getSelfUrl: () => ME,
        log: () => {},
      }),
    /locks every peer out/
  );
});

test("alg is pinned to EdDSA — a token cannot pick its own algorithm", async () => {
  const { verifier } = makeVerifier({ keysFor: { [CALLER]: jwks(caller) } });
  const [h, p, s] = mintToken(caller, { iss: CALLER, aud: ME }).split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  header.alg = "none";
  const evil = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${p}.${s}`;
  const r = await verifier.verify(evil);
  assert.equal(r.ok, false);
  assert.match(r.reason, /alg/);
});

test("normBase treats trailing slashes and ports consistently", () => {
  assert.equal(normBase("https://a.test/"), "https://a.test");
  assert.equal(normBase("http://10.0.1.225:8788/"), "http://10.0.1.225:8788");
  assert.notEqual(normBase("http://a.test:8788"), normBase("http://a.test:8789"));
});

test("decode/verifySignature are sane on garbage", () => {
  assert.equal(decodeToken("not-a-jwt"), null);
  assert.equal(decodeToken("a.b"), null);
  const d = decodeToken(mintToken(caller, { iss: CALLER, aud: ME }));
  assert.equal(verifySignature(d, jwks(stranger).keys[0]), false, "wrong key must not verify");
  assert.equal(verifySignature(d, jwks(caller).keys[0]), true);
});
