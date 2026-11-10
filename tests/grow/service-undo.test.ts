import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash, renderSkillFile, type GrowFields } from "../../src/grow/checks.js";
import { GrowService, trustItem } from "../../src/grow/service.js";
import { opMessage } from "../../src/grow/ops.js";
import { GrowZoneError } from "../../src/grow/zone.js";
import type { GrowOpRow, NotificationQueueResult, RunStore } from "../../src/run/run-store.js";
import { blockWrite, CLEAN, commitCount, countRows, growBody, growFields, growSetup, outboxTexts, PASS, small } from "../helpers/grow.js";

afterEach(() => { vi.restoreAllMocks(); });

type Setup = Awaited<ReturnType<typeof growSetup>>;
const UNTRUSTED = { ...CLEAN, level: "untrusted" as const };
const FAIL_REVIEW = { ...PASS, pass: false, findings: [{ step: "3", problem: "the step is vague" }], code: "review_failed" as const };
const rewrite = (f: GrowFields): GrowFields => ({ ...f, body: growBody(40, " in a new way") });
const other = (name: string, tag: string): GrowFields => growFields({ name, description: `a procedure about ${tag} for the tests here`, body: growBody(40, ` for ${tag}`) });
const stagedOf = (store: RunStore, name: string) => store.listGrowStaged().filter((r) => r.name === name);
const errSpy = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
const freshSvc = (s: Setup) => new GrowService({ store: s.store, zone: s.zone, env: {}, now: s.now });

/** v1 live, then a small edit live as v2. */
async function twoVersions(): Promise<Setup & { f: GrowFields }> {
  const s = await growSetup(); const f = growFields();
  await s.live(f);
  expect(await s.svc.submit(small(f), CLEAN)).toEqual({ status: "LIVE", name: f.name });
  return { ...s, f };
}
/** A reviewed row claimed by a publish operation that has not reached git. */
async function pendingPublish(s: Setup, f: GrowFields): Promise<GrowOpRow> {
  await s.svc.submit(f, CLEAN);
  const row = stagedOf(s.store, f.name).find((r) => r.state === "staged")!;
  s.svc.recordReview(row.id, PASS);
  return s.store.inTransaction(() => {
    s.store.patchGrowStaged(row.id, { state: "publishing" }, s.now());
    return s.store.insertGrowOp({ id: randomUUID(), kind: "publish", source: "submit", name: f.name, staged_id: row.id, request_id: null, target_json: row.fields_json, reason: null, undo_version_id: null, now: s.now() });
  });
}
function request(s: Setup, kind: "undo" | "adopt", name: string, key = `k-${name}-${kind}`): number {
  s.store.enqueueGrowRequest({ idempotency_key: key, kind, name, reason: kind === "undo" ? "wrong unit" : null, chat_id: "555", now: s.now() });
  return s.store.dueGrowRequests().find((r) => r.idempotency_key === key)!.id;
}
const requestRow = (store: RunStore, id: number) =>
  [...store.dueGrowRequests(), ...store.doneGrowRequests()].find((r) => r.id === id) ?? { id, state: "replied" as const };

describe("D. read and review text", () => {
  it("read returns the committed body under a name and When: header, counts one use per run, and reports the taint", async () => {
    const s = await growSetup(); const f = growFields();
    await s.live(f);
    expect(await s.svc.read(f.name, { run_id: "r1" })).toEqual({ ok: true, text: `# unit-convert\nWhen: ${f.description}\n\n${f.body}`, tainted: false });
    await s.svc.read(f.name, { run_id: "r1" });
    expect(s.store.getGrowItem(f.name)?.uses).toBe(1);
    await s.svc.read(f.name, { run_id: "r2" });
    expect(s.store.getGrowItem(f.name)?.uses).toBe(2);
    const g = other("web-notes", "web notes");
    await s.live(g, UNTRUSTED);
    expect(await s.svc.read(g.name, { run_id: "r1" })).toMatchObject({ ok: true, tainted: true });
    expect(await s.svc.read("missing-one", { run_id: "r1" })).toEqual({ ok: false, code: "unknown_skill" });
  });

  it("readReview gives the last failed row's findings, tainted by the mark, and 'no findings' for a dropped publish", async () => {
    const s = await growSetup(); const f = growFields();
    expect(s.svc.readReview(f.name)).toEqual({ ok: false, code: "no_review" });
    await s.svc.submit(f, UNTRUSTED);
    s.svc.recordReview(stagedOf(s.store, f.name)[0]!.id, FAIL_REVIEW);
    const r = s.svc.readReview(f.name);
    expect(r).toMatchObject({ ok: true, tainted: true });
    expect(r.ok && r.text).toContain("3: the step is vague");
    trustItem(s.store, f.name, s.now());
    expect(s.svc.readReview(f.name)).toMatchObject({ ok: true, tainted: false });
    // A newer submit superseded by a third is no review failure: the review's findings are still what is reported.
    await s.svc.submit(rewrite(f), CLEAN); await s.svc.submit({ ...f, body: growBody(40, " third") }, CLEAN);
    expect(s.svc.readReview(f.name)).toMatchObject({ ok: true, text: expect.stringContaining("the step is vague") });
    // Duplicate: failed when published, with no findings.
    const a = other("alpha-skill", "alpha"); const b = { ...a, name: "beta-skill", description: "the same alpha procedure under another name" };
    await s.svc.submit(a, CLEAN); await s.svc.submit(b, CLEAN);
    for (const row of s.store.listGrowStaged("staged").filter((x) => x.name !== f.name)) s.svc.recordReview(row.id, PASS);
    for (const row of s.store.listGrowStaged("approved")) await s.svc.publishStaged(row.id);
    const dup = s.svc.readReview("beta-skill");
    expect(dup).toMatchObject({ ok: true, text: expect.stringContaining("duplicate") });
    expect(dup.ok && dup.text).toContain("no findings");
  });
});

