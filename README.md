# clayborn

*Born of clay.* In the Chinese creation myth, Nüwa knelt by the river and
shaped the first people out of yellow earth, one at a time, by hand — and when
that grew slow she dipped a cord in the mud and flung it, and the flying drops
became people too.

This is the cord. You already made your agent by hand; this is how everyone
else makes theirs.

---

clayborn runs your own [A2A](https://a2a-protocol.org) agent on your own
machine, and makes it findable. Zero runtime dependencies. Node 20+.

```bash
git clone https://github.com/nvwalj/clayborn && cd clayborn
node src/index.js
```

That is the whole install. It starts a conformant A2A agent on
`127.0.0.1:8788` with the echo backend and no ingress — it answers the protocol
correctly and exposes nothing. Watch a task go `SUBMITTED → WORKING →
COMPLETED`, then decide what you actually want to run.

## Why this exists

Every A2A registry today lists *services*: hosted products with a domain, a
company, and an SLA. Nothing serves the other case — a person running an agent
on the laptop in front of them, behind NAT, on a machine that sleeps.

That is the case this is built for, and every default reflects it.

## What you get

- **A conformant Agent Card** at `/.well-known/agent-card.json`, validated at
  boot against the v1.0 shape. It refuses to start rather than publish a broken
  card.
- **JSON-RPC 2.0 binding** at `/a2a` — `SendMessage`, `GetTask`, `ListTasks`,
  `CancelTask`, with the spec's error codes.
- **HTTP+JSON binding** — `POST /message:send`, `GET /tasks/{id}`, `GET /tasks`,
  `POST /tasks/{id}:cancel`.
- **The full task lifecycle**, all eight states, with terminal states actually
  final.
- **A Claude Code backend** that runs in a sandbox, or an echo backend that runs
  nothing.
- **Ingress that works from behind NAT**, with no account and no domain.

## Three decisions, in the order they matter

### 1. What will this agent do for strangers?

This is the only irreversible one. An Agent Card is a public API contract: once
another machine can call `SendMessage`, whatever you declared is what you have
promised.

Skills live in `clayborn.config.json`. Each declares its own tool access:

```json
{
  "id": "summarize",
  "name": "Summarize a document",
  "description": "Returns a short summary of text you send.",
  "tags": ["text"],
  "tools": [],
  "promptPrefix": "Summarize the following in under 100 words."
}
```

`"tools": []` means the skill runs with **no tools at all** — it can read
nothing and write nothing. That is the default, and for most agents it should
stay that way. Adding `"tools": ["Read"]` lets that skill read files in its
working directory; add tools deliberately, one at a time.

"Forward the caller's prompt to this machine" is not a skill. It is a remote
execution endpoint with extra steps.

### 2. How will people reach it?

```jsonc
"ingress": { "mode": "none" }    // LAN / localhost only (default)
"ingress": { "mode": "quick" }   // free public URL, no account, no domain
"ingress": { "mode": "named", "publicUrl": "https://agent.example.com",
             "tunnel": "my-tunnel" }
```

`quick` shells out to `cloudflared tunnel --url` and gets you a
`*.trycloudflare.com` address in seconds — no Cloudflare account, no DNS, no
port forwarding, and it works from behind NAT because cloudflared only makes
*outbound* connections. The URL changes on every restart.

**`none` is not a lesser mode.** For two machines on one network, or an agent on
a work laptop, it is the correct answer: A2A is ordinary HTTP and a card's `url`
may be a private address. Peers you already know can be configured directly —
the spec lists direct configuration as a first-class discovery method, alongside
the well-known URI and registries.

> If the machine belongs to your employer, or sits on their network, a public
> tunnel bypasses their perimeter controls by design. That is a policy question,
> not a technical one, and it is yours to answer before you flip this to `quick`.

There is a fourth mode, `cardwall`, for a hosted service that keeps a stable
address answering while your machine sleeps. It is not implemented yet, and the
rule it will be built under is written into `src/ingress/index.js`: **quick,
named and none stay first-class and keep working with no account anywhere.** A
hosted service may make this easier. It may never become the thing that makes it
possible.

### 3. Who is allowed to call it?

```json
"auth": { "mode": "bearer", "token": "…long random string…" }
```

Or set `CLAYBORN_TOKEN`. With `mode: "none"` anyone who learns the URL can spend
your quota; the boot banner says so every time. The agent card is always served
without auth — discovery depends on it.

## Backends

**`echo`** (default) answers without a model. It exists so the protocol layer can
be verified — and tested — before you install anything or spend anything.

**`claude`** runs Claude Code in print mode. The security posture is fixed in
`src/backend/claude.js` and worth reading before you change it:

- never `--dangerously-skip-permissions`
- a dedicated `workDir`, not the repo and not your home directory
- tools denied by default; a skill opts into specific ones
- no `--resume` / `--continue`, so it cannot inherit your own session

```json
"backend": { "type": "claude", "model": "claude-sonnet-5", "timeoutSeconds": 300 }
```

## Checking cards

```bash
npm run check                              # your own config
npm run check -- https://some-agent.dev    # anyone's
```

Worth pointing at other agents. An [APIs.io scan][scan] of 22,341 hosts in July
2026 found 65 published cards — 10 passed every structural check.

A note on that, because it cost us an afternoon: **published "common mistakes"
lists are largely describing the pre-1.0 spec.** Against v1.0.1 the actual rules
are:

| | v1.0 |
|---|---|
| interface list | `supportedInterfaces` — *not* `additionalInterfaces` |
| `protocolVersion` | per-interface; **no** top-level field |
| `url` | per-interface; **no** top-level field |
| `capabilities` | an object, never an array |
| task states | `TASK_STATE_WORKING`, not `working` |
| methods | `SendMessage` / `GetTask`, not `message/send` / `tasks/get` |

Field names in this repo come from [`specification/a2a.proto`][proto], which the
spec names as the single authoritative definition. We accept the pre-1.0 method
spellings on input anyway — being lenient costs nothing and lets older clients
talk to you — but never emit them.

## Tests

```bash
npm test
```

Thirteen tests over the protocol surface, all against the echo backend, so they
cost nothing to run.

## License

MIT

[scan]: https://apievangelist.com/2026/07/29/most-published-agent-cards-are-not-actually-a2a/
[proto]: https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto
