// GitHub Pages publishing — everything except GitHub itself. A local bare
// repo stands in for the remote, so push/commit/idempotence are all real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deriveBase, publishToPages } from "../src/publish.js";

test("deriveBase knows user pages, project pages, ssh and https remotes", () => {
  assert.equal(deriveBase("git@github.com:Alice/alice.github.io.git"), "https://alice.github.io");
  assert.equal(deriveBase("https://github.com/alice/alice.github.io"), "https://alice.github.io");
  assert.equal(deriveBase("https://github.com/alice/tools.git"), "https://alice.github.io/tools");
  assert.equal(deriveBase("git@gitlab.com:alice/alice.gitlab.io.git"), null, "not github — refuse, don't guess");
  assert.equal(deriveBase(""), null);
});

test("publish writes card+jwks+.nojekyll, commits, pushes; unchanged content pushes nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clayborn-pages-"));
  const bare = path.join(dir, "remote.git");
  const clone = path.join(dir, "clone");
  const g = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
  execFileSync("git", ["clone", "-q", bare, clone], { stdio: "pipe" });
  g(clone, "config", "user.email", "t@t.test");
  g(clone, "config", "user.name", "t");
  g(clone, "commit", "--allow-empty", "-m", "root");
  g(clone, "push", "-q", "-u", "origin", "main");

  const card = { name: "PagesBird", supportedInterfaces: [{ url: "https://tunnel-1.example/a2a" }] };
  const jwksDoc = { keys: [{ kty: "OKP" }] };
  const config = { publish: { mode: "github-pages", repoDir: clone, base: "https://alice.github.io" } };

  const { base } = await publishToPages({ config, card, jwksDoc, log: () => {}, verify: false });
  assert.equal(base, "https://alice.github.io");
  assert.ok(existsSync(path.join(clone, ".nojekyll")), "Jekyll would eat .well-known — must be disabled");
  const served = JSON.parse(readFileSync(path.join(clone, ".well-known", "agent-card.json"), "utf8"));
  assert.equal(served.name, "PagesBird");
  assert.match(g(bare, "log", "-1", "--format=%s", "main"), /clayborn: card for PagesBird/, "reached the remote");

  // same content again → no new commit
  const head = g(bare, "rev-parse", "main");
  await publishToPages({ config, card, jwksDoc, log: () => {}, verify: false });
  assert.equal(g(bare, "rev-parse", "main"), head, "unchanged card must not generate commits");

  // endpoint moved (new tunnel) → exactly one new commit
  card.supportedInterfaces[0].url = "https://tunnel-2.example/a2a";
  await publishToPages({ config, card, jwksDoc, log: () => {}, verify: false });
  assert.notEqual(g(bare, "rev-parse", "main"), head, "a moved door must be published");
});

test("a repoDir that is not a git repo is refused", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clayborn-pages-plain-"));
  await assert.rejects(
    () => publishToPages({
      config: { publish: { mode: "github-pages", repoDir: dir } },
      card: { name: "x" }, jwksDoc: { keys: [] }, log: () => {}, verify: false,
    }),
    /not a git repository/
  );
});