describe("E. undo and requests", () => {
  it("I8: undo steps back one version per call by the version list, stores the reason, and fails a pending submit", async () => {
    const s = await twoVersions(); const { f } = s;
    await s.svc.submit(rewrite(f), CLEAN);
    expect(await s.svc.undo(f.name, "too wordy")).toEqual({ ok: true, removed: false });
    expect(s.store.getGrowItem(f.name)).toMatchObject({ state: "live", content_hash: contentHash(f) });
    expect(await s.zone.readHead(f.name)).toBe(renderSkillFile(f, "clean"));
    expect(s.store.listGrowVersions(f.name).map((v) => v.undone)).toEqual([false, true]);
    expect(s.store.listGrowUndoReasons(f.name).map((r) => r.reason)).toEqual(["too wordy"]);
    expect(stagedOf(s.store, f.name).at(-1)).toMatchObject({ state: "failed", code: "undone" });
    expect(await s.svc.submit(small(f), CLEAN)).toEqual({ status: "STAGED", name: f.name });   // a name once undone is always reviewed
    expect(await s.svc.undo(f.name, null)).toEqual({ ok: true, removed: true });
    expect(s.store.getGrowItem(f.name)?.state).toBe("removed");
    expect(await s.zone.readHead(f.name)).toBeNull();
    expect(s.store.listGrowVersions(f.name).map((v) => v.undone)).toEqual([true, true]);
    expect(s.store.listGrowUndoReasons(f.name).map((r) => r.reason)).toEqual(["too wordy", "(no reason given)"]);
    expect(await s.svc.undo(f.name, null)).toEqual({ ok: false, code: "unknown_skill" });
  });

  it("I8: the same content published twice is two versions: undo keeps the content live, the next undo removes it", async () => {
    const s = await growSetup(); const f = growFields();
    await s.live(f);
    expect(await s.svc.submit(f, CLEAN)).toEqual({ status: "LIVE", name: f.name });
    expect(s.store.listGrowVersions(f.name)).toHaveLength(2);
    expect(await s.svc.undo(f.name, null)).toEqual({ ok: true, removed: false });
    expect(s.store.listGrowVersions(f.name).map((v) => v.undone)).toEqual([false, true]);
    expect(s.store.getGrowItem(f.name)).toMatchObject({ state: "live", content_hash: contentHash(f) });
    expect(await s.svc.undo(f.name, null)).toEqual({ ok: true, removed: true });
  });

  it("an exemplar cannot be undone; an adopted item with no version rows is removed by undo", async () => {
    const s = await growSetup();
    const ex = other("option-comparison", "options");
    await s.svc.seed(ex, "exemplar", "seed");
    expect(await s.svc.undo(ex.name, null)).toEqual({ ok: false, code: "is_exemplar" });
    const g = other("stray-skill", "strays");
    await s.zone.writeAndCommit(g.name, renderSkillFile(g, "clean"), "skill(stray-skill): by hand");
    await s.svc.syncWithHead();
    expect(s.svc.adopt(g.name)).toBe(true);
    expect(s.store.listGrowVersions(g.name)).toEqual([]);
    expect(await s.svc.undo(g.name, null)).toEqual({ ok: true, removed: true });
    expect(s.store.getGrowItem(g.name)?.state).toBe("removed");
    expect(await s.zone.readHead(g.name)).toBeNull();
  });

  it("I2: undo cancels a pending publish whose commit is positively absent; reconcile then publishes nothing", async () => {
    const s = await growSetup(); const f = growFields();
    await s.live(f);
    const op = await pendingPublish(s, rewrite(f));
    expect(await s.svc.undo(f.name, null)).toEqual({ ok: true, removed: true });
    expect(s.store.getGrowOp(op.id)?.state).toBe("failed");
    expect(s.store.getGrowStaged(op.staged_id!)).toMatchObject({ state: "failed", code: "undone" });
    const n = commitCount(s.zone);
    await s.svc.reconcile(true);
    expect(commitCount(s.zone)).toBe(n);
    expect(s.store.getGrowItem(f.name)?.state).toBe("removed");
  });

  it("I2: undo first finishes a pending publish whose commit exists, then undoes that version", async () => {
    const s = await growSetup(); const f = growFields();
    await s.live(f);
    const g = rewrite(f);
    const op = await pendingPublish(s, g);
    await s.zone.writeAndCommit(f.name, renderSkillFile(g, "clean"), opMessage(op, "update"));
    expect(await s.svc.undo(f.name, null)).toEqual({ ok: true, removed: false });
    expect(s.store.getGrowOp(op.id)?.state).toBe("done");
    expect(s.store.listGrowVersions(f.name).map((v) => [v.content_hash, v.undone])).toEqual([[contentHash(f), false], [contentHash(g), true]]);
    expect(s.store.getGrowItem(f.name)?.content_hash).toBe(contentHash(f));
  });

  it("I2: a lookup error is not 'absent': undo answers zone_unavailable and the pending publish is untouched", async () => {
    const s = await growSetup(); const f = growFields(); const err = errSpy();
    await s.live(f);
    const op = await pendingPublish(s, rewrite(f));
    vi.spyOn(s.zone, "findOpCommit").mockRejectedValue(new GrowZoneError("git_failed"));
    expect(await s.svc.undo(f.name, null)).toEqual({ ok: false, code: "zone_unavailable" });
    expect(s.store.getGrowOp(op.id)).toMatchObject({ state: "pending", failures: 0 });
    expect(s.store.getGrowStaged(op.staged_id!)?.state).toBe("publishing");
    expect(s.store.getGrowItem(f.name)?.state).toBe("live");
    expect(err).toHaveBeenCalledWith("[grow] undo: zone_unavailable");
    expect(s.svc.disabledReason()).toBe("zone_unavailable");             // a git fault on the undo path latches the door
  });

  it("I7: an undo request queues once, runs once, and is replied to once", async () => {
    const s = await growSetup(); const f = growFields();
    await s.live(f);
    const id = request(s, "undo", f.name, "tg:1");
    s.store.enqueueGrowRequest({ idempotency_key: "tg:1", kind: "undo", name: f.name, reason: "again", chat_id: "555", now: s.now() });
    expect(s.store.dueGrowRequests()).toHaveLength(1);
    expect(await s.svc.runRequests()).toBe(1);
    expect(s.store.getGrowItem(f.name)?.state).toBe("removed");
    expect(requestRow(s.store, id).state).toBe("replied");
    expect(outboxTexts(s.store, `grow:req:${id}`)).toEqual(["↩️ unit-convert removed. Its next version will be reviewed."]);
    expect(s.store.getGrowOpByRequest(id)).toMatchObject({ state: "done", kind: "undo" });
    expect(await s.svc.runRequests()).toBe(0);
    expect(s.store.countNotificationsByIdempotencyKey(`grow:req:${id}`)).toBe(1);
  });

  it("I7: a crash after the undo's commit is completed by a fresh service once, with no new commit", async () => {
    const s = await twoVersions(); const { f } = s;
    const id = request(s, "undo", f.name);
    const [v1, v2] = s.store.listGrowVersions(f.name);
    const op = s.store.insertGrowOp({ id: randomUUID(), kind: "undo", source: "undo", name: f.name, staged_id: null, request_id: id, target_json: v1!.fields_json, reason: "wrong unit", undo_version_id: v2!.id, now: s.now() });
    await s.zone.writeAndCommit(f.name, renderSkillFile(f, "clean"), opMessage(op, "undo"));
    const n = commitCount(s.zone);
    expect(await freshSvc(s).runRequests()).toBe(1);
    expect(commitCount(s.zone)).toBe(n);
    expect(s.store.listGrowVersions(f.name).map((v) => v.undone)).toEqual([false, true]);
    expect(s.store.listGrowUndoReasons(f.name)).toHaveLength(1);
    expect(outboxTexts(s.store, `grow:req:${id}`)).toEqual(["↩️ unit-convert restored to its previous version. Its next version will be reviewed."]);
    expect(countRows(s.store, "grow_ops")).toBe(3);                    // two publishes and this undo: no second undo
  });

  it("I7: a request becomes replied only when its reply is in the outbox", async () => {
    const s = await growSetup(); const f = growFields(); const err = errSpy();
    await s.live(f);
    const id = request(s, "undo", f.name);
    const orig = s.store.enqueueNotification.bind(s.store);
    let conflicted = false;
    vi.spyOn(s.store, "enqueueNotification").mockImplementation((intent) => {
      if (intent.topic === "reply" && !conflicted) { conflicted = true; return { status: "conflict", error: "x" } satisfies NotificationQueueResult; }
      return orig(intent);
    });
    expect(await s.svc.runRequests()).toBe(1);
    expect(requestRow(s.store, id).state).toBe("done");
    expect(s.store.countNotificationsByIdempotencyKey(`grow:req:${id}`)).toBe(0);
    expect(await s.svc.runRequests()).toBe(0);
    expect(requestRow(s.store, id).state).toBe("replied");
    expect(s.store.countNotificationsByIdempotencyKey(`grow:req:${id}`)).toBe(1);
    expect(err.mock.calls.map((c) => c[0])).toEqual(["[grow] requests: reply_conflict"]);
  });

  it("a throw while listing finished requests is logged and does not reject runRequests", async () => {
    const s = await growSetup(); const err = errSpy();
    vi.spyOn(s.store, "doneGrowRequests").mockImplementationOnce(() => { throw new Error("disk"); });
    expect(await s.svc.runRequests()).toBe(0);
    expect(err).toHaveBeenCalledWith("[grow] requests: reply_failed");
  });

  it("I8: an undo that settles a pending undo of the name answers that one and steps back no further", async () => {
    const s = await twoVersions(); const { f } = s;
    const [v1, v2] = s.store.listGrowVersions(f.name);
    const pendingUndo = s.store.insertGrowOp({ id: randomUUID(), kind: "undo", source: "undo", name: f.name, staged_id: null, request_id: null, target_json: v1!.fields_json, reason: "first", undo_version_id: v2!.id, now: s.now() });
    const ops = countRows(s.store, "grow_ops");
    expect(await s.svc.undo(f.name, "second")).toEqual({ ok: true, removed: false });
    expect(s.store.getGrowOp(pendingUndo.id)?.state).toBe("done");
    expect(countRows(s.store, "grow_ops")).toBe(ops);
    expect(s.store.getGrowItem(f.name)).toMatchObject({ state: "live", content_hash: contentHash(f) });
    expect(s.store.listGrowVersions(f.name).map((v) => v.undone)).toEqual([false, true]);
  });

  it("an undo while the door is latched answers zone_unavailable at once and creates nothing", async () => {
    const s = await growSetup(); const f = growFields(); const err = errSpy();
    await s.live(f);
    const { rmSync } = await import("node:fs"); const { join } = await import("node:path");
    rmSync(join(s.zone.dir, ".git"), { recursive: true, force: true });
    await s.svc.submit(other("x-skill", "x"), CLEAN);                    // latches the door
    expect(s.svc.disabledReason()).toBe("zone_unavailable");
    const ops = countRows(s.store, "grow_ops");
    const lookup = vi.spyOn(s.zone, "findOpCommit");
    expect(await s.svc.undo(f.name, null)).toEqual({ ok: false, code: "zone_unavailable" });
    expect(countRows(s.store, "grow_ops")).toBe(ops);
    expect(lookup).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("[grow] submit: zone_unavailable");
  });

  it("I7: an undo request whose write fails for good ends done with the zone text, is counted, and is replied once", async () => {
    const s = await twoVersions(); const { f } = s; const err = errSpy();
    const id = request(s, "undo", f.name);
    const { rmSync } = await import("node:fs"); const { join } = await import("node:path");
    // The restore of v1 must fail before its commit: the skill's folder becomes a plain file, so the write cannot land.
    const block = () => { rmSync(join(s.zone.dir, "skills", f.name), { recursive: true, force: true }); blockWrite(s.zone, f.name); };
    block();
    expect(await s.svc.runRequests()).toBe(0);                           // first failure: retry, the request stays queued
    expect(requestRow(s.store, id).state).toBe("queued");
    block();
    expect(await s.svc.runRequests()).toBe(1);
    expect(s.store.getGrowOpByRequest(id)?.state).toBe("failed");
    expect(outboxTexts(s.store, `grow:req:${id}`)).toEqual(["The grow zone could not be written. See /status."]);
    expect(requestRow(s.store, id).state).toBe("replied");
    expect(await s.svc.runRequests()).toBe(0);
    expect(s.store.countNotificationsByIdempotencyKey(`grow:req:${id}`)).toBe(1);
    expect(err).toHaveBeenCalledWith("[grow] op: write_failed");
  });

  it("I7: an undo whose database half throws after its commit stays queued and is completed once by the next run", async () => {
    const s = await twoVersions(); const { f } = s; const err = errSpy();
    const id = request(s, "undo", f.name);
    vi.spyOn(s.store, "markGrowVersionUndone").mockImplementationOnce(() => { throw new Error("disk"); });
    expect(await s.svc.runRequests()).toBe(0);
    const op = s.store.getGrowOpByRequest(id)!;
    expect(op.state).toBe("pending");
    expect(requestRow(s.store, id)).toMatchObject({ state: "queued", result: null });
    const n = commitCount(s.zone);
    expect(await s.svc.runRequests()).toBe(1);
    expect(commitCount(s.zone)).toBe(n);
    expect(s.store.getGrowOp(op.id)?.state).toBe("done");
    expect(s.store.listGrowUndoReasons(f.name)).toHaveLength(1);
    expect(outboxTexts(s.store, `grow:req:${id}`)).toHaveLength(1);
    expect(err).toHaveBeenCalledWith("[grow] undo: zone_unavailable");
  });

  it("I7: a request whose own undo is already done is never answered by running another pending undo of the name", async () => {
    const s = await twoVersions(); const { f } = s; const err = errSpy();
    const id = request(s, "undo", f.name);
    const mine = s.store.insertGrowOp({ id: randomUUID(), kind: "undo", source: "undo", name: f.name, staged_id: null, request_id: id, target_json: null, reason: null, undo_version_id: null, now: s.now() });
    s.store.finishGrowOp(mine.id, "done", "c0ffee", s.now());
    const otherUndo = s.store.insertGrowOp({ id: randomUUID(), kind: "undo", source: "undo", name: f.name, staged_id: null, request_id: null, target_json: null, reason: null, undo_version_id: null, now: s.now() });
    const n = commitCount(s.zone);
    // A done operation whose request is still queued cannot arise (applyUndo finishes both in one transaction); it is
    // reported, and the request is never finished outside its operation's transaction or by another operation.
    expect(await s.svc.runRequests()).toBe(0);
    expect(s.store.getGrowOp(otherUndo.id)?.state).toBe("pending");
    expect(commitCount(s.zone)).toBe(n);
    expect(requestRow(s.store, id).state).toBe("queued");
    expect(err).toHaveBeenCalledWith("[grow] requests: done_op_queued");
  });

  /** v1, v2, v3 live: three versions to step back through. */
  async function threeVersions(): Promise<Setup & { f: GrowFields; v: Array<{ id: number; fields_json: string; content_hash: string }> }> {
    const s = await twoVersions(); const { f } = s;
    const v3 = { ...f, body: small(f).body.replace("Step 5 of", "Step five of") };
    expect(await s.svc.submit(v3, CLEAN)).toEqual({ status: "LIVE", name: f.name });
    return { ...s, v: s.store.listGrowVersions(f.name) };
  }
  /** The finishGrowRequest calls, each with whether it ran inside a store transaction. */
  function watchFinishes(store: RunStore): Array<{ id: number; inTx: boolean }> {
    const calls: Array<{ id: number; inTx: boolean }> = [];
    const orig = store.finishGrowRequest.bind(store);
    vi.spyOn(store, "finishGrowRequest").mockImplementation((id, result, now) => {
      calls.push({ id, inTx: (store as unknown as { outerTxDepth: number }).outerTxDepth > 0 });
      orig(id, result, now);
    });
    return calls;
  }

  it("I8: a direct undo while a request's undo is pending finishes that request's step, then takes its own", async () => {
    const s = await threeVersions(); const { f, v } = s;
    const r1 = request(s, "undo", f.name);
    s.store.insertGrowOp({ id: randomUUID(), kind: "undo", source: "undo", name: f.name, staged_id: null, request_id: r1, target_json: v[1]!.fields_json, reason: "r1 reason", undo_version_id: v[2]!.id, now: s.now() });
    const finishes = watchFinishes(s.store);
    expect(await s.svc.undo(f.name, "direct reason")).toEqual({ ok: true, removed: false });
    expect(s.store.getGrowItem(f.name)?.content_hash).toBe(v[0]!.content_hash);    // two steps: v3 → v2 (R1) → v1 (this call)
    expect(s.store.listGrowVersions(f.name).map((x) => x.undone)).toEqual([false, true, true]);
    expect(s.store.listGrowUndoReasons(f.name).map((x) => x.reason)).toEqual(["r1 reason", "direct reason"]);
    expect(requestRow(s.store, r1)).toMatchObject({ state: "done", result: "↩️ unit-convert restored to its previous version. Its next version will be reviewed." });
    expect(finishes).toEqual([{ id: r1, inTx: true }]);
  });

  it("I7 + I8: a second request while the first request's undo is pending: each finished once in its own transaction, two steps back", async () => {
    const s = await threeVersions(); const { f, v } = s;
    const r1 = request(s, "undo", f.name, "k1");
    s.store.insertGrowOp({ id: randomUUID(), kind: "undo", source: "undo", name: f.name, staged_id: null, request_id: r1, target_json: v[1]!.fields_json, reason: "r1 reason", undo_version_id: v[2]!.id, now: s.now() });
    s.store.enqueueGrowRequest({ idempotency_key: "k2", kind: "undo", name: f.name, reason: "r2 reason", chat_id: "555", now: s.now() });
    const r2 = s.store.dueGrowRequests().find((r) => r.idempotency_key === "k2")!.id;
    const finishes = watchFinishes(s.store);
    expect(await s.svc.undo(f.name, "r2 reason", r2)).toEqual({ ok: true, removed: false });
    expect(s.store.getGrowOpByRequest(r2)).toMatchObject({ state: "done", kind: "undo" });
    expect(s.store.getGrowItem(f.name)?.content_hash).toBe(v[0]!.content_hash);
    expect(s.store.listGrowUndoReasons(f.name).map((x) => x.reason)).toEqual(["r1 reason", "r2 reason"]);
    expect(finishes).toEqual([{ id: r1, inTx: true }, { id: r2, inTx: true }]);
    expect(await s.svc.runRequests()).toBe(0);                          // both already finished; this run only replies
    expect(outboxTexts(s.store, `grow:req:${r1}`)).toHaveLength(1);
    expect(outboxTexts(s.store, `grow:req:${r2}`)).toHaveLength(1);
    expect([requestRow(s.store, r1).state, requestRow(s.store, r2).state]).toEqual(["replied", "replied"]);
    expect(await s.svc.runRequests()).toBe(0);
    expect(s.store.countNotificationsByIdempotencyKey(`grow:req:${r1}`) + s.store.countNotificationsByIdempotencyKey(`grow:req:${r2}`)).toBe(2);
    expect(finishes).toHaveLength(2);
  });

  it("adopt changes the item, marks the name, writes the event and finishes the request in one transaction", async () => {
    const s = await growSetup();
    const g = other("stray-skill", "strays");
    await s.zone.writeAndCommit(g.name, renderSkillFile(g, "clean"), "skill(stray-skill): by hand");
    await s.svc.syncWithHead();
    s.store.unmarkGrowName(g.name);                                     // so the mark adopt sets is observable
    const id = request(s, "adopt", g.name);
    vi.spyOn(s.store, "appendGrowEvent").mockImplementationOnce(() => { throw new Error("disk"); });
    expect(() => s.svc.adopt(g.name, id)).toThrow("disk");
    expect(s.store.getGrowItem(g.name)?.state).toBe("orphan");
    expect(s.store.isGrowMarked(g.name)).toBe(false);
    expect(requestRow(s.store, id).state).toBe("queued");
    expect(s.svc.adopt(g.name, id)).toBe(true);
    expect(s.store.isGrowMarked(g.name)).toBe(true);
    expect(s.store.listGrowEvents({ actions: ["adopt"] })).toHaveLength(1);
    expect(requestRow(s.store, id)).toMatchObject({ state: "done", result: "✅ stray-skill adopted; it reads as outside content until you trust it." });
    expect(s.svc.adopt(g.name)).toBe(false);
    const none = request(s, "adopt", "nothing-here");
    expect(await s.svc.runRequests()).toBe(1);
    expect(outboxTexts(s.store, `grow:req:${none}`)).toEqual(["Nothing to adopt under nothing-here."]);
  });

  it("an adopt request whose transaction throws stays queued, the run goes on, and the failure is logged", async () => {
    const s = await growSetup(); const err = errSpy();
    const g = other("stray-skill", "strays");
    await s.zone.writeAndCommit(g.name, renderSkillFile(g, "clean"), "skill(stray-skill): by hand");
    await s.svc.syncWithHead();
    const id = request(s, "adopt", g.name);
    vi.spyOn(s.store, "appendGrowEvent").mockImplementationOnce(() => { throw new Error("disk"); });
    expect(await s.svc.runRequests()).toBe(0);
    expect(requestRow(s.store, id).state).toBe("queued");
    expect(err).toHaveBeenCalledWith("[grow] requests: adopt_failed");
    expect(await s.svc.runRequests()).toBe(1);
    expect(s.store.getGrowItem(g.name)?.state).toBe("live");
  });
});

