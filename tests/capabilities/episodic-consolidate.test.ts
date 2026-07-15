import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEpisodicMergeQuestion,
  DEFAULT_EPISODIC_DECAY_DAYS,
  DEFAULT_EPISODIC_MERGE_SIM,
  DEFAULT_EPISODIC_PRUNE_THRESHOLD,
  EPISODIC_MERGE_DISCIPLINE,
  EPISODIC_MERGE_MAX_CLUSTERS_PER_TICK,
  EPISODIC_PROMOTE_MIN_APPLIED,
  EPISODIC_PROMOTE_MIN_AGE_DAYS,
  parseEpisodicMergeResult,
  resolveEpisodicDecayDays,
  resolveEpisodicMergeSim,
  resolveEpisodicPruneThreshold,
  runEpisodicConsolidateTick
} from "../../src/capabilities/episodic-consolidate.js";
import { EPISODIC_FACT_MAX_CHARS, type EpisodicLlm } from "../../src/capabilities/episodic-extract.js";
import { RunStore } from "../../src/run/run-store.js";

// HERMETICITY: the tick reads env through its explicit `env` parameter in every test
// below (never ambient process.env), so a daemon .env that arms the flag or retunes
// the knobs can never flip an assertion. ENABLED is the baseline armed env.
const ENABLED: NodeJS.ProcessEnv = { HOUGE_EPISODIC_ENABLED: "1" };

const NOW = "2026-07-15T12:00:00.000Z";
const CHAT = "222";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

function hoursLater(hours: number): string {
  return new Date(Date.parse(NOW) + hours * 3_600_000).toISOString();
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => {
    prepare(sql: string): { run(...values: Array<string | number>): unknown };
    close(): void;
  };
};

/** File-backed store so a raw connection can set fields the API deliberately has no setter for. */
function fileStore(): { store: RunStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "houge-consolidate-"));
  dirs.push(dir);
  const path = join(dir, "houge.sqlite");
  return { store: RunStore.open(path), path };
}

function setReuseValue(path: string, id: number, value: number): void {
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE episodic_facts SET reuse_value = ? WHERE id = ?").run(value, id);
  raw.close();
}

/** A merge-only fake chain; throws on any unexpected surface (no silent misuse). */
function mergeLlm(answer: string | undefined, calls: string[] = []): EpisodicLlm {
  return async (input) => {
    if (input.system !== EPISODIC_MERGE_DISCIPLINE) {
      throw new Error(`unexpected system prompt: ${input.system.slice(0, 40)}`);
    }
    calls.push(input.question);
    return answer === undefined ? { ok: false } : { ok: true, answer };
  };
}

const noLlm: EpisodicLlm = async () => {
  throw new Error("consolidate must not call the chain in this test");
};
const noEmbed = async (): Promise<Float32Array | null> => null;

