// Protocol-level tests. These run against the echo backend, so they exercise
// the A2A surface without spawning a model or spending quota.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCard, validateCard, PROTOCOL_VERSION } from "../src/card.js";
import { TaskStore, STATE, textMessage, messageText } from "../src/tasks.js";
import { createHandlers, dispatch } from "../src/rpc.js";
import { createEchoBackend } from "../src/backend/echo.js";

const CONFIG = {
  name: "Test Agent",
  description: "fixture",
  version: "0.1.0",
  skills: [{ id: "ask", name: "Ask", description: "answers", tags: ["test"], default: true }],
};

function harness() {
  const store = new TaskStore();
  const skillsById = new Map(CONFIG.skills.map((s) => [s.id, s]));
  const handlers = createHandlers({
    store,
    backend: createEchoBackend(),
    config: CONFIG,
    skillsById,
  });
  return { store, handlers };
}

const userMessage = (text, extra = {}) => ({
  messageId: "m1",
  role: "ROLE_USER",
  parts: [{ text }],
  ...extra,
});

const settle = () => new Promise((r) => setTimeout(r, 250));

test("card uses v1.0 field names, not the pre-1.0 ones", () => {
  const card = buildCard(CONFIG, "https://agent.example.com");

  assert.ok(Array.isArray(card.supportedInterfaces), "supportedInterfaces must exist and be an array");
  assert.equal(card.additionalInterfaces, undefined, "additionalInterfaces is pre-1.0");
  assert.equal(card.protocolVersion, undefined, "protocolVersion is not a top-level v1.0 field");
  assert.equal(card.url, undefined, "url is not a top-level v1.0 field");

  assert.equal(typeof card.capabilities, "object");
  assert.ok(!Array.isArray(card.capabilities), "capabilities must be an object, not an array");

  const jsonrpc = card.supportedInterfaces.find((i) => i.protocolBinding === "JSONRPC");
  assert.ok(jsonrpc, "a JSONRPC interface must be declared");
  assert.equal(jsonrpc.protocolVersion, PROTOCOL_VERSION);
  assert.match(jsonrpc.url, /^https:\/\/agent\.example\.com/);
});

