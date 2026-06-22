# Phase 2 spec — skills (reusable procedures, anchor-gated, self-evolving)

**ADR:** [0011](../../decisions/0011-self-evolution-architecture.md) §1/§2/§3/§6/§7. **Date:** 2026-06-21.
**Scope:** the second evolvable layer — Houge acquires, applies, and refines reusable **procedures**
for classes of task. Builds on Phase 1's `coding_agent_cli`/worktree muscle and ADR 0010's composer.

## Framing (the corrected mental model)

A **skill is a competence, not a memory.** It is a reusable *procedure* for a class of task — "how
Houge does X well" — distinct from a *lesson* (a one-line preference about Paco) and from *code* (a
capability that executes logic). The three evolvable layers therefore get **three homes**:

| Layer | Unit | Home | Eval gate | Auto-write? |
|---|---|---|---|---|
| **lessons** | a tweak / preference | `memory/` (SQLite `lesson_blocks`) | the user (silent save) | yes (shipped, ADR 0010) |
| **skills** | a reusable procedure (markdown) | **`skills/`** (new top-level dir) | anchors (Gate B) + taste (Gate C) | **yes — report, not `/approve`** |
| **code** | executable logic | `src/` | tests/typecheck/build + `/approve` | no — Paco merges (ADR 0011 §5) |

Persona and the core principles never enter a skill (a skill is a method, not identity), so the
core-principles constant (ADR 0005) is not in scope here.

**Skills are ambient, never invoked by name.** There is no "invoke skill X" path — a skill is a
competence the composer applies *implicitly* during an ordinary natural-language turn (pre-filtered
by scope, self-selected via its `when:` hint). The user never names a skill and need not know one
exists; even "use your cross-check method here" is just a normal NL turn whose text matches a
`when:`. This preserves ADR 0010's natural-language front door. The three ways a user *touches* a
skill stay separate:

| Action | How | Sub-phase |
|---|---|---|
| **Use** | implicit — NL turn, auto-applied by scope + `when:` (Houge self-selects) | 2a |
| **Author / refine** | NL — "write/improve a skill for X" → `skill` intent | 2b |
| **View** | `/skills [scope]` — read-only list/inspect (a *viewer*, never an invoker) | 2a |

**Why skills can auto-write while code cannot:** ADR 0011 §1 marks skills "low risk — no
compile/merge." A skill is prose that executes no logic; a bad one yields a weaker answer and is
instantly revertible. So the human touchpoint for skills is a **report (awareness), not an approval
gate**. Code keeps the `/approve` merge gate because it is the writable-irreversible-ish surface.

## Goal

1. Make procedures first-class **loadable artifacts** the composer folds into a run (2a).
2. Let Houge **author** a skill — on command, auto-promoted from learning, or refined from a
   failure — via build-time muscle (Codex), routed by the §2 rubric (2b).
3. Add the **OPENSKILL anchor verifier** (Gate B) and the auto-author/refine loop, gated behind a
   spike that proves the verifier actually discriminates good from bad skills (2c).

## Architecture

```
                       ┌─ compose: identity + DISCIPLINE(floor) + SKILLS(overlay) + lessons + guardrails
run on a surface ──────┤     skills pre-filtered by scope; each `when:` line rides in-prompt;
                       └     Houge SELF-SELECTS which apply (no extra LLM call). cap ≤4/scope.

author a skill ──▶ Gate A qualify (4 criteria) ──▶ Codex authors draft in a worktree
                        │ fail                              │
                        ▼                                   ▼
                   down-route                       Gate B anchor verify (walled-off, ≤3 passes)
                   (tweak→lesson,                          │ pass            │ fail after 3
                    needs-code→code flag)                  ▼                 ▼
                                                    write skills/<scope>/<name>.md   down-route → lesson
                                                           │
                                                           ▼
                                          REPORT to Paco (gate-by-gate) + regenerate REGISTRY.md
```

