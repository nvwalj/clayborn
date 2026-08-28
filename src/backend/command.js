// Backend: command — wrap any CLI that can answer a question.
//
// This is the universal adapter. OpenClaw, ollama, llm, claude -p, a shell
// script — anything you can ask in a terminal can be an A2A agent behind
// clayborn: clayborn does the card, the signing, the wall; the command does
// the thinking.
//
// The security posture, in order of importance:
//   * argv comes from the OWNER's config, never from the caller. The caller's
//     text enters only as data.
//   * No shell, ever — execFile(argv[0], argv.slice(1)). A prompt containing
//     `$(rm -rf ~)` is just characters.
//   * The prompt is delivered EITHER by replacing the literal `{prompt}`
//     placeholder in argv elements, OR — when no placeholder is present — by
//     stdin. Stdin is the safer default for tools that read it; the
//     placeholder exists for CLIs (like `openclaw agent -m …`) that only take
//     the message as an argument.
//   * Hard timeout and a hard output cap. A wedged tool becomes a FAILED
//     task, not a wedged agent.
//
// What this does NOT do: sandbox the wrapped tool. If your command can send
// messages or delete files, strangers on the wall can now ask it to. Expose a
// command you would let strangers talk to — and say so in the skill's
// promptPrefix. A prompt is a request, not a fence.

import { execFile } from "node:child_process";

const MAX_OUTPUT = 512 * 1024;

export function createCommandBackend(config) {
  const spec = config.backend;
  const argvTemplate = spec.argv;
  const timeoutMs = (spec.timeoutSeconds || 240) * 1000;

  return {
    name: "command",
    describe: () => `command (${argvTemplate[0]}${argvTemplate.length > 1 ? " …" : ""}, timeout ${timeoutMs / 1000}s)`,

    /** @returns {{ promise: Promise<string>, abort: () => void }} */
    run({ prompt, taskId }) {
      let child = null;
      let aborted = false;

      const promise = new Promise((resolve, reject) => {
        const hasSlot = argvTemplate.some((a) => a.includes("{prompt}"));
        // {taskId} lets a session-oriented CLI (openclaw agent --session-id …)
        // isolate every task in its own session — without it, all callers
        // would share one conversation and could read each other's context.
        const argv = argvTemplate.map((a) =>
          a.split("{prompt}").join(prompt).split("{taskId}").join(taskId || "no-task")
        );

        child = execFile(
          argv[0],
          argv.slice(1),
          {
            timeout: timeoutMs,
            killSignal: "SIGTERM",
            maxBuffer: MAX_OUTPUT,
            // Extra environment from the owner's config (HERMES_HOME and the
            // like) — layered over ours, never replacing it, so PATH survives.
            env: spec.env ? { ...process.env, ...spec.env } : process.env,
          },
          (err, stdout, stderr) => {
            if (aborted) return reject(new Error("canceled"));
            if (err) {
              const why = err.killed
                ? `timed out after ${timeoutMs / 1000}s`
                : (String(stderr || "").trim() || err.message).slice(0, 400);
              return reject(new Error(`command backend: ${why}`));
            }
            // ANSI escapes never survive — a terminal answer is not a terminal.
            let text = String(stdout).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
            if (spec.lastParagraph) {
              // For CLIs that print a banner before the answer (PicoClaw's
              // lobster, and friends): the answer is the last paragraph.
              const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
              if (paras.length) text = paras[paras.length - 1].trim();
            }
            resolve(text || "(the command produced no output)");
          }
        );

        if (child.stdin) {
          if (!hasSlot) child.stdin.write(prompt);
          child.stdin.end();
        }
      });

      return {
        promise,
        abort: () => {
          aborted = true;
          child?.kill("SIGTERM");
        },
      };
    },
  };
}
