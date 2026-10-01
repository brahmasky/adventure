import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURN_ACTIONS } from "../../src/contracts/task-contract.js";
import { OMP_LOOP_TOOL_META } from "../../src/core/omp-turn-wiring.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { createBridgeHandler } from "../../src/omp/bridge-handler.js";
import { UNTRUSTED_READ_ENTRIES } from "../../src/omp/external-read.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { loadToolDeclarations, TOOL_DECLS_DIR, type ToolDeclaration } from "../../src/omp/tool-decls.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

// houge_status over the real bridge path (bridge `call` → policy → budget → buildOmpTools → loopToolExecute):
// read-only, always armed, never quarantined, one budget unit, plain code-rendered text back to the planner.

pinOmpEnv();
pinEnabledFlags();
const PINNED = ["HOUGE_TOMBSTONE_PATH", "HOUGE_PARK_MARKER_PATH", "HOUGE_DISARM_PATH", "HOUGE_TIMEZONE", "HOUGE_STATUS_CANARY"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => {
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = shortTmp("hhs-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.HOUGE_PARK_MARKER_PATH = join(tmp.dir, "houge.parked");
  process.env.HOUGE_DISARM_PATH = join(tmp.dir, "houge.disarm");
  process.env.HOUGE_STATUS_CANARY = "canary-secret-7Qx9";
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
  tmp.cleanup();
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function turn() {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "你重启了吗？现在跑的是哪个版本？", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "t:status", source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error("intake failed");
  return { run_id: intake.run_id, ...bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }), intake.run_id, tmp.dir) };
}

describe("houge_status over the bridge", () => {
  it("returns the code-rendered status as plain text: no quarantine, no approval, one budget unit", async () => {
    store.recordDaemonBoot({
      boot_id: "boot_1", started_at: "2026-10-02T07:34:00.000Z", pid: process.pid, reason: "self_write_reload",
      reload_sha: "4431d13aaaa", reload_subject: "s", reload_branch: "houge/selfwrite/run_a", reload_merged_at: "2026-10-02T07:33:00.000Z",
      head_sha: "4431d13aaaa", head_subject: "s", head_committed_at: "2026-10-02T07:33:00.000Z", dist_built_at: "2026-10-02T07:33:30.000Z"
    });
    const t = turn();
    const quarantine = vi.fn(t.turn.quarantine);
    t.turn.quarantine = quarantine;
    const r = await t.call("houge_status", {});
    expect(r.isError).toBe(false);
    expect(r.content.startsWith("Daemon: pid ")).toBe(true);
    expect(r.content).toContain("Boot reason: self_write_reload 4431d13");
    expect(r.content).not.toContain("canary-secret-7Qx9");
    expect(quarantine).not.toHaveBeenCalled();
    expect(t.turn.budget.usage().tool_calls).toBe(1);
    const events = store.getLedgerEvents(t.run_id);
    expect(events.filter((e) => e.event_type === "approval_requested")).toEqual([]);
    expect(events.find((e) => e.event_type === "tool_finished")?.payload).toMatchObject({ tool: "houge_status", status: "succeeded" });
  });

  it("is registered side-effect none, and is not a read tool that crosses the wall", () => {
    expect(OMP_LOOP_TOOL_META.houge_status?.side_effect_level).toBe("none");
    expect(UNTRUSTED_READ_ENTRIES.has("houge_status")).toBe(false);
    expect(turn().turn.registry.get("houge_status")?.side_effect_level).toBe("none");
  });

  it("is in the planner's manifest with no flag set", async () => {
    const decls = loadToolDeclarations(TOOL_DECLS_DIR);
    if (!decls.ok) throw new Error(decls.error);
    const handle = createBridgeHandler({
      store, cfg: resolveOmpConfig({}), ctx: { home: tmp.dir, repo: tmp.dir, data: tmp.dir }, decls: decls.decls, env: {},
      turnEnvelopeActions: [...TURN_ACTIONS], activeTurn: () => null
    });
    const names = ((await handle({ id: "m", kind: "manifest" })) as ToolDeclaration[]).map((d) => d.name);
    expect(names).toContain("houge_status");
  });
});
