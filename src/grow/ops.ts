import type { GrowOpRow, GrowOrigin, RunStore } from "../run/run-store.js";
import { bodyHash, contentHash, renderSkillFile, type GrowFields } from "./checks.js";
import type { GrowZone } from "./zone.js";

/**
 * The operation executor (spec 2026-11-10 §5.13, plan Task 4 Rev 4). Every change to the zone is an operation: its row
 * is written first, then the git commit carrying `Grow-Op: <id>`, then its effects in one transaction. This is the only
 * file that calls `zone.writeAndCommit` / `zone.removeAndCommit` (ADR 0035 G2).
 */
export interface OpDeps {
  store: RunStore;
  zone: GrowZone;
  now: () => string;
  onIncident: (kind: "grow_publish_failed") => void;
  /** The work tree could not be put back to HEAD: every later write must stop (the service latches its door). */
  onDirty: () => void;
  /** Effects applied and committed; given the operation so the callback never has to read the store again. */
  onApplied: (op: GrowOpRow) => void;
  /** The commit exists but its effects could not be recorded: the operation stays pending. */
  onApplyFailed: (opId: string) => void;
}
export type OpOutcome = "done" | "retry" | "failed" | "held" | "gone";

export const GROW_OP_TRIES = 2;
export const opMessage = (op: GrowOpRow, verb: string): string => `skill(${op.name}): ${verb}\n\nGrow-Op: ${op.id}`;

/** The mark is the only truth for origin; a seeded exemplar is the one exception, fixed by its source. */
const originOf = (d: OpDeps, op: GrowOpRow): GrowOrigin => (op.source === "seed" ? "exemplar" : d.store.isGrowMarked(op.name) ? "untrusted" : "clean");

/**
 * Steps 2 and 3 for one pending operation. Safe to call again after any crash. It rereads the operation, so a stale
 * argument cannot act. Throws on a git lookup error or a database error: the operation then stays pending.
 */
export async function runOp(d: OpDeps, stale: GrowOpRow, commit: boolean): Promise<OpOutcome> {
  const op = d.store.getGrowOp(stale.id);
  if (!op || op.state !== "pending") return "gone";
  let commitId = await d.zone.findOpCommit(op.id);          // a git error propagates: it is never "not found"
  if (commitId === null) {
    if (!commit) return "held";
    if (op.staged_id !== null && d.store.getGrowStaged(op.staged_id)?.state !== "publishing") { failOp(d, op, "superseded"); return "failed"; }
    commitId = await tryWrite(d, op);
    if (commitId === null) return countFailure(d, op);
  }
  applyOnce(d, op, commitId);
  return "done";
}

/** The commit id, or null when the write positively did not land. A write that threw may still have committed: ask git again. */
async function tryWrite(d: OpDeps, op: GrowOpRow): Promise<string | null> {
  try { return await writeOp(d, op); }
  catch {
    console.error("[grow] op: write_failed");
    let landed: string | null;
    try { landed = await d.zone.findOpCommit(op.id); }
    catch (e) { d.onDirty(); throw e; }                      // unknown whether it landed and the tree may be dirty: stop writing, count nothing
    if (landed !== null) return landed;
    try { await d.zone.restoreToHead(); } catch (e) { d.onDirty(); throw e; }   // a dirty tree stops every later write (the door latches)
    return null;
  }
}

/** Only a failure before the commit exists is counted (I4). */
function countFailure(d: OpDeps, op: GrowOpRow): "retry" | "failed" {
  if (d.store.bumpGrowOpFailure(op.id) < GROW_OP_TRIES) return "retry";
  failOp(d, op, "publish_failed");
  d.onIncident("grow_publish_failed");
  return "failed";
}

/** Step 3. The operation is reread inside the transaction, so effects are applied exactly once. */
function applyOnce(d: OpDeps, op: GrowOpRow, commitId: string): void {
  try {
    d.store.inTransaction(() => {
      if (d.store.getGrowOp(op.id)?.state !== "pending") return;
      if (op.kind === "undo") applyUndo(d, op, commitId); else applyPublish(d, op, commitId);
    });
  } catch (e) { d.onApplyFailed(op.id); throw e; }
  d.onApplied(op);
}

async function writeOp(d: OpDeps, op: GrowOpRow): Promise<string> {
  if (op.target_json === null) return d.zone.removeAndCommit(op.name, opMessage(op, "undo (removed)"));
  const f = JSON.parse(op.target_json) as GrowFields;
  const verb = op.kind === "undo" ? "undo" : d.store.getGrowItem(op.name)?.state === "live" ? "update" : "add";
  return d.zone.writeAndCommit(op.name, renderSkillFile(f, originOf(d, op)), opMessage(op, verb));
}

