import { describe, expect, it } from "vitest";
import { buildImproveState, groupSignals, scopeOf, skillMentioned, toolSummaryOf, type RecurrenceInfo } from "../../src/improve/groups.js";
import { RunStore, type ImproveSignalRow, type JevVerdictRow } from "../../src/run/run-store.js";
import { SkillStore } from "../../src/skills/skill-store.js";
import { createTelegramTurn } from "../helpers/runs.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spec 2b-ii §3.2 (codex D13): groups are (signal, scope) where scope is the category for corrections and think_harder,
// category+value for ratings, the capability for approvals, the failure kind, the settle reason, the entry id; one decision
// per group with the newest run. §4.2: the state carries counts, the redacted Paco text (≤ 500), a code-built tool summary,
// the last improvement on the scope, the recurrence info and the R3 stated-rule flag.
const NOW = "2026-10-21T10:00:00.000Z";
const row = (o: Partial<ImproveSignalRow>): ImproveSignalRow => ({ signal_id: 1, signal: "correction", value: "answer", run_id: "run_b", chat_id: "555", about_run_id: "run_a",
  source_outcome_id: null, created_at: NOW, consumed_at: null, ...o });
const verdict = (category: JevVerdictRow["category"], lane: JevVerdictRow["lane"] = "planner"): JevVerdictRow => ({ verdict_id: "jv_1", run_id: "run_a", category, breadth: null, reasoning: null, actions: null,
  sets_rule: null, rule_scope: null, lane, role: "default", effort: null, model: null, cascade: null, save_outcome: "none", route_outcome: "fallback", handler_outcome: "planner_done",
  reason: "jev_skipped", skip_reason: null, fast_used_tool: 0, paco_correction: null, quoted_turn_id: null, decision_id: null, created_at: NOW, updated_at: NOW });

describe("scopeOf", () => {
  it("category for corrections, think_harder, dig_deeper and lesson_undone (other when null); category:value for ratings; the value for the rest", () => {
    expect(scopeOf(row({}), verdict("lookup"))).toBe("lookup");
    expect(scopeOf(row({ signal: "think_harder", value: "fast" }), verdict(null))).toBe("other");
    expect(scopeOf(row({ signal: "rating", value: "0" }), verdict("answer"))).toBe("answer:0");
    expect(scopeOf(row({ signal: "approval_expired", value: "shell_external" }), undefined)).toBe("shell_external");
    expect(scopeOf(row({ signal: "planner_failed", value: "model_error" }), undefined)).toBe("model_error");
    expect(scopeOf(row({ signal: "settle_sent_back", value: "claim_saved" }), undefined)).toBe("claim_saved");
    expect(scopeOf(row({ signal: "review_bad", value: "turn.settle" }), undefined)).toBe("turn.settle");
    expect(scopeOf(row({ signal: "recurrence", value: "3", source_outcome_id: "rec:rec_abc:3" }), undefined)).toBe("rec:rec_abc");
    expect(scopeOf(row({ signal: "abandoned", value: "lookup" }), undefined)).toBe("lookup");
  });
});

