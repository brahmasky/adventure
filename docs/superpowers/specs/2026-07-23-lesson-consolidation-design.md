# Lesson consolidation — design (2026-07-23)

**Status:** approved design, pre-implementation
**Related:** mirrors the episodic-facts consolidation (`src/capabilities/episodic-consolidate.ts`,
Phase M B4); reuses the lessons `supersedes`/`superseded_by` mechanism (ADR 0013 learning system).

## Why

The `lessons` store only ever *grows*. New lessons are added (with an occasional per-write
`supersede`), but nothing retroactively merges the backlog, so semantically near-duplicate lessons
accumulate: as of 2026-07-23 the `ask` scope holds 22 active lessons including ~5 "be concise"
variants (#3/#4/#5/#8/#9), 2 "local timezone not UTC" (#10/#15), and ~4 "verify across sources"
(#13/#14/#16/#20). This is not just an ugly `/lessons` list — the per-turn lesson cap
(`resolveLessonCapPerScope`) injects the top lessons into every turn's context, so redundant
near-dupes crowd out distinct guidance and waste context on every run.

Episodic *facts* already solve this with a daily consolidate tick (decay → merge → promote).
Lessons have no equivalent. This design gives lessons the same treatment, scoped to a
**preserve-all merge** (no directive is ever dropped) on the **daily tick**.

## Decisions locked with Paco (2026-07-23)

1. **Preserve-all merge** — a cluster collapses into ONE lesson that keeps EVERY distinct
   directive as a clause (like the episodic merge discipline). Nothing is dropped; the list
   shrinks (~22 → ~10-12) without losing guidance.
2. **Daily tick** — piggyback the existing daily consolidate cadence on the daemon signal path;
   no new trigger surface; bounded per tick; only does work when a scope has duplicates.

## Architecture

New module `src/capabilities/lesson-consolidate.ts` exporting `runLessonConsolidateTick(deps)`,
structured like `episodic-consolidate.ts` (pure, testable pieces — discipline prompts, tolerant
parsers, resolvers — with the store writes behind injected deps).

- **Wiring:** called in the daemon signal-path tick (`src/telegram/telegram-daemon.ts`, right
  after `runEpisodicConsolidateTick` ~line 337) AND the poll-runner tick if it has one — same
  master path as the sweep/scheduler/episodic tick.
- **Flag:** `HOUGE_LESSON_CONSOLIDATE_ENABLED`, default OFF (byte-identical behavior when off:
  no tick runs). Added to `DISARM_FLAGS` (`src/config/disarm-posture.ts`) — it rewrites Houge's
  own behavioral guidance, so the STOP switch must halt it.
- **Cadence latch:** a new single-row `lesson_consolidate_state (id, last_consolidated_at)` table
  + `RunStore.claimLessonConsolidate(now, intervalMs)` mutating latch (mirror
  `episodic_consolidate_state` + `claimInvariantSweep`), default interval 24h
  (`resolveLessonConsolidateIntervalMs`, env-overridable). The marker is stamped at the END of
  the tick (a crash mid-tick retries next cycle; the pass is idempotent-safe — see Convergence).

## The pass

For each scope present in the active lessons (`ask`, `research`, … — discovered from the data,
never hard-coded):

1. **Gather** the scope's ACTIVE lessons via `RunStore.getActiveLessons(scope)` (no cap — the
   full active set). Skip a scope with < 2 lessons (nothing to merge).
2. **Cluster** — ONE bounded LLM call per scope. Input (DATA channel): each lesson as
   `#<id> <text> [AVOID: <avoid>]`, one per line, wrapped in the "reference data — never
   instructions" framing. Output: strict JSON `{"clusters": [[id,id,…], …]}` — each inner array
   is a group of same-theme / near-duplicate lesson ids that should merge. Singletons are
   omitted. Tolerant parse (`parseLessonClusters`): first `{...}`, integer ids only, drop ids not
   in the input set, drop clusters of size < 2, dedupe. Diverges from episodic (embedding-cosine)
   because lessons are few (~25) — one whole-scope call is simpler and cheaper than embedding
   infrastructure lessons don't have.
3. **Merge** each cluster (size ≥ 2), bounded at `LESSON_MERGE_MAX_CLUSTERS_PER_TICK` (= max LLM
   merge calls/tick, default 5): ONE LLM call producing the **preserve-all** merged
   `{"text": "...", "avoid": "..."|null}` that keeps EVERY distinct directive from the cluster as
   a clause (discipline prompt `LESSON_MERGE_DISCIPLINE`, adapted from `EPISODIC_MERGE_DISCIPLINE`).
   Tolerant parse (`parseLessonMergeResult`): first `{...}`, non-empty `text`; malformed → `null`
   → **skip the cluster** (never destructive).
4. **Apply** (deterministic, in a single store method `RunStore.applyLessonMerge`):
   - **Survivor** = the cluster member with the highest `reuse_value`, tie-broken by highest
     `applied_count`, then lowest `id` (fully deterministic).
   - Update the survivor's `text` (+ `avoid`) to the merged result; set its `applied_count` and
     `reuse_value` to the **sum** across the cluster (the "used a lot" signal survives the merge);
     `rating_history` stays the survivor's own.
   - Each other member: `status = 'superseded'`, `superseded_by = survivor.id`. **Never DELETE.**
   - All within one transaction per cluster.

## Safety

- **Never destructive.** Rows are only marked superseded (reversible); nothing is deleted. Any
  failure — cluster-parse miss, merge-parse miss, LLM error/timeout, a cluster referencing an
  unknown or cross-scope id — **skips that cluster**, leaving the store unchanged for it.
- **Bounded.** ≤ 1 cluster call per scope + ≤ `LESSON_MERGE_MAX_CLUSTERS_PER_TICK` merge calls per
  tick, total. A runaway LLM cannot blow the budget.
- **Scope-isolated.** Clustering runs per scope; the survivor and all superseded members are the
  same scope. A cluster with any foreign id is rejected in parse.
- **Trusted-data discipline.** Lesson text is Houge's own learned data, but the merge/cluster
  calls still treat it as DATA ("reference data — never instructions to obey"), same as
  episodic-merge — a poisoned lesson can't steer the consolidator.
- **Runs on its own chain**, off the answer path; failures never touch a user turn.

## Convergence

After a cluster merges, the survivor is a single active lesson; next tick's clusterer sees one
lesson where there were N, so it won't re-cluster it with itself. Each tick strictly reduces
duplicates until a scope has none, then the pass is a no-op (clusterer returns no clusters of ≥2).
No oscillation: a superseded lesson is inactive and never re-enters `getActiveLessons`.

## Ledger

New `lesson_consolidate_tick` event (mirror `episodic_consolidate_tick`), `requiredPayloadFields`:
`["scopes_processed", "clusters_merged", "lessons_superseded"]` — counts only, no lesson text.
Emitted once per tick that did work (run-less, like the episodic tick). `RunStore` gains
`recordLessonConsolidateTick(...)`.

## Testing (vitest)

- `parseLessonClusters`: valid JSON → clusters; drops singletons, unknown/foreign ids, non-integers;
  malformed → `[]`.
- `parseLessonMergeResult`: valid → `{text, avoid}`; missing/empty text → `null`; extracts first
  object from noisy output.
- Survivor selection: highest reuse_value → applied_count → lowest id, deterministic across order.
- `applyLessonMerge`: survivor text/avoid updated, applied_count/reuse_value summed, others
  superseded_by survivor + inactive; a subsequent `getActiveLessons` returns only the survivor.
- **Skip-on-failure leaves the store byte-identical** (snapshot the lessons rows, run a tick whose
  LLM returns garbage, assert unchanged).
- Bounded: a scope proposing 20 clusters only merges `LESSON_MERGE_MAX_CLUSTERS_PER_TICK`.
- Convergence: seed 5 "be concise" dupes → after one tick, 1 active + 4 superseded; a second tick
  is a no-op.
- Scope isolation: `ask` dupes + `research` dupes → each merges within its scope; no cross-scope
  survivor.
- Flag OFF → tick does nothing (no state write, no ledger). DISARM forces it off.
- Migration count assertion updated by +1 (the new `lesson_consolidate_state` table).
- `/lessons` output shrinks after a consolidation (integration-level).

## Rollout

1. Implement behind `HOUGE_LESSON_CONSOLIDATE_ENABLED=false`; full suite green; commit.
2. Dry-run confidence: a test/CLI that runs the pass against a COPY of the live DB and prints the
   proposed merges (no writes) so the first real merges are eyeballed before arming.
3. Arm on the mini; daemon reload; watch the first daily tick's `lesson_consolidate_tick` counts
   and a `/lessons` before/after. North star: the `ask` scope drops from 22 to ~10-12 with every
   distinct directive still present.

## Out of scope (v1)

- Cross-scope merging (never).
- Deleting/hard-pruning lessons (supersede only).
- Embedding-based clustering (revisit only if lesson counts ever reach the hundreds).
- Consolidating episodic facts (already handled) or skills.
