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
import { createCommandBackend } from "./backend/command.js";
import { createHttpBackend } from "./backend/http.js";
import { loadCorpora } from "./corpus.js";
import { loadIdentity, jwks } from "./identity.js";
import { createPeerVerifier } from "./peers.js";
import { startWallHeartbeat } from "./wall.js";
import { publishToPages } from "./publish.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(file, log = console.log) {
  // Current directory first, so `npx clayborn start` finds the config where
  // the USER is, not where npm cached the code. The repo root keeps working
  // for a plain clone.
  const cwdConfig = path.resolve("clayborn.config.json");
  const rootConfig = path.join(ROOT, "clayborn.config.json");
  let p = path.resolve(
    file || process.env.CLAYBORN_CONFIG || (existsSync(cwdConfig) ? cwdConfig : rootConfig)
  );
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
  ensureEchoSkill(config);
  if (config.auth?.mode === "bearer" && !config.auth.token) {
    const env = process.env.CLAYBORN_TOKEN;
    if (!env) throw new Error('auth.mode is "bearer" but no auth.token and no CLAYBORN_TOKEN env var');
    config.auth.token = env;
  }
  if (config.wall) {
    try {
      new URL(config.wall.url);
    } catch {
      throw new Error(`config.wall.url is not a URL: ${JSON.stringify(config.wall.url)}`);
    }
  }
  if (config.seeking) {
    const s = config.seeking;
    const textOk = !s.text || typeof s.text === "string";
    const tagsOk = !s.tags || (Array.isArray(s.tags) && s.tags.every((t) => typeof t === "string"));
    if (!textOk || !tagsOk || (!s.text && !(s.tags || []).length)) {
      throw new Error('config.seeking needs "text" (a string) and/or "tags" (an array of strings)');
    }
  }
  if (config.publish) {
    if (config.publish.mode !== "github-pages") {
      throw new Error(`unknown publish.mode: ${JSON.stringify(config.publish.mode)} (only "github-pages")`);
    }
    if (!config.publish.repoDir) {
      throw new Error("publish.repoDir is required — a local clone of your Pages repo");
    }
  }
  if (config.backend?.type === "command") {
    const a = config.backend.argv;
    if (!Array.isArray(a) || !a.length || !a.every((x) => typeof x === "string")) {
      throw new Error('backend.type "command" needs backend.argv — an array of strings, e.g. ["ollama", "run", "llama3"]');
    }
  }
  if (config.backend?.type === "http") {
    try {
      new URL(config.backend.url);
    } catch {
      throw new Error(`backend.type "http" needs a valid backend.url (got ${JSON.stringify(config.backend.url)})`);
    }
  }
  // The identity keypair lives next to whichever config defined the agent —
  // for an npx run that is the user's directory, never npm's cache.
  if (!config.identityFile) config.identityFile = path.join(path.dirname(p), "clayborn.identity.json");
  return config;
}

/**
 * Every agent answers `echo` unless the owner opts out — the A2A equivalent of
 * ping. It runs no model and no tools, so it is free on both sides: a caller
 * does not need an LLM to walk the full task lifecycle against a real agent,
 * and the agent spends nothing answering. (Suggested by the first agent that
 * ever tested this repo, which shipped itself as echo-only — the right
 * instinct, now built in.)
 */
export function ensureEchoSkill(config) {
  if (config.echoSkill === false) return config;
  if ((config.backend?.type || "echo") === "echo") return config; // whole agent already echoes
  if ((config.skills || []).some((s) => s.id === "echo")) return config; // owner defined their own
  config.skills.push({
    id: "echo",
    name: "Echo",
    description:
      "Returns your message unchanged, without running a model. Free to call — exists so anyone can walk the full A2A task lifecycle against this agent, no LLM needed on either side.",
    tags: ["diagnostic", "echo"],
    examples: ["ping"],
    tools: [],
    backend: "echo",
    _builtin: true,
  });
  return config;
}

export function createBackend(config) {
  const type = config.backend?.type || "echo";
  if (type === "claude") return createClaudeBackend(config);
  if (type === "echo") return createEchoBackend();
  if (type === "command") return createCommandBackend(config);
  if (type === "http") return createHttpBackend(config);
  throw new Error(`unknown backend.type: ${type} (expected "claude", "echo", "command" or "http")`);
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
  // so it can CALL peers that require one. Costs a 3KB file. loadConfig has
  // already defaulted identityFile to sit next to the config.
  const identity = loadIdentity(path.resolve(config.identityFile), log);

  // The verifier needs to know our public URL for the aud check, but that URL
  // only exists after ingress resolves — hence the ref, same pattern as `card`.
  const self = { url: null };
  const peerVerifier = createPeerVerifier({ config, getSelfUrl: () => self.url, log });

  const handlers = createHandlers({
    store,
    backend,
    echoBackend: createEchoBackend({ note: "This is the echo skill; the agent's other skills answer for real." }),
    config,
    skillsById,
    corpora,
  });

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

  // With publish configured, the STABLE address — the identity peers sign as
  // and walls verify against — is the Pages URL; the ingress URL is just
  // today's door, recorded inside the card. Publish failures are fatal: the
  // config promised an identity we could not put up.
  let identityUrl = ingress.url;
  if (config.publish) {
    try {
      const pub = await publishToPages({ config, card, jwksDoc: jwks(identity), log });
      identityUrl = pub.base;
    } catch (err) {
      ingress.stop();
      server.close();
      throw new Error(`publish failed: ${err.message}`);
    }
  }

  log("");
  log(`  ${config.name}`);
  log(`  public   ${ingress.url}`);
  log(`  card     ${ingress.url}/.well-known/agent-card.json`);
  log(`  jsonrpc  ${ingress.url}/a2a`);
  log(`  backend  ${backend.describe()}`);
  log(`  skills   ${config.skills.map((s) => s.id).join(", ")}`);
  log(`  identity ${identity.kid.slice(0, 12)}…  (keys at /.well-known/jwks.json)`);
  if (config.publish) log(`  publish  ${identityUrl}  — the stable address; sign and register as this`);
  if (config.wall) log(`  wall     ${config.wall.url}`);
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

  // Last, because it is the only outward-facing announcement: everything above
  // proved the agent real and reachable, so this is the first safe moment to
  // walk up to a wall and say so. The wall knows us by the stable address.
  const wallHeartbeat = config.wall
    ? startWallHeartbeat({ config, identity, selfUrl: identityUrl, log })
    : null;

  const stop = async () => {
    wallHeartbeat?.stop();
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
