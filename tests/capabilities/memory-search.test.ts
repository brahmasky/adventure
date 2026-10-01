import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_SEARCH_COSINE_BAND, MEMORY_SEARCH_MIN_COSINE, searchActiveMemory } from "../../src/capabilities/memory-correct.js";
import { RunStore } from "../../src/run/run-store.js";

// Relevance cutoff (review round 2): every search hit becomes an id the planner may ask to change, so the embedding
// leg must not pad the list with whatever is nearest. Keyword and substring hits always count; an embedding-only row
// needs cosine >= MEMORY_SEARCH_MIN_COSINE and within MEMORY_SEARCH_COSINE_BAND of the best one.
const CHAT = "555";
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

/** A unit vector at cosine `c` to the query [1, 0]. */
const at = (c: number) => new Float32Array([c, Math.sqrt(1 - c * c)]);
const fact = (text: string, cos: number) => store.addEpisodicFact({ chat_id: CHAT, fact: text, embedding: at(cos), embedding_model: "m" });
const search = (query: string) => searchActiveMemory(store, "fact", CHAT, query, new Float32Array([1, 0])).map((c) => c.id);

describe("memory search: the embedding leg's relevance cutoff", () => {
  it("names both constants", () => {
    expect(MEMORY_SEARCH_MIN_COSINE).toBe(0.55);
    expect(MEMORY_SEARCH_COSINE_BAND).toBe(0.1);
  });

  it("admits embedding rows only within 0.10 of the best", () => {
    const best = fact("alpha", 0.99);
    const near = fact("beta", 0.92);
    const far = fact("gamma", 0.8);
    expect(search("qqq")).toEqual([best, near]);
    expect(search("qqq")).not.toContain(far);
  });

  it("admits nothing below 0.55, even the best", () => {
    const top = fact("alpha", 0.6);
    const ok = fact("beta", 0.56);
    fact("gamma", 0.54);
    expect(search("qqq")).toEqual([top, ok]);
    store.close();
    store = RunStore.openInMemory();
    fact("delta", 0.5);
    expect(search("qqq")).toEqual([]);
  });

  it("keyword and substring hits count whatever their cosine", () => {
    const keyword = fact("zeta brief", 0.0);
    const best = fact("alpha", 0.99);
    expect(search("zeta")).toEqual([keyword, best]);
  });
});
