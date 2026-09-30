import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { FAKE_OMP_BIN, pinEnabledFlags, pinOmpEnv, shortTmp, tmpOmpDist } from "../helpers/omp-env.js";
import { bridgeTurn } from "../helpers/omp-worker.js";

// Routing ruling (fix round 1, judgement 7): lesson_write's distill and reconcile are memory work on
// the ticks chain (spec §8); /ask stays on the planner chain. Production seats (no injected LLM),
// the fake omp logs which --model each one-shot ran.
pinOmpEnv();
pinEnabledFlags();
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => {
  tmp = shortTmp("hsr-");
  store = RunStore.openInMemory();
  writeFileSync(join(tmp.dir, "s.json"), JSON.stringify({ "*": { text: '{"durable":true,"lesson":"be brief"}' } }));
  Object.assign(process.env, {
    HOUGE_OMP_BIN: FAKE_OMP_BIN, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG",
    FAKE_OMP_SCENARIO: join(tmp.dir, "s.json"), FAKE_OMP_ARGV_LOG: join(tmp.dir, "argv.log")
  });
});
afterEach(() => { store.close(); tmp.cleanup(); });

const models = () => (existsSync(join(tmp.dir, "argv.log")) ? readFileSync(join(tmp.dir, "argv.log"), "utf8").trim().split("\n") : [])
  .map((l) => (JSON.parse(l) as { argv: string[] }).argv).filter((a) => a.includes("--model")).map((a) => a[a.indexOf("--model") + 1]);
const worker = () => new CoreWorker(store, join(tmp.dir, "project"), undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => null,
  undefined, undefined, { dataDir: tmp.dir, distDir: tmpOmpDist(tmp.dir) });

function intake(type: "turn" | "ask", goal: string): string {
  const r = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type, program: type, goal, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `r:${type}`, source_reference: "telegram:update:1:message:1"
  }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}

describe("which chain each internal call rides", () => {
  it("lesson_write's distill (and reconcile) run on the ticks chain (kimi-code/k3), never the planner", async () => {
    const run = intake("turn", "以后回答简洁一点");
    await bridgeTurn(store, worker(), run, tmp.dir).call("lesson_write", {});
    expect(models().length).toBeGreaterThan(0);
    expect(new Set(models())).toEqual(new Set(["kimi-code/k3"]));
    const roles = store.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload.role);
    expect(roles[0]).toBe("distill");
  });

  it("/ask stays on the planner chain (claude first)", async () => {
    const run = intake("ask", "what next?");
    await worker().executeRun(run, "w");
    expect(models()[0]).toBe("anthropic/claude-opus-5-5");
  });
});
