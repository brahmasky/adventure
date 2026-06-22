# Current System State (read first — 2026-06-22)

- **Branch:** `feat/learning-v1` @ `443bb19`, pushed to origin (brahmasky/adventure). **NOT merged to main.** Houge runs from THIS branch's `dist/`, not main.
- **Daemon:** launchd `com.houge.daemon`, **PID 4137** (restart via `launchctl kickstart -k gui/$(id -u)/com.houge.daemon`). Code change ⇒ `npm run build` + reload. Conversation/lessons/identity/skills survive reloads (`houge.sqlite` + `skills/` + `houge.md`); only in-flight runs lost.
- **Runtime:** model-agnostic chain `pi→kimi` (NEVER Claude). **Codex = build-time muscle** for code self-diagnose only (NOT skill authoring — skills are authored on pi→kimi).
- **`.env` (gitignored):** `HOUGE_CODEX_ENABLED=true`, `HOUGE_CODEX_TIMEOUT_MS=300000`. Skills default ON (`HOUGE_SKILLS_ENABLED`).
- **Live skills present** (gitignored runtime): `skills/research/fact-check-viral-claim.md` + `cross-check-figures-across-sources.md` (both real, authored by Houge over Telegram in the 2b live test).
- **猴哥 classifier bug: UNFIXED ON PURPOSE** — it's the live fixture (intent router prompt lacks identity; bypasses the composer). Phase 3 (gated self-write) is where Houge would fix it himself. Don't fix it ad-hoc.
- **Done so far:** ADR 0010 (conversational front door) LIVE; ADR 0011 (self-evolution); **Phase 1 code self-diagnose DONE+LIVE**; **Phase 2a (load/apply skills) DONE+LIVE** (247b490); **Phase 2b (author skills) DONE+LIVE** (443bb19 — Houge authors his own skills on command, Gate A routes skill/lesson/code, over real Telegram).
- **Next:** **Phase 2c** — Gate B + auto-author/refine. **SPIKE DONE 2026-06-22 → GO (conditional on a 3-pass
  ensemble)** (`scripts/spike-gateb-2c.mjs`; result in spec "Spike RESULT"). Single-pass cheap Gate B too noisy
  (margin swung +0.17/0.00/−0.17); **3-pass averaged static-grade cleanly+stably separates** good 0.28–0.89 vs
  bad ≤0.06 (margin +0.22/+0.28), threshold ~0.15. Settles: D1=static-grade procedure-level independent criteria
  (NO run-and-check/web needed); Gate B = 3-pass ensemble; D4 = auto-author may be BLOCKING-gated on it + report.
  **Next: `/goal` the real 2c build.** Then Phase 3 (gated code self-write).
- **Critical rules:** `/goal` is a REAL user-invoked stop-gate command (don't claim it doesn't exist); every `/goal` ends with a LIVE run (not just `npm test`); **freedom-over-control** — no 紧箍咒/cage framing, OK for Houge to fail, only core principles stay constant (ADR 0001/0011).

---
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

## Build — staged (each green), via subagents — ALL DONE (committed 7bcaa65)
- [x] S1. Worktree harness (`src/run/worktree.ts`) + `coding_agent_cli` adapter (`src/capabilities/coding-agent.ts`) + unit tests (fake `codex` script).
- [x] S2. `selfcode` intent (union + `INTENT_DISCIPLINE` + parser) in `src/capabilities/intent.ts`.
- [x] S3. `executeSelfDiagnose`/`runSelfDiagnose` + `compileSelfDiagnoseContract` (allows `coding_agent_cli`; `turn` forbids it) + dispatch + tests. Policy: blanket-deny on `coding_agent_cli` replaced by allowed/forbidden gating (tests strengthened to 3 cases).
- [x] S4. Config (`HOUGE_CODEX_ENABLED` off by default / `MODEL`/`TIMEOUT_MS` 240s default/`BIN`) + docs.
- [x] S5. **typecheck clean · npm test 358/358 · build OK · deps {}** · independent adversarial verification PASS (9/9 invariants; containment airtight, tests strengthened not gutted).
- [x] S6. **LIVE gate CLOSED:** real Telegram `12:23 "猴哥, go read your own intent classifier… why you keep [asking which 猴哥]"` → classified **selfcode** → worktree of HEAD 7bcaa65 → **real Codex** (`report Sources: coding_agent_cli:codex`) → correct root cause ("intent router never gets identity; classifier bypasses the composer that loads houge.md", cited files, even caught the clarify-cap-only-blocks-repeats detail; referenced `selfcode` ⇒ read the real worktree). Clean worktree teardown (no leaks). Daemon PID 71157 on new code. 猴哥 bug left unfixed (fixture).

