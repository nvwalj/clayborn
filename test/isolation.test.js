// Task isolation: a caller may only see or cancel a task it created. A peer
// cannot read another peer's task, an anonymous echo caller cannot smuggle a
// message onto someone else's in-flight task, and the machine's own operator
// token sees everything. This is the invariant behind the anon-echo gate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureEchoSkill } from "../src/index.js";
import { createHandlers } from "../src/rpc.js";
import { TaskStore } from "../src/tasks.js";
import { createEchoBackend } from "../src/backend/echo.js";

function harness() {
  const config = ensureEchoSkill({
    name: "T", description: "t", backend: { type: "echo" },
    skills: [{ id: "ask", name: "Ask", description: "d", tags: [] }],
  });
  const store = new TaskStore();
  const echoBackend = createEchoBackend({ note: "echo" });
  const handlers = createHandlers({
    store,
    backend: echoBackend, // every skill completes via echo, so tasks reach a terminal state fast
    echoBackend,
    config,
    skillsById: new Map(config.skills.map((s) => [s.id, s])),
  });
  return { handlers };
}

const msg = (text, extra = {}) => ({ messageId: "m", role: "ROLE_USER", parts: [{ text }], ...extra });
const A = { caller: "peer:https://a.example" };
const B = { caller: "peer:https://b.example" };

test("tasks are isolated per caller; the operator token sees all", async () => {
  const { handlers } = harness();

  const a = await handlers.SendMessage({ message: msg("hi from A") }, A);
  assert.ok(a.id);
  // owner is readable in-process (the store filters on it) but non-enumerable,
  // so it never serialises onto the A2A Task a client receives.
  assert.equal(JSON.parse(JSON.stringify(a)).owner, undefined, "owner must not appear on the wire Task");

  // Peer B cannot see or cancel A's task — it reads as absent, never confirmed.
  assert.throws(() => handlers.GetTask({ id: a.id }, B), /TaskNotFound/, "B cannot GetTask A's task");
  assert.throws(() => handlers.CancelTask({ id: a.id }, B), /TaskNotFound/, "B cannot cancel A's task");

  // A sees its own; the operator token sees everything.
  assert.equal(handlers.GetTask({ id: a.id }, A).id, a.id, "A sees its own task");
  assert.equal(handlers.GetTask({ id: a.id }, { caller: "owner" }).id, a.id, "operator sees any task");

  // ListTasks is scoped to the caller; owner lists all.
  assert.equal(handlers.ListTasks({}, B).tasks.length, 0, "B lists none of A's tasks");
  assert.equal(handlers.ListTasks({}, A).tasks.length, 1, "A lists its own");
  assert.equal(handlers.ListTasks({}, { caller: "owner" }).tasks.length, 1, "owner lists all");

  // An anonymous echo caller cannot continue (and thereby read/steal) A's task.
  await assert.rejects(
    handlers.SendMessage({ metadata: { skillId: "echo" }, message: msg("mine now", { taskId: a.id }) }, { caller: "anon" }),
    /TaskNotFound/,
    "anon cannot smuggle a message onto A's task"
  );
});

test("historyLength:0 returns no history, not all of it", async () => {
  const { handlers } = harness();
  const a = await handlers.SendMessage({ message: msg("one") }, A);
  const none = handlers.GetTask({ id: a.id, historyLength: 0 }, A);
  assert.equal(none.history.length, 0, "slice(-0) must not leak the whole history");
  const full = handlers.GetTask({ id: a.id }, A);
  assert.ok(full.history.length >= 1, "no limit → full history");
});
