import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const NOW = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T10:20:00.000Z";
const stores: RunStore[] = []; const dirs: string[] = [];
const mem = (): RunStore => { const s = RunStore.openInMemory(); stores.push(s); return s; };
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const staged = (s: RunStore, name = "unit-convert", needs_review = true): number =>
  s.insertGrowStaged({ name, run_id: "run_1", chat_id: "555", origin: "clean", fields_json: "{}", content_hash: "h1", needs_review, now: NOW });
const item = (name = "unit-convert") =>
  ({ name, state: "live" as const, origin: "clean" as const, description: "d".repeat(20), example: "e".repeat(10), head_commit: "c1", content_hash: "h1", body_hash: "b1" });
const review = (staged_id: number, over: Record<string, unknown> = {}) =>
  ({ staged_id, name: "unit-convert", content_hash: "h1", pass: true, code: "ok", findings_json: "[]", reviewer_model: "m", input_hash: "i1", author_families: "claude", undo_reasons_n: 0, at: NOW, ...over });

describe("grow store", () => {
  it("applies the migration once on a file-backed store (a second open must not fail or duplicate)", () => {
    const dir = mkdtempSync(join(tmpdir(), "grow-store-")); dirs.push(dir);
    RunStore.open(join(dir, "t.sqlite")).close();
    const s = RunStore.open(join(dir, "t.sqlite")); stores.push(s);
    expect(s.listGrowItems()).toEqual([]);
  });

  it("a review is claimed by exactly one caller, so two poll cycles never review the same item twice", () => {
    const s = mem(); const id = staged(s);
    expect(s.dueGrowReviews(NOW).map((r) => r.id)).toEqual([id]);
    expect(s.claimGrowReview(id, NOW)).toBe(true);
    expect(s.claimGrowReview(id, NOW)).toBe(false);
    expect(s.dueGrowReviews(NOW)).toEqual([]);
    expect(s.getGrowStaged(id)?.attempts).toBe(1);
  });

  it("releases a claim older than the stale bound, so a crash mid-review does not strand the item", () => {
    const s = mem(); const id = staged(s);
    s.claimGrowReview(id, NOW);
    expect(s.releaseStaleGrowClaims("2026-11-10T09:55:00.000Z")).toBe(0);
    expect(s.releaseStaleGrowClaims(LATER)).toBe(1);
    expect(s.dueGrowReviews(LATER).map((r) => r.id)).toEqual([id]);
  });

  it("a row whose next attempt is in the future is not due yet", () => {
    const s = mem(); const id = staged(s);
    s.patchGrowStaged(id, { next_attempt_at: LATER }, NOW);
    expect(s.dueGrowReviews(NOW)).toEqual([]);
    expect(s.dueGrowReviews(LATER).map((r) => r.id)).toEqual([id]);
  });

  it("an update that needs no review is never offered to the reviewer", () => {
    const s = mem(); staged(s, "small-edit", false);
    expect(s.dueGrowReviews(LATER)).toEqual([]);
  });

  it("counts one use per run, because a planner re-reading a skill in one turn is not more evidence", () => {
    const s = mem();
    s.upsertGrowItem(item(), NOW);
    expect(s.recordGrowUse("unit-convert", "run_1", NOW)).toBe(true);
    expect(s.recordGrowUse("unit-convert", "run_1", NOW)).toBe(false);
    expect(s.recordGrowUse("unit-convert", "run_2", LATER)).toBe(true);
    expect(s.getGrowItem("unit-convert")).toMatchObject({ uses: 2, last_used_at: LATER });
  });

  it("a hint is recorded once per recurrence key and surfaces as one event for its chat", () => {
    const s = mem();
    const hint = { idempotency_key: "cat:t1", chat_id: "555", category: "conversion", turn_ids: ["t1", "t2"], decision_id: "dec_1", now: NOW };
    expect(s.recordGrowHint(hint)).toBe(true);
    expect(s.recordGrowHint(hint)).toBe(false);
    expect(s.growHintExists("cat:t1")).toBe(true);
    expect(s.growHintOverlapsTurns(["t2", "t9"], "2026-11-01T00:00:00.000Z")).toBe(true);
    expect(s.growHintOverlapsTurns(["t9"], "2026-11-01T00:00:00.000Z")).toBe(false);
    expect(s.growHintOverlapsTurns(["t2"], LATER)).toBe(false);
    expect(s.listGrowEvents({ chat_id: "555", actions: ["hint"] })).toMatchObject([{ action: "hint", code: "conversion" }]);
    expect(s.countGrowHintsSince("2026-11-01T00:00:00.000Z")).toBe(1);
  });

  it("undo reasons accumulate and are never replaced", () => {
    const s = mem();
    s.addGrowUndoReason("unit-convert", "wrong factor", NOW);
    s.addGrowUndoReason("unit-convert", "still wrong", LATER);
    expect(s.listGrowUndoReasons("unit-convert").map((r) => r.reason)).toEqual(["wrong factor", "still wrong"]);
  });

  it("author families come only from successful planner rows, and a row without a family is reported unknown", () => {
    const s = mem();
    expect(s.runAuthorFamilies("run_missing")).toEqual({ families: [], unknown: true });
    const run_id = createQueuedTurnRun(s);
    const sink = s.llmAuditSink({ run_id, role: "compose" });
    sink.record({ provider: "anthropic", role: "", outcome: "ok", model: "claude-opus-5-5", family: "claude", request_key: `${run_id}:1` });
    sink.record({ provider: "kimi", role: "", outcome: "error", family: "kimi", request_key: `${run_id}:2` });
    expect(s.runAuthorFamilies(run_id)).toEqual({ families: ["claude"], unknown: false });
    s.llmAuditSink({ run_id, role: "reviewer" }).record({ provider: "openai", role: "", outcome: "ok", model: "gpt-x", family: "gpt", request_key: `${run_id}:r1` });
    expect(s.runAuthorFamilies(run_id)).toEqual({ families: ["claude"], unknown: false });
    sink.record({ provider: "x", role: "", outcome: "ok", model: "m", request_key: `${run_id}:3` });
    expect(s.runAuthorFamilies(run_id)).toMatchObject({ unknown: true });
  });

  it("upsertGrowItem on an existing name keeps uses and created_at, so a republish does not reset the evidence", () => {
    const s = mem();
    s.upsertGrowItem(item(), NOW);
    s.recordGrowUse("unit-convert", "run_1", NOW);
    s.upsertGrowItem({ ...item(), description: "new ".repeat(10), head_commit: "c2", content_hash: "h2", body_hash: "b2" }, LATER);
    expect(s.getGrowItem("unit-convert")).toMatchObject({ uses: 1, last_used_at: NOW, created_at: NOW, updated_at: LATER, head_commit: "c2", content_hash: "h2", body_hash: "b2" });
  });

  it("item state, origin and counts follow their setters; list is ordered by name", () => {
    const s = mem();
    s.upsertGrowItem(item("b-skill"), NOW); s.upsertGrowItem(item("a-skill"), NOW);
    expect(s.listGrowItems().map((r) => r.name)).toEqual(["a-skill", "b-skill"]);
    s.setGrowItemState("a-skill", "removed", LATER); s.setGrowItemOrigin("b-skill", "untrusted", LATER);
    expect(s.countGrowItems("live")).toBe(1);
    expect(s.listGrowItems("removed").map((r) => r.name)).toEqual(["a-skill"]);
    expect(s.getGrowItem("b-skill")?.origin).toBe("untrusted");
  });

  it("insertGrowStaged is due immediately and listGrowStaged is in ascending id", () => {
    const s = mem(); const a = staged(s, "one"); const b = staged(s, "two");
    expect(s.getGrowStaged(a)).toMatchObject({ state: "staged", next_attempt_at: NOW, needs_review: true, });
    expect(s.listGrowStaged("staged").map((r) => r.id)).toEqual([a, b]);
    s.patchGrowStaged(a, { state: "failed", code: "bad" }, LATER);
    expect(s.listGrowStaged("failed").map((r) => r.id)).toEqual([a]);
    s.deleteGrowStaged(b);
    expect(s.getGrowStaged(b)).toBeUndefined();
  });

  it("supersedeGrowStaged fails only pending rows of that name and spares exceptId and publishing rows", () => {
    const s = mem();
    const a = staged(s); const keep = staged(s); const pub = staged(s); const other = staged(s, "other");
    s.patchGrowStaged(pub, { state: "publishing" }, NOW);
    s.claimGrowReview(a, NOW);
    expect(s.supersedeGrowStaged("unit-convert", keep, "superseded", LATER)).toBe(1);
    expect(s.getGrowStaged(a)).toMatchObject({ state: "failed", code: "superseded", claimed_at: null });
    expect(s.getGrowStaged(keep)?.state).toBe("staged");
    expect(s.getGrowStaged(pub)?.state).toBe("publishing");
    expect(s.getGrowStaged(other)?.state).toBe("staged");
    expect(s.supersedeGrowStaged("unit-convert", null, "undone", LATER)).toBe(1);
    expect(s.getGrowStaged(keep)).toMatchObject({ state: "failed", code: "undone" });
  });

  it("unclaimGrowReview restores the attempt count", () => {
    const s = mem(); const id = staged(s);
    s.claimGrowReview(id, NOW);
    expect(s.getGrowStaged(id)).toMatchObject({ attempts: 1, claimed_at: NOW });
    s.unclaimGrowReview(id);
    expect(s.getGrowStaged(id)).toMatchObject({ attempts: 0, claimed_at: null });
  });

  it("getPassingGrowReview returns nothing for a failing review, another staged id, or another content hash", () => {
    const s = mem(); const id = staged(s); const other = staged(s, "other");
    s.insertGrowReview(review(id, { pass: false, code: "unsafe" }));
    expect(s.getPassingGrowReview(id, "h1")).toBeUndefined();
    const pass = s.insertGrowReview(review(id));
    expect(s.getPassingGrowReview(id, "h1")).toMatchObject({ id: pass, pass: true });
    expect(s.getPassingGrowReview(other, "h1")).toBeUndefined();
    expect(s.getPassingGrowReview(id, "h2")).toBeUndefined();
    expect(s.listGrowReviews("unit-convert").map((r) => r.pass)).toEqual([false, true]);
  });

  it("enqueueGrowRequest is once-only per key and finishGrowRequest removes it from dueGrowRequests", () => {
    const s = mem();
    const req = { idempotency_key: "k1", kind: "undo" as const, name: "unit-convert", reason: "bad", chat_id: "555", now: NOW };
    expect(s.enqueueGrowRequest(req)).toBe(true);
    expect(s.enqueueGrowRequest(req)).toBe(false);
    const due = s.dueGrowRequests();
    expect(due).toMatchObject([{ idempotency_key: "k1", kind: "undo", state: "queued", reason: "bad" }]);
    s.finishGrowRequest(due[0]!.id, "undone", LATER);
    expect(s.dueGrowRequests()).toEqual([]);
  });

  it("request states only move forward: finishing a replied request or replying to a queued one changes nothing", () => {
    const s = mem();
    s.enqueueGrowRequest({ idempotency_key: "k1", kind: "undo", name: "n", reason: null, chat_id: null, now: NOW });
    const id = s.dueGrowRequests()[0]!.id;
    s.markGrowRequestReplied(id, LATER);
    expect(s.dueGrowRequests().map((r) => r.id)).toEqual([id]);
    s.finishGrowRequest(id, "ok", LATER); s.markGrowRequestReplied(id, LATER);
    s.finishGrowRequest(id, "again", LATER);
    expect(s.doneGrowRequests()).toEqual([]);
    expect(s.dueGrowRequests()).toEqual([]);
  });

  it("a finished request appears in doneGrowRequests and leaves it once replied", () => {
    const s = mem();
    s.enqueueGrowRequest({ idempotency_key: "k1", kind: "adopt", name: "n", reason: null, chat_id: null, now: NOW });
    const id = s.dueGrowRequests()[0]!.id;
    expect(s.doneGrowRequests()).toEqual([]);
    s.finishGrowRequest(id, "adopted", LATER);
    expect(s.doneGrowRequests()).toMatchObject([{ id, state: "done", result: "adopted", done_at: LATER }]);
    s.markGrowRequestReplied(id, LATER);
    expect(s.doneGrowRequests()).toEqual([]);
    expect(s.dueGrowRequests()).toEqual([]);
  });

  it("the mark is set once and survives a second mark; unmark removes it", () => {
    const s = mem();
    expect(s.isGrowMarked("n")).toBe(false);
    s.markGrowName("n", NOW); s.markGrowName("n", LATER);
    expect(s.isGrowMarked("n")).toBe(true);
    s.unmarkGrowName("n");
    expect(s.isGrowMarked("n")).toBe(false);
  });

  it("setGrowStagedOrigin touches only pending rows of that name", () => {
    const s = mem();
    const a = staged(s); const b = staged(s); const done = staged(s); const other = staged(s, "other");
    s.patchGrowStaged(b, { state: "approved" }, NOW);
    s.patchGrowStaged(done, { state: "failed" }, NOW);
    expect(s.setGrowStagedOrigin("unit-convert", "untrusted", LATER)).toBe(2);
    expect(s.getGrowStaged(a)?.origin).toBe("untrusted");
    expect(s.getGrowStaged(b)?.origin).toBe("untrusted");
    expect(s.getGrowStaged(done)?.origin).toBe("clean");
    expect(s.getGrowStaged(other)?.origin).toBe("clean");
  });

  it("events list ascending, newest option returns the newest rows still ascending, and counts by action since", () => {
    const s = mem();
    const ev = (name: string, at: string, action: "submit" | "publish" = "submit") =>
      s.appendGrowEvent({ at, run_id: null, chat_id: "555", name, action, result: "ok", code: null, reviewer_model: null, commit_id: null });
    const a = ev("a", NOW); const b = ev("b", NOW, "publish"); const c = ev("c", LATER);
    expect(s.listGrowEvents({}).map((e) => e.id)).toEqual([a, b, c]);
    expect(s.listGrowEvents({ limit: 2, newest: true }).map((e) => e.id)).toEqual([b, c]);
    expect(s.listGrowEvents({ sinceId: a }).map((e) => e.id)).toEqual([b, c]);
    expect(s.countGrowEventsSince("submit", LATER)).toBe(1);
    expect(s.listGrowEvents({ limit: 2 }).map((e) => e.id)).toEqual([a, b]);
  });

  it("the context cursor is 0 until set, then holds the last value set, per chat", () => {
    const s = mem();
    expect(s.getGrowContextCursor("555")).toBe(0);
    s.setGrowContextCursor("555", 7); s.setGrowContextCursor("555", 9);
    expect(s.getGrowContextCursor("555")).toBe(9);
    expect(s.getGrowContextCursor("666")).toBe(0);
  });

  const op = (s: RunStore, id: string, over: Record<string, unknown> = {}) =>
    s.insertGrowOp({ id, kind: "publish", source: "submit", name: "unit-convert", staged_id: null, request_id: null, target_json: null, reason: null, undo_version_id: null, now: NOW, ...over });

  it("a pending operation is listed oldest first until finished, and finishing twice changes nothing", () => {
    const s = mem();
    expect(op(s, "op1")).toMatchObject({ id: "op1", state: "pending", failures: 0, commit_id: null });
    op(s, "op2", { now: LATER }); op(s, "op3", { name: "other", now: NOW });
    expect(s.pendingGrowOps().map((o) => o.id)).toEqual(["op1", "op3", "op2"]);
    expect(s.pendingGrowOps("unit-convert").map((o) => o.id)).toEqual(["op1", "op2"]);
    s.finishGrowOp("op1", "done", "c1", LATER);
    expect(s.pendingGrowOps("unit-convert").map((o) => o.id)).toEqual(["op2"]);
    s.finishGrowOp("op1", "failed", "c2", "2026-11-10T11:00:00.000Z");
    expect(s.getGrowOp("op1")).toMatchObject({ state: "done", commit_id: "c1", updated_at: LATER });
  });

  it("a second operation for one request id is rejected, and getGrowOpByRequest finds it in any state", () => {
    const s = mem();
    op(s, "op1", { kind: "undo", source: "undo", request_id: 7 });
    expect(() => op(s, "op2", { request_id: 7 })).toThrow();
    s.finishGrowOp("op1", "failed", null, LATER);
    expect(s.getGrowOpByRequest(7)).toMatchObject({ id: "op1", state: "failed" });
    expect(s.getGrowOpByRequest(8)).toBeUndefined();
  });

  it("bumpGrowOpFailure returns the new count", () => {
    const s = mem(); op(s, "op1");
    expect(s.bumpGrowOpFailure("op1")).toBe(1);
    expect(s.bumpGrowOpFailure("op1")).toBe(2);
    expect(s.getGrowOp("op1")?.failures).toBe(2);
  });

  it("latest and previous versions skip undone ones, and one op id yields one version", () => {
    const s = mem();
    const v = (op_id: string) => s.insertGrowVersion({ name: "unit-convert", op_id, commit_id: `c-${op_id}`, content_hash: "h", fields_json: "{}", at: NOW });
    const a = v("o1"); const b = v("o2"); const c = v("o3");
    expect(s.latestGrowVersion("unit-convert")?.id).toBe(c);
    expect(s.previousGrowVersion("unit-convert", c)?.id).toBe(b);
    s.markGrowVersionUndone(c); s.markGrowVersionUndone(b);
    expect(s.latestGrowVersion("unit-convert")?.id).toBe(a);
    expect(s.previousGrowVersion("unit-convert", b)?.id).toBe(a);
    expect(s.previousGrowVersion("unit-convert", a)).toBeUndefined();
    expect(s.listGrowVersions("unit-convert").map((x) => x.undone)).toEqual([false, true, true]);
    expect(s.latestGrowVersion("nope")).toBeUndefined();
    expect(() => v("o1")).toThrow();
  });
});
