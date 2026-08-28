#!/usr/bin/env node
// Call another A2A agent, authenticating as this one.
//
//   node scripts/call.js <peer-base-url> "message…" --iss <my-base-url>
//   node scripts/call.js <peer-base-url> "message…" --token <static-token>
//
// With --iss, requests carry a JWT signed by this machine's identity file, and
// the peer verifies it by fetching <my-base-url>/.well-known/jwks.json — so the
// agent at --iss must be RUNNING; its jwks route is how you are believed.
//
// Options:
//   --iss <url>        who I am (my agent's public base URL)
//   --identity <file>  identity file (default: clayborn.identity.json in repo root)
//   --token <string>   use a static bearer token instead of an identity
//   --skill <id>       ask the peer for a specific skill
//   --timeout <s>      give up after this many seconds (default 120)

import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadIdentity, mintToken, normBase } from "../src/identity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--iss") args.iss = argv[++i];
    else if (a === "--identity") args.identity = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--skill") args.skill = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else args.words.push(a);
  }
  args.peer = args.words.shift();
  args.message = args.words.join(" ");
  return args;
}

const die = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

const args = parseArgs(process.argv.slice(2));
if (!args.peer || !args.message) {
  die('usage: call.js <peer-base-url> "message" (--iss <my-base-url> | --token <t>) [--skill id]');
}
if (!args.token && !args.iss) {
  die("pick an identity: --iss <my-base-url> (signed JWT) or --token <static>");
}

// Who am I, if signing.
let identity = null;
if (!args.token) {
  identity = loadIdentity(path.resolve(args.identity || path.join(ROOT, "clayborn.identity.json")), () => {});
}

// Read the peer's card; it tells us where the JSON-RPC endpoint really is,
// and its base is what we bind the audience to.
const peerBase = args.peer.replace(/\/+$/, "");
const card = await getJson(`${peerBase}/.well-known/agent-card.json`).catch((e) =>
  die(`cannot read the peer's card: ${e.message}`)
);
const iface =
  (card.supportedInterfaces || []).find((i) => i.protocolBinding === "JSONRPC") ||
  die(`${card.name || "peer"} declares no JSONRPC interface`);
const endpoint = iface.url;
const aud = normBase(endpoint.replace(/\/a2a$/, "") || peerBase);

console.log(`\n  → ${card.name}  (${endpoint})`);

// One fresh token per request: the peer's replay cache is allowed to assume a
// jti is seen once, so reusing a token across polls would 401 the second poll.
const authHeader = () =>
  args.token ? `Bearer ${args.token}` : `Bearer ${mintToken(identity, { iss: args.iss, aud })}`;

async function rpc(method, params) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authHeader() },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) die(`unauthorized: ${body?.error?.data || "(no reason given)"}`);
  if (body.error) die(`${method} → ${body.error.message}${body.error.data ? `: ${body.error.data}` : ""}`);
  return body.result;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const message = {
  messageId: randomUUID(),
  role: "ROLE_USER",
  parts: [{ text: args.message }],
};
// Return immediately and poll ourselves: the server now BLOCKS by default until
// terminal, which for a long task would outlast this client's per-call timeout.
const params = { message, configuration: { blocking: false } };
if (args.skill) params.metadata = { skillId: args.skill };

const sent = await rpc("SendMessage", params);
// SendMessage's result is the v1.0.1 envelope { task }; fall back to a bare
// task for any agent still on the old shape.
let task = sent?.task || sent;
console.log(`  task ${task.id} → ${task.status.state}`);

const finish = (t) => {
  if (/COMPLETED/.test(t.status.state)) {
    const text = t.artifacts?.[0]?.parts?.map((p) => p.text).filter(Boolean).join("\n") || "(no text)";
    // Exit only once stdout has drained — console.log + an immediate
    // process.exit(0) truncates a large piped answer mid-buffer.
    process.stdout.write(`\n${text.replace(/^/gm, "  ")}\n`, () => process.exit(0));
    return;
  }
  die(`${t.status.state}${t.metadata?.error ? `: ${t.metadata.error}` : ""}`);
};

const deadline = Date.now() + (args.timeout || 120) * 1000;
let state = task.status.state;
while (!/COMPLETED|FAILED|CANCELED|REJECTED/.test(state)) {
  if (Date.now() > deadline) die(`timed out in ${state}`);
  await new Promise((r) => setTimeout(r, 1500));
  task = await rpc("GetTask", { id: task.id });
  if (task.status.state !== state) {
    state = task.status.state;
    console.log(`  … ${state}`);
  }
}
// Terminal — whether the initial reply was already terminal or we polled to it.
finish(task);