/** Inside the caller's transaction: the item, its version row, the staged row, the event, the change-log line, the op. */
export function applyPublish(d: OpDeps, op: GrowOpRow, commitId: string): void {
  const { store } = d; const now = d.now();
  if (op.target_json === null) throw new Error("grow publish op without a target");
  const f = JSON.parse(op.target_json) as GrowFields;
  const updated = store.getGrowItem(op.name)?.state === "live";
  const staged = op.staged_id === null ? undefined : store.getGrowStaged(op.staged_id);
  store.upsertGrowItem({ name: op.name, state: "live", origin: originOf(d, op), description: f.description, example: f.example, head_commit: commitId, content_hash: contentHash(f), body_hash: bodyHash(f) }, now);
  // An exemplar is the orchestrator's (G1), never outside content: a mark a fresh database's HEAD sync set on it (an
  // orphan to that database) is cleared with the publish that makes it the exemplar again.
  if (op.source === "seed") store.unmarkGrowName(op.name);
  store.insertGrowVersion({ name: op.name, op_id: op.id, commit_id: commitId, content_hash: contentHash(f), fields_json: op.target_json, at: now });
  if (op.staged_id !== null) store.deleteGrowStaged(op.staged_id);
  store.appendGrowEvent({ at: now, run_id: staged?.run_id ?? null, chat_id: staged?.chat_id ?? null, name: op.name, action: "publish", result: updated ? "updated" : "added", code: null, reviewer_model: null, commit_id: commitId });
  if (op.source === "submit") {
    store.enqueueNotification({ topic: "grow_log", idempotency_key: `grow:op:${op.id}`, correlation_id: `grow:op:${op.id}`, text: `Houge ${updated ? "updated" : "added"} the skill ${op.name}.`, now });
  }
  store.finishGrowOp(op.id, "done", commitId, now);
}

/** Inside the caller's transaction: step back one version (or remove), record the reason, finish a linked request. */
export function applyUndo(d: OpDeps, op: GrowOpRow, commitId: string): void {
  const { store } = d; const now = d.now();
  if (op.undo_version_id !== null) store.markGrowVersionUndone(op.undo_version_id);
  if (op.target_json === null) store.setGrowItemState(op.name, "removed", now);
  else {
    const f = JSON.parse(op.target_json) as GrowFields;
    store.upsertGrowItem({ name: op.name, state: "live", origin: originOf(d, op), description: f.description, example: f.example, head_commit: commitId, content_hash: contentHash(f), body_hash: bodyHash(f) }, now);
  }
  store.supersedeGrowStaged(op.name, null, "undone", now);
  store.addGrowUndoReason(op.name, op.reason ?? "(no reason given)", now);
  store.appendGrowEvent({ at: now, run_id: null, chat_id: null, name: op.name, action: "undo", result: op.target_json === null ? "removed" : "restored", code: null, reviewer_model: null, commit_id: commitId });
  store.enqueueNotification({ topic: "grow_log", idempotency_key: `grow:op:${op.id}`, correlation_id: `grow:op:${op.id}`, text: `Paco undid the skill ${op.name}.`, now });
  if (op.request_id !== null) {
    const text = op.target_json === null ? `↩️ ${op.name} removed. Its next version will be reviewed.` : `↩️ ${op.name} restored to its previous version. Its next version will be reviewed.`;
    store.finishGrowRequest(op.request_id, text, now);
  }
  store.finishGrowOp(op.id, "done", commitId, now);
}

/** Ends a pending operation without effects. A no-op unless the reread operation is still pending. */
export function failOp(d: OpDeps, op: GrowOpRow, code: "publish_failed" | "superseded" | "undone"): void {
  const { store } = d; const now = d.now();
  store.inTransaction(() => {
    if (store.getGrowOp(op.id)?.state !== "pending") return;
    store.finishGrowOp(op.id, "failed", null, now);
    const row = op.staged_id === null ? undefined : store.getGrowStaged(op.staged_id);
    if (row) {
      store.patchGrowStaged(row.id, { state: "failed", code, claimed_at: null }, now);
      store.appendGrowEvent({ at: now, run_id: row.run_id, chat_id: row.chat_id, name: op.name, action: "review_failed", result: "failed", code, reviewer_model: null, commit_id: null });
    }
    if (op.request_id !== null) store.finishGrowRequest(op.request_id, "The grow zone could not be written. See /status.", now);
  });
}
