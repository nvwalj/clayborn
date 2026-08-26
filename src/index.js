#!/usr/bin/env node
// clayborn — put your own agent on the wall.
//
// Boot order matters and is deliberate:
//   1. load + sanity-check config
//   2. start the local server on loopback
//   3. open ingress and learn the public URL
//   4. build the agent card FROM that URL and validate it
//   5. only then announce
//
// The card cannot be built before step 3 because supportedInterfaces[].url must
// be the absolute public URL. Publishing a card that points at 127.0.0.1 is the
// single most common way to be "listed but unreachable".

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCard, validateCard } from "./card.js";
import { TaskStore } from "./tasks.js";
import { createHandlers } from "./rpc.js";
import { createServer } from "./server.js";
import { startIngress, bindHost, verifyReachable } from "./ingress/index.js";
import { createClaudeBackend } from "./backend/claude.js";
import { createEchoBackend } from "./backend/echo.js";
import { loadCorpora } from "./corpus.js";
import { loadIdentity, jwks } from "./identity.js";
import { createPeerVerifier } from "./peers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(file, log = console.log) {
  let p = path.resolve(file || process.env.CLAYBORN_CONFIG || path.join(ROOT, "clayborn.config.json"));
  if (!existsSync(p)) {
    // Fall back to the committed example so a fresh clone runs with zero setup.
    // The example is deliberately inert: echo backend, no ingress, no auth
    // needed — so "just run it" cannot accidentally expose anything.
    const example = path.join(ROOT, "clayborn.config.example.json");
    if (!file && existsSync(example)) {
      log("[clayborn] no clayborn.config.json — using the example config (echo backend, no ingress)");
      log("[clayborn] cp clayborn.config.example.json clayborn.config.json  to make it yours");
      p = example;
    } else {
      throw new Error(`config not found: ${p}\nCopy clayborn.config.example.json to clayborn.config.json.`);
    }
  }
  let config;
  try {
    config = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`config is not valid JSON (${p}): ${e.message}`);
  }
  for (const f of ["name", "description"]) {
    if (!config[f]) throw new Error(`config is missing required field: ${f}`);
  }
  if (!Array.isArray(config.skills) || config.skills.length === 0) {
    throw new Error(
      "config.skills is empty. Declaring a skill is how you decide what this machine " +
        "will do for strangers — it is not boilerplate. See README §What to expose."
    );
  }
  const ids = new Set();
  for (const s of config.skills) {
    for (const f of ["id", "name", "description"]) {
      if (!s?.[f]) throw new Error(`every skill needs "${f}" (offending skill: ${JSON.stringify(s).slice(0, 80)})`);
    }
    if (ids.has(s.id)) throw new Error(`duplicate skill id: ${s.id}`);
    ids.add(s.id);
  }
  if (config.auth?.mode === "bearer" && !config.auth.token) {
    const env = process.env.CLAYBORN_TOKEN;
    if (!env) throw new Error('auth.mode is "bearer" but no auth.token and no CLAYBORN_TOKEN env var');
    config.auth.token = env;
  }
  return config;
}

export function createBackend(config) {
  const type = config.backend?.type || "echo";
  if (type === "claude") return createClaudeBackend(config);
  if (type === "echo") return createEchoBackend();
  throw new Error(`unknown backend.type: ${type} (expected "claude" or "echo")`);
}

