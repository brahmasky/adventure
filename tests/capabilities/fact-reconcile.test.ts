import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EPISODIC_EXTRACT_DISCIPLINE,
  EPISODIC_FACT_MAX_CHARS,
  FACT_RECONCILE_DISCIPLINE,
  runEpisodicDistillPass,
  type EpisodicLlm
} from "../../src/capabilities/episodic-extract.js";
import { RECONCILE_DISCIPLINE } from "../../src/capabilities/reconcile.js";
import { blobToFloat32 } from "../../src/llm/embeddings.js";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-10-02T12:00:00.000Z";
const CHAT = "222";
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const NEAR = Float32Array.from([1, 0]);
const FAR = Float32Array.from([0, 1]);
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); process.env.HOUGE_EPISODIC_EVIDENCE = "off"; });
afterEach(() => { store.close(); delete process.env.HOUGE_EPISODIC_EVIDENCE; });

/** Records every call; extract → the given facts, reconcile → `verdict(question)`. */
function llm(facts: string[], verdict: (q: string) => string, log: Array<{ system: string; question: string }>): EpisodicLlm {
  return async (input) => {
    log.push(input);
    return { ok: true, answer: input.system === EPISODIC_EXTRACT_DISCIPLINE ? JSON.stringify({ facts: facts.map((fact) => ({ fact })) }) : verdict(input.question) };
  };
}
function window(text = "new detail about the thing"): void {
  store.recordChatTurn({ chat_id: CHAT, run_id: "r1", role: "user", text, created_at: minutesAgo(90) });
}
const pass = (l: EpisodicLlm, embed: (t: string) => Promise<Float32Array | null>) =>
  runEpisodicDistillPass({ store, llm: l, embed, chatId: CHAT, userName: "user", now: NOW });

describe("FACT_RECONCILE_DISCIPLINE (spec §7)", () => {
  it("is a fact prompt, not the lesson prompt: statements, never instructions, one atomic fact under the cap", () => {
    expect(FACT_RECONCILE_DISCIPLINE).not.toBe(RECONCILE_DISCIPLINE);
    expect(FACT_RECONCILE_DISCIPLINE).toContain("never an instruction");
    expect(FACT_RECONCILE_DISCIPLINE).toContain(`at most ${EPISODIC_FACT_MAX_CHARS} characters`);
    expect(FACT_RECONCILE_DISCIPLINE).toContain("newer value of the same attribute");
    expect(FACT_RECONCILE_DISCIPLINE).toContain("NEVER drop information by superseding");
    expect(FACT_RECONCILE_DISCIPLINE).not.toContain("imperative rule");
  });

  it("the pass reconciles facts under the fact prompt", async () => {
    store.addEpisodicFact({ chat_id: CHAT, fact: "old fact", created_at: minutesAgo(500) });
    window();
    const log: Array<{ system: string; question: string }> = [];
    await pass(llm(["new fact"], () => '{"verdict":"ADD"}', log), async () => null);
    expect(log.map((c) => c.system)).toContain(FACT_RECONCILE_DISCIPLINE);
    expect(log.map((c) => c.system)).not.toContain(RECONCILE_DISCIPLINE);
  });
});

describe("embed before reconcile; neighbours by cosine (spec §7)", () => {
  it("an older semantically close fact is a neighbour even when 8 newer unrelated facts exist (newest-K would miss it)", async () => {
    // No shared token with the candidate: only the cosine leg can find it.
    const close = store.addEpisodicFact({ chat_id: CHAT, fact: "alpha beta", embedding: NEAR, created_at: minutesAgo(5000) });
    const newer: number[] = [];
    for (let i = 0; i < 8; i++) newer.push(store.addEpisodicFact({ chat_id: CHAT, fact: `unrelated ${i}`, embedding: FAR, created_at: minutesAgo(1000 - i) }));
    window();
    const log: Array<{ system: string; question: string }> = [];
    await pass(llm(["gamma delta"], () => '{"verdict":"ADD"}', log), async () => NEAR);
    const q = log.find((c) => c.system === FACT_RECONCILE_DISCIPLINE)!.question;
    expect(q).toContain(`#${close}: alpha beta`);
    expect(q).not.toContain(`#${newer[7]}:`);
  });

  it("no candidate embedding keeps today's newest-K fallback (CJK has no FTS hit)", async () => {
    const newest = store.addEpisodicFact({ chat_id: CHAT, fact: "最近的事实", created_at: minutesAgo(100) });
    window("新的细节");
    const log: Array<{ system: string; question: string }> = [];
    await pass(llm(["新的事实"], () => '{"verdict":"ADD"}', log), async () => null);
    expect(log.find((c) => c.system === FACT_RECONCILE_DISCIPLINE)!.question).toContain(`#${newest}:`);
  });

  it("an UPDATE that changes the text is re-embedded before saving", async () => {
    const old = store.addEpisodicFact({ chat_id: CHAT, fact: "owns a bike", embedding: NEAR, created_at: minutesAgo(500) });
    window();
    const embedded: string[] = [];
    const vectors: Record<string, Float32Array> = { "owns two bikes": NEAR, "owns two bikes, both red": Float32Array.from([0.6, 0.8]) };
    await pass(
      llm(["owns two bikes"], () => `{"verdict":"UPDATE","id":${old},"text":"owns two bikes, both red"}`, []),
      async (t) => { embedded.push(t); return vectors[t] ?? null; }
    );
    expect(embedded).toEqual(["owns two bikes", "owns two bikes, both red"]);
    const [row] = store.getActiveEpisodicFacts(CHAT);
    expect(row!.fact).toBe("owns two bikes, both red");
    expect([...blobToFloat32(row!.embedding!)]).toEqual([...Float32Array.from([0.6, 0.8])]);
  });
});

describe("RunStore.getEpisodicFactsForReconcile with a candidate embedding", () => {
  it("returns FTS hits ∪ cosine ≥ 0.50 neighbours, deduplicated, at most k", () => {
    const fts = store.addEpisodicFact({ chat_id: CHAT, fact: "harbour walk on sundays", embedding: FAR });
    const near = store.addEpisodicFact({ chat_id: CHAT, fact: "unrelated words", embedding: NEAR });
    store.addEpisodicFact({ chat_id: CHAT, fact: "other words", embedding: FAR });
    const ids = store.getEpisodicFactsForReconcile(CHAT, "harbour", 8, NEAR).map((f) => f.id);
    expect(ids.sort((a, b) => a - b)).toEqual([fts, near].sort((a, b) => a - b));
    expect(store.getEpisodicFactsForReconcile(CHAT, "harbour", 1, NEAR)).toHaveLength(1);
  });

  it("reserves 4 of 8 slots for cosine-only hits, so 10 FTS hits cannot crowd them out", () => {
    for (let i = 0; i < 10; i++) store.addEpisodicFact({ chat_id: CHAT, fact: `harbour note ${i}`, embedding: FAR });
    const near = [0, 1, 2, 3, 4].map((i) => store.addEpisodicFact({ chat_id: CHAT, fact: `close wording ${i}`, embedding: NEAR }));
    const got = store.getEpisodicFactsForReconcile(CHAT, "harbour", 8, NEAR).map((f) => f.id);
    expect(got).toHaveLength(8);
    expect(got.filter((id) => near.includes(id))).toHaveLength(4);
  });
});
