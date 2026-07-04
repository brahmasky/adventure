# Current System State (read first — 2026-06-26)

- **Branch:** **`main` @ `3c85328`** (brahmasky/adventure). Phases **1, 2a/b/c, 3, 3.1, 3.3, 3.4, 3.5 all
  SHIPPED to main.** `3c85328` = **Houge's own self-write** (the 猴哥 fix, merged via the 3.3 [Merge & reload]
  button 2026-06-26 — the FIRST fully-autonomous self-write landed via the complete loop). Branch model =
  **daemon runs from main**; develop on feature branches, merge back via [Merge & reload] or manual git.
- **Daemon:** launchd `com.houge.daemon` — **LIVE on main `3c85328`, PID 33935** (SELF-RESTARTED 2026-06-26
  after Houge's [Merge & reload]; Phase 3.4 4-leg chain + Phase 3.5 kimi reviewer; **SELF-WRITE ARMED:
  Writer=Codex(gpt-5.5 high) / Reviewer=kimi(no-tools agent, confined)**, push off; writer EXECUTION-FREE).
  Reload: `npm run build && launchctl kickstart -k gui/$(id -u)/com.houge.daemon`.
  Conversation/lessons/identity/skills survive reloads (`houge.sqlite` + `skills/` + `memory/core/houge.md`);
  only in-flight runs lost.
- **Self-write is ARMED + PROVEN LIVE (2026-06-26)** — `.env`: `HOUGE_SELFWRITE_ENABLED=true`, `HOUGE_CLAUDE_BIN`,
  `HOUGE_CODEX_BIN`, `HOUGE_KIMI_CLI_BIN`, `HOUGE_SELFWRITE_WRITER=codex`, `HOUGE_SELFWRITE_REVIEWER=kimi`,
  `HOUGE_SELFWRITE_PUSH=false`. ✅ **The full loop ran end-to-end over Telegram** (`run_f93782e2`): Codex wrote
  the 猴哥 fix in ONE clean pass → test-gate PASS → kimi PASS (`{verdict:pass,fixes_task:true}`) → branch →
  Paco [Merge & reload] → merged `3c85328` → daemon self-restarted. Codex chose a minimal INTENT_DISCIPLINE
  prompt-patch (clarify 猴哥/you/this-agent = same agent), not the identity-injection — kimi judged it sound.

⚠ **NEXT UP (pending, not lost):**
  1. ✅ **Live runtime bug (2026-06-26) — FIXED by Phase 3.4** (section below; code+docs+live evidence done,
     `/goal` met bar one literal Telegram round-trip). Chain is now `pi,agy-cli,kimi-api,gemini-api` — when the
     coding leg over-produces, a general Gemini-Flash leg (agy CLI / Gemini API) catches the synthesis; and a
     full-chain failure now ALWAYS replies (no more silent fail). Both old backlog items (LLM-for-research
     model fit · Silent turn failures) RESOLVED. NOT committed yet — branch/commit at Paco's call.
  2. **Phase 3.2** — provider rate-limit/quota surfacing + per-run cost (DESIGN DONE, /goal drafted; see the
     "Phase 3.2" section below + spec).

- **猴哥 fix branches** `houge/selfwrite/run_48db7150` (codex) + `run_4c0f99f0` (claude) are UNMERGED +
  STALE (cut before 3.1 changed intent.ts/composer.ts/core-worker.ts → would conflict). Don't merge them;
  re-fix 猴哥 via a fresh self-write off current main (now possible via the 3.3 [Merge & reload] button).
  `git branch -D` them (+ `feat/merge-controls`, == main) when convenient.
- **Runtime:** model-agnostic chain `pi→kimi` (NEVER Claude). **Codex = build-time muscle** for code self-diagnose only (NOT skill authoring — skills are authored on pi→kimi).
- **`.env` (gitignored):** `HOUGE_CODEX_ENABLED=true`, `HOUGE_CODEX_TIMEOUT_MS=300000`. Skills default ON (`HOUGE_SKILLS_ENABLED`).
- **Live skills present** (gitignored runtime): `skills/research/fact-check-viral-claim.md` + `cross-check-figures-across-sources.md` (both real, authored by Houge over Telegram in the 2b live test).
- **猴哥 classifier bug: ✅ FIXED BY HOUGE HIMSELF (2026-06-26, `3c85328`)** — the long-standing live fixture is
  RETIRED. Houge self-wrote the fix over Telegram (Codex writer + kimi reviewer, merged via [Merge & reload]):
  patched `INTENT_DISCIPLINE` so the classifier knows 猴哥/you/this-agent are the same agent. ⚠ Behavioral
  follow-up: verify live that he no longer asks "which 猴哥"; if the deeper root cause (intent prompt bypasses
  the composer) still bites, a follow-up self-write can route identity through the composer.
- **Done so far:** ADR 0010 (conversational front door) LIVE; ADR 0011 (self-evolution); **Phase 1 code self-diagnose DONE+LIVE**; **Phase 2a (load/apply skills) DONE+LIVE** (247b490); **Phase 2b (author skills) DONE+LIVE** (443bb19 — Houge authors his own skills on command, Gate A routes skill/lesson/code, over real Telegram).
- **Next:** **Phase 2c** — Gate B + auto-author/refine. **SPIKE DONE 2026-06-22 → GO (conditional on a 3-pass
  ensemble)** (`scripts/spike-gateb-2c.mjs`; result in spec "Spike RESULT"). Single-pass cheap Gate B too noisy
  (margin swung +0.17/0.00/−0.17); **3-pass averaged static-grade cleanly+stably separates** good 0.28–0.89 vs
  bad ≤0.06 (margin +0.22/+0.28), threshold ~0.15. Settles: D1=static-grade procedure-level independent criteria
  (NO run-and-check/web needed); Gate B = 3-pass ensemble; D4 = auto-author may be BLOCKING-gated on it + report.
  **Next: `/goal` the real 2c build.** Then Phase 3 (gated code self-write).
- **Critical rules:** `/goal` is a REAL user-invoked stop-gate command (don't claim it doesn't exist); every `/goal` ends with a LIVE run (not just `npm test`); **freedom-over-control** — no 紧箍咒/cage framing, OK for Houge to fail, only core principles stay constant (ADR 0001/0011).

---
# Houge STRATEGIC DIRECTION — LOCKED 2026-06-26 (spine spec PENDING Paco's papers, 2026-06-27)

Defined with Paco this session (4 strategic forks + model economics). Top-level charter; the Phases
below are implementations of it. **UPDATE 2026-06-27: the papers discussion HAPPENED — 5 papers read,
spine Decisions 1–4 LOCKED + a sequenced roadmap drafted (see "Houge SPINE — design decisions" section
below). UPDATE 2026-07-02: ADR 0013 (LLM inner composition) LOCKED — the spine roadmap gains a step ⓪
(the inner loop); see "Houge INNER-LOOP REFACTOR" section below. NEXT: /goal inner-loop step ⓪·1 when
Paco's ready.**

**Thesis:** Houge = autonomous self-evolving agent (NOT a chatbot). Improves himself without asking
permission; safety NETS (not human approval) protect the two hard lines.

**Forks decided (Paco):**
1. **Autonomy = FULL autonomy + safety nets** (notify-after, NOT approve-before). REVERSES the
   approve-before [Merge & reload] model.
2. **First build = the SELF-EVOLUTION SPINE** (before any task capability).
3. **Real money / trading / fund custody = DEFERRED** until the spine proves stable autonomy.
   Free/non-financial tasks (weather/cycling, producing work) stay IN as TESTS of the spine.
4. **Models = BEST MODEL PER CAPABILITY** (outcome-first). REVERSES "never Claude at runtime."

