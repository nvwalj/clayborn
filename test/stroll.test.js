// The fist bump and the stroll: anonymous echo, and who to meet today.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { pickStranger } from "../src/wall.js";
import { start } from "../src/index.js";

test("pickStranger prefers matches, skips self, the met, and the dead", () => {
  const agents = [
    { id: "me", name: "me", alive: true },
    { id: "a", name: "a", alive: true },
    { id: "b", name: "b", alive: true },
    { id: "dead", name: "dead", alive: false },
    { id: "old", name: "old", alive: true },
  ];
  const met = { old: {} };
  const p = pickStranger({ agents, myId: "me", met, preferIds: ["b"] }, () => 0);
  assert.equal(p.id, "b", "the matched one wins");
  const q = pickStranger({ agents, myId: "me", met, preferIds: [] }, () => 0);
  assert.equal(q.id, "a", "otherwise first unmet living stranger");
  assert.equal(pickStranger({ agents: [{ id: "me", alive: true }], myId: "me", met: {} }), null);
});

test("anonymous echo: the fist bump works without credentials, everything else stays locked", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clayborn-anon-"));
  const cfg = path.join(dir, "c.json");
  writeFileSync(cfg, JSON.stringify({
    name: "locked",
    description: "d",
    identityFile: path.join(dir, "id.json"),
    auth: { mode: "bearer", token: "secret-token-value-123" },
    skills: [
      { id: "real", name: "real", description: "d", tags: [], tools: [] },
      { id: "echo", name: "Echo", description: "d", tags: [], tools: [], backend: "echo", _builtin: true },
    ],
    backend: { type: "command", argv: ["true"] }, // a real backend that must never run
    ingress: { mode: "none" },
  }));
  const { url, stop } = await start({ configFile: cfg, port: 18921, log: () => {} });
  const rpc = (body) =>
    fetch(`${url}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  try {
    // 1. anonymous echo send → accepted
    const sent = await rpc({
      jsonrpc: "2.0", id: "1", method: "SendMessage",
      params: { metadata: { skillId: "echo" }, message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "bump" }] } },
    });
    assert.equal(sent.status, 200);
    const taskId = sent.json.result.id;
    assert.ok(taskId);

    // 2. the same anonymous caller can poll THAT task
    await new Promise((r) => setTimeout(r, 300));
    const got = await rpc({ jsonrpc: "2.0", id: "2", method: "GetTask", params: { id: taskId } });
    assert.equal(got.status, 200);
    assert.match(got.json.result.status.state, /COMPLETED/);

    // 3. anonymous calls to a REAL skill are refused
    const real = await rpc({
      jsonrpc: "2.0", id: "3", method: "SendMessage",
      params: { metadata: { skillId: "real" }, message: { messageId: "m2", role: "ROLE_USER", parts: [{ text: "x" }] } },
    });
    assert.equal(real.status, 401);

    // 4. a bare message (no skillId) is refused too — no fallthrough to the default skill
    const bare = await rpc({
      jsonrpc: "2.0", id: "4", method: "SendMessage",
      params: { message: { messageId: "m3", role: "ROLE_USER", parts: [{ text: "x" }] } },
    });
    assert.equal(bare.status, 401);

    // 5. anonymous GetTask on an unknown task id is refused, not enumerated
    const nosy = await rpc({ jsonrpc: "2.0", id: "5", method: "GetTask", params: { id: "someone-elses-task" } });
    assert.equal(nosy.status, 401);

    // 6. the token still opens everything
    const withAuth = await fetch(`${url}/tasks`, { headers: { authorization: "Bearer secret-token-value-123" } });
    assert.equal(withAuth.status, 200);
  } finally {
    await stop();
  }
});
