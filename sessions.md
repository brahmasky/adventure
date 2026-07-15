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

## 2026-07-03 (evening) — /goal ⓪·2b LOOP HARDENING DONE + H5 live gate: Houge closed his own clock bug
- Built H1–H4 (2a64dfb): reviewer fallback chain on unavailable-only (reject terminal — argv-trap
  proven; reviewer_backend attributed in ledger) · evolution deadline extension (per sub-contract:
  30/60/10 min) · fallback finals restated in user's language via unreserved compose (bilingual
  wrapper as last resort; all six halt sites covered) · buttons restored on refused merge
  (merge_conflict/reverted only). 843 tests (+32); verifier GO (4 MINORs parked in todo).
- Paco caught the dirty tree BEFORE the live gate this time → committed pre-tap (lesson sticking).
- H5 LIVE GATE (run_e0b1b673): "把当前时间也加进temporal context" → straight to self_write_propose →
  ONE writer pass (77s) → guard✓ tests✓ reviewer kimi PASS → published in 2m19s → loop halted
  "final" (H2 working — no timeout truncation) → Paco tapped [Merge & reload] → handler merged
  5ae8d5e, gates green, daemon self-restarted PID 35919 → live: "Today's date and time is
  2026-07-03 17:30 (Australia/Sydney)". June-27 date/TZ bug CLOSED end-to-end by Houge himself.
- Pushed main (5ae8d5e), merged branch deleted. NEXT: /goal ⓪·3 — spine Slice A on the loop
  (rating, reconcile/supersede — the duplicate timezone lessons in the ask block are the test case).

## 2026-07-03 (night) — /goal ⓪·2c SELF-WRITE UX DONE + the immutable-literal lesson
- Built U1+U2 (d14ad02): readable [View diff] (stat summary → cleaned per-file head-capped hunks;
  full .patch attached via zero-dep sendDocument when inline loses content; no parse_mode on the
  path so diff content can't fail the send; ≤4096 fuzz-proven) · reload marker + boot confirmation
  (green merge writes sha+subject marker → daemon boot consumes exactly-once → "✅ 重启成功 — 现在
  运行 <sha>「…」" via outbox; stage 1 of ADR 0012 D4). 870 tests; verifier GO.
- LIVE ROUND 1 (run_3dbd8174) = the best failure yet: Houge's header rename was STRUCTURALLY
  IMPOSSIBLE (5 tests pinned the literal; existing tests immutable to self-writes) → writer produced
  the only legal move (parenthetical keeping the substring) → kimi reviewer rightly REJECTED as not
  honoring intent → honest Chinese failure reply. Root cause = OUR test design. Fix 43562ec: export
  EVOLUTION_NOTICE_HEADER, tests assert via constant. LESSON: code-owned user-facing strings must be
  asserted via exported constants or they become un-self-writable.
- Also caught live (run_72230506): ambiguous "改标题" feedback → model saved a LESSON that cannot
  affect a code-owned string and overpromised ("以后我会…"). Paco's point: user shouldn't need to
  know code-vs-memory. → LAYER-ROUTING self-knowledge folded into ⓪·3 (discipline list + lesson_write
  verbatim-in-src refusal + eval-loop escalation). User never needs tool names — natural language only.
- LIVE ROUND 2 (run_083877fe → 5d8b97f): clean 1-line constant change → gates green (kimi pass) →
  readable diff → merge tap → daemon self-restart → ✅ 重启成功 arrived unprompted (both notifications
  delivered 10:34). U4 MET. Houge's sign-off is now "🐒 自我修改进展" — self-written.
- NEXT: /goal ⓪·3 — spine Slice A on the loop + layer-routing (two ready-made live cases queued).

## 2026-07-04 — /goal ⓪·3 SPINE SLICE A DONE + A9 LIVE: first visible compounding
- Built in two staged builds (23540b1, 4023 insertions): S1 per-lesson rows (migration from block
  bullets — rehearsed on a live-DB copy, byte-clean, idempotent, transactional; 14 rows live) ·
  reconcile-on-write ADD/SUPERSEDE/UPDATE/DROP (LLM compare per scope, no embedding dep) · AVOID ·
  layer-routing (discipline + verbatim-in-src refusal) · S2 session rating (lull+substance+cooldown
  ask, bare-digit capture, digit+comment forwards the comment as a real turn — never swallows) ·
  attribution to applied lesson_ids · low-rating culprit pass (accumulate: flag at 1, demote at 2) ·
  reuse_value math · daily decay/prune tick · repeat-supersede escalation. 971 tests; verifier GO;
  3 verifier findings fixed pre-live (rating swallow, conversational-string self-collision, scripts).
- A9 LIVE GATE MET (one session): ask fired unprompted 31s after boot → rating 3 captured →
  "以后所有时间一律用悉尼时间" SUPERSEDED #11 → #15 w/ lineage (COMPOUNDING VISIBLE — the re-learning
  loop closed for the first time) → 标题 feedback: mechanical code-owned refusal → in-turn pivot →
  self-write published → Paco merged → 465cd2b live ("✨ 又偷学了新本事", named + shipped by Houge).
- LIVE MISS recorded (F1): phrase checker reads only the current message — the 22:14 turn (phrase
  two turns back) produced an overpromise with no code path. Fix = thread-scoped phrase extraction.
- NEXT: F1 fix (small) · then ⓪·4 (retire legacy paths) or spine ② episodic memory. The eval loop
  is now LIVE end-to-end: sense→remember→change→evaluate→keep/rollback all have running machinery.

## 2026-07-04 (cont.) — ⓪·3f F1 + polish DONE + LIVE; Houge renamed his own sign-off twice
- Built 3cae47c: F1 thread-scoped code-owned check (user turns only — anti-poison test proves an
  assistant turn carrying the header does NOT refuse) + P1 scope guard, P2 throw-injection test,
  P3 tie-order, P4 deadline-extender coverage. 986 tests.
- LIVE: two-turn shape → model asked direction (no overpromise — improvement over 22:14), then
  "就换成🗡️ 又闯了一关吧" → target recovered FROM THREAD → straight self-write → published →
  merged 4de7523 → ✅ boot confirmed. F1 net = tested backstop; judgment didn't need it live.
- COSMETIC catch: writer swallowed the sentence particle 吧 into the title constant; reviewer
  missed it. One-terse-message fix queued as loop trivia.
- Spine step ⓪ now COMPLETE except ⓪·4 (retire legacy). NEXT: ⓪·4 or spine ② episodic memory.

## 2026-07-04 (day) — first SOAK day: football saga, 3 more Houge self-writes, housekeeping
- World Cup Q exposed: (1) temporal reasoning gap → Houge diagnosed + self-wrote temporalComparisonContext
  (dual-TZ instant + compare rules into research prompts), merged cc5b3c2 after 3 attempts (#2 typecheck
  red, #3 writer timeout — gates honest throughout); (2) digest noise (markdown image junk drowns scores;
  queued as Houge-sized fix); (3) false follow-up promises ("等我确认后告诉你" — NO scheduler exists;
  lesson queued; scheduler capability = future roadmap item w/ own gate design).
- LIVE INCIDENT → ⓪·3g case hardened: single-lane daemon is DEAF during pipelines AND LOSSY (Telegram
  expires unfetched callback taps ~1min — 3 View taps destroyed server-side, zero trace). Queued: off-
  thread pipelines or busy-notice + tap dedupe.
- Housekeeping: 4 stale June branches pruned (2 already-merged debris, 2 obsolete 猴哥-fix attempts —
  the literal ADR 0012 anecdote branches); 吧 particle removed from sign-off title BY HOUGE (1bdbb11,
  merged+reloaded by Paco solo — full circuit needed zero Claude involvement); all selfwrite branches 0.
- Houge self-write count this week: 8 merged. The loop is routine now — Paco runs send→diff→merge→boot
  cycles without orchestrator help. NEXT: soak + ratings; then ⓪·3g or ⓪·4 or spine ②/scheduler.

## 2026-07-04 (evening) — soak continues: lessons compounding live; deep-research ceiling mapped
- No-false-promises feedback landed WELL: lessons #16 (research) + #17 (ask, SUPERSEDES #6 — second
  live supersede) with AVOID "making promises about capabilities you don't have"; Houge's meta-reply
  honest ("等 Paco 帮我写进代码"). Noted: same lesson wrote to two scopes — reconcile is within-scope
  only (small v1 limit). First reply clunky ("你是指哪个问题?") = thread-context shallowness → ② case.
