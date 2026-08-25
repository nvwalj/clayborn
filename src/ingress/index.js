// Ingress: how the outside world reaches this machine.
//
// The whole point of the repo is that most people have no public domain, no
// static IP, and a machine behind NAT. Three modes, all producing one thing:
// the absolute public URL that goes into the agent card.
//
//   quick  (default) — cloudflared quick tunnel. No account, no domain, no DNS.
//                      Ephemeral: the hostname changes on every restart.
//   named            — you own the hostname. cloudflared runs your named tunnel,
//                      or you point any reverse proxy at the local port.
//   none             — no ingress. LAN or localhost only.
//   cardwall         — a hosted service that gives you a stable address and
//                      answers on your behalf while this machine is asleep.
//                      Optional, and deliberately so: see below.
//
// `quick`, `named` and `none` must always be first-class and must always work
// with no account anywhere. cardwall is allowed to make things EASIER; it is
// never allowed to become the thing that makes them POSSIBLE. Nothing in this
// file may phone home, and nothing outside `mode: "cardwall"` may contact it.
//
// `none` is not a downgrade. For an agent on a work machine, or two machines on
// the same network, it is the correct answer — A2A is just HTTP, and the card's
// url may be a private address. Do not expose a company machine to the internet
// because a default told you to.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

const CLOUDFLARED = [
  process.env.CLOUDFLARED_BIN,
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  "/usr/bin/cloudflared",
].filter(Boolean);

function resolveCloudflared() {
  for (const p of CLOUDFLARED) if (existsSync(p)) return p;
  return null;
}

/**
 * @returns {Promise<{ url: string, mode: string, stop: () => void, note?: string }>}
 */
export async function startIngress(config, port, log = console.log) {
  const mode = config.ingress?.mode || "quick";

  if (mode === "none") {
    const url = config.ingress?.publicUrl || `http://${lanAddress()}:${port}`;
    return { url, mode, stop: () => {}, note: "no public ingress — reachable on this network only" };
  }

  if (mode === "named") {
    const url = config.ingress?.publicUrl;
    if (!url) {
      throw new Error(
        'ingress.mode "named" requires ingress.publicUrl (e.g. "https://agent.example.com")'
      );
    }
    if (config.ingress.tunnel) {
      const bin = requireCloudflared();
      const child = spawn(bin, ["tunnel", "run", config.ingress.tunnel], { stdio: "ignore" });
      child.on("error", (e) => log(`[ingress] cloudflared: ${e.message}`));
      return { url, mode, stop: () => child.kill("SIGTERM") };
    }
    return {
      url,
      mode,
      stop: () => {},
      note: "assuming your own proxy/tunnel already forwards to this port",
    };
  }

  if (mode === "cardwall") return startCardwall(config, port, log);

  if (mode !== "quick") throw new Error(`unknown ingress.mode: ${mode}`);
  return startQuickTunnel(port, log);
}

/**
 * Connect to a cardwall host.
 *
 * The contract, so it is written down before the code exists: this agent dials
 * OUT and holds the connection open; the host forwards inbound A2A calls back
 * down it and publishes a stable hostname that survives restarts and sleep.
 * Same shape as cloudflared, and for the same reason — it is the only way to be
 * reachable from behind NAT without opening a port.
 *
 * Not implemented yet. It fails loudly rather than degrading to something that
 * looks like it worked: an agent that believes it is reachable and is not is
 * worse than one that refused to start.
 */
async function startCardwall(config, port, log) {
  const host = config.ingress?.host || "https://cardwall.ai";
  if (!config.ingress?.token) {
    throw new Error(
      `ingress.mode "cardwall" requires ingress.token (or CLAYBORN_TOKEN).\n` +
        `  Not ready yet — use "quick" for a free public URL with no account, ` +
        `or "none" to stay on your own network.`
    );
  }
  throw new Error(
    `ingress.mode "cardwall" is not implemented in this release (host: ${host}).\n` +
      `  "quick" gives you a public URL today with no account and no domain.`
  );
}

function requireCloudflared() {
  const bin = resolveCloudflared();
  if (!bin) {
    throw new Error(
      "cloudflared not found. Install it (brew install cloudflared) or set " +
        'ingress.mode to "none" in clayborn.config.json.'
    );
  }
  return bin;
}

function startQuickTunnel(port, log) {
  const bin = requireCloudflared();
  log("[ingress] opening a quick tunnel (no account needed)…");

  const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = "";

    // cloudflared prints the assigned hostname to stderr inside a box; the only
    // reliable handle is the URL itself.
    const scan = (chunk) => {
      buf += chunk;
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          url: m[0],
          mode: "quick",
          stop: () => child.kill("SIGTERM"),
          note: "ephemeral URL — it changes every time you restart",
        });
      }
      if (buf.length > 64_000) buf = buf.slice(-8000);
    };

    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", scan);
    child.stdout.on("data", scan);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not start cloudflared: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited ${code} before announcing a URL`));
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("cloudflared did not announce a URL within 45s"));
    }, 45_000);
  });
}

/** Best-effort LAN address, so `none` mode still prints something another machine can call. */
export function lanAddress() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return "127.0.0.1";
}
