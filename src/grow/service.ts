import { randomUUID } from "node:crypto";
import { openAlertedIncident } from "../run/incident-alert.js";
import type { RoutedIncidentKind } from "../run/incident-route.js";
import type { GrowOpRow, GrowStagedRow, RunStore } from "../run/run-store.js";
import { checkFields, contentHash, fieldScrub, isSmallUpdate, parseSkillFile, type GrowFailCode, type GrowFields } from "./checks.js";
import { resolveGrowEnabled } from "./flags.js";
import { runOp, type OpDeps } from "./ops.js";
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
  | { status: "REFUSED"; code: "grow_disabled" | "turn_hostile" | "name_is_exemplar" | "rate_capped" | "zone_full" | "busy" | "zone_unavailable" };
export interface GrowDeps { store: RunStore; zone: GrowZone; env: NodeJS.ProcessEnv; now: () => string }
export interface SubmitCtx { run_id: string; chat_id: string | null; level: TrustLevelName }
export interface ReviewRecord { pass: boolean; findings: Array<{ step: string; problem: string }>; reviewer_model: string | null; input_hash: string | null; author_families: string[]; undo_reasons_n: number; code: "review_passed" | "review_failed" | "review_unavailable" }
export type PublishOutcome = "published" | "retry" | "failed" | "gone" | "not_approved" | "held";

export const GROW_SUBMITS_PER_DAY = 20;
export const GROW_ITEMS_MAX = 200;
export const GROW_INDEX_LINES = 40;
export const GROW_INDEX_CHARS = 4000;
const DAY_MS = 86_400_000;
const INDEX_HEAD = "These are your own procedures, written by you. Before a task that matches one, read it with grow_read.";
const INDEX_WRITE = "When a kind of task repeats or went badly, add or improve a procedure with grow_submit.";
const refused = (code: Extract<SubmitResult, { status: "REFUSED" }>["code"]): SubmitResult => ({ status: "REFUSED", code });
/** Incident subjects: the latched door, a commit whose effects could not be recorded, a publish that was dropped. */
const ZONE = "zone"; const APPLY = "apply"; const PUBLISH = "publish";

/** I5: only Paco clears a mark: unmark, the item and its pending rows become clean, in one transaction. */
export function trustItem(store: RunStore, name: string, now: string): boolean {
  if (!store.isGrowMarked(name)) return false;
  store.inTransaction(() => {
    store.unmarkGrowName(name);
    const item = store.getGrowItem(name);
    if (item && item.origin !== "exemplar") store.setGrowItemOrigin(name, "clean", now);
    store.setGrowStagedOrigin(name, "clean", now);
    store.appendGrowEvent({ at: now, run_id: null, chat_id: null, name, action: "trust", result: "clean", code: null, reviewer_model: null, commit_id: null });
  });
  return true;
}

