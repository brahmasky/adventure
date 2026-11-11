import { randomUUID } from "node:crypto";
import { openAlertedIncident } from "../run/incident-alert.js";
import type { RoutedIncidentKind } from "../run/incident-route.js";
import type { GrowEventRow, GrowOpRow, GrowStagedRow, NotificationQueueResult, RunStore } from "../run/run-store.js";
import { bodyHash, checkFields, contentHash, fieldScrub, isSmallUpdate, parseSkillFile, renderSkillFile, type GrowFailCode, type GrowFields } from "./checks.js";
import { resolveGrowEnabled } from "./flags.js";
import { failOp, runOp, type OpDeps } from "./ops.js";
import { GrowZoneError, type GrowZone } from "./zone.js";

/**
 * The grow zone's service (spec 2026-11-10 §5, plan Task 4 Rev 4): the door (submit), the review gate, publishing
 * through the operation log (`ops.ts`), recovery (`reconcile`) and seeding. Every public method that writes takes the
 * lock once at its top and then calls only private `…Locked` functions and the executor (I10).
 */
export type TrustLevelName = "clean" | "untrusted" | "hostile";
export type SubmitResult =
  | { status: "LIVE"; name: string } | { status: "STAGED"; name: string }
  | { status: "FAIL"; code: GrowFailCode | "zone_full" | "publish_failed"; message: string }
  | { status: "REFUSED"; code: "grow_disabled" | "turn_hostile" | "name_is_exemplar" | "pending_clean" | "rate_capped" | "zone_full" | "busy" | "zone_unavailable" };
export interface GrowDeps { store: RunStore; zone: GrowZone; env: NodeJS.ProcessEnv; now: () => string }
export interface SubmitCtx { run_id: string; chat_id: string | null; level: TrustLevelName }
export interface ReviewRecord { pass: boolean; findings: Array<{ step: string; problem: string }>; reviewer_model: string | null; input_hash: string | null; author_families: string[]; undo_reasons_n: number; code: "review_passed" | "review_failed" | "review_unavailable" }
export type PublishOutcome = "published" | "retry" | "failed" | "gone" | "not_approved" | "held";
export type UndoResult = { ok: true; removed: boolean } | { ok: false; code: "unknown_skill" | "is_exemplar" | "zone_unavailable" | "busy" };

export const GROW_SUBMITS_PER_DAY = 20;
export const GROW_ITEMS_MAX = 200;
export const GROW_INDEX_LINES = 40;
export const GROW_INDEX_CHARS = 4000;
const DAY_MS = 86_400_000;
const INDEX_HEAD = "These are your own procedures, written by you. Before a task that matches one, read it with grow_read.";
const INDEX_WRITE = "When a kind of task repeats or went badly, add or improve a procedure with grow_submit.";
const INDEX_MARKED = "(from outside content; grow_read it to see it)";
const refused = (code: Extract<SubmitResult, { status: "REFUSED" }>["code"]): SubmitResult => ({ status: "REFUSED", code });
/** Incident subjects: the latched door, a commit whose effects could not be recorded, a publish that was dropped. */
const ZONE = "zone"; const APPLY = "apply"; const PUBLISH = "publish";
const UNDO_TEXT = { unknown_skill: "No live skill of that name. /grow lists them.", is_exemplar: "That one is an exemplar and cannot be undone." } as const;
/** Only these mean the reply is in the outbox (I7). */
const IN_OUTBOX: ReadonlySet<NotificationQueueResult["status"]> = new Set(["queued", "duplicate"]);
/** Failed rows that say nothing about the submission's content: never "the last failed review", never an outcome line. */
export const NOT_A_FAILURE: ReadonlySet<string> = new Set(["superseded", "undone"]);
const NOTE_RUNS_MAX = 200;
/** HEAD sync's events: the event table has no sync action, so they are `publish` events with this code (never an outcome line). */
const HEAD_SYNC = "head_sync";

export type TrustResult = "trusted" | "not_marked" | "pending";
/** Both trust surfaces (`/grow trust`, `houge grow trust`) answer a refused trust with this. */
export const trustPendingText = (name: string): string => `A new version of ${name} is waiting for review; trust it once it is live or failed.`;

/**
 * I5: only Paco clears a mark: unmark and the item becomes clean, in one transaction. Refused (`pending`) while any
 * version of the name is in motion (a staged, approved or publishing row, or a pending operation): the mark would be
 * cleared for text Paco has not seen, and it would publish clean. The check and the unmark share the transaction, so
 * a submit in the daemon (the CLI is another process) cannot slip a row in between.
 */
