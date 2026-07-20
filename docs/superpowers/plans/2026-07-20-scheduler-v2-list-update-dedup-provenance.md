# Scheduler v2 — list/update verbs, dedup-on-create, schedule-born provenance strip

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 2026-07-19 duplicate-schedule bug class and make "update my schedule" a first-class Telegram request: `schedule_task` gains `list` and `update` verbs, creation dedupes against identical enabled rows, and schedule-born runs lose the `schedule_task` capability entirely at contract-compile time.

**Architecture:** Four independent, individually-shippable changes on the existing Scheduler v1 stack (B10b, ADR 0017). Store mutation added to `RunStore`; adapter verbs added to `executeScheduleTask` in `core-worker.ts` (mirroring the existing cancel branch's own-chat scoping and code-rendered digests); dedup is a pre-insert lookup in the same adapter; the provenance strip is a one-conditional change in `compileTurnContract` — the tool manifest already derives from `contract.allowed_actions`, so removing the action there removes the tool from the model's menu mechanically.

**Tech Stack:** TypeScript ESM, node:sqlite via `RunStore`, Vitest. Feature flag `HOUGE_SCHEDULER_ENABLED` (existing) arms everything; no new flags.

**Motivating incident (2026-07-19):** the weekly AI周报 fire replayed its goal text as a fresh turn; the LLM misread it as a request to *create* the schedule and inserted a duplicate (`sch_b6095c61`). Separately, Paco's feedback ("以后加上悉尼AI工作机会") could not be persisted because the model has no list/update verbs. Root causes: provenance never surfaced (fix: Task 6), no creation idempotency (fix: Task 5), no update path (fix: Tasks 1–4).

**Background reading for the engineer:**
- `docs/decisions/0017-scheduler.md` — Scheduler v1 design (fire-then-run, idempotent occurrences, per-chat cap).
- `src/core/core-worker.ts:2428-2495` — the existing `executeScheduleTask` adapter (create + cancel). Every new verb copies its patterns: own-chat scoping via `getRunNotifyTarget`, id shape-check before lookup, refusals via exported constants, digests code-rendered (the model relays, never computes).
- `tests/core/core-worker-turn-loop.test.ts:1274-1440` — the existing loop-path schedule tests. New loop tests mirror the `turnRun` + `loopLlm` harness there.
- Run vitest as: `npx vitest run <file>` from the repo root.

**Conventions that are load-bearing in this repo (do not deviate):**
- Cross-chat / not-found refusals must read IDENTICALLY (no probe signal).
- Error strings and digests are exported constants/builders — tests assert via the exports, never pinned literals.
- Rows are never deleted; `disabled` is history.
- New code comments explain constraints, not narration; match the existing comment voice.

---

## File Structure

| File | Change |
|---|---|
| `src/run/run-store.ts` | Add `updateScheduledTask` next to `cancelScheduledTask` (~line 2775) |
| `src/run/schedule-spec.ts` | Receives `SCHEDULE_LIST_EMPTY_TEXT`, `SCHEDULE_GOAL_PREVIEW_CHARS`, `formatScheduleListText`, `formatScheduleLine` moved from gateway (both layers need the renderer; schedule-spec is the shared leaf both already import) |
| `src/gateway/gateway.ts` | Delete the moved block (~lines 902-940 area), re-export the moved names for existing importers |
| `src/core/core-worker.ts` | `executeScheduleTask`: add `list` + `update` branches, dedup-on-create; new digest builders + error constants at ~line 3271 block |
| `src/core/tool-manifest.ts` | `schedule_task` description/inputSketch documents all four verbs |
| `src/contracts/task-contract.ts` | `compileTurnContract`: strip `schedule_task` from `allowed_actions` when `event.source === "schedule"` |
| `docs/decisions/0017-scheduler.md` | Amendment section: scheduler v2 |
| `tests/run/scheduled-tasks.test.ts` | Store-level `updateScheduledTask` tests |
| `tests/core/core-worker-turn-loop.test.ts` | Loop tests: list, update, dedup, provenance-strip |
| `tests/contracts/task-contract.test.ts` | Contract test: schedule-born turn lacks `schedule_task` |
| `tests/gateway/gateway-telegram.test.ts` | Unchanged — its imports keep working via the gateway re-export |

Dependency order: Task 1 (store) → Task 2 (renderer move) → Tasks 3/4/5 (adapter verbs; independent of each other) → Task 6 (contract strip; independent of 1-5) → Task 7 (manifest text) → Task 8 (ADR + sweep).

---

### Task 1: `RunStore.updateScheduledTask`

**Files:**
- Modify: `src/run/run-store.ts` (insert directly after `cancelScheduledTask`, ~line 2775)
- Test: `tests/run/scheduled-tasks.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/run/scheduled-tasks.test.ts` (match the file's existing imports/describe style — it already imports `RunStore`):

```ts
describe("updateScheduledTask (scheduler v2)", () => {
  it("updates only the provided fields and stamps updated_at", () => {
    const store = RunStore.openInMemory();
    try {
      const row = store.addScheduledTask({
        chat_id: "555",
        goal: "old goal",
        spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z",
        now: "2026-07-20T00:00:00.000Z"
      });
      const ok = store.updateScheduledTask({
        schedule_id: row.schedule_id,
        goal: "new goal",
        now: "2026-07-21T00:00:00.000Z"
      });
      expect(ok).toBe(true);
      const after = store.getScheduledTask(row.schedule_id)!;
      expect(after.goal).toBe("new goal");
      expect(after.spec_json).toBe('{"kind":"weekly","day":"mon","at":"08:00"}'); // untouched
      expect(after.tz).toBe("Australia/Sydney"); // untouched
      expect(after.next_run_at).toBe("2099-01-01T00:00:00.000Z"); // untouched
      expect(after.updated_at).toBe("2026-07-21T00:00:00.000Z");
      expect(after.state).toBe("enabled");
    } finally {
      store.close();
    }
  });

  it("re-enables a failed row and resets its failure counter — fixing the row IS the repair path", () => {
    const store = RunStore.openInMemory();
    try {
      const row = store.addScheduledTask({
        chat_id: "555",
        goal: "g",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z"
      });
      // Park the row as 'failed' the way the tick does (3 consecutive failures).
      store.recordScheduleFailure(row.schedule_id, "2026-07-20T00:00:00.000Z", 1);
      expect(store.getScheduledTask(row.schedule_id)!.state).toBe("failed");

      const ok = store.updateScheduledTask({
        schedule_id: row.schedule_id,
        spec_json: '{"kind":"daily","at":"09:00"}',
        next_run_at: "2099-02-01T00:00:00.000Z"
      });
      expect(ok).toBe(true);
      const after = store.getScheduledTask(row.schedule_id)!;
      expect(after.state).toBe("enabled");
      expect(after.consecutive_failures).toBe(0);
      expect(after.spec_json).toBe('{"kind":"daily","at":"09:00"}');
      expect(after.next_run_at).toBe("2099-02-01T00:00:00.000Z");
    } finally {
      store.close();
    }
  });

  it("refuses absent and disabled rows — disabled is history, identical to cancel's scoping", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.updateScheduledTask({ schedule_id: "sch_missing", goal: "x" })).toBe(false);
      const row = store.addScheduledTask({
        chat_id: "555",
        goal: "g",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z"
      });
      store.cancelScheduledTask(row.schedule_id);
      expect(store.updateScheduledTask({ schedule_id: row.schedule_id, goal: "x" })).toBe(false);
      expect(store.getScheduledTask(row.schedule_id)!.goal).toBe("g"); // untouched
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/run/scheduled-tasks.test.ts`
Expected: FAIL — `store.updateScheduledTask is not a function`

- [ ] **Step 3: Implement `updateScheduledTask`**

In `src/run/run-store.ts`, insert after the `cancelScheduledTask` method:

```ts
  /**
   * Update an existing schedule in place (scheduler v2, ADR 0017 amendment). Only the
   * provided fields change; omitted fields keep the stored value. Enabled AND failed
   * rows are updatable — an update re-enables a failed row and resets its counter,
   * because fixing the goal/spec IS the repair path (cancel is the only other exit).
   * Disabled rows are history — untouchable, same scoping as cancel. next_run_at is
   * the CALLER's decision (the adapter recomputes it only when spec/tz changed).
   */
  updateScheduledTask(input: {
    schedule_id: string;
    goal?: string;
    spec_json?: string;
    tz?: string;
    next_run_at?: string;
    now?: string;
  }): boolean {
    const row = this.getScheduledTask(input.schedule_id);
    if (!row || row.state === "disabled") return false;
    const now = input.now ?? new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE scheduled_tasks
      SET goal = ?, spec_json = ?, tz = ?, next_run_at = ?,
          state = 'enabled', consecutive_failures = 0, updated_at = ?
      WHERE schedule_id = ? AND state IN ('enabled', 'failed')
    `).run(
      input.goal ?? row.goal,
      input.spec_json ?? row.spec_json,
      input.tz ?? row.tz,
      input.next_run_at ?? row.next_run_at,
      now,
      input.schedule_id
    );
    return result.changes === 1;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/run/scheduled-tasks.test.ts`
Expected: PASS (all, including pre-existing)

- [ ] **Step 5: Commit**

```bash
git add src/run/run-store.ts tests/run/scheduled-tasks.test.ts
git commit -m "feat(scheduler-v2): RunStore.updateScheduledTask — partial update, failed-row repair, disabled untouchable"
```

---

### Task 2: Move the schedule-list renderer to `schedule-spec.ts`

The `update`/`list` adapter (core layer) needs the same renderer the `/schedule` command (gateway layer) uses. Core must not import gateway; `schedule-spec.ts` is the shared leaf both already import. Move, then re-export from gateway so `tests/gateway/gateway-telegram.test.ts` imports keep working.

**Files:**
- Modify: `src/run/schedule-spec.ts` (append at end)
- Modify: `src/gateway/gateway.ts` (~lines 902-940: delete moved code, add re-export)

- [ ] **Step 1: Add the renderer to `schedule-spec.ts`**

Append to `src/run/schedule-spec.ts` (it already exports `parseScheduleSpec`, `describeScheduleSpec`, `formatInstantInZone`; `ScheduledTaskRow` comes from run-store — import it as a type):

```ts
import type { ScheduledTaskRow } from "./run-store.js";

/** `/schedule` reply when the chat has no visible (enabled/failed) schedules. */
export const SCHEDULE_LIST_EMPTY_TEXT =
  "No schedules for this chat yet. Ask Houge in plain language to schedule a recurring task.";

/** Goal preview length on a `/schedule` list row. */
export const SCHEDULE_GOAL_PREVIEW_CHARS = 60;

/**
 * Render the schedule list (B10b; moved from gateway in scheduler v2 — the
 * schedule_task list verb and the /schedule command share ONE renderer): one line per
 * non-disabled schedule. Failed rows keep their line, prefixed `⚠ failed · ` (the
 * owner must see a schedule that stopped retrying). Disabled rows are history — omitted.
 */
export function formatScheduleListText(rows: ScheduledTaskRow[]): string {
  const visible = rows.filter((row) => row.state !== "disabled");
  if (visible.length === 0) return SCHEDULE_LIST_EMPTY_TEXT;
  return visible.map((row) => formatScheduleLine(row)).join("\n");
}

function formatScheduleLine(row: ScheduledTaskRow): string {
  const spec = parseScheduleSpec(row.spec_json);
  const specText = spec ? describeScheduleSpec(spec) : "unreadable spec";
  // The city segment keeps the `next` clause short; the full IANA zone already rendered.
  const city = row.tz.split("/").pop() ?? row.tz;
  const goal =
    row.goal.length > SCHEDULE_GOAL_PREVIEW_CHARS
      ? `${row.goal.slice(0, SCHEDULE_GOAL_PREVIEW_CHARS)}…`
      : row.goal;
  const prefix = row.state === "failed" ? "⚠ failed · " : "";
  return `${prefix}${row.schedule_id} · ${specText} ${row.tz} · next ${formatInstantInZone(row.next_run_at, row.tz)} (${city}) · ${goal}`;
}
```

Cycle check done (2026-07-20): `run-store.ts` does NOT import `schedule-spec.ts` (only references it in comments), and the new import is `import type` — erased at build. No cycle; use the import as written.

- [ ] **Step 2: Delete the moved block from `gateway.ts` and re-export**

In `src/gateway/gateway.ts` delete `SCHEDULE_LIST_EMPTY_TEXT`, `SCHEDULE_GOAL_PREVIEW_CHARS`, `formatScheduleListText`, `formatScheduleLine` (keep `SCHEDULE_CANCEL_NOT_FOUND_TEXT` and `formatScheduleCancelledText` — they are command-path-only, not moving). Replace with:

```ts
export {
  SCHEDULE_LIST_EMPTY_TEXT,
  SCHEDULE_GOAL_PREVIEW_CHARS,
  formatScheduleListText
} from "../run/schedule-spec.js";
```

The internal call site `this.runStore.listScheduledTasks(chat_id)` → `formatScheduleListText(...)` at ~line 439 keeps working — the name now resolves via the re-export/import.

- [ ] **Step 3: Run the gateway + schedule-spec suites to prove the move is behavior-neutral**

Run: `npx vitest run tests/gateway/gateway-telegram.test.ts tests/run/schedule-spec.test.ts`
Expected: PASS, zero test-file edits

- [ ] **Step 4: Commit**

```bash
git add src/run/schedule-spec.ts src/gateway/gateway.ts
git commit -m "refactor(scheduler-v2): schedule-list renderer moves to schedule-spec — core and gateway share one renderer"
```

---

### Task 3: `schedule_task` `{list: true}` verb

**Files:**
- Modify: `src/core/core-worker.ts` — `executeScheduleTask` (~line 2435) + import block (~line 117)
- Test: `tests/core/core-worker-turn-loop.test.ts` (inside the existing `describe("schedule_task on the loop …")`)

- [ ] **Step 1: Write the failing test**

```ts
  it("list: returns the code-rendered list of the run's OWN chat's schedules only", async () => {
    const store = RunStore.openInMemory();
    try {
      const mine = store.addScheduledTask({
        chat_id: "555",
        goal: "AI周报",
        spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z"
      });
      store.addScheduledTask({
        chat_id: "999",
        goal: "other chat schedule",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z"
      });
      const run_id = turnRun(store, "我现在有哪些定时任务？");
      const worker = new CoreWorker(
        store,
        projectRoot(),
        loopLlm('{"intent":"answer"}', [
          '{"action":"schedule_task","input":{"list":true},"why":"user asked what is scheduled"}',
          '{"action":"final","answer":"你有一个每周一的AI周报。"}'
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      const steps = loopEvents(store, run_id, "loop_step");
      expect(steps[0]!.payload).toMatchObject({ action: "schedule_task", ok: true });
      const digest = String(steps[0]!.payload.result_digest);
      expect(digest).toBe(formatScheduleListText([mine])); // own chat only — 999's row absent
      expect(digest).toContain(mine.schedule_id);
      expect(digest).not.toContain("other chat schedule");
    } finally {
      store.close();
    }
  });
```

Add `formatScheduleListText` to this test file's imports (from `../../src/run/schedule-spec.js`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/core-worker-turn-loop.test.ts -t "list: returns"`
Expected: FAIL — adapter falls through `list` into spec parsing → `ok: false` with `SCHEDULE_TASK_INVALID_SPEC_ERROR`

- [ ] **Step 3: Implement the list branch**

In `src/core/core-worker.ts`:

(a) Extend the schedule-spec import block (~line 117) with `formatScheduleListText`:

```ts
import {
  computeNextRunAt,
  describeScheduleSpec,
  formatInstantInZone,
  formatScheduleListText,
  parseScheduleSpec,
  resolveSchedulerMaxPerChat,
  sanitizeScheduleGoal,
  type ScheduleSpec
} from "../run/schedule-spec.js";
```

(b) In `executeScheduleTask`, immediately after the `chat_id` line and BEFORE the cancel branch:

```ts
    // v2 list verb: the model's discovery path for update/cancel — the SAME renderer
    // as the /schedule command, scoped to the run's own chat (no cross-chat reads).
    // VERB PRECEDENCE (spec'd invariant, senior review 2026-07-20): first match wins,
    // in this order: list → cancel → update → create. Combined inputs resolve to the
    // first present verb; reordering these branches is a behavior change.
    if (input.list === true) {
      return {
        ok: true,
        output: { answer: formatScheduleListText(this.runStore.listScheduledTasks(chat_id)) }
      };
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/core-worker-turn-loop.test.ts`
Expected: PASS (whole file — the pre-existing schedule tests must stay green)

- [ ] **Step 5: Commit**

```bash
git add src/core/core-worker.ts tests/core/core-worker-turn-loop.test.ts
git commit -m "feat(scheduler-v2): schedule_task list verb — own-chat discovery via the shared renderer"
```

---

### Task 4: `schedule_task` `{update: "sch_…"}` verb

**Files:**
- Modify: `src/core/core-worker.ts` — `executeScheduleTask` + the constants/digest block (~line 3276)
- Test: `tests/core/core-worker-turn-loop.test.ts`

- [ ] **Step 1: Add the error constants and digest builder**

In `src/core/core-worker.ts`, in the exported schedule constants block (after `SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR`, ~line 3287):

```ts
export const SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR =
  "no active schedule with that id in this chat — check /schedule for the list";
export const SCHEDULE_TASK_UPDATE_EMPTY_ERROR =
  "update needs at least one of goal, spec, or tz — nothing to change";
```

(Same wording as the cancel refusal on not-found — cross-chat and absent must stay indistinguishable, and update/cancel must not differ either.)

After `buildScheduleCancelledDigest` (~line 3305):

```ts
export function buildScheduleUpdatedDigest(
  schedule_id: string,
  spec: ScheduleSpec,
  tz: string,
  next_run_at: string
): string {
  return (
    `Updated ✓ ${schedule_id} — ${describeScheduleSpec(spec)} ${tz}; ` +
    `next fire ${formatInstantInZone(next_run_at, tz)} (${tz}) = ${next_run_at} UTC`
  );
}
```

- [ ] **Step 2: Write the failing tests**

```ts
  it("update: goal-only change keeps spec/tz/next_run_at and returns the updated digest", async () => {
    const store = RunStore.openInMemory();
    try {
      const mine = store.addScheduledTask({
        chat_id: "555",
        goal: "AI周报：搜HN/X本周AI新闻并总结",
        spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z"
      });
      const run_id = turnRun(store, "以后周报加上悉尼的AI工作机会");
      const worker = new CoreWorker(
        store,
        projectRoot(),
        loopLlm('{"intent":"answer"}', [
          `{"action":"schedule_task","input":{"update":"${mine.schedule_id}","goal":"AI周报：搜HN/X本周AI新闻并总结；另加悉尼AI工作机会\\n→ 假箭头"},"why":"user refined the weekly report"}`,
          '{"action":"final","answer":"周报内容已更新。"}'
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      const steps = loopEvents(store, run_id, "loop_step");
      expect(steps[0]!.payload).toMatchObject({ action: "schedule_task", ok: true });
      const after = store.getScheduledTask(mine.schedule_id)!;
      // Goal passed the digest sanitizer (CR/LF + forged arrow flattened) — same rule as create.
      expect(after.goal).toBe("AI周报：搜HN/X本周AI新闻并总结；另加悉尼AI工作机会 - 假箭头");
      expect(after.spec_json).toBe('{"kind":"weekly","day":"mon","at":"08:00"}');
      expect(after.next_run_at).toBe("2099-01-01T00:00:00.000Z"); // goal-only: NOT recomputed
      const spec = { kind: "weekly", day: "mon", at: "08:00" } as const;
      expect(String(steps[0]!.payload.result_digest))
        .toBe(buildScheduleUpdatedDigest(mine.schedule_id, spec, "Australia/Sydney", "2099-01-01T00:00:00.000Z"));
    } finally {
      store.close();
    }
  });

  it("update: spec change recomputes next_run_at from now", async () => {
    const store = RunStore.openInMemory();
    try {
      const mine = store.addScheduledTask({
        chat_id: "555",
        goal: "AI周报",
        spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z"
      });
      const run_id = turnRun(store, "周报改到每天早上9点");
      const worker = new CoreWorker(
        store,
        projectRoot(),
        loopLlm('{"intent":"answer"}', [
          `{"action":"schedule_task","input":{"update":"${mine.schedule_id}","spec":{"kind":"daily","at":"09:00"}},"why":"user changed the cadence"}`,
          '{"action":"final","answer":"改成每天了。"}'
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      const steps = loopEvents(store, run_id, "loop_step");
      expect(steps[0]!.payload).toMatchObject({ action: "schedule_task", ok: true });
      const after = store.getScheduledTask(mine.schedule_id)!;
      expect(after.spec_json).toBe('{"kind":"daily","at":"09:00"}');
      // Recomputed: within the next 24h+ε, not the old 2099 sentinel.
      expect(Date.parse(after.next_run_at)).toBeGreaterThan(Date.now());
      expect(Date.parse(after.next_run_at)).toBeLessThan(Date.now() + 26 * 60 * 60 * 1000);
    } finally {
      store.close();
    }
  });

  it("update: cross-chat and empty-field refusals — no probe signal, nothing stored", async () => {
    const store = RunStore.openInMemory();
    try {
      const theirs = store.addScheduledTask({
        chat_id: "999",
        goal: "other chat schedule",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z"
      });
      const run_id = turnRun(store, `改一下 ${theirs.schedule_id}`);
      const worker = new CoreWorker(
        store,
        projectRoot(),
        loopLlm('{"intent":"answer"}', [
          `{"action":"schedule_task","input":{"update":"${theirs.schedule_id}","goal":"hijack"},"why":"user asked"}`,
          `{"action":"schedule_task","input":{"update":"${theirs.schedule_id}"},"why":"retry"}`,
          '{"action":"final","answer":"那个不是这个对话的日程。"}'
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      const steps = loopEvents(store, run_id, "loop_step");
      expect(steps[0]!.payload).toMatchObject({ action: "schedule_task", ok: false });
      expect(String(steps[0]!.payload.result_digest)).toContain(SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR);
      // Cross-chat row survives byte-identical.
      expect(store.getScheduledTask(theirs.schedule_id)!.goal).toBe("other chat schedule");
    } finally {
      store.close();
    }
  });
```

Add `buildScheduleUpdatedDigest` and `SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR` to the test file's core-worker imports.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/core/core-worker-turn-loop.test.ts -t "update:"`
Expected: FAIL (adapter treats the input as a malformed create → `SCHEDULE_TASK_INVALID_SPEC_ERROR`)

- [ ] **Step 4: Implement the update branch**

In `executeScheduleTask`, after the cancel branch and before `parseScheduleSpec(input.spec)` (the create path):

```ts
    // v2 update verb (ADR 0017 amendment): partial in-place edit of an own-chat row.
    // Same shape-check-before-lookup and identical-to-not-found refusal as cancel; the
    // goal passes the SAME sanitizer as create (it replays as a future turn text);
    // next_run_at recomputes ONLY when spec/tz changed — a goal edit must not move a
    // pending fire. Updating a 'failed' row re-enables it (store semantics, Task 1).
    if (typeof input.update === "string" && input.update.trim().length > 0) {
      const schedule_id = input.update.trim();
      if (!/^sch_[0-9a-fA-F-]{8,}$/.test(schedule_id)) {
        return { ok: false, error: SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR };
      }
      const row = this.runStore.getScheduledTask(schedule_id);
      if (!row || row.chat_id !== chat_id || row.state === "disabled") {
        return { ok: false, error: SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR };
      }
      const hasGoal = typeof input.goal === "string" && input.goal.trim().length > 0;
      const hasSpec = input.spec !== undefined && input.spec !== null;
      const hasTz = typeof input.tz === "string" && (input.tz as string).trim().length > 0;
      if (!hasGoal && !hasSpec && !hasTz) {
        return { ok: false, error: SCHEDULE_TASK_UPDATE_EMPTY_ERROR };
      }
      const goal = hasGoal ? sanitizeScheduleGoal(input.goal as string) : undefined;
      if (hasGoal && (goal === undefined || goal.length === 0)) {
        return { ok: false, error: SCHEDULE_TASK_GOAL_REQUIRED_ERROR };
      }
      const spec = hasSpec ? parseScheduleSpec(input.spec) : parseScheduleSpec(row.spec_json);
      // A corrupt STORED spec surfaces here too: the model must supply a fresh spec.
      if (!spec) {
        return { ok: false, error: SCHEDULE_TASK_INVALID_SPEC_ERROR };
      }
      const tz = hasTz ? resolveTimeZone((input.tz as string).trim()) : row.tz;
      if (!tz) {
        return { ok: false, error: SCHEDULE_TASK_INVALID_TZ_ERROR };
      }
      const now = new Date().toISOString();
      let next_run_at = row.next_run_at;
      if (hasSpec || hasTz) {
        const recomputed = computeNextRunAt(spec, tz, now);
        if (!recomputed) {
          return { ok: false, error: SCHEDULE_TASK_NEXT_UNCOMPUTABLE_ERROR };
        }
        next_run_at = recomputed;
      }
      const updated = this.runStore.updateScheduledTask({
        schedule_id,
        goal,
        spec_json: hasSpec ? JSON.stringify(spec) : undefined,
        tz: hasTz ? tz : undefined,
        next_run_at: hasSpec || hasTz ? next_run_at : undefined,
        now
      });
      // The store can still say no (state changed under us) — a digest must never
      // claim a write that didn't land.
      if (!updated) {
        return { ok: false, error: SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR };
      }
      return {
        ok: true,
        output: { answer: buildScheduleUpdatedDigest(schedule_id, spec, tz, next_run_at) }
      };
    }
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/core/core-worker-turn-loop.test.ts`
Expected: PASS (whole file)

- [ ] **Step 6: Commit**

```bash
git add src/core/core-worker.ts tests/core/core-worker-turn-loop.test.ts
git commit -m "feat(scheduler-v2): schedule_task update verb — partial edit, own-chat scoped, recompute only on spec/tz change"
```

---

### Task 5: Dedup-on-create

**Files:**
- Modify: `src/core/core-worker.ts` — create path of `executeScheduleTask` + digest block
- Test: `tests/core/core-worker-turn-loop.test.ts`

- [ ] **Step 1: Add the digest builder**

After `buildScheduleUpdatedDigest`:

```ts
export function buildScheduleExistsDigest(
  schedule_id: string,
  spec: ScheduleSpec,
  tz: string,
  next_run_at: string
): string {
  return (
    `Already scheduled ✓ ${schedule_id} — ${describeScheduleSpec(spec)} ${tz}; ` +
    `next fire ${formatInstantInZone(next_run_at, tz)} (${tz}) = ${next_run_at} UTC. No duplicate created — use {"update":"${schedule_id}"} to change it.`
  );
}
```

- [ ] **Step 2: Write the failing test**

```ts
  it("create dedups: an identical enabled row (chat+spec+tz+goal) short-circuits to the exists digest", async () => {
    const store = RunStore.openInMemory();
    try {
      const existing = store.addScheduledTask({
        chat_id: "555",
        goal: "AI周报",
        spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z"
      });
      const run_id = turnRun(store, "每周一早上8点给我AI周报");
      const worker = new CoreWorker(
        store,
        projectRoot(),
        loopLlm('{"intent":"answer"}', [
          '{"action":"schedule_task","input":{"goal":"AI周报","spec":{"kind":"weekly","day":"mon","at":"08:00"},"tz":"Australia/Sydney"},"why":"user asked for a weekly report"}',
          '{"action":"final","answer":"这个周报已经安排过了。"}'
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      const steps = loopEvents(store, run_id, "loop_step");
      expect(steps[0]!.payload).toMatchObject({ action: "schedule_task", ok: true });
      const spec = { kind: "weekly", day: "mon", at: "08:00" } as const;
      expect(String(steps[0]!.payload.result_digest))
        .toBe(buildScheduleExistsDigest(existing.schedule_id, spec, "Australia/Sydney", "2099-01-01T00:00:00.000Z"));
      expect(store.listScheduledTasks("555").length).toBe(1); // NO second row
    } finally {
      store.close();
    }
  });
```

Add `buildScheduleExistsDigest` to the test file's imports.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/core/core-worker-turn-loop.test.ts -t "create dedups"`
Expected: FAIL — two rows stored, digest is the created digest

- [ ] **Step 4: Implement dedup in the create path**

In `executeScheduleTask`'s create path, after the `goal` sanitize/validation and BEFORE the cap check (an idempotent no-op must not be refused by a full cap):

```ts
    // v2 dedup (the 2026-07-19 duplicate-AI周报 bug): an ENABLED row with identical
    // spec+tz+goal in this chat makes creation an idempotent no-op that names the
    // existing id — the model relays it instead of minting sch_ twins. Runs BEFORE the
    // cap check: refusing an idempotent retry because the cap is full would be wrong.
    const spec_json = JSON.stringify(spec);
    const duplicate = this.runStore
      .listScheduledTasks(chat_id)
      .find((r) => r.state === "enabled" && r.spec_json === spec_json && r.tz === tz && r.goal === goal);
    if (duplicate) {
      return {
        ok: true,
        output: {
          answer: buildScheduleExistsDigest(duplicate.schedule_id, spec, duplicate.tz, duplicate.next_run_at)
        }
      };
    }
```

Then change the existing `addScheduledTask` call to reuse the computed `spec_json` (`spec_json: spec_json` instead of `spec_json: JSON.stringify(spec)`).

- [ ] **Step 5: Run to verify it passes (and the create/cap tests stay green)**

Run: `npx vitest run tests/core/core-worker-turn-loop.test.ts`
Expected: PASS (whole file)

- [ ] **Step 6: Commit**

```bash
git add src/core/core-worker.ts tests/core/core-worker-turn-loop.test.ts
git commit -m "feat(scheduler-v2): dedup-on-create — identical enabled row returns the exists digest, never a twin"
```

---

### Task 6: Provenance strip — schedule-born runs lose `schedule_task`

**Files:**
- Modify: `src/contracts/task-contract.ts` — `compileTurnContract` (~line 171)
- Test: `tests/contracts/task-contract.test.ts`
- Test: `tests/core/core-worker-turn-loop.test.ts`

- [ ] **Step 1: Write the failing contract test**

In `tests/contracts/task-contract.test.ts`, add (mirror the file's existing event-construction style — read its first ~50 lines and reuse its helper for a turn event; construct one event with `source: "telegram"` and one with `source: "schedule"`, `requested_by: { kind: "schedule", id: "sch_test" }`):

```ts
  it("turn contract: a schedule-born run's allowed_actions EXCLUDE schedule_task (provenance strip, scheduler v2)", () => {
    const telegramEvent = buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "每周一早上8点给我AI周报",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: "t:1",
      source_reference: "telegram:update:1:message:1"
    });
    const scheduleEvent = buildTypedTaskEvent({
      source: "schedule",
      type: "turn",
      program: "turn",
      goal: "AI周报：搜索Hacker News和X/Twitter本周AI领域最新进展并总结",
      requested_by: { kind: "schedule", id: "sch_test" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: "schedule:sch_test:2026-07-26T22:00:00.000Z",
      source_reference: "scheduled_tasks.sch_test"
    });
    const fromTelegram = compileTaskContract(telegramEvent);
    const fromSchedule = compileTaskContract(scheduleEvent);
    if (!fromTelegram.ok || !fromSchedule.ok) throw new Error("contract compile failed");
    expect(fromTelegram.contract.allowed_actions).toContain("schedule_task");
    expect(fromSchedule.contract.allowed_actions).not.toContain("schedule_task");
    // The strip is the ONLY difference in the action envelope.
    expect(fromSchedule.contract.allowed_actions).toEqual(
      fromTelegram.contract.allowed_actions.filter((a) => a !== "schedule_task")
    );
  });
```

The file already imports `compileTaskContract` from `../../src/contracts/task-contract.js` and `buildTypedTaskEvent` from `../../src/domain/types.js` (lines 2-3) — no new imports needed. The result shape is `{ ok: true, contract }` as asserted throughout the existing tests.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/contracts/task-contract.test.ts`
Expected: FAIL — schedule-born contract still contains `schedule_task`

- [ ] **Step 3: Implement the strip**

In `src/contracts/task-contract.ts`, `compileTurnContract`, the `allowed_actions` array inside `base` currently lists `"schedule_task"` inline. Extract and filter:

```ts
  // Scheduler v2 provenance strip: a run BORN FROM a schedule fire must not create or
  // mutate schedules — its goal text is replayed schedule data, not a fresh user ask.
  // 2026-07-19: the weekly AI周报 fire misread its own goal as "set up a weekly report"
  // and minted a duplicate row. The capability leaves the envelope HERE, so the manifest
  // (derived from allowed_actions) never shows the tool and a scripted call is denied.
  const turnActions = [
    "intent_router",
    "web_search",
    "http_fetch",
    "to_local_time",
    "llm_answer",
    "lesson_write",
    // schedule_task (B10b, ADR 0017) is armed-listed like http_fetch: allowed in the
    // envelope, on the model's menu only when HOUGE_SCHEDULER_ENABLED arms it.
    "schedule_task",
    // wiki_build/wiki_refine (Phase W, ADR 0020) are armed-listed the same way:
    // allowed in the envelope, listed only when HOUGE_WIKI_ENABLED arms them.
    "wiki_build",
    "wiki_refine",
    "self_diagnose",
    "self_write_propose",
    "skill_author",
    // external_work (ADR 0023) is armed-listed like the other evolution tools: allowed in
    // the envelope, on the model's menu only when HOUGE_EXTWORK_ENABLED arms it.
    "external_work",
    // P2 bounty intake (spec 2026-07-18): armed-listed on HOUGE_BOUNTY_ENABLED.
    "bounty_scan",
    "project_track",
    "project_update",
    "project_list",
    "write_report"
  ].filter((action) => !(event.source === "schedule" && action === "schedule_task"));

  const base = {
    objective: event.goal,
    budget: { time_minutes: 10, max_tool_calls: 14, max_agent_delegations: 0 },
    allowed_actions: turnActions,
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid_action"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["local_write", "external_write", "destructive", "paid"] as SideEffectLevel[],
    stop_condition: "intent classified and answered, or budget exhausted",
    eval_hooks: []
  };

  return { ok: true, contract: { ...base, contract_hash: stableHash(base) } };
```

Only two real changes vs the current file: the array literal moves out of `base` into `turnActions` with the `.filter(...)` appended, and `base.allowed_actions` references it. Everything else (including the existing comments inside the array) is byte-identical to the current `compileTurnContract`. `contract_hash` is computed from `base` — schedule-born contracts hash differently, which is correct (different envelope ⇒ different hash).

- [ ] **Step 4: Write the failing loop test (end-to-end: unlisted + scripted call denied)**

In `tests/core/core-worker-turn-loop.test.ts`, first add a schedule-born twin of `turnRun` next to it (~line 117):

```ts
/** A run born from a schedule fire (source=schedule) — the v2 provenance-strip path. */
function scheduleRun(store: RunStore, goal: string, key = `s:${goal}`): string {
  const intake = new Gateway(store).intake(
    buildTypedTaskEvent({
      source: "schedule",
      type: "turn",
      program: "turn",
      goal,
      requested_by: { kind: "schedule", id: "sch_test" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: key,
      source_reference: "scheduled_tasks.sch_test"
    })
  );
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}
```

Then the test, in the schedule_task describe block:

```ts
  it("schedule-born run: schedule_task is unlisted and a scripted call is denied — no twin rows possible", async () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = scheduleRun(store, "AI周报：搜索Hacker News和X/Twitter本周AI领域最新进展并总结");
      const worker = new CoreWorker(
        store,
        projectRoot(),
        loopLlm('{"intent":"answer"}', [
          '{"action":"schedule_task","input":{"goal":"AI周报","spec":{"kind":"weekly","day":"mon","at":"08:00"},"tz":"Australia/Sydney"},"why":"set up the weekly report"}',
          '{"action":"final","answer":"本周AI进展如下……"}'
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      // Armed flag is ON (describe beforeEach) yet the manifest excludes the tool:
      // the strip happened at contract compile, upstream of arming.
      expect(loopEvents(store, run_id, "loop_started")[0]!.payload.manifest).not.toContain("schedule_task");
      const steps = loopEvents(store, run_id, "loop_step");
      expect(steps[0]!.payload).toMatchObject({ action: "schedule_task", ok: false });
      expect(store.listScheduledTasks("555").length).toBe(0); // nothing stored
    } finally {
      store.close();
    }
  });
```

(If the denial path parks/refuses differently than `ok: false` on a loop_step — check the existing "disarmed (default)" test at the end of the describe block and mirror its exact assertion shape for the denied call.)

- [ ] **Step 5: Run both files to verify green**

Run: `npx vitest run tests/contracts/task-contract.test.ts tests/core/core-worker-turn-loop.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/contracts/task-contract.ts tests/contracts/task-contract.test.ts tests/core/core-worker-turn-loop.test.ts
git commit -m "feat(scheduler-v2): provenance strip — schedule-born runs lose schedule_task at contract compile"
```

---

### Task 7: Manifest description — document the four verbs

**Files:**
- Modify: `src/core/tool-manifest.ts:108-119` (`schedule_task` entry)

- [ ] **Step 1: Replace description + inputSketch**

```ts
  schedule_task: {
    name: "schedule_task",
    description:
      "Manage this chat's scheduled tasks — four verbs in one tool. CREATE: schedule a recurring or one-time task; at each scheduled time Houge runs the given goal as a fresh message in this chat and sends the result ('每周一早上8点给我AI周报', 'remind me tomorrow 9am'). For a RELATIVE one-shot ('3分钟后', 'in 2 hours') pass {\"kind\":\"once\",\"in_minutes\":N} — never compute a UTC timestamp yourself. Creating an exact duplicate of an enabled schedule returns the existing id instead of a twin. LIST: pass {\"list\":true} to see this chat's schedules with their ids — do this FIRST when the user refers to an existing schedule. UPDATE: pass {\"update\":\"sch_...\"} plus any of goal/spec/tz to change an existing schedule in place — use this when the user refines a recurring task ('周报以后加上悉尼工作机会'); a goal-only update never moves the next fire time. CANCEL: pass {\"cancel\":\"sch_...\"}.",
    inputSketch:
      '{"goal":"AI周报：搜HN/X本周AI新闻并总结","spec":{"kind":"weekly","day":"mon","at":"08:00"} or {"kind":"daily","at":"08:00"} or {"kind":"once","in_minutes":3} or {"kind":"once","at_iso":"2026-07-20T22:00:00Z (only when the user stated an explicit absolute time)"},"tz":"Australia/Sydney (optional; defaults to your local timezone)"} — or {"list":true} — or {"update":"sch_...","goal":"...","spec":{...},"tz":"..."} (any subset of the three) — or {"cancel":"sch_..."}',
    category: "tool",
    side_effect_level: "none",
    risk_level: "low",
    output_limit_bytes: 100_000,
    armed: resolveSchedulerEnabled
  },
```

(Keep the comment block above the entry; extend its last line with: `// v2 adds list/update verbs + dedup-on-create; schedule-born runs never see this tool (contract strip).`)

- [ ] **Step 2: Run the manifest + loop suites**

Run: `npx vitest run tests/core/tool-manifest.test.ts tests/core/core-worker-turn-loop.test.ts`
Expected: PASS (manifest tests assert names/arming, not description prose — if one pins the old description literal, update that assertion to the new constant)

- [ ] **Step 3: Commit**

```bash
git add src/core/tool-manifest.ts
git commit -m "docs(scheduler-v2): schedule_task manifest teaches list/update/cancel verbs + dedup semantics"
```

---

### Task 8: ADR amendment, full sweep, ship

**Files:**
- Modify: `docs/decisions/0017-scheduler.md`

- [ ] **Step 1: Append the amendment section**

Append at the end of `docs/decisions/0017-scheduler.md`:

```markdown
## Amendment — Scheduler v2 (2026-07-20)

Incident: the 2026-07-19 weekly AI周报 fire replayed its goal as a fresh turn; the model
misread the goal text as a request to CREATE the schedule and minted a duplicate row
(`sch_b6095c61`). Separately, user feedback refining the report ("以后加上悉尼AI工作机会")
had no durable landing — the tool had no update verb, so the promise lived only in chat.

Four changes, each independently shippable:

1. **Provenance strip** — `compileTurnContract` removes `schedule_task` from
   `allowed_actions` when `event.source === "schedule"`. A run born from a schedule fire
   cannot create/mutate schedules; the manifest derives from the contract, so the tool
   never reaches the model's menu. Enforcement, not prompt advice.
2. **`{list:true}` verb** — own-chat discovery for the model, same renderer as `/schedule`
   (moved to `schedule-spec.ts`, re-exported from gateway).
3. **`{update:"sch_…"}` verb** — partial in-place edit (goal/spec/tz), own-chat scoped
   with not-found-identical refusals, goal through the same sanitizer as create,
   `next_run_at` recomputed only when spec/tz change. Updating a `failed` row re-enables
   it (repair path). Re-enable may exceed the per-chat cap: accepted — the cap remains a
   creation guard, not an invariant.
4. **Dedup-on-create** — an enabled row with identical chat+spec+tz+goal makes creation
   an idempotent no-op returning the existing id (checked before the cap, so idempotent
   retries never bounce off a full cap).

Unchanged: fire path, fire idempotency, per-chat cap semantics on genuine creates,
`/schedule` command behavior, `none/low` side-effect class (all four verbs are local
sqlite bookkeeping).
```

- [ ] **Step 2: Build + full suite**

Run: `npm run build && npx vitest run`
Expected: build clean; full suite green (baseline was 1674 tests; expect ~1690 with the additions — the number grows, never shrinks)

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/0017-scheduler.md
git commit -m "docs(adr-0017): scheduler v2 amendment — list/update verbs, dedup-on-create, provenance strip"
```

- [ ] **Step 4: Reload the daemon on the new dist** (deploy step — after Paco's go-ahead)

```bash
launchctl kickstart -k gui/501/com.houge.daemon
```

Then verify: heartbeat row advances within 2 minutes (`daemon_heartbeat.last_success_at`), and a Telegram smoke turn ("我现在有哪些定时任务？") returns the list digest.

---

## Post-ship verification (manual, next Monday 2026-07-27 08:00 AEST)

- Exactly ONE AI周报 arrives (sch_e8460e2d only; sch_b6095c61 stays disabled).
- The report contains the 悉尼/澳洲 AI jobs section (goal text updated 2026-07-20).
- No new `sch_` row appears after the fire (`SELECT COUNT(*) FROM scheduled_tasks` unchanged) — the provenance strip held.
- No `` mojibake in the report (the 2026-07-20 StringDecoder fix's first long-output test).