**Review — Phase 1 DONE (2026-06-20).** Houge reviewed his own source, located a real bug, and explained the
root cause via real Codex on his subscription — the self-evolution vision's first light (ADR 0011 §7 Phase 1).
Note: test message named "intent classifier" (pointed at the area); fully-autonomous **symptom-only** diagnosis
is an available stronger demo now that `HOUGE_CODEX_TIMEOUT_MS=300000` (5 min) is in `.env` (needs a daemon reload).
**Next:** Phase 2 (skills) — design discussion pending (skill file format + consolidation-pass timing). Phase 3
(code self-write, gated) would let Houge actually FIX this bug himself.

---
# Goal — Phase 2b: skill authoring (on-command) + Gate A + reporting (IN PROGRESS 2026-06-22) — ADR 0011 §2/§4

Spec: `docs/superpowers/specs/2026-06-21-phase2-skills.md`. `/goal` active. Build via subagents.
2b = Houge AUTHORS skills on-command on the **cheap pi→kimi chain** (NO Codex/worktree — prose). Gate A
routes skill/lesson/code; every attempt reports. NO Gate B / NO auto-author (those are 2c); anchors authored now.
**Constraints: zero deps; skills are prose-only; skill-author contract writes ONLY to `skills/`.**

## Build — staged (each green), via subagents — S1–S8 DONE
- [x] S1. `SkillStore.writeSkill(scope,name,body)` (slug-sanitized, HARD containment: real-path-after-mkdir
      re-check rejects escapes/symlinks) + `readSkill` (refine, version++) + tests.
- [x] S2. `SKILL_AUTHOR_DISCIPLINE` + `DISCIPLINES["skill-author"]` (composer.ts) — purely additive; other
      surfaces byte-identical (goldens unchanged).
- [x] S3. `skill` intent: `Intent` union + `INTENT_DISCIPLINE` examples + tolerant parse (doesn't cannibalize
      selfcode/feedback) + tests.
- [x] S4. `src/capabilities/skill-author.ts` — `buildSkillAuthorQuestion`(+refine) + `parseAuthoredSkill`
      (validates via `parseSkillFile`, structured failure, never throws).
- [x] S5. `src/capabilities/skill-router.ts` — Gate A `GATE_A_DISCIPLINE` (4 criteria) + tolerant
      `parseGateAVerdict` (default safe `unsure`).