describe("runEpisodicConsolidateTick — gating + idempotency per 24h", () => {
  it("master flag off (default) → never runs, even with stale facts", async () => {
    const store = RunStore.openInMemory();
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "stale", created_at: daysAgo(90) });
      const result = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: {} });
      expect(result.ran).toBe(false);
      expect(store.getActiveEpisodicFacts(CHAT)[0]!.reuse_value).toBe(1.0); // untouched
    } finally {
      store.close();
    }
  });

  it("runs at most once per 24h (single-row state marker), and marks ran even with no work", async () => {
    const store = RunStore.openInMemory();
    try {
      const first = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      expect(first.ran).toBe(true);
      expect(store.getEpisodicConsolidateLastRun()).toBe(NOW);
      // No work → no ledger noise, but the marker still advanced (idempotency holds).
      expect(store.getLedgerEvents().filter((e) => e.event_type === "episodic_consolidate_tick")).toEqual([]);

      const second = await runEpisodicConsolidateTick({
        store,
        llm: noLlm,
        embed: noEmbed,
        now: hoursLater(23),
        env: ENABLED
      });
      expect(second.ran).toBe(false);

      const third = await runEpisodicConsolidateTick({
        store,
        llm: noLlm,
        embed: noEmbed,
        now: hoursLater(25),
        env: ENABLED
      });
      expect(third.ran).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("decay + prune boundaries", () => {
  it("a fact idle past the decay window loses 20% reuse_value; a fresh one is untouched", async () => {
    const store = RunStore.openInMemory();
    try {
      const stale = store.addEpisodicFact({ chat_id: CHAT, fact: "stale fact", created_at: daysAgo(31) });
      const fresh = store.addEpisodicFact({ chat_id: CHAT, fact: "fresh fact", created_at: daysAgo(1) });
      const result = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      expect(result.facts_decayed).toBe(1);
      expect(store.getEpisodicFact(stale)!.reuse_value).toBeCloseTo(0.8);
      expect(store.getEpisodicFact(fresh)!.reuse_value).toBe(1.0);
    } finally {
      store.close();
    }
  });

  it("a recent last_used shields an old fact from decay (applied facts are not stale)", async () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addEpisodicFact({ chat_id: CHAT, fact: "old but used", created_at: daysAgo(90) });
      store.touchEpisodicApplied([id], daysAgo(2));
      const result = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      expect(result.facts_decayed).toBe(0);
      expect(store.getEpisodicFact(id)!.reuse_value).toBe(1.0);
    } finally {
      store.close();
    }
  });

  it("decay below the prune threshold demotes to 'pruned' (reversible status, NEVER a delete)", async () => {
    const { store, path } = fileStore();
    try {
      const doomed = store.addEpisodicFact({ chat_id: CHAT, fact: "doomed", created_at: daysAgo(31) });
      const spared = store.addEpisodicFact({ chat_id: CHAT, fact: "spared", created_at: daysAgo(31) });
      setReuseValue(path, doomed, 0.24); // 0.24 × 0.8 = 0.192 < 0.2 → pruned
      setReuseValue(path, spared, 0.26); // 0.26 × 0.8 = 0.208 ≥ 0.2 → stays active

      const result = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      expect(result.pruned_ids).toEqual([doomed]);
      expect(store.getEpisodicFact(doomed)!.status).toBe("pruned"); // the row survives
      expect(store.getEpisodicFact(spared)!.status).toBe("active");
    } finally {
      store.close();
    }
  });
});

describe("merge: near-duplicate clusters → one LLM call → ADD + supersede chain", () => {
  it("merges a cosine-≥threshold pair, inheriting max salience, capped-sum reuse, earliest valid_from", async () => {
    const { store, path } = fileStore();
    try {
      const a = store.addEpisodicFact({
        chat_id: CHAT,
        fact: "Paco 喜欢骑车",
        salience: 0.5,
        participants: ["Paco"],
        source_turn_ids: ["turn_a"],
        embedding: Float32Array.from([1, 0]),
        created_at: daysAgo(10)
      });
      const b = store.addEpisodicFact({
        chat_id: CHAT,
        fact: "Paco 周末骑自行车",
        salience: 0.9,
        participants: ["Paco"],
        source_turn_ids: ["turn_b"],
        embedding: Float32Array.from([0.999, 0.02]), // cos ≈ 0.9998 ≥ 0.92
        created_at: daysAgo(3)
      });
      setReuseValue(path, a, 3);
      setReuseValue(path, b, 4); // sum 7 → capped at 5

      const calls: string[] = [];
      const result = await runEpisodicConsolidateTick({
        store,
        llm: mergeLlm('{"fact":"Paco 喜欢周末骑自行车"}', calls),
        embed: async () => Float32Array.from([1, 0.01]),
        now: NOW,
        env: ENABLED
      });
      expect(result.clusters_merged).toBe(1);
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain(`#${a}: Paco 喜欢骑车`); // sources rode the DATA channel

      const active = store.getActiveEpisodicFacts(CHAT);
      expect(active.length).toBe(1);
      const merged = active[0]!;
      expect(merged.fact).toBe("Paco 喜欢周末骑自行车");
      expect(merged.salience).toBe(0.9); // max
      expect(merged.reuse_value).toBe(5); // sum-capped
      expect(merged.valid_from).toBe(daysAgo(10)); // earliest — true since the FIRST source
      expect(merged.embedding).not.toBeNull(); // re-embedded
      expect(JSON.parse(merged.participants)).toEqual(["Paco"]);
      expect(JSON.parse(merged.source_turn_ids).sort()).toEqual(["turn_a", "turn_b"]); // provenance union

      // BOTH sources superseded → merged, valid_until stamped (invalidate, never delete).
      for (const id of [a, b]) {
        const source = store.getEpisodicFact(id)!;
        expect(source.status).toBe("superseded");
        expect(source.superseded_by).toBe(merged.id);
        expect(source.valid_until).toBe(NOW);
      }
    } finally {
      store.close();
    }
  });

  it("dissimilar facts (cosine < threshold) never cluster — no LLM call at all", async () => {
    const store = RunStore.openInMemory();
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "a", embedding: Float32Array.from([1, 0]), created_at: NOW });
      store.addEpisodicFact({ chat_id: CHAT, fact: "b", embedding: Float32Array.from([0, 1]), created_at: NOW });
      const result = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      expect(result.clusters_merged).toBe(0);
      expect(store.getActiveEpisodicFacts(CHAT).length).toBe(2);
    } finally {
      store.close();
    }
  });

  it("an LLM failure (chain down / garbage / throw) is NON-DESTRUCTIVE: sources stay active", async () => {
    // WHY: merge deletes nothing on its own — a flaky verdict may miss a dedupe,
    // but it must never be able to lose a fact.
    for (const llm of [
      mergeLlm(undefined), // ok:false
      mergeLlm("sorry, no JSON here"), // unparseable
      (async () => {
        throw new Error("chain exploded");
      }) as EpisodicLlm
    ]) {
      const store = RunStore.openInMemory();
      try {
        store.addEpisodicFact({ chat_id: CHAT, fact: "a", embedding: Float32Array.from([1, 0]), created_at: NOW });
        store.addEpisodicFact({ chat_id: CHAT, fact: "b", embedding: Float32Array.from([1, 0]), created_at: NOW });
        const result = await runEpisodicConsolidateTick({ store, llm, embed: noEmbed, now: NOW, env: ENABLED });
        expect(result.clusters_merged).toBe(0);
        expect(store.getActiveEpisodicFacts(CHAT).length).toBe(2);
        expect(result.ran).toBe(true); // the tick still completes (and stays idempotent)
      } finally {
        store.close();
      }
    }
  });

  it("a merged row with a failed re-embed is stored without an embedding (backfillable)", async () => {
    const store = RunStore.openInMemory();
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "a", embedding: Float32Array.from([1, 0]), created_at: NOW });
      store.addEpisodicFact({ chat_id: CHAT, fact: "b", embedding: Float32Array.from([1, 0]), created_at: NOW });
      const result = await runEpisodicConsolidateTick({
        store,
        llm: mergeLlm('{"fact":"a and b"}'),
        embed: async () => {
          throw new Error("ollama down");
        },
        now: NOW,
        env: ENABLED
      });
      expect(result.clusters_merged).toBe(1);
      const merged = store.getActiveEpisodicFacts(CHAT)[0]!;
      expect(merged.embedding).toBeNull();
      expect(merged.embedding_model).toBeNull();
    } finally {
      store.close();
    }
  });

  it("caps at 5 clusters (= 5 LLM calls) per tick", async () => {
    const store = RunStore.openInMemory();
    try {
      // 6 orthogonal pairs → 6 candidate clusters, only 5 may merge this tick.
      for (let pair = 0; pair < 6; pair += 1) {
        const vector = Float32Array.from(Array.from({ length: 6 }, (_, i) => (i === pair ? 1 : 0)));
        store.addEpisodicFact({ chat_id: CHAT, fact: `pair ${pair} a`, embedding: vector, created_at: NOW });
        store.addEpisodicFact({ chat_id: CHAT, fact: `pair ${pair} b`, embedding: vector, created_at: NOW });
      }
      const calls: string[] = [];
      const result = await runEpisodicConsolidateTick({
        store,
        llm: mergeLlm('{"fact":"merged pair"}', calls),
        embed: noEmbed,
        now: NOW,
        env: ENABLED
      });
      expect(result.clusters_merged).toBe(EPISODIC_MERGE_MAX_CLUSTERS_PER_TICK);
      expect(calls.length).toBe(EPISODIC_MERGE_MAX_CLUSTERS_PER_TICK);
      // 6 pairs − 5 merges = 1 pair untouched + 5 merged rows active.
      expect(store.getActiveEpisodicFacts(CHAT).length).toBe(7);
    } finally {
      store.close();
    }
  });

  it("facts without embeddings never cluster (backfill first, merge later)", async () => {
    const store = RunStore.openInMemory();
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "a", created_at: NOW });
      store.addEpisodicFact({ chat_id: CHAT, fact: "a", created_at: NOW }); // identical text, no vectors
      const result = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      expect(result.clusters_merged).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("promote: applied ≥3 and ≥7d old → salience bump, convergent at 1", () => {
  it("bumps a qualifying fact by 0.2 and converges to exactly 1 over repeated ticks", async () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addEpisodicFact({ chat_id: CHAT, fact: "durable", salience: 0.7, created_at: daysAgo(10) });
      store.touchEpisodicApplied([id], daysAgo(1));
      store.touchEpisodicApplied([id], daysAgo(1));
      store.touchEpisodicApplied([id], daysAgo(1)); // applied_count = 3, last_used fresh → no decay

      const first = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      expect(first.promoted_ids).toEqual([id]);
      expect(store.getEpisodicFact(id)!.salience).toBeCloseTo(0.9);

      const second = await runEpisodicConsolidateTick({
        store,
        llm: noLlm,
        embed: noEmbed,
        now: hoursLater(25),
        env: ENABLED
      });
      expect(second.promoted_ids).toEqual([id]);
      expect(store.getEpisodicFact(id)!.salience).toBe(1); // min(1, 0.9 + 0.2) — capped

      // CONVERGED: salience = 1 no longer qualifies, so the bump can never repeat
      // unbounded — the guard is the `salience < 1` gate, not a marker column.
      const third = await runEpisodicConsolidateTick({
        store,
        llm: noLlm,
        embed: noEmbed,
        now: hoursLater(50),
        env: ENABLED
      });
      expect(third.promoted_ids).toEqual([]);
      expect(store.getEpisodicFact(id)!.salience).toBe(1);
    } finally {
      store.close();
    }
  });

  it("too young or too rarely applied → not promoted", async () => {
    const store = RunStore.openInMemory();
    try {
      const young = store.addEpisodicFact({ chat_id: CHAT, fact: "young", salience: 0.5, created_at: daysAgo(3) });
      store.touchEpisodicApplied([young], NOW);
      store.touchEpisodicApplied([young], NOW);
      store.touchEpisodicApplied([young], NOW);
      const rare = store.addEpisodicFact({ chat_id: CHAT, fact: "rare", salience: 0.5, created_at: daysAgo(10) });
      store.touchEpisodicApplied([rare], NOW);

      const result = await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      expect(result.promoted_ids).toEqual([]);
      expect(EPISODIC_PROMOTE_MIN_APPLIED).toBe(3);
      expect(EPISODIC_PROMOTE_MIN_AGE_DAYS).toBe(7);
    } finally {
      store.close();
    }
  });
});