describe("groupSignals", () => {
  it("groups by (signal, scope), newest row per group, oldest group first; rows past the stale cut are their own stale groups; a recurrence row joins its cluster", () => {
    const rec: RecurrenceInfo = { clusterId: "rec_abc", turnIds: ["t1", "t2", "t3"], idempotencyKey: "answer:t1", texts: ["a", "b", "c"], category: "answer", spanDays: 1 };
    const rows = [row({ signal_id: 1, created_at: "2026-10-20T10:00:00.000Z" }), row({ signal_id: 2, about_run_id: "run_c" }), row({ signal_id: 3, signal: "rating", value: "0" }),
      row({ signal_id: 4, signal: "recurrence", value: "3", source_outcome_id: "rec:rec_abc:3", about_run_id: "run_d" }), row({ signal_id: 5, created_at: "2026-09-01T00:00:00.000Z", about_run_id: "run_old" })];
    const g = groupSignals(rows, () => verdict("answer"), new Map([["rec:rec_abc", rec]]), "2026-09-21T00:00:00.000Z");
    expect(g.map((x) => [x.key, x.rows.length, x.newest.signal_id, x.stale])).toEqual([["stale|5", 1, 5, true], ["correction|answer", 2, 2, false], ["rating|answer:0", 1, 3, false], ["recurrence|rec:rec_abc", 1, 4, false]]);
    expect(g[3]!.recurrence).toBe(rec);
    expect(g[1]!.recurrence).toBeNull();
  });
  it("two stale rows of the same signal stay two groups keyed by signal id, never merged", () => {
    const g = groupSignals([row({ signal_id: 7, created_at: "2026-01-01T00:00:00.000Z" }), row({ signal_id: 8, created_at: "2026-01-02T00:00:00.000Z" })], () => verdict("answer"), new Map(), "2026-09-21T00:00:00.000Z");
    expect(g.map((x) => [x.key, x.rows.length, x.stale])).toEqual([["stale|7", 1, true], ["stale|8", 1, true]]);
  });
  it("a recurrence row whose cluster is not in today's set is stale (the window moved on)", () => {
    const g = groupSignals([row({ signal: "recurrence", value: "3", source_outcome_id: "rec:rec_gone:3" })], () => undefined, new Map(), "2026-01-01T00:00:00.000Z");
    expect(g[0]).toMatchObject({ stale: true, recurrence: null });
  });
});

describe("toolSummaryOf and skillMentioned", () => {
  it("counts tool_finished events by tool name, never their text; none when there are none", () => {
    const ev = (tool: string) => ({ event_id: "e", correlation_id: "c", event_type: "tool_finished" as const, occurred_at: NOW, actor: "core" as const, sequence: 1, payload: { tool, status: "succeeded", output_hash: "h", output: "SECRET TEXT" } });
    expect(toolSummaryOf([ev("builtin:read"), ev("builtin:read"), ev("bash")])).toBe("builtin:read 2 · bash 1");
    expect(toolSummaryOf([])).toBe("none");
  });
  it("skillMentioned matches an active skill name word-bounded, case-folded, as authorAndWriteSkill's step 0 does", () => {
    const metas = [{ name: "weekly-report" }, { name: "verify" }];
    expect(skillMentioned(metas, ["run the Weekly-Report again"])).toBe(true);
    expect(skillMentioned(metas, ["verifying the numbers"])).toBe(false);
  });
});