- [x] S6. `distill` `looksLikeSkillProcedure` — FLAG-only promotion hint in the feedback report (conservative;
      bare tweaks don't trip it).
- [x] S7. `runSkill` route (Gate A → skill authors+writes w/ 1 retry / refine version++ · tweak→lesson ·
      code→flag · unsure→lesson+ask) + gate-stack report + `compileSkillAuthorContract` (allowed `llm_answer`
      +`write_report`; `coding_agent_cli`/shell/writes forbidden) + dispatch + tests. + safeLessonScope slug fix.
- [x] S8. Gates: **typecheck clean · npm test 403/403 · build OK · deps {}** · independent verification PASS
      (8/8 invariants, no real bugs; containment defeated all escape attempts; one nit fixed: down-route scope slug).
- [~] S9. LIVE gate. Harness PASS (`scripts/live-skills-2b.mjs`). **REAL Telegram Leg 1 PASSED** (06-22 01:51:46:
      "写一个…稀缺AI产业链…三只美股的技能" → intent=skill, Gate A 4/4, authored valid skill w/ 4 anchors, 🐒 report).
      **Live test surfaced 2 real issues → FIXED (404 tests, daemon reloaded PID 4137):**
      (1) classifier conflated "研究X"(do research) with "make a skill for X" when topic matched a just-authored
          skill → Leg 2 misclassified skill→refine. Fix: `INTENT_DISCIPLINE` — performing a task (research/
          analyze/find) is research/answer, NOT skill, even if a skill on the topic exists; only explicit
          create/write/improve a PROCEDURE is skill.
      (2) refine didn't bump version (LLM re-emitted v1). Fix: mechanical bump (`withFrontmatterVersion`, old+1)
          + regression test (v1→v2). 404 tests, daemon reloaded PID 4137.
- [x] S9. **LIVE gate CLOSED over REAL Telegram** (fixed daemon, real pi→kimi). 3 behaviors all verified:
      (1) `02:11:56` "write a skill for cross-checking figures" → intent=skill, Gate A 4/4, authored VALID
          `cross-check-figures-across-sources.md` (4 anchors, v1), 🐒 report;
      (2) `02:16:45` "research EV battery energy densities, compare across sources" → intent=**research**
          (classifier fix confirmed — pre-fix this misclassified as skill), cross-check skill folded in
          AMBIENTLY (answer carries per-source caveats + cross-validation);
      (3) `02:18:53` "write a skill that just means keep answers more concise" → Gate A=**LESSON** ("style
          preference, not a procedure") → saved to `ask`, NO skill file. `/skills` viewer proven in harness+tests.

---
# Goal — Phase 2a: skills as loadable artifacts (DONE 2026-06-21) — ADR 0011 §1/§2

Spec: `docs/superpowers/specs/2026-06-21-phase2-skills.md`. `/goal` active. Build via subagents.
2a = LOAD/APPLY/VIEW hand-authored skills only (NO authoring/Codex/gates — those are 2b/2c).
Skills are AMBIENT (implicit by scope + `when:`, never invoked by name); `/skills` is a read-only viewer.
**Constraint: zero deps (`dependencies: {}`) — hand-roll frontmatter parse (flat keys + `- ` list), NO yaml lib.**

## Build — staged (each green), via subagents — S1–S6 DONE
- [x] S1. `src/skills/skill-store.ts` — hand-rolled frontmatter parse (defensive→null, CRLF-normalized),
      read-by-scope (cap ≤4 `HOUGE_SKILL_MAX_PER_SCOPE`), list, regenerate `skills/REGISTRY.md` + unit tests.
- [x] S2. Composer skills layer (`src/prompt/composer.ts`) — `skillsReader`/`skillsScope` like `lessonsReader`;
      "## Skills — apply when relevant" block (each prefixed by `when:`); OMITTED when empty ⇒ byte-identical
      (test asserts strict `.toBe` equality).
- [x] S3. Wired `skillsReader` into all 4 core-worker composer call sites (kill-switch in `skillsReader()`;
      research-critique→`research`, selfcode→`ask`).
- [x] S4. `/skills [scope]` control command (parser + adapter + gateway `handleSkills`) — idempotent like
      `/lessons`, no run/budget, regenerates REGISTRY then lists; "No skills yet" empty state + tests.
- [x] S5. Config (`HOUGE_SKILLS_ENABLED` default ON, `HOUGE_SKILL_MAX_PER_SCOPE` 4) + configuration.md
      + README + `.gitignore` `/skills/` (anchored top-level — does NOT swallow src/skills, tests/skills).
- [x] S6. Gates: **typecheck clean · npm test 375/375 · build OK · deps {}** · independent verification:
      one HIGH blocker found (unanchored `.gitignore skills/` swallowed src+tests) → FIXED + re-verified;
      CRLF nit → fixed + regression test. All 7 safety invariants PASS.
- [x] S7. **LIVE gate CLOSED over REAL Telegram** (daemon PID 83592, real pi→kimi + real Tavily). Paco sent real
      research msgs: `06-21 10:59` SpaceX + `11:05` agent-memory → marker **ABSENT** (no live skill). Then authored
      `skills/research/research-marker-probe.md` on the live daemon (read fresh, NO reload) → `11:12` real research
      msg → marker **PRESENT** verbatim `🔬 SKILL-2A-LIVE ✓ 🔬`, self-applied (ambient, never named). Also: harness
      PASS (`scripts/live-skills-2a.mjs`) earlier confirmed absent/present/`/skills`. Probe skill = live-gate-only.

---
# Phase 2 design — SKILLS (LOCKED 2026-06-21) — ADR 0011 §1/§2/§7

Full spec: `docs/superpowers/specs/2026-06-21-phase2-skills.md`. Design discussion done this session.

**Key framing (corrected by Paco):** a skill is a reusable PROCEDURE for a class of task (a competence),
NOT memory. → its OWN top-level **`skills/`** dir (sibling to `src/capabilities/`), gitignored runtime
state. The three layers map to three homes: lessons→`memory/` (SQLite), skills→`skills/`, code→`src/`.
Persona/core-principles never enter skills, so that question doesn't arise here.

**Locked decisions:**
- **File format:** `skills/<scope>/<name>.md` + frontmatter (name, scope, `when:` trigger hint, `anchors:`
  for Gate B, `version`, `last_verified`, `origin`).
- **Selection:** scope pre-filters cheaply (a research run considers only `skills/research/*`), the `when:`
  lines ride into the main run prompt, Houge self-selects (NO extra LLM call). Cap ≤4 skills/scope (§6).
  Built-in disciplines stay the committed FLOOR (in code); skills are an additive evolvable overlay.
- **Three origins:** (1) on-command NL `skill` intent ("write a skill for X"); (2) auto-promoted from
  distill; (3) refined from a failure (a correction on a surface where a skill applied updates THAT skill).
- **Mutable:** update/refine = re-author from the existing file → report a DIFF + new anchor score; `version`++.
- **Registry:** auto-generated `skills/REGISTRY.md` (generated view; frontmatter is source of truth) +
  `/skills [scope]` control command (idempotent like `/lessons`).
- **Gate stack:** A=qualify (the 4 routing criteria, §2) → B=OPENSKILL anchor verifier (≤3 passes) →
  C=taste (Paco, the ~11%). **Every attempt REPORTS** (Paco wants auto-author + a report): pass/fail per
  gate, what it down-routed to. Fail A → down-route (tweak→lesson, needs-code→code flag). Fail B after 3 →
  down-route to a LESSON (nothing wasted).
- **Auto-author is SAFE here (unlike code):** ADR marks skills "low risk — no compile/merge"; a skill is
  prose, executes no logic, instantly revertible. So skills auto-WRITE (report, not `/approve`); CODE keeps
  the `/approve` merge gate. Authoring muscle = Codex (build-time, like Phase 1), auto-triggered.

**Sub-phasing (each shippable + live-gated):**
- **2a** — format + `skills/` + skill-store + composer-loads-by-scope + `/skills`/REGISTRY. (foundation)
- **2b** — on-command `skill` intent + **pi→kimi authors** (NO Codex/worktree — skills are prose;
  Codex reserved for code layer) under a new `SKILL_AUTHOR_DISCIPLINE` (frontmatter contract, sharp
  `when:`, promptable-only, world-fact-grounded, EMIT anchors now even though Gate B runs in 2c,
  bounded, procedure-not-persona) + Gate A qualify/down-route (tweak→lesson, needs-code→code flag) +
  distill promotion **flag** (flags only; auto-author is 2c) + gate-stack reporting. Quality in 2b =
  writer discipline + Gate A + Paco's taste. "Skills are prose, not plugins" — MCP/scripts/live-API =
  code/capability layer, not skills. (Meta-skill `skills/meta/skill-authoring.md` = future self-evolution.)
- **2c** — Gate B anchor verifier + auto-author/refine loop. **SPIKE-THEN-DECIDE** (design locked 2026-06-22;
  full detail in spec "Phase 2c — design & spike"). Decisions: D1 verify-mode (run-and-check vs static) —
  spike measures both; D2 anchors INDEPENDENT (Gate B generates its own; frontmatter anchors = seed, not the
  test); D3 cheap walled-off pi→kimi session; D4 autonomy ramp DEFERRED to post-spike data; D5/Q5 Gate B scores
  ALL skills — advisory-by-origin (commanded advisory / auto blocking). Trigger: every create/refine; timing
  (inline vs async) falls out of D1 cost; re-verify-on-drift OUT (needs scheduler). **Spike = throwaway
  MEASUREMENT (no /goal, deleted after):** ~5 good + ~5 deliberately-broken skills → does cheap Gate B
  separate them cleanly? GO → /goal the real build; NO-GO → Gate B advisory-only, rethink.

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
- [ ] **`houge.sqlite` backup / durability** (surfaced 2026-06-21) — the live DB is Houge's SINGLE source of
      truth (conversations, lessons, ledger, approvals) and is gitignored/local-only with NO backup; delete it
      and all of Houge's memory is gone. Add cheap insurance: a periodic timestamped copy (cron/launchd) or a
      `litestream`-style continuous replica to local/remote storage. Must NOT leak secrets and must stay
      consistent (SQLite `.backup`/WAL-safe snapshot, not a raw `cp` mid-write). Consider retention + a tested
      restore path. (Low effort, high value — protects everything Houge has learned.)
- [ ] **Skill dedup / name normalization** (surfaced 2026-06-22 in 2b live test) — authoring the SAME
      conceptual skill twice with slightly different wording yields TWO files because the cheap writer derives
      a different kebab `name` each time (`fact-check-viral-claim` vs `viral-claim-fact-check`); the refine path
      only triggers on exact name match. Result: semantically-duplicate skills accumulate in a scope (noisy,
      eats the ≤4 cap). Fix options: a pre-write semantic-dedup check (does an existing skill cover this
      `when:`? → refine instead of create), or canonical-name normalization. Natural fit alongside 2c's
      Gate B / consolidation pass. Not a safety issue (containment holds); a quality/precision nit.
- [ ] **Scheduler / proactive triggers** (surfaced 2026-06-22; ADR 0011's "deferred idle loop") — Houge is
      purely REACTIVE today (every run starts from an inbound Telegram trigger). A scheduler is an orthogonal
      AUTONOMY axis (the *when Houge acts on his own*, distinct from the lessons/skills/code *what he knows*).
      Architecture fits an existing seam: a **new trigger SOURCE** (cron/time adapter) that synthesizes a
      `turn`-like `TypedTaskEvent` on a schedule → same gateway→worker path (`trigger_offsets`/intake already
      generic). NOTE distinction: capabilities (`web_search`) are tools called DURING a run; a scheduler STARTS
      runs. Unlocks e.g. "weekly report" (= a report-writing **skill** + a history-read **capability** + this
      **scheduler**). Carries its own design weight → **own ADR**: proactive messaging (initiative, not just
      reply — outbound `notification_outbox` already exists), safety floor for unprompted/no-human-in-loop runs,
      cost of timer-driven LLM runs (budget breaker bounds it). Deferred; revisit after the skills/code phases.

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