describe("ledger event (episodic_consolidate_tick)", () => {
  it("a tick that did work emits ONE valid event with the counts", async () => {
    const store = RunStore.openInMemory();
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "stale", created_at: daysAgo(31) });
      await runEpisodicConsolidateTick({ store, llm: noLlm, embed: noEmbed, now: NOW, env: ENABLED });
      const events = store.getLedgerEvents().filter((e) => e.event_type === "episodic_consolidate_tick");
      expect(events.length).toBe(1);
      expect(events[0]!.payload).toEqual({
        facts_decayed: 1,
        pruned_ids: [],
        clusters_merged: 0,
        promoted_ids: []
      });
    } finally {
      store.close();
    }
  });
});

describe("merge verdict parsing (tolerant, write-time backstop)", () => {
  it("accepts prose-wrapped strict JSON and sanitizes the text", () => {
    // \\n rides the JSON escape → a REAL newline in the parsed fact → flattened at write time.
    expect(parseEpisodicMergeResult('Here you go: {"fact":"Paco cycles\\non weekends → daily"}')).toBe(
      "Paco cycles on weekends - daily"
    );
  });

  it("rejects garbage, missing fact, and over-long facts (never an unsafe row)", () => {
    expect(parseEpisodicMergeResult("no json at all")).toBeNull();
    expect(parseEpisodicMergeResult('{"other":"x"}')).toBeNull();
    expect(parseEpisodicMergeResult(`{"fact":"${"x".repeat(EPISODIC_FACT_MAX_CHARS + 1)}"}`)).toBeNull();
  });

  it("buildEpisodicMergeQuestion lists each source as DATA with its id", () => {
    const q = buildEpisodicMergeQuestion([
      { id: 1, fact: "a" },
      { id: 2, fact: "b" }
    ]);
    expect(q).toContain("#1: a");
    expect(q).toContain("#2: b");
    expect(q).toContain("reference data");
  });
});