## Skill file format

`skills/<scope>/<name>.md` — `scope` ∈ the composer surfaces (`ask` | `research` | `selfcode` | …).

```markdown
---
name: cross-check-figures
scope: research
when: comparing numbers across multiple sources      # trigger hint; Houge self-applies
anchors:                                              # Gate B: world-fact {0,1} assertions
  - a part never exceeds its whole
  - units are converted before comparison
version: 2
last_verified: 2026-06-21        # anchor score: 3/3
origin: refined                  # commanded | learned | refined
---

<the procedure — the numbered method Houge follows for this class of task>
```

Frontmatter is the **source of truth**; `REGISTRY.md` is a generated view of it.

## Composer integration (2a)

Add a **skills layer** between discipline and lessons, mirroring the injected-reader pattern that
already exists for lessons (so a run with no skills composes byte-identically to today — eval
goldens unaffected):

```
temporalContext + identity + DISCIPLINE[surface] + SKILLS(scope) + LESSONS(scope) + GUARDRAILS
```

- `composeSystemPrompt` takes an optional `skillsReader?: (scope) => string | undefined` (like
  `lessonsReader`). Absent / empty → the skills section is omitted entirely.
- The reader returns the ≤4 in-scope skills rendered as a "## Skills — apply when relevant" block,
  each prefixed by its `when:` so Houge self-selects.
- Built-in `DISCIPLINES` stay hardcoded constants (the **floor**); skills are additive overlay only.

## The gate stack

**Gate A — qualify (the §2 routing rubric).** *Is this even a skill?* ALL four must hold:
(1) recurring class, not one-off · (2) a method, not a tweak · (3) promptable — needs no new code ·
(4) world-fact grounded → transfers + verifiable. Fail → **down-route**: (2)/tweak → a `lesson`;
(3)/needs-code → a code-capability flag (backlog item, not built here). Fuzzy lesson↔skill → save
the lesson now and **ask** Paco whether to promote (ADR §2; calibrates over time).

**Gate B — verify (OPENSKILL anchor verifier).** *Is the authored skill correct?* A **separate,
walled-off** model session retrieves verification knowledge **distinct from the skill content**,
emits deterministic `{0,1}` assertions anchored to those world facts, and scores the skill by
whether running it satisfies them. **≤3 refine passes** (the paper peaks at 3, overfits at 5/10 —
ADR §6). Fail after 3 → **down-route to a lesson** (nothing learned is wasted).

**Gate C — taste (Paco).** The deep-semantic slice the anchors provably cannot cover (~11% in the
paper). Delivered via the per-attempt report + `/skills` standing view; Paco reverts/refines by reply.

## Authoring — three origins, one pipeline (2b/2c)

1. **On command (NL, not a slash):** a new `skill` intent ("write a skill for X") — consistent with
   ADR 0010 dropping `/ask`·`/research` for natural-language routing. Routed like `selfcode`.
2. **Auto-promoted from learning:** `distill` flags a recurring procedure (Gate A axis added to the
   existing feedback→lesson path).
3. **Refined from a failure:** a correction on a surface where a skill **already applied** updates
   **that skill** (author starts from the existing file; report a **diff** + new anchor score;
   `version`++) rather than adding a parallel lesson.

**Authoring engine (revised 2026-06-22): the cheap pi→kimi chain writes the skill** — no Codex, no
worktree. A skill is *prose* (a promptable procedure), so authoring it is the same muscle that already
writes lessons via the distiller, just longer output. Codex/build-muscle is reserved for the **code
layer** (Phase 3), where execution actually needs it. (If kimi ever writes weak procedures, the chain
is pluggable — point authoring at a stronger model without re-architecting.)

### Skills are prose, not plugins

