import { describe, expect, it, vi } from "vitest";
import { draftFor, evidenceOf, lessonScopeFor } from "../../src/improve/proposals.js";
import type { SignalGroup } from "../../src/improve/groups.js";
import type { ImproveState } from "../../src/decisions/entries/improve-route.js";
import { RunStore, type ImproveSignalRow } from "../../src/run/run-store.js";
import { createQueuedTurnRun, createTelegramTurn } from "../helpers/runs.js";

// Spec 2b-ii §5.1 (codex D11, D12, P3): drafts are code-built or distilled from Paco's correction; the prior reply reaches the
// distill only from a clean turn, redacted; a fact needs its evidence quote in Paco's words; a parse failure is no card;
// every proposal shows a one-line code-built evidence.
const NOW = "2026-10-21T10:00:00.000Z";
const row = (o: Partial<ImproveSignalRow>): ImproveSignalRow => ({ signal_id: 1, signal: "correction", value: "answer", run_id: "run_b", chat_id: "555", about_run_id: "run_a", source_outcome_id: null, created_at: NOW, consumed_at: null, ...o });
const group = (r: ImproveSignalRow, extra: Partial<SignalGroup> = {}): SignalGroup => ({ key: `${r.signal}|answer`, signal: r.signal, value: r.value, scope: "answer", rows: [r], newest: r, stale: false, recurrence: null, ...extra });
const state = (o: Partial<ImproveState> = {}): ImproveState => ({ signal: "correction", value: "answer", scope: "answer", count: 1, count14d: 3, category: "answer", lane: "answer", capability: null,
  pacoText: "please always answer in one line", toolSummary: "none", lastImprovement: null, recurrence: null, alreadyAuthored: false, skillExists: false, wikiArmed: false, scheduleHint: null, stale: false,
  statedRuleSaved: false, redacted: { pacoText: "please always answer in one line" }, ...o });
const deps = (store: RunStore, answer: string | null, calls: string[] = []) => ({ store, env: {}, now: NOW, tz: "Australia/Sydney", redact: (t: string) => t.replace("SECRET", "‹secret›"),
  distill: vi.fn(async (i: { question: string }) => { calls.push(i.question); return answer === null ? { ok: false as const } : { ok: true as const, answer }; }) });

