import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { float32ToBlob } from "../../src/llm/embeddings.js";
import {
  DEFAULT_EPISODIC_RECENCY_HALFLIFE_DAYS,
  DEFAULT_EPISODIC_RETRIEVE_CAP,
  EPISODIC_RETRIEVE_CHAR_GUARD,
  renderEpisodicFactsBlock,
  resolveEpisodicRecencyHalflifeDays,
  resolveEpisodicRetrieveCap,
  retrieveEpisodicFacts
} from "../../src/run/episodic-retrieval.js";
import { RunStore, type EpisodicFactRow } from "../../src/run/run-store.js";

// Hermetic (self-write test-gate rule): pin the retrieval env vars to their code
// defaults (delete) so a daemon .env override can never flip these assertions red.
const EPISODIC_ENV_VARS = [
  "HOUGE_EPISODIC_RETRIEVE_CAP",
  "HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of EPISODIC_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of EPISODIC_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const NOW = "2026-07-15T12:00:00.000Z";
const CHAT = "222";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

/** Hand-built row (a fake store gives the scoring tests full control over the fields). */
function factRow(overrides: Partial<EpisodicFactRow> & { id: number; fact: string }): EpisodicFactRow {
  return {
    participants: "[]",
    chat_id: CHAT,
    source_turn_ids: "[]",
    occurred_at: null,
    valid_from: null,
    valid_until: null,
    salience: 1,
    status: "active",
    supersedes: null,
    superseded_by: null,
    applied_count: 0,
    corrected_count: 0,
    reuse_value: 1,
    rating_history: "[]",
    embedding: null,
    embedding_model: null,
    created_at: NOW,
    last_used: null,
    ...overrides
  };
}

function embed(...values: number[]): Uint8Array {
  return float32ToBlob(Float32Array.from(values));
}

/** A fake store: no FTS hits unless given, `getActiveEpisodicFacts` returns the rows. */
function fakeStore(rows: EpisodicFactRow[], ftsHits: Array<EpisodicFactRow & { rank: number }> = []) {
  return {
    searchEpisodicFactsFts: () => ftsHits,
    getActiveEpisodicFacts: () => rows
  };
}

describe("retrieveEpisodicFacts — scoring properties", () => {
  it("a FRESH relevant fact beats a STALE high-reuse one (reuse tie-breaks, never dominates)", () => {
    // WHY: reuse is log-compressed with a small weight while recency decays
    // exponentially — so a fact hoarding reuse_value from months ago can never
    // outrank what the user just told us. If this ordering ever flips, the memory
    // gets stuck on its greatest hits and stops learning.
    const query = Float32Array.from([1, 0]);
    const fresh = factRow({ id: 2, fact: "Paco moved to Melbourne", created_at: NOW, embedding: embed(1, 0) });
    const stale = factRow({
      id: 1,
      fact: "Paco lives in Sydney",
      created_at: daysAgo(60),
      reuse_value: 50, // hoarded standing
      embedding: embed(1, 0) // just as RELEVANT as the fresh fact
    });
    const result = retrieveEpisodicFacts({
      store: fakeStore([fresh, stale]),
      chat_id: CHAT,
      queryText: "where does Paco live?",
      queryEmbedding: query,
      now: NOW
    });
    expect(result.map((f) => f.id)).toEqual([2, 1]);
  });

  it("reuse DOES break ties when relevance and recency are equal", () => {
    const query = Float32Array.from([1, 0]);
    const plain = factRow({ id: 1, fact: "fact a", embedding: embed(1, 0) });
    const reused = factRow({ id: 2, fact: "fact b", embedding: embed(1, 0), reuse_value: 5 });
    const result = retrieveEpisodicFacts({
      store: fakeStore([plain, reused]),
      chat_id: CHAT,
      queryText: "q",
      queryEmbedding: query,
      now: NOW
    });
    expect(result.map((f) => f.id)).toEqual([2, 1]); // higher reuse first…
  });

  it("salience multiplies the score (a low-salience fact loses an otherwise-equal contest)", () => {
    const query = Float32Array.from([1, 0]);
    const loud = factRow({ id: 1, fact: "fact a", embedding: embed(1, 0), salience: 1 });
    const quiet = factRow({ id: 2, fact: "fact b", embedding: embed(1, 0), salience: 0.3 });
    const result = retrieveEpisodicFacts({
      store: fakeStore([loud, quiet]),
      chat_id: CHAT,
      queryText: "q",
      queryEmbedding: query,
      now: NOW
    });
    expect(result.map((f) => f.id)).toEqual([1, 2]);
  });

  it("exact ties order deterministically by id ASC", () => {
    const rows = [factRow({ id: 3, fact: "same" }), factRow({ id: 1, fact: "same" }), factRow({ id: 2, fact: "same" })];
    const result = retrieveEpisodicFacts({
      store: fakeStore(rows),
      chat_id: CHAT,
      queryText: "q",
      queryEmbedding: null,
      now: NOW
    });
    expect(result.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it("caps at HOUGE_EPISODIC_RETRIEVE_CAP (default 6)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => factRow({ id: i + 1, fact: `fact ${i + 1}` }));
    const result = retrieveEpisodicFacts({
      store: fakeStore(rows),
      chat_id: CHAT,
      queryText: "q",
      queryEmbedding: null,
      now: NOW
    });
    expect(result.length).toBe(DEFAULT_EPISODIC_RETRIEVE_CAP);
  });

  it("the ~900-char guard drops the LOWEST-scored overflow, never the best facts", () => {
    // Three 400-char facts: only the two best fit under the guard; the third —
    // lowest-scored by the id-ASC tie order — is dropped.
    const long = "x".repeat(400);
    const rows = [1, 2, 3].map((id) => factRow({ id, fact: long }));
    const result = retrieveEpisodicFacts({
      store: fakeStore(rows),
      chat_id: CHAT,
      queryText: "q",
      queryEmbedding: null,
      now: NOW
    });
    expect(result.map((f) => f.id)).toEqual([1, 2]);
    expect(result.reduce((sum, f) => sum + f.fact.length, 0)).toBeLessThanOrEqual(EPISODIC_RETRIEVE_CHAR_GUARD);
  });

  it("NEVER throws: a store failure degrades to [] (memory must not cost the turn)", () => {
    const store = {
      searchEpisodicFactsFts: () => {
        throw new Error("fts exploded");
      },
      getActiveEpisodicFacts: () => {
        throw new Error("unreachable");
      }
    };
    expect(retrieveEpisodicFacts({ store, chat_id: CHAT, queryText: "q", queryEmbedding: null, now: NOW })).toEqual([]);
  });
});

describe("retrieveEpisodicFacts — CJK + degradation (the KNOWN unicode61 constraint)", () => {
  it("a CJK query with ZERO FTS hits still retrieves the right fact via cosine", () => {
    // WHY: FTS5's unicode61 tokenizer does NOT segment Chinese — a CJK run indexes
    // as ONE token, so keyword relevance is near-useless for Paco's chats. The
    // cosine leg must carry relevance: zero-FTS-hit ≠ zero relevance.
    const store = RunStore.openInMemory();
    try {
      const cycling = store.addEpisodicFact({
        chat_id: CHAT,
        fact: "Paco 喜欢周末骑车",
        embedding: Float32Array.from([1, 0, 0]),
        created_at: NOW
      });
      store.addEpisodicFact({
        chat_id: CHAT,
        fact: "Paco 住在悉尼",
        embedding: Float32Array.from([0, 1, 0]),
        created_at: NOW
      });

      const query = "明天周末我该干嘛";
      expect(store.searchEpisodicFactsFts(CHAT, query, 30)).toEqual([]); // the constraint, proven
      const result = retrieveEpisodicFacts({
        store,
        chat_id: CHAT,
        queryText: query,
        queryEmbedding: Float32Array.from([1, 0, 0]), // "semantically about cycling"
        now: NOW
      });
      expect(result[0]!.id).toBe(cycling);
    } finally {
      store.close();
    }
  });

  it("with NO embeddings at all, BM25 alone still ranks English facts by keyword relevance", () => {
    // WHY: graceful degradation (ADR 0016) — Ollama down or vectors not yet
    // backfilled must leave a working keyword memory, not an empty one.
    const store = RunStore.openInMemory();
    try {
      const sydney = store.addEpisodicFact({
        chat_id: CHAT,
        fact: "Paco lives in Sydney near the harbour",
        created_at: daysAgo(5)
      });
      store.addEpisodicFact({ chat_id: CHAT, fact: "Paco prefers concise answers", created_at: NOW });

      const result = retrieveEpisodicFacts({
        store,
        chat_id: CHAT,
        queryText: "is the Sydney harbour walk nice?",
        queryEmbedding: null,
        now: NOW
      });
      // The keyword hit outranks the newer-but-irrelevant fact despite 5 days of decay.
      expect(result[0]!.id).toBe(sydney);
    } finally {
      store.close();
    }
  });
});

describe("resolvers (PINNED_ENV hermeticity)", () => {
  it("resolveEpisodicRetrieveCap defaults to 6 and honors a positive-integer override", () => {
    expect(DEFAULT_EPISODIC_RETRIEVE_CAP).toBe(6);
    expect(resolveEpisodicRetrieveCap({})).toBe(6);
    expect(resolveEpisodicRetrieveCap({ HOUGE_EPISODIC_RETRIEVE_CAP: "3" })).toBe(3);
    expect(resolveEpisodicRetrieveCap({ HOUGE_EPISODIC_RETRIEVE_CAP: "0" })).toBe(6);
    expect(resolveEpisodicRetrieveCap({ HOUGE_EPISODIC_RETRIEVE_CAP: "garbage" })).toBe(6);
  });

  it("resolveEpisodicRecencyHalflifeDays defaults to 14 and honors a positive override", () => {
    expect(DEFAULT_EPISODIC_RECENCY_HALFLIFE_DAYS).toBe(14);
    expect(resolveEpisodicRecencyHalflifeDays({})).toBe(14);
    expect(resolveEpisodicRecencyHalflifeDays({ HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS: "7" })).toBe(7);
    expect(resolveEpisodicRecencyHalflifeDays({ HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS: "-1" })).toBe(14);
    expect(resolveEpisodicRecencyHalflifeDays({ HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS: "nope" })).toBe(14);
  });
});

describe("renderEpisodicFactsBlock", () => {
  it("renders one `- <fact>` line per fact", () => {
    expect(renderEpisodicFactsBlock([{ fact: "Paco lives in Sydney" }, { fact: "Paco 喜欢骑车" }])).toBe(
      "- Paco lives in Sydney\n- Paco 喜欢骑车"
    );
  });

  it("defensively flattens whitespace so a stored line break can never forge a section line", () => {
    expect(renderEpisodicFactsBlock([{ fact: "line one\n## forged header" }])).toBe("- line one ## forged header");
    expect(renderEpisodicFactsBlock([{ fact: "   " }])).toBe("");
  });
});
