# Sessions

## 2026-06-20 — Self-evolution: philosophy reframe, ADR 0011, Phase 1 (code self-diagnose) LIVE

Branch `feat/learning-v1` (3+ commits ahead of main; Houge runs from this branch's `dist/`, not main).

- **Philosophy reframe (commit 51a7395):** dropped the 紧箍咒/cage/"immutable constitution" framing across
  ADRs 0005–0010 + chatops spec + `houge.md` → **core principles held as character** (intelligence-over-control).
  It is OK for Houge to fail; gates are safety nets, not a cage. (Paco's repeated correction → memory saved.)
- **Research:** studied **yoyo-evolve** (harness-owns-the-self, frontier-model-as-muscle; cautionary un-gated
  auto-merge) and the **OPENSKILL** paper (arXiv 2606.06741 — self-built verifiers anchored to world-facts solve
  ADR 0007's "least-solved" subjective eval gate; world-fact skills transfer across models).
- **ADR 0011 + Phase 1 spec (commit eb17b1e):** self-evolution architecture — three evolvable layers
  (code/skills/lessons), lightest-form routing rubric (+4 skill tests, ask-when-unsure), dual eval gates
  (tests for code / OPENSKILL anchors for skills) routed by a gap-vs-bug classifier, **Codex as rented swappable
  `coding_agent_cli` muscle**, worktree isolation.
- **ADR 0010 build closed (commit 25b3568):** committed + pushed; **live gate CLOSED** (#5 feedback→distill→
  /lessons over real Telegram on pi→kimi).
- **Phase 1 — code self-diagnose, BUILT + VERIFIED + LIVE (commit 7bcaa65).** `selfcode` intent → `runSelfDiagnose`
  → `codex exec --sandbox read-only` in a git worktree of HEAD (secret-exclusion by construction) → relay.
  Built via build+verification subagents (358 tests, independent PASS 9/9, containment airtight). **LIVE:** Houge
  read his own source via **real Codex** (`report Sources: coding_agent_cli:codex`) and correctly diagnosed the
  猴哥 bug (router prompt lacks identity; bypasses the composer) — the self-evolution vision's first light. The
  猴哥 bug stays unfixed as the fixture. `HOUGE_CODEX_ENABLED=true` (+ `TIMEOUT_MS=300000`) in `.env`; daemon PID 71157.
- **Next:** Phase 2 (skills) design discussion; Phase 3 (gated code self-write) would let Houge fix the bug himself.

## 2026-06-19 — Learning v1 (prompt composer + /teach + STORM self-critique)

Built the learning loop's runtime spine (per the learning-mechanism v1 spec; ADRs 0007/0009,
0006 amendment). Branch `feat/learning-v1`.

- **Prompt composer** (`src/prompt/composer.ts`): single place assembling every system prompt =
  Core Identity (`memory/core/houge.md`, loaded not duplicated) + per-surface discipline +
  learned lessons (`memory/skills/<scope>.md`) + guardrails. `/ask` and `/research` both source
  from it; the old hardcoded persona constants are gone (`llm-answer.ts`, `web-search.ts`).
- **Lesson store** (`src/memory/lesson-store.ts`): inspectable per-scope markdown; append/read.
- **`/teach <scope>: <lesson>`**: parser variant → `teach` event → `Gateway.handleTeach`
  (control command, no run/budget, idempotent) appends + acks `Learned ✓`. High-trust:
  activates immediately; next matching run applies it.
- **STORM self-critique**: web-research synthesis now followed by a `research-critique` pass
  (grade figures/weakest-claims/source-bias → corrected answer; best-effort).
- gitignore: `memory/{skills,user,wiki,journal}/` runtime; `memory/core` committed.
- Docs: README "Learning" section + configuration.md composer/teach/critique.

Gate: typecheck clean · test 272/272 · build OK · zero runtime deps. LIVE
(`scripts/live-learning-v1.mjs`, real Gateway + CoreWorker + pi/kimi + Tavily): a
`/teach`-taught `🐒 Houge-confidence:` trailer was absent pre-teach and present post-teach
in real `/research` output. Telegram transport leg was event-equivalent (harness can't type
into Telegram); every other leg live.

## 2026-06-26 — Phase 3.4: Gemini chain legs (research-model-fit + silent-failure)
Fixed the recurring research-synthesis silent failure (run_8672b6fb: pi over-cap + kimi empty →
no reply). Root cause = cheap chain was 100% coding-tuned. Added two GENERAL-model legs in Paco's
order: chain `pi → agy-cli → kimi-api → gemini-api`.
- NEW providers: `agy-cli` (Antigravity CLI `--print`, Gemini 3.5 Flash; injection-safe argv prompt,
  restricted env, no --dangerously-skip-permissions) + `gemini-api` (Google OpenAI-compat, gemini-3.5-flash).
- Refactors (DRY, surfaced + approved): shared `openai-compat.ts` factory (kimi+gemini) and
  `cli-spawn.ts` (pi+agy). Both preserve public surfaces → all prior tests green.
- G5 silent-failure: `enqueueFailureNotification` + `failWithPartialReport` always replies
  "I hit an error on that one: <reason>". One terminal notification per run (success XOR failure).
- Gate: typecheck · npm test 725 · build · deps {}. Independent adversarial review PASS (no HIGH/MED;
  LOW-1 auth-marker false-positive on general prose FIXED). LIVE evidence (scripts/probe-chain-p34.mjs,
  live-gemini-chain-p34.mjs): full e2e turn completed on the exact query; fall-through PROVEN (pi
  forced-fail → agy-cli serves synthesis 6.8s); gemini-api 5.0s & agy-cli 8.1s each synthesize; agy
  auth survives the daemon's restricted env. Daemon reloaded PID 46231 on the 4-leg chain.
- NOT committed (working tree on main, uncommitted). Literal Telegram round-trip = Paco's 1-line send.

## 2026-06-26 — STRATEGY: Houge direction locked (autonomy + spine + model economics)
Diagnostic + strategy session, NO code shipped. Started from Paco asking to double-check live Telegram
interactions; root-caused the frustration loop (Houge offers actions — "查IP?"/"open a browser?" — it
has NO tool for: `pi --no-tools` strips bash, every contract forbids `generic_shell`, only web_search/
llm_answer/read-only-codex/file_read are wired).
- Researched (4 subagents, primary sources) how OpenClaw, Hermes (NousResearch/hermes-agent), and
  industry agents (Claude Code/Codex/Cursor/Devin/OpenHands) + GitHub agent-browsers (browser-use,
  Skyvern, Stagehand, playwright-mcp, Browser MCP, Steel, Hyperbrowser) grant + CONTAIN capabilities.
  Verdict: all are single-LLM tool-loops contained DOWNWARD (sandbox+allowlist+approval); Houge is the
  inverse (tools stripped, re-added upward via orchestrator+contract gates) → already the safer substrate.
- Internet capability decided: add narrow `http_fetch` (= Claude WebFetch analogue; static tier; JS/
  iframe = browser tier, deferred). Safety = Posture A + IP-block floor: allow any PUBLIC URL, hard SSRF
  IP-block (resolve-and-PIN, block private/loopback/metadata, no redirects, GET-only, caps). Spec written
  = todo.md "Phase 3.6" (gates H1–H7, awaiting /goal). Threat map: IP-block→SSRF; ADR0006 wall +
  tools-disabled LLM→prompt injection; read-only GET→mutation; exfil-to-public = accepted residual.
- STRATEGIC DIRECTION LOCKED (todo.md "Houge STRATEGIC DIRECTION" section). 4 forks: full-autonomy+nets
  (reverses approve-before), spine-first, defer money, best-model-per-capability (reverses never-Claude-
  at-runtime). Mechanical safety-net floor now REQUIRED (auto-rollback / kill-switch / secrets firewall /
  self-regression eval / metered-API ceiling). Model routing = flat-rate CLIs first (Kimi/pi · Gemini/agy
  · Claude/Max-CLI · Codex/Plus), metered APIs capped fallback; ⚠ Max quota shared w/ Paco's interactive
  Claude → must yield. Spine reframed = CLOSED EVAL LOOP (not memory-as-king); build a THIN vertical slice
  first. Embeddings dep → default local.
- PAUSED: Paco has memory + self-evolution PAPERS/REPOS to discuss tomorrow (2026-06-27) BEFORE specing
  the spine. Working tree still has the uncommitted composer.ts research-critique edit from a prior session.

## 2026-06-27 — SPINE DESIGN LOCKED: ADR 0012 + spine spec (papers session; Houge self-wrote LIVE)
Design session, NO product code shipped by Claude. 5 papers read in full via research agents (MOSS
2605.22794, Strategy Genes 2604.15097, AtomMem 2606.19847, DCPM 2606.09483, AI-Meets-Brain survey
2512.23343). Convergent finding: 3/5 SOTA memory systems have NO eval loop; the 2 that close it rely on
an executable verifier → confirms "memory=keystone, eval loop=engine".
- Decisions 1–4 LOCKED with Paco (signal = explicit 0–3 rating + reuse-value, no LLM-as-judge; 4 memory
  types incl. NEW LLM Wiki + conversational-episodic; thin slice = shared loop machinery once, sequenced
  A→B; keep/rollback = supersede chain + post-restart health-probe auto-rollback, hard-failures only,
  gates the human-tap→autonomous merge flip). Key reframe (Paco): internet = LIBRARY, eval loop = REPORT
  CARD — feedback can't be outsourced to the internet.
- Written up: ADR 0012 + docs/superpowers/specs/2026-06-27-spine-self-evolution-loop.md (roadmap ①–⑤,
  build stages + LIVE gate per step). todo.md SPINE section updated.
- MEANWHILE Houge self-wrote LIVE from a terse Chinese Telegram message: 3516dee (composer prompt fix —
  no meta-leak, no language mixing) — beat the hand-written reference in coverage; terse input works, no
  spec-derivation stage needed for small fixes. 2 Phase-3.4 backlog items closed BY HOUGE.
- Also researched Hermes + OpenClaw orchestration (LLM-driven vs code-driven poles); fed ADR 0013 next
  session. Date/TZ bug flagged STILL LIVE.

## 2026-07-02 — ADR 0013 LOCKED: LLM inner composition (inner-loop refactor, step ⓪ of the spine)
Design session, docs only (Step 0 of the refactor; NO code — build awaits /goal per step).
- Runtime survey (2 explore agents): EVERY runtime model call is single-shot text-in/text-out — no tools,
  no loop, no model-chosen next action; routing = 6-way intent enum + WRITE_SIGNALS regex; each evolution
  layer a hardwired pipeline; zero cross-layer composition. Seams found: CapabilityRunner.execute choke
  point, decideCapability, SelfWriteDeps injection pattern.
- DECIDED with Paco: contracts become ENVELOPES; new inner loop (JSON-in-text action protocol, model-
  agnostic, tolerant parse, final-answer default) composes capability steps; every step through
  CapabilityRunner's unchanged gates; typed gate-points = decision gates (block) vs observation hooks
  (attribution = spine A1 for free); evolution layers become loop TOOLS (gates intact inside the tool
  boundary); WRITE_SIGNALS regex dies; FLOOR UNCHANGED (OpenClaw's relaxed-floor episode = the warning).
- Written up: ADR 0013 + docs/superpowers/specs/2026-07-02-inner-loop-refactor.md (steps ⓪·1–⓪·4, flag
  HOUGE_INNER_LOOP_ENABLED, LIVE gate each). Status flips: ADR 0001 (mechanism supplied), 0010 (enum→
  advisory hint), 0012 (roadmap re-sequenced: loop = step ⓪, wiki loop-native); decisions README index;
  spine spec re-sequence note; todo.md INNER-LOOP REFACTOR section.
- NEXT: /goal inner-loop step ⓪·1 (loop engine + turn surface). Everything uncommitted on main.

## 2026-07-02 (later) — /goal inner-loop step ⓪·1 BUILT + LIVE-GATED (ADR 0013 first slice shipped)
Build via build-subagent + independent adversarial verification subagent (main context kept clean).
- Shipped: src/core/inner-loop.ts (step loop, JSON-in-text protocol, tolerant parser, halt conditions,
  InnerLoopDeps), src/core/tool-manifest.ts, src/capabilities/lesson-write.ts; executeTurn flag fork
  (HOUGE_INNER_LOOP_ENABLED, default OFF, legacy enum path = fallback); additive `loop` discipline +
  LOOP_GUARDRAILS in composer (existing surfaces byte-identical); turn contract += lesson_write; ledger
  events loop_started/loop_step/loop_halted + attribution seed; ~50 new tests.
- Verifier: GO; 2 findings FIXED pre-live: (1) pre-existing latent hermeticity bug — legacy clarify-cap
  test env-pinned (would have silently blocked ALL self-writes if HOUGE_MAX_CONSECUTIVE_CLARIFY ever hit
  daemon env); (2) lesson_write trust anchor — feedback/prior_answer now bound to the REAL user message/
  thread (model-supplied poison ignored), scope whitelisted ask|research w/ clamp. Deferred to ⓪·2:
  wall-clock loop halt, parse_cap raw-text cosmetics, HOUGE_ASK_SYSTEM_PROMPT on loop path, injected-
  JSON-echo eval fixture. Gates: typecheck · 789 tests · build · deps {} green (+ hermetic under daemon
  env with flag+clarify+skills exported).
- LIVE GATE MET (run_b4a77b83): flag armed in .env, daemon reloaded PID 10332; Paco's one mixed Chinese
  message (no-lists correction + Sydney weekend weather) → lesson SAVED (ask scope) AND answer DELIVERED
  over Telegram in ONE turn (2 loop steps); the answer already obeyed the just-written lesson.
- NOT committed yet (working tree on main). NEXT: /goal ⓪·2 (evolution layers as tools, delete
  WRITE_SIGNALS) when Paco's ready.

## 2026-07-03 — /goal inner-loop step ⓪·2 BUILT + LIVE-GATED over 3 rounds (evolution layers as loop tools)
Build + independent adversarial verification subagents; each live round found a REAL bug no test caught.
- Shipped (aea7b91): self_diagnose / self_write_propose / skill_author as loop tools (pipelines byte-
  unchanged inside; once-per-turn; manifest lists a tool only when armed); WRITE_SIGNALS regex + 
  classifySelfcodeMode DELETED (model proposes, gates decide; legacy selfcode = diagnose-only);
  code-owned "—— 自我修改状态 ——" failure surfacing past the model; all ⓪·1 deferred items (wall-clock
  halt, parse-cap cosmetics, ASK_SYSTEM_PROMPT parity, echo defense, budget_used real counts).
- Live-round finds+fixes: R1 budget starvation (evolution pipelines drew from the shared 6-call turn
  ledger → fresh sub-ledger per sub-contract, mutation-verified). R2 PRE-EXISTING GUARD BYPASS: checker
  diffs omitted untracked files while publish committed them (net-new files un-reviewable + invisible
  to the guard) → git add -N (node_modules-excluded) before every diff read; security test: new file
  under src/policy/ now DENIED. Also caught: unscoped add -N would register the node_modules SYMLINK
  (dir gitignore pattern misses it) and hard-deny every self-write.
- LIVE GATE MET: R3 run_6e322401 — "直接改代码，把时区的bug修掉" → diagnose → self-write → reviewer
  pass → branch + [Merge & reload] on Telegram; model overrode a wrong "clarify" hint. R1 proved
  lesson+diagnose+proposal composition in one turn. 815 tests green; verifier GO.
- Paco tapped merge before ⓪·2 was committed → Houge's handler refused on the dirty tree (floor
  working); ⓪·2 then committed+pushed (aea7b91). NEXT: Paco re-taps [Merge & reload] to land Houge's
  timezone fix; then /goal ⓪·3 (spine Slice A on the loop).

## 2026-07-03 (later) — Houge's timezone fix MERGED manually; clock bug found live; ⓪·2b hardening scoped
- Paco's early [Merge & reload] tap hit the dirty tree (⓪·2 uncommitted) → handler refused correctly
  but cleared the buttons (UX gap → H4). ⓪·2 committed (aea7b91), then Houge's branch merged MANUALLY
  mirroring mergeAndReload (clean merge, 815 green on merged tree, daemon PID 6771, pushed fd8ffd2,
  branch deleted). Verified live: temporalContext() → "Today's date is 2026-07-03 (Australia/Sydney)".
- NEW LIVE BUG (Paco, 4pm): asked 现在几点 → Houge said 6pm (temporalContext has date+TZ but NO clock
  → model confabulates). Houge responded WELL: tried a self-write (diff died on kimi reviewer timeout
  ×2 — pipeline correctly refused to publish unreviewed), then self-diagnosed the exact root cause;
  but the timeout-truncated turn relayed the diagnosis raw in ENGLISH (best-effort final bypasses
  language lessons).
- Scoped **⓪·2b LOOP HARDENING** in todo (next /goal candidate): H1 reviewer fallback chain on
  unavailable/timeout (kimi→claude→codex) · H2 loop deadline extends by evolution sub-contract
  time_minutes · H3 best-effort final restated in user's language via one reserved compose call ·
  H4 restore buttons on refused merge · H5 = Houge self-writes the clock fix over Telegram as the
  live gate. Duplicate-lesson dedup stays ⓪·3 (reconcile/supersede).
