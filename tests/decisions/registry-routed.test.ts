import { describe, expect, it } from "vitest";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, VerdictEffect } from "../../src/decisions/types.js";

const card: VerdictEffect = { kind: "effect", reversible: false, announced: "card", what: "a card now" };
const inbox: VerdictEffect = { kind: "effect", reversible: true, announced: "inbox", what: "listed in /inbox" };
const bar = { kind: "provisional", question: "q", criteriaHash: "h", p: 0.6, source: "test" } as const;
function routed(over: Partial<Record<string, unknown>> = {}): AnyEntry {
  return {
    id: "test.routed", version: 1, stage: "inbound", input: "tool", question: "q?",
    verdicts: ["ping", "inbox"], fail: "ping", defaultVerdict: "ping", alwaysRecord: true,
    ladder: [{ kind: "rule", name: "r", decide: () => ({ abstain: true }) },
      { kind: "system_one", name: "j", questions: [], bars: bar, timeoutMs: 1000 }],
    outcomes: [], armed: { rule: "on", system_one: "on" },
    effects: { ping: card, inbox }, perItemRouting: () => true, reasonCodes: [], ...over
  } as unknown as AnyEntry;
}

describe("ADR 0034 2.6 — the perItemRouting arm", () => {
  it("passes a two-lane tool entry whose default and fail are the card lane", () => {
    expect(entryProblems(routed())).toEqual([]);
  });
  it("fails the same entry without the predicate", () => {
    expect(entryProblems(routed({ perItemRouting: undefined })).length).toBeGreaterThan(0);
  });
  it("fails a third verdict", () => {
    const e = routed({ verdicts: ["ping", "inbox", "drop"], effects: { ping: card, inbox, drop: { kind: "effect", reversible: true, announced: "inbox" } } });
    expect(entryProblems(e).length).toBeGreaterThan(0);
  });
  it("fails when the default is the inbox lane", () => {
    expect(entryProblems(routed({ defaultVerdict: "inbox", fail: "inbox" })).length).toBeGreaterThan(0);
  });
  it("fails mixed or paco input with the predicate", () => {
    expect(entryProblems(routed({ input: "mixed" })).length).toBeGreaterThan(0);
  });
  it("fails an inbox lane that is not reversible", () => {
    expect(entryProblems(routed({ effects: { ping: card, inbox: { ...inbox, reversible: false } } })).length).toBeGreaterThan(0);
  });
});
