import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blobToFloat32 } from "../../src/llm/embeddings.js";
import { RunStore, WIKI_TOPIC_COSINE_THRESHOLD } from "../../src/run/run-store.js";
import type { WikiPageCandidate } from "../../src/run/run-store.js";

// Hermetic by construction: every cap is passed explicitly — no HOUGE_* env is read here.
let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const NOW = "2026-07-16T12:00:00.000Z";
const LATER = "2026-07-16T13:00:00.000Z";
const CAP = 200;

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-wiki-"));
  dirs.push(dir);
  return join(dir, "houge.sqlite");
}

type CandidateInput = WikiPageCandidate & { created_at?: string };

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    topic_slug: "asml-q2-2026",
    title: "ASML Q2 2026 earnings",
    summary: "Beat expectations.",
    key_facts: ["EPS €4.9"],
    body_md: "## Results\nGood quarter.",
    sources: ["https://a.com/x", "https://b.com/y"],
    confidence: 0.8,
    verified_passes: 2,
    last_verified: NOW,
    ...overrides
  };
}

describe("wiki_pages migration (Phase W, 2026-07-16-wiki-pages)", () => {
  it("is idempotent: reopening the same db re-runs migrate() without error or data loss", () => {
    const path = tempDbPath();
    const store = RunStore.open(path);
    const id = store.addWikiPage(candidate({ created_at: NOW }));
    store.close();

    const reopened = RunStore.open(path);
    try {
      const row = reopened.getWikiPage(id)!;
      expect(row.title).toBe("ASML Q2 2026 earnings");
      expect(row.status).toBe("active");
      // The W2 decay latch landed in the SAME migration (schema complete in one shot).
      expect(() => reopened.getWikiPage(id)).not.toThrow();
    } finally {
      reopened.close();
    }
  });

  it("addWikiPage stores defaults + JSON columns + embedding BLOB round-trip", () => {
    const store = RunStore.openInMemory();
    try {
      const vector = Float32Array.from([0.5, -1.25, 3]);
      const id = store.addWikiPage(
        candidate({
          contradictions: [{ claim: "EPS", a: "source 1: €4.9", b: "source 2: €5.2" }],
          embedding: vector,
          embedding_model: "embeddinggemma",
          created_at: NOW
        })
      );
      const row = store.getWikiPage(id)!;
      expect(row.topic_slug).toBe("asml-q2-2026");
      expect(JSON.parse(row.key_facts)).toEqual(["EPS €4.9"]);
      expect(JSON.parse(row.sources)).toEqual(["https://a.com/x", "https://b.com/y"]);
      expect(JSON.parse(row.contradictions)).toEqual([
        { claim: "EPS", a: "source 1: €4.9", b: "source 2: €5.2" }
      ]);
      expect(row.confidence).toBe(0.8);
      expect(row.verified_passes).toBe(2);
      expect(row.status).toBe("active");
      expect(row.reuse_value).toBe(1.0);
      expect(row.applied_count).toBe(0);
      expect(row.created_at).toBe(NOW);
      expect(row.embedding_model).toBe("embeddinggemma");
      expect(Array.from(blobToFloat32(row.embedding!))).toEqual([0.5, -1.25, 3]);
    } finally {
      store.close();
    }
  });

  it("an unverified page stores confidence NULL (never a fake zero)", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addWikiPage(
        candidate({ confidence: null, verified_passes: 0, last_verified: null, created_at: NOW })
      );
      const row = store.getWikiPage(id)!;
      expect(row.confidence).toBeNull();
      expect(row.verified_passes).toBe(0);
      expect(row.last_verified).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("wiki_pages_fts stays in sync via triggers", () => {
  it("insert is indexed over title/summary/body; a superseded row is filtered by status", () => {
    const store = RunStore.openInMemory();
    try {
      const a = store.addWikiPage(candidate({ created_at: NOW }));
      expect(store.searchWikiPagesFts("earnings", 5).map((r) => r.id)).toEqual([a]);
      // summary and body_md are indexed too.
      expect(store.searchWikiPagesFts("expectations", 5).map((r) => r.id)).toEqual([a]);
      expect(store.searchWikiPagesFts("quarter", 5).map((r) => r.id)).toEqual([a]);

      const b = store.addWikiPage(candidate({ title: "ASML Q3 2026 earnings", created_at: LATER }));
      store.supersedeWikiPage(a, b, LATER);
      expect(store.searchWikiPagesFts("earnings", 5).map((r) => r.id)).toEqual([b]);
    } finally {
      store.close();
    }
  });

  it("an UPDATE of the indexed columns re-indexes (au trigger)", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addWikiPage(candidate({ created_at: NOW }));
      // Reach the au trigger directly (no public rewrite API — rows are supersede-only).
      // @ts-expect-error — reach the private db handle to exercise the trigger.
      store.db.prepare("UPDATE wiki_pages SET title = ? WHERE id = ?").run("Zeppelin flight", id);
      expect(store.searchWikiPagesFts("zeppelin", 5).map((r) => r.id)).toEqual([id]);
      expect(store.searchWikiPagesFts("earnings", 5)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("hostile MATCH syntax degrades to [] — never throws", () => {
    const store = RunStore.openInMemory();
    try {
      store.addWikiPage(candidate({ created_at: NOW }));
      expect(() => store.searchWikiPagesFts('"unbalanced OR NEAR( *', 5)).not.toThrow();
      expect(store.searchWikiPagesFts("!!!)(", 5)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("supersedeWikiPage (bidirectional pointers, never delete)", () => {
  it("links both directions, flips status, and keeps the old row queryable", () => {
    const store = RunStore.openInMemory();
    try {
      const oldId = store.addWikiPage(candidate({ created_at: NOW }));
      const newId = store.addWikiPage(candidate({ created_at: LATER }));
      store.supersedeWikiPage(oldId, newId, LATER);

      const oldRow = store.getWikiPage(oldId)!;
      const newRow = store.getWikiPage(newId)!;
      expect(oldRow.status).toBe("superseded");
      expect(oldRow.superseded_by).toBe(newId);
      expect(newRow.supersedes).toBe(oldId);
      expect(newRow.status).toBe("active");
      // NEVER deleted — the lineage row still reads back whole.
      expect(oldRow.title).toBe("ASML Q2 2026 earnings");
    } finally {
      store.close();
    }
  });
});

describe("saveReconciledWikiPage (verbs add/refine/unchanged)", () => {
  it("no prior ⇒ add", () => {
    const store = RunStore.openInMemory();
    try {
      const saved = store.saveReconciledWikiPage(candidate(), undefined, NOW, CAP);
      expect(saved.verb).toBe("add");
      expect(saved.supersededId).toBeUndefined();
      expect(store.getWikiPage(saved.id)!.status).toBe("active");
    } finally {
      store.close();
    }
  });

  it("prior ⇒ refine: new row inserted + bidirectional supersede, prior NOT penalized without the flag", () => {
    const store = RunStore.openInMemory();
    try {
      const first = store.saveReconciledWikiPage(candidate(), undefined, NOW, CAP);
      const prior = store.getWikiPage(first.id)!;
      const saved = store.saveReconciledWikiPage(
        candidate({ title: "ASML Q2 2026 earnings (updated)" }),
        prior,
        LATER,
        CAP
      );
      expect(saved.verb).toBe("refine");
      expect(saved.supersededId).toBe(prior.id);

      const oldRow = store.getWikiPage(prior.id)!;
      expect(oldRow.status).toBe("superseded");
      expect(oldRow.superseded_by).toBe(saved.id);
      expect(oldRow.corrected_count).toBe(0);
      expect(oldRow.reuse_value).toBe(1.0);
      expect(store.getWikiPage(saved.id)!.supersedes).toBe(prior.id);
    } finally {
      store.close();
    }
  });

  it("priorContradicted ⇒ the OLD row pays corrected_count +1 and reuse −0.5 (only then)", () => {
    const store = RunStore.openInMemory();
    try {
      const first = store.saveReconciledWikiPage(candidate(), undefined, NOW, CAP);
      const prior = store.getWikiPage(first.id)!;
      const saved = store.saveReconciledWikiPage(
        candidate({ priorContradicted: true }),
        prior,
        LATER,
        CAP
      );
      const oldRow = store.getWikiPage(prior.id)!;
      expect(oldRow.corrected_count).toBe(1);
      expect(oldRow.reuse_value).toBe(0.5);
      // The NEW row starts clean.
      expect(store.getWikiPage(saved.id)!.reuse_value).toBe(1.0);
    } finally {
      store.close();
    }
  });

  it("unchanged + prior ⇒ touch last_verified only — no new row, verb unchanged", () => {
    const store = RunStore.openInMemory();
    try {
      const first = store.saveReconciledWikiPage(candidate({ last_verified: NOW }), undefined, NOW, CAP);
      const prior = store.getWikiPage(first.id)!;
      const saved = store.saveReconciledWikiPage(candidate({ unchanged: true }), prior, LATER, CAP);
      expect(saved.verb).toBe("unchanged");
      expect(saved.id).toBe(prior.id);
      const row = store.getWikiPage(prior.id)!;
      expect(row.last_verified).toBe(LATER);
      expect(row.status).toBe("active");
      expect(store.getActiveWikiPages().length).toBe(1); // no duplicate row
    } finally {
      store.close();
    }
  });

  it("a STALE prior (no longer active) degrades to add — a verdict can never retire lineage twice", () => {
    const store = RunStore.openInMemory();
    try {
      const first = store.saveReconciledWikiPage(candidate(), undefined, NOW, CAP);
      const prior = store.getWikiPage(first.id)!;
      const second = store.saveReconciledWikiPage(candidate(), prior, LATER, CAP);
      expect(second.verb).toBe("refine");
      // The SAME (now superseded) prior offered again: degrade to add, don't re-supersede.
      const third = store.saveReconciledWikiPage(candidate(), prior, LATER, CAP);
      expect(third.verb).toBe("add");
      expect(store.getWikiPage(prior.id)!.superseded_by).toBe(second.id); // untouched
    } finally {
      store.close();
    }
  });
});

describe("findWikiPageForTopic (3 identity legs, each graceful)", () => {
  it("leg 1 — exact active slug wins first", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addWikiPage(candidate({ created_at: NOW }));
      const hit = store.findWikiPageForTopic("whatever phrasing", "asml-q2-2026", null);
      expect(hit?.id).toBe(id);
    } finally {
      store.close();
    }
  });

  it("leg 2 — FTS top-1 catches a re-phrased topic with a different slug (F2: every token must match)", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addWikiPage(candidate({ created_at: NOW }));
      // W2 F2 tightened this leg to all-tokens (AND): the rephrase's tokens must all
      // appear in the page ("latest"/"report" would now miss — the cosine leg's job).
      const hit = store.findWikiPageForTopic("ASML 2026 earnings", "asml-2026-earnings", null);
      expect(hit?.id).toBe(id);
    } finally {
      store.close();
    }
  });

  it("leg 3 — cosine ≥ 0.75 over the active embeddings; below the floor misses", () => {
    const store = RunStore.openInMemory();
    try {
      expect(WIKI_TOPIC_COSINE_THRESHOLD).toBe(0.75);
      const id = store.addWikiPage(
        candidate({ title: "页面甲", summary: "", body_md: "", embedding: Float32Array.from([1, 0]), created_at: NOW })
      );
      store.addWikiPage(
        candidate({
          topic_slug: "other",
          title: "页面乙",
          summary: "",
          body_md: "",
          embedding: Float32Array.from([0, 1]),
          created_at: NOW
        })
      );
      // CJK query: unicode61 FTS cannot segment it; the embedding leg carries identity.
      const near = Float32Array.from([0.95, 0.05]);
      expect(store.findWikiPageForTopic("某个话题", "某个话题", near)?.id).toBe(id);
      // Orthogonal-ish query below the floor for both pages: no match.
      const far = Float32Array.from([0.7, 0.72]);
      expect(store.findWikiPageForTopic("别的", "别的", far)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("Ollama down (null embedding) skips the cosine leg gracefully; rows without embeddings are skipped", () => {
    const store = RunStore.openInMemory();
    try {
      store.addWikiPage(candidate({ title: "页面甲", summary: "", body_md: "", created_at: NOW })); // no embedding
      expect(store.findWikiPageForTopic("某个话题", "某个话题", null)).toBeUndefined();
      expect(store.findWikiPageForTopic("某个话题", "某个话题", Float32Array.from([1, 0]))).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("pruneWikiOverflow (via saveReconciledWikiPage): lowest reuse first, never the new row", () => {
  it("prunes the lowest reuse_value actives over the cap and spares the just-written page", () => {
    const store = RunStore.openInMemory();
    try {
      const low = store.addWikiPage(candidate({ topic_slug: "low", created_at: NOW }));
      const high = store.addWikiPage(candidate({ topic_slug: "high", created_at: NOW }));
      // @ts-expect-error — reach the private db handle to shape reuse_value.
      store.db.prepare("UPDATE wiki_pages SET reuse_value = ? WHERE id = ?").run(0.1, low);
      // @ts-expect-error — same.
      store.db.prepare("UPDATE wiki_pages SET reuse_value = ? WHERE id = ?").run(5, high);

      const saved = store.saveReconciledWikiPage(candidate({ topic_slug: "newest" }), undefined, LATER, 2);
      expect(saved.prunedIds).toEqual([low]);
      expect(store.getWikiPage(low)!.status).toBe("pruned"); // reversible, not deleted
      expect(store.getWikiPage(high)!.status).toBe("active");
      expect(store.getWikiPage(saved.id)!.status).toBe("active"); // newest spared
    } finally {
      store.close();
    }
  });

  it("cap ≤ 0 disables pruning", () => {
    const store = RunStore.openInMemory();
    try {
      store.addWikiPage(candidate({ topic_slug: "a", created_at: NOW }));
      const saved = store.saveReconciledWikiPage(candidate({ topic_slug: "b" }), undefined, LATER, 0);
      expect(saved.prunedIds).toEqual([]);
      expect(store.getActiveWikiPages().length).toBe(2);
    } finally {
      store.close();
    }
  });
});
