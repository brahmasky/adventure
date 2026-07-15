import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gateway } from "../../src/gateway/gateway.js";
import type { GatewayIntakeResult } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import {
  maybeFireScheduledTasks,
  SCHEDULE_MAX_CONSECUTIVE_FAILURES,
  SCHEDULE_TICK_MAX_FIRES_PER_TICK,
  SCHEDULE_TICK_WORKER_ID
} from "../../src/run/schedule-tick.js";
import type { ScheduleTickGateway, ScheduleTickWorker } from "../../src/run/schedule-tick.js";

let store: RunStore;
beforeEach(() => {
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
});

const NOW = "2026-07-20T00:00:00.000Z";
const ARMED = { HOUGE_SCHEDULER_ENABLED: "1" };

function addWeekly(overrides: Partial<Parameters<RunStore["addScheduledTask"]>[0]> = {}) {
  return store.addScheduledTask({
    chat_id: "555",
    goal: "AI周报：搜HN/X本周AI新闻并总结",
    spec_json: '{"kind":"weekly","day":"sun","at":"08:00"}',
    tz: "Australia/Sydney",
    // Due (in the past relative to NOW) — also exercises the misfire path.
    next_run_at: "2026-07-18T22:00:00.000Z",
    now: "2026-07-15T00:00:00.000Z",
    ...overrides
  });
}

/** A worker fake that records executed run_ids (the run itself is left queued). */
function fakeWorker(executed: Array<{ run_id: string; worker_id: string }>): ScheduleTickWorker {
  return {
    executeRun: async (run_id, worker_id) => {
      executed.push({ run_id, worker_id });
      return { status: "completed" };
    }
  };
}

