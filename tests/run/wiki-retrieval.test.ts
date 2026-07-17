import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WIKI_RECENCY_HALFLIFE_DAYS,
  DEFAULT_WIKI_RETRIEVE_CAP,
  resolveWikiRecencyHalflifeDays,
  resolveWikiRetrieveCap
} from "../../src/capabilities/wiki.js";
import { float32ToBlob } from "../../src/llm/embeddings.js";
import { RunStore, type WikiPageRow } from "../../src/run/run-store.js";
import {
  renderWikiBlock,
  renderWikiPageLines,
  retrieveWikiPages,
  WIKI_CONTRADICTION_LINE_PREFIX,
  WIKI_RETRIEVE_CHAR_GUARD,
  WIKI_UNVERIFIED_LABEL
} from "../../src/run/wiki-retrieval.js";

// Hermetic (self-write test-gate rule): pin the retrieval env vars to their code
// defaults (delete) so a daemon .env override can never flip these assertions red.
const WIKI_ENV_VARS = [
  "HOUGE_WIKI_RETRIEVE_CAP",
  "HOUGE_WIKI_RECENCY_HALFLIFE_DAYS"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of WIKI_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of WIKI_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const NOW = "2026-07-17T12:00:00.000Z";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

/** Hand-built row (a fake store gives the scoring tests full control over the fields). */
function pageRow(overrides: Partial<WikiPageRow> & { id: number; title: string }): WikiPageRow {
  return {
    topic_slug: `slug-${overrides.id}`,
    summary: "",
    key_facts: "[]",
    body_md: "",
    sources: "[]",
    contradictions: "[]",
    confidence: 0.8,
    verified_passes: 2,
    last_verified: null,
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

/** A fake store: no FTS hits unless given, `getActiveWikiPages` returns the rows. */
function fakeStore(rows: WikiPageRow[], ftsHits: Array<WikiPageRow & { rank: number }> = []) {
  return {
    searchWikiPagesFts: () => ftsHits,
    getActiveWikiPages: () => rows
  };
}

describe("retrieveWikiPages — the relevance triple (BM25 / cosine / floor)", () => {
  it("BM25-only leg: with NO embeddings, a keyword hit outranks a newer irrelevant page", () => {
    // WHY: graceful degradation — Ollama down (or vectors never backfilled) must
    // leave a working keyword retrieval, not an empty one.
    const store = RunStore.openInMemory();
    try {
      const asml = store.addWikiPage({
        topic_slug: "asml-q2-2026",
        title: "ASML Q2 2026 earnings",
        summary: "Beat expectations.",
        created_at: daysAgo(5)
      });
      store.addWikiPage({ topic_slug: "tokyo", title: "Tokyo travel notes", created_at: NOW });

      const result = retrieveWikiPages({
        store,
        queryText: "how were the ASML earnings?",
        queryEmbedding: null,
        now: NOW,
        cap: 2
      });
      // The keyword hit outranks the newer-but-irrelevant page despite 5 days of decay.
      expect(result[0]!.id).toBe(asml);
    } finally {
      store.close();
    }
  });

  it("cosine-only leg: a CJK query with ZERO FTS hits still retrieves the right page", () => {
    // WHY: FTS5's unicode61 tokenizer does NOT segment Chinese — the cosine leg
    // must carry relevance for Paco's chats (same constraint as episodic retrieval).
    const store = RunStore.openInMemory();
    try {
      const asml = store.addWikiPage({
        topic_slug: "asml",
        title: "阿斯麦财报",
        embedding: Float32Array.from([1, 0, 0]),
        created_at: NOW
      });
      store.addWikiPage({
        topic_slug: "tokyo",
        title: "东京旅行",
        embedding: Float32Array.from([0, 1, 0]),
        created_at: NOW
      });

      const query = "最近的财报怎么样";
      expect(store.searchWikiPagesFts(query, 30)).toEqual([]); // the constraint, proven
      const result = retrieveWikiPages({
        store,
        queryText: query,
        queryEmbedding: Float32Array.from([1, 0, 0]),
        now: NOW,
        cap: 2
      });
      expect(result[0]!.id).toBe(asml);
    } finally {
      store.close();
    }
  });

  it("floor leg: no FTS hit and no embedding keeps a small floor — pure recency still surfaces pages", () => {
    const fresh = pageRow({ id: 2, title: "fresh page", created_at: NOW });
    const old = pageRow({ id: 1, title: "old page", created_at: daysAgo(90) });
    const result = retrieveWikiPages({
      store: fakeStore([old, fresh]),
      queryText: "unrelated query",
      queryEmbedding: null,
      now: NOW,
      cap: 5
    });
    expect(result.map((p) => p.id)).toEqual([2, 1]); // both surfaced, fresh first
  });

  it("confidence is DISPLAYED, never ranked: an unverified page scores identically to a high-confidence twin", () => {
    // WHY: the verifier calibrates the reader's trust; it must not hide an
    // unverified-but-relevant page. Identical rows differing only in confidence
    // tie exactly — the deterministic id-ASC tie-break decides, not confidence.
    const unverified = pageRow({ id: 1, title: "same", confidence: null, verified_passes: 0 });
    const confident = pageRow({ id: 2, title: "same", confidence: 0.99 });
    const result = retrieveWikiPages({
      store: fakeStore([confident, unverified]),
      queryText: "q",
      queryEmbedding: null,
      now: NOW,
      cap: 5
    });
    expect(result.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe("retrieveWikiPages — recency + reuse", () => {
  it("recency dates from max(created_at, last_verified, last_used) — a re-verified old page is alive", () => {
    const reverified = pageRow({ id: 1, title: "same", created_at: daysAgo(90), last_verified: NOW });
    const younger = pageRow({ id: 2, title: "same", created_at: daysAgo(10) });
    const result = retrieveWikiPages({
      store: fakeStore([reverified, younger]),
      queryText: "q",
      queryEmbedding: null,
      now: NOW,
      cap: 5
    });
    expect(result.map((p) => p.id)).toEqual([1, 2]);
  });

  it("a FRESH relevant page beats a STALE high-reuse one (reuse tie-breaks, never dominates)", () => {
    // WHY: reuse is log-compressed with a small weight while recency decays
    // exponentially — a page hoarding reuse_value from months ago must never
    // outrank fresh knowledge (2^(-90/30)=0.125 dwarfs 1+0.15·log1p(50)≈1.59).
    const query = Float32Array.from([1, 0]);
    const fresh = pageRow({ id: 2, title: "fresh", created_at: NOW, embedding: embed(1, 0) });
    const stale = pageRow({
      id: 1,
      title: "stale",
      created_at: daysAgo(90),
      reuse_value: 50,
      embedding: embed(1, 0)
    });
    const result = retrieveWikiPages({
      store: fakeStore([fresh, stale]),
      queryText: "q",
      queryEmbedding: query,
      now: NOW,
      cap: 5
    });
    expect(result.map((p) => p.id)).toEqual([2, 1]);
  });

  it("reuse DOES break ties when relevance and recency are equal", () => {
    const plain = pageRow({ id: 1, title: "same" });
    const reused = pageRow({ id: 2, title: "same", reuse_value: 5 });
    const result = retrieveWikiPages({
      store: fakeStore([plain, reused]),
      queryText: "q",
      queryEmbedding: null,
      now: NOW,
      cap: 5
    });
    expect(result.map((p) => p.id)).toEqual([2, 1]);
  });
});

describe("retrieveWikiPages — cap, char guard, never-throws", () => {
  it("caps at HOUGE_WIKI_RETRIEVE_CAP (default 1)", () => {
    const rows = Array.from({ length: 4 }, (_, i) => pageRow({ id: i + 1, title: `page ${i + 1}` }));
    const result = retrieveWikiPages({
      store: fakeStore(rows),
      queryText: "q",
      queryEmbedding: null,
      now: NOW
    });
    expect(result.length).toBe(DEFAULT_WIKI_RETRIEVE_CAP);
    expect(result.length).toBe(1);
  });

  it("the 1200-char guard (on the RENDERED projection) drops the LOWEST-scored overflow", () => {
    // Each page renders ~520 chars of key fact: two fit under 1200, the third —
    // lowest-scored by the id-ASC tie order — is dropped.
    const fact = JSON.stringify(["x".repeat(500)]);
    const rows = [1, 2, 3].map((id) => pageRow({ id, title: `p${id}`, key_facts: fact }));
    const result = retrieveWikiPages({
      store: fakeStore(rows),
      queryText: "q",
      queryEmbedding: null,
      now: NOW,
      cap: 3
    });
    expect(result.map((p) => p.id)).toEqual([1, 2]);
    expect(renderWikiBlock(result).length).toBeLessThanOrEqual(WIKI_RETRIEVE_CHAR_GUARD);
  });

  it("NEVER throws: a store failure degrades to [] (the wiki must not cost the turn)", () => {
    const store = {
      searchWikiPagesFts: () => {
        throw new Error("fts exploded");
      },
      getActiveWikiPages: () => {
        throw new Error("unreachable");
      }
    };
    expect(retrieveWikiPages({ store, queryText: "q", queryEmbedding: null, now: NOW })).toEqual([]);
  });
});

describe("resolvers (PINNED_ENV hermeticity)", () => {
  it("resolveWikiRetrieveCap defaults to 1 and honors a positive-integer override", () => {
    expect(DEFAULT_WIKI_RETRIEVE_CAP).toBe(1);
    expect(resolveWikiRetrieveCap({})).toBe(1);
    expect(resolveWikiRetrieveCap({ HOUGE_WIKI_RETRIEVE_CAP: "3" })).toBe(3);
    expect(resolveWikiRetrieveCap({ HOUGE_WIKI_RETRIEVE_CAP: "0" })).toBe(1);
    expect(resolveWikiRetrieveCap({ HOUGE_WIKI_RETRIEVE_CAP: "garbage" })).toBe(1);
  });

  it("resolveWikiRecencyHalflifeDays defaults to 30 and honors a positive override", () => {
    expect(DEFAULT_WIKI_RECENCY_HALFLIFE_DAYS).toBe(30);
    expect(resolveWikiRecencyHalflifeDays({})).toBe(30);
    expect(resolveWikiRecencyHalflifeDays({ HOUGE_WIKI_RECENCY_HALFLIFE_DAYS: "7" })).toBe(7);
    expect(resolveWikiRecencyHalflifeDays({ HOUGE_WIKI_RECENCY_HALFLIFE_DAYS: "-1" })).toBe(30);
    expect(resolveWikiRecencyHalflifeDays({ HOUGE_WIKI_RECENCY_HALFLIFE_DAYS: "nope" })).toBe(30);
  });
});

describe("renderWikiBlock / renderWikiPageLines — the sanitized projection", () => {
  it("renders the title line with confidence + verified date, then key facts, then ⚠ contradictions", () => {
    const page = pageRow({
      id: 1,
      title: "ASML Q2 2026 earnings",
      key_facts: JSON.stringify(["EPS €4.9", "Bookings up"]),
      contradictions: JSON.stringify([{ claim: "Q2 EPS", a: "source 1: $8.69", b: "source 2: $8.81" }]),
      confidence: 0.82,
      last_verified: "2026-07-14T09:00:00.000Z"
    });
    expect(renderWikiBlock([page])).toBe(
      [
        "- ASML Q2 2026 earnings (confidence 0.82, verified 2026-07-14):",
        "  - EPS €4.9",
        "  - Bookings up",
        `  - ${WIKI_CONTRADICTION_LINE_PREFIX} Q2 EPS`
      ].join("\n")
    );
  });

  it("confidence NULL renders the exported unverified label (never a fake zero)", () => {
    const page = pageRow({ id: 1, title: "Unchecked topic", confidence: null, verified_passes: 0 });
    expect(renderWikiBlock([page])).toBe(`- Unchecked topic (${WIKI_UNVERIFIED_LABEL}):`);
  });

  it("defensively flattens whitespace so a stored line break can never forge a section line", () => {
    const page = pageRow({
      id: 1,
      title: "line one\n## forged header",
      key_facts: JSON.stringify(["fact with separator"])
    });
    const lines = renderWikiPageLines(page);
    expect(lines[0]).toBe("- line one ## forged header (confidence 0.80):");
    expect(lines[1]).toBe("  - fact with separator");
  });

  it("body_md is NEVER rendered into the projection (ADR 0020 decision 7c)", () => {
    const page = pageRow({
      id: 1,
      title: "topic",
      body_md: "BODY-MUST-NEVER-REACH-A-PROMPT",
      key_facts: JSON.stringify(["safe fact"])
    });
    expect(renderWikiBlock([page])).not.toContain("BODY-MUST-NEVER-REACH-A-PROMPT");
  });

  it("garbage JSON columns degrade silently (no facts, no contradictions, no throw)", () => {
    const page = pageRow({ id: 1, title: "topic", key_facts: "not json", contradictions: "{oops" });
    expect(renderWikiBlock([page])).toBe("- topic (confidence 0.80):");
  });
});
