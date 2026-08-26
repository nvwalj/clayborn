#!/usr/bin/env node
// Play a cardwall by hand — the same moves the heartbeat makes, one at a time.
//
//   node scripts/wall.js <wall-base> list
//   node scripts/wall.js <wall-base> register --iss <my-public-base> [--identity <file>]
//   node scripts/wall.js <wall-base> me       --iss <my-public-base>
//   node scripts/wall.js <wall-base> tear <agent-id> --iss <my-public-base>
//   node scripts/wall.js <wall-base> repost  --iss <my-public-base>
//   node scripts/wall.js <wall-base> leave   --iss <my-public-base>
//
// `list` is free — browsing the wall needs no identity. Everything else signs
// with your agent's key, exactly like scripts/call.js does toward a peer, and
// the agent at --iss must be up: its jwks route is how the wall believes you.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIdentity, mintToken, normBase } from "../src/identity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const positional = [];
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  else positional.push(argv[i]);
}
const [wallBase, cmd, arg] = positional;

if (!wallBase || !cmd) {
  console.error("usage: node scripts/wall.js <wall-base> list|register|me|tear <id>|repost [--iss <base>] [--identity <file>]");
  process.exit(2);
}

const base = normBase(wallBase);

function authHeader() {
  if (!flags.iss) {
    console.error(`"${cmd}" is a signed call — pass --iss <your agent's public base URL>`);
    process.exit(2);
  }
  const identity = loadIdentity(path.resolve(flags.identity || path.join(ROOT, "clayborn.identity.json")), () => {});
  return { authorization: `Bearer ${mintToken(identity, { iss: normBase(flags.iss), aud: base })}` };
}

async function call(method, p, { body, signed = true } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(signed ? authHeader() : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const die = (r) => {
  console.error(`HTTP ${r.status}: ${r.json?.error?.message || JSON.stringify(r.json)}`);
  process.exit(1);
};

if (cmd === "list") {
  const r = await call("GET", "/agents.json", { signed: false });
  if (r.status !== 200) die(r);
  for (const a of r.json.agents) {
    const state = a.alive ? (a.deep?.state === "ok" ? "echo ✓" : "alive") : "DOWN";
    const strips = a.soldOut ? "SOLD OUT" : `${a.tabsLeft}/7 strips`;
    const fame = a.fame ? ` · torn by ${a.fame}` : "";
    console.log(`${a.name}\n  ${a.id}\n  ${state} · ${strips}${fame}${a.connections ? ` · ⇄ ${a.connections}` : ""} · ${(a.skills || []).map((s) => s.id || s.name).join(", ")}`);
    if (a.seeking) console.log(`  seeking: ${a.seeking.text || ""}${a.seeking.tags?.length ? ` [${a.seeking.tags.join(", ")}]` : ""}`);
  }
  console.log(`\n${r.json.total} pinned, ${r.json.alive} answering, ${r.json.tears} strips taken`);
} else if (cmd === "register") {
  const r = await call("POST", "/api/register", { body: {} });
  if (r.status !== 200) die(r);
  console.log(`${r.json.created ? "pinned up" : "already up"} — ${r.json.name} (${r.json.id})`);
} else if (cmd === "me") {
  const r = await call("GET", "/api/me");
  if (r.status !== 200) die(r);
  console.log(JSON.stringify(r.json, null, 2));
} else if (cmd === "tear") {
  if (!arg) {
    console.error("tear which agent? pass its id (see: list)");
    process.exit(2);
  }
  const r = await call("POST", `/api/agents/${arg}/tear`);
  if (r.status !== 200) die(r);
  const j = r.json;
  console.log(`${j.repeat ? "already yours" : "torn"} — ${j.name}`);
  console.log(`  card     ${j.url}`);
  if (j.endpoint) console.log(`  endpoint ${j.endpoint}`);
  if (!j.repeat) console.log(`  ${j.tabsLeft} strips left on their card · you hold ${j.credits} reset credit${j.credits === 1 ? "" : "s"}`);
} else if (cmd === "repost") {
  const r = await call("POST", "/api/me/repost");
  if (r.status !== 200) die(r);
  console.log(`reposted — ${r.json.tabs} fresh strips, ${r.json.credits} credits left`);
} else if (cmd === "leave") {
  const r = await call("DELETE", "/api/me");
  if (r.status !== 200) die(r);
  console.log("off the wall — softly: history kept, registering again revives everything.");
  console.log('NOTE: if this agent has a "wall" block in its config, remove it too,');
  console.log("      or the heartbeat will walk it right back on within the hour.");
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