export function trustItem(store: RunStore, name: string, now: string): TrustResult {
  return store.inTransaction(() => {
    if (!store.isGrowMarked(name)) return "not_marked";
    if (store.listGrowStaged().some((r) => r.name === name && r.state !== "failed") || store.pendingGrowOps(name).length > 0) return "pending";
    store.unmarkGrowName(name);
    const item = store.getGrowItem(name);
    if (item && item.origin !== "exemplar") store.setGrowItemOrigin(name, "clean", now);
    store.appendGrowEvent({ at: now, run_id: null, chat_id: null, name, action: "trust", result: "clean", code: null, reviewer_model: null, commit_id: null });
    return "trusted";
  });
}

export function submitText(r: SubmitResult): string {
  switch (r.status) {
    case "LIVE": return `LIVE: ${r.name} is live.`;
    case "STAGED": return `STAGED: ${r.name} passed the formal checks and is queued; it is not live yet. You will see the outcome in a later turn.`;
    case "FAIL": return `FAIL ${r.code}: ${r.message}`;
    case "REFUSED": return `REFUSED ${r.code}`;
  }
}

export class GrowService {
  readonly zone: GrowZone;
  private held = false;
  private readonly waiters: Array<() => void> = [];
  /** The write door's latch: set when the zone is unusable or its work tree could not be restored; only `ensureZone` clears it. */
  private disabled = false;
  private ready = false;
  /** Outcome lines handed to a run, by run: advanced into the chat's cursor only when that run commits. */
  private readonly notes = new Map<string, { chat_id: string; last: number }>();

  constructor(private readonly d: GrowDeps) { this.zone = d.zone; }

  // --- the lock (I10): handed straight to the oldest waiter, so nobody can overtake ---