test("validateCard rejects the three common conformance failures", () => {
  const good = buildCard(CONFIG, "https://agent.example.com");
  assert.equal(validateCard(good).ok, true);

  const arrayCaps = { ...good, capabilities: ["streaming"] };
  assert.match(validateCard(arrayCaps).errors.join(" "), /capabilities must be an object/);

  const oldField = { ...good, additionalInterfaces: [] };
  assert.match(validateCard(oldField).errors.join(" "), /pre-1\.0/);

  const relative = {
    ...good,
    supportedInterfaces: [{ url: "/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  };
  assert.match(validateCard(relative).errors.join(" "), /absolute http/);

  const noProvider = { ...good, provider: { organization: "Acme" } };
  assert.match(validateCard(noProvider).errors.join(" "), /BOTH organization and url/);
});

test("SendMessage creates a task and drives it to COMPLETED", async () => {
  const { handlers } = harness();

  const task = await handlers.SendMessage({ message: userMessage("hello") });
  assert.ok(task.id);
  assert.ok(task.contextId, "the agent must assign a contextId when the client omits one");
  assert.equal(task.status.state, STATE.WORKING);

  await settle();
  const done = handlers.GetTask({ id: task.id });
  assert.equal(done.status.state, STATE.COMPLETED);
  assert.equal(done.artifacts.length, 1);
  assert.match(messageText({ parts: done.artifacts[0].parts }), /echo backend/);
});

test("task states are the ProtoJSON enum names", async () => {
  const { handlers } = harness();
  const task = await handlers.SendMessage({ message: userMessage("hi") });
  assert.match(task.status.state, /^TASK_STATE_/);
  await settle();
  assert.equal(handlers.GetTask({ id: task.id }).status.state, "TASK_STATE_COMPLETED");
});

test("GetTask on an unknown id is TaskNotFoundError (-32001)", async () => {
  const { handlers } = harness();
  const res = await dispatch(handlers, {
    jsonrpc: "2.0",
    id: 1,
    method: "GetTask",
    params: { id: "nope" },
  });
  assert.equal(res.error.code, -32001);
  assert.equal(res.error.message, "TaskNotFoundError");
});

test("a finished task cannot be canceled or continued", async () => {
  const { handlers } = harness();
  const task = await handlers.SendMessage({ message: userMessage("hi") });
  await settle();

  const cancel = await dispatch(handlers, {
    jsonrpc: "2.0",
    id: 2,
    method: "CancelTask",
    params: { id: task.id },
  });
  assert.equal(cancel.error.code, -32002, "TaskNotCancelableError");

  const cont = await dispatch(handlers, {
    jsonrpc: "2.0",
    id: 3,
    method: "SendMessage",
    params: { message: userMessage("more", { taskId: task.id }) },
  });
  assert.equal(cont.error.code, -32004, "UnsupportedOperationError on a terminal task");
});

test("cancel is honoured mid-flight and the state is final", async () => {
  const { handlers, store } = harness();
  const task = await handlers.SendMessage({ message: userMessage("slow") });
  const canceled = handlers.CancelTask({ id: task.id });
  assert.equal(canceled.status.state, STATE.CANCELED);

  await settle();
  // The backend result lands after the cancel; it must not resurrect the task.
  assert.equal(store.get(task.id).status.state, STATE.CANCELED);
});

test("ListTasks paginates, newest first", async () => {
  const { handlers } = harness();
  for (let i = 0; i < 5; i++) await handlers.SendMessage({ message: userMessage(`m${i}`) });
  await settle();

  const page1 = handlers.ListTasks({ pageSize: 2 });
  assert.equal(page1.tasks.length, 2);
  assert.equal(page1.nextPageToken, "2");

  const page2 = handlers.ListTasks({ pageSize: 2, pageToken: page1.nextPageToken });
  assert.equal(page2.tasks.length, 2);
  assert.notEqual(page1.tasks[0].id, page2.tasks[0].id);

  const filtered = handlers.ListTasks({ state: STATE.COMPLETED });
  assert.equal(filtered.tasks.length, 5);
});

test("undeclared capabilities must error, not half-work", async () => {
  const { handlers } = harness();
  for (const [method, code] of [
    ["SendStreamingMessage", -32004],
    ["SubscribeToTask", -32004],
    ["CreateTaskPushNotificationConfig", -32003],
  ]) {
    const res = await dispatch(handlers, { jsonrpc: "2.0", id: 9, method, params: {} });
    assert.equal(res.error.code, code, `${method} should return ${code}`);
  }
});

test("JSON-RPC envelope: bad version, unknown method, notifications, aliases", async () => {
  const { handlers } = harness();

  const badVersion = await dispatch(handlers, { jsonrpc: "1.0", id: 1, method: "GetTask" });
  assert.equal(badVersion.error.code, -32600);

  const unknown = await dispatch(handlers, { jsonrpc: "2.0", id: 1, method: "Nope" });
  assert.equal(unknown.error.code, -32601);

  // No id => notification => no response at all.
  const notification = await dispatch(handlers, { jsonrpc: "2.0", method: "GetTask", params: { id: "x" } });
  assert.equal(notification, null);

  // Pre-1.0 spelling still accepted on input.
  const aliased = await dispatch(handlers, {
    jsonrpc: "2.0",
    id: 4,
    method: "tasks/get",
    params: { id: "missing" },
  });
  assert.equal(aliased.error.code, -32001, "alias should reach GetTask");
});

test("empty or unreadable message parts are rejected", async () => {
  const { handlers } = harness();

  const empty = await dispatch(handlers, {
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: { message: { messageId: "m", role: "ROLE_USER", parts: [] } },
  });
  assert.equal(empty.error.code, -32602);

  const noText = await dispatch(handlers, {
    jsonrpc: "2.0",
    id: 2,
    method: "SendMessage",
    params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ raw: "AAAA" }] } },
  });
  assert.equal(noText.error.code, -32005, "ContentTypeNotSupportedError");
});

test("messageText flattens mixed part types", () => {
  assert.equal(messageText({ parts: [{ text: "a" }, { text: "b" }] }), "a\nb");
  assert.equal(messageText({ parts: [{ data: { k: 1 } }] }), '{"k":1}');
  assert.match(messageText({ parts: [{ url: "x", filename: "f.png" }] }), /f\.png/);
  assert.equal(messageText(null), "");
});

test("textMessage carries task and context ids", () => {
  const m = textMessage("hi", { taskId: "t", contextId: "c" });
  assert.equal(m.role, "ROLE_AGENT");
  assert.equal(m.taskId, "t");
  assert.equal(m.contextId, "c");
  assert.equal(m.parts[0].text, "hi");
});
