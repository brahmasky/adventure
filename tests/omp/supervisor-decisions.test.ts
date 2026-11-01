import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import type { RunStore } from "../../src/run/run-store.js";
import { steerOrQueueInput, type SupervisorState, type TurnRequest } from "../../src/omp/planner-supervisor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { cleanups, fakeSession, harness, heldSession, req, until, untilState } from "../helpers/supervisor-harness.js";

afterEach(async () => { for (const c of cleanups.splice(0)) await c(); vi.restoreAllMocks(); });

type Row = [string, string, string | null, string, string | null];
function rows(store: RunStore): Row[] {
  return ((store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db.prepare("SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id IN ('intake.bare_ack','intake.steer_or_queue') ORDER BY rowid").all() as Array<Record<string, string | null>>)
    .map((r) => [r.entry_id as string, r.verdict as string, r.reason_code ?? null, r.run_id as string, r.tool_call_id ?? null]);
}
/** The recorder needs the store `harness` builds: resolve it lazily. */
function withRecorder(session: ReturnType<typeof fakeSession>, extra: Parameters<typeof harness>[2] = {}) {
  const cell: { store?: RunStore; counts: string[] } = { counts: [] };
  const recorder: DecisionRecorder = { record: (e, r, c) => { cell.counts.push(e.id); return storeRecorder(cell.store as RunStore).record(e, r, c); } };
  const h = harness(session, {}, { recorder, ...extra }); cell.store = h.store;
  return { ...h, counts: cell.counts };
}
type Q = { prepare(q: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
const q = (store: RunStore) => (store as unknown as { db: Q }).db;
const outboxN = (store: RunStore) => q(store).prepare("SELECT COUNT(*) AS n FROM notification_outbox").all()[0]?.n as number;
const incidentsN = (store: RunStore) => q(store).prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind='decision_record_failed' AND state='open'").all()[0]?.n as number;
const dones = (o: { done: unknown[] }) => o.done as Array<{ run_id: string; text: string }>;

describe("R3 rows", () => {
  it("1 idle message: completes, zero rows", async () => {
    const { store, sup, outcome, counts } = withRecorder(fakeSession()); const a = createQueuedTurnRun(store);
    sup.submit(req(a)); await sup.whenIdle();
    expect(dones(outcome)).toHaveLength(1); expect(rows(store)).toEqual([]);
    expect(counts).toEqual(["intake.steer_or_queue"]); // P12: runTurn consults queue/idle; the entry writes no row for it
  });
  it("2 steer in RUNNING", async () => {
    const h = heldSession(); const { store, sup } = withRecorder(h.session);
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    sup.submit(req(a, "first")); await h.live(); sup.submit(req(b, "second"));
    expect(h.session.steers).toEqual(["second"]);
    expect(rows(store)).toEqual([["intake.steer_or_queue", "steer", "live_turn", b, null]]);
    h.end(); await sup.whenIdle();
  });
  it("3 bare ack in AWAITING: nudge row only", async () => {
    const h = heldSession(); const { store, sup, outcome, counts } = withRecorder(h.session);
    const r1 = createQueuedTurnRun(store); sup.submit(req(r1, "go")); await h.live();
    sup.setAwaitingApprovalForTest(true);
    const r2 = createQueuedTurnRun(store, "好"); sup.submit(req(r2, "好"));
    await until(() => dones(outcome).some((d) => d.run_id === r2));
    expect(h.session.steers).toEqual([]); expect(counts).toEqual(["intake.steer_or_queue", "intake.bare_ack"]); // r1's idle consult, then the nudge; none for r2's steer branch
    expect(rows(store)).toEqual([["intake.bare_ack", "nudge", "ack_while_card_waits", r2, null]]);
    expect(dones(outcome).find((d) => d.run_id === r2)?.text).toContain("waiting for your tap");
    expect(store.getLedgerEvents().some((e) => e.event_type === "ack_nudged" && e.payload.approval_run_id === r1)).toBe(true);
    expect(store.getRunState(r2)).toBe("completed");
    sup.setAwaitingApprovalForTest(false); h.end(); await untilState(sup, "IDLE");
  });
  it("4 non-ack while a card waits: steer row, no bare_ack row, pass consulted", async () => {
    const h = heldSession(); const { store, sup, counts } = withRecorder(h.session);
    const r1 = createQueuedTurnRun(store); sup.submit(req(r1, "go")); await h.live();
    sup.setAwaitingApprovalForTest(true);
    const r2 = createQueuedTurnRun(store, "why?"); sup.submit(req(r2, "why?"));
    expect(h.session.steers).toEqual(["why?"]);
    expect(rows(store)).toEqual([["intake.steer_or_queue", "steer", "live_turn", r2, null]]);
    expect(counts).toEqual(["intake.steer_or_queue", "intake.bare_ack", "intake.steer_or_queue"]); // r1 idle queue, then pass, then steer
    sup.setAwaitingApprovalForTest(false); h.end(); await sup.whenIdle();
  });
  it("5 Telegram message during a schedule-born live turn: wait, row written at the claim (after the first turn completes)", async () => {
    const h = heldSession(); const { store, sup, outcome } = withRecorder(h.session);
    const s = createQueuedTurnRun(store); const m = createQueuedTurnRun(store, "later");
    sup.submit({ ...req(s, "brief", "schedule"), goal: "g" }); await h.live(); sup.submit(req(m, "later"));
    expect(h.session.steers).toEqual([]); expect(rows(store)).toEqual([]);
    h.end(); await h.live(2); h.end(); await sup.whenIdle();
    expect(rows(store)).toEqual([["intake.steer_or_queue", "wait", "turn_schedule_born", m, null]]);
    expect(dones(outcome).filter((d) => d.run_id === m)).toHaveLength(1);
  });
  it("6 scheduled message during a live Telegram turn: message_scheduled", async () => {
    const h = heldSession(); const { store, sup } = withRecorder(h.session);
    const a = createQueuedTurnRun(store); const s = createQueuedTurnRun(store);
    sup.submit(req(a, "u")); await h.live(); sup.submit({ ...req(s, "b", "schedule"), goal: "g" });
    h.end(); await h.live(2); h.end(); await sup.whenIdle();
    expect(rows(store)).toEqual([["intake.steer_or_queue", "wait", "message_scheduled", s, null]]);
  });
  it("7 media message during a live turn; and a media ack while a card waits is not nudged", async () => {
    const h = heldSession(); const { store, sup, outcome } = withRecorder(h.session);
    const a = createQueuedTurnRun(store); const p = createQueuedTurnRun(store, "photo"); const qq = createQueuedTurnRun(store, "好");
    sup.submit(req(a, "u")); await h.live();
    sup.submit({ ...req(p, "photo"), needsIngest: true });
    sup.setAwaitingApprovalForTest(true);
    sup.submit({ ...req(qq, "好"), needsIngest: true });
    expect(h.session.steers).toEqual([]);
    sup.setAwaitingApprovalForTest(false);
    h.end(); await h.live(2); h.end(); await h.live(3); h.end(); await sup.whenIdle();
    expect(rows(store)).toEqual([["intake.steer_or_queue", "wait", "needs_ingest", p, null], ["intake.steer_or_queue", "wait", "needs_ingest", qq, null]]);
    expect(dones(outcome).filter((d) => d.text.includes("waiting for your tap"))).toEqual([]); // no nudge reply for either run
  });
  it("8 message while the first turn's start is held: turn_not_live", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const h = heldSession({ start: () => gate }); const { store, sup, outcome } = withRecorder(h.session);
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    sup.submit(req(a, "u")); await untilState(sup, "STARTING");
    sup.submit(req(b, "second"));
    release(); await h.live(); h.end(); await h.live(2); h.end(); await sup.whenIdle();
    expect(rows(store)).toEqual([["intake.steer_or_queue", "wait", "turn_not_live", b, null]]);
    expect(dones(outcome).map((d) => d.run_id).sort()).toEqual([a, b].sort());
  });
  it("8b a bare ack in RUNNING with an open card (approvals > 0, P11) is nudged: one nudge row", async () => {
    const h = heldSession(); const { store, sup, outcome } = withRecorder(h.session);
    const r1 = createQueuedTurnRun(store, "push it"); sup.submit(req(r1, "push it")); await h.live();
    sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: 30 });
    await untilState(sup, "RUNNING"); // the pause ran out; the card is still open
    const r2 = createQueuedTurnRun(store, "好"); sup.submit(req(r2, "好"));
    await until(() => dones(outcome).some((d) => d.run_id === r2));
    expect(h.session.steers).toEqual([]);
    expect(rows(store)).toEqual([["intake.bare_ack", "nudge", "ack_while_card_waits", r2, null]]);
    sup.setAwaitingApprovalForTest(false); h.end(); await untilState(sup, "IDLE");
  });
  it("9 queued_behind: only reachable synchronously from a failure callback fired between claim and this.turn", async () => {
    const h = heldSession(); let n = 0; const ids: string[] = [];
    const { store, sup, outcome } = withRecorder(h.session, { buildTools: () => { if (++n === 2) throw new Error("setup"); return { registry: new ToolRegistry(), quarantine: async () => ({ digest: "", contains_instructions: false, source_meta: { tool: "x", bytes: 0 } }) }; } });
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store); const c = createQueuedTurnRun(store);
    ids.push(a, b, c);
    const orig = outcome.fail; outcome.fail = (i) => { orig(i); if (i.run_id === b) sup.submit(req(c, "third")); };
    sup.submit({ ...req(a, "1", "schedule"), goal: "g" }); sup.submit({ ...req(b, "2", "schedule"), goal: "g" });
    await h.live(); h.end(); await h.live(2); h.end(); await sup.whenIdle();
    expect(rows(store).filter((r) => r[3] === c)).toEqual([["intake.steer_or_queue", "wait", "queued_behind", c, null]]);
  });
  it("10 the same run submitted twice during a live turn: one steer row", async () => {
    const h = heldSession(); const { store, sup } = withRecorder(h.session);
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    sup.submit(req(a, "u")); await h.live(); sup.submit(req(b, "x")); sup.submit(req(b, "x"));
    expect(h.session.steers).toEqual(["x"]);
    expect(rows(store)).toEqual([["intake.steer_or_queue", "steer", "live_turn", b, null]]);
    h.end(); await sup.whenIdle();
  });
  it("11 pre-claimed nudge and pre-claimed steer write no rows", async () => {
    const h = heldSession(); const { store, sup, outcome } = withRecorder(h.session);
    const a = createQueuedTurnRun(store); sup.submit(req(a, "u")); await h.live();
    const s1 = createQueuedTurnRun(store); expect(store.claimRun(s1, "other", 120)).toBeTruthy();
    sup.submit(req(s1, "steer me"));
    sup.setAwaitingApprovalForTest(true);
    const n1 = createQueuedTurnRun(store, "好"); expect(store.claimRun(n1, "other", 120)).toBeTruthy();
    sup.submit(req(n1, "好"));
    expect(rows(store)).toEqual([]); expect(h.session.steers).toEqual([]);
    expect(dones(outcome).some((d) => d.run_id === n1)).toBe(false);
    sup.setAwaitingApprovalForTest(false); h.end(); await sup.whenIdle();
  });
  it("12 a queued request failed by abortAll before it runs writes no row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r3-kill-")); // P2: pin the tombstone paths; nothing may land in the cwd
    vi.stubEnv("HOUGE_TOMBSTONE_PATH", join(dir, "houge.kill")); vi.stubEnv("HOUGE_DISARM_PATH", join(dir, "houge.disarm"));
    const h = heldSession(); const { store, sup } = withRecorder(h.session);
    const a = createQueuedTurnRun(store); const s = createQueuedTurnRun(store);
    sup.submit(req(a, "u")); await h.live(); sup.submit({ ...req(s, "b", "schedule"), goal: "g" });
    await sup.abortAll("killed");
    expect(rows(store)).toEqual([]);
    expect(existsSync(join(process.cwd(), "houge.kill"))).toBe(false); rmSync(dir, { recursive: true, force: true });
  });
  it("13 no recorder: identical behaviour, zero rows", async () => {
    const h = heldSession(); const { store, sup } = harness(h.session);
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    sup.submit(req(a, "u")); await h.live(); sup.submit(req(b, "x"));
    expect(h.session.steers).toEqual(["x"]); expect(rows(store)).toEqual([]);
    h.end(); await sup.whenIdle();
  });
  it("14 insert fault opens one alerted incident; a throwing recorder opens none; the steer is unchanged in both", async () => {
    vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", "stub-chat"); // the alert targets the stub; restored by vi.unstubAllEnvs
    try {
      const h = heldSession(); const w = withRecorder(h.session);
      vi.spyOn(w.store, "insertDecision").mockImplementation(() => { throw new Error("disk"); });
      const a = createQueuedTurnRun(w.store); const b = createQueuedTurnRun(w.store);
      w.sup.submit(req(a, "u")); await h.live();
      const out0 = outboxN(w.store); w.sup.submit(req(b, "x"));
      expect(h.session.steers).toEqual(["x"]);
      expect(incidentsN(w.store)).toBe(1);
      expect(outboxN(w.store) - out0).toBe(1);
      expect(q(w.store).prepare("SELECT target_json FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'").all()).toHaveLength(1);
      h.end(); await w.sup.whenIdle();
      const h2 = heldSession(); const boom: DecisionRecorder = { record: () => { throw new Error("boom"); } };
      const w2 = harness(h2.session, {}, { recorder: boom });
      const c = createQueuedTurnRun(w2.store); const d = createQueuedTurnRun(w2.store);
      w2.sup.submit(req(c, "u")); await h2.live();
      const out1 = outboxN(w2.store); w2.sup.submit(req(d, "y"));
      expect(h2.session.steers).toEqual(["y"]);
      expect(incidentsN(w2.store)).toBe(0);
      expect(outboxN(w2.store) - out1).toBe(0);
      h2.end(); await w2.sup.whenIdle();
    } finally { vi.unstubAllEnvs(); }
  });
  it("15 steerOrQueueInput mirrors the branch", () => {
    const ts = [undefined, { live: false, req: { source: "telegram" as const } }, { live: true, req: { source: "telegram" as const } }, { live: true, req: { source: "schedule" as const } }];
    const sts: SupervisorState[] = ["STARTING", "IDLE", "RUNNING", "AWAITING_APPROVAL", "ABORTING", "STOPPED"];
    for (const t of ts) for (const st of sts) for (const busy of [false, true]) for (const source of ["telegram", "schedule"] as const) for (const needsIngest of [false, true]) {
      const r = { run_id: "r", text: "x", source, needsIngest, requester: { kind: "user", id: "paco" } } as TurnRequest;
      const d = steerOrQueueInput(t, st, busy, r);
      const live = t?.live && t.req.source === "telegram" && r.source === "telegram" && !r.needsIngest && (st === "RUNNING" || st === "AWAITING_APPROVAL");
      expect(d.outcome === "steer").toBe(Boolean(live));
      const reason = t === undefined ? (busy ? "queued_behind" : "idle") : !t.live ? "turn_not_live" : t.req.source !== "telegram" ? "turn_schedule_born"
        : r.source !== "telegram" ? "message_scheduled" : r.needsIngest ? "needs_ingest" : st !== "RUNNING" && st !== "AWAITING_APPROVAL" ? "not_running" : "live_turn";
      expect(d.reason).toBe(reason);
      expect(d.outcome).toBe(reason === "live_turn" ? "steer" : reason === "idle" ? "queue" : "wait");
    }
  });
});