describe("maybeFireScheduledTasks (B10b, ADR 0017)", () => {
  it("flag OFF (default): a due schedule never fires — the tick is inert", async () => {
    addWeekly();
    const executed: Array<{ run_id: string; worker_id: string }> = [];
    const result = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker(executed),
      now: NOW,
      env: {}
    });
    expect(result).toEqual({ fired: 0, skipped_duplicates: 0, failures: 0 });
    expect(executed).toEqual([]);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "schedule_fired")).toEqual([]);
  });

  it("fires a due schedule down the REAL gateway path: schedule-typed event, ledger audit, cursor advanced from NOW (misfire fires once)", async () => {
    const task = addWeekly();
    const executed: Array<{ run_id: string; worker_id: string }> = [];
    const result = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker(executed),
      now: NOW,
      env: ARMED
    });
    expect(result).toEqual({ fired: 1, skipped_duplicates: 0, failures: 0 });
    expect(executed.length).toBe(1);
    expect(executed[0]!.worker_id).toBe(SCHEDULE_TICK_WORKER_ID);

    // The run wears the schedule identity end-to-end (vestigial types now live).
    const run_id = executed[0]!.run_id;
    const fired = store.getLedgerEvents(run_id).filter((e) => e.event_type === "schedule_fired");
    expect(fired.length).toBe(1);
    expect(fired[0]!.payload).toMatchObject({
      schedule_id: task.schedule_id,
      scheduled_time: "2026-07-18T22:00:00.000Z"
    });
    const created = store.getLedgerEvents(run_id).filter((e) => e.event_type === "run_created");
    expect(created[0]!.payload.source).toBe("schedule");
    expect(created[0]!.payload.requester).toEqual({ kind: "schedule", id: task.schedule_id });

    // MISFIRE POLICY: the missed 07-19 08:00 Sydney occurrence fired ONCE; the cursor
    // advanced from NOW (2026-07-20) to the NEXT Sunday — never a burst of missed periods.
    const after = store.getScheduledTask(task.schedule_id)!;
    expect(after.last_fired_at).toBe(NOW);
    expect(after.next_run_at).toBe("2026-07-25T22:00:00.000Z"); // Sun 07-26 08:00 AEST
    expect(after.state).toBe("enabled");
    // Already advanced → a second tick at the same `now` has nothing due.
    const again = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker(executed),
      now: NOW,
      env: ARMED
    });
    expect(again).toEqual({ fired: 0, skipped_duplicates: 0, failures: 0 });
    expect(executed.length).toBe(1);
  });

  it("a scheduled bare-digit goal runs as a TURN — never swallowed as a rating reply (gateway guard)", async () => {
    // An active pending ask would normally intercept a bare digit from a human.
    store.writePendingRating({ chat_id: "555", asked_at: NOW, window_start: NOW });
    addWeekly({ goal: "3" });
    const executed: Array<{ run_id: string; worker_id: string }> = [];
    const result = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker(executed),
      now: NOW,
      env: ARMED
    });
    expect(result.fired).toBe(1);
    expect(executed.length).toBe(1);
    // The pending ask survives untouched — nothing was captured or cancelled.
    expect(store.getPendingRating("555")?.active).toBe(true);
  });

  it("a crash replay (duplicate idempotency key) dedupes into schedule_skipped_duplicate and still advances", async () => {
    const task = addWeekly();
    // Simulate the crash window: the FIRST tick created + executed the run, then we
    // rewind the cursor as if the process died before markScheduleFired persisted.
    const executed: Array<{ run_id: string; worker_id: string }> = [];
    await maybeFireScheduledTasks({ store, gateway: new Gateway(store), worker: fakeWorker(executed), now: NOW, env: ARMED });
    store.markScheduleFired(task.schedule_id, NOW, "2026-07-18T22:00:00.000Z"); // rewind

    const replay = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker(executed),
      now: NOW,
      env: ARMED
    });
    expect(replay).toEqual({ fired: 0, skipped_duplicates: 1, failures: 0 });
    // No second run executed; the skip is audited against the EXISTING run.
    expect(executed.length).toBe(1);
    const skipped = store
      .getLedgerEvents(executed[0]!.run_id)
      .filter((e) => e.event_type === "schedule_skipped_duplicate");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.payload).toMatchObject({
      schedule_id: task.schedule_id,
      idempotency_key: `schedule:${task.schedule_id}:2026-07-18T22:00:00.000Z`,
      existing_run_id: executed[0]!.run_id
    });
    // Advanced again — the replayed occurrence is consumed, not stuck due forever.
    expect(store.getScheduledTask(task.schedule_id)!.next_run_at).toBe("2026-07-25T22:00:00.000Z");
  });

  it("a once schedule fires exactly once, then the row flips to 'disabled'", async () => {
    const task = addWeekly({
      spec_json: '{"kind":"once","at_iso":"2026-07-19T00:00:00Z"}',
      next_run_at: "2026-07-19T00:00:00.000Z"
    });
    const executed: Array<{ run_id: string; worker_id: string }> = [];
    const result = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker(executed),
      now: NOW,
      env: ARMED
    });
    expect(result.fired).toBe(1);
    const after = store.getScheduledTask(task.schedule_id)!;
    expect(after.state).toBe("disabled");
    expect(after.last_fired_at).toBe(NOW);
  });

  it("a budget-fuse refusal PAUSES (no failure count, cursor kept) — the breaker must never brick schedules (verifier F3)", async () => {
    // A fuse lasts hours while ticks are seconds apart: counting fuse refusals parked
    // every schedule that came due during a fuse as 'failed' within ~3 cycles. A fuse is
    // this feature's designed blast-radius net (ADR 0003/0017), so it pauses; the misfire
    // policy then delivers exactly ONE catch-up fire when the fuse lifts.
    const task = addWeekly();
    const fusedGateway: ScheduleTickGateway = {
      intake: (): GatewayIntakeResult => ({
        ok: false,
        error: { code: "GLOBAL_BUDGET_FUSE", message: "paused" }
      })
    };
    for (let tick = 1; tick <= SCHEDULE_MAX_CONSECUTIVE_FAILURES + 2; tick += 1) {
      const result = await maybeFireScheduledTasks({
        store,
        gateway: fusedGateway,
        worker: fakeWorker([]),
        now: NOW,
        env: ARMED
      });
      expect(result.failures).toBe(0);
      const row = store.getScheduledTask(task.schedule_id)!;
      expect(row.state).toBe("enabled");
      expect(row.consecutive_failures).toBe(0);
      expect(row.next_run_at).toBe("2026-07-18T22:00:00.000Z"); // occurrence preserved
    }
  });

  it("a non-fuse intake refusal leaves the cursor for retry; three consecutive failures park the row as 'failed'", async () => {
    const task = addWeekly();
    const refusingGateway: ScheduleTickGateway = {
      intake: (): GatewayIntakeResult => ({
        ok: false,
        error: { code: "CONTRACT_COMPILE_FAILED", message: "bad contract" }
      })
    };
    const executed: Array<{ run_id: string; worker_id: string }> = [];
    for (let attempt = 1; attempt <= SCHEDULE_MAX_CONSECUTIVE_FAILURES; attempt += 1) {
      const result = await maybeFireScheduledTasks({
        store,
        gateway: refusingGateway,
        worker: fakeWorker(executed),
        now: NOW,
        env: ARMED
      });
      expect(result.failures).toBe(1);
      const row = store.getScheduledTask(task.schedule_id)!;
      // NOT advanced — the same occurrence retries next tick until the row fails.
      expect(row.next_run_at).toBe("2026-07-18T22:00:00.000Z");
      expect(row.consecutive_failures).toBe(attempt);
      expect(row.state).toBe(attempt < SCHEDULE_MAX_CONSECUTIVE_FAILURES ? "enabled" : "failed");
    }
    expect(executed).toEqual([]);
  });

  it("a corrupt stored spec counts as a failure instead of throwing", async () => {
    const task = addWeekly({ spec_json: "garbage" });
    const result = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker([]),
      now: NOW,
      env: ARMED
    });
    expect(result).toEqual({ fired: 0, skipped_duplicates: 0, failures: 1 });
    expect(store.getScheduledTask(task.schedule_id)!.consecutive_failures).toBe(1);
  });

  it("caps fires per tick — a backlog drains across cycles", async () => {
    for (let index = 0; index < SCHEDULE_TICK_MAX_FIRES_PER_TICK + 1; index += 1) {
      addWeekly({ chat_id: `chat-${index}` });
    }
    const executed: Array<{ run_id: string; worker_id: string }> = [];
    const first = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker(executed),
      now: NOW,
      env: ARMED
    });
    expect(first.fired).toBe(SCHEDULE_TICK_MAX_FIRES_PER_TICK);
    const second = await maybeFireScheduledTasks({
      store,
      gateway: new Gateway(store),
      worker: fakeWorker(executed),
      now: NOW,
      env: ARMED
    });
    expect(second.fired).toBe(1);
    expect(executed.length).toBe(SCHEDULE_TICK_MAX_FIRES_PER_TICK + 1);
  });
});
