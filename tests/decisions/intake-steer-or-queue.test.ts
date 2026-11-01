import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_STEER_OR_QUEUE, STEER_REASONS, type SteerOrQueueInput } from "../../src/decisions/entries/intake-steer-or-queue.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_STEER_OR_QUEUE as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: "r", tool_call_id: null, recorder };

describe("intake.steer_or_queue — a message steered into a live turn, or held back from one, leaves a row (spec R3 §4.2, Decision 1-A)", () => {
  it("is unlocked, rule-only, tool input, sound (rule-only: R12 does not bind the irreversible steer, Decision 2-A)", () => {
    expect(INTAKE_STEER_OR_QUEUE.locked).toBeUndefined();
    expect(LOCKED_ENTRY_IDS).not.toContain("intake.steer_or_queue");
    expect(INTAKE_STEER_OR_QUEUE.input).toBe("tool");
    expect(INTAKE_STEER_OR_QUEUE.defaultVerdict).toBe("queue");
    expect(INTAKE_STEER_OR_QUEUE.fail).toBe("wait");
    expect(INTAKE_STEER_OR_QUEUE.reasonCodes).toEqual(["live_turn", "turn_schedule_born", "message_scheduled", "needs_ingest", "not_running", "turn_not_live", "queued_behind", "idle"]);
    expect(entryProblems(INTAKE_STEER_OR_QUEUE as unknown as AnyEntry)).toEqual([]);
    expect(INTAKE_STEER_OR_QUEUE.id).toBe("intake.steer_or_queue");
    expect(INTAKE_STEER_OR_QUEUE.version).toBe(1);
    expect(INTAKE_STEER_OR_QUEUE.stage).toBe("intake");
    expect(INTAKE_STEER_OR_QUEUE.question).toBe("Does this message steer into the live Telegram turn, wait behind a turn it may not join, or queue on an idle planner?");
    expect(INTAKE_STEER_OR_QUEUE.verdicts).toEqual(["steer", "wait", "queue"]);
    expect(INTAKE_STEER_OR_QUEUE.ladder.map((r) => [r.kind, r.name])).toEqual([["rule", "submit"]]);
    expect(INTAKE_STEER_OR_QUEUE.outcomes).toEqual([]);
    expect(INTAKE_STEER_OR_QUEUE.armed).toEqual({ rule: "on" });
    expect(INTAKE_STEER_OR_QUEUE.effects).toEqual({
      steer: { kind: "effect", reversible: false, announced: "none", what: "the message joins the running turn; one reply" },
      wait: { kind: "none", reversible: true, announced: "none" },
      queue: { kind: "none", reversible: true, announced: "none" }
    });
  });
  it("a judge rung on this entry would be refused (the registry check Decision 2-A relies on)", () => {
    const jev = { kind: "system_one", name: "x", questions: [], bars: { kind: "provisional", question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "mu" }, timeoutMs: 1 };
    const judged = { ...INTAKE_STEER_OR_QUEUE, ladder: [...INTAKE_STEER_OR_QUEUE.ladder, jev] } as unknown as AnyEntry;
    expect(entryProblems(judged).some((p) => p.includes("steer"))).toBe(true);
  });
  const cases: Array<[SteerOrQueueInput, boolean]> = [
    [{ outcome: "steer", reason: "live_turn" }, true],
    ...(["turn_schedule_born", "message_scheduled", "needs_ingest", "not_running", "turn_not_live", "queued_behind"] as const).map((reason) => [{ outcome: "wait" as const, reason }, true] as [SteerOrQueueInput, boolean]),
    [{ outcome: "queue", reason: "idle" }, false]
  ];
  it.each(cases)("%o → that verdict and reason; recorded: %s", (input, recorded) => {
    expect(decideSync(INTAKE_STEER_OR_QUEUE, input, ctx)).toMatchObject({ verdict: input.outcome, reason: input.reason });
    expect(rows).toEqual(recorded ? [{ verdict: input.outcome, reason: input.reason }] : []);
  });
  it("every reason is covered", () => { expect(new Set(cases.map(([i]) => i.reason))).toEqual(new Set(STEER_REASONS)); });
});
