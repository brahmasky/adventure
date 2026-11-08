/**
 * Rule: ADR 0034 rule 3.2, the settle-stage and delivery sentence (spec R7 §9, Decision 2-A): parse rows are best-effort terminal records written on the
 * success arm and kept when the run then fails to stage its report; a turn that took the failure arm writes none; a send row is written only after
 * markDelivered, with the outbox row's run_id (null for a run-less row). Changing this rule changes this test in the same commit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoreWorker } from "../../src/core/core-worker.js";
import { storeRecorder } from "../../src/decisions/record.js";
import { NotificationDispatcher } from "../../src/notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp, useFakeOmp } from "../helpers/omp-env.js";
import { drainOutbox, ompWorker, until } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

pinOmpEnv();
pinEnabledFlags();
const adr = readFileSync(join(import.meta.dirname, "..", "..", "docs", "decisions", "0034-decision-ladder-consolidated.md"), "utf8");
const flat = (s: string): string => s.replace(/\s+/g, " ");
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
let worker: CoreWorker | undefined;
beforeEach(() => {
  tmp = shortTmp("hadr-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.FAKE_OMP_ARGV_LOG = join(tmp.dir, "argv.log");
  process.env.HOUGE_TELEGRAM_CHAT_ID = "";
  store = RunStore.openInMemory();
});
afterEach(async () => { await worker?.shutdownPlanners(); worker = undefined; store.close(); tmp.cleanup(); delete process.env.HOUGE_TOMBSTONE_PATH; delete process.env.HOUGE_TELEGRAM_CHAT_ID; });

const attachRows = (s: RunStore, run: string) => s.listDecisionsForRun(run).filter((r) => r.entry_id === "attach.path").map((r) => [r.verdict, r.reason_code, r.run_id]);
type Db = { prepare(s: string): { all(...a: unknown[]): Array<Record<string, unknown>>; run(...a: unknown[]): unknown } };
const db = (s: RunStore) => (s as unknown as { db: Db }).db;

describe("ADR 0034 rule 3.2: settle-stage and delivery rows", () => {
  it("1. the rule text states the R7 sentences and the qualifications, and no longer the bare phrasing", () => {
    const rule = flat(adr.slice(adr.indexOf("- 3.2 "), adr.indexOf("- 3.3 ")));
    expect(rule).toContain("Settle-stage rows (`attach.path` at parse) are best-effort terminal records: written when the supervisor reached its success arm on a non-lane turn, after the end signal, and kept when the run then fails to stage its report or loses its finish claim; a turn that took the failure arm writes none.");
    expect(rule).toContain("Delivery rows (`attach.path` at send) are written by the outbox dispatcher after the delivery committed, with the outbox row's `run_id`; a delivery that did not commit writes none.");
    expect(rule).toContain("Rows are written only while the turn is live (except the settle-stage and delivery rows below);");
    expect(rule).toContain("Supervisor rows follow the incoming run's successful claim (settle-stage rows: below).");
    expect(rule).toContain("so a lost turn writes no row (settle-stage rows, which a later finish failure keeps, and delivery rows: below).");
    expect(rule).not.toContain("only while the turn is live; the signal");
    expect(rule).not.toContain("successful claim. A lane");
    expect(rule).not.toContain("a lost turn writes no row.**");
  });

  it("2. failure arm writes none", async () => {
    useFakeOmp({ "*": { rpcText: "ok\n[[attach: ../x]]", rpcAbortAfterText: true } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "send it"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "failed");
    expect(attachRows(store, run)).toEqual([]);
  });

  it("2b. control: the same reply without the abort writes the marker_outside row, so case 2 cannot pass vacuously", async () => {
    useFakeOmp({ "*": { rpcText: "ok\n[[attach: ../x]]" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "send it"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "completed");
    expect(attachRows(store, run)).toEqual([["refuse", "marker_outside", run]]);
  });

  it("3. a report stage that fails keeps the parse row; the final_report row is the failure notice without attachments", async () => {
    useFakeOmp({ "*": { rpcText: "ok\n[[attach: ../x]]" } }, tmp.dir);
    mkdirSync(join(tmp.dir, "project"), { recursive: true }); writeFileSync(join(tmp.dir, "project", "runs"), "");
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "send it"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "failed");
    const failed = db(store).prepare("SELECT payload_json FROM ledger_events WHERE run_id = ? AND event_type = 'run_failed'").all(run).map((r) => String(r.payload_json));
    expect(failed.some((p) => p.includes("report_write_failed"))).toBe(true);
    expect(attachRows(store, run)).toEqual([["refuse", "marker_outside", run]]);
    const payload = drainOutbox(store).get(`${run}:final_report`) as { text: string; attachments?: string[] };
    expect(payload).toBeDefined();
    expect("attachments" in payload).toBe(false);
    expect(payload.text).not.toContain("[[attach:");
  });

  it("4. a send row is written only after markDelivered, with the outbox row's run_id; null for a run-less row", async () => {
    const outbox = new NotificationOutbox(store);
    const enq = (type: "final_report" | "progress", key: string, runId?: string) => outbox.enqueue({
      topic: "reply", target: { kind: "telegram", chat_id: "222" }, intent_type: type, idempotency_key: key, correlation_id: key,
      ...(runId ? { run_id: runId } : {}), payload: { text: "r", ...(type === "final_report" ? { attachments: ["/w/a"] } : {}) } });
    const withRun = enq("final_report", "k1", "run_1");
    const rows = () => db(store).prepare("SELECT verdict, reason_code, run_id FROM decisions WHERE entry_id = 'attach.path' ORDER BY rowid").all().map((r) => [r.verdict, r.reason_code, r.run_id]);
    const real = store.markNotificationDelivered.bind(store); let threw = false;
    store.markNotificationDelivered = (id, p) => { if (!threw) { threw = true; throw new Error("planted"); } real(id, p); };
    const d = new NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "l" }) },
      telegram: { send: async () => ({ provider_message_id: "t:1", attach_checks: ["not_found"] as const }) } }, { recorder: storeRecorder(store) });
    await expect(d.dispatchOnce("s")).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(outbox.get(withRun.notification_id)!.state).toBe("retry_wait");
    expect(rows()).toEqual([]);
    db(store).prepare("UPDATE notification_outbox SET next_attempt_at = ? WHERE notification_id = ?").run(new Date(Date.now() - 60_000).toISOString(), withRun.notification_id);
    store.requeueRetryWaitNotifications(new Date().toISOString());
    await expect(d.dispatchOnce("s")).resolves.toMatchObject({ status: "delivered" });
    expect(rows()).toEqual([["refuse", "not_found", "run_1"]]);
    enq("progress", "k2");
    const runless = new NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "l" }) },
      telegram: { send: async () => ({ provider_message_id: "t:2", attach_checks: ["not_found"] as const }) } }, { recorder: storeRecorder(store) });
    await expect(runless.dispatchOnce("s")).resolves.toMatchObject({ status: "delivered" });
    expect(rows()).toEqual([["refuse", "not_found", "run_1"], ["refuse", "not_found", null]]);
  });

  it("5. rule 4's attach.path row says refusals (1-A) and is no longer an alwaysRecord row", () => {
    const row = adr.split("\n").find((l) => l.startsWith("| `attach.path` |"));
    expect(row).toBeDefined();
    expect(row).toContain("refusals (1-A)");
    expect(row).not.toContain("`alwaysRecord`");
  });
});
