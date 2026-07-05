# ADR 0015: Secrets firewall — the main process holds no ambient credentials

- **Status:** accepted (design; flag-gated build to follow as its own `/goal`)
- **Date:** 2026-07-05
- **Deciders:** Paco
- **Relates to:** implements the charter's **secrets firewall** (the load-bearing safety-net
  mechanism named in [ADR 0012](0012-self-evolution-spine-closed-loop.md)); the *exfil* half of
  the lethal trifecta that [ADR 0014](0014-dual-llm-privilege-separation.md) complements (the *act*
  half); protects the hard safety line **(b) no leaking secrets** under full autonomy

## Context

Houge's two hard safety lines are (a) no adverse impact to his own operation and (b) no leaking
secrets. Under notify-after autonomy (fork #1) these force a *mechanical* floor — the human is no
longer in the loop per action, so the code must make a leak structurally hard, not merely
discouraged. The charter names a **secrets firewall** as one of the five floor mechanisms and makes
it load-bearing exactly at spine steps ③/④ (autonomous internet ingestion). ③ `http_fetch` shipped
live on 2026-07-05; ④ (the LLM Wiki) will ingest the open internet at scale. This is the moment.

A 2026-07-05 survey mapped the actual secret surface — it is small and precisely bounded:

- **The daemon holds exactly five real secrets:** four HTTP API keys (`KIMI_API_KEY`,
  `GEMINI_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`) and the Telegram bot token
  (`HOUGE_TELEGRAM_BOT_TOKEN`). No Anthropic/OpenAI key is read anywhere in `src/`.
- **`.env` is loaded by mutating `process.env` in place** (`src/config/load-env.ts:37`), once at boot
  (`src/cli.ts:13`). Everything downstream reads **ambient `process.env`** — there is no threaded
  config object. The four HTTP providers read their key from `process.env` **at call time**
  (`openai-compat.ts:124`, `tavily.ts:44`, `firecrawl.ts:47`), living in the daemon's own memory.
- **The CLI-spawn legs are already firewalled.** `buildChildEnv` (`cli-spawn.ts:116`) passes an
  **allowlist** (`PATH/HOME/TERM/LANG/USER`) to pi/agy children; they authenticate via their own
  `$HOME` and never receive our secrets. This is the pattern to generalize.

Three concrete leak vectors remain, and they matter under autonomy:

1. **Ambient `process.env` authority.** Any code in the process — including a **self-written** file
   that passed review — can read `process.env.KIMI_API_KEY`. The self-write guard
   (`self-write-guard.ts`) protects *structure* (gate machinery, identity, test-weakening) but is
   **blind to a new file that reads env and exfiltrates it**; such a file under `src/capabilities/`
   passes the guard.
2. **Codex full-env inheritance.** The Codex self-diagnose/self-write child does **not** use the
   allowlist — `coding-agent.ts` spawns with no explicit `env`, so it **inherits the daemon's entire
   `process.env`**, carrying all secrets into the child even though Codex authenticates via its own
   subscription and needs none of them.
3. **No output redaction.** There is no helper that scrubs a secret *value* from an outbound Telegram
   reply, a ledger payload, or a log line. Provider errors are key-free by convention, but nothing
   *enforces* it — one careless interpolation leaks a key over the answer channel.

## Decision

**We will remove ambient credential authority from the daemon: after boot loads them, the five
secrets live only inside a `SecretBroker` and the objects it deliberately hands them to — never in
`process.env`, never importable by arbitrary code, never re-read from the environment.**

Concretely (Phase 1 — in-process broker; single Node process, no new process boundary):

1. **`SecretBroker` (new, `src/config/secret-broker.ts`).** Constructed at boot from the loaded env;
   holds the five secrets in a **private closure** with narrow typed getters
   (`kimiKey()`, `geminiKey()`, `tavilyKey()`, `firecrawlKey()`, `telegramToken()`). It is **not a
   module-level singleton export** — it is *injected* into exactly the factories that need it. There
   is no generic `get(name)` accessor.
2. **Strip after load.** Immediately after constructing the broker, `delete process.env[k]` for every
   secret key (matched by exact name **and** the `*_API_KEY` / `*_TOKEN` / `*_SECRET` patterns, so an
   operator's future key is stripped by default). For the rest of the process lifetime `process.env`
   holds no credential.
3. **Single source of truth for the HTTP providers.** `buildLlmChain` / `buildWebChain` receive the
   broker and populate each provider's existing (currently-unused) `config.apiKey` slot; providers
   read **only** `config.apiKey` — the `?? process.env[…]` fallback is **removed**. One source, the
   broker; no ambient re-read path.
4. **Telegram token via the broker.** `TelegramClient` is constructed from `broker.telegramToken()`
   at boot (it already captures the token privately); the env var is stripped afterward. The main
   loop reaches the token only through the already-constructed client, never the environment.
5. **Codex child env lockdown.** Route Codex spawns through an explicit allowlisted env (the
   `buildChildEnv` pattern), not full `process.env` inheritance — belt-and-braces even after the
   strip empties the secrets.
6. **Outbound redaction.** The broker produces a `redact(text)` that replaces any known secret
   *value* with `«redacted»`; apply it at the egress points (Telegram reply assembly, ledger payload
   write, error surfacing) so a value can never ride an outbound string.
7. **Protect the wiring.** Add `secret-broker.ts` and the boot wiring to the self-write
   `PROTECTED_FILES`, so a self-write cannot re-route secrets, restore the `process.env` fallback, or
   disable the strip.

**The property this yields:** after boot the five secrets exist only inside the broker closure and
the specific objects it handed them to (provider `config`, `TelegramClient`). `process.env` is
credential-free, so a self-written `process.env.KIMI_API_KEY` reads `undefined`; new code has no
import path to the broker (protected wiring); Codex children inherit an allowlisted env; and any
secret value reaching an outbound string is redacted. Guard-blindness (vector 1) stops mattering for
these secrets because **the ambient target is empty**.

## Consequences

- **The *exfil* half of the trifecta is structurally bounded**, pairing with
  [ADR 0014](0014-dual-llm-privilege-separation.md)'s *act* half. Together they gate the
  charter's human-tapped → autonomous merge flip; this ADR ships **first** (smaller, mechanical,
  directly protects hard line (b)).
- **Least-privilege by construction.** Credentials flow only to the four provider factories and the
  Telegram client; nothing else in the process can name a secret. New capabilities must be *given* a
  key through the broker to use one — the default is no access.
- **Honest limit — this is in-process, not process-isolation.** A fully compromised daemon (arbitrary
  code that already passed review *and* merge) can still read the broker's memory or the provider
  configs. Removing ambient authority defeats the realistic near-term vectors (env reads, guard
  blindness, Codex inheritance, accidental dumps); it does **not** defeat code that has already
  breached the merge floor. That stronger form — a **separate broker process** that holds secrets and
  answers scoped, audited requests over IPC, so the main loop's address space never contains a key —
  is deferred to **Phase 2** (its own ADR-amendment) and slotted only if the threat model demands it.
- **The merge floor still owns "malicious merged code."** The reviewer + test-gate + human-tapped
  merge remain the backstop for a self-write that does arbitrary I/O; the firewall raises the bar (no
  ambient keys to grab) but does not replace review. Arbitrary *data* exfil via a raw `fetch` in
  merged code stays owned by that floor (and, later, sandboxing) — out of scope here, which is
  **secrets**, not all egress.
- **Small, contained build.** Providers already prefer `config.apiKey`; the change is concentrated in
  the two chain builders, the boot sequence, the Codex spawn env, and a redactor — not a
  rewrite. Flag-gated (`HOUGE_SECRETS_FIREWALL_ENABLED`, default OFF at first) so the strip can be
  proven not to starve a live provider before it becomes the default.
- **Revisit conditions:** promote to Phase 2 (broker process) if self-write ever runs unsandboxed with
  merge autonomy on; extend the secret-name patterns if a new credential shape appears.

## Alternatives considered

- **Do nothing / rely on convention** (keep ambient `process.env`, trust that no code dumps it).
  Rejected: under notify-after autonomy a self-written env-reader passes the guard, and ③/④ raise the
  stakes past convention — the charter names this mechanism for exactly this moment.
- **A separate broker process from the start** (Phase 2 up front). Rejected as the starting point,
  adopted as the deferred stronger form: it is the only thing that defends against a compromised main
  process, but it is a large IPC/lifecycle build. Phase 1 removes ambient authority — the realistic
  near-term threat — at a fraction of the cost and de-risks the seam; Phase 2 applies process
  isolation once merge autonomy actually turns on.
- **A typed `Config` object threaded everywhere** (dependency-inject all settings, secrets included).
  Rejected as the vehicle: valuable refactor, but far larger than the firewall, and it would spread
  secrets through more call sites, not fewer. The broker deliberately *narrows* who can name a secret;
  the config refactor can happen later without secrets riding it.
- **Extend the self-write guard to statically forbid `process.env` reads.** Rejected as the primary
  mechanism (kept as possible defense-in-depth): a static check is an arms race against obfuscation,
  whereas emptying `process.env` of secrets makes the read return nothing regardless of how it is
  written — structural beats pattern-matching, consistent with [ADR 0001](0001-deterministic-harness-governs-everything.md).
