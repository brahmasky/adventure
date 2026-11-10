import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OMP_LOOP_TOOL_META } from "../../src/core/omp-turn-wiring.js";
import { compileTaskContract } from "../../src/contracts/task-contract.js";
import { TurnTrust } from "../../src/decisions/trust.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import type { TurnContextDeps } from "../../src/omp/turn-context.js";
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
/** The grow zone lives in its own root: inside the worker's data dir the resolver refuses the override and falls back to the REAL home zone. */
let growRoot: { dir: string; cleanup: () => void };
let errLog: ReturnType<typeof vi.spyOn>;
let store: RunStore;
beforeEach(() => {
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = shortTmp("hgw-");
  growRoot = shortTmp("hgz-");
  errLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.HOUGE_PARK_MARKER_PATH = join(tmp.dir, "houge.parked");
  process.env.HOUGE_DISARM_PATH = join(tmp.dir, "houge.disarm");
  process.env.HOUGE_GROW_DIR = join(growRoot.dir, "grow"); // a git repo per test, outside the data dir
  process.env.HOUGE_TRUST_ASK_TTL_MS = "50";
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
  tmp.cleanup();
  growRoot.cleanup();
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
    expect(JSON.stringify(errLog.mock.calls)).not.toContain("ZEBRA-QUILL-7731");
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
  it("on a worker whose zone was never ensured, a held service lock answers REFUSED busy at once (ensureZone does not wait)", async () => {
    const t = turn();
    const svc = t.worker.growService();
    let release!: () => void;
    const held = svc.withLockWait(() => new Promise<void>((res) => { release = res; }));
    try {
      const r = await Promise.race([t.call("grow_submit", SUBMIT), new Promise<null>((res) => setTimeout(() => res(null), 1500))]);
      expect(r).not.toBeNull();
      expect(r?.content).toContain("REFUSED busy");
      expect(store.listGrowStaged("staged")).toEqual([]);
    } finally { release(); await held; }
  });
  it("a zone whose repository config is not canonical answers REFUSED zone_unavailable (not busy)", async () => {
    expect(await turn().worker.growService().ensureZone()).toBe(true);
    writeFileSync(join(process.env.HOUGE_GROW_DIR as string, ".git", "config"), "[core]\n\thooksPath = /tmp/x\n");
    const t = turn();
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.content).toContain("REFUSED zone_unavailable");
    expect(store.listGrowStaged("staged")).toEqual([]);
  });
  it("a disarmed door (HOUGE_GROW_ENABLED=false) answers grow_disabled without touching a broken zone, and pages nobody", async () => {
    expect(await turn().worker.growService().ensureZone()).toBe(true);
    writeFileSync(join(process.env.HOUGE_GROW_DIR as string, ".git", "config"), "[core]\n\thooksPath = /tmp/x\n");
    process.env.HOUGE_GROW_ENABLED = "false";
    const r = await turn().call("grow_submit", SUBMIT);
    expect(r.content).toContain("REFUSED grow_disabled");
    expect(store.listOpenIncidents().filter((i) => i.kind === "grow_zone_unavailable")).toEqual([]);
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
  it("a failed review of a CLEAN-born name is not tainted: reading it leaves the turn clean", async () => {
    const t = turn();
    await t.call("grow_submit", SUBMIT);
    const row = store.listGrowStaged("staged")[0];
    if (!row) throw new Error("not staged");
    t.worker.growService().recordReview(row.id, { ...PASS, pass: false, code: "review_failed", findings: [{ step: "2", problem: "vague" }] });
    const reader = turn({ worker: t.worker });
    const r = await reader.call("grow_read", { name: "web-notes", what: "review" });
    expect(r.content).toContain("vague");
    expect(reader.trust.level()).toBe("clean");
  });
  it("an unknown skill answers REFUSED unknown_skill and does not raise the turn", async () => {
    const t = turn();
    const r = await t.call("grow_read", { name: "nope" });
    expect(r.content).toContain("REFUSED unknown_skill");
    expect(t.trust.level()).toBe("clean");
  });
});

describe("the single writer (spec: one process writes the zone)", () => {
  it("a worker that is not the daemon refuses grow_submit, creates no zone, and still reads", async () => {
    const worker = ompWorker(store, tmp.dir, { project: join(tmp.dir, "project"), growWriter: false });
    const t = turn({ worker });
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.content).toContain("REFUSED not_the_daemon");
    expect(existsSync(process.env.HOUGE_GROW_DIR as string)).toBe(false);
    expect(store.listGrowStaged("staged")).toEqual([]);
    expect((await t.call("grow_read", { name: "web-notes" })).content).toContain("REFUSED unknown_skill");
  });
  it("no process but the daemon asks for the writer role", () => {
    const hits = execFileSync("grep", ["-rln", "growWriter", "src", "scripts"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(hits).toEqual(["scripts/live-gate-grow.mjs", "scripts/live-gate-omp.mjs", "src/core/core-worker.ts", "src/telegram/telegram-daemon.ts"]);
  });
});

describe("the service and the sandbox share one directory", () => {
  it("growService().zone.dir equals the grow field of the sandbox path context", () => {
    const worker = ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") });
    expect(worker.growService().zone.dir).toBe(resolve(process.env.HOUGE_GROW_DIR as string)); // the override was accepted, not the home fallback
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

describe("the grow reads in the omp turn context", () => {
  const ctxFor = (dir: string) => (turn().worker as unknown as { ompTurnContext(d: string): TurnContextDeps }).ompTurnContext(dir);
  function seedLiveItemAndOutcome(): void {
    const at = "2026-11-10T10:00:00.000Z";
    store.upsertGrowItem({ name: "unit-convert", state: "live", origin: "clean", description: "converting recipe amounts", example: "convert 2 cups", head_commit: null, content_hash: "h", body_hash: "b" }, at);
    store.appendGrowEvent({ at, run_id: null, chat_id: "555", name: "-", action: "hint", result: "ok", code: "recipe", reviewer_model: null, commit_id: null });
  }

  it("HOUGE_SKILLS_ENABLED=false: no index and no notes, with the same store that yields both when the flag is on", () => {
    seedLiveItemAndOutcome();
    process.env.HOUGE_SKILLS_ENABLED = "true";
    const on = ctxFor(tmp.dir);
    expect(on.growIndex!()).toContain("- unit-convert");
    expect(on.growNotes!("555", "r1").join("\n")).toContain("recipe");
    process.env.HOUGE_SKILLS_ENABLED = "false";
    const off = ctxFor(tmp.dir);
    expect(off.growIndex!()).toBeUndefined();
    expect(off.growNotes!("555", "r2")).toEqual([]);
  });

  it("a store that throws on the grow read gives no index and no notes, and the turn context does not throw", () => {
    process.env.HOUGE_SKILLS_ENABLED = "true";
    const c = ctxFor(tmp.dir);
    vi.spyOn(store, "listGrowItems").mockImplementation(() => { throw new Error("db gone"); });
    vi.spyOn(store, "listGrowEvents").mockImplementation(() => { throw new Error("db gone"); });
    expect(c.growIndex!()).toBeUndefined();
    expect(c.growNotes!("555", "r1")).toEqual([]);
    expect(JSON.stringify(errLog.mock.calls)).toContain("[grow] index unavailable");
    expect(JSON.stringify(errLog.mock.calls)).not.toContain("db gone");
  });
});
