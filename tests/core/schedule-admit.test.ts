import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildScheduleCapError, buildScheduleCancelledDigest, SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR, SCHEDULE_TASK_INVALID_SPEC_ERROR,
  SCHEDULE_TASK_NO_CHAT_ERROR, SCHEDULE_TASK_UPDATE_EMPTY_ERROR, SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR
} from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

pinOmpEnv();
pinEnabledFlags();
let tmp: ReturnType<typeof shortTmp>;
let store: RunStore;
let savedCap: string | undefined;
let n = 0;

beforeEach(() => {
  tmp = shortTmp("hsad-");
  store = RunStore.openInMemory();
  savedCap = process.env.HOUGE_SCHEDULER_MAX_PER_CHAT;
  process.env.HOUGE_SCHEDULER_ENABLED = "1";
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  tmp.cleanup();
  delete process.env.HOUGE_TOMBSTONE_PATH;
  if (savedCap === undefined) delete process.env.HOUGE_SCHEDULER_MAX_PER_CHAT;
  else process.env.HOUGE_SCHEDULER_MAX_PER_CHAT = savedCap;
});

const SPEC = { kind: "daily", at: "08:00" };
const SPEC_JSON = '{"kind":"daily","at":"08:00"}';

function seed(chat_id: string, goal: string, state?: "disabled") {
  const row = store.addScheduledTask({
    chat_id, goal, now: "2026-10-08T00:00:00.000Z", spec_json: SPEC_JSON,
    tz: "Australia/Sydney", next_run_at: "2099-01-01T00:00:00.000Z"
  });
  if (state === "disabled") store.cancelScheduledTask(row.schedule_id);
  return row;
}

function start(notify: Record<string, unknown>, source: "telegram" | "cli") {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source, type: "turn", program: "turn", goal: "schedule admit",
    requested_by: { kind: "user", id: "paco" }, notify,
    idempotency_key: `schedule-admit-${++n}`, source_reference: `${source}:update:${n}:message:${n}`
  } as never));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  const { call } = bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }), intake.run_id, tmp.dir);
  return { run_id: intake.run_id, call };
}
const chatRun = () => start({ kind: "telegram", chat_id: "555" }, "telegram");
const rows = (run_id: string) =>
  store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "schedule.admit").map((d) => [d.verdict, d.reason_code]);
const answer = (c: string) => (JSON.parse(c) as { answer: string }).answer;

