import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

pinOmpEnv();
pinEnabledFlags();
let tmp: ReturnType<typeof shortTmp>;
let store: RunStore;

beforeEach(() => {
  tmp = shortTmp("hmcp-");
  store = RunStore.openInMemory();
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
});
afterEach(() => {
  store.close();
  tmp.cleanup();
  delete process.env.HOUGE_TOMBSTONE_PATH;
});

describe("memory.correct_preflight through CoreWorker.memoryDeps", () => {
  it("a correction naming an id the run never saw is refused and recorded as one refuse/not_offered row on the run", async () => {
    // Why it matters: CoreWorker.memoryDeps is the only place the worker hands the decision recorder to the memory tools; dropping it silently loses the row.
    const intake = new Gateway(store).intake(buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: "memory correct preflight",
      requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: "mcp-recorder-1", source_reference: "telegram:update:1:message:1"
    } as never));
    if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
    const { call } = bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }), intake.run_id, tmp.dir);
    const res = await call("memory_correct", { action: "retire", ids: [2_000_000_001] });
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/^not_offered/);
    const rows = store.listDecisionsForRun(intake.run_id).filter((d) => d.entry_id === "memory.correct_preflight");
    expect(rows.map((d) => [d.verdict, d.reason_code])).toEqual([["refuse", "not_offered"]]);
  });
});
