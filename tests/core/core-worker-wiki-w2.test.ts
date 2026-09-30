import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { buildTurnPrompt, type TurnContextDeps } from "../../src/omp/turn-context.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { ompWorker } from "../helpers/omp-worker.js";

// Wiki retrieval on the omp turn (Phase W W2): the worker's turn context retrieves pages and the
// daemon prepends them as the prompt's [context] block (plan deviation 1), recording attribution.
// Ported from the inner-loop suite (Task 14), which asserted the same through the loop's system prompt.
pinOmpEnv();
pinEnabledFlags();
const PINNED = ["HOUGE_EPISODIC_RETRIEVE_CAP", "HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS", "HOUGE_WIKI_RETRIEVE_CAP", "HOUGE_WIKI_RECENCY_HALFLIFE_DAYS",
  "HOUGE_WIKI_DECAY_DAYS", "HOUGE_EMBED_URL", "HOUGE_EMBED_MODEL", "HOUGE_LESSON_CAP_PER_SCOPE"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => {
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = shortTmp("hw2-");
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
  tmp.cleanup();
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function run(message: string): string {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: message, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `t:${message}:${Math.random()}`, source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error("intake failed");
  return intake.run_id;
}

function context(embed: (text: string) => Promise<Float32Array | null>): TurnContextDeps {
  const worker = ompWorker(store, tmp.dir, { project: join(tmp.dir, "project"), embed });
  return (worker as unknown as { ompTurnContext(dir: string): TurnContextDeps }).ompTurnContext(tmp.dir);
}

async function prompt(message: string, embed: (text: string) => Promise<Float32Array | null> = async () => null) {
  const run_id = run(message);
  const text = await buildTurnPrompt(context(embed), { run_id, chat_id: "555", message, source: "telegram" });
  const started = store.getLedgerEvents(run_id).find((e) => e.event_type === "loop_started");
  return { text, artifacts: started?.payload.applied_artifacts as Record<string, unknown> };
}

function seedPage(): number {
  return store.addWikiPage({
    topic_slug: "asml-q2-2026-earnings", title: "ASML Q2 2026 earnings", summary: "Beat expectations.", key_facts: ["EPS €4.9"],
    body_md: "BODY-MUST-NEVER-REACH-A-PROMPT", contradictions: [{ claim: "Q2 EPS", a: "source 1: $8.69", b: "source 2: $8.81" }],
    confidence: 0.82, verified_passes: 2, last_verified: "2026-07-14T09:00:00.000Z", created_at: "2026-07-14T09:00:00.000Z"
  });
}

describe("wiki retrieval folds into the omp turn (Phase W W2)", () => {
  it("armed: the page's sanitized projection rides the context block; ids recorded + touched; body_md never folds", async () => {
    // replaces: wiki retrieval folds into the turn › "armed: the page's sanitized projection rides the loop SYSTEM prompt; ids recorded + touched; body_md never folds"
    process.env.HOUGE_WIKI_ENABLED = "1";
    const pageId = seedPage();
    const { text, artifacts } = await prompt("how were the ASML earnings?"); // Ollama down — BM25 carries
    expect(text).toContain("ASML Q2 2026 earnings (confidence 0.82, verified 2026-07-14):");
    expect(text).toContain("  - EPS €4.9");
    expect(text).toContain("⚠ sources disagree: Q2 EPS");
    expect(text).not.toContain("BODY-MUST-NEVER-REACH-A-PROMPT");
    expect(artifacts.wiki_page_ids).toEqual([pageId]);
    const row = store.getWikiPage(pageId)!;
    expect(row.applied_count).toBe(1);
    expect(row.last_used).not.toBeNull();
  });

  it("shares ONE query embedding between episodic and wiki retrieval (a single embed call per turn)", async () => {
    // replaces: wiki retrieval folds into the turn › "shares ONE query embedding between episodic and wiki retrieval (a single embed call per turn)"
    process.env.HOUGE_WIKI_ENABLED = "1";
    process.env.HOUGE_EPISODIC_ENABLED = "1";
    seedPage();
    store.addEpisodicFact({ chat_id: "555", fact: "Paco follows ASML earnings", created_at: "2026-07-14T09:00:00.000Z" });
    let embeds = 0;
    await prompt("how were the ASML earnings?", async () => { embeds += 1; return Float32Array.from([1, 0]); });
    expect(embeds).toBe(1);
  });

  it("disarmed (default OFF): zero behavior — no store read, no embed call, empty attribution, no touch", async () => {
    // replaces: wiki retrieval folds into the turn › "disarmed (default OFF): zero behavior — no store read, no embed call, empty attribution, no touch"
    const pageId = seedPage();
    let reads = 0;
    for (const method of ["searchWikiPagesFts", "getActiveWikiPages"] as const) {
      const original = store[method].bind(store) as (...args: unknown[]) => unknown;
      (store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { reads += 1; return original(...args); };
    }
    let embeds = 0;
    const { text, artifacts } = await prompt("how were the ASML earnings?", async () => { embeds += 1; return null; });
    expect([reads, embeds]).toEqual([0, 0]);
    expect(text).toBe("how were the ASML earnings?");
    expect(artifacts.wiki_page_ids).toEqual([]);
    expect(store.getWikiPage(pageId)).toMatchObject({ applied_count: 0, last_used: null });
  });

  it("wiki armed with NO matching page (empty store) prompts byte-identically to disarmed (goldens safe)", async () => {
    // replaces: wiki retrieval folds into the turn › "wiki armed with NO matching standing (empty store) composes byte-identically to disarmed (goldens safe)"
    process.env.HOUGE_WIKI_ENABLED = "1";
    const armed = (await prompt("hello there")).text;
    delete process.env.HOUGE_WIKI_ENABLED;
    const disarmed = (await prompt("hello there")).text;
    expect(armed).toBe(disarmed);
    expect(armed).toBe("hello there");
  });
});
