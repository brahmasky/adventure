# Phase 1 spec — code self-diagnose (read-only, Codex-backed)

**ADR:** [0011](../../decisions/0011-self-evolution-architecture.md) §7. **Date:** 2026-06-20.
**Scope:** the first self-evolution surface — Houge reads his own source and explains a bug.
**Read-only. No writes anywhere. No approval gate needed.**

## Goal

On a natural-language Telegram message like *"you asked me which 猴哥 — go read your intent
classifier and tell me why,"* Houge: classifies the message as `selfcode`, frames the question
with his own context, consults **Codex read-only in a fresh git worktree**, and relays the root
cause in his voice. This closes the live demo and builds the worktree + `coding_agent_cli`
foundation that Phase 3 (code self-write) reuses.

## Architecture (thin delegation — ADR 0011 §4)

```
Telegram msg ──▶ classify intent ──▶ [selfcode] ──▶ executeSelfDiagnose
  1. Frame the question: user's report + relevant lessons/memory + "you are diagnosing
     Houge's OWN source; symptom = X"            (the untrusted DATA channel, ADR 0006)
  2. git worktree add <tmp> HEAD   → tracked source only: no .env / auth.json / *.sqlite
  3. codex exec --sandbox read-only -C <tmp> -o <out> -   < framed-question   (budget + timeout)
  4. Capture diagnosis → ack-then-deliver over Telegram (async; Codex takes minutes)
  5. git worktree remove <tmp>
```

**Why a worktree:** a fresh worktree of HEAD contains only tracked files — so gitignored secrets
(`.env`, `~/.codex/auth.json`, `houge.sqlite`) are absent **by construction** (no deny-list to
maintain), it's isolated from the running daemon, and it's a real git repo (Codex requires one;
the spike needed `--skip-git-repo-check` only because the temp copy had no `.git`).

## New code (file pointers from the machinery map)

| Piece | Where | Notes |
|---|---|---|
| `coding_agent_cli` adapter | `src/capabilities/coding-agent.ts` (new) | shells `codex exec --sandbox read-only -C <wt> -o <file> -` with framed prompt on stdin; parses the `-o` final message; maps non-zero exit / auth failure / timeout to a clean `CapabilityResult`. `side_effect_level: "external_read"` (sends source to OpenAI, reads only), `risk_level: "medium"`, `timeout_ms` generous (Codex is slow), `output_limit_bytes` capped. |
| Worktree harness | `src/run/worktree.ts` (new) | `create(HEAD) → path`, `remove(path)`; temp dir under the OS tmp; idempotent teardown. Reused by Phase 3. |
| `selfcode` intent | `src/capabilities/intent.ts` | add to `Intent` union + `INTENT_DISCIPLINE` (定义 + examples: "read your code", "why did you do X internally", "look at your <file>"); tolerant parse already handles unknown → `answer` fallback. |
| `executeSelfDiagnose` route | `src/core/core-worker.ts` | dispatched from `executeTurn` on `intent==="selfcode"`; frames question, drives worktree + `coding_agent_cli`, relays; records the turn. |
| `self-diagnose` contract | `src/contracts/task-contract.ts` | `allowed_actions: ["coding_agent_cli","llm_answer","write_report"]`; `forbidden_actions` keeps writes/destructive/paid; `coding_agent_cli` stays forbidden in the normal `turn` contract (gated to this route only); budget: 1–2 tool calls, long time ceiling. |
| Config | `docs/reference/configuration.md` | `HOUGE_CODEX_ENABLED`, `HOUGE_CODEX_MODEL`, `HOUGE_CODEX_TIMEOUT_MS`, `HOUGE_CODEX_BIN` (default `codex`). |

## Containment

- `codex exec --sandbox read-only` (Codex's own sandbox — inner wall); **never** any
  `--dangerously-bypass-*` flag.
- Worktree of HEAD → no secrets, no live DB, isolated from the daemon.
- `coding_agent_cli` is in the `turn` contract's `forbidden_actions`; only the `self-diagnose`
  contract allows it. Budget breaker + timeout + output cap apply.
- One outward flow named explicitly: **Houge's source code goes to OpenAI** (inherent to Codex;
  Paco's own code on Paco's subscription). `external_read`, not a write — no `/approve` needed.

## UX (async, daemon-native)

Codex takes minutes. Houge sends a quick ack (*"Let me read my own code…"*), runs the diagnosis
as a normal async `turn` run, then delivers the result — the daemon already runs turns async.

## Out of scope (→ Phase 3)

Any writing/editing, diff generation, the `/approve` write-gate, the test/typecheck/build eval,
mutation testing. Phase 1 reads and explains; it never changes a file.

## Build stages (each green; via build + independent-verification subagents)

- [ ] S1. Worktree harness (`worktree.ts`) + `coding-agent.ts` capability (read-only codex exec)
      + unit tests (mock the `codex` binary; assert flags, sandbox, timeout, error mapping).
- [ ] S2. `selfcode` intent: `Intent` union + discipline + examples + parser tests.
- [ ] S3. `executeSelfDiagnose` route + `self-diagnose` contract + `executeTurn` dispatch + tests
      (framing, worktree lifecycle, relay, turn recorded).
- [ ] S4. Config + `docs/reference/configuration.md` + README "Self-evolution" note.
- [ ] S5. Gates: typecheck clean · `npm test` green · `npm run build` OK · `dependencies: {}`.
- [ ] S6. **LIVE gate** (per the stop-gate rule): real Telegram → *"go read your intent classifier
      and tell me why you asked which 猴哥"* → Houge returns the real root cause (router prompt
      never receives his identity) via **real Codex**, not Claude.

## Risks / unknowns

1. **`selfcode` classification reliability** on the cheap chain — mitigate with crisp examples;
   safe fallback is `answer`. (Decided: natural-language intent, no command — ADR 0010.)
2. **Codex headless auth from the launchd daemon** (`auth.json` subscription token — the
   interactively-authenticated caveat). Spike auth in the daemon's environment early; Paco-present
   flows mitigate (he can re-auth). True headless only matters for the deferred idle loop.
3. **Prerequisite:** the worktree diagnoses **committed HEAD**, so the current ADR-0010 build (where
   `intent.ts` lives, still untracked) must be **committed first** for Houge to see the 猴哥 bug —
   correct behavior (Houge diagnoses his shipped self, not uncommitted WIP), but a real ordering
   dependency. The ADR-0010 build's own live gate is already pending.
4. **Codex latency** vs Telegram UX → handled by ack-then-deliver async.

## Verification

Build + independent-verification subagents on Claude (keep main context clean); the LIVE gate (S6)
stays interactive — Paco drives the Telegram message, agent observes the run-store + relay.