A skill is markdown only — it executes no code, does no I/O, introduces no new tool. It may *orchestrate
capabilities Houge already has* ("to verify a date, use `web_search` then cross-check the two newest
sources") but it can never *be* a capability. Anything needing a script, a live API, or an **MCP
server** is the **code/capability layer** (a pluggable adapter, `/approve`-gated — like the Tavily web
chain), NOT a skill. Boundary test: *can a colleague follow this with a pen and the tools already on the
desk?* Yes → skill; needs a new tool wired in → code.

### The writer's rubric — `SKILL_AUTHOR_DISCIPLINE`

Quality starts at the **input**: the cheap chain authors under a dedicated discipline (a new constant in
`composer.ts`, alongside `ASK_DISCIPLINE` etc. — the analogue of the skill-authoring guide a strong
agent follows). It encodes: the frontmatter contract; a **sharp `when:`** (a specific trigger, not a
whole surface — this is what makes 2a self-selection work); **promptable-only** (Gate A crit. 3 — steps
using tools Houge already has, never "write code"); **world-fact-grounded** (crit. 4); **emit `anchors:`**
(the testable assertions — even though Gate B doesn't *run* until 2c, writing them now forces a
verifiable skill and gives 2c something to check); **bounded + procedure-not-persona** (no voice — that
lives in `houge.md`). It is a built-in **discipline (the floor)** for 2b; later it can graduate into an
evolvable **meta-skill** (`skills/meta/skill-authoring.md`) so Houge improves *how he writes skills* —
self-evolution applied to self-evolution (future, not 2b).

**Three roles, three prompts** (don't conflate): the **writer** (`SKILL_AUTHOR_DISCIPLINE`) writes a
good skill up front; the **router** (Gate A) decides skill/lesson/code; the **verifier** (Gate B, 2c)
checks correctness. The writer discipline doesn't replace Gate B — it makes Gate B pass more often, and
carries 2b's quality while Gate B doesn't yet exist.

## Registry + visibility

- **`skills/REGISTRY.md`** — auto-regenerated on every write: name · scope · `when:` · #anchors ·
  version · last anchor score · origin. Generated view; never hand-edited.
- **`/skills [scope]`** — control command, idempotent, no run/budget (exactly like `/lessons`):
  lists skills on Telegram.

## Reporting (every attempt, whatever the outcome)

In **2b** the report shows Gate A + the write outcome (Gate B is deferred to 2c — shown as such):
```
🐒 Skill attempt: "cross-check-figures" (research)
  Origin: you asked
  Gate A qualify: ✓ all 4 held
  Gate B anchors: (deferred to 2c)
  → Wrote skills/research/cross-check-figures.md (3 anchors authored). /skills to view, reply to refine.
```
Once **2c** lands, the same report carries the anchor verdict and may down-route on failure:
```
  Gate B anchors: ✗ 2/3 passed after 3 tries (failed: "units converted before compare")
  → Down-routed to a LESSON: "always convert units before comparing figures"
```

## New code (file pointers)

| Piece | Where | Notes |
|---|---|---|
| skill store | `src/skills/skill-store.ts` (new) | read-by-scope (≤cap), parse/validate frontmatter, write, list, regenerate `REGISTRY.md`. Filesystem under `skills/`. |
| composer skills layer | `src/prompt/composer.ts` | `skillsReader` option; "## Skills" block; omitted when empty (goldens unaffected). |
| `skill` intent | `src/capabilities/intent.ts` | add to `Intent` union + `INTENT_DISCIPLINE` examples ("write/teach a skill for X"); tolerant parse → `answer` fallback. |
| Gate A router | `src/capabilities/skill-router.ts` (new) | the 4-criteria qualify + down-route decision (→lesson / →code-flag); the fuzzy→ask path. |
| Gate B verifier | `src/capabilities/anchor-verify.ts` (new) | walled-off session: retrieve verification knowledge → emit {0,1} anchors → score; ≤3 passes. **Spiked before wired (2c).** |
| skill author | `src/capabilities/skill-author.ts` (new) | frames the authoring prompt under `SKILL_AUTHOR_DISCIPLINE`; **authors on the cheap pi→kimi chain** (NO Codex/worktree in 2b); parses the markdown; diff on refine. |
| writer discipline | `src/prompt/composer.ts` | `SKILL_AUTHOR_DISCIPLINE` constant (frontmatter contract, sharp `when:`, promptable-only, world-fact-grounded, emit anchors, bounded, procedure-not-persona). |
| routes | `src/core/core-worker.ts` | `executeSkill` (author/refine) dispatched from `executeTurn` on `intent==="skill"`; distill flag → promotion; reporting. |
| contract | `src/contracts/task-contract.ts` | `skill-author` contract: `allowed_actions` = `llm_answer` + a write **scoped to `skills/` only**; everything else forbidden (NO `coding_agent_cli` — skills are prose). |
| `/skills` cmd | parser + trigger-adapter + `gateway.ts` | idempotent control command, like `/lessons`. |
| config | `docs/reference/configuration.md` | `HOUGE_SKILLS_ENABLED` (default **on** — kill switch; skills are read-only/low-risk), `HOUGE_SKILL_MAX_PER_SCOPE` (4), `HOUGE_SKILL_REFINE_PASSES` (3), `HOUGE_ANCHOR_MODEL` (the walled-off verifier model). |
| gitignore | `.gitignore` | add `skills/` (runtime state, like `memory/skills/` was). "Graduating" a skill to committed is a manual `git add`. |

## Containment / safety

- The `skill-author` contract's only write target is **`skills/`** — protected paths (secrets,
  `memory/core`, `src/`) are off-limits even here (a skill author cannot touch code or identity).
- Skill authoring writes **prose only** (markdown under `skills/`); it runs no shell, touches no code,
  introduces no new tool. No worktree needed in 2b (that was a code-reading construct — Phase 1/3).
- Gate B (2c) runs in a **walled-off session** with verification knowledge it retrieves itself — it
  never sees an answer key and never adopts the skill text as instructions (untrusted-data wall, ADR 0006).
- Auto-write is bounded: ≤4 skills/scope, ≤3 refine passes, every write reported + revertible.
- **Engine split (revised):** skill authoring runs on the **cheap pi→kimi chain** (prose is in its
  reach). Build-muscle (Codex) is reserved for the **code layer** (Phase 3). Gate B's verifier (2c) is
  a *separate walled-off* model session, not the runtime engine — the ADR 0010 build/runtime split holds.

## Sub-phasing (each independently shippable + live-gated)

- **2a — skills as loadable artifacts.** Format + `skills/` + `skill-store` + composer-loads-by-scope
  + `/skills` + `REGISTRY.md`. No authoring yet. **Live gate:** hand-author `skills/research/<x>.md`
  with a marker, send a research message, confirm the marker shows in behavior (absent before,
  present after) on the real pi→kimi chain — mirrors the v1 `/teach` live test.
- **2b — authoring + Gate A + reporting.** `skill` intent (on-command) → **pi→kimi authors** under
  `SKILL_AUTHOR_DISCIPLINE` (no Codex/worktree) → write + report; Gate A qualify + down-route; distill
  promotion **flag** (flags only — auto-author is 2c). Anchors are authored now (Gate B runs in 2c).
  Quality rests on the writer discipline + Gate A + Paco's report/taste. **Live gate:** "猴哥, write a
  skill for cross-checking figures in research" → authored, written to `skills/research/`, reported on
  the real pi→kimi chain, and a *fresh* research turn picks it up (the 2a path); plus a tweak request
  ("be more concise") **down-routes to a lesson**, shown in the report.
- **2c — Gate B anchor verifier + auto-author/refine loop. SPIKE-THEN-DECIDE.** See the **Phase 2c
  design** section below for the locked decisions + the spike. In short: a *throwaway measurement
  spike* first proves the cheap walled-off verifier can separate good skills from bad ones; **only on a
  GO** do we `/goal` the real build (auto-author/refine wired, autonomy level decided with data); on
  NO-GO, Gate B ships **advisory-only** and we revisit. **Live gate (the build, not the spike):** a
  real correction auto-refines a skill (diff + new score) and a deliberately-bad skill is caught.

## Phase 2c — design & spike (decisions locked 2026-06-22)

The unproven phase, so structured **spike-then-decide**: a throwaway *measurement* answers the
make-or-break question before any production build.

**The make-or-break question:** can a cheap, walled-off model emit honest `{0,1}` anchor verdicts that
*separate good skills from bad ones*? If no, the whole "auto-author gated by Gate B" design collapses
(a verifier that can't discriminate is worse than none — false confidence).

**Decisions (locked):**
- **D1 — verify mode (run-and-check vs static-grade): the spike measures both.** Run-and-check
  (actually execute the skill on a test input, score the *output* against anchors) is the faithful
  OPENSKILL form (lean); static text-grade is cheaper but drifts toward the self-feedback trap. Pick
  whichever the spike shows discriminates.
- **D2 — anchors are independent.** Gate B *generates its own* assertions from independently-retrieved
  verification knowledge; the author's frontmatter `anchors:` are a **seed/comparison signal, NOT the
  test** (an author must not grade its own homework).
- **D3 — cheap walled-off model.** A fresh pi→kimi session, independent of the author's context (no
  answer key). If the spike shows the cheap model can't discriminate → Gate B ships **advisory**, revisit.
- **D4 — autonomy ramp: DEFERRED to post-spike.** Full auto-author+report (Paco's stated preference)
  vs Paco-confirm-first until Gate B earns trust — decided *with spike data*, because the 2b live test
  showed the cheap classifier misfires and autonomy *amplifies* misclassification.
- **D5 / Q5 — Gate B scores ALL authored skills**, advisory-vs-blocking **by origin**: *commanded →
  advisory* (written regardless; score in the report + `last_verified`); *auto → blocking* (kept only
  if it passes; else refine ≤3 passes → down-route to a lesson).

**Trigger model (when Gate B fires):**
- On **every** event that creates/changes a skill: commanded create · commanded refine · auto-promote
  (distill flag acted on) · auto-refine (correction on an applied skill).
- **Advisory vs blocking is by origin** (commanded advisory / auto blocking), per D5.
- **Timing (inline vs async) falls out of D1's cost:** static-grade cheap → run **inline** everywhere;
  run-and-check expensive → **auto** inline+blocking (no human waiting), **commanded** writes
  immediately then Gate B runs **async** → a follow-up report with the score (keeps the command snappy).
- **Out of 2c:** re-verifying *existing* skills as world-facts drift (needs the scheduler — backlog).
  Lower risk anyway: a good skill encodes *timeless* facts ("cite a primary source"), and Gate B should
  *reject* a skill that bakes in a perishable fact (facts-as-procedure is a bad skill).

**The spike (throwaway measurement — NO `/goal`, not shipped, deleted after):**
- **Test set:** ~5 known-good skills (incl. the live-authored `fact-check-viral-claim`) + ~5
  **deliberately-broken** ones (e.g. "trust the first search result", vacuous/unfalsifiable steps,
  wrong anchors, facts-as-procedure).
- **Run** the candidate Gate B (both D1 variants) on each → independent anchor score.
- **Go-bar:** good ≫ bad with a clean separating margin (all good ≥ threshold T, all bad < T, no
  overlap). Output = go/no-go · which verify mode · whether the cheap model suffices.
- Keep the *learning* (and the validated Gate B core if it works); discard the harness.

**Post-spike:**
- **GO** → `/goal` the real 2c: Gate B capability wired per the trigger model, auto-author/refine loop,
  D4 autonomy decided, contracts/tests/live gate (like 2a/2b).
- **NO-GO** → Gate B ships **advisory-only** (shows a score, never blocks), no auto-author; rethink.

### Spike RESULT (run 2026-06-22 — `scripts/spike-gateb-2c.mjs`, real pi→kimi)

**Verdict: GO — conditional on a 3-pass ensemble.** On a 10-skill set (5 sound + 5 deliberately
broken: trust-first-result · vacuous · facts-as-procedure · unfalsifiable · popularity-wins):

- **Single-pass** static-grade was **too noisy** — margin swung +0.17 / 0.00 / −0.17 across runs
  (flipped GO↔NO-GO); good skills occasionally scored 0, a bad one occasionally leaked to 0.17. BUT the
  *means* always separated (good ~0.40 vs bad ~0.02) → signal present, single-shot unreliable.
- **3-pass averaged** static-grade **cleanly + stably separated** (two runs): good **0.28–0.89**, bad
  **≤0.06** (≈0 on nearly every pass), **margin +0.22 / +0.28**. Threshold ~0.15 passes all good, rejects all bad.

**Decisions this settles:**
- **D1 → static-grade, procedure-level, INDEPENDENT criteria** (Gate B derives its own quality criteria
  from world-knowledge, judges whether *following* the procedure ensures each). **No run-and-check
  needed** (no web, no skill execution) — cheaper, and it discriminates once ensembled.
- **Gate B = a 3-pass ensemble** (mean of 3 independent passes), pass-threshold ≈0.15 (calibrate in the
  build). 3× cheap-chain calls — still cheap.
- **D4 → auto-author may be GATED (blocking) on the 3-pass Gate B** + report (Paco's stated preference,
  now data-backed): broken skills are rejected ≈100% of passes, so the gate reliably stops garbage.
  Keep a conservative threshold; on fail → refine ≤3 → down-route to lesson.

**Honesty caveats:** toy 10-skill set, web-less, single model (kimi), one author of the "bad" skills
(me) — a real eval would broaden the set + run more trials. Good-skill *absolute* scores are modest
(Gate B's criteria run strict/aspirational); the gate works on *separation*, not high absolute scores —
so the build must set the threshold by the good/bad gap, not a fixed bar. Caught a measurement bug
mid-spike (graded output-level assertions against procedure text → fixed to procedure-level criteria).

## Out of scope

- Cross-surface skills (a skill bound to >1 intent) and a real LLM **selector** step — deferred until
  the library outgrows the ≤4/scope self-select. (Open question Paco flagged; revisit post-2a.)
- Code self-write (Phase 3) and the code-capability authoring a Gate-A "needs-code" flag points at.
- Committing/graduating learned skills into the repo (manual `git add` for now).

## Risks / unknowns

1. **Gate B reliability (the big one).** A cheap walled-off model may emit dishonest/low-recall
   anchors → auto-author becomes auto-drift. **Mitigation:** the 2c spike is a hard gate before
   wiring; Gate-B-advisory fallback if it fails.
2. **`skill` vs `selfcode` vs `feedback` classification overlap** on the cheap chain — crisp
   examples; safe fallback `answer`; refine-from-failure must not mis-fire on ordinary corrections.
3. **Self-select precision** — if Houge over-applies an irrelevant in-scope skill. Mitigated by the
   ≤4 cap + clear `when:` lines; the selector step is the escape hatch if it degrades.
4. **Codex authoring latency** vs Telegram UX → ack-then-deliver async (Phase 1 pattern).

## Verification

Build + independent-verification subagents on Claude (keep main context clean); the LIVE gate per
sub-phase stays interactive — Paco drives the Telegram message, agent observes run-store + `skills/`
+ relay. Gates per sub-phase: typecheck clean · `npm test` green · `npm run build` OK ·
`dependencies: {}` · LIVE run on the real pi→kimi chain (+ real Codex for 2b/2c).
