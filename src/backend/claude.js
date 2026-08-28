// Backend: drive Claude Code in print mode.
//
// SECURITY POSTURE — read before changing any flag here.
//
// This process is reachable from the public internet. It must NOT be able to do
// what your own interactive session can do. Three rules, all enforced below:
//
//   1. NEVER pass --dangerously-skip-permissions. A remote caller must not be
//      able to make this machine run arbitrary tools without a gate.
//   2. Run in a dedicated workDir, not the repo and not your home directory.
//      The default is .clayborn-work/, created on demand.
//   3. Tools are DENIED by default. A skill opts in to specific tools via its
//      `tools` list; everything else is refused by --disallowed-tools.
//
// It also does not inherit your session: no --resume, no --continue, and the
// MCP config is whatever the skill declares (default: none).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// Refused unless a skill explicitly asks for them. The read-only tools
// (Read/Glob/Grep/LS) matter as much as the writes: a corpus-grounded skill
// answers only from passages we paste in, so a caller telling the model to
// "ignore the passages and read /etc/…" must find no tool to obey with.
const DENY_BY_DEFAULT = [
  "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Read", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Task", "TodoWrite",
];

const CLAUDE_CANDIDATES = [
  process.env.CLAUDE_BIN,
  `${process.env.HOME}/.local/bin/claude`,
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
].filter(Boolean);

function resolveClaude() {
  for (const p of CLAUDE_CANDIDATES) if (existsSync(p)) return p;
  return "claude"; // fall back to PATH
}

export function createClaudeBackend(config) {
  const bin = resolveClaude();
  const workDir = path.resolve(config.backend?.workDir || ".clayborn-work");
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const model = config.backend?.model || "claude-sonnet-5";
  const timeoutMs = (config.backend?.timeoutSeconds || 300) * 1000;

  return {
    name: "claude",
    describe: () => `${bin} -p (model=${model}, cwd=${workDir})`,

    /**
     * @returns {{ promise: Promise<string>, abort: () => void }}
     */
    run({ skill, prompt, onProgress }) {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        // Ignore the machine's ambient MCP servers entirely: the ONLY MCP
        // surface is what a skill explicitly declares via --mcp-config below.
        "--strict-mcp-config",
        // And ignore ALL other ambient customizations — the owner's CLAUDE.md,
        // skills, plugins, hooks, auto-memory. A public agent driven by a
        // stranger's prompt must not inherit any of the operator's environment,
        // or a "no tools" skill could still trip hooks or leak loaded context.
        "--safe-mode",
      ];

      const allowed = skill?.tools || [];
      if (allowed.length) {
        args.push("--allowed-tools", allowed.join(","));
        const denied = DENY_BY_DEFAULT.filter((t) => !allowed.includes(t));
        if (denied.length) args.push("--disallowed-tools", denied.join(","));
      } else {
        // No tools requested: turn the built-in set OFF authoritatively, not
        // merely subtract a deny list. `--tools ""` leaves the model with no
        // built-in tools at all.
        args.push("--tools", "");
      }

      // MCP servers ARE tools. A skill that opted into no built-in tools does
      // not get an MCP surface either — otherwise the no-tools promise leaks
      // through a side door.
      if (skill?.mcpConfig && allowed.length) args.push("--mcp-config", skill.mcpConfig);
      if (skill?.systemPrompt) args.push("--append-system-prompt", skill.systemPrompt);

      const child = spawn(bin, args, {
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAYBORN: "1" },
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, timeoutMs);

      const promise = new Promise((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          // stream-json emits one JSON object per line.
          let nl;
          while ((nl = stdout.indexOf("\n")) !== -1) {
            const line = stdout.slice(0, nl).trim();
            stdout = stdout.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              handleEvent(ev, onProgress);
              if (ev.type === "result") {
                settled = true;
                clearTimeout(timer);
                if (ev.subtype && ev.subtype !== "success") {
                  reject(new Error(`claude returned ${ev.subtype}`));
                } else {
                  resolve(String(ev.result ?? "").trim());
                }
              }
            } catch {
              // Not JSON (a warning line, a partial write) — ignore it rather
              // than failing the whole run.
            }
          }
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c) => {
          stderr = (stderr + c).slice(-4000);
        });

        child.on("error", (e) => {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`could not start ${bin}: ${e.message}`));
        });

        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (signal === "SIGKILL") {
            reject(new Error(`backend timed out after ${timeoutMs / 1000}s`));
          } else {
            reject(new Error(`claude exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
          }
        });
      });

      child.stdin.end(prompt);

      return { promise, abort: () => child.kill("SIGTERM") };
    },
  };
}

function handleEvent(ev, onProgress) {
  if (!onProgress) return;
  if (ev.type === "assistant" && ev.message?.content) {
    const text = ev.message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text.trim()) onProgress({ kind: "text", text });
  } else if (ev.type === "assistant" && ev.message?.stop_reason === "tool_use") {
    onProgress({ kind: "tool" });
  }
}
