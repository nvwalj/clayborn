#!/usr/bin/env node
// The clayborn command. Because the repo is the package, this runs without
// installing anything:
//
//   npx github:nvwalj/clayborn init
//   npx github:nvwalj/clayborn start
//
// Config is looked for in the CURRENT directory first, so your agent lives in
// a folder you own, not inside wherever npm cached the code.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, copyFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);

const HELP = `clayborn — run your own A2A agent on your own machine

usage:
  clayborn init                        scaffold clayborn.config.json in this directory
  clayborn start                       run the agent (config from this directory)
  clayborn check [card-url]            validate your card, or anyone's
  clayborn call <peer> "msg" --iss <my-base>        send a task to a peer
  clayborn wall <wall> list                          browse a cardwall
  clayborn wall <wall> register|me|repost|leave --iss <my-base>
  clayborn wall <wall> tear <agent-id> --iss <my-base>

The config decides everything else — skills, backend, ingress, wall, seeking.
Start with init: the scaffold runs safely as-is (echo backend, no ingress).`;

function delegate(script) {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", script), ...rest], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
  process.exit(cmd ? 0 : 2);
} else if (cmd === "init") {
  const target = path.resolve("clayborn.config.json");
  if (existsSync(target)) {
    console.error("clayborn.config.json already exists here — not touching it.");
    process.exit(1);
  }
  copyFileSync(path.join(ROOT, "clayborn.config.example.json"), target);
  console.log("wrote clayborn.config.json — echo backend, no ingress, safe to run exactly as it is.");
  console.log("edit it (name, skills, ingress), then:  clayborn start");
} else if (cmd === "start") {
  const { start } = await import(path.join(ROOT, "src", "index.js"));
  start().then(
    ({ stop }) => {
      let closing = false;
      const bye = async () => {
        if (closing) return;
        closing = true;
        console.log("\n[clayborn] shutting down…");
        await stop();
        process.exit(0);
      };
      process.on("SIGINT", bye);
      process.on("SIGTERM", bye);
    },
    (err) => {
      console.error(`\n[clayborn] ${err.message}\n`);
      process.exit(1);
    }
  );
} else if (cmd === "check") {
  delegate("check-card.js");
} else if (cmd === "call") {
  delegate("call.js");
} else if (cmd === "wall") {
  delegate("wall.js");
} else {
  console.error(`unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(2);
}
