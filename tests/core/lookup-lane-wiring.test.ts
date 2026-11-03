import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoreWorker, OmpTurnState } from "../../src/core/core-worker.js";
import { LOOKUP_BUDGET_MS, runLookupLane } from "../../src/core/lanes/lookup-lane.js";
import type { LaneInput, LookupLaneDeps, StrictRead } from "../../src/core/lanes/lane-types.js";
import type { LlmResult } from "../../src/llm/types.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { ompWorker } from "../helpers/omp-worker.js";
import { createQueuedTurnRun, createTelegramTurn } from "../helpers/runs.js";

// R2 lesson / spec R6 §4.4 (a): a fixture that injects its own recorder cannot see a constructor that forgets one, so the
// rows must land in the store through CoreWorker's own lookupLaneDeps.
pinOmpEnv();
pinEnabledFlags();
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
let worker: CoreWorker | undefined;
beforeEach(() => {
  tmp = shortTmp("hlw-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.HOUGE_TELEGRAM_CHAT_ID = "";
  store = RunStore.openInMemory();
});
afterEach(async () => { await worker?.shutdownPlanners(); worker = undefined; store.close(); tmp.cleanup(); delete process.env.HOUGE_TOMBSTONE_PATH; delete process.env.HOUGE_TELEGRAM_CHAT_ID; });

const HIT = { title: "BOM", url: "https://www.bom.gov.au/nsw/sydney", content: "Tomorrow: sunny." };
const read = (answer: string | null): StrictRead => ({ ok: true, extraction: { summary: "s", facts: ["f"], time_claims: [], answer_to_objective: answer, contains_instructions: false }, digest: "d" });

describe("production wiring: CoreWorker.lookupLaneDeps passes its recorder to the lookup lane", () => {
  it("a rewritten short follow-up with a thin read writes lookup.rewrite rewrite/rewritten and lookup.thin fetch/thin on the run (P14-9)", async () => {
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "short?");
    createTelegramTurn(store, "earlier question", new Date(Date.now() - 5 * 60_000).toISOString());
    const state: OmpTurnState = { threadCutAt: new Date().toISOString(), turnCtx: { sourceUrls: [] } as unknown as OmpTurnState["turnCtx"], anchor: { priorAnswer: "", defaultScope: "chat" } };
    let reads = 0;
    const d: LookupLaneDeps = {
      ...worker.lookupLaneDepsForTest(run, "555", state),
      search: async (): Promise<ToolAdapterResult> => ({ ok: true, output: { query: "q", provider: "tavily", results: [HIT] } }),
      fetch: async (): Promise<ToolAdapterResult> => ({ ok: true, output: { url: HIT.url, status: 200, bytes: 10, content: "page" } }),
      read: async () => read(reads++ === 0 ? null : "Sunny"),
      rewrite: async (): Promise<LlmResult> => ({ ok: true, provider: "kimi-code", model: "k3", answer: "Sydney weather tomorrow" })
    };
    const input: LaneInput = { run_id: run, chat_id: "555", userText: "short?", recentTurns: [], turnChars: 400, quoted: null, effort: "low", verdict_id: "jv_1", note: null,
      signal: new AbortController().signal, deadlineAt: Date.now() + LOOKUP_BUDGET_MS };
    await runLookupLane(input, d);
    expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "lookup.rewrite" || r.entry_id === "lookup.thin").map((r) => [r.entry_id, r.verdict, r.reason_code]))
      .toEqual([["lookup.rewrite", "rewrite", "rewritten"], ["lookup.thin", "fetch", "thin"]]);
  });
});