**Two hard safety lines (Paco's ONLY constraints):** (a) no adverse impact to Houge's OWN operation;
(b) no leaking secrets. Under full autonomy these FORCE a mechanical safety-net floor — all REQUIRED
scope, gate everything above:
  - **Auto-rollback** — every self-write health-checked post-reload; revert to last-known-good on
    failure/regression (the ONLY way (a) survives unsupervised self-modification).
  - **Kill-switch.**
  - **Secrets firewall** — Houge's main process CANNOT read `.env`/keys; creds brokered only into the
    narrow capabilities that need them (the web_search-API-key pattern, generalized) → honors (b)
    structurally, not by trust.
  - **Self-regression eval** — prove each self-change net-positive or roll back ("improve without
    supervision" requires "measure without supervision").
  - **Metered-API $ ceiling + auto-throttle** (see model economics).

**Model routing — flat-rate CLIs FIRST, metered APIs = capped fallback** (Paco's subs: Claude Max
$100/mo · Codex Plus $20 · Gemini Pro+API · Kimi allegretto+API):
  - Volume (chat/classify/route): **Kimi via `pi` CLI** (flat).
  - Research/synthesis/prose: **Gemini via `agy` CLI** (flat; already wired Phase 3.4).
  - HARD reasoning/strategy/self-fix relay: **Claude via `claude` CLI (Max — FLAT, zero marginal
    cost)** — this is what unlocks "best model" WITHOUT cost. ⚠ CAVEAT: shares the Max rate-limit
    quota with Paco's own interactive Claude Code → Houge must back off + YIELD to interactive use,
    fall DOWN-tier (→Gemini/Kimi) when Max saturated, never stall.
  - Code self-write muscle: **Codex via `codex` CLI** (Plus, flat).
  - Fallback ONLY: `kimi-api` / `gemini-api` (metered) = the ONLY runaway-cost surface → hard ceiling.
  - Memory spine needs an **EMBEDDINGS model** (new dep) → default **LOCAL embeddings** (zero cost,
    no network); revisit only if quality demands. [PARKED sub-fork for spine spec.]

**Spine = a CLOSED EVOLUTION LOOP, not memory-as-king (refined this session):**
  `sense signal → remember → change → EVALUATE → keep/rollback → consolidate`.
  Memory is the keystone (most things depend on it) but the **EVAL loop is the engine** (gives
  direction; without it, autonomy drifts/degrades — a confident random walk). Evidence: Houge already
  self-writes + authors skills (Ph 2–3) yet doesn't COMPOUND (re-fixed 猴哥, stale branches, re-explains
  himself) = a **loop-not-closing** problem, not a DB-size one.
  → BUILD a **THIN VERTICAL SLICE of the whole loop first** (minimal memory + real eval + ONE learning
  path, end-to-end); let the loop reveal the memory shape. Do NOT over-spec a maximal memory arch up front.

**Open question for tomorrow:** Paco's feedback-signal quality — an unsupervised agent improves only as
fast as its signal about how it's doing; today that signal is mostly "Paco reacting on Telegram."

---
# Houge SPINE — design decisions (LOCKED 2026-06-27; ADR + spec written, awaiting /goal per step)

**Written up:** [ADR 0012](../docs/decisions/0012-self-evolution-spine-closed-loop.md) (the closed-loop
reframe + D1–D4) + [spine spec](../docs/superpowers/specs/2026-06-27-spine-self-evolution-loop.md)
(buildable roadmap ①–⑤, build stages + live gate per step). The summary below mirrors them.

Papers read in full (briefs in session): MOSS (2605.22794, source-level self-rewrite, OpenClaw twin),
Strategy Genes (2604.15097, compact control objects + AVOID), AtomMem (2606.19847, atomic-fact memory),
DCPM (2606.09483, Tencent, dual-process memory + supersedes chains), AI-Meets-Brain survey (2512.23343).
**Convergent finding:** 3/5 are SOTA memory systems with NO eval loop → they confirm "memory=keystone,
eval=engine" by omission; the 2 that DO close the loop (MOSS, Genes) both rely on an EXECUTABLE VERIFIER.
Houge's gated self-write is already further along the eval axis than any memory paper.

**Key reframe (Paco, 2026-06-27):** learning-knowledge ≠ getting-feedback. Internet = LIBRARY (knowledge in),
eval loop = REPORT CARD (self-knowledge). The internet can teach Houge facts/skills but NEVER which of his
own changes are net-positive — that's the spine's un-outsourceable job. So eval loop stays first cut.

## DECISION 1 — eval signal — LOCKED
- **Primary = explicit, Houge-initiated rating** (Anthropic "how's this session, 0–3?" model) + optional
  one-line comment. Asked at session boundary (lull + substance) AND after high-stakes events (self-write
  merged / new skill first applied / research delivered). **Rate-limited** so it never fatigues.
- Sparse-but-explicit beats dense-but-ambiguous (silence = weak/neutral, NOT positive).
- **Attribution:** each rating attaches to the artifacts LIVE that session → requires per-turn
  "what-was-applied" logging (the key cheap enabler). Low rating → a BOUNDED LLM attribution pass over the
  transcript guesses what went wrong (approved). Low + comment → reconcile-on-write a superseding lesson.
- **Single rating = weak evidence; a PATTERN across sessions promotes/demotes** (MOSS batch discipline).
- Secondary = **reuse-as-value** (free counter: applied-and-not-corrected → weight++). NO standalone
  self-judgment (reject LLM-as-judge as the signal). Autonomous signals (cross-source verify, prediction-
  error) come later via the knowledge/wiki domain (see D3).

## DECISION 2 — unit(s) of memory — LOCKED (4 types for v1)
1. **Lessons** (`lesson_blocks`, exists) — preferences/behavior. 2. **Skills** (`skills/`, exists) —
   procedures. Both get **+eval metadata** (applied_count, rating_history, reuse_value, supersedes ptr)
   and **+an explicit AVOID field** (Genes' highest-ROI element; the natural output of the eval loop).
3. **LLM Wiki** (NEW, `knowledge/<topic>.md`) — durable, SYNTHESIZED, per-topic knowledge (Karpathy's
   "LLM Wiki"); the "consolidate EXTERNAL knowledge" type. Built from the internet → needs Phase 3.6.
   Maps to survey episodic→semantic promotion + DCPM supersede-on-update (stays current w/o losing history).
4. **Conversational-episodic memory** (NEW, IN v1 per Paco) — long-term memory of what Paco & Houge
   discussed, so he stops re-explaining/re-asking. Mechanism = AtomMem + DCPM dual-process:
   - FAST (per session): extract atomic facts/identity (pronoun-resolved, time-grounded), reconcile
     ADD/SUPERSEDE/UPDATE, store only the novel residual — NOT raw transcripts.
   - SLOW (daily/idle): consolidate the day's facts, promote recurring → durable patterns, merge dups.
   - KEEP-SCORE = salience + recurrence + reuse + explicit signal; **FORGETTING** = raw dropped after
     distillation, distilled facts DECAY if unused + prune below threshold (papers weak here; survey
     Ebbinghaus covers it — Houge must add it; DCPM/AtomMem are append-only & grow unbounded).
   - **Prompt-only extraction** (no fine-tuning; AtomMem-Flat captured most of the gain).
   - Houge's edge: WRAP distillation in the eval loop (papers do it on blind faith; DCPM admits it
     "over-fires") — a distilled memory that proves wrong/unused decays or is superseded.
- DEFER (not v1): DCPM nightly pattern-induction GRAPH + cross-domain collision (single-digit ablation
  gains); AtomMem PageRank graph. Add only when the loop shows recall is the bottleneck.

## DECISION 3 — the thin vertical slice — LOCKED (sequenced A→B, not either/or)
Reconciles "4 memory types in v1" w/ "thin slice = ONE path": the slice builds the **shared loop machinery
ONCE** (rating + attribution logging + reconcile-on-write/supersede + reuse-value + decay), proves it on ONE
memory type, then the other types PLUG IN cheaply. Paco chose to build BOTH slices, sequenced — A de-risks
the engine (no confounds), then the SAME engine is carried to B (the vision). See roadmap below.

## DECISION 4 — keep/rollback — LOCKED
- TWO flavors: (1) **memory rollback** = the supersede chain (revert to prior version) — cheap, already in
  D2, basically free. (2) **code/behavior rollback** = the real piece (MOSS), protects hard safety line (a)
  "no adverse impact to Houge's own operation."
- Today: test-gate (pre-restart) + Phase-3.3 post-merge-red→auto-revert-no-restart. **GAP:** test-gate proves
  compiles+passes, NOT that the daemon comes up healthy LIVE on the new code.
- **ADD: post-restart LIVE health-probe + auto-rollback to last-known-good** (MOSS recipe: short window,
  sample heartbeat/process-alive/responds-to-probe, N consecutive passes to commit else revert; rollback
  target read from an INDEPENDENT last-known-good = the pre-merge git commit; rebuild+restart; notify Paco).
- **Scope v1 (LOCKED):** HARD failures only (liveness/crash/won't-boot/crash-loop). SOFT regressions
  ("boots but answers worse") ride the SLOW eval loop (ratings over sessions → supersede/revert). Don't
  expect the fast net to catch quality regressions.
- **When (LOCKED):** auto-rollback is the NET THAT UNLOCKS full autonomy (fork #1 notify-after). Keep merge
  HUMAN-TAPPED ([Merge & reload]) until auto-rollback ships; slot it right BEFORE flipping merge→autonomous,
  which lines up w/ the internet steps (③/④) where stakes rise.
- Caveat: code rollback is clean only w/o irreversible state change (DB migrations don't revert with code) —
  keep migrations OUT of autonomous scope for now (guard already protects some).

## SPINE ROADMAP — sequenced (each step shippable + LIVE-gated on its own; awaiting /goal per step)
**RE-SEQUENCED 2026-07-02 (ADR 0013): step ⓪ = the INNER LOOP precedes everything below** — A1
   attribution rides the loop's observation hook; ④ wiki lands loop-native. See the INNER-LOOP
   REFACTOR section below + [inner-loop spec](../docs/superpowers/specs/2026-07-02-inner-loop-refactor.md).
**① Slice A — loop machinery, proven on lessons** (NO new capability). Build the shared engine: per-turn
   attribution logging (which lessons/skills applied) · 0–3 rating prompt (session-boundary + high-stakes,
   rate-limited) · reconcile-on-write ADD/SUPERSEDE/UPDATE (stop appending) · reuse-value + decay ·
   low-rating bounded attribution pass · AVOID field on lessons. PROOF = a process-leak/猴哥-type correction
   sticks, gets reused, and a REPEAT correction supersedes instead of re-learning (= visible compounding).
**② Conversational-episodic memory** (NO new capability; reuses ①). Fast path = distill each session into
   atomic facts (reconcile/supersede); slow path = daily consolidation + decay. WIN = stops re-explaining.
**③ Phase 3.6 — http_fetch** (the internet capability; already spec'd H1–H7). Hard prereq for ④.
**④ Slice B — LLM Wiki** (reuses ① + adds autonomous signal). knowledge/<topic>.md synthesized pages via
   http_fetch · cross-source verification = the autonomous signal that needs no Paco · reuse/rating/
   supersede-on-update free from ①. Proactive refresh DEFERRED (scheduler ADR).
**⑤ Skills** get the eval metadata too — tiny, once ① exists.
**INTERLEAVE:** D4 auto-rollback + the **secrets firewall** (Houge's main process can't read .env) become
   load-bearing at ③/④ (autonomous internet ingestion) and gate the human-tapped→autonomous merge flip.
**STILL PENDING before /goal:** the 5-mechanism safety floor (auto-rollback ✓D4 / kill-switch / secrets
   firewall / self-regression eval / metered-$ ceiling) — eval loop ① IS the self-regression-eval seed.

---
# Houge INNER-LOOP REFACTOR — ADR 0013 LOCKED 2026-07-02 (LLM inner composition; awaiting /goal per step)

**Written up:** [ADR 0013](../docs/decisions/0013-llm-inner-composition.md) (code owns the gates, the
model composes between them) + [inner-loop spec](../docs/superpowers/specs/2026-07-02-inner-loop-refactor.md)
(buildable steps ⓪·1–⓪·4). Completes ADR 0001's amendment (gives the "cognition is free" principle its
mechanism); refines ADR 0010 (enum→advisory hint); re-sequences ADR 0012 (loop = spine step ⓪).

**Why (runtime survey 2026-07-02):** every runtime model call is single-shot text-in/text-out — NO
tools, NO loop, no model-chosen next action anywhere. Routing = 6-way intent enum (either/or; real
messages are mixtures) + a regex verb table for selfcode write/diagnose. Each evolution layer =
its own hardwired pipeline → O(n) plumbing per layer, ZERO cross-layer composition (a correction can
never become a lesson AND a self-write proposal in one turn). Peer evidence: Hermes = LLM-driven pole
(injection-weak); OpenClaw = code-driven pole, source of the decision/observation hook taxonomy we
adopt + the relaxed-floor cautionary tale (kept our floor hard).

**The design (one sentence):** contracts become ENVELOPES (allowed_actions = tool manifest handed to
the model; budget = step cap); a new inner loop (`src/core/inner-loop.ts`) lets the model pick one
action per step (JSON-in-text protocol — model-agnostic, tolerant parse, final-answer default); every
step executes through CapabilityRunner's unchanged gates; halts on final/budget/gate-denial. Evolution
layers become TOOLS in the loop (lesson_write, skill_author, self_diagnose, self_write_propose, later
wiki_*) — each pipeline's hard gates intact INSIDE the tool boundary. FLOOR UNCHANGED: guard, test-gate,
reviewer isolation, branch-only + human-tapped merge, unforgeable /approve /deny, breaker, DATA channel.

**Roadmap (each a /goal, each ends LIVE over Telegram; flag `HOUGE_INNER_LOOP_ENABLED` default OFF):**
- **⓪·1 — loop engine + `turn` surface** (manifest: llm_answer, web_search, lesson_write, clarify;
  enum path stays as fallback). LIVE gate: mixed-intent Chinese message → lesson AND answer in ONE turn.
  **✅ DONE + LIVE 2026-07-02 (run_b4a77b83).** One mixed-intent Chinese msg (no-lists correction +
  Sydney-weekend-weather question) → loop_started(hint=feedback) → step1 lesson_write SAVED ("Avoid
  lists; answer in one or two concise paragraphs instead.", scope ask) → step2 web_search →
  loop_halted(final, 2 steps) → answer DELIVERED over Telegram — and the answer already OBEYED the
  just-written lesson (paragraphs, no lists). Sources: loop:lesson_write + loop:web_search.
  - [x] L1 `src/core/inner-loop.ts` (step loop, protocol+tolerant parser, halt conditions, InnerLoopDeps)
  - [x] L2 `src/core/tool-manifest.ts` (descriptors from contract allowed_actions)
  - [x] L3 flag fork in executeTurn (`HOUGE_INNER_LOOP_ENABLED`, default OFF; enum path = fallback);
        manifest: llm_answer · web_search · lesson_write (distill+backstop+append) · clarify(protocol)
  - [x] L4 ledger events loop_started/loop_step/loop_halted + attribution recording
  - [x] L5 gates GREEN: typecheck · 789 tests · build · deps {} · independent adversarial verification
        (verdict GO; 2 findings FIXED pre-live: legacy clarify-cap test env-pinned [pre-existing latent
        self-write blocker]; lesson_write feedback anchored to REAL user msg + scope whitelist/clamp —
        model-supplied poison text can no longer reach the distiller). Hermetic under daemon env ✓.
        DEFERRED to ⓪·2: wall-clock loop halt (per-call timeouts bound it meanwhile); parse_cap raw-text
        reply cosmetics; HOUGE_ASK_SYSTEM_PROMPT honored on loop path; injected-JSON-echo eval fixture;
        run_completed budget_used showed tool_calls:1 on a 2-capability live run (telemetry undercount?
        — verify budget accounting on the loop path).
  - [ ] L6 LIVE gate: flag ON in .env + daemon reloaded PID 10332 ✓ — NOW NEEDS Paco: one mixed-intent
        Chinese message (correction + question) → lesson AND answer in ONE turn; verify
        loop_started/loop_step/loop_halted ledger events + /lessons shows the lesson.
- **⓪·2 — evolution layers as tools** (skill_author, self_diagnose, self_write_propose; DELETE the
  WRITE_SIGNALS regex). LIVE gate: terse Chinese bug report → self-write proposal, no verb table.
  **✅ DONE + LIVE 2026-07-03 (commit aea7b91; live run_6e322401).** Checklist:
  - [x] M1 tool-wrap skill_author (GateA→author→GateB), self_diagnose (read-only Codex), self_write_propose
        (writer→guard→test-gate→reviewer→branch→buttons, unchanged inside; armed by HOUGE_SELFWRITE_ENABLED);
        internal in-route sub-contracts stay as today; tool names added to turn allowed_actions
        (+ once-per-turn guard; publish buttons ride the loop's final report)
  - [x] M2 DELETE WRITE_SIGNALS regex (classifier enum stays as advisory hint only; legacy
        selfcode now ALWAYS diagnoses — the write path is loop-only)
  - [x] M3 manifest policy: evolution tools listed only when their arming flags are ON
        (codex→self_diagnose, selfwrite→self_write_propose, skills→skill_author; unlisted=denied)
  - [x] M4 ⓪·1 deferred items: wall-clock loop halt (reason "timeout") · parse_cap raw-text reply
        cosmetics · HOUGE_ASK_SYSTEM_PROMPT honored on loop path · injected-JSON-echo defense +
        fixtures · budget_used undercount fixed (recordRunCompleted hardcoded {tool_calls:1};
        turn paths now pass the shared ledger's actual usage)
  - [x] M5 build gates GREEN 2026-07-02: typecheck · 807 tests · build · deps {} · hermetic under
        daemon env (.env + INNER_LOOP=1, CLARIFY=5, SKILLS=1); floor tests untouched;
        independent adversarial verification still pending (orchestrator)
  - [x] M5b verifier fixes 2026-07-03: code-owned evolution-outcome notices appended to the
        outgoing reply (never model-mediated) + HOUGE_ASK_SYSTEM_PROMPT pinned in turn suite
  - [x] M5c LIVE-gate regression fix 2026-07-03 (run_8c1091be): evolution-tool internals ran on
        the loop's SHARED turn ledger → "writer failed: Tool-call budget exhausted". Each tool
        now runs its pipeline on a FRESH sub-ledger from its own sub-contract budget; turn
        ledger charged exactly 1 per evolution step; 3 regression tests (mutation-verified);
        810 tests green, hermetic sweep (6-var export) green
  - [x] M5d LIVE-run finding #2 fixed 2026-07-03 (run_1280539d, PRE-EXISTING guard bypass): both
        checker diffs (`git diff --raw`/`git diff HEAD`) omitted UNTRACKED files while publish
        `add -A`'d them — net-new files were un-reviewable ("file not shown" reject) AND invisible
        to the protected-path guard. Fix: `git add -N -- . ":(exclude)node_modules"` before every
        diff read (same exclusion as publish; the node_modules SYMLINK dodges the `node_modules/`
        gitignore dir pattern and would otherwise hard-deny as a new symlink). 5 real-git deps
        tests incl. the security assertion (new file under src/policy/ now DENIED); 815 green
  - [x] M6 LIVE gate MET over 3 Telegram rounds (each round found a real bug — the live gate earned
        its keep): R1 run_8c1091be = lesson+diagnose+self-write in ONE turn (composition proven; budget
        bug found). R2 run_1280539d = explicit "改代码" → straight to self_write_propose, 3 writer
        attempts on isolated budget, wall-clock halt worked, code-owned failure block delivered (guard
        blind spot found). R3 run_6e322401 = terse "直接改代码，把时区的bug修掉" → self_diagnose →
        self_write_propose → guard✓ tests✓ reviewer PASS → branch houge/selfwrite/run_6e322401
        (temporal.ts +17/−3) + [Merge & reload] delivered. NO verb table anywhere; the model even
        OVERRODE a wrong "clarify" hint. Post-gate: ⓪·2 committed (aea7b91) BEFORE merge tap (Houge's
        merge handler correctly refused Paco's early tap on the dirty tree — floor working).
        FOLLOW-UPS parked: 10-min turn time_minutes is tight for self-write turns (2/3 runs halted
        "timeout" after the pipeline finished — cosmetic, final composed as best-effort); echo-defense
        depth beyond prior digest; classifier hint noise (feedback/clarify on identical msgs).
- **⓪·2b — LOOP HARDENING** ✅ **DONE + LIVE 2026-07-03** (build 2a64dfb; H5 live gate = Houge's
  clock fix 5ae8d5e, self-written + kimi-reviewed + button-merged + self-restarted in ~7 min total;
  live output now "Today's date and time is 2026-07-03 17:30 (Australia/Sydney)" — the June-27
  date/TZ bug is CLOSED, final fix authored by Houge). 843 tests; verifier GO. Parked MINORs:
  extension stacking worst-case ~100-min turn blocks the synchronous daemon (freedom-over-control
  accepted; note lease-recovery has NO production caller); silent writer≠checker diversity loss if
  chain lands on codex (auditable via reviewer_backend); configured-codex reviewer bypasses enabled
  check (pre-existing); worker-level extendDeadlineFor closure untested directly.
  - [x] H1 **Reviewer fallback chain**: reviewer *unavailable/timeout* (NOT reject — reject stays
        terminal) falls down kimi → claude → codex before failing the attempt. Evidence: run at
        06:01 — a good timezone-clock diff died on "kimi reviewer timed out after 180000ms
        (after 2 attempts)". Best-model-per-capability alignment; record which reviewer verdicted.
  - [x] H2 **Evolution deadline extension**: the loop's wall-clock deadline extends by the invoked
        evolution tool's sub-contract time_minutes (self-write=30) when that tool starts. Evidence:
        3 of 4 live self-write turns halted "timeout" (10-min turn budget vs 8–11-min pipeline);
        truncation also triggers H3's raw fallback.
  - [x] H3 **Best-effort final must respect language/persona**: on timeout/parse-cap halts the
        code-assembled fallback ships raw English digests to a Chinese chat (06:12 live reply =
        Houge's diagnosis relayed verbatim in English — exactly what lesson 3516dee prevents).
        Fix: one RESERVED compose call to restate the digest in the user's language (fall back to
        a code-owned bilingual wrapper if even that call is unavailable).
  - [x] H4 **Restore buttons on refused merge**: merge clears the keyboard first (correct anti-
        double-tap) but a REFUSED merge (dirty tree / conflict) never restores it — Paco's early
        tap consumed the buttons and the branch became untappable (2026-07-03; manual merge needed).
        Re-attach the same keyboard on refusal outcomes; keep cleared on success/discard.
  - [x] H5 DONE 2026-07-03 (run_e0b1b673 → 5ae8d5e): AFTER H1 landed — **Houge self-writes the clock fix over Telegram** ("把当前时间也加进
        temporal context"): temporalContext (merged run_6e322401) has date+TZ but NO clock time →
        asked 现在几点 at 4pm he confabulated 6pm. His own diagnosis (06:12) nailed it; his own
        byte-stable-injected-now trick means the live branch can change without touching tests.
        This IS the live gate for H1–H3 (reviewer fallback exercised, no timeout truncation, any
        fallback reply in Chinese).
  - Parked for ⓪·3 (not here): duplicate timezone lessons in the ask block = reconcile/supersede.
- **⓪·2c — SELF-WRITE UX** ✅ **DONE + LIVE 2026-07-03** (build d14ad02; live gate = Houge's header
  rename 5d8b97f: readable [View diff] → merge tap → "✅ 重启成功 — 现在运行 5d8b97f「…」" arrived
  unprompted, both delivered 10:34). 870 tests; verifier GO (2 cosmetic MINORs parked: git-quoted
  non-ASCII paths render octal; ---/+++-shaped content lines dropped as meta).
  KEY LESSON (43562ec): Houge's first attempt run_3dbd8174 was STRUCTURALLY IMPOSSIBLE — 5 tests
  pinned the literal 自我修改状态 and existing tests are immutable to self-writes → writer could only
  produce the parenthetical hack kimi rightly rejected. Fix = assert code-owned user-facing strings
  via EXPORTED CONSTANTS so they stay self-write-evolvable. Also observed: model routed "改标题"
  feedback to a lesson that cannot affect a code-owned string (Houge overpromised "以后我会…") →
  layer-routing self-knowledge folded into ⓪·3 scope (see below).
  - [x] U1 **Readable [View diff] message**: lead with `git diff --stat` summary · cleaned compact
        hunks (strip index/---/+++ noise, per-file headers, head-capped per file — today's tail-cut
        loses the filenames) · full `.patch` attached via sendDocument when over the inline cap
        (zero-dep multipart; optional client method). NO GitHub compare link (branch never pushed
        pre-merge — would 404).
  - [x] U2 **Reload marker + boot confirmation** (= stage 1 of ADR 0012 D4 health probe): green
        merge writes a durable marker (sha+subject) before restart; daemon startup consumes it
        exactly once and notifies "✅ 重启成功 — running <sha> <subject>". No marker → no message;
        crash-loop detection + auto-rollback stays in the spine interleave (D4 proper).
  - [x] U3 gates GREEN (870): typecheck · test · build · deps {} · hermetic sweep · independent verification;
        merge-order invariants stay asserted (merge→build→test→notify→push→restart).
  - [x] U4 LIVE gate MET (5d8b97f): one small real Houge self-write end-to-end — [View diff] actually readable
        on mobile → [Merge & reload] → ✅ boot confirmation arrives on Telegram.
- **⓪·3 — spine Slice A on the loop** ✅ **DONE + LIVE 2026-07-04** (build 23540b1; A9 live gate
  MET in one evening session): unprompted 0–3 ask fired 31s after boot → rating 3 captured →
  repeat timezone correction SUPERSEDED lesson #11 (lesson #15 active, lineage intact — first
  visible compounding) → layer-routing net caught the code-owned 标题 feedback ({"reason":
  "code-owned"} refusal → in-turn pivot to self_write_propose → published → Paco merged →
  465cd2b live, header now "✨ 又偷学了新本事" — named by Houge, shipped by Houge).
  FOLLOW-UPS: (F1) code-owned phrase checker sees only the CURRENT message — a phrase quoted two
  turns earlier escapes the net (live miss 22:14: model overpromised "以后就用…" with no code path);
  fix = extract phrases from the recent thread. (F2) attribution empty on first rating (pre-deploy
  runs lack lesson_ids — self-heals). (F3) verifier MINORs: saveReconciledLesson lacks scope guard
  (defense-in-depth); reversed bullet order vs legacy block (cosmetic); no direct throw-injection
  test for processRatingSignal. Originally: /goal IN PROGRESS 2026-07-03 (rating, reconcile/
  supersede, reuse-value+decay, AVOID; A1 attribution already emitted by loop observation hooks).
  LIVE gate = spine A9 (visible compounding). DESIGN REFINEMENT vs spine spec A2: lessons move from
  one-capped-block-per-scope to PER-LESSON ROWS (`lessons` table; block composed at read time) —
  reconcile/supersede/reuse-value are per-lesson concepts; existing block bullets migrate to rows.
  Embeddings DEFERRED: per-scope lesson counts are small → reconcile = one LLM compare against the
  scope's lessons (flat-rate chain), no new dep (zero-runtime-deps rule holds).
  - [x] S1 BUILD 1 — memory reshape + write path: `lessons` table + migration from block bullets ·
        reconcile-on-write ADD/SUPERSEDE/UPDATE (never delete; bidirectional supersede pointers) ·
        AVOID field threaded into composer render · reuse_value/applied_count/last_used fields ·
        /lessons shows lineage+reuse, /forget by scope|id · lesson_write + legacy runFeedback both
        reconcile · LAYER-ROUTING (i) discipline names code-owned surfaces + (ii) lesson_write
        refuses feedback quoting a phrase found verbatim in src/ (digest steers to code layer).
  - [x] S2 BUILD 2 DONE 2026-07-03 — signal path: rating capability (session-lull + substance trigger on the poll
        loop, rate-limited, 0–3 + optional comment, pending-rating state so a bare digit routes to
        capture not chat) · rating attaches to the session's applied artifacts (from loop_started/
        loop_step attribution) · low-rating bounded transcript pass → culprit flag (accumulate,
        pattern-not-single-rating) · applied-and-not-corrected → reuse_value++ · daily decay+prune
        tick riding the poll loop · LAYER-ROUTING (iii) repeat-supersede of an ineffective lesson →
        digest suggests self_diagnose/self_write. Built: src/capabilities/session-rating.ts (ask
        trigger + bare-rating parse + attribution pass), gateway pre-turn capture, run-store
        pending_rating/session_ratings/lesson_decay_state (+ rating_history/reuse math, SUPERSEDE
        correction wiring, escalate digest), daemon runSignalPathTick, /lessons ratings+⚠ flagged,
        /status Rating line. VERIFIER FIXES applied 2026-07-04: (1) digit+comment never swallows —
        rating banked, COMMENT forwards as the turn's message (no ack; comment→lesson rides the
        normal turn once, comment→distill branch dropped from processRatingSignal); (2)
        CONVERSATIONAL_SRC_STRINGS skip-list so Houge's spoken strings (ask/acks/hints) never trip
        the code-owned refusal (rendered EVOLUTION_NOTICE_HEADER stays greppable); (3) live-skills-2b
        + live-conversational scripts ported off removed listLessonBlocks. 971 tests green
        (was 909); hermetic sweep incl. hostile HOUGE_RATING_*/HOUGE_LESSON_* values; typecheck/
        build/deps {} green.
  - [x] S3 gates + independent adversarial verification (both builds) · hermetic sweep · floor
        untouched · composer goldens for non-loop surfaces byte-stable.
  - [x] S4 LIVE gate MET (see above) (spine A9, interactive): correction → lesson lands with AVOID, SUPERSEDES the
        prior version (duplicate timezone lessons collapse = ready-made case 1) · Houge asks 0–3 at
        session boundary · repeat correction supersedes rather than re-learns · ineffective
        "playful sign-offs" lesson (case 2) escalates to the code layer · /lessons shows
        reuse_value + supersede lineage.
  **+ folded in (2026-07-03): LAYER-ROUTING self-knowledge** — (i) loop discipline names the
  code-owned surfaces (notice header, report scaffolding, buttons, wrappers): "a lesson can't change
  these → self_write_propose"; (ii) lesson_write mechanically refuses feedback quoting a phrase that
  exists verbatim in src/ (digest steers the model to the code layer in-turn); (iii) the eval loop
  itself: an applied-but-ineffective lesson loses reuse-value on repeat correction → escalates.
  READY-MADE LIVE CASES: the duplicate timezone lessons in ask block (reconcile) + the useless
  "playful sign-offs" lesson from run_72230506 (ineffective-layer escalation).
- **⓪·3f — F1 + POLISH** ✅ **DONE + LIVE 2026-07-04** (3cae47c; live gate = run_df822dbd →
  4de7523): "就换成🗡️ 又闯了一关吧" WITHOUT quoting the old title → model recovered the target from
  the THREAD, routed straight to self_write_propose (overriding an "answer" hint), honest reply
  ("分支就绪，等合并"), merged + ✅ boot confirmed. The 22:14 overpromise mode did NOT recur; the F1
  refusal net is test-proven (incl. the anti-poison assistant-turn case) and stands as backstop.
  ⚠ COSMETIC: writer included the trailing 吧 in the constant ("🗡️ 又闯了一关吧") and the reviewer
  missed it — Paco can fix with one terse message (good trivia exercise for the loop). — build DONE, LIVE gate open
  - [x] F1 thread-scoped code-owned check: extract phrases from the current message + recent USER
        turns (assistant turns EXCLUDED — a prior reply containing the notice header must not
        poison every later lesson_write). Live case: 22:14 two-turn miss.
        (`extractThreadPhrases` union: current-message phrases first, ≤6 user turns / ≤1500 chars /
        ≤8 phrases; worker passes `threadUserTexts` filtered to role="user"; anti-poison test pins
        the assistant-turn exclusion.)
  - [x] P1 saveReconciledLesson scope guard (cross-scope supersede degrades to ADD)
  - [x] P2 processRatingSignal throw-injection test (daemon survives — the try/catch already
        existed in telegram-daemon.ts; test-only, per spec)
  - [x] P3 lesson render tie-order = legacy reading order (created ASC on equal reuse_value)
  - [x] P4 worker-level evolution-deadline-extension coverage (⓪·2b parked MINOR —
        `evolutionDeadlineExtender` factory exported; 30/60/10-min grants + ranOnce/disarmed/0 pinned)
  - [x] LIVE gate MET (see above): replicate the 22:14 shape — msg 1 quotes the code-owned title, msg 2 says
        "换掉它" without quoting → refusal fires from thread → pivot to self_write_propose
        (branch may be discarded — the routing is the test).
- **⓪·3g "THE LANE FIX"** ⏳ **/goal IN PROGRESS 2026-07-04** (deaf+lossy single lane; design:
  the lane is blocked by SYNC child-process spawns, not architecture — convert pipeline spawns to
  async, background the evolution pipelines, keep the poll loop breathing)
  - [ ] G1 async spawns: writer (codex/claude), test-gate, reviewer chain, self-diagnose consult —
        execFileSync/spawnSync → promisified async (no worker threads, no extra processes; sqlite
        stays on the main thread). Gate SEQUENCE and requirements unchanged.
  - [ ] G2 background evolution lane: self_write_propose / self_diagnose / skill_author return
        IMMEDIATELY with a "started" digest (model tells the user work has begun); the pipeline
        runs as ONE tracked background promise (global busy flag — a second evolution ask while
        busy returns a not-ok "已有一个自我修改在进行中" digest). Completion sends its own durable
        notification: publish text + buttons (as today) or the CODE-OWNED failure text (the
        evolution-notice guarantee moves from the turn reply to the completion notification).
        Pipeline wall-clock cap = its sub-contract time_minutes (abort → failure notification).
        H2 turn-deadline extensions become unnecessary for backgrounded tools — remove/neutralize.
  - [ ] G3 daemon integration: poll loop keeps serving messages/taps during a pipeline; SIGTERM
        awaits the in-flight background pipeline (or tears down worktree safely); single-instance
        lock unchanged; ledger events (self_write_*) still emitted; budget: turn charged 1 for the
        kickoff as today, pipeline internals on their own sub-ledger (unchanged from ⓪·2).
  - [ ] G4 tap hygiene: answerCallbackQuery promptly; dedupe IDENTICAL callback actions
        (action+runId) within a 60s window (N impatient taps → one response); merge tap stays
        synchronous (it ends in restart) BUT sends an immediate "正在合并，跑门禁要几分钟 🐒" ack
        before the gate run.
  - [ ] G5 gates: typecheck · test · build · deps {} · hermetic sweep · FLOOR: guard byte-untouched;
        gate/reviewer/writer modules may change EXECUTION (sync→async) but not REQUIREMENTS,
        ORDER, or argv/tools-denied invariants (existing floor tests stay green, mechanically
        adapted only if the API forces it) · independent adversarial verification.
  - [ ] G6 LIVE gate (Paco): trigger a real self-write; WHILE the pipeline runs: a chat message
        gets answered promptly AND the kickoff reply arrives instantly; publish notification lands
        with buttons; an immediate View-diff tap answers in seconds (no loss); double-tap → one
        diff; merge → immediate ack → ✅ 重启成功.
- **ROADMAP NOTE 2026-07-04 (soak day 1 evidence):** Paco's real usage (deep investment research:
  "多方查证不同信息来源，做综合报告") hit the CAPABILITY CEILING squarely: web_search = snippets only
  (can't read sources — needs spine ③ http_fetch, already spec'd H1–H7) · one turn = ≤6 calls/10min
  (no comprehensive report) · no background work · no durable synthesis (needs spine ④ wiki — the
  investment-research use case is the wiki's designed demo; charter-clean: research OK, only
  trading/custody deferred). Houge's honest decline ("时间/预算不够") = the no-false-promises lesson
  WORKING. Proposed sequence: ⓪·3g lane fix → ③ http_fetch → ④ wiki, with ② episodic + scheduler
  slotting around them; ⓪·4 after a quiet week. ALSO NOTED: reconcile dedupes within-scope only —
  the same verify-across-sources lesson landed in BOTH ask (#17, superseding #6 ✓) and research
  (#16); cross-scope dedup = small known v1 limit for the ⓪·3g-era backlog.
- **⓪·4 — retire legacy paths** (flag default ON, executeTurn if-chain + per-intent handlers removed,
  research fixed sequence dissolves into composition). LIVE gate: a normal day's traffic on loop only.

**Key risks:** weak models compose poorly (caps + final-default + per-surface fallback + best-model-per-
capability); injection steers composition (bounded: only contract-allowed tools, budget capped, approvals
human); blast radius of ⓪·1 (parallel-path flag; ~300 floor tests + composer goldens untouched by design).

---
# Phase 3.6 — `http_fetch` capability (real internet, narrow tool) — SPEC DRAFTED 2026-06-26 (awaiting /goal)

**Why:** Live Telegram (2026-06-26, runs `0917fa11`/`325db3f6`/`581823f4`/`fd0ae1e6`): Paco asked Houge to locate
them via IP. Houge could only *describe* `curl ipinfo.io` and *offer* to query — it has NO tool to make an
arbitrary HTTP request (`pi --no-tools` strips bash; every contract forbids `generic_shell`; only `web_search`
exists, and that returns search snippets, not a direct GET to a chosen URL). Result: broken-promise loop
("需要我直接查吗?" → can't). Self-diagnosis `581823f4` correctly identified the gap.

**Decision (Paco, 2026-06-26):** add a **narrow `http_fetch` capability** = a bounded server-side GET, the
exact analogue of Claude Code's `WebFetch` (covers GitHub/arxiv/docs/JSON/`ipinfo.io` — the static tier).
JS/iframe/SPA pages are explicitly OUT OF SCOPE (that's the browser tier — isolation-based, a separate later
decision). **Safety posture = "A + IP-block floor":** allow ANY public URL (like Claude's WebFetch), but a
hard SSRF IP-block floor is non-negotiable. Optional env denylist; NO default domain allowlist.

**Why this is the right/safe first internet capability (research-backed, 2026-06-26):** a bounded single GET
has ONE chokepoint, so an SSRF guard is enforceable + default-on — unlike a browser (arbitrary JS/redirects/
sub-resources = no chokepoint; playwright-mcp & browser-use both self-declare their allowlists "not a security
boundary"). Industry net default is egress-OFF (Codex/Devin/Cursor); Houge is autonomous + ingests untrusted
input (no human-in-loop per fetch, unlike interactive Claude Code), so the IP-block floor IS the human's
replacement. Aligns ADR 0006 (web bytes = untrusted DATA channel) + model-agnostic runtime (orchestrator-level).

**SSRF guard — the load-bearing floor (must ALL hold; cutting any = playwright-mcp's advisory non-boundary):**
- [ ] Scheme allowlist: `http`/`https` only (reject `file:`/`gopher:`/`data:`/`ftp:`).
- [ ] Method: GET/HEAD only.
- [ ] **Resolve-and-PIN:** resolve host A+AAAA; reject if ANY resolved IP ∈ {`127/8`,`0/8`,`10/8`,`172.16/12`,
      `192.168/16`,`169.254/16` (incl. metadata `169.254.169.254`),`::1`,`fc00::/7`,`fe80::/10`, IPv4-mapped
      `::ffff:0:0/96` → decode+recheck}; then **connect to the validated IP**, do NOT re-resolve (kills DNS
      rebinding/TOCTOU). The #1 bypass — non-negotiable.
- [ ] No redirect-following (or cap hops + re-run scheme+IP checks every hop).
- [ ] Bounds: hard timeout + max response byte cap (reuse the provider byte-cap pattern).
- [ ] Optional `HOUGE_HTTPFETCH_DENY` host denylist (env). NO default domain allowlist (Posture A).

**Caveats (documented, not solved here):** (1) GET can still exfil via query-string to a public host — accepted
under Posture A; revisit only if Houge handles adversarial input near real secrets. (2) Egress guard does NOT
solve prompt injection — fetched bytes stay on the ADR 0006 DATA channel (reader/actor wall), never the system
prompt. (3) No JS — static tier only.

**Build plan (gates; mirror Phase 3.4 G-structure; build on Claude via subagents, verify independently):**
- [ ] H1. `src/web/http-fetch.ts` — `fetchUrl()` + the SSRF validator (pure, no I/O in the validator so it's
      exhaustively unit-testable). Injected `lookup`/`fetch`/`spawn` seams for tests.
- [ ] H2. `src/capabilities/http-fetch.ts` — `createHttpFetchAdapter` mirroring `web-search.ts`
      (`createWebSearchAdapter`): validate `input.url`, call H1, return `{ok,output:{url,status,content}}` as
      external_read DATA; never acts.
- [ ] H3. Register in `core-worker.ts` ToolRegistry — category `http_fetch`, `side_effect_level:"external_read"`,
      `risk_level:"low"`, byte cap, timeout. Wire `this.httpFetchAdapter`.
- [ ] H4. `task-contract.ts` — add `"http_fetch"` to `allowed_actions` of `compileTurnContract` (live Telegram
      path) + `compileWebResearchContract`. Stays FORBIDDEN elsewhere. Confirm the contract-vs-registry category
      gate accepts it (same mechanism as `web_search`).
- [ ] H5. Routing — `intent.ts`: add intent `"fetch"` (classifier extracts a concrete URL from the message);
      `core-worker` `runFetch()` = http_fetch(url) → llm_answer to summarize in Houge's voice (mirror
      `runResearch`: register tool → run → relay; web bytes ride the DATA channel). Default-safe fallback to
      `answer` on any parse miss (existing pattern). [Open Q for /goal: new `fetch` intent vs. fold a URL-present
      branch into `research` — recommend new intent for a clean orchestration path.]
- [ ] H6. Tests: SSRF validator table-tests (every blocked range + IPv4-mapped + rebinding/TOCTOU + redirect
      bypass + scheme reject); adapter happy-path w/ injected fetch; contract test (`http_fetch` allowed in
      turn/web-research, forbidden in ask/skill/selfcode/research-brief); intent-classify `fetch`. Typecheck
      clean · full `npm test` green · build OK.
- [ ] H7. **LIVE GATE (last step, interactive — Paco sends over Telegram):** "查一下我们当前的公网IP归属地"
      → Houge fetches `ipinfo.io/json`, replies with the actual city/ISP (not a how-to). Plus a negative test:
      a URL resolving to `127.0.0.1`/`169.254.169.254` is refused cleanly (no crash, no fetch).

**`.env` (gitignored) to add at reload:** `HOUGE_HTTPFETCH_ENABLED=true`, `HOUGE_HTTPFETCH_TIMEOUT_MS`,
`HOUGE_HTTPFETCH_MAX_BYTES`, optional `HOUGE_HTTPFETCH_DENY`. Reload: `npm run build && launchctl kickstart -k
gui/$(id -u)/com.houge.daemon`.

---
# Phase 3.4 — research-model-fit via Gemini chain legs — PLAN DRAFTED 2026-06-26 (awaiting /goal)

**Why:** `run_8672b6fb` (today) recurred the research-synthesis silent failure. The cheap chain is 100%
coding-tuned (`pi`=kimi-k2.7-code-highspeed) → over-produces on prose → blows pi's 256KB cap; kimi-api
fallback returned empty → run FAILED with no reply. Fix = add **general-model** legs. Paco's preferred
chain order: **`pi → agy CLI → kimi-api → gemini-api`** (CLI legs free/authed; API legs keyed).

**Discovery done (2026-06-26):**
- `agy` = Antigravity CLI `1.0.8` @ `/Users/pluo/.local/bin/agy` (supersedes the `gemini` CLI, which is NOT on
  PATH). **Already authenticated** — `agy --model "Gemini 3.5 Flash (Low)" --print "<prompt>"` → clean
  plain-text stdout, exit 0, ~8.5s cold. Multi-model (Gemini 3.5 Flash/3.1 Pro, Claude 4.6, GPT-OSS).
- **agy quirks vs pi:** prompt is an ARGV value (`--print <prompt>`), NOT stdin — still injection-safe via
  spawn arg-array (Go flag consumes the next token as the literal value). NO `--no-tools` flag (agentic CLI);
  NO `--system-prompt` flag; NO JSON/usage output. → fold system into the prompt string; bound blast radius
  with empty temp cwd + restricted env allowlist + NO `--dangerously-skip-permissions` (+ maybe `--sandbox`);
  onUsage telemetry absent for this leg.
- Live `.env`: `HOUGE_LLM_PROVIDERS` UNSET → running default `pi,kimi-api` (the failing chain). No
  `GEMINI_API_KEY` yet → **agy-cli leg alone fixes the bug today**; gemini-api leg lands when Paco adds a key.

**BUILD STATUS (2026-06-26, /goal active):** G1–G6 DONE + independently verified (PASS, no HIGH/MED;
LOW-1 auth-marker false-positive FIXED). Typecheck clean · **npm test 725** · build OK · deps {}. Daemon
reloaded PID 46231 on the 4-leg chain (`.env` HOUGE_LLM_PROVIDERS=pi,agy-cli,kimi-api,gemini-api +
HOUGE_AGY_BIN). agy auth confirmed under the daemon's restricted env. **G7 LIVE test = LAST STEP (awaiting
Paco's Telegram send of the failing weather query).** New/changed: openai-compat.ts (shared factory) +
gemini.ts + cli-spawn.ts (shared spawn) + agy-cli.ts + registry/llm-answer wiring + run-store
enqueueFailureNotification + core-worker failWithPartialReport (G5).

**Build plan:**
- [x] G1. `src/llm/providers/agy-cli.ts` — `createAgyCliProvider` on the pi.ts safety skeleton (injected
      spawn impl, SIGKILL timeout, byte cap, env allowlist, temp cwd, ENOENT/auth→`unavailable`). Args
      `["--model", model, "--print", system+"\n\n"+question]`. `HOUGE_AGY_BIN` (absolute, like CLAUDE/CODEX),
      `HOUGE_AGY_MODEL` (default `Gemini 3.5 Flash (Low)`). Plain-text stdout → strip-ANSI/trim. Tests mirror
      pi.test.ts.
- [x] G2. `src/llm/providers/gemini.ts` + shared `src/llm/providers/openai-compat.ts` factory (kimi+gemini
      both built from it; kimi public surface preserved → 64 prior tests green). Default `gemini-3.5-flash`,
      base `…/v1beta/openai` + `/chat/completions`, `GEMINI_API_KEY`, max_tokens 8192 (thinking-token headroom).
      ⚠ usage caveat stands (3.5-flash total_tokens incl. thinking; counts-only, non-blocking).
- [x] G3. `src/llm/registry.ts` — `agy-cli` + `gemini-api` cases + timeout/suffix maps. Default chain
      unchanged (`pi,kimi-api`); 4-leg opt-in via `.env`. Also NEW `src/llm/providers/cli-spawn.ts` (shared
      spawn machinery extracted from pi.ts; pi re-exports the types → pi tests green).
- [x] G4. `src/capabilities/llm-answer.ts` — onUsage threaded for `gemini-api` (agy-cli emits none).
- [x] G5. silent-failure notification — `RunStore.enqueueFailureNotification` + `failWithPartialReport`
      now always enqueues "I hit an error on that one: <reason>" on BOTH failure exits. Unit-locked
      (core-worker-turn test). One terminal notification per run (success XOR failure; shared idempotency key).
- [x] G6. `.env` (4-leg chain + HOUGE_AGY_BIN), `.env.example`, `docs/reference/configuration.md`, README.
- [x] G7. **Verify DONE** — typecheck clean · **npm test 725** · build OK · deps {}. **Independent adversarial
      review: PASS** (no HIGH/MED; LOW-1 auth-marker false-positive on general prose FIXED + test-locked).
      **LIVE EVIDENCE (real chain, scripts/probe-chain-p34.mjs + live-gemini-chain-p34.mjs):**
      • Full e2e turn (real Tavily + real chain) on the EXACT failing query → **completed** with a proper
        Chinese weather/cycling answer (that run pi happened to succeed: `llm:pi:kimi-for-coding`).
      • **Fall-through PROVEN**: full chain with pi forced to fail → served by **agy-cli·Gemini 3.5 Flash**
        (6.8s) — exactly the morning failure mode now recovering instead of going silent.
      • `gemini-api` alone (5.0s) and `agy-cli` alone (8.1s) each synthesize cleanly.
      • agy auth confirmed under the daemon's restricted env (PATH/HOME/TERM/LANG/USER).
      Daemon LIVE on the 4-leg chain (PID 46231). **Literal Telegram round-trip = Paco's 1-line send (or
      accept the above harness evidence).**

**Out of scope this round:** multimodal (image/voice/video) via agy/gemini — Paco flagged it as a later round.
**Follow-up filed:** "LLM-for-research model fit" + "Silent turn failures" backlog items → RESOLVED by Phase 3.4.

### Phase 3.4 LIVE thread (2026-06-26 23:17–23:23Z) — NEW issues surfaced (do NOT fix in this /goal)
The weather query `run_dd305dc2` COMPLETED + replied (silent-failure FIXED ✓; intent classified `research`
correctly). No `llm_call` telemetry on the research-synthesis turns → since only agy emits no usage, the
general **agy-cli/Gemini Flash leg likely served them**. Quality issues, all NEW backlog:
- [x] **Research self-critique leaks meta-commentary** — ✅ FIXED BY HOUGE (self-write `3516dee`, 2026-06-27).
      The reply opened "我仔细瞅了瞅你发来的这篇…草稿,发现几个妖怪" then "修正后的最终回复": the STORM grade+revise
      step emitted its INTERNAL critique as the user-facing answer AND misattributed its own first draft to the
      user ("你发来的草稿"). Houge patched `RESEARCH_CRITIQUE_DISCIPLINE` (composer.ts): "Return only the final
      user-facing answer: do not mention the draft, review, critique, corrections, revisions, or your thinking
      process." ⚠ residual edge NOT covered: the explicit "don't add a second greeting/sign-off" guard — fold
      into a future correction if double-greeting recurs.
- [ ] **Location hallucination (no geo capability)** — Houge assumed **Beijing** with no basis; the whole
      23:19–23:23 sub-thread was Paco catching it ("你从哪里确定我在北京?"). No geolocation; should ASK or say
      it can't determine location, not guess. New `location`/geo capability (or a "don't assume location"
      discipline). Pairs with the market-data/structured-connector family.
- [ ] **Date off by one (timezone)** — reply said "今天 2026年6月25日 周四" but Paco's local date is 06-26
      (AEST). `temporal.ts` likely injects UTC; the daemon logs/timestamps are Z. Inject LOCAL date (or the
      user's TZ) into cognitive prompts. ⚠ STILL LIVE 2026-06-27: Houge replied "2026年6月26日, UTC时间" at
      07:05 local on the 27th — confirms he reports UTC, not Paco's local date. Reproduces reliably.
- [x] **Persona/language drift on the general legs** — ✅ FIXED BY HOUGE (self-write `3516dee`, 2026-06-27).
      `run_93ba1594` replied in ENGLISH ("Greeting Paco! Master Brother (大师兄)…") mid-Chinese conversation — a
      general-leg (agy/gemini) following houge.md less faithfully than pi/kimi. Houge added "Match the user's
      language and style; if the topic is Chinese, answer in Chinese and avoid unnecessary English" to ALL THREE
      of ASK/RESEARCH/RESEARCH_CRITIQUE disciplines (composer.ts) — broader than the 2 surfaces the hand-written
      reference touched; the English-drift actually appeared on the ASK leg, which Houge caught and I had missed.
  > **SELF-WRITE EXPERIMENT (2026-06-27):** Paco sent a ONE-PARAGRAPH terse Telegram message (not a 5-point
  > spec) describing the meta-leak + English-drift symptoms; Houge (Codex writer → test-gate → kimi → [Merge &
  > reload]) produced `3516dee`, a fix BROADER than the hand-written reference (3 disciplines vs 2, caught the
  > ASK-leg drift the reference missed, kept citations). Evidence AGAINST needing a spec-derivation stage for
  > changes this size — the writer was not the bottleneck. (Hand-written reference was stashed then superseded;
  > `git stash drop stash@{0}` when convenient.)
- [ ] **Telemetry blind spot** — research-synthesis turns emit NO `llm_call` event (onUsage not wired on that
      path; agy emits none by design) → can't see which leg served a turn. Wire synthesis-path onUsage; for
      agy, record a usage-less `llm_call` (provider/model/role only) so the leg is visible in the ledger.

---
# Phase 3.5 — kimi-cli reviewer adapter + self-write writer/checker economics — PLAN (2026-06-26)

**Context — self-write writer/checker economics (decided 2026-06-26 with Paco):**
- **Writer = the strongest *reliable* model** (generation is the hard, ceiling-setting job); **Checker = cheap +
  diverse** (bounded judgment, double-backstopped by the free test-gate + Paco's merge). Expensive→writer.
- Claude-as-writer **does not terminate** (live: two 600s timeouts; first turn produced the correct fix in
  ~123s then churned). Root cause = agentic `claude -p` ran `npm test` in a verify-loop (the test-gate's job).
  **FIXED `bf45e37`**: writer is now EXECUTION-FREE (`--disallowedTools Bash WebFetch WebSearch` + prompt
  "don't run tests; a gate verifies; STOP"). That helped (123s, tokens 698K→239K) but **refine passes still
  churn** and this claude CLI has **no `--max-turns`** to bound it → Claude-writer parked.
- **Decision:** Writer = **Codex `gpt-5.5` high** (strong + terminates; proven in S8). Checker = **kimi-2.7**
  (`kimi-for-coding`), a different family → diversity. The cheap checker is the right cost fit because the
  test-gate (free) + Paco-merge are the real safety net.

**What the reviewer (checker 3) actually does** (`diff-reviewer.ts`): single-shot adversarial judgment on
`(objective, diff)` → verdict JSON `{verdict, fixes_task, introduces_bugs, scope_creep, reasons}`. The
SEMANTIC check tests can't give ("compiles + passes the gate but wrong / hacky / scope-creep / sneakily
weakened a test"). Today it checks against only the one-line objective — **no spec** (see backlog below).

**Execution (per [[subagents-for-goal-execution]]):** run K1–K4 via a **builder subagent** (Claude) + an
**independent verifier subagent** (adversarial diff review) — keep main context clean. Main loop integrates
results + runs the final gate (typecheck/test/build) and the **interactive** K5 live Telegram test with Paco.

**STATUS (2026-06-26) — Phase 3.5 COMPLETE + COMMITTED `8f62095`. K5 live-gate BLOCKED on writer skill (not 3.5).**
- K1–K4 built (builder subagent). Verifier found a **HIGH security defect** (kimi-cli's default agent has
  Shell/file tools + `--print` auto-approve + `--work-dir` does NOT sandbox → reviewer read a seeded secret AND
  wrote into the LIVE repo). **FIXED:** generated **no-tools agent** (`tools: []`) via `--agent-file` + neutral
  temp cwd + finally-cleanup. Re-verifier confirmed CLOSED with a live PoC (agent refuses file read/write).
- **kimi reviewer PROVEN end-to-end** (`scripts/.../kimi-review.mjs` on a real diff): confined + a sharp
  adversarial verdict — correctly judged a fix correct+backward-compat+no-bugs, AND caught scope-creep + a doc
  inconsistency + a perf note. NOT a rubber-stamp.
- **Codex writer TERMINATES** (no Claude-style 10-min hang; 3 clean refine passes per run).
- ⚠ **K5 live-gate NOT met:** the 猴哥 fix did NOT auto-land. Two live runs (bare + spec-enriched) → Codex's
  fix went **test-gate red** all 3 refines → no branch (kimi never reached; test-gate correctly blocked).
  **The fix IS landable** — I reproduced the backward-compat fix by hand (`buildIntentSystemPrompt(now,
  identity?)` date-first + `readIdentity` + call-site) → **typecheck + 738 green** — so the blocker is Codex's
  writing skill (can't produce the exact backward-compat change in 3 refines, even WITH acceptance criteria),
  NOT the fixture or 3.5. This is the **spec-driven-self-write** case in the flesh: a sharper-than-spec, near
  diff-level hint or a stronger writer is needed to auto-land it.
- **ACTUAL ROOT CAUSE (2026-06-26, via diagnostic instrumentation) — it was NOT the writer.** The self-write
  test-gate runs `npm test` as a child of the daemon, **inheriting the daemon's `.env`** (which sets
  `HOUGE_AGY_BIN`). A **non-hermetic test** I wrote in Phase 3.4 — `agy-cli.test.ts` "defaults the model" —
  asserted `binary === "agy"` WITHOUT clearing `HOUGE_AGY_BIN`, so under the gate's inherited env it resolved
  the real path and **red-failed `test`**. That poisoned the gate on EVERY self-write attempt (Codex's 猴哥
  diff was likely fine; the gate never let anything through). Passed locally (my shell lacks HOUGE_AGY_BIN) →
  silent. **FIXED:** `delete process.env.HOUGE_AGY_BIN` in that test → **738 green even with the full daemon env
  set** (audited: only that ONE test was non-hermetic). The Codex "can't write it" + "both writers exhausted"
  conclusions were WRONG — an artifact of the poisoned gate. (Claude's 600s timeout is a separate, real issue.)
- **LESSON (→ lessons.md):** any test asserting a DEFAULT for an env-var-backed config MUST `delete` that var
  first — the self-write test-gate inherits the daemon's runtime env, so a non-hermetic test passes in CI/local
  yet red-fails the gate and silently blocks ALL self-writes. Consider also: run the test-gate under a CLEAN env.
- ✅ **DONE — live gate MET the proper way (2026-06-26, `run_f93782e2` → `3c85328`).** Re-ran over Telegram with
  the gate unpoisoned: Codex wrote in ONE pass → test-gate PASS → kimi PASS → branch → [Merge & reload] →
  merged + daemon self-restarted. **Phase 3.5 COMPLETE.** First fully-autonomous self-write through the whole loop.
- **Open (separate, backlog):** (1) Claude `-p` writer non-termination (no `--max-turns`); (2) **spec-driven /
  self-fix-as-a-skill** — the architectural DECISION (2026-06-26): keep the frozen TS writer prompt for now
  (the writer was never the bottleneck — a poisoned gate was); next guidance step = spec-driven-lite (auto
  acceptance-criteria), already backlogged; promote to a refinable `selfcode` skill ONLY when real self-write
  runs show a recurring procedural failure (skills earn their place from evidence, like Houge's research skills).
  Rails stay deterministic TS forever (skills guide, agent generates, code enforces). (3) the Phase 3.4 LIVE
  thread issues (self-critique leak · location hallucination · date TZ · persona drift) still open.

**BUILD PLAN — `kimi-cli` reviewer backend (Option A, Paco wants the CLI adapter as a reusable asset):**
- [ ] K1. `diff-reviewer.ts`: add `"kimi"` to `ReviewerKind`; `resolveSelfWriteReviewer` recognizes `kimi`
      (default stays `claude`). New `reviewViaKimiCli(task,diff,env)`:
      `kimi-cli --print --quiet --final-message-only --prompt <buildReviewPrompt>` (validated: clean verdict
      JSON, ~7s). Reuse `buildReviewPrompt` + `parseVerdict` (last-balanced-brace scanner handles the trailing
      "To resume…" line). Pass the diff via **stdin** (`--input-format text`) if supported → avoid argv E2BIG
      on large diffs; neutral cwd (no worktree) for independence; restricted DAEMON_PATH.
- [ ] K2. Resolvers: `HOUGE_KIMI_CLI_BIN` (absolute, like CLAUDE/CODEX; unset→"kimi reviewer disabled"
      sentinel), `HOUGE_KIMI_CLI_MODEL` (optional; unset → defer to kimi-cli's own `kimi-for-coding`),
      `HOUGE_KIMI_CLI_TIMEOUT_MS` (default 180000; retry≤2 on timeout/unparseable, mirror the claude reviewer).
      No usage telemetry (final-message-only emits none) — acceptable.
- [ ] K3. Tests: fake kimi-cli bin — assert argv (`--print --quiet --final-message-only`), verdict parse
      (pass/reject), timeout→error, bin-unset→disabled. Mirror the claude/codex reviewer tests.
- [ ] K4. Docs: `configuration.md` (HOUGE_SELFWRITE_REVIEWER=kimi + the 3 kimi-cli vars), `.env.example`.
- [ ] K5. **LIVE gate = finally land the 猴哥 fix** with **Writer=Codex(gpt-5.5 high) + Reviewer=kimi**
      over Telegram → branch + [Merge & reload]. (`.env`: WRITER=codex, REVIEWER=kimi, HOUGE_KIMI_CLI_BIN.)
      Verify: typecheck · npm test · build · deps {}.

## Backlog — spec-driven self-write (ADR-level; tracked 2026-06-26)
- [ ] **Spec-driven self-write** — today the writer+reviewer work from a one-line objective, no spec. As tasks
      grow (new features; self-initiated upgrades) this won't scale: the **spec is the human-control surface** —
      review intent (small) not diffs (large). Direction (extends ADR 0011 §7, "autonomous-to-branch"):
      (1) a **spec stage** before the writer — derive problem · acceptance criteria · interface · **non-goals** ·
      test plan; (2) **gate the spec by complexity/risk** (reuse the intent classifier) — trivial fix skips it,
      feature/self-upgrade surfaces the spec to Paco BEFORE code; (3) writer implements **against the spec**,
      reviewer checks **diff-vs-spec** (sharper, not costlier), a **required** net-new test ENCODES the spec
      (AGENTS.md rule 9). Caveats: keep it **proportional** (no bureaucracy on one-liners); **spec quality
      becomes the new bottleneck** → the spec itself needs adversarial review / Paco approval on high-stakes
      (bad-spec-in = confidently-wrong-out with a green check). **Phase-1 entry point** = lightweight
      auto-derived acceptance criteria (sentence → 3–4 checkable bullets fed to writer+reviewer), then formalize
      the full model as its own ADR/phase.

---
# Phase 3 — code self-write (gated) — DESIGN LOCKED, SPIKE PENDING (2026-06-25) — ADR 0011 §7

Spec: `docs/superpowers/specs/2026-06-25-phase3-code-self-write.md` (source of truth + the §7 security
review). **No `/goal` yet** — design discussed + locked; spike-then-decide, then `/goal` the build.

**Decisions locked with Paco (2026-06-25):**
- Write scope = **deny-list** (freedom-over-control; everything improvable except the protected surface).
- Protected surface = **HARD DENY**, not `/approve`-overridable + **tracked & surfaced** (never silent).
- Test integrity = **net-new tests only** (existing `tests/` immutable; status `A` allowed, `M/D/R` denied).
- Reviewer (checker 3) = **Claude** (model diversity) — **spike-gated**; Codex-independent-session fallback.
- **NO synchronous `/approve` gate** (2026-06-25) — Houge runs/evolves autonomously to a branch; Paco is
  **notified, not a blocking gate**. Justified: a branch is reversible; `/approve` is for irreversible
  actions only. **§5 untouched** — daemon never hot-swaps; the human checkpoint = pull-based `git merge`.
  Deviates from ADR §7's `/approve` → recommend an ADR amendment. Dashboard = backlog (Telegram notify now).
- Daemon **never hot-swaps**; diff → branch → **Paco merges + reloads at leisure** (§5).

**Check stack (writer ≠ checker):** Codex(write) → ①protected-path(hard-deny) → ②test-gate(typecheck+
test+build) → ③Claude review(adversarial) → **auto-publish branch + notify Paco** → Paco merges+reloads.
Refine ≤3 (§6). 3 automated checkers run autonomously; no human in the synchronous loop.

**Live fixture:** Houge fixes the 猴哥 classifier bug himself (kept unfixed on purpose for this).

**S0 SPIKE DONE 2026-06-25 → GO** (`scripts/spike-claude-reviewer-p3.mjs`; result in spec "Spike RESULT").
Claude CLI print mode (`claude -p`) works headlessly under the daemon's restricted PATH via **absolute
bin** (build needs `HOUGE_CLAUDE_BIN`, like `HOUGE_CODEX_BIN`). Discriminates cleanly: GOOD→pass (29s),
BAD→reject (7s) — caught the no-op fix AND the deleted test. Subscription (cheap). API path = documented
fallback (key is empty placeholder); Codex-session = no-Claude fallback.

**BUILD IN PROGRESS (2026-06-25, `/goal` active).** Subagent orchestration; independent verifier's
primary mandate = the security invariant (prove no diff can reach a protected path).
- [x] S1. `src/capabilities/self-write-guard.ts` — hard-deny guard, **60 tests**, 7 bypass classes defended
      (path-norm, segment-boundary, rename/symlink/type-change, case-insensitive, fail-closed, self-protect).
- [x] S2. `src/run/test-gate.ts` — `runTestGate(worktree)` typecheck→test→build, capped 8KB, timeout. 8 tests.
- [x] S3. write-mode Codex adapter in coding-agent.ts — `buildCodexWriteArgs`/`createSelfWriteCodexAdapter`
      (`workspace-write`, no-bypass; caller owns worktree). 11 tests; read-only path intact (13).
- [x] S4. `src/capabilities/diff-reviewer.ts` — `reviewDiff` Claude CLI (spike pattern) + Codex fallback;
      `resolveClaudeBin` no bare default. 16 tests.
- [x] S5. route+contract+notify+tracking — `runSelfWrite` (frame→worktree+symlink node_modules→write-Codex→
      guard→test-gate→Claude review→refine≤3→publishBranch+notify), `compileCodeSelfWriteContract`,
      deterministic write-intent sub-route (default diagnose), `self_write_published/blocked/failed` events,
      `branch-publish.ts`. **npm test 530 green · typecheck clean · build OK · deps {}**. (S5 also fixed
      pre-existing strict-tsc errors in self-write-guard.ts — verifier to scrutinize.)
- [x] S6. config + docs + ADR amendment — configuration.md (5 new env vars), README Phase 3 section,
      ADR 0011 "Amendment (2026-06-25)" (autonomous-to-branch; checkpoint = merge, not /approve).
- [x] S7. gates + independent adversarial verification — **VERDICT: PASS.** 72 adversarial diffs all
      deny-correctly + segment-precision allows safe siblings; non-null assertions clean (length-guarded);
      8/8 orchestration invariants PASS (hard-deny never publishes, worktree always torn down on throw,
      mode-aware diff fails closed, refine ≤3, flag off-default, publishBranch never touches live tree,
      contract forbids shell/destructive/paid). No HIGH/MED. **npm test 606 · typecheck · build · deps {}.**
      Post-verify defense-in-depth: added `run-ledger.ts` (audit) + `local-project-write-adapter.ts` to the
      protected list; guard 132 green, full suite 606 green.
- [x] S8. **LIVE gate — PASS** (`scripts/live-selfwrite-p3.mjs`, REAL chain pi→kimi + Codex + Claude).
      **POSITIVE:** Houge fixed the 猴哥 bug HIMSELF, autonomously — root-caused that `buildIntentSystemPrompt`
      bypassed `composeSystemPrompt` (which loads houge.md identity), routed the intent prompt through the
      composer (+ a `discipline` option, backward-compat overloads, injectable test clock), and WROTE A
      NET-NEW TEST. Protected ✓ · tests ✓ · reviewer pass → branch `houge/selfwrite/run_48db7150…` published
      + 🐒 notification. Branch tree clean (no node_modules). **NEGATIVE:** "change the Codex timeout in
      coding-agent.ts" → Codex edited a PROTECTED file → HARD-DENY surfaced ("yours to make — I can't edit my
      own safety surface"), nothing landed. Proven on multiple runs.
      **Live-surfaced fixes (this session):** (1) reviewer parse was greedy `{...}` → broke on real diffs;
      replaced with a string-aware balanced-brace scanner taking the LAST valid verdict (+ case-insensitive).
      (2) reviewer pinned to `sonnet` (--model) + tools denied + retry≤2 ×180s (Opus over-thought; CLI
      throttles under burst). (3) `publishBranch` excluded the test-gate's `node_modules` symlink (`.gitignore`
      `node_modules/` dir-pattern misses a symlink FILE). **Claude reviewer PROVEN end-to-end** (run byxr2s1zs)
      AND is the default; under heavy burst it rate-limits → `HOUGE_SELFWRITE_REVIEWER=codex` is the reliable
      fallback (used for the final clean run). npm test 613 · typecheck · build · deps {}.

**PHASE 3 COMPLETE.** All gates met. Deliverable branch `houge/selfwrite/run_48db7150…` awaits Paco's review+merge.

## Phase 3.1 — per-role writer/checker flags + real LLM telemetry — DESIGN + SPIKES DONE (2026-06-25)
Spec: Phase-3 spec "Phase 3.1" section. **Decisions:** full `llm_call` ledger (all calls: codex/claude/
kimi) + per-role `.env` flags. **Both spikes GO:** reviewer (`spike-claude-reviewer-p3.mjs`) + writer
(`spike-claude-writer-p3.mjs` — claude `-p --permission-mode bypassPermissions --output-format json`
edited a file headlessly in 15s, clean diff, usage captured).
- `HOUGE_SELFWRITE_WRITER` (codex|claude, default codex) + `HOUGE_SELFWRITE_REVIEWER` (claude|codex,
  default claude). Paco's case: WRITER=claude / REVIEWER=codex (heavy writer load on Claude Max 5x).
- Telemetry retires the hand-grep + lands backlog #3 (LLM telemetry) + feeds dashboard (#10).
- Security unchanged: guard is writer-agnostic (checks the diff), both writers confined to the worktree.
**3.1 BUILD IN PROGRESS (2026-06-25, `/goal` active).** Subagent orchestration.
- [x] W1. `SelfWriter` abstraction (`runSelfWriter` → {provider,model,usageRaw}) + `HOUGE_SELFWRITE_WRITER`
      flag + `resolveClaudeWriterModel`; codex writer emits `--json` for usage. 37 scoped tests.
- [x] W2. `llm_call` ledger event + `recordLlmCall` + `llm-usage.ts` (normalizeClaude/CodexUsage) + reviewer
      returns usage + kimi/pi `onUsage` seam. No bodies recorded (verified). npm test 647.
- [x] W3. wire writer flag into `runSelfWrite` (registered `coding_agent_cli` adapter dispatches via
      `runSelfWriter({writer: resolveSelfWriteWriter(env), ...})`, surfaces provider/model/usageRaw out of
      runSelfWriteCapability) + record writer/reviewer llm_call (latency measured; normalize-null skips, never
      crashes) + cheap-chain classify+answer telemetry via construction-time `onUsage` on createLlmAnswerAdapter
      (NOT through capability input — runner canonicalizes it; instrumented only when default adapter in use) +
      usage_summary {writer,reviewer:{provider,model,total_tokens,cost_usd?}} on self_write_published (no bodies) +
      soft-warn same-provider (non-fatal). frame role DEFERRED (self-write framing is deterministic, no LLM call).
      typecheck+build clean; npm test 652 (647 + 5 new).
- [x] W4. config + docs (configuration.md flags + llm_call event, README 3.1) + **backlog #3 (LLM telemetry) DONE**.
- [x] W5. independent verification **VERDICT PASS** — guard writer-agnostic (claude diff→protected hard-denied),
      claude bypass confined to worktree (cwd, no --add-dir), telemetry leaks no bodies (fake sk-SECRET test). +3 tests.
- [x] W6. **LIVE gate — primary config PASS.** `WRITER=claude/REVIEWER=codex` → **PUBLISHED** branch
      `run_4c0f99f0` + per-role telemetry (writer claude ~737K incl cache $0.66 / reviewer codex ~218K). Negative
      hard-deny proven. Reverse config (`WRITER=codex/REVIEWER=claude`): both halves confirmed in 3.1 (codex
      writer ~1.2M telemetry; claude reviewer parses+usage standalone 12s) + published in Phase 3 (byxr2s1zs);
      a fresh end-to-end reverse publish was blocked by BOTH subscriptions rate-limiting after this session's
      heavy usage (environmental, not code) — re-run `HOUGE_SELFWRITE_WRITER=codex HOUGE_SELFWRITE_REVIEWER=claude
      node scripts/live-selfwrite-p3.mjs` when un-throttled to see it publish.
      **Live-surfaced fixes:** (1) Claude WRITER own timeout `HOUGE_CLAUDE_WRITER_TIMEOUT_MS` default 600000;
      (2) codex reviewer parse — pull `agent_message` text + verdict from real `--json` stream; (3)
      `normalizeCodexUsage` handles real `turn.completed.usage` stdout schema; (4) codex writer `usageRaw`
      filtered to usage lines (full --json stream blew the 200KB capability limit); (5) `normalizeClaudeUsage`
      input_tokens now cache-INCLUSIVE (comparable to codex; was undercounting ~700K); (6) writer framing =
      backward-compat guidance + existing-test-edit deny is REFINABLE (writer mistake) while gate/identity/deps
      deny stays terminal escalation.

**PHASE 3.1 COMPLETE.** Build gates green (659 tests · typecheck · build · deps {}); verification PASS; primary
live config published with per-role telemetry. Swappable writer/reviewer flags + real llm_call telemetry shipped.

## Phase 3.3 — interactive Telegram merge controls + §5 amendment — DESIGN + SPIKE GO (2026-06-25)
Spec: Phase-3 spec "Phase 3.3" section. **Sequenced FIRST** (before 3.2) per Paco — it's the payoff
(Houge self-updates, Paco approves from phone). **§5 amended:** human gate PRESERVED but MOVED to
Telegram — daemon merges+reloads ONLY on Paco's authenticated tap, never on its own; guard is the real
floor (unreachable dangerous surface); a merge is reversible. **Branch model = main** (rollout prereq:
merge feat/learning-v1→main + repoint daemon, by hand, once).
- Telegram callback infra (NEW — none today): inline [View diff]·[Merge & reload]·[Discard] +
  callback_query in (auth'd to Paco only) + answerCallbackQuery/editMessageReplyMarkup.
- [Merge & reload]: git merge→main · npm run build · **re-run test-gate (red→auto-revert, no restart)** ·
  durable "reloading" notif · **detached `launchctl kickstart` self-restart** · optional push (HOUGE_SELFWRITE_PUSH).
- **M1 SPIKE GO** (`scripts/spike-self-restart-p3.mjs`): throwaway launchd service self-kickstarted →
  relaunched, 2 distinct PIDs; live daemon untouched. Detached-kickstart pattern works.
**3.3 BUILD IN PROGRESS** (2026-06-25, `/goal` active, branch `feat/merge-controls` off main).
- [x] M1. self-restart spike GO (`scripts/spike-self-restart-p3.mjs`).
- [x] M2. Telegram callback infra — `callback_query` in (auth'd to allowlist only), `parseSelfWriteCallback`,
      notification `buttons`, `answerCallbackQuery`/`editMessageReplyMarkup`, allowed_updates. 48 tests. M4 seam ready.
- [x] M3. `self-write-merge.ts` — viewDiff/discardBranch/mergeAndReload (DI deps); order guaranteed
      (notifyDurable before restart; build/test red → resetMerge, never restart). 16 tests.
- [x] M4. shared `handleSelfWriteAction` (both poll consumers) + notifyDurable→outbox (before restart) +
      3 buttons on publish notification + idempotency (clear-buttons-first). Caught+fixed M3's real tsc bug
      (execFile→`spawn` detached). **npm test 697 · typecheck · build · deps {}**.
- [x] M5. ADR 0011 Amendment 2 (merge checkpoint → Telegram, still human-gated) + config (HOUGE_SELFWRITE_PUSH,
      HOUGE_DAEMON_LABEL) + configuration.md/README docs.
- [x] M6. independent verification **VERDICT PASS** — 7 mandates (callback auth floor; post-merge-red→auto-revert
      no-restart; notifyDurable-before-restart; idempotent double-tap ×3 layers; restart detached+inert in tests;
      guard untouched; discard-only-deletes). +2 tests. npm test 699.
- [x] **LIVE gate — PASS** (`scripts/live-merge-controls-p3.mjs`, REAL git/npm/launchctl on THROWAWAY targets;
      live daemon untouched). A: green merge → reloaded, main updated, notifyDurable fired, throwaway service
      SELF-RESTARTED (detached kickstart). B: post-merge test RED → reverted, main unchanged, NO restart. C:
      discard deletes the branch. **Live gate CAUGHT A REAL BUG the units missed**: `mergeAndReload` passed the
      branch name `into` to `testGate` → ran npm with cwd=<branch> → ENOENT → EVERY merge would falsely revert.
      Fixed: `testGate()` is bound to the deps' project dir (no-arg, like `build()`). + regression covered.

**PHASE 3.3 COMPLETE.** Build gates green (699 tests · typecheck · build · deps {}); verification PASS; live gate
PASS on real infra. Telegram [View diff]/[Merge & reload]/[Discard] buttons ship the self-evolution loop:
Houge self-writes → Paco taps Merge → daemon merges main + verifies + self-restarts onto new code. §5 human gate
moved to Telegram (not removed). Branch `feat/merge-controls`; merge to main + reload to go live (bootstrapping
merge is manual — the button then handles future merges).
Then Phase 3.2 (rate-limit/cost) after.

## Phase 3.2 — provider error surfacing (rate-limit/quota) + per-run cost — DESIGN DONE (2026-06-25)
Spec: Phase-3 spec "Phase 3.2" section. **Motivation:** a Codex 5h-window quota exhaustion surfaced as a
cryptic "exited non-zero (status 1)" — the adapter discarded the CLI's stderr (the real reason).
**Decisions:** (A) capture stderr + classify rate_limit/auth/timeout/generic → actionable notification
("switch HOUGE_SELFWRITE_<ROLE>=<other> or wait"); (B) per-run token+cost line on the notification;
**notify-only, NO auto-fallback** (Paco flips the flag); (C) token budget cap deferred. No spike.
**NEXT: `/goal` the 3.2 build** (E1 classifier · E2 capture stderr in adapters · E3 runSelfWrite notifications
+ cost line · E4 docs+gates+verification). Constraint: `detail` carries NO secrets (redact token-like).

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
# Goal — Phase 2c: Gate B anchor verifier + gated auto-author (IN PROGRESS 2026-06-22) — ADR 0011 §3/§6

Spec: `docs/superpowers/specs/2026-06-21-phase2-skills.md` (Phase 2c / Spike RESULT / Blocked auto-author path).
`/goal` active. Build via subagents. Spike PROVED: 3-pass static-grade Gate B separates good (0.28–0.89) from
bad (≤0.06); reuse `scripts/spike-gateb-2c.mjs`'s validated GATE_B prompt. **Constraints: zero deps; Gate B
IGNORES the skill's own frontmatter anchors (independence); writes confined to `skills/` incl. `_pending/`.**

## Build — staged (each green), via subagents
- [x] S1. `src/capabilities/anchor-verify.ts` — `verifySkill` (3-pass, INDEPENDENT procedure-level criteria
      from the spike's prompt; tolerant parse, never throws). `GATE_B_DISCIPLINE` + HOUGE_GATE_B_* resolvers. + tests.
- [x] S2. `SkillStore`: `writePending`/`listPending` (`skills/_pending/`, same boundary check); `_pending`
      excluded from `listScopes`/`readScopeBlock`/`list`/cap; `setFrontmatterFields` (score+last_verified). + tests.
- [x] S3. `runSkill` wiring: author → Gate B (3-pass). commanded→ADVISORY (write+stamp+report, ⚠ if low);
      auto→BLOCKING+GUIDED-REFINE ≤3 → pass keep / still-fail park+lesson+report. Real Gate B line. + tests.
- [x] S4. Auto-author from distill flag: clear procedure flag → auto-author (origin=auto) blocking+guided-refine
      → surface report every attempt; a plain tweak stays a lesson. + tests.
- [x] S5. `/skills pending` viewer (gateway lists `listPending`; parser already accepts the scope slot). + tests.
- [x] S6. Config + docs (configuration.md Gate B section + README). `.gitignore /skills/` covers `_pending`.
- [x] S7. Gates: typecheck clean · **npm test 428 green** · build OK · deps {} · evals/ unchanged · spike GO (+0.28).
      Independent verification: **1 HIGH bug FOUND + FIXED** — auto-authored skill was PARKED on a Gate B *error*
      (unscored), not just on a real low score (infra flakiness would destroy good skills). Fix: `unscored` →
      advisory-write (never block on error), matching the method's contract + new regression test. 2 nits fixed
      (stale doc comment, redundant "low score" text). All 9 other invariants PASS.
- [x] S8. LIVE gate — Gate B PROVEN live over REAL Telegram. Leg 1 (sound skill "evaluate research-source
      credibility") → **Gate B ✓ passed 0.78** vs 0.15 (3-pass), real report line (replaced "deferred to 2c"),
      frontmatter stamped `score: 0.78`/`last_verified`. Leg 2 (Gate-B-LOW-on-commanded): **empirically
      UNREACHABLE live** — Gate A caught all 5 deliberately-weak skills (trust-first ×2, popularity ×1,
      peer-review-only ×1, + the first 2b-style) and down-routed each to a sensible auto-lesson; none reached
      Gate B. The engineered "grounded-but-shallow" (peer-review-only) was caught too. So Gate B's low-score path
      is proven by **unit test (commanded-low → ⚠) + spike (bad ≤0.06)**, not live — Gate A is too good. The
      blocking+guided-refine+park + auto-unscored-fallback paths are harness/test-verified. **2c effectively
      DONE** (live gate's intent met: Gate B distinguishes good/bad over real Telegram; pass live, reject live via A).

---
# Goal — Phase 2b: skill authoring (on-command) + Gate A + reporting (DONE 2026-06-22) — ADR 0011 §2/§4

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
- [x] ~~**Code-write capability (gated)**~~ → **SUPERSEDED by Phase 3** (`docs/superpowers/specs/2026-06-25-
      phase3-code-self-write.md`). Design evolved: NOT `/approve`-gated (autonomous-to-branch + notify;
      human checkpoint = §5 merge). Deny-list write scope; hard-deny protected surface; net-new tests only;
      Codex-writes/Claude-reviews check stack. See the Phase 3 section at the top of this file.
- [x] ~~**LLM telemetry**~~ → **DONE (Phase 3.1)**: realized as the `llm_call` ledger event
      (`RunStore.recordLlmCall`, `src/run/run-store.ts`) — provider/model/role/in+out+cached tokens
      (+ optional cost_usd, latency_ms), counts/metadata only. Optional OTel export not done.
- [ ] **LLM-for-research model fit** — runtime chain is coding-tuned (`pi=kimi-for-coding`,
      `kimi-k2.7-code-highspeed`); pi over-produces on research synthesis. Add a general model for the
      research/answer surface (the chain is already pluggable). Also: still confirm #5's full Telegram sequence.
      ⚠ **RECURRED LIVE 2026-06-26** (daemon on main cd9c1f7, PID 37553): real Telegram research query
      "猴哥，今天和周末的天气如何，适合骑车吗" → `run_8672b6fb` → web_search ✓ then run_FAILED:
      `pi: output exceeded 262144 byte cap` + `kimi-api: Kimi response missing message content`. So LIVE-FIX-1's
      kimi max_tokens bump did NOT cure it — pi STILL blows the 256KB cap on research synthesis (root cause
      open) and the kimi-api fallback returned empty again. Simple chat is fine; only research/synthesis breaks.
      Likely real fix: route research synthesis to a general (non-coding) model. (Tie-in: Phase 3.2's provider
      error surfacing would at least make this VISIBLE instead of cryptic.)
- [ ] **Silent turn failures (NEW, surfaced live 2026-06-26)** — a FAILED run sends NO Telegram reply
      (notification_outbox empty for `run_8672b6fb`), so the user sees nothing — looks like Houge is dead when
      he actually errored. Add a failure-notification path: on `run_failed`, always send a short "I hit an error
      on that one: <reason>" so failures are never silent. High-value, small. (Pairs with Phase 3.2.)
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
- [ ] **Skill-content viewer `/skills <name>`** (surfaced 2026-06-22, live) — there is NO way to read back an
      authored skill's BODY: `/skills` shows metadata only (`formatSkillsText`), and `selfcode` can't see skills
      (they're gitignored runtime, excluded from the Codex worktree-of-HEAD by construction — Phase 1's
      secret-exclusion property). When Paco asked "show me the skill you wrote", it (a) misclassified as
      `selfcode` and (b) Codex couldn't find it in the committed tree. Fix: `/skills <name>` (or `/skill <name>`)
      → display `when` + anchors + procedure body from the live file. **Lookup = slug-normalized + forgiving:**
      canonical id is the kebab `name` (= filename stem, what `/skills` lists), but run the user's input through
      `sanitizeSlug` so BOTH `ai-weekly-industry-news-report` AND "AI weekly industry news report" resolve;
      cross-scope collision → accept `<scope>/<name>` or list matches; not-found → closest/fall back to list.
      (Optional later: a `title:` frontmatter field for a stable human display name distinct from the id.)
      Also: classifier should route "show me my
      X skill / the skill you wrote" to the skill VIEW path, not `selfcode`. Insight: "read your own CODE"
      (selfcode/Codex on HEAD) and "read your own LEARNED SKILLS" (runtime `skills/`) are distinct paths —
      selfcode structurally can't introspect runtime state, by the same isolation that keeps secrets out.
- [ ] **Skill dedup / name normalization** (surfaced 2026-06-22 in 2b live test) — authoring the SAME
      conceptual skill twice with slightly different wording yields TWO files because the cheap writer derives
      a different kebab `name` each time (`fact-check-viral-claim` vs `viral-claim-fact-check`); the refine path
      only triggers on exact name match. Result: semantically-duplicate skills accumulate in a scope (noisy,
      eats the ≤4 cap). Fix options: a pre-write semantic-dedup check (does an existing skill cover this
      `when:`? → refine instead of create), or canonical-name normalization. Natural fit alongside 2c's
      Gate B / consolidation pass. Not a safety issue (containment holds); a quality/precision nit.
- [ ] **Self-write observability dashboard** (surfaced 2026-06-25, Phase 3 design) — a read-only view over
      the `self_write_published / blocked / failed` run-store events: what Houge tried to change, which gates
      passed, what branches are awaiting merge, every time he reached for the protected surface. Telegram
      notification covers the immediate observe-need; the dashboard is the richer "watch him evolve" layer.
      No new write surface (reads existing events). Pairs naturally with the scheduler/autonomy axis below.
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

---
## Phase 3 / S5 — code-self-write INTEGRATION (build-time, this session)

Wired the autonomous check stack into Houge's selfcode route. New/changed:
- `src/contracts/task-contract.ts`: `compileCodeSelfWriteContract` (allows coding_agent_cli + llm_answer + write_report; forbids shell/destructive/paid/external_write; no new approval gate; 60min / 4 tool calls).
- `src/capabilities/intent.ts`: `resolveSelfWriteEnabled` (HOUGE_SELFWRITE_ENABLED, DEFAULT FALSE) + `classifySelfcodeMode` (deterministic write/diagnose, default diagnose; EN+中文 verbs).
- `src/run/branch-publish.ts` (NEW, protected): `publishBranch` / `selfWriteBranchName` → `houge/selfwrite/<run-id>` (checkout -b + add -A + commit in the worktree's shared .git).
- `src/run/run-ledger.ts` + `src/run/run-store.ts`: `self_write_published` / `self_write_blocked` / `self_write_failed` events + recorder methods.
- `src/core/core-worker.ts`: `runSelfWrite` orchestration (worktree → node_modules symlink → write-Codex → guard(HARD DENY) → test gate → reviewer → publish; refine ≤3 total; always teardown) + `SelfWriteDeps` injectable seam + the selfcode write/diagnose dispatch branch.
- Fixed pre-existing S1 strictness errors blocking the typecheck gate (self-write-guard.ts non-null asserts + its test).

Tests added (+13): contract shape, write-intent classification, runSelfWrite happy/hard-deny/test-red/reviewer-reject/flag-off, branch-publish fixture.
Gates: typecheck clean · npm test 530 pass · build OK · dependencies:{} unchanged.
Remaining: S6 (config docs + .env) · S7 independent adversarial verify · S8 LIVE gate.
