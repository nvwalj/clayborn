// Task store + lifecycle.
//
// State strings are the ProtoJSON enum names from a2a.proto (v1.0 aligned enum
// format with ADR-001). They are NOT the lowercase pre-1.0 values like
// "submitted"/"working" — a v1.0 client will not recognise those.

import { randomUUID } from "node:crypto";

export const STATE = {
  UNSPECIFIED: "TASK_STATE_UNSPECIFIED",
  SUBMITTED: "TASK_STATE_SUBMITTED",
  WORKING: "TASK_STATE_WORKING",
  COMPLETED: "TASK_STATE_COMPLETED",
  FAILED: "TASK_STATE_FAILED",
  CANCELED: "TASK_STATE_CANCELED",
  INPUT_REQUIRED: "TASK_STATE_INPUT_REQUIRED",
  REJECTED: "TASK_STATE_REJECTED",
  AUTH_REQUIRED: "TASK_STATE_AUTH_REQUIRED",
};

const TERMINAL = new Set([STATE.COMPLETED, STATE.FAILED, STATE.CANCELED, STATE.REJECTED]);

export const isTerminal = (s) => TERMINAL.has(s);

export class TaskStore {
  /**
   * @param {object} opts
   * @param {number} opts.max      keep at most this many tasks (oldest terminal ones evicted)
   * @param {number} opts.ttlMs    drop terminal tasks older than this
   */
  constructor({ max = 500, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.tasks = new Map();
    this.max = max;
    this.ttlMs = ttlMs;
    this.aborters = new Map();
  }

  create({ contextId, message }) {
    const id = randomUUID();
    const task = {
      id,
      contextId: contextId || randomUUID(),
      status: { state: STATE.SUBMITTED, timestamp: now() },
      artifacts: [],
      history: message ? [message] : [],
    };
    this.tasks.set(id, task);
    this.#evict();
    return task;
  }

  get(id) {
    return this.tasks.get(id) || null;
  }

  /**
   * Move a task to a new state. Terminal states are final: once a task is
   * completed/failed/canceled/rejected nothing may move it again. Without this
   * guard a late-arriving backend event can resurrect a canceled task.
   */
  setState(id, state, { message, error } = {}) {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (isTerminal(t.status.state)) return t;
    t.status = { state, timestamp: now() };
    if (message) {
      t.status.message = message;
      t.history.push(message);
    }
    if (error) t.metadata = { ...(t.metadata || {}), error: String(error) };
    return t;
  }

  addArtifact(id, artifact) {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.artifacts.push(artifact);
    return t;
  }

  /** Register the abort handle for an in-flight backend run. */
  track(id, aborter) {
    this.aborters.set(id, aborter);
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (isTerminal(t.status.state)) return t; // already final — report as-is, per spec
    const aborter = this.aborters.get(id);
    if (aborter) {
      try {
        aborter();
      } catch {
        /* backend already gone */
      }
      this.aborters.delete(id);
    }
    return this.setState(id, STATE.CANCELED);
  }

  done(id) {
    this.aborters.delete(id);
  }

  /**
   * ListTasks with filtering + pagination (added to the spec in v1.0).
   * Newest first, which is what a polling client actually wants.
   */
  list({ pageSize = 50, pageToken = "", state = null } = {}) {
    let all = [...this.tasks.values()].sort(
      (a, b) => Date.parse(b.status.timestamp) - Date.parse(a.status.timestamp)
    );
    if (state) all = all.filter((t) => t.status.state === state);

    const start = pageToken ? Math.max(0, parseInt(pageToken, 10) || 0) : 0;
    const size = Math.min(Math.max(1, pageSize), 200);
    const page = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : "";
    return { tasks: page, nextPageToken: next };
  }

  #evict() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, t] of this.tasks) {
      if (isTerminal(t.status.state) && Date.parse(t.status.timestamp) < cutoff) {
        this.tasks.delete(id);
        this.aborters.delete(id);
      }
    }
    if (this.tasks.size <= this.max) return;
    // Still over budget: drop oldest terminal tasks first, never in-flight ones.
    const terminal = [...this.tasks.values()]
      .filter((t) => isTerminal(t.status.state))
      .sort((a, b) => Date.parse(a.status.timestamp) - Date.parse(b.status.timestamp));
    for (const t of terminal) {
      if (this.tasks.size <= this.max) break;
      this.tasks.delete(t.id);
      this.aborters.delete(t.id);
    }
  }
}

export const now = () => new Date().toISOString();

export function textMessage(text, { role = "ROLE_AGENT", taskId, contextId } = {}) {
  const m = {
    messageId: randomUUID(),
    role,
    parts: [{ text }],
  };
  if (taskId) m.taskId = taskId;
  if (contextId) m.contextId = contextId;
  return m;
}

/**
 * True only if some part carries content this agent can actually read.
 *
 * Deliberately separate from messageText(): that function renders placeholders
 * like "[inline image omitted]" for non-text parts, and a placeholder is not
 * content. Testing `messageText(m).trim()` instead would silently accept a
 * message made entirely of binary parts and feed the placeholder to the model.
 */
export function hasReadableContent(message) {
  if (!message?.parts?.length) return false;
  return message.parts.some(
    (p) => (typeof p.text === "string" && p.text.trim() !== "") || p.data !== undefined
  );
}

/** Flatten a Message's parts into plain text. Non-text parts are summarised. */
export function messageText(message) {
  if (!message?.parts?.length) return "";
  return message.parts
    .map((p) => {
      if (typeof p.text === "string") return p.text;
      if (p.data !== undefined) return JSON.stringify(p.data);
      if (p.url) return `[file: ${p.filename || p.url}]`;
      if (p.raw) return `[inline ${p.mediaType || "binary"} omitted]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
