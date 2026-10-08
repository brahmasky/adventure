import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildScheduleCancelledDigest, SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR, SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR
} from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { visibleSchedules } from "../../src/run/schedule-spec.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

pinOmpEnv();
pinEnabledFlags();
let tmp: ReturnType<typeof shortTmp>;
let store: RunStore;

beforeEach(() => {
  tmp = shortTmp("hcsn-");
  store = RunStore.openInMemory();
  process.env.HOUGE_SCHEDULER_ENABLED = "1";
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
});
afterEach(() => {
  store.close();
  tmp.cleanup();
  delete process.env.HOUGE_TOMBSTONE_PATH;
});

function seed(chat_id: string, goal: string, now: string) {
  return store.addScheduledTask({
    chat_id, goal, now, spec_json: '{"kind":"daily","at":"08:00"}',
    tz: "Australia/Sydney", next_run_at: "2099-01-01T00:00:00.000Z"
  });
}

function scheduleCall() {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "修改定时任务",
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" },
    idempotency_key: "schedule-number-test", source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }), intake.run_id, tmp.dir).call;
}

describe("schedule_task numbered update and cancel", () => {
  it("updates the second listed row by number and the first by #N without moving either fire", async () => {
    const first = seed("555", "first", "2026-10-08T00:00:00.000Z");
    const second = seed("555", "second", "2026-10-08T00:01:00.000Z");
    const foreign = seed("999", "foreign", "2026-10-08T00:02:00.000Z");
    const listed = visibleSchedules(store.listScheduledTasks("555"));
    expect(listed.map((row) => row.schedule_id)).toEqual([second.schedule_id, first.schedule_id]);
    const call = scheduleCall();

    expect((await call("schedule_task", { update: "2", goal: "x" })).isError).toBe(false);
    expect(store.getScheduledTask(first.schedule_id)).toMatchObject({ goal: "x", next_run_at: first.next_run_at });
    expect(store.getScheduledTask(second.schedule_id)!.goal).toBe("second");
    expect((await call("schedule_task", { update: "#1", goal: "y" })).isError).toBe(false);
    expect(store.getScheduledTask(second.schedule_id)).toMatchObject({ goal: "y", next_run_at: second.next_run_at });

    const missing = await call("schedule_task", { update: "3", goal: "hijack" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain(SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR);
    expect(store.getScheduledTask(foreign.schedule_id)!.goal).toBe("foreign");
  });

  it("cancels the first listed row and refuses invalid or disabled references", async () => {
    const first = seed("555", "first", "2026-10-08T00:00:00.000Z");
    const second = seed("555", "second", "2026-10-08T00:01:00.000Z");
    seed("999", "foreign", "2026-10-08T00:02:00.000Z");
    const call = scheduleCall();

    const cancelled = await call("schedule_task", { cancel: "1" });
    expect(cancelled.isError).toBe(false);
    expect((JSON.parse(cancelled.content) as { answer: string }).answer).toBe(buildScheduleCancelledDigest(second.schedule_id));
    expect(store.getScheduledTask(second.schedule_id)!.state).toBe("disabled");
    expect(store.getScheduledTask(first.schedule_id)!.state).toBe("enabled");

    for (const arg of ["0", "abc", "1.5", second.schedule_id]) {
      expect((await call("schedule_task", { update: arg, goal: "wrong" })).content).toContain(SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR);
      expect((await call("schedule_task", { cancel: arg })).content).toContain(SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR);
    }
    expect(store.getScheduledTask(first.schedule_id)!.goal).toBe("first");
  });
});