describe("schedule.admit rows", () => {
  it("create new records admit/create; the same create again records exists/create naming the first id", async () => {
    const { run_id, call } = chatRun();
    const a = await call("schedule_task", { spec: SPEC, goal: "daily brief", tz: "Australia/Sydney" });
    expect(a.isError).toBe(false);
    expect(rows(run_id)).toEqual([["admit", "create"]]);
    const id = store.listScheduledTasks("555")[0]!.schedule_id;
    const b = await call("schedule_task", { spec: SPEC, goal: "daily brief", tz: "Australia/Sydney" });
    expect(b.isError).toBe(false);
    expect(answer(b.content)).toContain(id);
    expect(answer(b.content)).toContain("Already scheduled");
    expect(rows(run_id)).toEqual([["admit", "create"], ["exists", "create"]]);
  });

  it("create at the per-chat cap records refuse/cap with the cap error", async () => {
    process.env.HOUGE_SCHEDULER_MAX_PER_CHAT = "1";
    seed("555", "already");
    const { run_id, call } = chatRun();
    const r = await call("schedule_task", { spec: SPEC, goal: "another", tz: "Australia/Sydney" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(buildScheduleCapError(1));
    expect(rows(run_id)).toEqual([["refuse", "cap"]]);
  });

  it("cancel own records admit/cancel; bad shape, missing and other-chat record refuse/not_found", async () => {
    const own = seed("555", "mine");
    const foreign = seed("999", "theirs");
    const { run_id, call } = chatRun();
    const ok = await call("schedule_task", { cancel: "1" });
    expect(answer(ok.content)).toBe(buildScheduleCancelledDigest(own.schedule_id));
    expect(rows(run_id)).toEqual([["admit", "cancel"]]);
    for (const arg of ["abc", "sch_missing", foreign.schedule_id]) {
      const r = await call("schedule_task", { cancel: arg });
      expect(r.isError).toBe(true);
      expect(r.content).toContain(SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR);
    }
    expect(rows(run_id)).toEqual([["admit", "cancel"], ["refuse", "not_found"], ["refuse", "not_found"], ["refuse", "not_found"]]);
    expect(store.getScheduledTask(foreign.schedule_id)!.state).toBe("enabled");
  });

  it("update own goal records admit/update; disabled, other-chat and missing record refuse/not_found", async () => {
    const own = seed("555", "mine");
    const gone = seed("555", "gone", "disabled");
    const foreign = seed("999", "theirs");
    const { run_id, call } = chatRun();
    const ok = await call("schedule_task", { update: own.schedule_id, goal: "new goal" });
    expect(ok.isError).toBe(false);
    expect(store.getScheduledTask(own.schedule_id)!.goal).toBe("new goal");
    expect(rows(run_id)).toEqual([["admit", "update"]]);
    for (const arg of [gone.schedule_id, foreign.schedule_id, "sch_missing"]) {
      const r = await call("schedule_task", { update: arg, goal: "x" });
      expect(r.content).toContain(SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR);
    }
    expect(rows(run_id)).toEqual([["admit", "update"], ["refuse", "not_found"], ["refuse", "not_found"], ["refuse", "not_found"]]);
  });

  it("validation returns record nothing: empty update, invalid create spec, and list", async () => {
    const own = seed("555", "mine");
    const { run_id, call } = chatRun();
    const empty = await call("schedule_task", { update: own.schedule_id });
    expect(empty.content).toContain(SCHEDULE_TASK_UPDATE_EMPTY_ERROR);
    const bad = await call("schedule_task", { spec: { kind: "nonsense" }, goal: "x" });
    expect(bad.content).toContain(SCHEDULE_TASK_INVALID_SPEC_ERROR);
    expect((await call("schedule_task", { list: true })).isError).toBe(false);
    expect(rows(run_id)).toEqual([]);
  });

  it("a run with no telegram chat records refuse/no_chat for list and for create", async () => {
    const { run_id, call } = start({ kind: "local" }, "cli");
    for (const input of [{ list: true }, { spec: SPEC, goal: "x" }]) {
      const r = await call("schedule_task", input);
      expect(r.isError).toBe(true);
      expect(r.content).toContain(SCHEDULE_TASK_NO_CHAT_ERROR);
    }
    expect(rows(run_id)).toEqual([["refuse", "no_chat"], ["refuse", "no_chat"]]);
  });

  it("verb precedence: cancel wins over update and records only the cancel row", async () => {
    const own = seed("555", "mine");
    const { run_id, call } = chatRun();
    const r = await call("schedule_task", { cancel: "1", update: "1", goal: "x" });
    expect(answer(r.content)).toBe(buildScheduleCancelledDigest(own.schedule_id));
    expect(rows(run_id)).toEqual([["admit", "cancel"]]);
  });

  it("a decisions insert fault leaves the created digest and schedule row unchanged and opens one decision_record_failed incident", async () => {
    const base = chatRun();
    const expectedCall = await base.call("schedule_task", { spec: SPEC, goal: "fault goal", tz: "Australia/Sydney" });
    const expected = answer(expectedCall.content).replace(/sch_[\w-]+/, "ID");
    for (const t of store.listScheduledTasks("555")) store.cancelScheduledTask(t.schedule_id);

    const { call } = chatRun();
    vi.spyOn(store, "insertDecision").mockImplementationOnce(() => { throw new Error("disk full"); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await call("schedule_task", { spec: SPEC, goal: "fault goal", tz: "Australia/Sydney" });
    expect(r.isError).toBe(false);
    expect(answer(r.content).replace(/sch_[\w-]+/, "ID")).toBe(expected);
    expect(store.listScheduledTasks("555").filter((t) => t.state === "enabled")).toHaveLength(1);
    expect(store.listOpenIncidents().filter((i) => i.kind === "decision_record_failed")).toHaveLength(1);
  });
});
