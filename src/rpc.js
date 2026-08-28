// A2A application logic + the JSON-RPC 2.0 binding.
//
// Method strings and error codes are taken from the v1.0.1 spec, not from
// memory. Two things that trip up implementations ported from pre-1.0 code:
//
//   * Methods are `SendMessage` / `GetTask` / `ListTasks` / `CancelTask`.
//     The 0.2-era `message/send` and `tasks/get` strings are gone. We still
//     ACCEPT the old spellings (see ALIASES) because being lenient on input
//     costs nothing and lets older clients talk to us — but we never emit them.
//   * `params` IS the request message. GetTask takes {"id": "..."} directly,
//     not {"params": {"taskId": ...}}.

import { randomUUID } from "node:crypto";
import { STATE, isTerminal, textMessage, messageText, hasReadableContent, now } from "./tasks.js";

// Section 5.4, Error Code Mappings.
export const ERR = {
  PARSE: [-32700, "Parse error"],
  INVALID_REQUEST: [-32600, "Invalid Request"],
  METHOD_NOT_FOUND: [-32601, "Method not found"],
  INVALID_PARAMS: [-32602, "Invalid params"],
  INTERNAL: [-32603, "Internal error"],
  TASK_NOT_FOUND: [-32001, "TaskNotFoundError"],
  TASK_NOT_CANCELABLE: [-32002, "TaskNotCancelableError"],
  PUSH_NOT_SUPPORTED: [-32003, "PushNotificationNotSupportedError"],
  UNSUPPORTED_OPERATION: [-32004, "UnsupportedOperationError"],
  CONTENT_TYPE_NOT_SUPPORTED: [-32005, "ContentTypeNotSupportedError"],
  RESOURCE_EXHAUSTED: [-32000, "ResourceExhausted"], // impl-defined server error range
};

export class RpcError extends Error {
  constructor([code, message], detail) {
    super(detail ? `${message}: ${detail}` : message);
    this.code = code;
    this.rpcMessage = message;
    this.detail = detail;
  }
  toJSON() {
    const e = { code: this.code, message: this.rpcMessage };
    if (this.detail) e.data = this.detail;
    return e;
  }
}

const ALIASES = {
  "message/send": "SendMessage",
  "message/stream": "SendStreamingMessage",
  "tasks/get": "GetTask",
  "tasks/list": "ListTasks",
  "tasks/cancel": "CancelTask",
  "tasks/resubscribe": "SubscribeToTask",
  "agent/getAuthenticatedExtendedCard": "GetExtendedAgentCard",
};

