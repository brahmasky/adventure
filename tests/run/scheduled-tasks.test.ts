import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

let store: RunStore;
beforeEach(() => {
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
});

const NOW = "2026-07-15T00:00:00.000Z";

function addTask(overrides: Partial<Parameters<RunStore["addScheduledTask"]>[0]> = {}) {
  return store.addScheduledTask({
    chat_id: "555",
    goal: "AI周报：搜HN/X本周AI新闻并总结",
    spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
    tz: "Australia/Sydney",
    next_run_at: "2026-07-19T22:00:00.000Z",
    created_by: "run:run_test",
    now: NOW,
    ...overrides
  });
}

describe("scheduled_tasks store (B10b, ADR 0017)", () => {
  it("addScheduledTask mints a sch_ id and inserts an enabled row with a zeroed failure counter", () => {
    const row = addTask();
    expect(row.schedule_id).toMatch(/^sch_/);
    expect(row).toMatchObject({
      chat_id: "555",
      goal: "AI周报：搜HN/X本周AI新闻并总结",
      tz: "Australia/Sydney",
      state: "enabled",
      next_run_at: "2026-07-19T22:00:00.000Z",
      last_fired_at: null,
      consecutive_failures: 0,
      created_by: "run:run_test",
      created_at: NOW,
      updated_at: NOW
    });
    expect(store.getScheduledTask(row.schedule_id)).toEqual(row);
  });

  it("listScheduledTasks scopes to a chat when given one; countActiveSchedules counts enabled only", () => {
    const a = addTask();
    const b = addTask({ chat_id: "999" });
    expect(store.listScheduledTasks().length).toBe(2);
    expect(store.listScheduledTasks("555").map((r) => r.schedule_id)).toEqual([a.schedule_id]);
    expect(store.countActiveSchedules("555")).toBe(1);
    store.cancelScheduledTask(a.schedule_id, NOW);
    expect(store.countActiveSchedules("555")).toBe(0);
    // The other chat's schedule is untouched.
    expect(store.getScheduledTask(b.schedule_id)!.state).toBe("enabled");
  });

  it("cancelScheduledTask flips enabled→disabled (never DELETE) and is false on a second call", () => {
    const row = addTask();
    expect(store.cancelScheduledTask(row.schedule_id, NOW)).toBe(true);
    const after = store.getScheduledTask(row.schedule_id)!;
    expect(after.state).toBe("disabled");
    // The row survives — cancel is a reversible state flip, not a delete.
    expect(store.listScheduledTasks("555").length).toBe(1);
    expect(store.cancelScheduledTask(row.schedule_id, NOW)).toBe(false);
    expect(store.cancelScheduledTask("sch_missing", NOW)).toBe(false);
  });

  it("a 'failed' row is cancellable too — otherwise its ⚠ list entry could never be cleared (verifier F2)", () => {
    const row = addTask();
    for (let i = 0; i < 3; i += 1) store.recordScheduleFailure(row.schedule_id, NOW, 3);
    expect(store.getScheduledTask(row.schedule_id)!.state).toBe("failed");
    expect(store.cancelScheduledTask(row.schedule_id, NOW)).toBe(true);
    expect(store.getScheduledTask(row.schedule_id)!.state).toBe("disabled");
  });

  it("listDueScheduledTasks returns enabled rows due at/before now, soonest first, capped", () => {
    const due1 = addTask({ next_run_at: "2026-07-14T00:00:00.000Z" });
    const due2 = addTask({ next_run_at: "2026-07-15T00:00:00.000Z" }); // exactly now = due
    addTask({ next_run_at: "2026-07-16T00:00:00.000Z" }); // future — not due
    const cancelled = addTask({ next_run_at: "2026-07-13T00:00:00.000Z" });
    store.cancelScheduledTask(cancelled.schedule_id, NOW); // disabled — never due
    expect(store.listDueScheduledTasks(NOW, 3).map((r) => r.schedule_id))
      .toEqual([due1.schedule_id, due2.schedule_id]);
    expect(store.listDueScheduledTasks(NOW, 1).map((r) => r.schedule_id)).toEqual([due1.schedule_id]);
  });

  it("markScheduleFired advances the cursor, stamps last_fired_at, and resets the failure counter", () => {
    const row = addTask({ next_run_at: "2026-07-14T00:00:00.000Z" });
    store.recordScheduleFailure(row.schedule_id, NOW, 3);
    expect(store.getScheduledTask(row.schedule_id)!.consecutive_failures).toBe(1);
    store.markScheduleFired(row.schedule_id, NOW, "2026-07-19T22:00:00.000Z");
    const after = store.getScheduledTask(row.schedule_id)!;
    expect(after.last_fired_at).toBe(NOW);
    expect(after.next_run_at).toBe("2026-07-19T22:00:00.000Z");
    expect(after.consecutive_failures).toBe(0);
    expect(after.state).toBe("enabled");
  });

  it("recordScheduleFailure counts up and flips the row to 'failed' at the max (stops retrying)", () => {
    const row = addTask({ next_run_at: "2026-07-14T00:00:00.000Z" });
    expect(store.recordScheduleFailure(row.schedule_id, NOW, 3)).toEqual({ failures: 1, failed: false });
    expect(store.recordScheduleFailure(row.schedule_id, NOW, 3)).toEqual({ failures: 2, failed: false });
    expect(store.recordScheduleFailure(row.schedule_id, NOW, 3)).toEqual({ failures: 3, failed: true });
    const after = store.getScheduledTask(row.schedule_id)!;
    expect(after.state).toBe("failed");
    // A failed row is no longer due.
    expect(store.listDueScheduledTasks(NOW, 3)).toEqual([]);
    // Missing rows are a no-op, never a throw.
    expect(store.recordScheduleFailure("sch_missing", NOW, 3)).toEqual({ failures: 0, failed: false });
  });
});