describe("F. sync, index, notes", () => {
  it("syncWithHead: origin-line-only differences change nothing; strays become orphans; missing files are removed; changed files are untrusted", async () => {
    const s = await growSetup();
    const f = growFields(); const gone = other("gone-skill", "gone"); const changed = other("changed-skill", "changes");
    for (const x of [f, gone, changed]) await s.live(x);
    await s.zone.writeAndCommit(f.name, renderSkillFile(f, "untrusted"), "skill(unit-convert): origin line only");
    const stray = other("stray-skill", "strays");
    await s.zone.writeAndCommit(stray.name, renderSkillFile(stray, "clean"), "skill(stray-skill): by hand");
    await s.zone.removeAndCommit(gone.name, "skill(gone-skill): by hand");
    const edit = { ...changed, description: "a changed description written outside Houge", body: growBody(40, " edited by hand") };
    await s.zone.writeAndCommit(changed.name, renderSkillFile(edit, "clean"), "skill(changed-skill): by hand");
    expect(await s.svc.syncWithHead()).toEqual({ orphans: 1, removed: 1, changed: 1 });
    expect(s.store.getGrowItem(f.name)).toMatchObject({ state: "live", origin: "clean" });
    expect(s.store.isGrowMarked(f.name)).toBe(false);
    expect(s.store.getGrowItem(stray.name)).toMatchObject({ state: "orphan", origin: "untrusted", content_hash: contentHash(stray) });
    expect(s.store.isGrowMarked(stray.name)).toBe(true);
    expect(s.store.getGrowItem(gone.name)?.state).toBe("removed");
    expect(s.store.getGrowItem(changed.name)).toMatchObject({ state: "live", origin: "untrusted", content_hash: contentHash(edit), description: edit.description, head_commit: await s.zone.head() });
    expect(s.store.isGrowMarked(changed.name)).toBe(true);
    expect(await s.svc.syncWithHead()).toEqual({ orphans: 0, removed: 0, changed: 0 });
  });

  it("syncWithHead leaves a name with a pending operation alone: its commit is not an outside edit", async () => {
    const s = await growSetup(); const f = growFields();
    await s.live(f);
    const g = rewrite(f);
    const op = await pendingPublish(s, g);
    await s.zone.writeAndCommit(f.name, renderSkillFile(g, "clean"), opMessage(op, "update"));
    expect(await s.svc.syncWithHead()).toEqual({ orphans: 0, removed: 0, changed: 0 });
    expect(s.store.isGrowMarked(f.name)).toBe(false);
    await s.svc.reconcile(true);
    expect(s.store.getGrowItem(f.name)).toMatchObject({ origin: "clean", content_hash: contentHash(g) });
  });

  it("adopt makes an orphan live and untrusted, and the index then lists it", async () => {
    const s = await growSetup();
    const g = other("stray-skill", "strays");
    await s.zone.writeAndCommit(g.name, renderSkillFile(g, "clean"), "skill(stray-skill): by hand");
    await s.svc.syncWithHead();
    expect(s.svc.indexBlock() ?? "").not.toContain("stray-skill");
    expect(s.svc.adopt(g.name)).toBe(true);
    expect(s.store.getGrowItem(g.name)).toMatchObject({ state: "live", origin: "untrusted" });
    expect(s.svc.indexBlock()).toContain(`- stray-skill — ${g.description}`);
  });

  it("outcome lines go to the writing chat until a turn that carried them commits, and never to another chat", async () => {
    const s = await growSetup(); const f = growFields();
    await s.svc.submit(f, CLEAN);
    s.svc.recordReview(stagedOf(s.store, f.name)[0]!.id, FAIL_REVIEW);
    const failed = 'grow: unit-convert failed review (grow_read it with what "review" to see why)';
    expect(s.svc.contextNotes("555", "run_2")).toEqual([failed]);
    expect(s.svc.contextNotes("777", "run_3")).toEqual([]);
    expect(s.svc.contextNotes("555", "run_4")).toEqual([failed]);          // run_2 never committed
    s.svc.commitNotes("run_4");
    expect(s.svc.contextNotes("555", "run_5")).toEqual([]);
    await s.live(other("web-notes", "web notes"));
    await s.svc.submit(rewrite(other("web-notes", "web notes")), CLEAN);   // a superseded row is no outcome
    await s.svc.submit({ ...other("web-notes", "web notes"), body: growBody(40, " third") }, CLEAN);
    s.store.recordGrowHint({ idempotency_key: "h1", chat_id: "555", category: "unit_math", turn_ids: ["t1"], decision_id: "d1", now: s.now() });
    expect(s.svc.contextNotes("555", "run_6")).toEqual(["grow: web-notes is live", "grow: a task of kind unit_math keeps recurring; consider grow_submit"]);
    s.svc.commitNotes("run_6");
    s.svc.commitNotes("run_6");
    expect(s.svc.contextNotes("555", "run_7")).toEqual([]);
  });

  it("syncWithHead leaves exemplars to the seeder, and the seeder restores a removed exemplar", async () => {
    const s = await growSetup();
    const ex = other("option-comparison", "options");
    expect(await s.svc.seed(ex, "exemplar", "seed")).toBe("published");
    await s.zone.writeAndCommit(ex.name, renderSkillFile({ ...ex, body: growBody(40, " edited") }, "exemplar"), "skill(option-comparison): by hand");
    expect(await s.svc.syncWithHead()).toEqual({ orphans: 0, removed: 0, changed: 0 });
    expect(s.store.getGrowItem(ex.name)).toMatchObject({ state: "live", origin: "exemplar", content_hash: contentHash(ex) });
    expect(s.store.isGrowMarked(ex.name)).toBe(false);
    await s.zone.removeAndCommit(ex.name, "skill(option-comparison): removed by hand");
    expect(await s.svc.syncWithHead()).toEqual({ orphans: 0, removed: 0, changed: 0 });
    s.store.setGrowItemState(ex.name, "removed", s.now());              // as an older build's sync left it
    expect(await s.svc.seed(ex, "exemplar", "seed")).toBe("published");
    expect(s.store.getGrowItem(ex.name)).toMatchObject({ state: "live", origin: "exemplar" });
    expect(await s.zone.readHead(ex.name)).toBe(renderSkillFile(ex, "exemplar"));
    expect(await s.svc.seed(ex, "exemplar", "seed")).toBe("unchanged");
  });

  it("the seeder restores an exemplar removed or edited by hand at HEAD, and publishes changed exemplar content", async () => {
    const s = await growSetup();
    const ex = other("option-comparison", "options");
    await s.svc.seed(ex, "exemplar", "seed");
    await s.zone.removeAndCommit(ex.name, "skill(option-comparison): removed by hand");
    expect(s.store.getGrowItem(ex.name)?.state).toBe("live");            // the row alone still says live
    expect(await s.svc.seed(ex, "exemplar", "seed")).toBe("published");
    expect(await s.zone.readHead(ex.name)).toBe(renderSkillFile(ex, "exemplar"));
    await s.zone.writeAndCommit(ex.name, renderSkillFile({ ...ex, body: growBody(40, " edited") }, "exemplar"), "skill(option-comparison): edited by hand");
    expect(await s.svc.seed(ex, "exemplar", "seed")).toBe("published");
    expect(await s.zone.readHead(ex.name)).toBe(renderSkillFile(ex, "exemplar"));
    const n = commitCount(s.zone);
    expect(await s.svc.seed(ex, "exemplar", "seed")).toBe("unchanged");
    expect(commitCount(s.zone)).toBe(n);
    const next = { ...ex, body: growBody(40, " in the new release") };
    expect(await s.svc.seed(next, "exemplar", "seed")).toBe("published");
    expect(s.store.getGrowItem(ex.name)).toMatchObject({ state: "live", origin: "exemplar", content_hash: contentHash(next) });
    expect(await s.zone.readHead(ex.name)).toBe(renderSkillFile(next, "exemplar"));
  });

  it("the index is alphabetical and byte-identical after a read", async () => {
    const s = await growSetup();
    await s.live(other("zebra-skill", "zebras")); await s.live(other("alpha-skill", "alphas"));
    const before = s.svc.indexBlock()!;
    expect(before.indexOf("- alpha-skill")).toBeLessThan(before.indexOf("- zebra-skill"));
    await s.svc.read("zebra-skill", { run_id: "r1" });
    expect(s.svc.indexBlock()).toBe(before);
  });
});
