import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

const CHAT = "222";
const NOW = "2026-10-02T00:00:00.000Z";
const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });
const add = (fact: string, is_core: boolean, created_at = NOW) => store.addEpisodicFact({ chat_id: CHAT, fact, is_core, created_at });

describe("core through merges (spec §4)", () => {
  it("a core + core merge is core", () => {
    const merged = store.mergeEpisodicFacts([add("lives in city A", true), add("lives in city A, north side", true)], { fact: "lives in city A (north)" }, NOW);
    expect(store.getEpisodicFact(merged!.id)!.is_core).toBe(1);
  });

  it("a mixed core + non-core cluster is refused: no new row, both sources stay active, core stays core", () => {
    const core = add("lives in city A", true);
    const plain = add("likes the harbour in city A", false);
    const merged = store.mergeEpisodicFacts([core, plain], { fact: "lives in city A, likes its harbour" }, NOW);
    expect(merged).toBeUndefined();
    expect([core, plain].map((id) => store.getEpisodicFact(id)!.status)).toEqual(["active", "active"]);
    expect(store.getEpisodicFact(core)!.is_core).toBe(1);
  });

  it("a non-core + non-core merge is non-core", () => {
    const merged = store.mergeEpisodicFacts([add("likes the harbour", false), add("likes the harbour at dusk", false)], { fact: "likes the harbour at dusk" }, NOW);
    expect(store.getEpisodicFact(merged!.id)!.is_core).toBe(0);
  });
});

describe("core never decays and is never cap-pruned (spec §4)", () => {
  it("decay skips core rows; non-core rows still lose reuse", () => {
    const core = add("works as an engineer", true, ago(90));
    const plain = add("tried a new cafe", false, ago(90));
    store.decayEpisodicFacts(NOW, { decayDays: 30, pruneThreshold: 0.2 });
    expect(store.getEpisodicFact(core)!.reuse_value).toBe(1);
    expect(store.getEpisodicFact(plain)!.reuse_value).toBeCloseTo(0.8);
  });

  it("the per-chat cap prunes a non-core row even when the core rows are older and lower-ranked", () => {
    const coreA = add("born in city B", true, ago(30));
    const coreB = add("works as an engineer", true, ago(20));
    const plain = add("tried a new cafe", false, ago(10));
    const saved = store.saveReconciledFact({ chat_id: CHAT, fact: "owns a bicycle" }, { verdict: "ADD" }, NOW, 3);
    expect(saved.prunedIds).toEqual([plain]);
    expect([coreA, coreB].map((id) => store.getEpisodicFact(id)!.status)).toEqual(["active", "active"]);
  });

  it("core rows still count toward the cap: two core + one new over a cap of 2 prunes nothing core and nothing new", () => {
    add("born in city B", true, ago(30));
    add("works as an engineer", true, ago(20));
    const saved = store.saveReconciledFact({ chat_id: CHAT, fact: "owns a bicycle" }, { verdict: "ADD" }, NOW, 2);
    expect(saved.prunedIds).toEqual([]);
  });

  it("core at or over the cap: every other non-core row is pruned, core untouched, and it terminates", () => {
    const cores = [add("born in city B", true, ago(30)), add("works as an engineer", true, ago(20))];
    const plains = [add("tried a new cafe", false, ago(10)), add("bought a hat", false, ago(5))];
    const saved = store.saveReconciledFact({ chat_id: CHAT, fact: "owns a bicycle" }, { verdict: "ADD" }, NOW, 2);
    expect([...saved.prunedIds].sort()).toEqual([...plains].sort());
    expect(cores.map((id) => store.getEpisodicFact(id)!.status)).toEqual(["active", "active"]);
    expect(store.getEpisodicFact(saved.id!)!.status).toBe("active");
  });
});
