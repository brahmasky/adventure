import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failureNotifyText, TURN_UNAVAILABLE_TEXT } from "../../src/core/omp-turn-wiring.js";
import { EVOLUTION_NOTICE_HEADER, type CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { mediaFailureReply, type TelegramMediaRef } from "../../src/media/media-config.js";
import { KILLED_TEXT, PLANNER_EXIT_TEXT, PlannerSupervisor } from "../../src/omp/planner-supervisor.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp, useFakeOmp } from "../helpers/omp-env.js";
import { drainOutbox, fakeLog, ompWorker, until } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

pinOmpEnv();
pinEnabledFlags();
const MEDIA_ENV = ["HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_EPISODIC_ENABLED", "HOUGE_WIKI_ENABLED", "HOUGE_TOMBSTONE_PATH"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
let worker: CoreWorker | undefined;
beforeEach(() => {
  for (const k of MEDIA_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = shortTmp("hcw-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.FAKE_OMP_ARGV_LOG = join(tmp.dir, "argv.log");
  store = RunStore.openInMemory();
});
afterEach(async () => {
  await worker?.shutdownPlanners();
  worker = undefined;
  store.close();
  tmp.cleanup();
  for (const k of MEDIA_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const state = (run: string) => store.getRunState(run);
const events = (run: string, type: string) => store.getLedgerEvents(run).filter((e) => e.event_type === type);

function mediaRun(ref: TelegramMediaRef): string {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "[voice message]", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `media:${ref.file_id}`, source_reference: "telegram:update:1:message:1",
    metadata: { telegram_update_id: 1, telegram_message_id: 1, media: ref }
  }));
  if (!intake.ok) throw new Error("intake failed");
  return intake.run_id;
}
const voice: TelegramMediaRef = { kind: "voice", file_id: "v1", file_unique_id: "vu1", mime_type: "audio/ogg", has_caption: false, file_size: 9000, duration: 7 };

describe("CoreWorker.submitTurn — turns run on the planner supervisor (Task 13)", () => {
  it("returns before the turn ends; the run later completes with a report and one final reply (the poll loop is never blocked by a turn)", async () => {
    useFakeOmp({ "*": { rpcText: "fake reply" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "hello there");
    expect(worker.submitTurn(run)).toBe(true);
    expect(state(run)).not.toBe("completed"); // handed over, not executed inline
    await until(() => state(run) === "completed");
    expect(events(run, "report_written")).toHaveLength(1);
    expect(events(run, "run_completed")).toHaveLength(1);
    const reply = drainOutbox(store).get(`${run}:final_report`);
    expect(reply?.text).toBe("fake reply");
    // B10a no-double-record pin (replaces core-worker-turn-loop.test.ts › "B10a no-double-record pin"): the
    // thread holds exactly the user + assistant turns; the final_report enqueue adds none.
    expect(store.getRecentChatTurns("555", 10).map((t) => [t.role, t.text])).toEqual([["user", "hello there"], ["assistant", "fake reply"]]);
  });

  it("a voice note is transcribed first and the planner is prompted with the transcript; the reply opens with the echo line", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    useFakeOmp({ "*": { rpcText: "ok", rpcEcho: true } }, tmp.dir);
    worker = ompWorker(store, tmp.dir, { media: {
      downloadFile: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
      mediaCall: async (input) => ({ ok: true, output: { question: input.question, answer: "transcribed", model: "m", provider: "p" } }),
      tmpRoot: tmp.dir
    } });
    const run = mediaRun(voice);
    worker.submitTurn(run);
    await until(() => state(run) === "completed");
    const prompts = fakeLog(join(tmp.dir, "argv.log")).map((l) => l.cmd as { type?: string; message?: string } | undefined).filter((c) => c?.type === "prompt");
    expect(prompts.map((c) => c?.message)).toEqual(["transcribed"]);
    expect(String(drainOutbox(store).get(`${run}:final_report`)?.text)).toMatch(/^🎙 I heard: “transcribed”\n\nok ECHO:transcribed$/);
  });

  it("a failed ingest fails the run through the media failure path: the old failure text, a partial report, no planner spawned", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    useFakeOmp({ "*": { rpcText: "never" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir, { media: { downloadFile: async () => { throw new Error("download_failed: http"); }, tmpRoot: tmp.dir } });
    const run = mediaRun(voice);
    worker.submitTurn(run);
    await until(() => state(run) === "failed");
    expect(drainOutbox(store).get(`${run}:final_report`)?.text).toBe(failureNotifyText(mediaFailureReply("voice", "download_failed")));
    expect(events(run, "run_failed")[0]?.payload).toMatchObject({ error_type: "media_failed" });
    expect(events(run, "report_written")[0]?.payload).toMatchObject({ partial: true });
    expect(fakeLog(join(tmp.dir, "argv.log"))).toEqual([]);
  });

  it("live gate case 6: omp refuses planner[0] at spawn — the turn completes on the next string, audited [model_missing, ok], never 'bridge disconnected'", async () => {
    useFakeOmp({ rpcBadModelAtStart: ["anthropic/claude-opus-5-5"], "*": { rpcText: "from the second string" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "hello");
    worker.submitTurn(run);
    await until(() => state(run) === "completed");
    expect(drainOutbox(store).get(`${run}:final_report`)?.text).toBe("from the second string");
    expect(events(run, "llm_attempt").map((e) => [e.payload.model, e.payload.error_kind])).toEqual([["claude-opus-5-5", "model_missing"], ["claude-opus-4-6", undefined]]);
    expect(events(run, "run_failed")).toEqual([]);
    const spawned = fakeLog(join(tmp.dir, "argv.log")).filter((l) => Array.isArray(l.argv) && (l.argv as string[]).includes("rpc"));
    expect(spawned.map((l) => (l.argv as string[])[(l.argv as string[]).indexOf("--model") + 1])).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]);
  });

  it("a non-turn run is refused (false) and left untouched for the old executeRun path", () => {
    worker = ompWorker(store, tmp.dir);
    const intake = new Gateway(store).intake(buildTypedTaskEvent({
      source: "telegram", type: "run", program: "research-brief", goal: "brief", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "rb", source_reference: "telegram:update:9:message:9"
    }));
    if (!intake.ok) throw new Error("intake failed");
    expect(worker.submitTurn(intake.run_id)).toBe(false);
    expect(state(intake.run_id)).toBe("queued");
    expect(worker.plannerSupervisors()).toEqual([]);
  });

  it("shutdownPlanners stops every child (no omp process outlives the daemon)", async () => {
    useFakeOmp({ "*": { rpcHangAfterPrompt: true } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    worker.submitTurn(createQueuedTurnRun(store));
    await until(() => fakeLog(join(tmp.dir, "argv.log")).some((l) => (l.cmd as { type?: string } | undefined)?.type === "prompt"));
    const pid = fakeLog(join(tmp.dir, "argv.log"))[0]?.pid as number;
    expect(() => process.kill(pid, 0)).not.toThrow();
    await worker.shutdownPlanners();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  });

  it("a turn whose chat id is not numeric fails loudly (incident + reply) instead of throwing inside the supervisor", () => {
    worker = ompWorker(store, tmp.dir);
    const intake = new Gateway(store).intake(buildTypedTaskEvent({
      source: "schedule", type: "turn", program: "turn", goal: "weekly digest", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "../../etc" }, idempotency_key: "sched-bad", source_reference: "schedule:sch_1"
    }));
    if (!intake.ok) throw new Error("intake failed");
    expect(worker.submitTurn(intake.run_id)).toBe(true);
    expect(state(intake.run_id)).toBe("failed");
    expect(drainOutbox(store).get(`${intake.run_id}:final_report`)?.text).toBe(TURN_UNAVAILABLE_TEXT);
    expect(store.listOpenIncidents().map((i) => i.kind)).toContain("planner_turn_refused");
    expect(worker.plannerSupervisors()).toEqual([]);
  });
});

describe("merged (steered) runs — one reply, the parent's (ruling 7)", () => {
  it("a message steered into a live turn completes with its parent but sends nothing and reports no tool calls", async () => {
    useFakeOmp({ "*": { rpcText: "both", rpcFinishOnSteer: true } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const parent = createQueuedTurnRun(store, "first");
    worker.submitTurn(parent);
    await until(() => fakeLog(join(tmp.dir, "argv.log")).some((l) => (l.cmd as { type?: string } | undefined)?.type === "prompt"));
    const child = createQueuedTurnRun(store, "second");
    worker.submitTurn(child);
    await until(() => state(parent) === "completed" && state(child) === "completed");
    const out = drainOutbox(store);
    expect(out.get(`${parent}:final_report`)?.text).toBe("both STEERED:second");
    expect(out.has(`${child}:final_report`)).toBe(false);
    expect(events(child, "run_completed")[0]?.payload).toMatchObject({ budget_used: { tool_calls: 0 } });
  });

  it("when the parent is killed, the merged run fails merged_parent_failed and sends nothing", async () => {
    useFakeOmp({ "*": { rpcHangAfterPrompt: true } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const parent = createQueuedTurnRun(store, "first");
    worker.submitTurn(parent);
    await until(() => fakeLog(join(tmp.dir, "argv.log")).some((l) => (l.cmd as { type?: string } | undefined)?.type === "prompt"));
    const child = createQueuedTurnRun(store, "second");
    worker.submitTurn(child);
    await until(() => fakeLog(join(tmp.dir, "argv.log")).some((l) => (l.cmd as { type?: string } | undefined)?.type === "steer"));
    await Promise.all(worker.plannerSupervisors().map((s) => s.abortAll("killed")));
    await until(() => state(parent) === "failed" && state(child) === "failed");
    const out = drainOutbox(store);
    expect(out.get(`${parent}:final_report`)?.text).toBe(KILLED_TEXT);
    expect(out.has(`${child}:final_report`)).toBe(false);
    expect(events(child, "run_failed")[0]?.payload).toMatchObject({ error_type: "merged_parent_failed" });
  });
});

describe("media turns never steer (fix round 1, I-1)", () => {
  it("submitTurn marks a voice/photo run needsIngest (a plain text run is not marked)", () => {
    const seen: Array<{ run_id: string; needsIngest?: boolean }> = [];
    const spy = vi.spyOn(PlannerSupervisor.prototype, "submit").mockImplementation((r) => { seen.push(r); });
    worker = ompWorker(store, tmp.dir);
    const text = createQueuedTurnRun(store, "hi");
    const media = mediaRun(voice);
    worker.submitTurn(text); worker.submitTurn(media);
    spy.mockRestore();
    expect(seen.find((r) => r.run_id === text)?.needsIngest).toBeUndefined();
    expect(seen.find((r) => r.run_id === media)?.needsIngest).toBe(true);
  });

  it("a schedule-born turn's approvals are answered by the operator; a Paco turn carries no override (B2)", () => {
    const seen: Array<{ run_id: string; approver?: unknown }> = [];
    const spy = vi.spyOn(PlannerSupervisor.prototype, "submit").mockImplementation((r) => { seen.push(r); });
    worker = ompWorker(store, tmp.dir, { operator: { kind: "user", id: "paco" } });
    const text = createQueuedTurnRun(store, "hi");
    const intake = new Gateway(store).intake(buildTypedTaskEvent({
      source: "schedule", type: "turn", program: "turn", goal: "push notes", requested_by: { kind: "schedule", id: "sch_1" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "schedule:sch_1:t", source_reference: "scheduled_tasks.sch_1"
    }));
    if (!intake.ok) throw new Error("intake failed");
    worker.submitTurn(text); worker.submitTurn(intake.run_id);
    spy.mockRestore();
    expect(seen.find((r) => r.run_id === text)?.approver).toBeUndefined();
    expect(seen.find((r) => r.run_id === intake.run_id)?.approver).toEqual({ kind: "user", id: "paco" });
  });
});

describe("shutdown with turns still queued (fix round 1, I-2)", () => {
  it("every queued turn fails planner_exit and its reply is queued for the exit flush", async () => {
    useFakeOmp({ "*": { rpcHangAfterPrompt: true } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const runs = [createQueuedTurnRun(store, "one"), createQueuedTurnRun(store, "two"), createQueuedTurnRun(store, "three")];
    for (const r of runs) worker.submitTurn(r);
    await until(() => fakeLog(join(tmp.dir, "argv.log")).some((l) => (l.cmd as { type?: string } | undefined)?.type === "prompt"));
    await worker.shutdownPlanners();
    const out = drainOutbox(store);
    for (const r of runs) {
      expect(state(r)).toBe("failed");
      expect(out.get(`${r}:final_report`)?.text).toBe(PLANNER_EXIT_TEXT);
    }
  });
});

describe("the outcome sink never lets a stale owner overwrite the winner's report (fix round 1, M-2)", () => {
  type Sink = { complete: (i: Record<string, unknown>) => void; fail: (i: Record<string, unknown>) => void };
  // The sink is private: tests reach it the way the supervisor does, through ompOutcomeSink(chatId).
  const sinkOf = (w: CoreWorker) => (w as unknown as { ompOutcomeSink: (chat: string) => Sink }).ompOutcomeSink("555");

  it("a complete or media_failed that loses finishRun writes no report file and leaves no temp file", () => {
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store);
    store.claimRun(run, "planner:555:winner", 120);
    const dir = join(tmp.dir, "project", "runs", run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), "WINNER");
    sinkOf(worker).complete({ run_id: run, worker_id: "planner:555:stale", text: "stale", attachments: [], duration_ms: 1, tool_calls: 0 });
    sinkOf(worker).fail({ run_id: run, worker_id: "planner:555:stale", error_type: "media_failed", error_ref: "x" });
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("WINNER");
    expect(readdirSync(dir)).toEqual(["report.md"]);
    expect(events(run, "report_written")).toEqual([]);
  });

  it("a report that cannot be written fails the run with an errno code, never the fs message or path (fix round 2, M-6)", () => {
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store);
    store.claimRun(run, "planner:555:winner", 120);
    mkdirSync(join(tmp.dir, "project", "runs"), { recursive: true });
    writeFileSync(join(tmp.dir, "project", "runs", run), "a file where the run's directory should be");
    sinkOf(worker).complete({ run_id: run, worker_id: "planner:555:winner", text: "x", attachments: [], duration_ms: 1, tool_calls: 0 });
    const ref = String(events(run, "run_failed")[0]?.payload.error_ref);
    expect(ref).toMatch(/^report_write_failed: [A-Z0-9_]+$/);
    expect(JSON.stringify(store.getLedgerEvents(run))).not.toContain(tmp.dir);
  });

  it("the winner's report is renamed into place and recorded once", () => {
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store);
    store.claimRun(run, "planner:555:winner", 120);
    sinkOf(worker).complete({ run_id: run, worker_id: "planner:555:winner", text: "the answer", attachments: [], duration_ms: 1, tool_calls: 0 });
    const dir = join(tmp.dir, "project", "runs", run);
    expect(readdirSync(dir)).toEqual(["report.md"]);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("the answer");
    expect(events(run, "report_written")).toHaveLength(1);
  });
});

describe("a denied evolution call is surfaced code-owned in the reply (fix round 1, M-3)", () => {
  it("skill_author refused by the bridge (disarmed) appends the notice the old loop appended", async () => {
    const saved = process.env.HOUGE_SKILLS_ENABLED;
    process.env.HOUGE_SKILLS_ENABLED = "0";
    try {
      useFakeOmp({ "*": { rpcText: "done", rpcCall: { tool: "skill_author", args: {} } } }, tmp.dir);
      worker = ompWorker(store, tmp.dir);
      const run = createQueuedTurnRun(store, "write me a skill");
      worker.submitTurn(run);
      await until(() => state(run) === "completed");
      const text = String(drainOutbox(store).get(`${run}:final_report`)?.text);
      expect(text).toContain(EVOLUTION_NOTICE_HEADER);
      expect(text).toContain("skill_author step failed: not_armed");
    } finally {
      if (saved === undefined) delete process.env.HOUGE_SKILLS_ENABLED; else process.env.HOUGE_SKILLS_ENABLED = saved;
    }
  });
});

describe("planner RPC failures carry fixed codes, never omp's error text (fix round 2, item 3)", () => {
  it("a steer omp refuses fails the steered run `steer_failed: command_failed:steer`; the text is in no ledger row or incident", async () => {
    useFakeOmp({ "*": { rpcHangAfterPrompt: true, rpcSteerError: "SECRET-ish text from /Users/p/.omp/agent" } }, tmp.dir);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    worker = ompWorker(store, tmp.dir);
    const parent = createQueuedTurnRun(store, "first");
    worker.submitTurn(parent);
    await until(() => fakeLog(join(tmp.dir, "argv.log")).some((l) => (l.cmd as { type?: string } | undefined)?.type === "prompt"));
    const steered = createQueuedTurnRun(store, "second");
    worker.submitTurn(steered);
    await until(() => state(steered) === "failed");
    expect(events(steered, "run_failed")[0]?.payload).toMatchObject({ error_type: "planner_exit", error_ref: "steer_failed: command_failed:steer" });
    await worker.shutdownPlanners();
    const everything = JSON.stringify([...store.getLedgerEvents(), ...store.listOpenIncidents()]);
    expect(everything).not.toContain("SECRET-ish");
    expect(log.mock.calls.flat().join("\n")).toContain("SECRET-ish"); // stderr may keep it for debugging (capped)
    log.mockRestore();
  });
});
