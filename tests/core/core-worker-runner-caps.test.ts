import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RUNNER_TIMEOUT_BUFFER_MS, seatBudgetMs } from "../../src/llm/registry.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore, type LlmCallRole } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

// M3: a loop tool's runner cap is the budget of the seat chains it actually calls — never the
// planner's 3-leg "answer" budget for everything (a 1-leg ticks call must not get a 6-minute cap,
// and a pure-compute tool needs no LLM budget at all).
pinOmpEnv();
pinEnabledFlags();
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
/** The worker's seats run on its RoleResolver's chains (model roles), so the expected budgets read the same chains. */
let roles: RoleResolver;
beforeEach(() => {
  tmp = shortTmp("hrc-"); store = RunStore.openInMemory();
  roles = new RoleResolver({ store, env: () => ({}), readCatalog: async () => null });
});
afterEach(() => { store.close(); tmp.cleanup(); delete process.env.HOUGE_WIKI_VERIFY_PASSES; });

function caps(): (tool: string) => number | undefined {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "hi", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "t:caps", source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error("intake failed");
  const t = bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project"), roles }), intake.run_id, tmp.dir);
  return (tool) => t.turn.registry.get(tool)?.timeout_ms;
}
const seat = (role: LlmCallRole) => seatBudgetMs(resolveOmpConfig(process.env, roles.chains()), role) + RUNNER_TIMEOUT_BUFFER_MS;

describe("runner caps follow the called seat's chain (M3)", () => {
  it("to_local_time (pure compute) gets the runner buffer, not an LLM chain budget", () => {
    expect(caps()("to_local_time")).toBe(RUNNER_TIMEOUT_BUFFER_MS);
  });

  it("wiki_build = one synthesis (answer) + the verify ensemble on the READER chain", () => {
    process.env.HOUGE_WIKI_VERIFY_PASSES = "2";
    expect(caps()("wiki_build")).toBe(seat("answer") + seat("reader") * 2 * 2);
  });

  it("lesson_write = its distill seat + its reconcile seat", () => {
    expect(caps()("lesson_write")).toBe(seat("distill") + seat("consolidate"));
  });
});
