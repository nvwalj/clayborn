// Backend: http — wrap any agent that answers on a local port.
//
// Most agent runtimes expose some HTTP surface (OpenClaw's gateway, an
// OpenAI-compatible /v1 endpoint, a bespoke webhook). This backend POSTs the
// prompt there and returns whatever comes back; clayborn does the card, the
// signing, the wall.
//
//   "backend": { "type": "http", "url": "http://127.0.0.1:18789/…",
//                "headers": { "authorization": "Bearer …" } }
//
// The URL is the OWNER's config, typed by the person who runs this agent —
// usually loopback, pointing at their own runtime. It is trusted the same way
// corpus file paths are, so no SSRF battery here: guarding an owner against
// their own config would only break the local-bridge case this exists for.
//
// Request:  POST {"prompt": "...", "skill": "<id>"}
// Response: JSON with a "text" field, or any plain-text body.

const MAX_OUTPUT = 512 * 1024;

export function createHttpBackend(config) {
  const spec = config.backend;
  const timeoutMs = (spec.timeoutSeconds || 240) * 1000;

  return {
    name: "http",
    describe: () => `http (${spec.url}, timeout ${timeoutMs / 1000}s)`,

    /** @returns {{ promise: Promise<string>, abort: () => void }} */
    run({ skill, prompt }) {
      const ac = new AbortController();
      const promise = (async () => {
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          let res;
          try {
            res = await fetch(spec.url, {
              method: "POST",
              signal: ac.signal,
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/plain",
                ...(spec.headers || {}),
              },
              body: JSON.stringify({ prompt, skill: skill?.id ?? null }),
            });
          } catch (e) {
            throw new Error(
              e.name === "AbortError"
                ? `http backend: timed out after ${timeoutMs / 1000}s`
                : `http backend: cannot reach ${spec.url} (${e.message})`
            );
          }
          const body = (await res.text()).slice(0, MAX_OUTPUT);
          if (!res.ok) {
            throw new Error(`http backend: ${spec.url} returned HTTP ${res.status}: ${body.slice(0, 200)}`);
          }
          try {
            const j = JSON.parse(body);
            if (typeof j?.text === "string" && j.text.trim()) return j.text.trim();
          } catch { /* not JSON — plain body is the answer */ }
          return body.trim() || "(the backend produced no output)";
        } finally {
          clearTimeout(timer);
        }
      })();

      return { promise, abort: () => ac.abort() };
    },
  };
}
