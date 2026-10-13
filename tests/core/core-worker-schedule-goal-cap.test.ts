import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { SCHEDULE_GOAL_CHAR_CAP } from "../../src/run/schedule-spec.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

// 2026-10-13: the daily Alishan check stopped at `"https://` because the goal was cut at 300
// characters with no error, while the tool told the model it could write 2000. A scheduled goal
// replays as the next fire's message, so a silent cut breaks the task a day later, unseen.
pinOmpEnv();
pinEnabledFlags();
let tmp: ReturnType<typeof shortTmp>;
let store: RunStore;

beforeEach(() => {
  tmp = shortTmp("hcgc-");
  store = RunStore.openInMemory();
  process.env.HOUGE_SCHEDULER_ENABLED = "1";
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
});
afterEach(() => {
  store.close();
  tmp.cleanup();
  delete process.env.HOUGE_TOMBSTONE_PATH;
});

function scheduleCall() {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "定时查房",
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" },
    idempotency_key: "schedule-goal-cap-test", source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }), intake.run_id, tmp.dir).call;
}

const longGoal = (n: number) => `每天查阿里山空房，然后运行：curl -s "https://example.test/q?a=1" ${"x".repeat(n)}`.slice(0, n);

describe("schedule_task keeps the whole goal up to the declared 2000 characters", () => {
  it("the stored cap equals the tool's declared maxLength", () => {
    expect(SCHEDULE_GOAL_CHAR_CAP).toBe(2000);
  });

  it("stores a 1500-character goal in full on create and on update", async () => {
    const call = scheduleCall();
    const created = await call("schedule_task", { goal: longGoal(1500), spec: { kind: "daily", at: "11:00" }, tz: "Australia/Sydney" });
    expect(created.isError).toBe(false);
    const [row] = store.listScheduledTasks("555");
    expect(row!.goal).toBe(longGoal(1500));
    expect((await call("schedule_task", { update: row!.schedule_id, goal: longGoal(1800) })).isError).toBe(false);
    expect(store.getScheduledTask(row!.schedule_id)!.goal).toBe(longGoal(1800));
  });

  it("refuses a goal past the cap with an error and changes nothing", async () => {
    const call = scheduleCall();
    const over = await call("schedule_task", { goal: longGoal(2001), spec: { kind: "daily", at: "11:00" }, tz: "Australia/Sydney" });
    expect(over.isError).toBe(true);
    expect(store.listScheduledTasks("555")).toHaveLength(0);
  });
});
