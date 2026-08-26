// The wall heartbeat's brain — the parts that decide, not the parts that fetch.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideRepost, looksPrivate, startWallHeartbeat } from "../src/wall.js";
import { loadIdentity } from "../src/identity.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

test("repost exactly when sold out, funded, and off cooldown", () => {
  assert.equal(decideRepost({ tabs: 3, credits: 2, nextRepostAt: null }, NOW), false, "still has strips");
  assert.equal(decideRepost({ tabs: 0, credits: 0, nextRepostAt: null }, NOW), false, "no credit");
  assert.equal(decideRepost({ tabs: 0, credits: 1, nextRepostAt: iso(NOW + 3600_000) }, NOW), false, "cooldown ahead");
  assert.equal(decideRepost({ tabs: 0, credits: 1, nextRepostAt: iso(NOW - 1) }, NOW), true, "cooldown behind");
  assert.equal(decideRepost({ tabs: 0, credits: 1, nextRepostAt: null }, NOW), true, "never reposted");
  assert.equal(decideRepost({ tabs: undefined, credits: 1, nextRepostAt: null }, NOW), false, "garbage tabs never repost");
});

test("looksPrivate knows a LAN address when it sees one", () => {
  assert.equal(looksPrivate("http://10.0.1.225:8788"), true);
  assert.equal(looksPrivate("http://192.168.1.7:8788"), true);
  assert.equal(looksPrivate("http://localhost:8788"), true);
  assert.equal(looksPrivate("http://mymac.local:8788"), true);
  assert.equal(looksPrivate("https://agent.nvwalj.com"), false);
  assert.equal(looksPrivate("http://172.20.0.1"), true);
  assert.equal(looksPrivate("http://172.32.0.1"), false, "172.32 is public space");
});

test("a private agent pointed at a public wall gets a no-op heartbeat, not mystery 401s", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clayborn-wall-"));
  const identity = loadIdentity(path.join(dir, "id.json"), () => {});
  const lines = [];
  const hb = startWallHeartbeat({
    config: { wall: { url: "https://wall.example.com" } },
    identity,
    selfUrl: "http://10.0.1.225:8788",
    log: (l) => lines.push(l),
  });
  assert.equal(typeof hb.stop, "function");
  hb.stop();
  assert.match(lines.join("\n"), /private/, "says why it is off");
});
