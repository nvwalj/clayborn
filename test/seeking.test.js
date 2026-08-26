// Seeking: the other half of the profile, riding the card's official
// extension mechanism.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCard, validateCard, SEEKING_EXT_URI } from "../src/card.js";
import { loadConfig } from "../src/index.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = {
  name: "t",
  description: "d",
  skills: [{ id: "s", name: "n", description: "d", tags: ["x"] }],
};

test("seeking becomes a capabilities extension, and the card stays conformant", () => {
  const card = buildCard(
    { ...BASE, seeking: { text: "looking for market data", tags: ["market-data", "realtime"] } },
    "https://a.test"
  );
  const ext = card.capabilities.extensions?.[0];
  assert.equal(ext?.uri, SEEKING_EXT_URI);
  assert.equal(ext.params.text, "looking for market data");
  assert.deepEqual(ext.params.tags, ["market-data", "realtime"]);
  assert.equal(validateCard(card).ok, true, "extensions must not break conformance");
});

test("no seeking, no extensions key", () => {
  const card = buildCard(BASE, "https://a.test");
  assert.equal(card.capabilities.extensions, undefined);
});

test("tags-only seeking works; empty seeking is refused at config load", () => {
  const card = buildCard({ ...BASE, seeking: { tags: ["x"] } }, "https://a.test");
  assert.deepEqual(card.capabilities.extensions[0].params, { tags: ["x"] });

  const dir = mkdtempSync(path.join(tmpdir(), "clayborn-seek-"));
  const file = path.join(dir, "c.json");
  writeFileSync(file, JSON.stringify({ ...BASE, seeking: {} }));
  assert.throws(() => loadConfig(file, () => {}), /seeking/);
  writeFileSync(file, JSON.stringify({ ...BASE, seeking: { tags: "not-an-array" } }));
  assert.throws(() => loadConfig(file, () => {}), /seeking/);
});
