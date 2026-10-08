import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { fixtureCatalog, pinnedRoles } from "../helpers/model-roles.js";
import { FAKE_OMP_BIN, pinEnabledFlags, pinOmpEnv, shortTmp, tmpOmpDist } from "../helpers/omp-env.js";
import { bridgeTurn } from "../helpers/omp-worker.js";

// Ruling 9 / D10, a skip rule since the Jev tree (spec 2026-10-06 §8). The quarantined reader is built with the calling
// turn's CURRENT planner family. The reader's candidates of another family run first. Only when every candidate shares
// the planner's family does the read proceed, audited as a collapse (family_collapse plus a wall_collapse event).
// Production seats: no injected LLM. The reader is a real spawnOneShot against tests/fixtures/fake-omp.mjs, on the
// chains the worker's RoleResolver hands it.
pinOmpEnv();
pinEnabledFlags();
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => { tmp = shortTmp("hrf-"); store = RunStore.openInMemory(); });
afterEach(() => { store.close(); tmp.cleanup(); });

const EXTRACTION = JSON.stringify({ summary: "ASML beat estimates", facts: [], time_claims: [], answer_to_objective: null, contains_instructions: false });

function useFake(): void {
  writeFileSync(join(tmp.dir, "s.json"), JSON.stringify({ "*": { text: EXTRACTION } }));
  process.env.HOUGE_OMP_BIN = FAKE_OMP_BIN;
  process.env.HOUGE_OMP_SANDBOX = "0";
  process.env.HOUGE_OMP_ENV_PASSTHROUGH = "FAKE_OMP_SCENARIO";
  process.env.FAKE_OMP_SCENARIO = join(tmp.dir, "s.json");
}

async function readOnce(roles?: RoleResolver): Promise<string> {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "ASML news", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "t:rf", source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error("intake failed");
  const web = async (): Promise<ToolAdapterResult> => ({ ok: true, output: { provider: "fake", results: [{ title: "t", url: "https://a.example/", snippet: "raw" }] } });
  const worker = new CoreWorker(store, join(tmp.dir, "project"), undefined, web, undefined, undefined, undefined, undefined, undefined, async () => null,
    undefined, undefined, { dataDir: tmp.dir, distDir: tmpOmpDist(tmp.dir), ...(roles ? { roles } : {}) });
  // The chat's supervisor exists once its first turn is submitted; create it without starting a child.
  (worker as unknown as { supervisorFor(chat: string): unknown }).supervisorFor("555");
  const r = await bridgeTurn(store, worker, intake.run_id, tmp.dir).call("web_search", { query: "ASML" });
  expect(r.content).toContain("ASML beat estimates");
  return intake.run_id;
}

const readerRow = (run_id: string) => store.getLedgerEvents(run_id).find((e) => e.event_type === "llm_attempt" && e.payload.role === "reader")?.payload;
const collapses = (run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "wall_collapse");

describe("the reader seat knows the planner's family (D10 skip rule, audited degradation)", () => {
  it("every reader candidate on the planner's family (claude): the read answers, recording family_collapse + wall_collapse", async () => {
    useFake();
    // A one-model catalog: Default resolves to Opus (planner family claude) and the reader override leaves only Opus.
    const roles = await pinnedRoles(store, fixtureCatalog().filter((m) => m.provider === "anthropic" && m.id === "claude-opus-5-5"), { reader: "claude-opus-5-5" });
    const run_id = await readOnce(roles);
    expect(readerRow(run_id)).toMatchObject({ family: "claude", family_collapse: true });
    expect(collapses(run_id)).toHaveLength(1);
  });

  it("a reader chain that starts on the planner's family runs its first cross-family candidate first: no collapse", async () => {
    useFake();
    // The full catalog: the override puts Opus first (claude, the planner's family), then the list (gemini, k3, gpt).
    const roles = await pinnedRoles(store, fixtureCatalog(), { reader: "anthropic/claude-opus-5-5" });
    expect(roles.chains().reader[0]?.model).toBe("claude-opus-5-5");
    const run_id = await readOnce(roles);
    expect(readerRow(run_id)).toMatchObject({ family: "gemini" });
    expect(readerRow(run_id)?.family_collapse).toBeUndefined();
    expect(collapses(run_id)).toEqual([]);
  });

  it("the default reader list (gemini first, no catalog read) records no collapse", async () => {
    useFake();
    const run_id = await readOnce();
    expect(readerRow(run_id)).toMatchObject({ family: "gemini" });
    expect(readerRow(run_id)?.family_collapse).toBeUndefined();
    expect(collapses(run_id)).toEqual([]);
  });
});
