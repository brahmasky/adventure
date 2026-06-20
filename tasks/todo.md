# Goal — Phase 1: code self-diagnose (read-only, Codex-backed) — ADR 0011

**Active goal (spec: docs/superpowers/specs/2026-06-20-phase1-code-self-diagnose.md; ADR docs/decisions/0011).**
First self-evolution surface: Houge reads his OWN source and explains a bug — read-only, no writes, no gate.
A `selfcode`-intent message → `executeSelfDiagnose`: frame the question (user's report + his memory) → run
**`codex exec --sandbox read-only`** in a fresh **git worktree of HEAD** (tracked files only ⇒ no `.env`/
`auth.json`/DB ⇒ secret-exclusion by construction; isolated from the running daemon) → relay the root cause
in his voice (async ack-then-deliver). Codex = rented, swappable **`coding_agent_cli`** muscle; Houge owns
framing/judgment/relay (thin delegation). Executed via **subagent orchestration** (build + independent
verification, on Claude); live test interactive. **The 猴哥 classifier bug stays unfixed as the live fixture.**
Gate: typecheck + npm test + build + zero deps + LIVE run (Houge diagnoses the 猴哥 bug via REAL Codex).

## Build — staged (each green), via subagents
- [ ] S1. Worktree harness (`src/run/worktree.ts`: create(HEAD)→path / remove) + `coding_agent_cli` adapter
      (`src/capabilities/coding-agent.ts`: shells `codex exec --sandbox read-only -C <wt> -o <file> -`;
      parses `-o` final message; maps exit/auth/timeout → CapabilityResult; `external_read`/medium). + unit tests (mock `codex`).
- [ ] S2. `selfcode` intent: `Intent` union + `INTENT_DISCIPLINE` (def + examples) in `src/capabilities/intent.ts`; parser tests.
- [ ] S3. `executeSelfDiagnose` route + `self-diagnose` contract (`task-contract.ts`: allows `coding_agent_cli`;
      keep it forbidden in the `turn` contract) + `executeTurn` dispatch in `core-worker.ts` + tests.
- [ ] S4. Config (`HOUGE_CODEX_ENABLED/MODEL/TIMEOUT_MS/BIN`) + `docs/reference/configuration.md` + README note.
- [ ] S5. Gates: typecheck clean · npm test green · build OK · `dependencies: {}`. + independent verification pass.
- [ ] S6. **LIVE gate**: real Telegram → "go read your intent classifier and tell me why you asked which 猴哥"
      → Houge returns the real root cause via REAL Codex (rebuild + reload daemon first).

**Risks:** (i) `selfcode` classify reliability on cheap chain → crisp examples, fallback `answer`; (ii) Codex
auth from launchd daemon (`~/.codex/auth.json`; PATH has `/opt/homebrew/bin`) — verify at S6; user-present mitigates.

---
# DONE — ADR 0010 conversational interaction model (committed 25b3568, LIVE-VERIFIED 2026-06-20)
Committed + pushed on feat/learning-v1. **Live gate CLOSED:** #5 `answer → 太长了 → tighter 3-point re-answer →
silent distill → new lesson "Be concise: summarize…3 key points" (`[ask]` updated_at 06-19T14:04→06-20T11:48) →
/lessons` confirmed over real Telegram on pi→kimi (never Claude). Checks 1–4,6 + research previously confirmed.

---
# Goal — Conversational interaction model (ADR 0010), one milestone

**Active goal (plan: ~/.claude/plans/cosmic-weaving-snail.md; ADR docs/decisions/0010).** Drop `/ask`
`/research` `/teach`. Every non-command Telegram message → a `turn` run; worker classifies intent on the
model-agnostic runtime chain (pi→kimi, never Claude) into **answer / research / feedback / clarify** and
acts. Short-term per-chat conversation memory (`chat_turns`) gives context for follow-ups. A correction →
answer-back (tighter re-answer) + silent distill of clear preferences into char-capped per-scope
`lesson_blocks` the composer folds into future runs. `/lessons [scope]` views; `/forget <scope>` clears.
Control plane (`/status /approve /deny /run`) + safety floor unchanged. Executed via **subagent
orchestration** (build agent + independent verification agent, on Claude); live daemon test interactive.
Gate: npm test green + typecheck + build + zero deps + LIVE 6-check run (see goal/plan).

## Build — staged (each green), via subagents

**Stage A — front door + conversation memory (answer/research/clarify; NO feedback yet):**
- [x] A1. `chat_turns` table + migration + `recordChatTurn`/`getRecentChatTurns(chat_id, limit, sinceIso?)`. **Caps (env-configurable):** session window default 60min (`HOUGE_CHAT_CONTEXT_WINDOW_MINUTES`) + count cap default 8 (`HOUGE_CHAT_CONTEXT_TURNS`) + per-turn truncation ~500 chars on feed (`HOUGE_CHAT_CONTEXT_TURN_CHARS`, full text still stored). *(run-store.ts, core-worker.ts, capabilities/intent.ts)*
- [x] A2. `turn` event type + contract (`intent_router` union allowed_actions, budget 6). *(domain/types.ts, task-contract.ts)*
- [x] A3. Parser: remove `/ask`·`/research`; non-command text → `turn` (+reply hint); keep control cmds + `/teach` (removed in B). *(telegram-command-parser.ts, telegram-trigger-adapter.ts)*
- [x] A4. Intent classifier `src/capabilities/intent.ts` (answer/research/clarify; JSON-tolerant).
- [x] A5. `executeTurn` + `executeClaim` `intent_router` dispatch; extract answer/research helpers from executeAsk/executeWebResearch (keep those for CLI/eval); record turns. *(core-worker.ts)*
- [x] A6. Tests + typecheck + build green; update tests referencing /ask·/research commands. **DONE: typecheck clean · npm test 297/297 · build OK · deps {}.**

Stage A: **independently verified PASS** (gates green; 9/9 safety invariants). Carry-forwards → fold into B:
(i) all turn branches share ONE BudgetLedger (runAnswer currently makes its own); (ii) add explicit `"dependencies": {}` to package.json.

**Stage B — learning (feedback intent + lesson blocks; remove /teach):**
- [x] B-carry. ONE shared BudgetLedger threaded through runAnswer/runResearch/distill/answer-back/rewrite; `"dependencies": {}` added to package.json.
- [x] B1. `lesson_blocks` store + migration (`2026-06-19-lesson-blocks`); accessors `readLessonBlock`/`appendLessonToBlock(rewrite)`/`forgetScope`/`listLessonBlocks` on RunStore; composer reads blocks via injected `lessonsReader`; `intentToScope` (answer→ask, research→research). *(run-store.ts, composer.ts, core-worker.ts)*
- [x] B2. `src/capabilities/distill.ts` (buildDistillQuestion/parseDistillResult); `feedback` intent added to classifier; executeTurn feedback branch → distill → silent appendLesson (durable only) → answer-back composed after save. Reply-hint + chat-thread target resolution; `getRunIdByProviderMessageId`/`getAssistantChatTurnForRun`.
- [x] B3. `/lessons [scope]` + `/forget <scope>` control commands (idempotent like /status, no run/budget). *(parser, trigger-adapter, gateway.ts)*
- [x] B4. Removed `/teach` (parser/trigger-adapter/gateway handleTeach/`taught`/`teach` type/`lesson?` field); deleted file-based lesson-store.ts + its test.
- [x] B5. README + docs/reference/configuration.md updated for ADR 0010; tests for lesson_blocks append+cap→rewrite+forget, distill threshold, composer-reads-blocks, feedback branch (durable saves / one-off doesn't / no toast / no-target fallback), /lessons render + /forget clear + idempotency, /teach removed.

Stage B: **typecheck clean · npm test 314/314 · build OK · deps {} · eval m0/m1/m2 green.**
Stage B: **independently verified PASS** (10/10 invariants; gates green). One should-fix → hardening:
- [x] B6. Deterministic lesson-poisoning backstop (`shouldRejectLesson`: rejects a lesson lifted verbatim from the untrusted prior answer but absent from the user's feedback; per-lesson 240-char cap) + adversarial test. Verified PASS.

**Live (real Telegram, daemon):** in progress — confirmed live: plain→answer, follow-up uses thread,
vague→clarify, feedback recognized, research→sourced (post max_tokens fix), **2 real lessons learned &
scoped** (`ask`: don't say 师父; `research`: verify date) → checks 1–4,6 + research(#2) ✅; #5's full
`too long`→tighter→/lessons→persist sequence not yet run on Telegram (mechanism proven in harness).
- [x] LIVE-FIX-1. Research synthesis failed (Chinese query): pi blew its 256KB cap (coding model over-produces)
  + kimi empty content (`max_tokens:1024` too small). Fix: kimi `max_tokens`→4096, env `HOUGE_KIMI_MAX_TOKENS`.
- [x] LIVE-FIX-2. Three issues from live chat, built + independently verified PASS, daemon reloaded (PID 53080):
  (1) **current date** injected into all cognitive prompts (was answering as 2025 — `src/prompt/temporal.ts`);
  (2) **clarify-loop cap** (≥1 trailing clarify → force answer; `HOUGE_MAX_CONSECUTIVE_CLARIFY`);
  (3) **markdown→Telegram-HTML** (`parse_mode:HTML` + plain-text fallback; injection-escaped; sentinel-strip). 337/337 green.

## Next session — backlog (user-requested 2026-06-19)
- [ ] **Code-read capability** — scoped `read my repo` (source only; exclude `.env`/secrets to prevent exfil).
      Free read tier; prerequisite for write. (see [[houge-model-agnostic-cheap]] philosophy; ADR 0001 floor)
- [ ] **Code-write capability (gated)** — reuse the existing approval gate (`local_project_write` + policy
      `requires_approval` + `/approve`·`/deny` + `reconcileApprovedAction` hash-recheck). New work: edit/diff
      generation, **diff preview** in the approval prompt, writable-path scoping, and **protected paths**
      off-limits even with approval (safety floor, policy, `memory/core` constitution, secrets — ADR 0007 §8).
- [ ] **LLM telemetry** — add an `llm_answered` ledger event (provider, model, tokens, latency, cost); the
      ledger has the shape. Optional OTel export. Today provider/model is only a text line in `report.md`.
- [ ] **LLM-for-research model fit** — runtime chain is coding-tuned (`pi=kimi-for-coding`,
      `kimi-k2.7-code-highspeed`); pi over-produces on research synthesis. Add a general model for the
      research/answer surface (the chain is already pluggable). Also: still confirm #5's full Telegram sequence.
- [ ] **Market-data capability** (surfaced live 2026-06-19) — real-time quotes, technical indicators
      (MACD, K-line), fundamentals for tickers (e.g. LLY). `web_search` finds articles but can't fetch a
      live price or compute an indicator; Houge correctly declines today. New `market_data` `external_read`
      capability, pluggable like the Tavily web chain (Alpha Vantage / Finnhub / Polygon-style). Same
      "free read" tier as web_search. Part of a broader **structured-data connector** family.
- [ ] **Telegram-formatting discipline** — Telegram can't render tables; add a discipline so Houge defaults
      to aligned plain-text / lists for tabular data (proactive vs. learned). (Houge already learned "avoid
      tables" as a lesson — this makes it a default.)

## Review

**Build: DONE & audited.** typecheck clean · `npm test` 322/322 · `npm run build` OK · `dependencies: {}`.
Two independent verification passes (Stage A: 9/9 invariants; Stage B: 10/10 incl. lesson-poisoning wall)
+ a deterministic poisoning backstop (B6) with adversarial test. Executed via subagent orchestration on Claude.

**Live (real models, harness `scripts/live-conversational.mjs`):** drove the REAL turn path on pi→kimi +
real Tavily, in-memory DB. All 7 checks passed: 1 answer · 2 follow-up used thread (Paris) · 3 research+sources ·
4 feedback→tighter re-answer · 5 /lessons shows "Be concise in research summaries" (clean, not poisoned) ·
6 fresh research 1467ch < 1784ch (lesson persisted across runs) · 7 clarify. Report source lines `llm:kimi-api:*`/
`llm:pi:*`, never Claude. Classifier reliable on the cheap model (all 7 intents correct).

**PENDING (blocked on user — interactive, agent cannot send Telegram):** the literal gate's "LIVE run through
the launchd daemon over real Telegram" — daemon is rebuilt + reloaded (PID 48463, healthy). User sends the
7-message sequence (todo "Live") to close the gate, OR accepts the harness as the live evidence.

---
# PRIOR GOAL (history) — Learning v1 (prompt composer + /teach + STORM self-critique)
NOTE: v2 above SUPERSEDES the /teach command + file-based lessons from v1. KEPT from v1: the composer,
disciplines (ask/research/research-critique), STORM self-critique, gitignore, houge.md identity.

**v1 /goal (done, but capture+storage now being replaced):** composer assembles every system prompt
(houge.md + discipline + learned lessons + guardrails); /ask + /research use it; `/teach <scope>: <lesson>`
→ memory/skills/<scope>.md → composer folds into next run; STORM self-critique on web-research.

## Design (per docs/superpowers/specs/2026-06-19-learning-mechanism-v1.md)

- composer reads memoryRoot = <projectRoot>/memory: core/houge.md (identity, fallback if
  absent) + DISCIPLINES[surface] + skills/<surface>.md (lessons, "" if absent) + guardrails.
- Persona moves OUT of the constants INTO houge.md (loaded once); constants → disciplines (task only).
- /teach: parser → {type:"teach", scope, lesson} (teach already in TaskEventType; lesson field exists)
  → gateway handleTeach → lessonStore.append + "Learned ✓" notification.
- self-critique: executeWebResearch adds a 3rd llm call (grade+revise) using compose("research") +
  critique framing. Budget max_tool_calls already 4.

## Build steps (each green)

- [x] 1. src/prompt/composer.ts — composeSystemPrompt(memoryRoot, surface); ASK_DISCIPLINE +
      RESEARCH_DISCIPLINE (persona-stripped); FALLBACK_IDENTITY. + tests.
- [x] 2. src/memory/lesson-store.ts — append(scope, lesson, now) / read(scope) over
      memory/skills/<scope>.md (mkdir/create). + tests.
- [x] 3. Wire composer into /ask (llm-answer/executeAsk pass composed system) + /research
      (executeWebResearch uses compose("research"); buildResearchQuestion returns the question).
      Updated llm-answer/web-search/core-worker-web-research tests. Persona only in houge.md now.
- [x] 4. /teach: parser + TelegramCommand variant + buildTelegramEvent + gateway handleTeach
      (lessonStore + "Learned ✓" notification, idempotent). + parser + gateway tests.
- [x] 5. STORM self-critique pass in executeWebResearch (compose("research-critique") grade+revise) + test.
- [x] 6. .gitignore: memory/skills/ memory/user/ memory/wiki/ memory/journal/ (NOT memory/core).
- [x] 7. Docs: /teach + composer + self-critique in configuration.md + README (Learning section).
- [x] 8. typecheck clean, test green (272), build OK, zero deps (dependencies: {}).
- [x] 9. LIVE: /research → /teach research: <marker lesson> → /research applied it (marker absent
      before, present after) through real pi/kimi LLM + real Tavily; memory/skills/research.md shown.

## Review

**Learning v1 — DONE & live-verified (2026-06-19).**

What shipped:
- **Prompt composer** (`src/prompt/composer.ts`, ADR 0009): every LLM surface builds its
  system prompt from Core Identity (`memory/core/houge.md`, loaded not duplicated) +
  per-surface discipline + learned lessons (`memory/skills/<scope>.md`) + guardrails.
  `/ask` and `/research` both source from it — no more hardcoded persona constants.
- **Lesson store** (`src/memory/lesson-store.ts`): inspectable per-scope markdown;
  `appendLesson` / `readLessons`, filesystem-safe scope.
- **`/teach <scope>: <lesson>`**: parser variant → `teach` TypedTaskEvent (scope on
  `program`, text on `lesson`) → `Gateway.handleTeach` (control command, no run/budget,
  idempotent on the trigger key) appends the lesson + acks `Learned ✓`. High-trust /
  low-ceremony: activates immediately, composer folds it into the next matching run.
- **STORM self-critique** (ADR 0006 amendment): after web-research synthesis a second
  `llm_answer` pass (`research-critique` discipline, reusing `research` lessons) grades
  figures/weakest-claims/source-bias and returns a corrected answer; best-effort
  (keeps the draft if it fails). web-research = web_search + synth + critique = 3 calls
  (contract cap 4).
- **gitignore**: `memory/{skills,user,wiki,journal}/` are runtime state; `memory/core` committed.

Gate evidence: typecheck clean · `npm test` 272/272 · `npm run build` OK · `dependencies: {}`.
Live (`scripts/live-learning-v1.mjs`, real Gateway+CoreWorker+pi/kimi+Tavily): the
`🐒 Houge-confidence:` trailer taught via `/teach research:` was **absent** in the
pre-teach `/research` and **present** in the post-teach one. Telegram transport leg was
event-equivalent (harness can't type into Telegram); every other leg was live.

---
# Prior goals done: breaker (G1), daemon (G2), web read (G4), 猴哥 identity. ADRs 0001–0009 + v1 spec on main.