- Deep investment research ask ("多方查证做综合报告") hit the true CAPABILITY CEILING: snippets-only
  (no ③ http_fetch), 6-call/10-min turn envelope, no background jobs, no durable synthesis (④ wiki's
  designed demo). Houge declined HONESTLY (lesson working) instead of promising. Roadmap updated:
  ⓪·3g lane fix → ③ http_fetch → ④ wiki proposed; naming de-confused (⓪·3g "lane fix" ≠ spine ③).
- Docs/commits verified current through this entry; tree clean, all pushed.

## 2026-07-04 (night) — /goal ⓪·3g THE LANE FIX DONE + LIVE: Houge stays responsive during self-writes
- Root cause was sync child-process spawns freezing the event loop, not architecture. Built (f79716a):
  exec-file-async (execFileSync contract mirrored byte-for-byte) · evolution lane (kickoff digest
  returns immediately; ONE background pipeline; completion = own durable notification w/ buttons or
  code-owned failure; per-tool keys; wall-clock cap; lane released in finally; late orphans deliver
  nothing) · SIGTERM awaits lane · /status lane line · view-tap dedupe 60s · merge ack "正在合并…" ·
  merge REFUSED while lane busy (verifier F1: launchd ExitTimeOut 40 = SIGKILL at 40s). 1013 tests.