export function createHandlers({ store, backend, echoBackend, config, skillsById, corpora }) {
  // Admission control for backend runs. A JSON-RPC batch dispatches all its
  // elements at once, and each SendMessage starts a backend immediately, so
  // without a cap one 2 MB request full of messages could spawn thousands of
  // processes. This bounds how many run concurrently; excess is refused, not
  // queued, so memory and process slots stay bounded.
  const MAX_CONCURRENT_BACKENDS = Number(config?.maxConcurrentBackends) || 8;
  let activeBackends = 0;

  // Task isolation. Every task remembers who created it (a peer's iss, "anon",
  // or "public"/"owner" for the credential-free and static-token modes). A
  // caller may only see or cancel a task it owns; the machine's own operator
  // token ("owner") sees everything. The owner tag is non-enumerable so it is
  // never serialised into an A2A Task on the wire.
  const setOwner = (task, caller) => {
    Object.defineProperty(task, "owner", { value: caller, enumerable: false, writable: true, configurable: true });
    return task;
  };
  const canAccess = (task, caller) => caller === "owner" || task.owner === caller;

  /** SendMessage — creates a Task, runs the backend. Blocks for a terminal state unless the caller opts out. */
  async function SendMessage(params, ctx = {}) {
    const caller = ctx.caller || "public";
    const message = params?.message;
    if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
      throw new RpcError(ERR.INVALID_PARAMS, "message.parts is required and must be non-empty");
    }

    // Check for real content BEFORE flattening: messageText renders placeholders
    // for binary/file parts, so a message of nothing but a blob would otherwise
    // look like valid text.
    if (!hasReadableContent(message)) {
      throw new RpcError(
        ERR.CONTENT_TYPE_NOT_SUPPORTED,
        "message.parts carries no text or data this agent can read"
      );
    }
    const prompt = messageText(message).trim();

    // A message addressed to an existing task continues it — unless that task
    // is already finished, which the spec says must be refused. Continuing a
    // task you do not own is indistinguishable, on the wire, from it not
    // existing: same error, so an anonymous echo caller cannot smuggle its
    // message onto someone else's in-flight task and read the result back.
    if (message.taskId) {
      const existing = store.get(message.taskId);
      if (!existing || !canAccess(existing, caller)) throw new RpcError(ERR.TASK_NOT_FOUND, message.taskId);
      if (isTerminal(existing.status.state)) {
        throw new RpcError(
          ERR.UNSUPPORTED_OPERATION,
          `task ${message.taskId} is in terminal state ${existing.status.state}`
        );
      }
      // A task that is already running cannot take a second concurrent message:
      // that would spawn a second backend the store can't both track, so a
      // cancel would orphan one. Continuation is for a paused/input-required
      // task, not a busy one.
      if (existing.status.state === STATE.WORKING) {
        throw new RpcError(ERR.UNSUPPORTED_OPERATION, `task ${message.taskId} is still working — wait for it`);
      }
    }

    // Refuse to start a new backend when too many are already running — checked
    // and (below) incremented with no await between, so a concurrent batch can't
    // slip past the cap. GetTask/ListTasks/CancelTask are unaffected; only work
    // that spawns a backend is admission-controlled.
    if (activeBackends >= MAX_CONCURRENT_BACKENDS) {
      throw new RpcError(ERR.RESOURCE_EXHAUSTED, "too many tasks are running right now — retry shortly");
    }

    const skill = resolveSkill(params, prompt, skillsById, config);

    // If the skill is grounded in a corpus, retrieve HERE and paste the
    // passages into the prompt. The model still runs with no tools, so a caller
    // cannot redirect it at anything we did not hand it. See src/corpus.js.
    let grounding = null;
    const corpus = skill && corpora?.get(skill.id);
    if (corpus) {
      grounding = corpus.context(prompt, {
        limit: skill.corpus.maxSnippets || 8,
        maxChars: skill.corpus.maxChars || 700,
      });
    }
    const inbound = { ...message, role: message.role || "ROLE_USER" };

    const task = message.taskId
      ? store.get(message.taskId)
      : setOwner(store.create({ contextId: message.contextId, message: inbound }), caller);
    if (message.taskId) task.history.push(inbound);

    store.setState(task.id, STATE.WORKING);

    const parts = [];
    if (skill?.promptPrefix) parts.push(skill.promptPrefix);
    if (grounding) {
      parts.push(
        `Passages retrieved from the corpus, most relevant first. Answer ONLY from these; ` +
          `if they do not contain the answer, say so plainly rather than filling the gap ` +
          `from memory. Cite the numbered passages you used.\n\n${grounding}`
      );
    } else if (corpus) {
      parts.push("The corpus returned no passages matching this question. Say so; do not answer from memory.");
    }
    parts.push(grounding ? `Question: ${prompt}` : prompt);

    // A skill may pin itself to the echo backend. That is what makes the
    // built-in echo skill free: it walks the full task lifecycle without ever
    // starting a model, so anyone — including a caller with no LLM at all —
    // can verify this agent end to end at zero cost to either side.
    const runner = skill?.backend === "echo" && echoBackend ? echoBackend : backend;
    const { promise, abort } = runner.run({
      skill,
      prompt: parts.join("\n\n---\n\n"),
      taskId: task.id,
      onProgress: () => {},
    });
    activeBackends++; // paired with the decrement in .finally below
    store.track(task.id, abort);

    // Fire-and-forget: the caller polls GetTask. Never let a backend rejection
    // become an unhandled rejection and take the process down.
    promise
      .then((text) => {
        store.addArtifact(task.id, {
          artifactId: randomUUID(),
          name: skill ? `${skill.id}-result` : "result",
          parts: [{ text }],
        });
        store.setState(task.id, STATE.COMPLETED, {
          message: textMessage(text, { taskId: task.id, contextId: task.contextId }),
        });
      })
      .catch((err) => {
        // Only skip the FAILED transition if the task was ACTUALLY canceled —
        // read the authoritative state, don't sniff the error text. A backend
        // that rejects with "upstream canceled the request" is a real failure,
        // not our cancel, and must not leave the task stuck WORKING.
        if (store.get(task.id)?.status.state === STATE.CANCELED) return;
        store.setState(task.id, STATE.FAILED, {
          message: textMessage(`Backend error: ${err.message}`, {
            taskId: task.id,
            contextId: task.contextId,
          }),
          error: err.message,
        });
      })
      .finally(() => { activeBackends--; store.done(task.id); });

    // v1.0.1 blocks by default: return only once the task reaches a terminal
    // (or interrupted) state. A caller wanting fire-and-forget asks for it
    // explicitly. Every backend is bounded by its own timeout, so the runner
    // promise always settles — the wait is real, not a poll-and-hope cap.
    const wantImmediate =
      params?.configuration?.returnImmediately === true ||
      params?.configuration?.blocking === false;
    if (!wantImmediate) {
      await promise.then(() => {}, () => {});
    }
    return store.get(task.id) || task;
  }

  function GetTask(params, ctx = {}) {
    const caller = ctx.caller || "public";
    const id = params?.id;
    if (!id) throw new RpcError(ERR.INVALID_PARAMS, "id is required");
    const task = store.get(id);
    // A task the caller doesn't own reads as absent — never confirm it exists.
    if (!task || !canAccess(task, caller)) throw new RpcError(ERR.TASK_NOT_FOUND, id);
    return historyLimited(task, params?.historyLength);
  }

  function ListTasks(params, ctx = {}) {
    const caller = ctx.caller || "public";
    return store.list({
      pageSize: params?.pageSize,
      pageToken: params?.pageToken,
      state: params?.status ?? params?.state,
      contextId: params?.contextId,
      includeArtifacts: params?.includeArtifacts === true, // omitted unless explicitly requested
      historyLength: params?.historyLength,
      statusTimestampAfter: params?.statusTimestampAfter,
      // The operator's own token lists everything; every other caller sees only
      // the tasks it created.
      owner: caller === "owner" ? undefined : caller,
    });
  }

  function CancelTask(params, ctx = {}) {
    const caller = ctx.caller || "public";
    const id = params?.id;
    if (!id) throw new RpcError(ERR.INVALID_PARAMS, "id is required");
    const task = store.get(id);
    if (!task || !canAccess(task, caller)) throw new RpcError(ERR.TASK_NOT_FOUND, id);
    if (isTerminal(task.status.state)) {
      throw new RpcError(ERR.TASK_NOT_CANCELABLE, `task is already ${task.status.state}`);
    }
    return store.cancel(id);
  }

  // Declared false in capabilities, so the spec REQUIRES these to error rather
  // than half-work. Section 3.3.4, Capability Validation.
  const unsupported = (name) => () => {
    throw new RpcError(ERR.UNSUPPORTED_OPERATION, `${name} is not supported by this agent`);
  };
  const pushUnsupported = () => {
    throw new RpcError(ERR.PUSH_NOT_SUPPORTED, "capabilities.pushNotifications is false");
  };

  return {
    SendMessage,
    GetTask,
    ListTasks,
    CancelTask,
    SendStreamingMessage: unsupported("SendStreamingMessage"),
    SubscribeToTask: unsupported("SubscribeToTask"),
    GetExtendedAgentCard: unsupported("GetExtendedAgentCard"),
    CreateTaskPushNotificationConfig: pushUnsupported,
    GetTaskPushNotificationConfig: pushUnsupported,
    ListTaskPushNotificationConfigs: pushUnsupported,
    DeleteTaskPushNotificationConfig: pushUnsupported,
  };
}