describe("resolvers (PINNED_ENV hermeticity)", () => {
  it("decay days default 30; prune threshold default 0.2; merge sim default 0.92", () => {
    expect(DEFAULT_EPISODIC_DECAY_DAYS).toBe(30);
    expect(DEFAULT_EPISODIC_PRUNE_THRESHOLD).toBe(0.2);
    expect(DEFAULT_EPISODIC_MERGE_SIM).toBe(0.92);
    expect(resolveEpisodicDecayDays({})).toBe(30);
    expect(resolveEpisodicPruneThreshold({})).toBe(0.2);
    expect(resolveEpisodicMergeSim({})).toBe(0.92);
  });

  it("overrides parse; garbage/out-of-range degrade to defaults", () => {
    expect(resolveEpisodicDecayDays({ HOUGE_EPISODIC_DECAY_DAYS: "10" })).toBe(10);
    expect(resolveEpisodicDecayDays({ HOUGE_EPISODIC_DECAY_DAYS: "0" })).toBe(30);
    expect(resolveEpisodicPruneThreshold({ HOUGE_EPISODIC_PRUNE_THRESHOLD: "0.5" })).toBe(0.5);
    expect(resolveEpisodicPruneThreshold({ HOUGE_EPISODIC_PRUNE_THRESHOLD: "-1" })).toBe(0.2);
    expect(resolveEpisodicMergeSim({ HOUGE_EPISODIC_MERGE_SIM: "0.8" })).toBe(0.8);
    expect(resolveEpisodicMergeSim({ HOUGE_EPISODIC_MERGE_SIM: "1.5" })).toBe(0.92);
    expect(resolveEpisodicMergeSim({ HOUGE_EPISODIC_MERGE_SIM: "junk" })).toBe(0.92);
  });
});