export async function start({ configFile, port: portOverride, log = console.log } = {}) {
  const config = loadConfig(configFile, log);
  const port = portOverride || Number(process.env.PORT) || config.port || 8788;

  const backend = createBackend(config);
  const store = new TaskStore({
    max: config.tasks?.max,
    ttlMs: config.tasks?.ttlHours ? config.tasks.ttlHours * 3600_000 : undefined,
  });
  const skillsById = new Map(config.skills.map((s) => [s.id, s]));

  // Corpora load at boot: a missing or unreadable corpus should stop the
  // process now, not surface as a confusing answer to a stranger later.
  const corpora = loadCorpora(config, log);

  // Identity is unconditional — even an agent with peer auth off has a keypair,
  // so it can CALL peers that require one. Costs a 3KB file.
  const identity = loadIdentity(
    path.resolve(config.identityFile || path.join(ROOT, "clayborn.identity.json")),
    log
  );

  // The verifier needs to know our public URL for the aud check, but that URL
  // only exists after ingress resolves — hence the ref, same pattern as `card`.
  const self = { url: null };
  const peerVerifier = createPeerVerifier({ config, getSelfUrl: () => self.url, log });

  const handlers = createHandlers({ store, backend, config, skillsById, corpora });

  // The card is filled in once ingress resolves; the server closes over this
  // object so the /.well-known route always sees the final version.
  const card = {};
  const server = createServer({ card, jwks: jwks(identity), handlers, config, peerVerifier, log });

  const host = bindHost(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  log(`[clayborn] local  http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}  (bound ${host})`);

  let ingress;
  try {
    ingress = await startIngress(config, port, log);
  } catch (err) {
    server.close();
    throw err;
  }

  self.url = ingress.url;
  Object.assign(card, buildCard(config, ingress.url));

  const { ok, errors, warnings } = validateCard(card);
  for (const w of warnings) log(`[clayborn] warning: ${w}`);
  if (!ok) {
    ingress.stop();
    server.close();
    throw new Error(`agent card is not v1.0 conformant:\n  - ${errors.join("\n  - ")}`);
  }

  // Go and check, rather than assert. See verifyReachable().
  const reach = await verifyReachable(ingress.url, card.name, {
    attempts: ingress.mode === "none" ? 1 : 3,
  });
  if (!reach.ok) {
    const detail = `cannot reach my own card at ${reach.target} — ${reach.reason}`;
    if (ingress.mode === "none") {
      // On a LAN there is no round trip to blame: if this machine cannot reach
      // the address it is about to publish, no other machine can either.
      ingress.stop();
      server.close();
      throw new Error(
        `${detail}\n  The card would advertise an address nothing can connect to.\n` +
          `  If something else on this machine owns the port, or you are behind your own\n` +
          `  proxy, set "host" and "ingress.publicUrl" in the config explicitly.`
      );
    }
    log(`[clayborn] WARNING: ${detail}`);
    log(`[clayborn] the tunnel reported success but nothing answers through it yet.`);
  }

  log("");
  log(`  ${config.name}`);
  log(`  public   ${ingress.url}`);
  log(`  card     ${ingress.url}/.well-known/agent-card.json`);
  log(`  jsonrpc  ${ingress.url}/a2a`);
  log(`  backend  ${backend.describe()}`);
  log(`  skills   ${config.skills.map((s) => s.id).join(", ")}`);
  log(`  identity ${identity.kid.slice(0, 12)}…  (keys at /.well-known/jwks.json)`);
  if (peerVerifier) {
    log(`  peers    ${peerVerifier.mode}${peerVerifier.mode === "allowlist" ? ` (${(config.peers.allow || []).length} allowed)` : ""}`);
  }
  if (config.auth?.mode === "bearer") log(`  auth     bearer token${peerVerifier ? " or verified peer JWT" : ""}`);
  else if (peerVerifier) log(`  auth     verified peer JWT required`);
  else log(`  auth     NONE — anyone who knows the URL can call this agent`);
  if (peerVerifier?.mode === "anyone" && (config.backend?.type === "claude")) {
    log(`  WARNING  peers "anyone" + claude backend: any agent that controls a URL can spend your quota`);
  }
  if (ingress.note) log(`  note     ${ingress.note}`);
  log("");

  const stop = async () => {
    ingress.stop();
    await new Promise((r) => server.close(r));
  };
  return { server, card, store, config, url: ingress.url, stop };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  start().then(
    ({ stop }) => {
      let closing = false;
      const bye = async () => {
        if (closing) return;
        closing = true;
        console.log("\n[clayborn] shutting down…");
        await stop();
        process.exit(0);
      };
      process.on("SIGINT", bye);
      process.on("SIGTERM", bye);
    },
    (err) => {
      console.error(`\n[clayborn] ${err.message}\n`);
      process.exit(1);
    }
  );
}
