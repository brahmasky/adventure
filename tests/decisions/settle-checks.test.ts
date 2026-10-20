import { describe, expect, it } from "vitest";
import { claimsCheck, lastCallDenied, pendingCount, settleChecks, todoCheck } from "../../src/decisions/settle-checks.js";
import { settleRule, type SettleState, type TodoSnapshot } from "../../src/decisions/entries/turn-settle.js";

// Spec §3.3: the claims check is code-owned and tested per verb, with and without evidence, zh and en, with negations;
// the todo check fires only on a list that changed THIS turn and still holds pending or in_progress work (2b-R6).
const ev = (event_type: string, payload: Record<string, unknown>) => ({ event_id: "e", correlation_id: "c", event_type, occurred_at: "t", actor: "core", sequence: 1, payload }) as any;
const ok = (tool: string) => ev("tool_finished", { tool, status: "succeeded" });
const CLAIMS: Array<[string, string, string[]]> = [
  // [claim text, the reason it raises, the evidence that satisfies it: event descriptions]
  ["I've scheduled the reminder for 9am.", "claim_scheduled", ["ok:schedule_task"]],
  ["已安排明天早上提醒你。", "claim_scheduled", ["ok:schedule_task"]],
  ["已设置提醒。", "claim_scheduled", ["ok:schedule_task"]],
  ["安排好了。", "claim_scheduled", ["ok:schedule_task"]],
  ["Saved. I'll keep that in mind.", "claim_saved", ["lesson_saved", "fact_saved", "ok:lesson_write"]],
  ["I have remembered your preference.", "claim_saved", ["lesson_saved"]],
  ["已保存。", "claim_saved", ["fact_saved"]],
  ["记住了。", "claim_saved", ["lesson_saved"]],
  ["好的，记下来了。", "claim_saved", ["lesson_saved"]],
  ["I've attached the report below.", "claim_attached", ["attached"]],
  ["附上报告。", "claim_attached", ["attached"]],
  ["已附文件。", "claim_attached", ["attached"]],
  ["I've sent the email to the team.", "claim_sent", ["external_work_published", "step:shell_external"]],
  ["已发送。", "claim_sent", ["external_work_published"]],
  ["发出去了。", "claim_sent", ["step:shell_external"]]
];
const evidenceOf = (d: string) => d === "attached" ? null : d.startsWith("ok:") ? ok(d.slice(3)) : d.startsWith("step:") ? ev("loop_step", { action: "bash", capability: d.slice(5), ok: true }) : ev(d, {});

describe("claimsCheck prose that is not a claim", () => {
  it.each(["Maintenance was scheduled for Tuesday.", "The saved file is in the folder.", "Saved searches are listed below.", "Your invoice was sent last week.", "He sent the email to the team.",
    "A reminder set for 9 shows here.", "请附上发票。", "Sent items are in the folder."])("%s raises nothing", (t) => expect(claimsCheck(t, [], 0)).toEqual([]));
  it("a mixed reply claims only the unnegated verb; a short bare confirmation and a pronoun passive still claim", () => {
    expect(claimsCheck("I've saved it. I haven't sent it.", [], 0)).toEqual(["claim_saved"]);
    expect(claimsCheck("Saved, thanks.", [], 0)).toEqual(["claim_saved"]);
    expect(claimsCheck("It was sent.", [], 0)).toEqual(["claim_sent"]);
  });
});

describe("claimsCheck", () => {
  it.each(CLAIMS)("%s → %s without evidence; settles with each listed evidence", (text, reason, evidences) => {
    expect(claimsCheck(text, [], 0)).toEqual([reason]);
    for (const d of evidences) {
      const e = evidenceOf(d);
      expect(claimsCheck(text, e ? [e] : [], e ? 0 : 1)).toEqual([]);
    }
  });
  it("a negation never matches; a tool_finished without `tool` or with status failed is never evidence; a loop_step for a local shell is not `sent`", () => {
    for (const t of ["I haven't scheduled it yet.", "I did not save that.", "没有保存。", "还没发送。", "I couldn't attach it."]) expect(claimsCheck(t, [], 0)).toEqual([]);
    expect(claimsCheck("Saved.", [ev("tool_finished", { status: "succeeded" })], 0)).toEqual(["claim_saved"]);
    expect(claimsCheck("Saved.", [ev("tool_finished", { tool: "lesson_write", status: "failed" })], 0)).toEqual(["claim_saved"]);
    expect(claimsCheck("Sent.", [ev("loop_step", { capability: "shell", ok: true })], 0)).toEqual(["claim_sent"]);
  });
  it("a clean reply raises nothing; two unsupported claims raise both in table order", () => {
    expect(claimsCheck("The meeting is at 10. Anything else?", [], 0)).toEqual([]);
    expect(claimsCheck("I've scheduled it and sent the invite.", [], 0)).toEqual(["claim_scheduled", "claim_sent"]);
  });
});

