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

The authoring muscle is **Codex** (build-time, `coding_agent_cli`, reusing Phase 1's
`coding-agent.ts` + `worktree.ts`), **auto-triggered** — "auto" means no manual trigger, not that the
cheap chain does the authoring. The cheap chain only **classifies/flags**; it never authors.

## Registry + visibility

- **`skills/REGISTRY.md`** — auto-regenerated on every write: name · scope · `when:` · #anchors ·
  version · last anchor score · origin. Generated view; never hand-edited.
- **`/skills [scope]`** — control command, idempotent, no run/budget (exactly like `/lessons`):
  lists skills on Telegram.

## Reporting (every attempt, whatever the outcome)

```
🐒 Skill attempt: "cross-check-figures" (research)
  Origin: you asked
  Gate A qualify: ✓ all 4 held
  Gate B anchors: ✗ 2/3 passed after 3 tries (failed: "units converted before compare")
  → Down-routed to a LESSON: "always convert units before comparing figures"
  Reverted nothing. /skills to view, reply to refine.
```

## New code (file pointers)

| Piece | Where | Notes |
|---|---|---|
| skill store | `src/skills/skill-store.ts` (new) | read-by-scope (≤cap), parse/validate frontmatter, write, list, regenerate `REGISTRY.md`. Filesystem under `skills/`. |
| composer skills layer | `src/prompt/composer.ts` | `skillsReader` option; "## Skills" block; omitted when empty (goldens unaffected). |
| `skill` intent | `src/capabilities/intent.ts` | add to `Intent` union + `INTENT_DISCIPLINE` examples ("write/teach a skill for X"); tolerant parse → `answer` fallback. |
| Gate A router | `src/capabilities/skill-router.ts` (new) | the 4-criteria qualify + down-route decision (→lesson / →code-flag); the fuzzy→ask path. |
| Gate B verifier | `src/capabilities/anchor-verify.ts` (new) | walled-off session: retrieve verification knowledge → emit {0,1} anchors → score; ≤3 passes. **Spiked before wired (2c).** |
| skill author | `src/capabilities/skill-author.ts` (new) | frames the authoring prompt; drives `coding_agent_cli` in a worktree (reuse Phase 1) to draft/refine; diff on refine. |
| routes | `src/core/core-worker.ts` | `executeSkill` (author/refine) dispatched from `executeTurn` on `intent==="skill"`; distill flag → promotion; reporting. |
| contract | `src/contracts/task-contract.ts` | `skill-author` contract: `allowed_actions` incl. `coding_agent_cli` + a write **scoped to `skills/` only**; everything else forbidden; `coding_agent_cli` stays forbidden in the normal `turn` contract. |
| `/skills` cmd | parser + trigger-adapter + `gateway.ts` | idempotent control command, like `/lessons`. |
| config | `docs/reference/configuration.md` | `HOUGE_SKILLS_ENABLED` (default **on** — kill switch; skills are read-only/low-risk), `HOUGE_SKILL_MAX_PER_SCOPE` (4), `HOUGE_SKILL_REFINE_PASSES` (3), `HOUGE_ANCHOR_MODEL` (the walled-off verifier model). |
| gitignore | `.gitignore` | add `skills/` (runtime state, like `memory/skills/` was). "Graduating" a skill to committed is a manual `git add`. |

## Containment / safety

- The `skill-author` contract's only write target is **`skills/`** — protected paths (secrets,
  `memory/core`, `src/`) are off-limits even here (a skill author cannot touch code or identity).
- Authoring runs in a **fresh worktree of HEAD** (Phase 1 mechanism) → no secrets, isolated.
- Gate B runs in a **walled-off session** with verification knowledge it retrieves itself — it never
  sees an answer key and never adopts the skill text as instructions (untrusted-data wall, ADR 0006).
- Auto-write is bounded: ≤4 skills/scope, ≤3 refine passes, every write reported + revertible.
- **The cheap runtime stays cheap:** it classifies/flags/applies only; all authoring + verification
  is build-time muscle (ADR 0010 build/runtime split holds).

## Sub-phasing (each independently shippable + live-gated)

- **2a — skills as loadable artifacts.** Format + `skills/` + `skill-store` + composer-loads-by-scope
  + `/skills` + `REGISTRY.md`. No authoring yet. **Live gate:** hand-author `skills/research/<x>.md`
  with a marker, send a research message, confirm the marker shows in behavior (absent before,
  present after) on the real pi→kimi chain — mirrors the v1 `/teach` live test.
- **2b — authoring + Gate A + reporting.** `skill` intent (on-command) → Codex author → write +
  report; Gate A qualify + down-route; distill promotion flag. **Live gate:** "猴哥, write a skill
  for X" → authored, written to `skills/`, reported via real Codex; and a tweak request down-routes
  to a lesson (verified in the report).
- **2c — Gate B anchor verifier + auto-author/refine loop. SPIKE-THEN-DECIDE.** The anchor verifier
  is the one genuinely unproven piece — a cheap walled-off model emitting honest world-fact `{0,1}`
  anchors. **First build it as a throwaway spike** and throw known-good + known-bad skills at it;
  **only if it measurably discriminates** do we wire auto-author + auto-refine to it. If it's weak,
  2c degrades to "Paco-confirmed author" (Gate B advisory, not blocking) and we revisit. **Live
  gate:** a real correction auto-refines a skill (diff + new score reported) and a deliberately-bad
  skill is caught by Gate B.

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