describe("buildImproveState", () => {
  it("reads category and lane from the about run's verdict, the redacted Paco text capped at 500, the tool summary, the 14-day count, the last improvement, the stated-rule flag, the wiki flag", () => {
    const s = RunStore.openInMemory();
    const about = createTelegramTurn(s, "what is the capital of peru").run_id;
    // Paco's text for a correction is the CORRECTING turn's (what he said), never the corrected question's
    const correcting = createTelegramTurn(s, `记下来：回答要短, my code is 483920 ${"x".repeat(600)}`).run_id;
    s.insertJevVerdict({ run_id: about, category: "answer", breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "answer", role: "default", effort: null, cascade: null,
      save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null });
    s.insertMemorySaveTrigger(correcting, ["rule"], NOW);
    const r1 = row({ signal_id: 1, run_id: correcting, about_run_id: about });
    const r2 = row({ signal_id: 2, run_id: null, about_run_id: about, created_at: "2026-10-15T10:00:00.000Z" });
    // neither of these shares r1's (signal, scope): a different signal, and a correction on a lookup-category run
    const other = createTelegramTurn(s, "who won the match").run_id;
    s.insertJevVerdict({ run_id: other, category: "lookup", breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "answer", role: "default", effort: null, cascade: null,
      save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null });
    const r3 = row({ signal_id: 3, signal: "rating", value: "0", run_id: null, about_run_id: about });
    const r4 = row({ signal_id: 4, run_id: null, about_run_id: other });
    const skills = new SkillStore({ root: mkdtempSync(join(tmpdir(), "hg-skills-")) });
    const g = groupSignals([r1], (id) => s.getJevVerdictForRun(id), new Map(), "2026-01-01T00:00:00.000Z")[0]!;
    const state = buildImproveState(g, { store: s, env: { HOUGE_WIKI_ENABLED: "false" }, now: NOW, skills, redact: (t) => t.replace("483920", "‹secret›"), scheduleHints: new Map(), since14: [r1, r2, r3, r4] });
    expect(state).toMatchObject({ signal: "correction", value: "answer", scope: "answer", count: 1, count14d: 2, category: "answer", lane: "answer", capability: null, toolSummary: "none",
      lastImprovement: null, recurrence: null, alreadyAuthored: false, skillExists: false, wikiArmed: false, scheduleHint: null, stale: false, statedRuleSaved: true });
    expect(state.pacoText).not.toContain("483920");
    expect(state.pacoText).toContain("记下来");           // the correcting turn, not "capital of peru"
    expect(state.pacoText).not.toContain("peru");
    expect(Array.from(state.pacoText)).toHaveLength(500);
    expect(state.redacted.pacoText).toBe(state.pacoText);
  });
  it("an approval group carries the capability and the schedule hint; a recurrence group carries the cluster, the overlap check and the skill check", () => {
    const s = RunStore.openInMemory();
    const skills = new SkillStore({ root: mkdtempSync(join(tmpdir(), "hg-skills-")) });
    skills.writeSkill("ask", "weekly-report", "---\nname: weekly-report\nscope: ask\nwhen: asked for the weekly report\nanchors:\n  - report\n---\n1. do it\n");
    const hint = { schedule_id: "sched_1", hour: 11 };
    const ga = groupSignals([row({ signal: "approval_expired", value: "shell_external", about_run_id: null })], () => undefined, new Map(), "2026-01-01T00:00:00.000Z")[0]!;
    expect(buildImproveState(ga, { store: s, env: {}, now: NOW, skills, redact: (t) => t, scheduleHints: new Map([["shell_external", hint]]), since14: [] })).toMatchObject({ capability: "shell_external", scheduleHint: hint, pacoText: "" });
    const rec: RecurrenceInfo = { clusterId: "rec_abc", turnIds: ["t1", "t2", "t3"], idempotencyKey: "answer:t1", texts: ["make the weekly-report", "weekly-report please", "weekly-report again"], category: "answer", spanDays: 1 };
    const gr = groupSignals([row({ signal: "recurrence", value: "3", source_outcome_id: "rec:rec_abc:3", about_run_id: null })], () => undefined, new Map([["rec:rec_abc", rec]]), "2026-01-01T00:00:00.000Z")[0]!;
    expect(buildImproveState(gr, { store: s, env: {}, now: NOW, skills, redact: (t) => t, scheduleHints: new Map(), since14: [] })).toMatchObject({ recurrence: { clusterId: "rec_abc", turnIds: ["t1", "t2", "t3"], idempotencyKey: "answer:t1" }, skillExists: true, alreadyAuthored: false, category: "answer" });
  });
  it("caps Paco's text at 500 code points, never splitting a surrogate pair", () => {
    const s = RunStore.openInMemory();
    const correcting = createTelegramTurn(s, `ok ${"😀".repeat(600)}`).run_id;
    const skills = new SkillStore({ root: mkdtempSync(join(tmpdir(), "hg-skills-")) });
    const g = groupSignals([row({ run_id: correcting, about_run_id: null })], () => undefined, new Map(), "2026-01-01T00:00:00.000Z")[0]!;
    const state = buildImproveState(g, { store: s, env: {}, now: NOW, skills, redact: (t) => t, scheduleHints: new Map(), since14: [] });
    expect(Array.from(state.pacoText)).toHaveLength(500);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(state.pacoText)).toBe(false);
  });
});
