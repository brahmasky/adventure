import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { FAKE_OMP_BIN, pinEnabledFlags, pinOmpEnv, shortTmp, tmpOmpDist } from "../helpers/omp-env.js";
import { bridgeTurn } from "../helpers/omp-worker.js";

// Ruling 9 / D10: the quarantined reader is built with the calling turn's CURRENT planner family,
// so a read that lands on the planner's own family still answers but is audited as a collapse
// (family_collapse on the llm_attempt row + a wall_collapse ledger event). Production seats: no
// injected LLM — the reader is a real spawnOneShot against tests/fixtures/fake-omp.mjs.
pinOmpEnv();
pinEnabledFlags();
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => { tmp = shortTmp("hrf-"); store = RunStore.openInMemory(); });
afterEach(() => { store.close(); tmp.cleanup(); });

const EXTRACTION = JSON.stringify({ summary: "ASML beat estimates", facts: [], time_claims: [], answer_to_objective: null, contains_instructions: false });

function useFake(reader: string): void {
  writeFileSync(join(tmp.dir, "s.json"), JSON.stringify({ "*": { text: EXTRACTION } }));
  process.env.HOUGE_OMP_BIN = FAKE_OMP_BIN;
  process.env.HOUGE_OMP_SANDBOX = "0";
  process.env.HOUGE_OMP_ENV_PASSTHROUGH = "FAKE_OMP_SCENARIO";
  process.env.FAKE_OMP_SCENARIO = join(tmp.dir, "s.json");
  process.env.HOUGE_OMP_READER = reader;
}

async function readOnce(): Promise<string> {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "ASML news", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "t:rf", source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error("intake failed");
  const web = async (): Promise<ToolAdapterResult> => ({ ok: true, output: { provider: "fake", results: [{ title: "t", url: "https://a.example/", snippet: "raw" }] } });
  const worker = new CoreWorker(store, join(tmp.dir, "project"), undefined, web, undefined, undefined, undefined, undefined, undefined, async () => null,
    undefined, undefined, { dataDir: tmp.dir, distDir: tmpOmpDist(tmp.dir) });
  // The chat's supervisor exists once its first turn is submitted; create it without starting a child.
  (worker as unknown as { supervisorFor(chat: string): unknown }).supervisorFor("555");
  const r = await bridgeTurn(store, worker, intake.run_id, tmp.dir).call("web_search", { query: "ASML" });
  expect(r.content).toContain("ASML beat estimates");
  return intake.run_id;
}

describe("the reader seat knows the planner's family (D10 audited degradation)", () => {
  it("a reader on the planner's family (claude) answers, and records family_collapse + wall_collapse", async () => {
    useFake("anthropic/claude-opus-5-5:low");
    const run_id = await readOnce();
    const events = store.getLedgerEvents(run_id);
    expect(events.find((e) => e.event_type === "llm_attempt" && e.payload.role === "reader")?.payload).toMatchObject({ family: "claude", family_collapse: true });
    expect(events.filter((e) => e.event_type === "wall_collapse")).toHaveLength(1);
  });

  it("the default cross-family reader (gemini) records no collapse", async () => {
    useFake("google-antigravity/gemini-3.8-flash:low");
    const run_id = await readOnce();
    const events = store.getLedgerEvents(run_id);
    expect(events.find((e) => e.event_type === "llm_attempt" && e.payload.role === "reader")?.payload).toMatchObject({ family: "gemini" });
    expect(events.find((e) => e.event_type === "llm_attempt")?.payload.family_collapse).toBeUndefined();
    expect(events.filter((e) => e.event_type === "wall_collapse")).toEqual([]);
  });
});
