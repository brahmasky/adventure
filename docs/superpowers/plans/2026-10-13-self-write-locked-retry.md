# Self-write: locked-path list, one guided retry, honest escalation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Houge's self-write stops failing on fixes that never needed a locked file: the writer is told the locked paths up front, gets one guided retry when it touches one, and Houge says "yours to make" only when a locked change is truly needed, with the writer's reason and a real title.

**Architecture:** All in the existing self-write loop (`CoreWorker.runSelfWrite`, `src/core/core-worker.ts`). The locked list is rendered from the guard's own `PROTECTED_DIRS` / `PROTECTED_FILES` (no second list). The guard still checks every attempt; a locked diff never lands. A sentinel file lets the writer declare a locked change unavoidable.

**Tech Stack:** Node + TypeScript, vitest, existing `selfWriteDeps` test seams.

**Spec:** the bounded design Paco approved in chat on 2026-10-13 ("yes do A now and B as a design" → "go ahead with B"), quoted under "Design" below. Evidence: ledger `self_write_blocked` events of 2026-10-07 (`src/omp/tools/schedule_task.json`) and 2026-10-13 run `run_5804d1db…` (`src/omp/tool-decls.ts`, a file the fix did not need: `validateInput` already enforces the declared `maxLength`).

## Design (approved)

1. **Tell the writer.** `buildSelfWriteTask` (core-worker.ts, `function buildSelfWriteTask`) gains a block listing every locked directory and file, rendered from `PROTECTED_DIRS` / `PROTECTED_FILES` exported by `src/capabilities/self-write-guard.ts`. The vague line "Likewise do NOT touch gate/identity/dependency/config files" is replaced by that list.
2. **One guided retry on a locked hit.** Today the guard branch (`// (d) CHECKER 1`) refines only when every denied path is an existing test; any other denial is terminal. New: a denial of non-test locked paths also refines once, if `attempt < maxAttempts` and no locked-path retry has happened yet in this run. The refine text: the writer touched `<paths>`, which are locked; revert those edits and fix the reported problem without them; if that is truly impossible, revert everything and write the reason in a file named `HOUGE_NEEDS_LOCKED.md` at the worktree root (one short paragraph naming the locked file and the change it needs).
3. **Honest escalation.** Terminal "yours to make" only when (a) the writer wrote `HOUGE_NEEDS_LOCKED.md`, or (b) the locked-path retry still touches a locked path. The notification quotes the writer's reason (case a; truncated to 500 chars and passed through the existing secret masking used for notifications) or says "it still needed `<paths>` after being told they are locked" (case b). The sentinel file is read and deleted BEFORE the guard runs, so it never appears in a diff, and is never published.
4. **A real title.** `src/omp/tools/self_write_propose.json` gains an optional `title` (`string`, `maxLength: 80`) described as "a short title for the fix, shown to Paco". `label` = sanitized title when present, else today's `summarizeFocus(focus)`.

Unchanged: the guard, `maxAttempts = 3`, the test-gate and reviewer refine paths, existing-test immutability, ledger event types (`self_write_blocked` keeps `attempted_paths`; it gains no new required field).

## Global Constraints

- `dependencies: {}` stays empty. Functions under 50 lines. Match surrounding style; no unrelated refactors.
- Never build in the main checkout; work in `.worktrees/self-write-locked-retry`.
- Protected files touched: `src/omp/tools/self_write_propose.json` (under `src/omp/`) — Paco's hand merge. `src/capabilities/self-write-guard.ts` is NOT edited (read-only import of its exports).
- Telegram text through the existing `selfWriteReport` path (rich renderer). Errors explicit, no silent catch (a failed sentinel read is logged and treated as "no sentinel").
- Tests in `tests/core/`, each stating why the behaviour matters. Existing tests stay unedited unless the plan names them.
- Conventional Commits, one concern per commit, stage files by name, attribution line per the session.

---

### Task 1: Locked list in the writer prompt, guided retry, sentinel, honest notification

**Files:**
- Modify: `src/core/core-worker.ts` — `buildSelfWriteTask`, the `// (d) CHECKER 1` guard branch in `runSelfWrite`, `buildHardDenyNotification`, `buildSelfWriteRefineTask` callers.
- Test: `tests/core/core-worker-selfwrite-locked.test.ts` (new). Read `tests/core/core-worker-selfwrite.test.ts` first and reuse its harness/stubs for `selfWriteDeps` (writer stub that edits files in the worktree per attempt, guard, test gate, reviewer).

**Interfaces:**
- Consumes: `PROTECTED_DIRS`, `PROTECTED_FILES` from `src/capabilities/self-write-guard.ts`.
- Produces: `export function renderLockedPaths(): string` (core-worker.ts or a small sibling module `src/core/self-write-locked.ts`; the implementer picks and says why) and `export const NEEDS_LOCKED_FILE = "HOUGE_NEEDS_LOCKED.md"`.