export function submitText(r: SubmitResult): string {
  switch (r.status) {
    case "LIVE": return `LIVE: ${r.name} is live.`;
    case "STAGED": return `STAGED: ${r.name} passed the formal checks and is waiting for review; it is not live yet. You will see the outcome in a later turn.`;
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
      onApplied: (opId) => { this.resolve("grow_zone_unavailable", APPLY); if (this.d.store.getGrowOp(opId)?.kind === "publish") this.resolve("grow_publish_failed", PUBLISH); },
      onApplyFailed: () => this.alert("grow_zone_unavailable", APPLY)
    };
  }

  /**
   * True when the zone is usable. Creates the repository only for a zone the database knows nothing about: no item and
   * no pending operation (a pending first operation whose repository vanished is a fault, not a fresh start). Clears the
   * latch only after `ensure` and `restoreToHead` both succeed.
   */
  async ensureZone(): Promise<boolean> {
    if (this.ready && !this.disabled) return true;
    return this.withLockWait(async () => {
      const { store, zone } = this.d;
      const fresh = store.listGrowItems().length === 0 && store.pendingGrowOps().length === 0;
      try { await zone.ensure(fresh); await zone.restoreToHead(); }
      catch { console.error("[grow] ensure: zone_unavailable"); this.disable(); return false; }
      this.ready = true; this.disabled = false;
      this.resolve("grow_zone_unavailable", ZONE);
      return true;
    });
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
    } catch (e) { return this.zoneFault(e); }
    const stop = this.admit(f, ctx, now);
    if (stop) return stop;
    const existing = store.getGrowItem(f.name);
    const untrusted = ctx.level === "untrusted" || store.isGrowMarked(f.name);
    let needs_review: boolean;
    try { needs_review = await this.needsReview(f, existing?.state === "live", untrusted); } catch (e) { return this.zoneFault(e); }
    const id = store.inTransaction(() => {
      if (untrusted) store.markGrowName(f.name, now);
      const newId = store.insertGrowStaged({ name: f.name, run_id: ctx.run_id, chat_id: ctx.chat_id, origin: untrusted ? "untrusted" : "clean", fields_json: JSON.stringify(f), content_hash: contentHash(f), needs_review, now });
      store.supersedeGrowStaged(f.name, newId, "superseded", now);
      if (!needs_review) store.patchGrowStaged(newId, { state: "approved" }, now);   // I3: a row needing no review is recoverable as approved
      return newId;
    });
    return needs_review ? { status: "STAGED", name: f.name } : this.publishNow(id, f.name);
  }

  /**
   * A fault on the submit path is answered, never thrown at the planner. Only a zone (git) fault latches the door; a
   * database fault after a commit is already paged by `onApplyFailed` and must not shut the door for every name.
   */
  private zoneFault(e: unknown): SubmitResult {
    const git = e instanceof GrowZoneError;
    console.error(git ? "[grow] submit: zone_unavailable" : "[grow] submit: apply_failed");
    if (git) this.disable();
    return refused("zone_unavailable");
  }

  /** The exemplar, rate, cap and formal gates; the submit event is recorded for every submit that reaches the checks. */
  private admit(f: GrowFields, ctx: SubmitCtx, now: string): SubmitResult | null {
    const { store } = this.d;
    const existing = store.getGrowItem(f.name);
    if (existing?.origin === "exemplar") return refused("name_is_exemplar");
    if (store.countGrowEventsSince("submit", new Date(Date.parse(now) - DAY_MS).toISOString()) >= GROW_SUBMITS_PER_DAY) return refused("rate_capped");
    if (existing?.state !== "live" && store.countGrowItems("live") >= GROW_ITEMS_MAX) return refused("zone_full");
    const check = checkFields(f, store.listGrowItems("live"), fieldScrub(store));
    store.appendGrowEvent({ at: now, run_id: ctx.run_id, chat_id: ctx.chat_id, name: f.name, action: "submit", result: check.ok ? "accepted" : "failed", code: check.ok ? null : check.code, reviewer_model: null, commit_id: null });
    return check.ok ? null : { status: "FAIL", code: check.code, message: check.message };
  }

  private async needsReview(f: GrowFields, isLive: boolean, untrusted: boolean): Promise<boolean> {
    if (!isLive || untrusted || this.d.store.listGrowUndoReasons(f.name).length > 0) return true;
    const prev = parseSkillFile((await this.d.zone.readHead(f.name)) ?? "");
    return prev === null || !isSmallUpdate(prev, f);
  }

  /** A small update of a clean live skill publishes inside the submit: one retry, then the answer. */
  private async publishNow(id: number, name: string): Promise<SubmitResult> {
    let out: PublishOutcome;
    try {
      out = await this.publishLocked(id, true);
      if (out === "retry") out = await this.publishLocked(id, true);
    } catch { console.error("[grow] submit: publish_failed"); return refused("zone_unavailable"); }
    if (out === "published") return { status: "LIVE", name };
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

  async publishStaged(id: number): Promise<PublishOutcome> {
    return this.withLockWait(() => this.publishLocked(id, true));
  }

  private async publishLocked(id: number, commit: boolean): Promise<PublishOutcome> {
    const row = this.d.store.getGrowStaged(id);
    if (!row || row.state === "failed") return "gone";
    const op = this.d.store.pendingGrowOps(row.name).find((o) => o.staged_id === id) ?? this.createPublishOp(row, commit);
    if (typeof op === "string") return op;
    const out = await runOp(this.opDeps(), op, this.canWrite(commit));
    return out === "done" ? "published" : out;
  }

  /** I1 + I6: the operation exists only for an approved row that still passes the cap and the duplicate rule. */
  private createPublishOp(row: GrowStagedRow, commit: boolean): GrowOpRow | PublishOutcome {
    const { store } = this.d; const now = this.d.now();
    if (row.state !== "approved") return row.state === "staged" ? "not_approved" : "gone";
    if (row.needs_review && !store.getPassingGrowReview(row.id, row.content_hash)) return "not_approved";
    if (!this.canWrite(commit)) return "held";
    const stop = this.revalidate(JSON.parse(row.fields_json) as GrowFields);
    if (stop) { this.failRow(row, stop); return "failed"; }
    return store.inTransaction(() => {
      store.patchGrowStaged(row.id, { state: "publishing", claimed_at: null }, now);
      return store.insertGrowOp({ id: randomUUID(), kind: "publish", source: "submit", name: row.name, staged_id: row.id, request_id: null, target_json: row.fields_json, reason: null, undo_version_id: null, now });
    });
  }

  /** I6 against what is live now: the cap for a new name, and the duplicate rule (the secret scrub ran at submit). */
  private revalidate(f: GrowFields): "zone_full" | "duplicate" | null {
    const live = this.d.store.listGrowItems("live");
    if (!live.some((i) => i.name === f.name) && live.length >= GROW_ITEMS_MAX) return "zone_full";
    const check = checkFields(f, live, (s) => s);
    return !check.ok && check.code === "duplicate" ? "duplicate" : null;
  }

  private failRow(row: GrowStagedRow, code: "zone_full" | "duplicate"): void {
    const { store } = this.d; const now = this.d.now();
    store.inTransaction(() => {
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
      const logged = (): void => { console.error("[grow] reconcile: op_failed"); };   // a code, never the error's text
      for (const op of this.d.store.pendingGrowOps()) await runOp(this.opDeps(), op, this.canWrite(commit)).catch(logged);
      for (const row of this.d.store.listGrowStaged("approved")) await this.publishLocked(row.id, commit).catch(logged);
    });
  }

  // --- seed: Task 12's only way to write ---

  async seed(f: GrowFields, origin: "exemplar" | "clean", source: "seed" | "migrate"): Promise<"published" | "unchanged" | "failed"> {
    // The operation row carries no origin: the executor derives `exemplar` from source "seed", so the pair must agree.
    if ((origin === "exemplar") !== (source === "seed")) { console.error("[grow] seed: bad_origin"); return "failed"; }
    return this.withLockWait(async () => {
      try { return await this.seedLocked(f, source); } catch { console.error("[grow] seed: op_failed"); return "failed"; }
    });
  }

  private async seedLocked(f: GrowFields, source: "seed" | "migrate"): Promise<"published" | "unchanged" | "failed"> {
    const { store } = this.d;
    if (!(await this.settle(f.name, true))) return "failed";        // an earlier boot's operation is finished, never duplicated
    const item = store.getGrowItem(f.name);
    if ((source === "migrate" && item) || item?.content_hash === contentHash(f)) return "unchanged";
    if (this.disabled) return "failed";
    const op = store.insertGrowOp({ id: randomUUID(), kind: "publish", source, name: f.name, staged_id: null, request_id: null, target_json: JSON.stringify(f), reason: null, undo_version_id: null, now: this.d.now() });
    return (await runOp(this.opDeps(), op, true)) === "done" ? "published" : "failed";
  }

  // --- read side (the minimal versions 4a needs; 4b adds the rest) ---

  async read(name: string, ctx: { run_id: string }): Promise<{ ok: true; text: string; tainted: boolean } | { ok: false; code: "unknown_skill" | "zone_unavailable" }> {
    const { store } = this.d;
    if (store.getGrowItem(name)?.state !== "live") return { ok: false, code: "unknown_skill" };
    let f: ReturnType<typeof parseSkillFile>;
    try { f = parseSkillFile((await this.d.zone.readHead(name)) ?? ""); } catch { console.error("[grow] read: zone_unavailable"); return { ok: false, code: "zone_unavailable" }; }
    if (f === null) return { ok: false, code: "zone_unavailable" };
    store.recordGrowUse(name, ctx.run_id, this.d.now());
    return { ok: true, text: `# ${name}\nWhen: ${f.description}\n\n${f.body}`, tainted: store.isGrowMarked(name) };
  }

  /** Live items in name order under the line and char caps, plus the write sentence while writing is possible. */
  indexBlock(): string | undefined {
    const write = resolveGrowEnabled(this.d.env) && !this.disabled;
    const lines = [INDEX_HEAD];
    let chars = INDEX_HEAD.length;
    for (const i of this.d.store.listGrowItems("live")) {
      const line = `- ${i.name} — ${i.description}`;
      if (lines.length > GROW_INDEX_LINES || chars + 1 + line.length > GROW_INDEX_CHARS) break;
      lines.push(line); chars += 1 + line.length;
    }
    if (lines.length === 1 && !write) return undefined;
    return (write ? [...lines, INDEX_WRITE] : lines).join("\n");
  }
}