function historyLimited(task, historyLength) {
  if (historyLength === undefined || historyLength === null) return task;
  const n = Number(historyLength);
  if (!Number.isFinite(n) || n < 0) return task;
  // slice(-0) === slice(0) === the whole array, so historyLength:0 must be
  // special-cased to "no history" rather than "all of it".
  return { ...task, history: n === 0 ? [] : task.history.slice(-n) };
}

/**
 * Pick the skill for a request. Explicit wins; otherwise fall back to the
 * single configured skill, or the one flagged `default`. We deliberately do NOT
 * guess from prompt text — a remote caller silently getting a different
 * capability than it asked for is worse than an error.
 */
function resolveSkill(params, prompt, skillsById, config) {
  const requested =
    params?.metadata?.skillId ||
    params?.configuration?.skillId ||
    params?.message?.metadata?.skillId;

  if (requested) {
    const s = skillsById.get(requested);
    if (!s) throw new RpcError(ERR.INVALID_PARAMS, `unknown skill: ${requested}`);
    return s;
  }
  const all = [...skillsById.values()];
  // The built-in echo skill never wins by default — it answers only when asked
  // for by id. Otherwise adding it would silently change what a bare message
  // to a single-skill agent does.
  const real = all.filter((s) => !s._builtin);
  if (real.length === 1) return real[0];
  return all.find((s) => s.default) || null;
}