- [ ] **Step 1: failing tests** (each a separate `it`, each with a one-line comment on why it matters):
  1. The writer's first task text contains `src/omp/`, `docs/decisions/`, `agents.md` and `src/capabilities/self-write-guard.ts`, and no longer contains "gate/identity/dependency/config files".
  2. Attempt 1 edits `src/omp/tool-decls.ts` + `src/run/schedule-spec.ts`; attempt 2 edits only `src/run/schedule-spec.ts`; gate and reviewer pass → the branch is published, NO `self_write_blocked` event, the attempt-2 task text names `src/omp/tool-decls.ts` as locked.
  3. Both attempts edit `src/omp/tool-decls.ts` → one `self_write_blocked` event; the notification says it still needed `src/omp/tool-decls.ts` after being told; exactly 2 writer calls (the locked retry happens once, not until `maxAttempts`).
  4. Attempt 1 touches `src/omp/x.ts`; attempt 2 reverts and writes `HOUGE_NEEDS_LOCKED.md` with a reason → terminal, the notification quotes the reason, the sentinel is not in any diff the guard saw, nothing is published.
  5. A sentinel containing a secret-shaped string (`sk-` + 40 chars) is masked in the notification.
  6. Existing behaviour kept: test-only denials still refine with today's text (assert one existing-test-edit case still publishes on the retry).
- [ ] **Step 2:** run `npx vitest run tests/core/core-worker-selfwrite-locked.test.ts` → FAIL for the right reasons.
- [ ] **Step 3:** implement. Keep the guard branch readable: extract the locked-retry decision into a helper under 50 lines. The locked-retry is allowed once per run (a boolean in the loop), only when `attempt < maxAttempts`.
- [ ] **Step 4:** the new file and `tests/core/core-worker-selfwrite.test.ts` pass; `npm run typecheck` clean.
- [ ] **Step 5:** commit `feat(self-write): tell the writer the locked paths and retry once without them`.

### Task 2: `title` on self_write_propose

**Files:**
- Modify (protected, Paco's merge): `src/omp/tools/self_write_propose.json` — add `"title": { "type": "string", "maxLength": 80, "description": "..." }` (not required).
- Modify: `src/core/core-worker.ts` — where the tool input reaches `runSelfWrite` (follow `case "self_write_propose"` and the `self_write_propose` branches near the evolution-tool dispatch) so `title` is passed through; `label` uses it.
- Test: extend the Task 1 test file.

- [ ] **Step 1: failing tests:** (a) with `title: "Schedule goal cap"` the hard-deny and publish notifications use that title, not the focus's first line; (b) without a title the label is `summarizeFocus(focus)` as today; (c) a title with a newline or backticks is flattened/escaped the same way the label is today; (d) `loadToolDeclarations` accepts the manifest and `validateInput` refuses an 81-char title.
- [ ] **Step 2–4:** red → implement → green; typecheck.
- [ ] **Step 5:** commit `feat(self-write): an optional title names the fix in Paco's notifications`.

### Task 3: Live check

**Files:**
- Create: `scripts/live-gate-self-write-locked.mjs`.

The gate exercises the real codex writer and the real guard against a throwaway clone, never the main checkout or the live DB:
- `git clone --local` the repo at HEAD into a temp dir under the gate's own temp root (deleted on every exit), symlink `node_modules`.
- Build the self-write deps with the real writer and guard, test gate and reviewer stubbed to pass (the subject is the writer/guard loop, not the suite).
- Task: a harmless real fix that a careless writer might place under `src/omp/` — "raise the `http_fetch` tool's declared description clarity" is NOT acceptable (it IS under src/omp). Use: "The schedule list shows goals capped at SCHEDULE_DISPLAY_NAME_CHARS; add a one-line comment above that constant explaining why it is lower than SCHEDULE_GOAL_CHAR_CAP" — the fix belongs in `src/run/schedule-spec.ts`. To force the retry path deterministically, run attempt 1 with a focus that explicitly instructs editing `src/omp/tool-decls.ts` as well, then let the loop's retry run normally.
- PASS: attempt 1 is denied for `src/omp/tool-decls.ts`; the retry's diff touches only unlocked paths; no `self_write_blocked`; the published branch (in the clone) contains the comment. A skipped or failed writer call is INCONCLUSIVE, never PASS.
- Print the writer calls made (expect 2) and clean up.

- [ ] Write the script; run `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-self-write-locked.mjs` from the worktree after `npm run build` there; paste the output into the report.
- [ ] Commit `test(self-write): live gate for the locked-path retry`.

### Task 4: Docs

- `docs/reference/` self-write section (find where self-write is documented; `grep -rn "self_write" docs/reference`), `tasks/todo.md` state block, `sessions.md` are written by the controller at ship. The implementer only updates the reference doc if one describes the guard/refine behaviour.
