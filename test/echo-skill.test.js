// The built-in echo skill: free to call, never the default, never a model.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureEchoSkill } from "../src/index.js";
import { createHandlers } from "../src/rpc.js";
import { TaskStore, STATE } from "../src/tasks.js";
import { createEchoBackend } from "../src/backend/echo.js";

const claudeConfig = () => ({
  name: "T", description: "t", backend: { type: "claude" },
  skills: [{ id: "ask", name: "Ask", description: "d", tags: [] }],
});

test("echo is injected for model-backed agents, and only there", () => {
  const a = ensureEchoSkill(claudeConfig());
  assert.ok(a.skills.some((s) => s.id === "echo" && s._builtin), "injected for claude backend");

  const b = ensureEchoSkill({ ...claudeConfig(), backend: { type: "echo" } });
  assert.ok(!b.skills.some((s) => s.id === "echo"), "not injected when the whole agent echoes");

  const c = ensureEchoSkill({ ...claudeConfig(), echoSkill: false });
  assert.ok(!c.skills.some((s) => s.id === "echo"), "owner can opt out");

  const own = claudeConfig();
  own.skills.push({ id: "echo", name: "Mine", description: "d", tags: [] });
  assert.equal(ensureEchoSkill(own).skills.filter((s) => s.id === "echo").length, 1, "never duplicated");
});

function harness() {
  const config = ensureEchoSkill(claudeConfig());
  const store = new TaskStore();
  const handlers = createHandlers({
    store,
    // The real backend must never run in these tests — that is the point.
    backend: { run: () => ({ promise: Promise.reject(new Error("real backend must not run")), abort() {} }) },
    echoBackend: createEchoBackend({ note: "echo skill" }),
    config,
    skillsById: new Map(config.skills.map((s) => [s.id, s])),
  });
  return { handlers };
}

const msg = (text, extra = {}) => ({ messageId: "m", role: "ROLE_USER", parts: [{ text }], ...extra });
const settle = () => new Promise((r) => setTimeout(r, 250));

test("calling the echo skill never starts the model", async () => {
  const { handlers } = harness();
  const task = await handlers.SendMessage({ metadata: { skillId: "echo" }, message: msg("ping") });
  await settle();
  const done = handlers.GetTask({ id: task.id });
  assert.equal(done.status.state, STATE.COMPLETED);
  assert.match(done.artifacts[0].parts[0].text, /ping/);
});

test("a bare message still falls to the real skill, not to echo", async () => {
  const { handlers } = harness();
  const task = await handlers.SendMessage({ message: msg("hello") });
  await settle();
  // The stub real backend rejects — proving the fallback chose "ask", not "echo".
  assert.equal(handlers.GetTask({ id: task.id }).status.state, STATE.FAILED);
});
