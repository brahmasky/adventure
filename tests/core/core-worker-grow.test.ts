import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OMP_LOOP_TOOL_META } from "../../src/core/omp-turn-wiring.js";
import { compileTaskContract } from "../../src/contracts/task-contract.js";
import { TurnTrust } from "../../src/decisions/trust.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { isToolArmed } from "../../src/omp/tool-arming.js";
import { RunStore } from "../../src/run/run-store.js";
import { telegramTurnEvent } from "../helpers/events.js";
import { growBody, PASS } from "../helpers/grow.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

// Unit 8c: grow_submit / grow_read over the real bridge path (bridge call -> policy -> buildOmpTools -> ompLoopExecute -> GrowService).
// The service answers, the worker only wires: level read at execute time, the same directory as the sandbox, the body in no log or ledger row.

pinOmpEnv();
pinEnabledFlags();
const PINNED = ["HOUGE_TOMBSTONE_PATH", "HOUGE_PARK_MARKER_PATH", "HOUGE_DISARM_PATH", "HOUGE_GROW_DIR", "HOUGE_SKILLS_ENABLED", "HOUGE_GROW_ENABLED"] as const;
const BODY_LINE = "ZEBRA-QUILL-7731 rinse the filter twice";
const SUBMIT = { name: "web-notes", description: "taking structured notes on a web page the user shares", example: "summarise this page for me", body: `${growBody(20)}\n${BODY_LINE}` };
const saved: Record<string, string | undefined> = {};
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => {
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = shortTmp("hgw-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.HOUGE_PARK_MARKER_PATH = join(tmp.dir, "houge.parked");
  process.env.HOUGE_DISARM_PATH = join(tmp.dir, "houge.disarm");
  process.env.HOUGE_GROW_DIR = join(tmp.dir, "grow"); // a git repo per test: the file-level pin would share one across tests
  process.env.HOUGE_TRUST_ASK_TTL_MS = "50";
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
  tmp.cleanup();
  vi.restoreAllMocks();
  delete process.env.HOUGE_TRUST_ASK_TTL_MS;
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

let seq = 0;
function intake(): string {
  const r = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "remember how to summarise this page", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `t:growwire:${++seq}`, source_reference: `telegram:update:${seq}:message:1`
  }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}
/** A bridge turn with a real TurnTrust (as the supervisor builds it). */
function turn(over: { worker?: ReturnType<typeof ompWorker> } = {}) {
  const run_id = intake();
  const worker = over.worker ?? ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") });
  const t = bridgeTurn(store, worker, run_id, tmp.dir);
  const trust = new TurnTrust({ store, run_id, chat_id: "555", born: "telegram", env: process.env });
  Object.assign(t.turn, { trust });
  const cards = () => store.getLedgerEvents(run_id).filter((e) => e.event_type === "approval_requested");
  return { ...t, run_id, trust, worker, cards };
}
const rows = (run_id: string, type: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === type);

describe("grow_submit over the bridge", () => {
  it("stages a valid new skill, answers STAGED, and leaves no part of the body in the run's ledger", async () => {
    const t = turn();
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^STAGED:/);
    expect(store.listGrowStaged("staged").map((x) => x.name)).toEqual(["web-notes"]);
    expect(JSON.stringify(store.getLedgerEvents(t.run_id))).not.toContain("ZEBRA-QUILL-7731");
    expect(t.cards()).toEqual([]);
  });
  it("an untrusted turn submits with no approval card and the staged row is born untrusted", async () => {
    const t = turn();
    t.trust.raise("wall_read");
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.content.startsWith("STAGED:")).toBe(true);
    expect(t.cards()).toEqual([]);
    expect(store.listGrowStaged("staged")[0]?.origin).toBe("untrusted");
  });
  it("I-2: the level is read at execute time: untrusted at the preflight, hostile afterwards, is refused by the service and stages nothing", async () => {
    const run_id = intake();
    const worker = ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") });
    const claim = store.claimRun(run_id, `planner:test:${run_id}`, 120);
    if (!claim) throw new Error("claim failed");
    const tools = worker.buildOmpTools(claim);
    let asked = 0;
    tools.bindTrust(() => (++asked === 1 ? "untrusted" : "hostile"));
    expect(tools.preflight("grow_submit", SUBMIT)).toBeNull();
    const r = await tools.registry.get("grow_submit")?.execute?.(SUBMIT);
    expect(JSON.stringify(r)).toContain("REFUSED turn_hostile");
    expect(store.listGrowStaged("staged")).toEqual([]);
  });
  it("while another holder has the service lock it answers REFUSED busy and does not wait", async () => {
    const t = turn();
    const svc = t.worker.growService();
    expect(await svc.ensureZone()).toBe(true);
    let release!: () => void;
    const held = svc.withLockWait(() => new Promise<void>((res) => { release = res; }));
    try {
      const r = await Promise.race([t.call("grow_submit", SUBMIT), new Promise<null>((res) => setTimeout(() => res(null), 3000))]);
      expect(r).not.toBeNull();
      expect(r?.content).toContain("REFUSED busy");
      expect(store.listGrowStaged("staged")).toEqual([]);
    } finally { release(); await held; }
  });
  it("HOUGE_GROW_ENABLED=false refuses a submit (grow_disabled) while grow_read still works", async () => {
    const t = turn();
    process.env.HOUGE_GROW_ENABLED = "false";
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.content).toContain("REFUSED grow_disabled");
    expect(store.listGrowStaged("staged")).toEqual([]);
    const read = await t.call("grow_read", { name: "web-notes" });
    expect(read.isError).toBe(false);
    expect(read.content).toContain("REFUSED unknown_skill");
  });
  it("HOUGE_SKILLS_ENABLED=false (the /disarm posture): neither tool is armed", async () => {
    process.env.HOUGE_SKILLS_ENABLED = "false";
    expect(isToolArmed("grow_submit", process.env)).toBe(false);
    expect(isToolArmed("grow_read", process.env)).toBe(false);
    const t = turn();
    expect((await t.call("grow_submit", SUBMIT)).isError).toBe(true);
    expect(store.listGrowStaged("staged")).toEqual([]);
  });
});

