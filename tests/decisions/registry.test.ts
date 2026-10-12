import { describe, expect, it } from "vitest";
import { ENTRY_IDS, LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { entryById, entryProblems, REGISTRY } from "../../src/decisions/registry.js";
import type { AnyEntry, EffectKind, VerdictEffect } from "../../src/decisions/types.js";

// Spec §4.1 (R12, R13) / §6.3: the registry is a gate. Every entry must be internally sound; what a Jev or model rung may
// cause depends on what it read (over Paco's message: reversible and announced; over tool input: only tighten or propose);
// no entry ships in shadow or off; locked entries carry rule rungs only; a provisional bar sits only on a monotone or
// fail-open entry. A misdeclared entry must FAIL here — that is the whole point of declaring effects as data.
const HANDLER = REGISTRY[0] as AnyEntry;
const base = (o: Partial<AnyEntry>): AnyEntry => ({ ...HANDLER, ...o });
const fx = (kind: EffectKind, reversible = true, announced: VerdictEffect["announced"] = "card"): VerdictEffect => ({ kind, reversible, announced });
const shape = (e: AnyEntry) => Object.fromEntries(Object.entries(e.effects).map(([v, f]) => [v, [f.kind, f.reversible, f.announced]]));

describe("the registry", () => {
  it("holds exactly ENTRY_IDS, once each, and every entry is sound", () => {
    expect(REGISTRY.map((e) => e.id)).toEqual([...ENTRY_IDS]);
    for (const e of REGISTRY) expect([e.id, entryProblems(e)]).toEqual([e.id, []]);
  });
  it("a registered locked entry is listed in LOCKED_ENTRY_IDS (so the store refuses its moves)", () => {
    for (const e of REGISTRY.filter((x) => x.locked)) expect(LOCKED_ENTRY_IDS as readonly string[]).toContain(e.id);
  });
  it("entryById finds turn.handler and turn.gear", () => {
    expect(entryById("turn.handler")?.stage).toBe("pre_model");
    expect(entryById("turn.gear")?.fail).toBe("default");
    expect(entryById("nope")).toBeUndefined();
  });
  it("every registered entry is armed on (R13: no designed shadow or off state)", () => {
    for (const e of REGISTRY) expect([e.id, Object.values(e.armed).every((m) => m === "on")]).toEqual([e.id, true]);
  });
  // R12: the front door's real effects, pinned, so relabelling one away is a visible, reviewed edit. A confident sets_rule
  // saves a lesson first on the answer, lookup and planner routes too (tree-policy.ts:226-237, core-worker.ts:2931-2934),
  // announced today only in the reply; Task 8c (Paco's Q1 ruling) moves them to the Undo card and updates this pin.
  it("turn.handler reads Paco's message and its effect table is exactly today's behaviour", () => {
    expect(HANDLER.input).toBe("paco");
    expect(shape(HANDLER)).toEqual({ answer: ["effect", true, "reply"], lookup: ["effect", true, "reply"], memory: ["effect", true, "card"],
      status: ["reply", true, "card"], planner: ["effect", true, "reply"] });
    expect(entryById("turn.gear")?.input).toBe("paco");
    expect(Object.values(shape(entryById("turn.gear")!)).map((f) => f[0])).toEqual(["none", "none", "none"]);
  });
});

describe("entryProblems (R12 and R13 as data)", () => {
  it("fails a judged entry over Paco's message whose verdict causes an irreversible or unannounced effect", () => {
    expect(entryProblems(base({ effects: { ...HANDLER.effects, memory: fx("effect", false) } })))
      .toContain("a jev/model rung can choose memory, an unannounced or irreversible effect");
    expect(entryProblems(base({ effects: { ...HANDLER.effects, planner: fx("effect", true, "none") } })))
      .toContain("a jev/model rung can choose planner, an unannounced or irreversible effect");
  });
  it("over tool or mixed input anything but none / tighten / proposal fails, even a reversible announced reply", () => {
    expect(entryProblems(base({ input: "tool" }))).toContain("a jev/model rung over tool input can choose answer, which is not tightening");
    expect(entryProblems(base({ input: "mixed" }))).toContain("a jev/model rung over mixed input can choose memory, which is not tightening");
    const kinds: EffectKind[] = ["none", "tighten", "proposal"];
    const passive = Object.fromEntries(HANDLER.verdicts.map((v, k) => [v, fx(kinds[k % 3]!)]));
    expect(entryProblems(base({ input: "tool", effects: passive }))).toEqual([]);
  });
  it("a code-only entry may cause an effect (R12 binds the judges, not code rules)", () => {
    const codeOnly = base({ ladder: [HANDLER.ladder[0]!], armed: { rule: "on" }, effects: { ...HANDLER.effects, memory: fx("effect", false, "none") } });
    expect(entryProblems(codeOnly)).toEqual([]);
  });
  it("fails a missing effect, a shadow or off arming (R13), a locked entry with a judge, and a fail or default outside the verdicts", () => {
    const noMemory = Object.fromEntries(Object.entries(HANDLER.effects).filter(([v]) => v !== "memory"));
    expect(entryProblems(base({ effects: noMemory }))).toContain("no effect declared for memory");
    expect(entryProblems(base({ armed: { rule: "on", system_one: "shadow", model: "on" } }))).toContain("entry armed other than on (R13: no designed shadow or off state)");
    expect(entryProblems(base({ locked: true }))).toContain("locked entry with a non-rule rung");
    expect(entryProblems(base({ fail: "nope" }))).toContain("fail not in verdicts");
    expect(entryProblems(base({ defaultVerdict: "nope" }))).toContain("defaultVerdict not in verdicts");
  });
  it("fails a provisional bar on an entry that is neither monotone nor fail-open", () => {
    const ladder = HANDLER.ladder.map((r) => (r.kind === "system_one" ? { ...r, bars: { kind: "provisional" as const, question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "mu" } } : r));
    expect(entryProblems(base({ ladder, fail: "answer" }))).toContain("provisional bar on an entry that is neither monotone nor fail-open");
    expect(entryProblems(base({ ladder }))).toEqual([]); // turn.handler is fail-open: fail = default = planner
  });
});
