/**
 * Rule: ADR 0034 rule 10.5 (spec 2026-11-07 §3): a lesson or fact proposal applies on its own only through the code-owned
 * provenance predicate `autoApplies`, which `improve.route` names as `pacoWordsOnly`: every row of the group a correction
 * Paco typed on the memory lane (`memlane_fix`, a new run of his, never the corrected run), verdict lesson or fact, and not a rewrite (the repeat check found the draft a near-copy of a lesson accepted on the pair within LESSON_REWRITE_DAYS — ruling R1').
 * Any other origin, a null origin (rows older builds wrote), a run-less row, or a rewrite is a card. Changing this rule changes this test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autoApplies as autoAppliesReal, IMPROVE_ROUTE, LESSON_REWRITE_DAYS } from "../../src/decisions/entries/improve-route.js";

type Row = { origin: "memlane_fix" | "dig_deeper" | "escalation" | "rating" | null; run_id: string | null; about_run_id: string | null };
const fix: Row = { origin: "memlane_fix", run_id: "run_b", about_run_id: "run_a" };
const s = { signal: "correction" as const };
const telegram = (run_id: string): boolean => run_id !== "run_cli";
const autoApplies = (g: { rows: Row[] }, st: { signal: "correction" | "dig_deeper" }, v: Parameters<typeof autoAppliesReal>[2], tg = telegram, rewrite = false) => autoAppliesReal(g, st, v, tg, rewrite);

describe("ADR 0034 rule 10.5: autoApplies", () => {
  it("is the entry's named predicate", () => { expect(IMPROVE_ROUTE.pacoWordsOnly).toBe(autoAppliesReal); });
  it("applies a lesson or fact from memlane_fix rows of Telegram runs only", () => {
    expect(autoApplies({ rows: [fix] }, s, "lesson")).toBe(true);
    expect(autoApplies({ rows: [fix, fix] }, s, "fact")).toBe(true);
    for (const v of ["nothing", "skill", "schedule", "knowledge", "tool_gap", "ladder"] as const) expect([v, autoApplies({ rows: [fix] }, s, v)]).toEqual([v, false]);
    expect(autoApplies({ rows: [fix] }, s, "lesson", () => false)).toBe(false); // P16: the apply boundary re-checks the run's source
    expect(autoApplies({ rows: [{ ...fix, run_id: "run_cli" }] }, s, "lesson")).toBe(false);
  });
  it.each<[string, Row]>([
    ["dig_deeper (the original request, no new words)", { ...fix, origin: "dig_deeper" }],
    ["escalation (run = about)", { origin: "escalation", run_id: "run_a", about_run_id: "run_a" }],
    ["rating (no run)", { origin: "rating", run_id: null, about_run_id: "run_a" }],
    ["null origin (an older build's row)", { ...fix, origin: null }],
    ["memlane_fix whose run is the corrected run", { ...fix, run_id: "run_a" }],
    ["memlane_fix with no run", { ...fix, run_id: null }]
  ])("%s is a card", (_name, row) => {
    expect(autoApplies({ rows: [row] }, s, "lesson")).toBe(false);
    expect(autoApplies({ rows: [fix, row] }, s, "lesson")).toBe(false); // one foreign row taints the group
  });
  it("an empty group, a non-correction signal, and the lesson-did-not-hold rewrite are cards", () => {
    expect(autoApplies({ rows: [] }, s, "lesson")).toBe(false);
    expect(autoApplies({ rows: [fix] }, { signal: "dig_deeper" }, "lesson")).toBe(false);
    expect(LESSON_REWRITE_DAYS).toBe(30); // the window of accepted lessons a near-copy is a rewrite of
    expect(autoApplies({ rows: [fix] }, s, "lesson", telegram, true)).toBe(false); // the repeat check said rewrite: a card
    expect(autoApplies({ rows: [fix] }, s, "fact", telegram, true)).toBe(false);
    expect(autoApplies({ rows: [fix] }, s, "lesson", telegram, false)).toBe(true); // a recent accepted lesson alone is no rewrite (R1')
  });
});

const adr = readFileSync(join(import.meta.dirname, "..", "..", "docs", "decisions", "0034-decision-ladder-consolidated.md"), "utf8");
const rule = (id: string): string => { const at = adr.indexOf(`- ${id} `); expect(at).toBeGreaterThan(-1); return adr.slice(at, adr.indexOf("\n- ", at + 1)); };
describe("ADR 0034 names the rule the code pins", () => {
  it("10.5 names autoApplies, memlane_fix, the empty prior, the reverted proposal and the card for the rest; 2.5 names pacoWordsOnly; 13.1 says no digest; 13.2 names improve_tick_degraded; 6.6 no longer names digest ✅/❌", () => {
    expect(rule("10.5")).toMatch(/autoApplies/); expect(rule("10.5")).toMatch(/memlane_fix/); expect(rule("10.5")).toMatch(/prior: ""|empty prior|no prior/); expect(rule("10.5")).toMatch(/reverted/);
    expect(rule("2.5")).toMatch(/pacoWordsOnly/);
    expect(rule("13.1")).toMatch(/No digest/); expect(rule("13.2")).toMatch(/improve_tick_degraded/);
    expect(rule("6.6")).not.toMatch(/Digest ✅\/❌/); expect(rule("6.6")).toMatch(/No tap produces a category label now/);
    expect(rule("11.3")).toMatch(/revoked.*schedule_ended.*tampered_use/s);
    expect(rule("10.2")).toMatch(/HOUGE_IMPROVE_AT/);
  });
});