// Methods whose v1.0.1 response is an envelope, not the bare payload. SendMessage
// returns SendMessageResponse { oneof { task, msg } } — a conforming client
// (the official a2a-js transport among them) reads result.task, not result.id.
const ENVELOPE = new Set(["SendMessage", "SendStreamingMessage"]);

/** Wrap a handler result in its v1.0.1 response envelope where the spec has one. */
export function envelopeFor(method, result) {
  if (!ENVELOPE.has(method)) return result;
  // We only ever produce Tasks from SendMessage, never bare Messages.
  return { task: result };
}

/** Dispatch one JSON-RPC request object. Returns a response object, or null for notifications. */
export async function dispatch(handlers, req, ctx = {}) {
  const id = req && typeof req === "object" ? (req.id ?? null) : null;

  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return errorResponse(id, new RpcError(ERR.INVALID_REQUEST));
  }
  if (req.jsonrpc !== "2.0") {
    return errorResponse(id, new RpcError(ERR.INVALID_REQUEST, 'jsonrpc must be "2.0"'));
  }
  if (typeof req.method !== "string") {
    return errorResponse(id, new RpcError(ERR.INVALID_REQUEST, "method must be a string"));
  }

  const method = ALIASES[req.method] || req.method;
  const handler = handlers[method];
  if (!handler) return errorResponse(id, new RpcError(ERR.METHOD_NOT_FOUND, req.method));

  try {
    const result = await handler(req.params || {}, ctx);
    if (req.id === undefined) return null; // notification
    return { jsonrpc: "2.0", id, result: envelopeFor(method, result) };
  } catch (err) {
    if (req.id === undefined) return null;
    return errorResponse(
      id,
      err instanceof RpcError ? err : new RpcError(ERR.INTERNAL, err?.message || String(err))
    );
  }
}

function errorResponse(id, err) {
  return { jsonrpc: "2.0", id, error: err.toJSON() };
}

export { now };