/** Publish a skill through the worker's own service so grow_read has something to read. */
async function publish(t: ReturnType<typeof turn>, name: string, level: "clean" | "untrusted"): Promise<void> {
  const svc = t.worker.growService();
  expect(await svc.ensureZone()).toBe(true);
  await svc.submit({ ...SUBMIT, name }, { run_id: t.run_id, chat_id: "555", level });
  const row = store.listGrowStaged("staged").find((r) => r.name === name);
  if (!row) throw new Error("not staged");
  svc.recordReview(row.id, PASS);
  await svc.publishStaged(row.id);
  if (store.getGrowItem(name)?.state !== "live") throw new Error("not live");
}

describe("grow_read over the bridge", () => {
  it("returns a clean skill as plain text; the quarantine is never called and the turn stays clean", async () => {
    const t = turn();
    await publish(t, "web-notes", "clean");
    const quarantine = vi.fn(t.turn.quarantine);
    t.turn.quarantine = quarantine;
    const r = await t.call("grow_read", { name: "web-notes" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain(BODY_LINE);
    expect(r.content.startsWith("# web-notes")).toBe(true);
    expect(quarantine).not.toHaveBeenCalled();
    expect(t.trust.level()).toBe("clean");
  });
  it("a skill born from an untrusted turn raises the reading turn to untrusted (cause grow_read_untrusted)", async () => {
    const t = turn();
    await publish(t, "web-notes", "untrusted");
    const reader = turn({ worker: t.worker });
    const r = await reader.call("grow_read", { name: "web-notes" });
    expect(r.content).toContain(BODY_LINE);
    expect(reader.trust.level()).toBe("untrusted");
    expect(rows(reader.run_id, "turn_trust").map((e) => (e.payload as { cause?: string }).cause)).toContain("grow_read_untrusted");
  });
  it("a failed review of a marked name is tainted the same way; of a clean name it is not", async () => {
    const t = turn();
    t.trust.raise("wall_read");
    await t.call("grow_submit", SUBMIT);
    const row = store.listGrowStaged("staged")[0];
    if (!row) throw new Error("not staged");
    const svc = t.worker.growService();
    svc.recordReview(row.id, { ...PASS, pass: false, code: "review_failed", findings: [{ step: "2", problem: "vague" }] });
    const reader = turn({ worker: t.worker });
    const r = await reader.call("grow_read", { name: "web-notes", what: "review" });
    expect(r.content).toContain("vague");
    expect(reader.trust.level()).toBe("untrusted");
    expect(rows(reader.run_id, "turn_trust").map((e) => (e.payload as { cause?: string }).cause)).toContain("grow_read_untrusted");
    const none = await turn({ worker: t.worker }).call("grow_read", { name: "other", what: "review" });
    expect(none.content).toBe("No failed review is stored for other.");
  });
  it("an unknown skill answers REFUSED unknown_skill and does not raise the turn", async () => {
    const t = turn();
    const r = await t.call("grow_read", { name: "nope" });
    expect(r.content).toContain("REFUSED unknown_skill");
    expect(t.trust.level()).toBe("clean");
  });
});

describe("the service and the sandbox share one directory", () => {
  it("growService().zone.dir equals the grow field of the sandbox path context", () => {
    const worker = ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") });
    expect(worker.growService().zone.dir).toBe(worker.ompProbeContext().ctx.grow);
    expect(worker.growService()).toBe(worker.growService());
  });
});

describe("tool meta", () => {
  it("grow_submit and grow_read are side_effect_level none, which no turn contract gates", () => {
    expect(OMP_LOOP_TOOL_META.grow_submit?.side_effect_level).toBe("none");
    expect(OMP_LOOP_TOOL_META.grow_read?.side_effect_level).toBe("none");
    const c = compileTaskContract(telegramTurnEvent());
    if (!c.ok) throw new Error("compile failed");
    expect(c.contract.approval_gates as string[]).not.toContain("none");
  });
});