describe("draftFor", () => {
  it("lesson: the distill runs over the correcting turn's text as instruction with the corrected reply as prior only when that turn was clean, redacted; the draft is {scope, text, avoid?}", async () => {
    const s = RunStore.openInMemory();
    const about = createQueuedTurnRun(s, "what is the capital of peru");
    s.recordChatTurn({ chat_id: "555", run_id: about, role: "assistant", text: "Lima. Also SECRET and a long story…", created_at: NOW });
    s.appendRunLedgerEvent(about, "turn_trust_final", "core", { max_level: "clean" });
    const correcting = createTelegramTurn(s, "please always answer in one line").run_id;
    const calls: string[] = [];
    const d = await draftFor("lesson", group(row({ run_id: correcting, about_run_id: about })), state(), deps(s, '{"kind":"rule","lesson":"Answer in one line.","avoid":"long stories"}', calls));
    expect(d).toEqual({ target: "lesson", draft_json: JSON.stringify({ scope: "ask", text: "Answer in one line.", avoid: "long stories" }), evidence: "correction on 2026-10-21, scope answer" });
    expect(calls[0]).toContain("‹secret›"); expect(calls[0]).not.toContain("SECRET"); expect(calls[0]).toContain("KIND: rule");
  });
  it("an untrusted corrected turn sends an empty prior; a distill parse failure or none is no draft", async () => {
    const s = RunStore.openInMemory();
    const about = createQueuedTurnRun(s, "q");
    s.recordChatTurn({ chat_id: "555", run_id: about, role: "assistant", text: "TOOL OUTPUT", created_at: NOW });
    s.appendRunLedgerEvent(about, "turn_trust_final", "core", { max_level: "untrusted" });
    const correcting = createTelegramTurn(s, "shorter please always").run_id;
    const calls: string[] = [];
    expect(await draftFor("lesson", group(row({ run_id: correcting, about_run_id: about })), state(), deps(s, "not json", calls))).toBeNull();
    expect(calls[0]).not.toContain("TOOL OUTPUT");
    expect(await draftFor("lesson", group(row({ run_id: correcting, about_run_id: about })), state(), deps(s, '{"kind":"none"}'))).toBeNull();
  });
  it("fact: the evidence quote must occur in Paco's text; the draft keeps the quote and the source turn ids", async () => {
    const s = RunStore.openInMemory();
    const about = createQueuedTurnRun(s, "q");
    const correcting = createTelegramTurn(s, "my sister lives in lima");
    const st = state({ pacoText: "my sister lives in lima", redacted: { pacoText: "my sister lives in lima" } });
    const ok = await draftFor("fact", group(row({ run_id: correcting.run_id, about_run_id: about })), st, deps(s, '{"kind":"fact","fact":"Paco\'s sister lives in Lima.","evidence":{"line":1,"quote":"sister lives in lima"}}'));
    expect(JSON.parse(ok!.draft_json)).toEqual({ text: "Paco's sister lives in Lima.", evidence: { line: 1, quote: "sister lives in lima" }, source_turn_ids: [correcting.turn_id] }); // chat turn ids, not run ids
    expect(await draftFor("fact", group(row({ run_id: correcting.run_id, about_run_id: about })), st, deps(s, '{"kind":"fact","fact":"X","evidence":{"line":1,"quote":"not in the text"}}'))).toBeNull();
    const leaked = await draftFor("fact", group(row({ run_id: correcting.run_id, about_run_id: about })), st, deps(s, '{"kind":"fact","fact":"Her number is SECRET.","evidence":{"line":1,"quote":"sister lives in lima"}}'));
    expect(JSON.parse(leaked!.draft_json).text).toBe("Her number is ‹secret›."); // the model's output is redacted before it is stored
  });
  it("skill needs a recurrence; tool_gap and ladder are code-built; knowledge is never a proposal; a locked entry gets no ladder draft", async () => {
    const s = RunStore.openInMemory();
    const rec = { clusterId: "rec_1", turnIds: ["t1", "t2", "t3"], idempotencyKey: "answer:t1", spanDays: 1 };
    expect(await draftFor("skill", group(row({})), state(), deps(s, null))).toBeNull();
    expect(JSON.parse((await draftFor("skill", group(row({ signal: "recurrence" })), state({ signal: "recurrence", recurrence: rec }), deps(s, null)))!.draft_json)).toEqual({ origin: { turn_ids: ["t1", "t2", "t3"], category: "answer" } });
    const tg = await draftFor("tool_gap", group(row({ signal: "planner_failed", value: "model_error" })), state({ signal: "planner_failed", value: "model_error", scope: "model_error" }), deps(s, null));
    expect(JSON.parse(tg!.draft_json)).toEqual({ focus: "answer turns fail on model_error 3 times" });
    expect(await draftFor("knowledge", group(row({})), state(), deps(s, null))).toBeNull();
    const lad = await draftFor("ladder", group(row({ signal: "review_bad", value: "turn.settle" })), state({ signal: "review_bad", value: "turn.settle", scope: "turn.settle", count14d: 3 }), deps(s, null));
    expect(JSON.parse(lad!.draft_json)).toEqual({ entry_id: "turn.settle", move: "retire_judge" });
    expect(await draftFor("ladder", group(row({ signal: "review_bad", value: "turn.trust" })), state({ signal: "review_bad", value: "turn.trust", scope: "turn.trust", count14d: 3 }), deps(s, null))).toBeNull();
  });
  it("evidence lines are code-built per signal; lessonScopeFor maps lookup/research to research, else ask", () => {
    expect(evidenceOf(group(row({})), state(), "Australia/Sydney")).toBe("correction on 2026-10-21, scope answer");
    expect(evidenceOf(group(row({ signal: "recurrence" })), state({ signal: "recurrence", recurrence: { clusterId: "r", turnIds: ["a", "b", "c"], idempotencyKey: "k", spanDays: 2 } }), "Australia/Sydney")).toBe("3 requests over 2 days");
    expect(evidenceOf(group(row({ signal: "review_bad", value: "turn.settle" })), state({ signal: "review_bad", scope: "turn.settle", count14d: 3 }), "Australia/Sydney")).toBe("3 ❌ on turn.settle in 14 days");
    expect(evidenceOf(group(row({})), state({ count14d: 2, lastImprovement: { target: "lesson", ageDays: 9 } }), "Australia/Sydney")).toBe("lesson did not hold: 2 corrections since (9 d)"); // spec §7
    expect(lessonScopeFor("lookup")).toBe("research"); expect(lessonScopeFor("answer")).toBe("ask"); expect(lessonScopeFor(null)).toBe("ask");
  });
  it("ladder: fewer than three ❌ lower the bar", async () => {
    const lad = await draftFor("ladder", group(row({ signal: "review_bad", value: "turn.settle" })), state({ signal: "review_bad", value: "turn.settle", scope: "turn.settle", count14d: 2 }), deps(RunStore.openInMemory(), null));
    expect(JSON.parse(lad!.draft_json)).toEqual({ entry_id: "turn.settle", move: "lower_bar" });
  });
  it("schedule: a draft only with the hint and the map entry keyed by the capability", async () => {
    const s = RunStore.openInMemory();
    const sch = s.addScheduledTask({ chat_id: "555", goal: "g", spec_json: JSON.stringify({ kind: "daily", at: "11:00" }), tz: "Australia/Sydney", next_run_at: "2026-10-22T00:00:00.000Z", now: "2026-10-01T00:00:00.000Z" });
    const hint = { schedule_id: sch.schedule_id, hour: 11, dates: ["2026-10-19", "2026-10-20"] };
    const st = state({ signal: "approval_expired", value: "shell_external", scope: "shell_external", scheduleHint: { schedule_id: sch.schedule_id, hour: 11 } });
    const g = group(row({ signal: "approval_expired", value: "shell_external" }));
    const ok = await draftFor("schedule", g, st, { ...deps(s, null), scheduleHints: new Map([["shell_external", hint]]) });
    expect(ok).toMatchObject({ target: "schedule", evidence: "2 expiries at 11:00 (2026-10-19, 2026-10-20)" });
    expect(await draftFor("schedule", g, st, { ...deps(s, null), scheduleHints: new Map() })).toBeNull();
    expect(await draftFor("schedule", g, { ...st, scheduleHint: null }, { ...deps(s, null), scheduleHints: new Map([["shell_external", hint]]) })).toBeNull();
  });
  it("every stored distilled field is redacted; a failed distill or an empty instruction is no draft; the prior is capped", async () => {
    const s = RunStore.openInMemory();
    const about = createQueuedTurnRun(s, "q");
    s.recordChatTurn({ chat_id: "555", run_id: about, role: "assistant", text: "x".repeat(900), created_at: NOW });
    s.appendRunLedgerEvent(about, "turn_trust_final", "core", { max_level: "clean" });
    const c = createTelegramTurn(s, "my sister lives in lima");
    const calls: string[] = [];
    const lesson = await draftFor("lesson", group(row({ run_id: c.run_id, about_run_id: about })), state(), deps(s, '{"kind":"rule","lesson":"Say SECRET never.","avoid":"SECRET talk"}', calls));
    expect(JSON.parse(lesson!.draft_json)).toMatchObject({ text: "Say ‹secret› never.", avoid: "‹secret› talk" });
    expect(calls[0]).toContain("x".repeat(500)); expect(calls[0]).not.toContain("x".repeat(501));
    const st = state({ pacoText: "my sister lives in SECRET city", redacted: { pacoText: "my sister lives in SECRET city" } });
    const fact = await draftFor("fact", group(row({ run_id: c.run_id, about_run_id: about })), st, deps(s, '{"kind":"fact","fact":"F","evidence":{"line":1,"quote":"SECRET city"}}'));
    expect(JSON.parse(fact!.draft_json).evidence.quote).toBe("‹secret› city");
    expect(await draftFor("lesson", group(row({ run_id: c.run_id })), state(), deps(s, null))).toBeNull();
    expect(await draftFor("fact", group(row({ run_id: c.run_id })), st, deps(s, null))).toBeNull();
    expect(await draftFor("lesson", group(row({ run_id: c.run_id })), state({ redacted: { pacoText: "  " } }), deps(s, '{"kind":"rule","lesson":"L"}'))).toBeNull();
  });
});
