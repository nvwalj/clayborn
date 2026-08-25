#!/usr/bin/env node
// Validate any agent card against the A2A v1.0 shape.
//
//   npm run check                         # your own config, rendered as a card
//   npm run check -- https://host         # fetch and check someone else's
//   npm run check -- ./card.json          # check a local file
//
// Worth pointing at other people's agents: an APIs.io scan of 22,341 hosts in
// July 2026 found 65 published cards, of which only 10 passed every structural
// check. Most of the failures are the three this catches.

import { readFileSync, existsSync } from "node:fs";
import { buildCard, validateCard } from "../src/card.js";
import { loadConfig } from "../src/index.js";

const arg = process.argv[2];

const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const GRN = "\x1b[32m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

async function resolveCard(arg) {
  if (!arg) {
    const config = loadConfig(undefined, () => {});
    return {
      source: "your config (rendered against a placeholder URL)",
      card: buildCard(config, "https://example.invalid"),
    };
  }
  if (existsSync(arg)) {
    return { source: arg, card: JSON.parse(readFileSync(arg, "utf8")) };
  }
  if (/^https?:\/\//.test(arg)) {
    const url = arg.includes("/.well-known/")
      ? arg
      : `${arg.replace(/\/+$/, "")}/.well-known/agent-card.json`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);

    // A 200 is not a card. Plenty of sites answer every path with their SPA
    // shell, so a status code alone proves nothing — check what came back.
    const type = res.headers.get("content-type") || "";
    const body = await res.text();
    if (!/json/i.test(type) && !body.trimStart().startsWith("{")) {
      throw new Error(
        `${url} returned HTTP 200 but content-type is "${type}" — that is a web page, not a card`
      );
    }
    try {
      return { source: url, card: JSON.parse(body) };
    } catch {
      throw new Error(`${url} returned HTTP 200 but the body is not JSON`);
    }
  }
  throw new Error(`don't know how to read "${arg}" — pass a URL, a file path, or nothing`);
}

try {
  const { source, card } = await resolveCard(arg);
  const { ok, errors, warnings } = validateCard(card);

  console.log(`\n${DIM}source:${OFF} ${source}`);
  if (card.name) console.log(`${DIM}agent: ${OFF} ${card.name} v${card.version || "?"}`);
  const ifaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  for (const i of ifaces) console.log(`${DIM}iface: ${OFF} ${i.protocolBinding} ${i.protocolVersion} → ${i.url}`);
  console.log("");

  for (const e of errors) console.log(`  ${RED}✗${OFF} ${e}`);
  for (const w of warnings) console.log(`  ${YEL}!${OFF} ${w}`);

  if (ok && !warnings.length) console.log(`  ${GRN}✓${OFF} conformant with A2A v1.0`);
  else if (ok) console.log(`\n  ${GRN}✓${OFF} structurally valid (${warnings.length} warning(s))`);
  else console.log(`\n  ${RED}✗ ${errors.length} error(s)${OFF}`);
  console.log("");

  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(`\n  ${RED}✗${OFF} ${err.message}\n`);
  process.exit(2);
}
