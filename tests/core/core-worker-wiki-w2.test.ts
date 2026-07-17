import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { CoreWorker, defaultSelfWriteDeps } from "../../src/core/core-worker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { LOOP_DISCIPLINE, WIKI_SECTION_HEADER } from "../../src/prompt/composer.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-wiki-w2-"));
  dirs.push(dir);
  return dir;
}

// HERMETICITY (PINNED_ENV cardinal rule): every flag these turns depend on is pinned
// (delete = code default) and restored, so an armed daemon .env can never flip a
// default assertion or point a test at a real Ollama.
const PINNED_ENV = [
  "HOUGE_MAX_CONSECUTIVE_CLARIFY",
  "HOUGE_SELFWRITE_ENABLED",
  "HOUGE_CODEX_ENABLED",
  "HOUGE_SKILLS_ENABLED",
  "HOUGE_HTTPFETCH_ENABLED",
  "HOUGE_TIME_TOOL_ENABLED",
  "HOUGE_SCHEDULER_ENABLED",
  "HOUGE_ASK_SYSTEM_PROMPT",
  "HOUGE_LESSON_CAP_PER_SCOPE",
  "HOUGE_SECRETS_FIREWALL_ENABLED",
  "HOUGE_DUAL_LLM_ENABLED",
  "HOUGE_LLM_READER_PROVIDERS",
  "HOUGE_EPISODIC_ENABLED",
  "HOUGE_EPISODIC_RETRIEVE_CAP",
  "HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS",
  "HOUGE_WIKI_ENABLED",
  "HOUGE_WIKI_MIN_SOURCES",
  "HOUGE_WIKI_VERIFY_PASSES",
  "HOUGE_WIKI_MAX_PAGES",
  "HOUGE_WIKI_RETRIEVE_CAP",
  "HOUGE_WIKI_RECENCY_HALFLIFE_DAYS",
  "HOUGE_WIKI_DECAY_DAYS",
  "HOUGE_EMBED_URL",
  "HOUGE_EMBED_MODEL"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetEvolutionLaneForTests();
});
afterEach(async () => {
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
  for (const key of PINNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function turnRun(store: RunStore, message: string, key = `t:${message}`): string {
  const intake = new Gateway(store).intake(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: message,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: key,
      source_reference: "telegram:update:1:message:1"
    })
  );
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

/** Loop LLM stub: intent classifier → answer; the loop finals immediately. */
function finalLoopLlm(calls: Array<Record<string, unknown>> = []) {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    calls.push(input);
    const system = typeof input.system === "string" ? input.system : "";
    let answer = `ANSWER: ${input.question}`;
    if (system.includes(INTENT_DISCIPLINE)) answer = '{"intent":"answer"}';
    else if (system.includes(LOOP_DISCIPLINE)) answer = '{"action":"final","answer":"好的。"}';
    return { ok: true, output: { question: input.question, answer, model: "fake", provider: "fake" } };
  };
}

function makeWorker(
  store: RunStore,
  llm: (input: Record<string, unknown>) => Promise<ToolAdapterResult>,
  embed: (text: string) => Promise<Float32Array | null>
): CoreWorker {
  return new CoreWorker(
    store,
    projectRoot(),
    llm,
    async () => ({ ok: true, output: { provider: "fake", results: [] } }),
    undefined,
    defaultSelfWriteDeps(),
    undefined,
    undefined,
    undefined,
    embed
  );
}

function seedPage(store: RunStore): number {
  return store.addWikiPage({
    topic_slug: "asml-q2-2026-earnings",
    title: "ASML Q2 2026 earnings",
    summary: "Beat expectations.",
    key_facts: ["EPS €4.9"],
    body_md: "BODY-MUST-NEVER-REACH-A-PROMPT",
    contradictions: [{ claim: "Q2 EPS", a: "source 1: $8.69", b: "source 2: $8.81" }],
    confidence: 0.82,
    verified_passes: 2,
    last_verified: "2026-07-14T09:00:00.000Z",
    created_at: "2026-07-14T09:00:00.000Z"
  });
}

function loopStartedArtifacts(store: RunStore, run_id: string): Record<string, unknown> {
  const event = store.getLedgerEvents(run_id).find((e) => e.event_type === "loop_started")!;
  return event.payload.applied_artifacts as Record<string, unknown>;
}

describe("wiki retrieval folds into the turn (Phase W W2)", () => {
  it("armed: the page's sanitized projection rides the loop SYSTEM prompt; ids recorded + touched; body_md never folds", async () => {
    process.env.HOUGE_WIKI_ENABLED = "1";
    const store = RunStore.openInMemory();
    const calls: Array<Record<string, unknown>> = [];
    try {
      const pageId = seedPage(store);
      const run_id = turnRun(store, "how were the ASML earnings?");
      const worker = makeWorker(store, finalLoopLlm(calls), async () => null); // Ollama down — BM25 carries
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // The composed loop prompt carries the wiki section: header + title + key fact.
      const loopCall = calls.find(
        (c) => typeof c.system === "string" && c.system.includes(LOOP_DISCIPLINE)
      )!;
      const system = String(loopCall.system);
      expect(system).toContain(WIKI_SECTION_HEADER);
      expect(system).toContain("ASML Q2 2026 earnings (confidence 0.82, verified 2026-07-14):");
      expect(system).toContain("  - EPS €4.9");
      // Contradictions surface as a ⚠ claim line; body_md NEVER enters a prompt (7c).
      expect(system).toContain("⚠ sources disagree: Q2 EPS");
      expect(system).not.toContain("BODY-MUST-NEVER-REACH-A-PROMPT");

      // Attribution seed + reuse credit.
      expect(loopStartedArtifacts(store, run_id).wiki_page_ids).toEqual([pageId]);
      const row = store.getWikiPage(pageId)!;
      expect(row.applied_count).toBe(1);
      expect(row.last_used).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("shares ONE query embedding between episodic and wiki retrieval (a single embed call per turn)", async () => {
    process.env.HOUGE_WIKI_ENABLED = "1";
    process.env.HOUGE_EPISODIC_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      seedPage(store);
      store.addEpisodicFact({ chat_id: "555", fact: "Paco follows ASML earnings", created_at: "2026-07-14T09:00:00.000Z" });
      const run_id = turnRun(store, "how were the ASML earnings?");
      let embedCalls = 0;
      const worker = makeWorker(store, finalLoopLlm(), async () => {
        embedCalls += 1;
        return Float32Array.from([1, 0]);
      });
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      // BOTH retrievals armed, exactly ONE Ollama round-trip.
      expect(embedCalls).toBe(1);
    } finally {
      store.close();
    }
  });

  it("disarmed (default OFF): zero behavior — no store read, no embed call, empty attribution, no touch", async () => {
    const store = RunStore.openInMemory();
    try {
      const pageId = seedPage(store);
      // Counter-wrap the retrieval reads: disarmed means they are NEVER consulted.
      let storeReads = 0;
      const wrap = <K extends "searchWikiPagesFts" | "getActiveWikiPages">(method: K): void => {
        const original = store[method].bind(store) as (...args: unknown[]) => unknown;
        (store as unknown as Record<K, unknown>)[method] = (...args: unknown[]) => {
          storeReads += 1;
          return original(...args);
        };
      };
      wrap("searchWikiPagesFts");
      wrap("getActiveWikiPages");

      const run_id = turnRun(store, "how were the ASML earnings?");
      let embedCalls = 0;
      const worker = makeWorker(store, finalLoopLlm(), async () => {
        embedCalls += 1;
        return null;
      });
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      expect(storeReads).toBe(0); // no retrieval call at all
      expect(embedCalls).toBe(0); // no embedding resolved either (episodic off too)
      expect(loopStartedArtifacts(store, run_id).wiki_page_ids).toEqual([]);
      const row = store.getWikiPage(pageId)!;
      expect(row.applied_count).toBe(0);
      expect(row.last_used).toBeNull();
    } finally {
      store.close();
    }
  });

  it("wiki armed with NO matching standing (empty store) composes byte-identically to disarmed (goldens safe)", async () => {
    // Two identical turns, one armed one not, over EMPTY wiki stores: the loop
    // system prompt must be the same shape (no wiki section leaks in when nothing
    // was retrieved).
    const runOnce = async (armed: boolean): Promise<string> => {
      if (armed) process.env.HOUGE_WIKI_ENABLED = "1";
      else delete process.env.HOUGE_WIKI_ENABLED;
      const store = RunStore.openInMemory();
      const calls: Array<Record<string, unknown>> = [];
      try {
        const run_id = turnRun(store, "hello there");
        const worker = makeWorker(store, finalLoopLlm(calls), async () => null);
        await worker.executeRun(run_id, "w");
        const loopCall = calls.find(
          (c) => typeof c.system === "string" && c.system.includes(LOOP_DISCIPLINE)
        )!;
        return String(loopCall.system).replace(/Today's date is [^.]+\./, "DATE.");
      } finally {
        store.close();
      }
    };
    const armed = await runOnce(true);
    const disarmed = await runOnce(false);
    expect(armed).toBe(disarmed);
    expect(armed).not.toContain(WIKI_SECTION_HEADER);
  });
});
