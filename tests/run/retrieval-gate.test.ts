import { describe, expect, it } from "vitest";
import { float32ToBlob } from "../../src/llm/embeddings.js";
import { DEFAULT_EPISODIC_MIN_COSINE, resolveEpisodicMinCosine, retrieveEpisodicFacts } from "../../src/run/episodic-retrieval.js";
import { resolveCosineGate } from "../../src/run/relevance-gate.js";
import type { EpisodicFactRow, WikiPageRow } from "../../src/run/run-store.js";
import { DEFAULT_WIKI_MIN_COSINE, retrieveWikiPages } from "../../src/run/wiki-retrieval.js";

const NOW = "2026-10-02T00:00:00.000Z";
const CHAT = "222";
const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
const vec = (...v: number[]) => float32ToBlob(Float32Array.from(v));
const Q = Float32Array.from([1, 0]);

function fact(id: number, over: Partial<EpisodicFactRow> = {}): EpisodicFactRow {
  return {
    id, fact: `fact ${id}`, participants: "[]", chat_id: CHAT, source_turn_ids: "[]", occurred_at: null, valid_from: null,
    valid_until: null, salience: 1, status: "active", supersedes: null, superseded_by: null, applied_count: 0,
    corrected_count: 0, reuse_value: 1, rating_history: "[]", embedding: null, embedding_model: null, created_at: NOW,
    last_used: null, is_core: 0, ...over
  };
}

/** Newest-first like the store; honours the cap exactly as `getActiveEpisodicFacts(chat, cap)` does. */
function factStore(rows: EpisodicFactRow[], fts: Array<EpisodicFactRow & { rank: number }> = []) {
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { searchEpisodicFactsFts: () => fts, getActiveEpisodicFacts: (_c: string, cap?: number) => (cap === undefined ? sorted : sorted.slice(0, cap)) };
}

const facts = (rows: EpisodicFactRow[], q: Float32Array | null, env: NodeJS.ProcessEnv = {}, fts: Array<EpisodicFactRow & { rank: number }> = []) =>
  retrieveEpisodicFacts({ store: factStore(rows, fts), chat_id: CHAT, queryText: "q", queryEmbedding: q, now: NOW, env });

describe("the fact gate (spec §3)", () => {
  it("defaults to 0.42 and admits nothing below it when both embeddings are present", () => {
    expect(DEFAULT_EPISODIC_MIN_COSINE).toBe(0.42);
    const r = facts([fact(1, { embedding: vec(1, 0) }), fact(2, { embedding: vec(0, 1) }), fact(3, { embedding: vec(0.4, 0.9165) })], Q);
    expect(r.rows.map((f) => f.id)).toEqual([1]);
    expect(r.best_admitted).toBeCloseTo(1);
    expect(r.best_rejected).toBeCloseTo(0.4, 2);
    expect(r).toMatchObject({ embedding: true, fts_only: false });
  });

  it("a fact at EXACTLY the gate is admitted: the gate is >=, not > (D1)", () => {
    // 21/50 = 0.42 exactly: |(21,45,5,3)| = 50, so the cosine to (1,0,0,0) is the double 0.42 itself
    const at = facts([fact(1, { embedding: vec(21, 45, 5, 3) })], Float32Array.from([1, 0, 0, 0]));
    expect(at.best_admitted).toBe(0.42);
    expect(at.rows.map((f) => f.id)).toEqual([1]);
  });

  it("an older relevant fact outside the newest 50 is admitted (the pool is the whole chat)", () => {
    const rows = [fact(1, { embedding: vec(1, 0), created_at: ago(90) })];
    for (let i = 2; i <= 60; i++) rows.push(fact(i, { embedding: vec(0, 1), created_at: ago(1) }));
    expect(facts(rows, Q).rows.map((f) => f.id)).toEqual([1]);
  });

  it("no query embedding (Ollama down): FTS hits only, never the recency pool", () => {
    const hit = { ...fact(5, { embedding: vec(0, 1) }), rank: -2 };
    const r = facts([fact(4, { embedding: vec(1, 0) }), fact(5, { embedding: vec(0, 1) })], null, {}, [hit]);
    expect(r.rows.map((f) => f.id)).toEqual([5]);
    expect(r).toMatchObject({ embedding: false, fts_only: true });
  });

  it("with a query embedding, a row without an embedding enters only by FTS, and FTS cannot lift a row below the gate", () => {
    const noVec = fact(6);
    const lowButHit = fact(7, { embedding: vec(0, 1) });
    expect(facts([noVec, lowButHit], Q, {}, [{ ...lowButHit, rank: -3 }]).rows).toEqual([]);
    expect(facts([noVec], Q, {}, [{ ...noVec, rank: -3 }]).rows.map((f) => f.id)).toEqual([6]);
  });

  it("gate 0 restores today's pool and floor: recency surfaces an unrelated fact", () => {
    const r = facts([fact(8, { embedding: vec(0, 1) })], null, { HOUGE_EPISODIC_MIN_COSINE: "0" });
    expect(r.rows.map((f) => f.id)).toEqual([8]);
    expect(r.fts_only).toBe(false);
  });

  it("the gate env var: blank or garbage → default, 0 is valid, out of [0,1] → default", () => {
    expect(resolveEpisodicMinCosine({})).toBe(0.42);
    expect(resolveEpisodicMinCosine({ HOUGE_EPISODIC_MIN_COSINE: "0" })).toBe(0);
    expect(resolveEpisodicMinCosine({ HOUGE_EPISODIC_MIN_COSINE: "0.6" })).toBe(0.6);
    expect(resolveCosineGate("abc", 0.3)).toBe(0.3);
    expect(resolveCosineGate("1.5", 0.3)).toBe(0.3);
    expect(resolveCosineGate("  ", 0.3)).toBe(0.3);
  });
});

function page(id: number, over: Partial<WikiPageRow> = {}): WikiPageRow {
  return {
    id, topic_slug: `p${id}`, title: `Page ${id}`, summary: "", key_facts: "[]", body_md: "", sources: "[]", contradictions: "[]",
    confidence: 0.8, verified_passes: 2, last_verified: null, status: "active", supersedes: null, superseded_by: null,
    applied_count: 0, corrected_count: 0, reuse_value: 1, rating_history: "[]", embedding: null, embedding_model: null,
    created_at: NOW, last_used: null, ...over
  };
}

describe("the wiki gate (spec §3)", () => {
  it("defaults to 0.42 and admits no page below it when both embeddings are present", () => {
    expect(DEFAULT_WIKI_MIN_COSINE).toBe(0.42);
    const store = { searchWikiPagesFts: () => [], getActiveWikiPages: () => [page(1, { embedding: vec(0.45, 0.8930) }), page(2, { embedding: vec(0.4, 0.9165) })] };
    const r = retrieveWikiPages({ store, queryText: "q", queryEmbedding: Q, now: NOW, env: { HOUGE_WIKI_RETRIEVE_CAP: "5" } });
    expect(r.rows.map((p) => p.id)).toEqual([1]);
    expect(r.best_rejected).toBeCloseTo(0.4, 2);
  });
});
