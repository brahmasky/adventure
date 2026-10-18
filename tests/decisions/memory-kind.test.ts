import { describe, expect, it } from "vitest";
import {
  confidentMemoryKind, MEMORY_KIND, MEMORY_KIND_BAR, MEMORY_KIND_BAR_P, memoryKindJevRung
} from "../../src/decisions/entries/memory-kind.js";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry } from "../../src/decisions/types.js";
import { TREE_MEMORY_KIND } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { choiceAns } from "../helpers/jev-tree-answers.js";

const OPTIONS = ["other", "fix", "rule", "fact", "both"];
const ans = (top: string, p: number) => choiceAns(OPTIONS, top, p);

// Spec §3 / ADR 0030 amendment 2026-10-17: Jev's memory_kind decides only at p >= 0.85 (Paco's R6: armed at ship, no
// calibration sitting), on the bar that names the frozen question's hash, so a reworded question cannot keep the bar.
describe("the memory.kind entry", () => {
  it("is registered with input paco, verdicts escape-first, fail other, always recorded", () => {
    const e = entryById("memory.kind") as AnyEntry;
    expect(e).toBe(MEMORY_KIND as unknown as AnyEntry);
    expect([e.input, e.stage, e.fail, e.defaultVerdict, e.alwaysRecord]).toEqual(["paco", "pre_model", "other", "other", true]);
    expect([...e.verdicts]).toEqual(OPTIONS);
    expect(e.ladder.map((r) => `${r.kind}:${r.name}`)).toEqual(["system_one:memory_kind", "model:distill"]);
    expect(entryProblems(e)).toEqual([]);
  });
  it("declares rule/fact/both as reversible saves announced on a card, fix/other as the planner", () => {
    const fx = Object.fromEntries(Object.entries(MEMORY_KIND.effects).map(([v, f]) => [v, [f.kind, f.reversible, f.announced]]));
    expect(fx).toEqual({ other: ["none", true, "none"], fix: ["none", true, "none"], rule: ["effect", true, "card"], fact: ["effect", true, "card"],
      both: ["effect", true, "card"] });
  });
  it("its provisional bar is 0.85 on the frozen memory_kind hash", () => {
    expect(MEMORY_KIND_BAR).toMatchObject({ kind: "provisional", question: "memory_kind", criteriaHash: criteriaHash(TREE_MEMORY_KIND), p: 0.85 });
    expect(MEMORY_KIND_BAR_P).toBe(0.85);
  });
});

describe("the Jev rung", () => {
  it("decides at or above the bar, and abstains below it or without an answer (the distill decides then)", () => {
    expect(confidentMemoryKind(ans("fact", 0.85))).toEqual({ kind: "fact", p: 0.85 });
    expect(confidentMemoryKind(ans("fact", 0.84))).toBeNull();
    expect(confidentMemoryKind(undefined)).toBeNull();
    expect(confidentMemoryKind({ type: "noul", noul: 0.9 })).toBeNull();
    expect(memoryKindJevRung({ jev: ans("rule", 0.97), escapes: false })).toEqual({ verdict: "rule", p: 0.97, reason: "jev_kind" });
    expect(memoryKindJevRung({ jev: ans("rule", 0.6), escapes: false })).toMatchObject({ abstain: true });
  });
  // Spec §3 item 2: on a save sets_rule already called for, Jev's `other` or `fix` never suppresses the save.
  it("on a save path an escape answer abstains; at the front door it decides", () => {
    expect(memoryKindJevRung({ jev: ans("other", 0.95), escapes: false })).toMatchObject({ abstain: true });
    expect(memoryKindJevRung({ jev: ans("fix", 0.95), escapes: false })).toMatchObject({ abstain: true });
    expect(memoryKindJevRung({ jev: ans("fix", 0.95), escapes: true })).toEqual({ verdict: "fix", p: 0.95, reason: "jev_kind" });
  });
});