const todo = (...statuses: string[]): TodoSnapshot => ({ phases: [{ name: "p", tasks: statuses.map((status, k) => ({ content: `t${k}`, status })) }] });
describe("todoCheck", () => {
  it("fires only when the list changed this turn and holds pending or in_progress work", () => {
    expect(todoCheck(todo(), todo("pending"))).toBe("todo_pending");
    expect(todoCheck(todo("completed"), todo("completed", "in_progress"))).toBe("todo_pending");
    expect(todoCheck(todo("pending"), todo("pending"))).toBeNull(); // unchanged since the previous turn (2b-R6)
    expect(todoCheck(todo("pending"), todo("completed"))).toBeNull();
    expect(todoCheck(null, todo("pending"))).toBe("todo_unavailable");
    expect(todoCheck(todo(), null)).toBe("todo_unavailable");
    expect(pendingCount(todo("pending", "in_progress", "completed", "blocked"))).toBe(2);
  });
});

describe("settleChecks inside settleRule", () => {
  const s = (over: Partial<SettleState>): SettleState => ({ run_id: "r", text: "ok", pass: 0, sentBack: false, trust: "clean", lastCallDenied: false, steerQueued: false, msLeft: 100_000, aborting: false,
    evidence: [], todoBefore: todo(), todoNow: todo(), pacoMessage: "", attachmentsAccepted: 0, redacted: { text: "ok", pacoMessage: "" }, toolSummary: "none", ...over });
  it("a claim sends back with its reason; a changed todo with pending work sends back todo_pending; todo_unavailable alone abstains", () => {
    expect(settleRule(s({ text: "I've scheduled it." }))).toMatchObject({ verdict: "send_back", reason: "claim_scheduled", detail: { claims: ["claim_scheduled"] } });
    expect(settleRule(s({ todoNow: todo("pending") }))).toMatchObject({ verdict: "send_back", reason: "todo_pending" });
    expect(settleRule(s({ todoNow: null }))).toEqual({ abstain: true, reason: "todo_unavailable" });
    expect(settleRule(s({}))).toEqual({ abstain: true });
  });
});

describe("lastCallDenied", () => {
  const ev = (event_type: string, payload: Record<string, unknown>, sequence: number) => ({ event_id: "e", correlation_id: "c", event_type, occurred_at: "t", actor: "core", sequence, payload }) as any;
  it("reads the NEWEST tool event: a denied tool_finished or a gate deny; an older denial behind a success does not count", () => {
    expect(lastCallDenied([ev("tool_finished", { status: "denied", reason: "denied_by_paco" }, 1)])).toBe(true);
    expect(lastCallDenied([ev("policy_decision", { decision: "deny", reason: "protected_path" }, 1)])).toBe(true);
    expect(lastCallDenied([ev("tool_finished", { status: "denied" }, 1), ev("tool_finished", { status: "succeeded" }, 2)])).toBe(false);
    expect(lastCallDenied([])).toBe(false);
  });
  it("A5: a todo update is bookkeeping, not a tool call: a denial followed by a todo row is still the last call denied", () => {
    expect(lastCallDenied([ev("tool_finished", { tool: "bash", status: "denied" }, 1), ev("tool_finished", { tool: "builtin:todo", status: "succeeded" }, 2)])).toBe(true);
    expect(lastCallDenied([ev("tool_finished", { tool: "builtin:todo", status: "failed" }, 1)])).toBe(false);
  });
});
