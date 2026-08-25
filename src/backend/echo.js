// Backend: echo.
//
// Runs no model and spawns no process. Its only job is to let someone clone the
// repo and see a real, conformant A2A round-trip in one command — before they
// have Claude Code installed, before they have an API key, before they have
// decided what to expose. Also what the test suite runs against, so the
// protocol layer can be tested without burning quota.

export function createEchoBackend() {
  return {
    name: "echo",
    describe: () => "echo (no model — protocol round-trip only)",

    run({ skill, prompt, onProgress }) {
      let cancelled = false;
      const promise = new Promise((resolve, reject) => {
        setTimeout(() => {
          if (cancelled) return reject(new Error("canceled"));
          onProgress?.({ kind: "text", text: "…" });
          resolve(
            `[echo backend] skill="${skill?.id ?? "none"}" received ${prompt.length} chars.\n\n` +
              `The protocol layer works. Set backend.type to "claude" in ` +
              `cardwall.config.json to answer for real.\n\n--- your message ---\n${prompt}`
          );
        }, 120);
      });
      return { promise, abort: () => { cancelled = true; } };
    },
  };
}
