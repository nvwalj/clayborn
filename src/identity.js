// Identity: a keypair, and JWTs signed with it.
//
// The design is card-is-identity, the same shape that lets thousands of
// self-hosted Mastodon and Matrix servers authenticate each other with no
// central authority: your identity IS your public URL, your public key is
// published at a well-known path next to your card, and every outbound request
// carries a signature only you could have produced. The receiver fetches your
// key from the URL you claim to be and checks the math.
//
// There is no shared secret anywhere in this file. That is the point: a secret
// you never share is a secret you never have to distribute, rotate across
// machines, or leak.
//
// Everything is node:crypto — Ed25519 keys, hand-rolled JWS (EdDSA). The repo's
// zero-dependency promise holds.

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as edSign,
  verify as edVerify,
  randomUUID,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

export const TOKEN_TTL_S = 300; // five minutes; these tokens exist per-call, not per-session
export const CLOCK_SKEW_S = 60;

/** Load the identity file, or mint one on first boot. The private key never leaves this machine. */
export function loadIdentity(file, log = console.log) {
  let pem;
  if (existsSync(file)) {
    pem = JSON.parse(readFileSync(file, "utf8")).privateKeyPem;
  } else {
    const { privateKey } = generateKeyPairSync("ed25519");
    pem = privateKey.export({ type: "pkcs8", format: "pem" });
    writeFileSync(file, JSON.stringify({ privateKeyPem: pem, createdAt: new Date().toISOString() }, null, 2));
    chmodSync(file, 0o600);
    log(`[identity] new Ed25519 keypair written to ${file}`);
  }
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" }); // { kty: "OKP", crv: "Ed25519", x }
  const kid = thumbprint(jwk);
  return { privateKey, publicKey, jwk: { ...jwk, kid, alg: "EdDSA", use: "sig" }, kid };
}

/** RFC 7638 thumbprint — the canonical JSON of the required members, hashed. */
export function thumbprint(jwk) {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  return createHash("sha256").update(canonical).digest("base64url");
}

/** The document served at /.well-known/jwks.json. */
export function jwks(identity) {
  return { keys: [identity.jwk] };
}

/**
 * Mint a token proving "the agent at `iss` is calling `aud`, now".
 * aud is bound so a token captured by one peer cannot be replayed at another;
 * jti so it cannot be replayed at the same one.
 */
export function mintToken(identity, { iss, aud }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: identity.kid };
  const payload = { iss, aud, iat: now, exp: now + TOKEN_TTL_S, jti: randomUUID() };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = edSign(null, Buffer.from(input), identity.privateKey); // null = Ed25519 pre-hash-free
  return `${input}.${b64u(sig)}`;
}

/** Split and parse without verifying — the verifier decides what to do with it. */
export function decodeToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(fromB64u(parts[0]).toString("utf8")),
      payload: JSON.parse(fromB64u(parts[1]).toString("utf8")),
      input: `${parts[0]}.${parts[1]}`,
      sig: fromB64u(parts[2]),
    };
  } catch {
    return null;
  }
}

/** Verify one decoded token against one JWK. Pure math — no policy here. */
export function verifySignature(decoded, jwk) {
  if (decoded.header.alg !== "EdDSA") return false; // never let the token pick a weaker algorithm
  let key;
  try {
    key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" });
  } catch {
    return false;
  }
  try {
    return edVerify(null, Buffer.from(decoded.input), key, decoded.sig);
  } catch {
    return false;
  }
}

/** Time-window checks, shared by the verifier. */
export function checkTimes(payload, nowS = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(payload.exp)) return "no exp";
  if (payload.exp < nowS - CLOCK_SKEW_S) return "expired";
  if (Number.isFinite(payload.iat) && payload.iat > nowS + CLOCK_SKEW_S) return "iat is in the future";
  // Bound how long a stolen token stays usable and how long jti caches must remember.
  if (payload.exp > nowS + TOKEN_TTL_S + CLOCK_SKEW_S * 2) return "exp too far in the future";
  return null;
}

/** Base-URL normalisation used everywhere identities are compared. */
export function normBase(u) {
  const url = new URL(u);
  return url.origin + url.pathname.replace(/\/+$/, "");
}
