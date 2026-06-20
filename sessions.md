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
