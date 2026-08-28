// The universal adapters: any CLI, any local port.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createCommandBackend } from "../src/backend/command.js";
import { createHttpBackend } from "../src/backend/http.js";

const run = (backend, prompt) => backend.run({ skill: { id: "s" }, prompt }).promise;

test("command backend feeds stdin when there is no placeholder", async () => {
  const b = createCommandBackend({ backend: { type: "command", argv: ["cat"] } });
  assert.equal(await run(b, "hello through stdin"), "hello through stdin");
});

test("command backend substitutes {prompt} into argv — as data, never through a shell", async () => {
  const b = createCommandBackend({
    backend: { type: "command", argv: ["node", "-e", "console.log(process.argv[1].toUpperCase())", "--", "{prompt}"] },
  });
  // If a shell ever interpreted this, $(echo pwned) would not survive verbatim.
  assert.equal(await run(b, "spacex $(echo pwned)"), "SPACEX $(ECHO PWNED)");
});

test("a failing command becomes a FAILED task, with stderr in the reason", async () => {
  const b = createCommandBackend({
    backend: { type: "command", argv: ["node", "-e", "console.error('boom'); process.exit(3)"] },
  });
  await assert.rejects(() => run(b, "x"), /boom/);
});

test("a wedged command times out instead of wedging the agent", async () => {
  const b = createCommandBackend({
    backend: { type: "command", argv: ["node", "-e", "setTimeout(()=>{}, 60000)"], timeoutSeconds: 1 },
  });
  await assert.rejects(() => run(b, "x"), /timed out/);
});

test("http backend: JSON {text} answers, plain text answers, and HTTP errors", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { prompt } = JSON.parse(body);
      if (req.url === "/json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ text: `json says: ${prompt}` }));
      } else if (req.url === "/plain") {
        res.end(`plain says: ${prompt}`);
      } else {
        res.statusCode = 500;
        res.end("kaput");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const j = createHttpBackend({ backend: { type: "http", url: `${base}/json` } });
    assert.equal(await run(j, "ping"), "json says: ping");
    const p = createHttpBackend({ backend: { type: "http", url: `${base}/plain` } });
    assert.equal(await run(p, "ping"), "plain says: ping");
    const e = createHttpBackend({ backend: { type: "http", url: `${base}/boom` } });
    await assert.rejects(() => run(e, "ping"), /HTTP 500.*kaput/s);
  } finally {
    server.close();
  }
});
