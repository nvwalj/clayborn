// HTTP server: agent card + the JSON-RPC and HTTP+JSON bindings.
//
// REST paths follow the google.api.http annotations in a2a.proto:
//   POST /message:send          POST /tasks/{id}:cancel
//   GET  /tasks/{id}            GET  /tasks
// The colon is part of the path (AIP-136 custom methods), not a typo.
//
// v1.0.1 prefers the `application/a2a+json` media type for the HTTP binding;
// plain application/json is accepted on input because most clients send it.

import http from "node:http";
import { dispatch, RpcError, ERR } from "./rpc.js";

const A2A_JSON = "application/a2a+json";
const MAX_BODY = 2 * 1024 * 1024;

export function createServer({ card, jwks, handlers, config, peerVerifier, log = console.log }) {
  const token = config.auth?.mode === "bearer" ? config.auth.token : null;

  // The echo skill answers WITHOUT credentials — the protocol-level fist bump.
  // Two strangers on a wall can always make first contact, because echo runs
  // no model and reads nothing: free on both sides, nothing to steal. Guarded
  // hard: the exemption applies only when a skill with id "echo" exists AND
  // its backend is the echo backend — an owner-defined "echo" skill wired to
  // a real model never becomes a free door to their quota.
  const wholeAgentEchoes = (config.backend?.type || "echo") === "echo";
  const echoOpen = (config.skills || []).some(
    (s) => s.id === "echo" && (s.backend === "echo" || wholeAgentEchoes)
  );
  // Tasks born from anonymous echo calls, so the same anonymous caller can
  // poll them to completion. Nothing else is ever visible without auth.
  const publicTasks = new Set();
  const rememberPublic = (id) => {
    if (!id) return;
    if (publicTasks.size >= 4096) publicTasks.delete(publicTasks.values().next().value);
    publicTasks.add(id);
  };
  const isEchoSend = (b) =>
    b && !Array.isArray(b) &&
    ["SendMessage", "message/send"].includes(b.method) &&
    b.params?.metadata?.skillId === "echo";
  const isPublicFollowup = (b) =>
    b && !Array.isArray(b) &&
    ["GetTask", "tasks/get", "CancelTask", "tasks/cancel"].includes(b.method) &&
    publicTasks.has(b.params?.id);

  const server = http.createServer(async (req, res) => {
    const send = (code, obj, type = A2A_JSON) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        "content-type": `${type}; charset=utf-8`,
        "content-length": Buffer.byteLength(body),
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(body);
    };

    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      return send(400, { error: "bad request" });
    }
    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-max-age": "86400",
      });
      return res.end();
    }

    // --- Public: the agent card. Never behind auth; discovery depends on it. ---
    if (req.method === "GET" && (route === "/.well-known/agent-card.json" || route === "/.well-known/agent.json")) {
      return send(200, card, "application/json");
    }
    // Public for the same reason: peers verify our signatures with this.
    if (req.method === "GET" && route === "/.well-known/jwks.json") {
      return send(200, jwks || { keys: [] }, "application/json");
    }
    if (req.method === "GET" && route === "/") {
      return send(200, {
        ok: true,
        service: "clayborn",
        agent: card.name,
        card: "/.well-known/agent-card.json",
        endpoints: { jsonrpc: "/a2a", rest: ["/message:send", "/tasks", "/tasks/{id}"] },
      }, "application/json");
    }

    // --- Everything below is the protocol surface and may require credentials.
    // Two doors, either opens: the owner's static token, or a peer JWT that
    // src/peers.js can verify. A rejected peer gets the reason — it names no
    // secret, and "your token replayed" beats a bare 401 when the caller is a
    // machine three networks away. Third, narrow door: anonymous echo (above).
    let prereadBody;
    if (token || peerVerifier) {
      const auth = req.headers.authorization || "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      let authorized = false;
      let why = "missing bearer token";
      if (token && presented && timingSafeEqual(presented, token)) {
        authorized = true;
      } else if (peerVerifier && presented && presented.split(".").length === 3) {
        const r = await peerVerifier.verify(presented);
        if (r.ok) {
          authorized = true;
          log(`[peer] ${r.iss} → ${req.method} ${route}`);
        } else {
          why = r.reason;
        }
      } else if (presented) {
        why = "unrecognized token";
      }
      if (!authorized && echoOpen) {
        // Peek at what is actually being asked before slamming the door.
        if (req.method === "POST" && (route === "/a2a" || route === "/jsonrpc" || route === "/message:send")) {
          try {
            prereadBody = await readJson(req);
          } catch { /* malformed — fall through to 401; the body reader ate the stream anyway */ }
          const rpcish = route !== "/message:send";
          const probe = rpcish ? prereadBody : { method: "SendMessage", params: prereadBody };
          if (isEchoSend(probe) || (rpcish && isPublicFollowup(probe))) authorized = true;
        } else if (req.method === "GET" && /^\/tasks\/[^/:]+$/.test(route)) {
          if (publicTasks.has(decodeURIComponent(route.slice("/tasks/".length)))) authorized = true;
        } else if (req.method === "POST" && /:cancel$/.test(route)) {
          const id = route.match(/^\/tasks\/([^/]+):cancel$/)?.[1];
          if (id && publicTasks.has(decodeURIComponent(id))) authorized = true;
        }
        if (authorized) req._anonEcho = true;
      }
      if (!authorized) {
        res.writeHead(401, {
          "content-type": `${A2A_JSON}; charset=utf-8`,
          "www-authenticate": 'Bearer realm="clayborn"',
        });
        return res.end(JSON.stringify({ error: { code: -32600, message: "Unauthorized", data: why } }));
      }
    }

    // --- JSON-RPC binding ---
    if (req.method === "POST" && (route === "/a2a" || route === "/jsonrpc")) {
      let body;
      if (prereadBody !== undefined) {
        body = prereadBody;
      } else {
        try {
          body = await readJson(req);
        } catch (e) {
          return send(e.code === 413 ? 413 : 200, {
            jsonrpc: "2.0",
            id: null,
            error: new RpcError(e.code === 413 ? ERR.INVALID_REQUEST : ERR.PARSE, e.message).toJSON(),
          });
        }
      }
      if (req._anonEcho && isEchoSend(body)) {
        const out = await dispatch(handlers, body);
        rememberPublic(out?.result?.id);
        return out ? send(200, out) : res.writeHead(204).end();
      }

      if (Array.isArray(body)) {
        if (body.length === 0) {
          return send(200, {
            jsonrpc: "2.0",
            id: null,
            error: new RpcError(ERR.INVALID_REQUEST, "empty batch").toJSON(),
          });
        }
        const out = (await Promise.all(body.map((r) => dispatch(handlers, r)))).filter(Boolean);
        return out.length ? send(200, out) : res.writeHead(204).end();
      }
      const one = await dispatch(handlers, body);
      return one ? send(200, one) : res.writeHead(204).end();
    }

    // --- HTTP+JSON binding ---
    try {
      if (req.method === "POST" && route === "/message:send") {
        const params = prereadBody !== undefined ? prereadBody : await readJson(req);
        const task = await handlers.SendMessage(params);
        if (req._anonEcho) rememberPublic(task?.id);
        return send(200, task);
      }
      if (req.method === "GET" && route === "/tasks") {
        return send(200, handlers.ListTasks({
          pageSize: numOrUndef(url.searchParams.get("pageSize")),
          pageToken: url.searchParams.get("pageToken") || "",
          state: url.searchParams.get("state") || null,
        }));
      }
      const cancel = route.match(/^\/tasks\/([^/]+):cancel$/);
      if (req.method === "POST" && cancel) {
        return send(200, handlers.CancelTask({ id: decodeURIComponent(cancel[1]) }));
      }
      const getTask = route.match(/^\/tasks\/([^/:]+)$/);
      if (req.method === "GET" && getTask) {
        return send(200, handlers.GetTask({
          id: decodeURIComponent(getTask[1]),
          historyLength: numOrUndef(url.searchParams.get("historyLength")),
        }));
      }
      if (route === "/message:stream" || route.endsWith(":subscribe")) {
        throw new RpcError(ERR.UNSUPPORTED_OPERATION, "streaming is not supported by this agent");
      }
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(ERR.INTERNAL, err?.message);
      return send(httpStatusFor(e.code), { error: e.toJSON() });
    }

    send(404, { error: { code: -32601, message: "Method not found", data: route } });
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}

// Section 5.4 maps each A2A error to an HTTP status for the REST binding.
function httpStatusFor(code) {
  if (code === -32001) return 404;
  if (code === -32603 || code === -32006) return 500;
  if (code === -32601) return 404;
  return 400;
}

function numOrUndef(v) {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        const e = new Error("request body too large");
        e.code = 413;
        req.destroy();
        return reject(e);
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

/** Constant-time-ish compare so a wrong token can't be recovered by timing. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