- Verifier GO + 3 findings fixed pre-live (merge×lane, notification key collision, timeout wording).
- G6 LIVE (digest-noise cleanup as test subject, merged 498acf7): kickoff 18s · concurrent chat 7s
  pickup mid-pipeline · publish 2m41s · buttons → merge → ✅ 重启成功. Houge self-write #10 merged;
  web digests now stripped of image-markdown junk (the football-score bug's second half fixed).
- ⓪ roadmap: ⓪·1/⓪·2/⓪·2b/⓪·2c/⓪·3/⓪·3f/⓪·3g ALL DONE+LIVE. Remaining: ⓪·4 (after quiet week).
  NEXT per usage evidence: ③ http_fetch → ④ wiki (deep research); ② episodic + scheduler in the mix.

## 2026-07-05 — soak-debug → /goal lane-awareness + context-window fix (799eea8)
- Soak triage from Telegram: Houge lost thread context across pauses (the "比分怎么样" → "which
  match?" amnesia). Root-caused live from the chat_turns/ledger: (①) `getRecentChatTurns` loaded
  with a 60-min wall-clock filter (`chatContextSince`) starved the inner loop's context; (②) the
  loop was unaware self_diagnose/self_write share ONE background lane, so every self-fix turn
  repeat-diagnosed and bounced the write off the busy guard; then hit the protected-path guard
  (run-store.ts) so nothing landed — the FLOOR working as designed, Houge deferred honestly.
- /goal executed the fix (build + adversarial-verify subagents): kickoff-terminal loop seam
  (`terminalAfterSuccess` → halt reason:"kickoff"), tool-desc rewrite (write diagnoses as it
  writes), window 60→1440min + turns 8→20, legacy runResearch context param. Gate green both env
  modes (1015/1015). Verifier verdict SHIP; caught a latent honesty bug (old post-kickoff final
  claimed "已提交修复分支" before the async pipeline finished).
- LIVE gate: **G1 PASSED** — 5 consecutive context-dependent World Cup follow-ups (incl. the exact
  "比分怎么样") all answered in-thread on 799eea8; amnesia gone. **G2 PASSED** — run d70bf191 (real
  Telegram): self-fix ask → ONE step (self_write_propose) → loop_halted reason:"kickoff", steps:1,
  zero busy-guard bounces, writer detached in a worktree. The old repeat-diagnose/write-bounce is
  gone. BOTH gates live-passed; goal satisfied.
- LESSON (Paco correction): I misread repeated Stop-hook re-fires as "user idle" and kept nudging
  `/goal clear` while he was actively testing on Telegram. Recorded in lessons.md + memory
  ([[goal-interactive-gate-no-idle-loop]] refined): check the ledger for in-flight activity before
  assuming the user is away; switch to watch-and-report.

## 2026-07-04 (close) — PARKED; handoff written
- Session closed at Paco's request (Fable 5 limit approaching). Full handoff block written at the
  TOP of tasks/todo.md ("⏸ PARKED 2026-07-04 — RESUME HERE"): state, onboarding order, load-bearing
  process rules, soak watchlist, next-build order (③ http_fetch → ④ wiki; ②/scheduler design chat;
  ⓪·4 after quiet week; charter safety floor interleaved). Any model can resume from repo files
  alone — no verbal context needed. Week's tally: ADR 0012+0013 designed+shipped ⓪·1→⓪·3g, 1013
  tests, 10 Houge self-writes merged, eval loop live and compounding.

## 2026-07-07 — Fix #2: reader temporal-tuple preservation + protect quarantine.ts (SHIPPED, live-gated)
- DIAGNOSIS (Paco ask: "why does Houge always get time wrong / hallucinate?"): traced the 07-06
  World Cup thread through chat_turns + ledger_events. Four distinct failure modes: (1) unlabeled
  schedule times misread as venue-local (Fox server-render is GMT; "7:00PM" Dallas ≠ Chicago time —
  to_local_time's math was right, its INPUTS were wrong); (2) the quarantined reader merged a
  US-frame date with an HK-frame time ("July 6 … 3:00 AM HK" — actually Jul 7 HK) → "match already
  played" illusion → the whole can't-find-results spiral; (3) `feedback`-routed run answered with
  ZERO tool calls and invented a capability claim — WITH lesson 19 in its prompt (empirical proof
  lessons alone don't hold; mechanical guards needed); (4) two runs burned their last steps on
  malformed action JSON and died on step_cap. Division agreed with Paco: #2 backend (this session),
  #1/#3/#4 → Houge self-writes later.
- BUILD (subagent) + adversarial VERIFY (independent subagent, SHIP-WITH-NITS, wall empirically
  unbroken: proto pollution, protocol-JSON lookalikes, 14/14 guard bypass vectors denied): commit
  ffce1d7 — ReaderExtraction.time_claims verbatim `(event — date time — zone: label|not stated)`
  tuples; READER_DISCIPLINE no-cross-frame-pairing + never-infer-zone rules; digest values
  newline-flattened (closed a pre-existing forged-frame-line hole in summary/facts too);
  src/core/quarantine.ts added to PROTECTED_FILES (pure wall half now Paco's-hand-only). 1148
  tests green incl. daemon-env sweep.
- LIVE GATE R7 PASSED: real turn (run_899cf696) via Gateway→CoreWorker, dual-LLM armed for the
  process (daemon untouched). Digests carried GMT/BST as separate tuples + "zone: not stated" for
  bare times; answer correct: ARG-EGY Sydney 02:00 Jul 8, SUI-COL 06:00 Jul 8, cross-corroborated
  (12:00PM ET = 16:00 GMT). ROLLOUT DONE same session: Paco flipped
  .env:75 to true; launchctl kickstart -k com.houge.daemon → graceful SIGTERM ("finishing in-flight
  work", clean stop after 373 cycles), new PID 22885 on current dist, heartbeat last_success green.
  Production wall ARMED.
- Follow-ups queued: fix #1 must ALSO revise LOOP_DISCIPLINE's "times are in the venue's/source's
  timezone" line (it actively taught the venue-local guess; live-gate answer still showed a
  cosmetic zone-presentation slip from it); verifier flagged wall WIRING (core-worker/inner-loop
  call sites, READER_DISCIPLINE) stays self-writable by design — revisit scope if desired.

## 2026-07-07 (later) — ROADMAP handoff doc (Fable 5 → any successor model)
- Context: Paco's access to the current orchestrator model (Claude Fable 5) may end after today;
  he asked for a detailed, model-agnostic roadmap so Opus 4.8 / any LLM can continue the build.
- GROUND-TRUTH CHECK first: daemon PID 78016 live (restarted 14:15 on current dist);
  .env verified — ALL walls armed (inner loop, self-write, http_fetch, firewall, dual-LLM,
  time tool, TZ-EVIDENCE). todo.md's "awaiting ARMING" was stale — arming already happened.
- LIVE EVIDENCE: the fix-#1 replay (run_42211bde 04:16Z, 「再来一次，明天有哪几场世界杯比赛？」)
  = HALF-PASS. Safety ✓ (no guessed zones). Utility ✗: 10× web_search, to_local_time never called,
  1 step lost to malformed action JSON, step_cap halt, apologetic fallback DESPITE digests holding
  GMT-labeled fixtures. Research convergence under the evidence regime = top functional gap.
- 3 parallel digest subagents swept todo.md(1770L)/sessions.md, all 16 ADRs + spine/inner-loop
  specs, lessons/README/code-map/flag-inventory — full project knowledge distilled.
- PACO'S 4 SEQUENCING DECISIONS (recorded in docs/ROADMAP.md §4): (1) Phase R research-convergence
  fix IMMEDIATE next build; (2) next major capability = ② episodic memory (④ wiki after);
  (3) safety floor INTERLEAVED — kill-switch + metered-$ ceiling as small builds between
  capabilities, full auto-rollback (D4) only when the autonomy flip becomes a goal;
  (4) autonomy flip = LATER milestone with documented preconditions (Milestone A).
- SHIPPED: docs/ROADMAP.md — charter, verified state + safety-floor ledger, non-negotiables
  (PINNED_ENV, live-gate mandate, exported-constants, /goal gate, monitor discipline), sequenced
  phases 0/R/M/S/W/K + Milestone A preconditions, ranked backlog, successor-orchestrator handoff
  notes (nothing in production depends on the departing model — the orchestrator seat changes,
  the daemon doesn't). todo.md top block updated to point at it + record the half-pass replay.
- Still open for Paco (Phase 0): S12 secrets probe, D12 injection probe (live, Telegram);
  BST→Europe/London alias one-liner queued for Houge.


## 2026-07-07 (afternoon) — Backend batch B1-B4 + the day's arc: 6 prompt measures fail, 4 mechanical nets hold
- Houge self-writes #3-#5 landed (tz aliases, LOOP_DISCIPLINE, evidence gate flag-gated after
  immutable-tests bounce; planner relative_day filter) — but "明天休赛日" still shipped 3× (readers
  doing source-frame calendar math; one-step finals; frame-poisoned queries). Paco called backend.
- B1 convert-before-final guard (bounce final on relative-day Q + time_claims + zero CONVERTED rows;
  verifier F1: all-error to_local_time must not disarm — fixed), B2 reader relative-day ban,
  B3 verified-reload invariant + PROTECTED merge machinery, B4 BST/AEST aliases + env symmetry.
- B3 investigation DISPROVED my merge-reload race diagnosis: smoke test rm-rf's dist每次 npm test —
  my own verification wrote the "stale" mtimes I then read as evidence. Manual restarts were
  unnecessary; button was always correct (~17s gate). Lesson: primary evidence (outbox beacons,
  reflog) before narrative; correlated mtimes lie.
- Turn budget 10→14 + bounce digest teaching event-name+GMT queries closed the last gap: live gate
  passed on the natural phrasing (Syd 02:00/06:00), plus a real mergeAndReload cycle (reloaded, fresh).
- Day's tally: 4 mechanical nets shipped (time_claims schema, zone-evidence anchor, convert-before-
  final bounce, verified reload) vs 6 ignored prompt measures. Every bad patch today was caught by
  the check stack; every clean land was a sharply-specified ask.

## 2026-07-12 — B5+B6: fallbackFinal honors conversions/hedges (F3) + to_local_time label (SHIPPED, live-gated)
- Resumed after 5-day quiet soak (zero runs since 07-07 evening; daemon healthy, one transient
  fetch-failed heartbeat self-recovered). Paco /goal: F3 fix + to_local_time label, NO claude-cli
  wiring (planner leg stays queued).
- BUILD (subagent) per spec: fallback digest LEADS with converted to_local_time rows +
  code-owned restater guidance (outside the untrusted-digest block); HEDGE when relative-day
  question + time_claims + zero conversions — bilingual code-owned hedge line survives
  absent/failed/junk restatement on every bare-digest path; all 6 fallbackFinal call sites
  covered. B6: per-item label threads onto success AND error rows, sanitized (non-deleting
  substitutions, render-seam guard), both manifest sketches updated.
- Independent adversarial VERIFY: SHIP-WITH-NITS. F1 (major, pre-existing but B5-amplified):
  `when`/`tz` echoed verbatim into error-row digests let a crafted when forge a CONVERTED_ROW
  match and DISARM the B1 guard — the exact bypass class the guard exists for. Fixed pre-commit
  at the same adapter chokepoint (sanitizeDigestText for label/when/tz); verifier's structural
  suggestion (guard on structured rows, not rendered-text regex) queued. 1200/1200 both sweeps.
- LIVE GATE (scripts/live-gate-b5b6.mjs — real Gateway→CoreWorker, real planner+Tavily,
  in-memory DB, forced budgets via post-intake contract surgery): S1 budget-3 step_cap →
  HEDGED honestly (the 07-07 invented-"today"-matches path, now closed); S2 budget-9 →
  9× web_search, never reached to_local_time (Phase R convergence class), hedged again;
  S3 full budget → clean final, LABELED digest rows («France vs Spain Semifinal: … →
  2026-07-15 05:00 (in 3 days)»), negative claim 明天没有比赛 backed by converted rows.
  Daemon kickstarted onto fresh dist: graceful stop after 3013 cycles, heartbeat green.
- Commit fa26a3e. Residuals queued in todo.md: structured-row guard refactor, Phase R
  convergence (S2 evidence), ET-first prose presentation slip, conversion-led fallback branch
  live-unexercised (unit-covered).

## 2026-07-12 (evening) — B7+B8: Phase R levers 2+4 — budget-tail shaping + protocol-retry hygiene (SHIPPED, live-gated)
- Paco /goal: "backend batch" = Phase R levers 2+4 (lever 1 landed as B5 this morning; lever 3
  queued as a Houge self-write; claude planner leg still deferred).
- BUILD (subagent): B7 — at ≤2 remaining charged steps the menu shrinks to convert-or-answer
  (to_local_time + llm_answer + final/clarify) with a code-owned stop-searching notice; parsed
  out-of-tail actions bounce charged (never failure/parse-failure; checked BEFORE the ping-pong
  guard so repeats can't be misrouted into parse_cap). B8 — malformed-action retries uncharged
  (chargedSteps accounting), total iterations backstopped at maxSteps+4, clean runs byte-identical
  (pinned question fixture). 3 B5 hedge fixtures legitimately shifted (their web_search now sat
  inside the tail).
- Independent adversarial VERIFY: SHIP-WITH-NITS. 500-seed livelock fuzz clean; HEAD differential
  byte-identity clean; guard-interaction matrix clean (B1 wins over tail on a final; B1-cap-
  exhausted tail final accepted — verifier added the missing test). F1 (minor, fixed pre-commit):
  tail guidance unconditionally instructed to_local_time even when DISARMED → obedient planners
  exited "denial" instead of honest step_cap; fix = manifest-conditional guidance variants.
  F2 (evolution kickoff at charged step 13+ gets tail-bounced) + nits queued. 1222/1222 both sweeps.
- LIVE GATE: S2 (budget 9 — this afternoon's search-death run) now: 6 searches → B1 bounce →
  tail to_local_time attempt → evidence-gate rejection → hedged honest fallback. The chain
  B1→tail→evidence-gate→B5-hedge all fired in one real turn. S3 clean final, rows labeled,
  rest-day negative claim backed by conversions. NEW residual: prose named Sydney clocks as
  北京时间 (pi row-misquote class) → queued mechanical candidate: local zone name in digest rows.
- Daemon on fresh dist (PID cycle clean), heartbeat green 07:13:22Z. Commit e961292.
- Day's arc: two /goal batches (B5+B6 morning, B7+B8 evening), both through build subagent →
  independent adversarial verifier → pre-commit fix of a real finding → live gate → rollout.
  Phase R levers 1/2/4 now mechanical; lever 3 (search discipline prompt) is the next Houge
  self-write; the S2 trajectory shows the nets composing exactly as designed.

## 2026-07-12 (late) — Claude wiring removed from Houge runtime entirely (Paco decision)
- Paco: "remove claude wiring completely, want to keep you to focus on building" — Claude is
  the BUILD-ORCHESTRATOR seat only; the daemon must never depend on it. Re-reverses the
  06-26 "Claude allowed at runtime via Max" rule (different rationale: seat separation, not cost).
- Excised (all INACTIVE — writer=codex reviewer=kimi were live config): claude self-write writer
  backend, claude diff-reviewer backend, normalizeClaudeUsage, core-worker wiring, both
  spike-claude-*.mjs scripts, HOUGE_CLAUDE_BIN + stale ANTHROPIC_API_KEY/HOUGE_LLM_MODEL block
  from .env/.env.example. Reviewer chain now [kimi, codex]; WriterKind=codex-only.
- Graceful-degradation contract PINNED by new tests: stale HOUGE_SELFWRITE_WRITER/REVIEWER=claude
  in any .env resolve to codex/kimi (no error, no publish block). 23 claude-path tests deleted,
  generic obligations (unknown-value fallback, reject-delivery, guard writer-agnosticism)
  re-anchored on codex/kimi. 1199/1199 both sweeps; nothing was load-bearing.
- claude-cli planner leg DROPPED from the queue; ROADMAP §1 charter + §5 handoff notes updated;
  memory (houge-model-agnostic-cheap) updated to the new rule. Commit b9d28d2. Daemon reloaded
  on cleaned env+dist, heartbeat green.
- Residual noted by build agent: scripts/live-selfwrite-p3.mjs still references the removed
  claude reviewer path in comments/env — historical driver script, left as-is.

## 2026-07-13 — B9: smaller-residuals batch R1–R6 (SHIPPED, live-gated)
- Paco /goal: "Smaller residuals pls" — the queued small items from B5–B8; structured-row guard
  refactor deliberately held back (medium architecture change).
- BUILD (subagent) per sharpened specs: R1 converted rows carry the target IANA zone INSIDE the
  relative-day parens (CONVERTED_ROW regex byte-identical — a token between time and paren would
  have silently disarmed the B1 guard; recon caught it before spec) + local_tz threaded through
  the adapter envelope, alias-resolved, sanitized; R2 tail-aware B1 bounce digests (exported
  variants, manifest-conditional per the F1 pattern); R3 tail arms only when maxSteps >
  TAIL_RESERVE_STEPS (2-call contracts were latently whole-run-tail); R4 terminal-after-success
  kickoffs (evolution lane) allowed through the tail — menu and enforcement share one predicate;
  R5 LOOP_TIME_PRESENTATION_RULE (lead with the user's zone) + fallback guidance clause;
  R6 claude refs stripped from the p3 driver. 14 new tests, 1213/1213 both sweeps.
- Independent adversarial VERIFY: SHIP-WITH-NITS. Guard-forge probes through the real adapter all
  defused (hostile local_tz collapses to UTC via resolveTimeZone before rendering); 500-seed
  livelock fuzz clean; HEAD byte-differential clean outside deliberate changes; B7 guard-matrix
  tests still meaningful. Fixed pre-commit: (1) R2 gated on the position where the digest is READ
  (post-bounce, remainingSteps-1) — a bounce one step above the tail no longer instructs a search
  the next menu bans; (2) raw wording pins ("search the specific events") replaced with an
  exported RELATIVE_DAY_SEARCH_INSTRUCTION fragment the base digest is composed from — the
  self-write rule, since lever 3 will likely reword exactly these digests. 1214/1214 both sweeps.
  Commit 5b73a3f.
- LIVE GATE (per-scenario re-runs of live-gate-b5b6.mjs): S1 (budget 3) produced the full B9
  chain live — B1 bounce read in the tail → R2 digest says convert-don't-search → planner obeyed
  with to_local_time on times it already had → conversion-led hedged fallback quoting the
  zone-named row (first live exercise of B5's conversion-led branch). S2 clean final with
  zone-named rows + honest evidence-gate error row. S3 prose now LEADS with the user's frame
  (ET-first slip gone), negative claim backed. NEW narrowed residual: S3 prose adorned correct
  Sydney clocks with a spurious «北京时间/» co-label; queued with the ZONE_EVIDENCE_ERROR
  instruct-then-ban wording as next mechanical candidates.
- Daemon rolled via launchd SIGTERM (clean stop after 232 cycles), fresh dist, heartbeat green.
- Arc note: recon subagent → sharpened specs → build subagent → adversarial verifier → two real
  pre-commit fixes → per-scenario live gate. The tail nets composed live exactly as designed;
  remaining utility gap is prose-level frame adornment, which is structured-row-guard territory.

## 2026-07-13 — Phase R lever 3: search discipline via Houge SELF-WRITE (MERGED, live) — Phase R COMPLETE
- Paco /goal: "lever 3 self-write" — the last Phase R lever lands through Houge's own evolution
  lane; Claude orchestrates only (kickoff message, ledger watch, merge-gate shepherding). First
  full self-write circuit since the claude-runtime excision — codex writer / kimi reviewer chain
  confirmed live.
- Recon (subagent): kickoff is Telegram-only (no CLI path reaches EVOLUTION_TOOLS); pipeline =
  codex writer (≤3 attempts) → protected-path guard → test-gate (typecheck+test+build in a
  node_modules-linked worktree) → kimi review → publish branch → Telegram view/merge/discard
  buttons → mergeAndReload (re-verifies, reverts on red, launchctl restart on green). Confirmed
  composer.ts/inner-loop constants self-writable — B9's exported-fragment prep was the enabler.
  Ledger watch armed from rowid high-water mark BEFORE surfacing the gate (monitor lesson).
- The circuit: Paco's kickoff 06:00:28Z → planner chose self_write_propose on step 1 (7s;
  B9-R4 note: kickoff would have survived even in the tail) → published 06:03:31Z (2m47s) →
  diff read + SHIP recommendation surfaced → Paco merged → clean SIGTERM + restart 06:04:54Z
  on merge commit 85e792f (Houge-authored). All three gates pass; kimi's review reasons were
  substantive ("minimal change to the correct prompt, preserves timezone rules").
- The change (1 line in LOOP_DISCIPLINE): query scheduled events by event name + timezone
  keyword, not the local date — promotes the B1 bounce digest's reactive teaching to proactive
  every-step guidance (the 07-12 S2 9×-search death class).
- Post-merge live probe (gate S2): mechanical nets composed (tail-forced conversion, zone-named
  row, honest budget denial, conversion-led fallback). Convergence NOT claimable from n=1
  (7 searches vs 5 pre-lever same morning; same-scenario variance 5–9 today) — soak metric.
  Probe CAUGHT a real residual: fallback restatement said «明天» for a row labeled `in 2 days`
  (right clock/zone, wrong relative word — the LLM ignored B5's code-owned restater rule).
  Queued mechanical candidate: post-restatement relative-day token validation against row labels.
- Phase R closed: levers 1 (B5 fallback conversions), 2+4 (B7/B8 tail + retry hygiene),
  3 (this self-write). Next roadmap item: ② episodic memory. Orchestration note: the
  interactive gates (kickoff, merge) were surfaced once with full context and completed by
  Paco in minutes — no idle-loop nudging needed.

## 2026-07-15 — Phase M: ② conversational-episodic memory B1–B5 + accelerated B6 (SHIPPED, live)
- Paco /goal: "episodic memory" — roadmap Phase M / spine stages B1–B6. Design sub-decision put
  to Paco per roadmap: he chose EMBEDDINGS NOW (option b, amends ADR 0005 §1) over FTS5-only v1.
  Implementation preserves dependencies:{}: local Ollama /api/embed (system-service dep, same
  class as pi/agy CLIs), embeddinggemma 768-dim multilingual (CJK is why FTS5-only was weak —
  unicode61 doesn't segment Chinese), graceful degradation to BM25/recency when down. ADR 0016.
- Two build subagents: M1 (episodic_facts store + FTS5 mirror + embeddings client + fast-path
  distillation with Slice A reconcile verdicts + per-chat watermark + session-lull trigger),
  M2 (retrieval relevance[BM25+cosine]×recency×reuse×salience folded into the composer with
  byte-stable goldens when off + applied_artifacts attribution + daily consolidation tick
  [decay/prune/merge/promote, never deletes] + live-gate script + ADR). 1311/1311 both sweeps.
- Independent adversarial VERIFY: SHIP-WITH-NITS. Attack surfaces held: persistent prompt
  injection through the fact pipeline (two walls: write-time sanitize + render flatten),
  15 hostile FTS MATCH strings, migration on a VACUUM-copy of the REAL houge.sqlite (idempotent,
  integrity ok, 8→10 schema rows), BM25-negative-rank normalization direction verified on real
  data, clock-backwards idempotency, zero hard-DELETEs anywhere. Verifier fixed U+2028/29/85
  line-separator smuggling in-tree (+regression). I fixed pre-commit: >24-turn burst silently
  skipping oldest turns forever (new getChatTurnsAfter, oldest-first, catch-up across ticks,
  regression test) + NaN-cosine comparator poisoning. 1313/1313 both sweeps incl. ARMED-flag env
  (the selfwrite-testgate hermeticity lesson applied before arming). Commit 0ac9bc2.
- LIVE GATE (real chain + real Ollama): S1 four atomic pronoun-resolved embedded facts from
  Chinese turns. S2 the money shot — Chinese query, English stored facts, cross-lingual cosine
  retrieved all 4, and the real planner answered a weekend-planning question USING 小芸 + 海边
  骑车 + Sydney unprompted, zero re-asking (B6-class behavior, live). S3 correction superseded
  the Sydney fact (pointer chain + valid_until + reuse penalty) and Melbourne topped location
  retrieval. S3's first run false-failed on language-brittle script assertions (facts stored in
  English from a Chinese transcript) — assertions rewritten pointer-based (3b7c90b).
- Rollout: HOUGE_EPISODIC_ENABLED=true appended to .env AFTER re-running the armed-env sweep;
  daemon rolled via launchd (clean stop after 1392 cycles, PID 8191). B6 multi-day soak begins:
  distill fires ~30min after chat lull; consolidation daily; judge unprompted use over the week.
- Residuals: English-fact language slip (cosmetic), inline distill latency in the poll loop
  (watch first ticks), embeddings-only merge clustering (backfill deferred), legacy enum path
  unwired (dead in production), parse-layer-only sanitization (contract note).

## 2026-07-15 (late) — B10: background reports → chat_turns + scheduler v1 (SHIPPED, live-gated)
- Paco /goal: "fix the chat_turns bug and add scheduler" — both born from the morning chat
  review (Gate B reference miss; 每周一周报 ask unserved by a skill alone).
- Recon: outbox (target_key, idempotency_key) uniqueness is a free exactly-once latch for
  B10a; the repo carried VESTIGIAL scheduler scaffolding (schedule TriggerSource/Identity,
  ScheduleState machine, schedule_fired events) since Milestone 2 — B10b wired it live.
  Roadmap backlog #1 (Scheduler ADR) → ADR 0017.
- BUILD (subagent, resumed once after a session-limit kill mid-edit — SendMessage continuation
  worked cleanly): B10a records the assistant turn at enqueue-time on the queued latch;
  B10b = scheduled_tasks store + DST-correct spec math (wallClockToInstant exported) +
  schedule_task loop tool (per-chat cap = self-replication bound) + daemon tick (≤3/tick,
  fire-then-advance-from-now) + /schedule list/cancel + docs. Verifier SHIP-WITH-NITS:
  self-replication converged AT the cap under a real create-loop; F1 U+2028 goal smuggling
  fixed in-tree; I fixed F2 (failed rows cancellable) + F3 (budget fuse now PAUSES due
  schedules — counting fuse refusals had bricked them in ~3 ticks against the breaker's whole
  purpose) pre-commit; F4 (advance→execute crash orphan) accepted in ADR + residual.
  1383/1383 → commit 6011afb; scheduler armed in .env after the armed-env sweep.
- LIVE GATE on the real daemon (Paco's Telegram): weekly AI周报 created conversationally
  (Mon 08:00 Sydney = 2026-07-19T22:00Z ✓); "3分钟后提醒喝水" created a once schedule — and
  CAUGHT the next bug class: the planner computed at_iso itself with a +11 offset (July =
  AEST +10); prose said 18:04, row said 19:04. Fixed same session: {kind:"once",in_minutes}
  code-side math + description steering ("never compute a UTC timestamp yourself"), a5d903d.
  The mistimed row fired naturally at 19:04:30 Sydney: source:"schedule" run → «川哥，喝水时间
  到了！» delivered AND recorded in chat_turns (B10a mechanism carries scheduler output too) →
  row self-disabled → schedule_fired ledger event. Full chain proven.
- Ops notes: permission layer correctly declined my direct live-DB row edit (left the row to
  fire naturally — right call); daemon rolled twice (B10 then in_minutes), PID 89248 final.
- Day's arc: three /goals shipped (Phase M episodic memory; B10). Houge now: remembers
  conversations, sees its own background reports in-thread, and acts proactively on schedule.
  Next roadmap: Phase S (kill-switch + $-ceiling), then ④ wiki.

## 2026-07-15 (later) — B11: Phase S safety floor — durable kill-switch + metered-$ ceiling (SHIPPED, live-gated)
- Paco /goal: "kill-switch and $-ceiling" — the interleaved safety floor, timely now that the
  scheduler runs autonomously overnight.
- Recon nailed two design-deciding facts: /guard NEVER existed (docs-only — S-1 greenfield), and
  launchd KeepAlive is unconditional <true/> (ThrottleInterval 10s) → a tombstone-EXIT would
  restart-loop → design is PARK-ALIVE (boot gate constructs nothing, awaits SIGTERM). Arming flags
  read process.env LIVE → disarm = mutate env now + a posture file loaded BEFORE .env
  (first-writer-wins) for restart survival. kimi/gemini already report tokens via openai-compat
  onUsage; cost_usd field exists on llm_call but was never populated (no pricing anywhere).
- BUILD (subagent): S-1 tombstone module + cli.ts boot gate (park-alive; smoke caught that signal
  listeners alone don't hold Node's event loop — added a keepalive interval, else the park would
  10s-restart-loop, the exact failure it prevents) + /kill /disarm /rearm (slash-only, allowlist,
  rate-limit-exempt) + PROTECTED_FILES for both state files. S-2 pricing table + cost at the
  recordLlmCall seam + dual-window (24h-rolling + calendar-month-UTC) USD ceilings derived from the
  ledger + latch-driven buildLlmChain filter that drops metered legs on breach but never empties
  (falls back to pi) + one deduped alert (twin of the run-count fuse latch). 2 ADRs. 1440/1440.
  Build incident: an over-broad pkill during smoke bounced the real daemon once (graceful, no loss)
  → the live daemon ended up pre-rolled on B11 dist.
- Independent adversarial VERIFY: SHIP-WITH-NITS, one MAJOR caught: deploy/launchd/run-daemon.sh
  (the wrapper launchd execs) + the plist template were self-write-editable — a self-write could
  prepend `rm -f houge.kill` and AUTO-REVIVE a killed daemon on the next relaunch (one-hop boot-path
  bypass, same class as the already-protected load-env.ts). Fixed in-tree + regression. Verifier's
  fail-open/closed audit endorsed the whole design: kill switch fail-CLOSED (corrupt tombstone still
  kills), budget net fail-OPEN (DB hiccup pauses tracking, never bricks cognition), posture beats a
  stale shell export. Hostile pricing JSON → no proto pollution. 1443/1443 both sweeps. Commit 57a03dd.
- LIVE GATE on the real daemon (Paco Telegram): /disarm flipped all 4 flags live (posture written).
  /kill wrote the tombstone, acked WITH revival instructions BEFORE shutting down, launchd relaunched
  (47622→49038) and the new process PARKED IDLE — held stable across the 10s ThrottleInterval at 0.0%
  CPU with no lock file. Resurrection defeated: a stopped Houge stays stopped. Revival (orchestrator-
  run, since a parked daemon can't hear Telegram): rm houge.kill + houge.disarm → launchctl kickstart
  → PID 49207 back to normal long-poll. Cleared disarm too (gate test) so the Mon 08:00 AI周报 stays
  armed. Metered ceiling: /status line live, but no real breach exercised (test-proven only).
- Phase S done. Roadmap now: ④ LLM wiki (last major spine capability). Day's arc: FOUR /goals
  shipped (Phase M episodic memory; B10 chat-turns+scheduler; B11 safety floor) — Houge now
  remembers, sees its own background work, acts on schedule, and can be durably, unforgeably stopped.