  private release(): void { const next = this.waiters.shift(); if (next) next(); else this.held = false; }
  /** The planner's calls never wait: told "busy" when the lock is held or anyone is queued (spec §5.8). */
  async withLock<T>(fn: () => Promise<T>): Promise<T | "busy"> {
    if (this.held || this.waiters.length > 0) return "busy";
    this.held = true;
    try { return await fn(); } finally { this.release(); }
  }
  /** The daemon's own work takes its turn, in arrival order. */
  async withLockWait<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held) await new Promise<void>((r) => this.waiters.push(r)); else this.held = true;
    try { return await fn(); } finally { this.release(); }
  }

  // --- the door's latch and its incidents ---

  disabledReason(): string | null { return this.disabled ? "zone_unavailable" : null; }
  private canWrite(commit: boolean): boolean { return commit && !this.disabled; }

  private disable(): void { this.disabled = true; this.alert("grow_zone_unavailable", ZONE); }

  private alert(kind: RoutedIncidentKind, subject: string): void {
    try { openAlertedIncident(this.d.store, { kind, subject, detail: {}, env: this.d.env, now: this.d.now() }); }
    catch { console.error("[grow] incident: open_failed"); }
  }

  private resolve(kind: RoutedIncidentKind, subject: string): void {
    const { store } = this.d;
    try {
      const open = store.findOpenIncident(store.incidentFingerprint(kind, subject));
      if (open) store.resolveIncident(open.incident_id, this.d.now());
    } catch { console.error("[grow] incident: resolve_failed"); }
  }

  private opDeps(): OpDeps {
    return {
      store: this.d.store, zone: this.d.zone, now: this.d.now,
      onIncident: (kind) => this.alert(kind, PUBLISH),
      onDirty: () => this.disable(),
      onApplied: (op) => this.applied(op),
      onApplyFailed: () => this.alert("grow_zone_unavailable", APPLY)
    };
  }

  /** The `apply` page stays open while any operation is still pending; a dropped publish is cleared by the next one that lands. */
  private applied(op: GrowOpRow): void {
    let idle: boolean;
    try { idle = this.d.store.pendingGrowOps().length === 0; } catch { console.error("[grow] incident: resolve_failed"); return; }
    if (idle) this.resolve("grow_zone_unavailable", APPLY);
    if (op.kind === "publish") this.resolve("grow_publish_failed", PUBLISH);
  }

  /** A git fault seen on a daemon path latches the door; any other fault is only logged by the caller. */
  private latchOnZoneError(e: unknown): void { if (e instanceof GrowZoneError) this.disable(); }

  /**
   * True when the zone is usable. Creates the repository only for a zone the database knows nothing about: no item and
   * no pending operation (a pending first operation whose repository vanished is a fault, not a fresh start). Clears the
   * latch only after `ensure` and `restoreToHead` both succeed. The daemon waits its turn (default); the planner passes
   * `wait: false` and is told "not ready" while the lock is held or anyone is queued (I10: the planner never waits).
   */
  async ensureZone(opts: { wait?: boolean } = {}): Promise<boolean> {
    if (this.ready && !this.disabled) return true;
    if (opts.wait !== false) return this.withLockWait(() => this.ensureLocked());
    const out = await this.withLock(() => this.ensureLocked());
    return out === "busy" ? false : out;
  }

  private async ensureLocked(): Promise<boolean> {
    if (this.ready && !this.disabled) return true;                   // a caller queued behind a successful one repeats nothing
    const { store, zone } = this.d;
    const fresh = store.listGrowItems().length === 0 && store.pendingGrowOps().length === 0;
    try { await zone.ensure(fresh); await zone.restoreToHead(); }
    catch { console.error("[grow] ensure: zone_unavailable"); this.disable(); return false; }
    this.ready = true; this.disabled = false;
    this.resolve("grow_zone_unavailable", ZONE);
    return true;
  }

  // --- submit ---

  async submit(f: GrowFields, ctx: SubmitCtx): Promise<SubmitResult> {
    if (!resolveGrowEnabled(this.d.env)) return refused("grow_disabled");
    if (ctx.level === "hostile") return refused("turn_hostile");
    if (this.disabled) return refused("zone_unavailable");
    const out = await this.withLock(() => this.submitLocked(f, ctx));
    return out === "busy" ? refused("busy") : out;
  }

  private async submitLocked(f: GrowFields, ctx: SubmitCtx): Promise<SubmitResult> {
    const { store } = this.d; const now = this.d.now();
    try {
      await this.d.zone.assertToplevel();
      if (!(await this.settle(f.name, true))) return refused("busy");     // I2: one operation in motion per name
      const stop = this.admit(f, ctx, now);
      if (stop) return stop;
      const existing = store.getGrowItem(f.name);
      const needs_review = await this.needsReview(f, existing?.state === "live", ctx.level === "untrusted" || store.isGrowMarked(f.name));
      const id = this.stage(f, ctx, needs_review, now);
      return needs_review ? { status: "STAGED", name: f.name } : await this.publishNow(id, f.name);
    } catch (e) { return this.submitFault(e); }
  }

  /**
   * One transaction. Only an untrusted turn marks the name; the row's origin reads the mark here, inside the
   * transaction, so a `trustItem` that landed while the submit awaited is never undone by it (I5).
   */
  private stage(f: GrowFields, ctx: SubmitCtx, needs_review: boolean, now: string): number {
    const { store } = this.d;
    return store.inTransaction(() => {
      if (ctx.level === "untrusted") store.markGrowName(f.name, now);
      const origin = store.isGrowMarked(f.name) ? "untrusted" : "clean";
      const newId = store.insertGrowStaged({ name: f.name, run_id: ctx.run_id, chat_id: ctx.chat_id, origin, fields_json: JSON.stringify(f), content_hash: contentHash(f), needs_review, now });
      store.supersedeGrowStaged(f.name, newId, "superseded", now);
      if (!needs_review) store.patchGrowStaged(newId, { state: "approved" }, now);   // I3: a row needing no review is recoverable as approved
      return newId;
    });
  }

  /**
   * Any fault on the submit path is answered, never thrown at the planner. Only a zone (git) fault latches the door; a
   * database fault (a post-commit apply is already paged by `onApplyFailed`) or a malformed field object must not shut
   * the door for every name.
   */
  private submitFault(e: unknown): SubmitResult {
    const git = e instanceof GrowZoneError;
    console.error(git ? "[grow] submit: zone_unavailable" : "[grow] submit: internal_error");
    if (git) this.disable();
    return refused("zone_unavailable");
  }

  /** The exemplar, pending-clean, rate, cap and formal gates; the submit event is recorded for every submit that reaches the checks. */
  private admit(f: GrowFields, ctx: SubmitCtx, now: string): SubmitResult | null {
    const { store } = this.d;
    const existing = store.getGrowItem(f.name);
    if (existing?.origin === "exemplar") return refused("name_is_exemplar");
    if (ctx.level === "untrusted" && this.pendingClean(f.name)) return refused("pending_clean");
    if (store.countGrowEventsSince("submit", new Date(Date.parse(now) - DAY_MS).toISOString()) >= GROW_SUBMITS_PER_DAY) return refused("rate_capped");
    if (existing?.state !== "live" && store.countGrowItems("live") >= GROW_ITEMS_MAX) return refused("zone_full");
    const check = checkFields(f, store.listGrowItems("live"), fieldScrub(store));
    store.appendGrowEvent({ at: now, run_id: ctx.run_id, chat_id: ctx.chat_id, name: f.name, action: "submit", result: check.ok ? "accepted" : "failed", code: check.ok ? null : check.code, reviewer_model: null, commit_id: null });
    return check.ok ? null : { status: "FAIL", code: check.code, message: check.message };
  }

  /**
   * A version of the name is in motion and the name is unmarked: it came from a clean turn (an untrusted one marks the
   * name, and trust is refused while a version is pending). An untrusted submit must not supersede it: that would drop
   * Houge's own work and mark the name, a side effect outside text could aim at any name.
   */
  private pendingClean(name: string): boolean {
    const { store } = this.d;
    return !store.isGrowMarked(name) && store.listGrowStaged().some((r) => r.name === name && r.state !== "failed");
  }

  private async needsReview(f: GrowFields, isLive: boolean, untrusted: boolean): Promise<boolean> {
    if (!isLive || untrusted || this.d.store.listGrowUndoReasons(f.name).length > 0) return true;
    const prev = parseSkillFile((await this.d.zone.readHead(f.name)) ?? "");
    return prev === null || !isSmallUpdate(prev, f);
  }

  /**
   * A small update of a clean live skill publishes inside the submit: one retry, then the answer. A row left `approved`
   * or `publishing` (held, or still retrying) is queued: the next reconcile publishes it, so the answer is STAGED.
   */
  private async publishNow(id: number, name: string): Promise<SubmitResult> {
    let out: PublishOutcome;
    try {
      out = await this.publishLocked(id, true);
      if (out === "retry") out = await this.publishLocked(id, true);
    } catch (e) { console.error("[grow] submit: publish_failed"); this.latchOnZoneError(e); return refused("zone_unavailable"); }
    if (out === "published") return { status: "LIVE", name };
    if (out === "held" || out === "retry") return { status: "STAGED", name };
    if (out !== "failed") return refused("zone_unavailable");
    const code = this.d.store.getGrowStaged(id)?.code;
    return { status: "FAIL", code: code === "duplicate" || code === "zone_full" ? code : "publish_failed", message: "the update could not be published" };
  }

  // --- the review gate and publishing ---

  /** One transaction; a row no longer `staged` is ignored (a superseded row's late review approves nothing). */
  recordReview(id: number, r: ReviewRecord): void {
    const { store } = this.d; const now = this.d.now();
    store.inTransaction(() => {
      const row = store.getGrowStaged(id);
      if (!row || row.state !== "staged") return;
      const findings_json = JSON.stringify(r.findings);
      store.insertGrowReview({ staged_id: id, name: row.name, content_hash: row.content_hash, pass: r.pass, code: r.code, findings_json, reviewer_model: r.reviewer_model, input_hash: r.input_hash, author_families: r.author_families.join(","), undo_reasons_n: r.undo_reasons_n, at: now });
      if (r.pass) { store.patchGrowStaged(id, { state: "approved", claimed_at: null }, now); return; }
      store.patchGrowStaged(id, { state: "failed", code: r.code, findings_json, claimed_at: null }, now);
      store.appendGrowEvent({ at: now, run_id: row.run_id, chat_id: row.chat_id, name: row.name, action: "review_failed", result: "failed", code: r.code, reviewer_model: r.reviewer_model, commit_id: null });
    });
  }

  /** With `commit` false (the switch is off) nothing is created or committed: an approved row stays `approved` (I9). */
  async publishStaged(id: number, commit = true): Promise<PublishOutcome> {
    return this.withLockWait(async () => {
      try { return await this.publishLocked(id, commit); } catch (e) { this.latchOnZoneError(e); throw e; }
    });
  }

  private async publishLocked(id: number, commit: boolean): Promise<PublishOutcome> {
    const row = this.d.store.getGrowStaged(id);
    if (!row || row.state === "failed") return "gone";
    const op = this.d.store.pendingGrowOps(row.name).find((o) => o.staged_id === id) ?? this.createPublishOp(row, commit);
    if (typeof op === "string") return op;
    const out = await runOp(this.opDeps(), op, this.canWrite(commit));
    return out === "done" ? "published" : out;
  }

  /**
   * I1 + I6: the operation exists only for an approved row that still passes the cap, the duplicate and the exemplar
   * rule. I2: while another operation of the name is pending, nothing is created (`held`).
   */
  private createPublishOp(row: GrowStagedRow, commit: boolean): GrowOpRow | PublishOutcome {
    const { store } = this.d; const now = this.d.now();
    if (row.state !== "approved") return row.state === "staged" ? "not_approved" : "gone";
    if (row.needs_review && !store.getPassingGrowReview(row.id, row.content_hash)) return "not_approved";
    if (!this.canWrite(commit) || store.pendingGrowOps(row.name).length > 0) return "held";
    const stop = this.revalidate(JSON.parse(row.fields_json) as GrowFields);
    if (stop) { this.failRow(row.id, "approved", stop); return "failed"; }
    return store.inTransaction(() => {
      store.patchGrowStaged(row.id, { state: "publishing", claimed_at: null }, now);
      return store.insertGrowOp({ id: randomUUID(), kind: "publish", source: "submit", name: row.name, staged_id: row.id, request_id: null, target_json: row.fields_json, reason: null, undo_version_id: null, now });
    });
  }

  /** I6 against what is live now: the exemplar rule, the cap for a new name, and the duplicate rule (the secret scrub ran at submit). */
  private revalidate(f: GrowFields): "zone_full" | "duplicate" | "name_is_exemplar" | null {
    if (this.d.store.getGrowItem(f.name)?.origin === "exemplar") return "name_is_exemplar";
    const live = this.d.store.listGrowItems("live");
    if (!live.some((i) => i.name === f.name) && live.length >= GROW_ITEMS_MAX) return "zone_full";
    const check = checkFields(f, live, (s) => s);
    return !check.ok && check.code === "duplicate" ? "duplicate" : null;
  }

  /** A staged row whose authoring turn will never settle: failed `run_unsettled`, never reviewed (the tick decides when). */
  failUnsettled(id: number): void { this.failRow(id, "staged", "run_unsettled"); }

  /** One transaction; the row is reread and failed only while it is still in the expected state. */
  private failRow(id: number, expected: "staged" | "approved", code: "zone_full" | "duplicate" | "name_is_exemplar" | "run_unsettled"): void {
    const { store } = this.d; const now = this.d.now();
    store.inTransaction(() => {
      const row = store.getGrowStaged(id);
      if (!row || row.state !== expected) return;
      store.patchGrowStaged(row.id, { state: "failed", code, claimed_at: null }, now);
      store.appendGrowEvent({ at: now, run_id: row.run_id, chat_id: row.chat_id, name: row.name, action: "review_failed", result: "failed", code, reviewer_model: null, commit_id: null });
    });
  }

  /** I2: run every pending operation of this name. True when none is left pending. Throws on a git lookup error. */
  private async settle(name: string, commit: boolean): Promise<boolean> {
    for (const op of this.d.store.pendingGrowOps(name)) await runOp(this.opDeps(), op, this.canWrite(commit));
    return this.d.store.pendingGrowOps(name).length === 0;
  }

  /** I3 + I9: finish pending operations, then publish approved rows; with `commit` false nothing is created or committed. */
  async reconcile(commit: boolean): Promise<void> {
    await this.withLockWait(async () => {
      const logged = (e: unknown): void => { console.error("[grow] reconcile: op_failed"); this.latchOnZoneError(e); };   // a code, never the error's text
      for (const op of this.d.store.pendingGrowOps()) await runOp(this.opDeps(), op, this.canWrite(commit)).catch(logged);
      for (const row of this.d.store.listGrowStaged("approved")) await this.publishLocked(row.id, commit).catch(logged);
      // The last pending operation may have ended through failOp, which applies nothing: clear the apply page here too.
      if (this.d.store.pendingGrowOps().length === 0) this.resolve("grow_zone_unavailable", APPLY);
    });
  }

  // --- seed: Task 12's only way to write ---

  async seed(f: GrowFields, origin: "exemplar" | "clean", source: "seed" | "migrate"): Promise<"published" | "unchanged" | "failed"> {
    // The operation row carries no origin: the executor derives `exemplar` from source "seed", so the pair must agree.
    if ((origin === "exemplar") !== (source === "seed")) { console.error("[grow] seed: bad_origin"); return "failed"; }
    return this.withLockWait(async () => {
      try { return await this.seedLocked(f, source); } catch (e) { console.error("[grow] seed: op_failed"); this.latchOnZoneError(e); return "failed"; }
    });
  }

  private async seedLocked(f: GrowFields, source: "seed" | "migrate"): Promise<"published" | "unchanged" | "failed"> {
    const { store } = this.d;
    if (!(await this.settle(f.name, true))) return "failed";        // an earlier boot's operation is finished, never duplicated
    const item = store.getGrowItem(f.name);
    if (source === "migrate" && item) return "unchanged";                // a migration never restores a name the zone knows
    // An exemplar is unchanged only when its row AND the committed file are; a removed or hand-edited one is restored.
    if (item?.state === "live" && item.content_hash === contentHash(f) && (await this.d.zone.readHead(f.name)) === renderSkillFile(f, "exemplar")) return "unchanged";
    if (this.disabled) return "failed";
    const op = store.insertGrowOp({ id: randomUUID(), kind: "publish", source, name: f.name, staged_id: null, request_id: null, target_json: JSON.stringify(f), reason: null, undo_version_id: null, now: this.d.now() });
    return (await runOp(this.opDeps(), op, true)) === "done" ? "published" : "failed";
  }


  // --- undo (I2, I7, I8) ---

  async undo(name: string, reason: string | null, requestId?: number): Promise<UndoResult> {
    return this.withLockWait(() => this.undoLocked(name, reason, requestId));
  }

  private async undoLocked(name: string, reason: string | null, requestId?: number): Promise<UndoResult> {
    const { store } = this.d;
    if (this.disabled) return { ok: false, code: "zone_unavailable" };   // the latched door creates and writes nothing
    try {
      const linked = requestId === undefined ? undefined : store.getGrowOpByRequest(requestId);
      const op = linked ?? (await this.newUndoOp(name, reason, requestId));
      if (typeof op === "string") return op === "busy" ? { ok: false, code: "busy" } : { ok: false, code: op };
      if (op.state === "done") return { ok: true, removed: op.target_json === null };   // a linked request continues ITS operation, never another
      if (op.state === "failed") return { ok: false, code: "zone_unavailable" };
      if ((await runOp(this.opDeps(), op, true)) !== "done") return { ok: false, code: "zone_unavailable" };
      return { ok: true, removed: op.target_json === null };
    } catch (e) {
      console.error("[grow] undo: zone_unavailable");
      this.latchOnZoneError(e);
      return { ok: false, code: "zone_unavailable" };
    }
  }

  /** I8: one step back by the version list (never by git history). A live item with no earlier version is removed. */
  private async newUndoOp(name: string, reason: string | null, requestId?: number): Promise<GrowOpRow | "busy" | "unknown_skill" | "is_exemplar"> {
    const { store } = this.d;
    const settled = await this.cancelOrSettle(name);
    if (settled === false) return "busy";
    // The same owner's pending undo just finished: that was this call's step back. Another owner's undo is its own step.
    if (settled !== true && settled.request_id === (requestId ?? null)) return settled;
    const item = store.getGrowItem(name);                                // read after settling: a finished publish may have changed it
    if (!item || item.state !== "live") return "unknown_skill";
    if (item.origin === "exemplar") return "is_exemplar";
    const cur = store.latestGrowVersion(name);
    const prev = cur ? store.previousGrowVersion(name, cur.id) : undefined;
    return store.insertGrowOp({ id: randomUUID(), kind: "undo", source: "undo", name, staged_id: null, request_id: requestId ?? null, target_json: prev?.fields_json ?? null,
      reason: (reason ?? "(no reason given)").slice(0, 500), undo_version_id: cur?.id ?? null, now: this.d.now() });
  }

  /**
   * I2 for undo: finish a pending publish whose commit exists; cancel one whose commit is positively absent. A git error
   * throws (no cancel). Answers false while anything is left pending, the finished undo when settling ran one (I8: one
   * step back per call, so the caller inserts nothing more), else true.
   */
  private async cancelOrSettle(name: string): Promise<boolean | GrowOpRow> {
    let undone: GrowOpRow | undefined;
    for (const op of this.d.store.pendingGrowOps(name)) {
      if (op.kind === "undo") { if ((await runOp(this.opDeps(), op, true)) === "done") undone = op; continue; }
      const out = await runOp(this.opDeps(), op, false);                 // "held" = positively no commit
      if (out === "held") failOp(this.opDeps(), op, "undone");
    }
    if (this.d.store.pendingGrowOps(name).length > 0) return false;
    return undone ? (this.d.store.getGrowOp(undone.id) ?? true) : true;
  }

  // --- requests (I7) ---

  /** Runs due undo/adopt requests, then queues the reply of every finished one. Returns how many requests finished. */
  async runRequests(): Promise<number> {
    return this.withLockWait(async () => {
      let finished = 0;
      for (const req of this.d.store.dueGrowRequests()) if (await this.runRequest(req.id, req.kind, req.name, req.reason)) finished += 1;
      this.replyFinished();
      return finished;
    });
  }

  /** True when the request left `queued`. A transient undo failure leaves it queued for the next run (its operation is continued). */
  private async runRequest(id: number, kind: "undo" | "adopt", name: string, reason: string | null): Promise<boolean> {
    const { store } = this.d;
    if (kind === "adopt") {
      try { await this.adopt(name, id); } catch (e) { console.error("[grow] requests: adopt_failed"); this.latchOnZoneError(e); }
    } else {
      // A request with an operation is finished only inside that operation's transaction (applyUndo or failOp, I7).
      const r = await this.undoLocked(name, reason, id);
      try {
        const op = store.getGrowOpByRequest(id);
        if (!r.ok && !op && (r.code === "unknown_skill" || r.code === "is_exemplar")) store.finishGrowRequest(id, UNDO_TEXT[r.code], this.d.now());
        else if (op?.state === "done" && store.dueGrowRequests().some((q) => q.id === id)) console.error("[grow] requests: done_op_queued");
      } catch { console.error("[grow] requests: finish_failed"); }
    }
    // Finished is whatever left `queued`, by whichever path (failOp also finishes a request whose operation failed for good).
    try { return !store.dueGrowRequests().some((q) => q.id === id); } catch { console.error("[grow] requests: finish_failed"); return false; }
  }

  /** A request becomes `replied` only when its reply is in the outbox; a chat-less one has nobody to tell. */
  private replyFinished(): void {
    const { store } = this.d;
    let done: ReturnType<RunStore["doneGrowRequests"]>;
    try { done = store.doneGrowRequests(); } catch { console.error("[grow] requests: reply_failed"); return; }
    for (const req of done) {
      try {
        if (!req.chat_id) { store.markGrowRequestReplied(req.id, this.d.now()); continue; }
        const q = store.enqueueNotification({ topic: "reply", target: { kind: "telegram", chat_id: req.chat_id }, intent_type: "progress",
          idempotency_key: `grow:req:${req.id}`, correlation_id: `grow:req:${req.id}`, payload: { text: req.result ?? "" } });
        if (IN_OUTBOX.has(q.status)) store.markGrowRequestReplied(req.id, this.d.now());
        else console.error("[grow] requests: reply_conflict");          // stays `done`: the next run tries again
      } catch { console.error("[grow] requests: reply_failed"); }
    }
  }

  /**
   * An orphan becomes live and untrusted with its name marked, and its content at HEAD becomes its first version (I8: an
   * undo of a later update steps back to it). HEAD is read first, outside the transaction; the rest is one transaction,
   * which also finishes a request with the outcome. A file gone from HEAD meanwhile is nothing to adopt.
   */
  async adopt(name: string, requestId?: number): Promise<boolean> {
    const { store } = this.d;
    const orphan = store.getGrowItem(name)?.state === "orphan";
    const head = orphan ? await this.d.zone.head() : null;
    const f = head === null ? null : await this.headFields(name);
    const now = this.d.now();
    return store.inTransaction(() => {
      const adopted = head !== null && f !== null && store.getGrowItem(name)?.state === "orphan";
      if (adopted) {
        this.writeFromHead(name, f, "live", head, "adopt");
        store.appendGrowEvent({ at: now, run_id: null, chat_id: null, name, action: "adopt", result: "live", code: null, reviewer_model: null, commit_id: null });
      }
      if (requestId !== undefined) store.finishGrowRequest(requestId, adopted ? `✅ ${name} adopted; it reads as outside content until you trust it.` : `Nothing to adopt under ${name}.`, now);
      return adopted;
    });
  }

  // --- HEAD sync ---

  /**
   * Brings the rows in line with what is committed at HEAD. Compares `contentHash`, which leaves the file's `origin:` line
   * out on purpose: the mark is the truth for origin, so an origin-line difference can never bring back a mark Paco
   * cleared. A name with a pending operation is skipped: its commit is Houge's own, finished by the next reconcile. An
   * exemplar is skipped too: the seeder owns it and restores it.
   */
  async syncWithHead(): Promise<{ orphans: number; removed: number; changed: number }> {
    return this.withLockWait(async () => {
      const counts = { orphans: 0, removed: 0, changed: 0 };
      try {
        const head = await this.d.zone.head();
        const atHead = new Set(await this.d.zone.listHead());
        const busy = new Set(this.d.store.pendingGrowOps().map((o) => o.name));
        for (const name of atHead) if (!busy.has(name) && !this.d.store.getGrowItem(name) && (await this.syncOrphan(name, head))) counts.orphans += 1;
        for (const item of this.d.store.listGrowItems("live")) {
          if (busy.has(item.name) || item.origin === "exemplar") continue;   // the seeder owns exemplars
          if (!atHead.has(item.name)) { this.syncRecord(item.name, "removed", head, () => this.d.store.setGrowItemState(item.name, "removed", this.d.now())); counts.removed += 1; }
          else if (await this.syncChanged(item.name, item.content_hash, head)) counts.changed += 1;
        }
      } catch (e) { console.error("[grow] sync: failed"); this.latchOnZoneError(e); }
      return counts;
    });
  }

  private async headFields(name: string): Promise<GrowFields | null> {
    const f = parseSkillFile((await this.d.zone.readHead(name)) ?? "");
    if (f === null) console.error("[grow] sync: unparsable");
    return f;
  }

  private async syncOrphan(name: string, head: string): Promise<boolean> {
    const f = await this.headFields(name);
    if (!f) return false;
    this.syncRecord(name, "orphan", head, () => this.writeFromHead(name, f, "orphan", head, "sync"));
    return true;
  }

  private async syncChanged(name: string, hash: string, head: string): Promise<boolean> {
    const f = await this.headFields(name);
    if (!f || contentHash(f) === hash) return false;
    this.syncRecord(name, "changed", head, () => this.writeFromHead(name, f, "live", head, "sync"));
    return true;
  }

  /**
   * Content that did not come through the door: untrusted, and the name is marked. Live content is a version (I8), so
   * an undo steps back from it to what was live before. Its `op_id` names no operation (none wrote it): `sync:` or
   * `adopt:` plus a fresh id, never one an earlier version holds (the column is unique), whatever HEAD is.
   */
  private writeFromHead(name: string, f: GrowFields, state: "live" | "orphan", head: string, by: "sync" | "adopt"): void {
    const { store } = this.d; const now = this.d.now();
    store.upsertGrowItem({ name, state, origin: "untrusted", description: f.description, example: f.example, head_commit: head, content_hash: contentHash(f), body_hash: bodyHash(f) }, now);
    store.markGrowName(name, now);
    if (state === "live") store.insertGrowVersion({ name, op_id: `${by}:${randomUUID()}`, commit_id: head, content_hash: contentHash(f), fields_json: JSON.stringify(f), at: now });
  }

  private syncRecord(name: string, result: "orphan" | "removed" | "changed", head: string, change: () => void): void {
    const { store } = this.d;
    store.inTransaction(() => {
      change();
      store.appendGrowEvent({ at: this.d.now(), run_id: null, chat_id: null, name, action: "publish", result, code: HEAD_SYNC, reviewer_model: null, commit_id: head });
    });
  }

  // --- outcome lines for the writing chat ---

  /** New outcomes for this chat since its cursor, at most 10. They stay until a run that carried them commits. */
  contextNotes(chat_id: string, run_id: string): string[] {
    const events = this.d.store.listGrowEvents({ sinceId: this.d.store.getGrowContextCursor(chat_id), chat_id, actions: ["publish", "review_failed", "hint"], limit: 10 });
    if (this.notes.size > NOTE_RUNS_MAX) this.notes.clear();
    const last = events.at(-1);
    if (last) this.notes.set(run_id, { chat_id, last: last.id });
    return events.map(noteText).filter((t): t is string => t !== null);
  }

  commitNotes(run_id: string): void {
    const n = this.notes.get(run_id);
    if (!n) return;
    this.notes.delete(run_id);
    if (n.last > this.d.store.getGrowContextCursor(n.chat_id)) this.d.store.setGrowContextCursor(n.chat_id, n.last);
  }

  // --- read side ---

  async read(name: string, ctx: { run_id: string }): Promise<{ ok: true; text: string; tainted: boolean } | { ok: false; code: "unknown_skill" | "zone_unavailable" }> {
    const { store } = this.d;
    if (store.getGrowItem(name)?.state !== "live") return { ok: false, code: "unknown_skill" };
    let f: ReturnType<typeof parseSkillFile>;
    try { f = parseSkillFile((await this.d.zone.readHead(name)) ?? ""); } catch { console.error("[grow] read: zone_unavailable"); return { ok: false, code: "zone_unavailable" }; }
    if (f === null) { console.error("[grow] read: unreadable"); return { ok: false, code: "zone_unavailable" }; }
    store.recordGrowUse(name, ctx.run_id, this.d.now());
    return { ok: true, text: `# ${name}\nWhen: ${f.description}\n\n${f.body}`, tainted: store.isGrowMarked(name) };
  }

  /** The findings of the last submission of `name` that failed; the text is outside content while the name is marked. */
  readReview(name: string): { ok: true; text: string; tainted: boolean } | { ok: false; code: "no_review" } {
    const row = this.d.store.listGrowStaged("failed").filter((r) => r.name === name && !NOT_A_FAILURE.has(r.code ?? "")).at(-1);
    if (!row) return { ok: false, code: "no_review" };
    const findings = parseFindings(row.findings_json);
    const head = `${name}: your last submission failed (${row.code ?? "failed"})`;
    const text = findings.length === 0 ? `${head}; no findings.` : [`${head}. Findings:`, ...findings.map((x) => `- step ${x.step}: ${x.problem}`)].join("\n");
    return { ok: true, text, tainted: this.d.store.isGrowMarked(name) };
  }

  /**
   * Live items in name order under the line and char caps, plus the write sentence while writing is possible. A marked
   * item shows its name and a label only: its description is outside text, and the index rides in every system prompt
   * and in the reviewer's LIVE_INDEX unread, where the taint of `grow_read` cannot follow it (G4).
   */
  indexBlock(): string | undefined {
    const write = resolveGrowEnabled(this.d.env) && !this.disabled;
    const lines = [INDEX_HEAD];
    let chars = INDEX_HEAD.length;
    for (const i of this.d.store.listGrowItems("live")) {
      const line = `- ${i.name} — ${this.d.store.isGrowMarked(i.name) ? INDEX_MARKED : i.description}`;
      if (lines.length > GROW_INDEX_LINES || chars + 1 + line.length > GROW_INDEX_CHARS) break;
      lines.push(line); chars += 1 + line.length;
    }
    if (lines.length === 1 && !write) return undefined;
    return (write ? [...lines, INDEX_WRITE] : lines).join("\n");
  }
}

function parseFindings(json: string | null): Array<{ step: string; problem: string }> {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is { step: string; problem: string } => typeof x?.step === "string" && typeof x?.problem === "string") : [];
  } catch { console.error("[grow] review: bad_findings"); return []; }
}

/** One outcome line, or null for an event that is not an outcome of the chat's own writing. */
function noteText(e: GrowEventRow): string | null {
  if (e.action === "publish") return e.code === HEAD_SYNC || (e.result !== "added" && e.result !== "updated") ? null : `grow: ${e.name} is live`;
  if (e.action === "review_failed") return NOT_A_FAILURE.has(e.code ?? "") ? null : `grow: ${e.name} failed review (grow_read it with what "review" to see why)`;
  if (e.action === "hint") return `grow: a task of kind ${e.code ?? "unknown"} keeps recurring; consider grow_submit`;
  return null;
}
