import { describe, expect, it, vi } from "vitest";
import { GROW_RETRY_AFTER_MS, runGrowTick } from "../../src/grow/tick.js";
import type { LlmResult } from "../../src/llm/types.js";
import { parseModelString } from "../../src/omp/model-string.js";
import { CLEAN, growFields, growSetup, PASS } from "../helpers/grow.js";

const chain = () => ["kimi-code/k3:high", "openai-codex/gpt-6.1-sol:high"].map(parseModelString);
const pass = async (): Promise<LlmResult> => ({ ok: true, provider: "kimi-code", model: "k3", answer: '{"pass":true,"findings":[]}' });
const reject = async (): Promise<LlmResult> => ({ ok: true, provider: "kimi-code", model: "k3", answer: '{"pass":false,"findings":[{"step":"2","problem":"wrong factor"}]}' });
const down = async (): Promise<LlmResult> => ({ ok: false, provider: "kimi-code", error: "quota" });
const NOW = "2026-11-10T11:00:00.000Z";

async function staged() {
  const s = await growSetup();
  await s.svc.submit(growFields(), CLEAN);
  const id = s.store.listGrowStaged()[0]!.id;
  const tick = (spawn: () => Promise<LlmResult>, o: { now?: string; env?: NodeJS.ProcessEnv; settled?: boolean; signal?: AbortSignal; families?: { families: string[]; unknown: boolean } } = {}) => {
    vi.spyOn(s.store, "runAuthorFamilies").mockReturnValue(o.families ?? { families: ["claude"], unknown: false });
    return runGrowTick({ store: s.store, svc: s.svc, env: o.env ?? {}, now: o.now ?? NOW, signal: o.signal ?? new AbortController().signal, chain, spawn, exemplar: async () => "EXEMPLAR", settled: () => o.settled ?? true });
  };
  return { ...s, id, tick };
}

describe("grow tick", () => {
  it("reviews a staged skill after its turn has ended, records the review, and publishes it on a pass", async () => {
    const s = await staged();
    expect(await s.tick(pass)).toEqual({ requests: 0, reviewed: s.id });
    expect(s.store.getGrowItem("unit-convert")?.state).toBe("live");
    expect(s.store.listGrowReviews("unit-convert")).toMatchObject([{ staged_id: s.id, pass: true, reviewer_model: "kimi-code/k3", author_families: "claude", undo_reasons_n: 0 }]);
    expect(s.store.listGrowReviews("unit-convert")[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not review while the authoring turn is still running", async () => {
    const s = await staged();
    expect((await s.tick(pass, { settled: false })).reviewed).toBeNull();
    expect(s.store.listGrowStaged("staged")).toHaveLength(1);
  });

  it("a rejected skill is failed with its findings, is not live, and leaves an outcome line for Houge", async () => {
    const s = await staged();
    await s.tick(reject);
    expect(s.store.getGrowItem("unit-convert")).toBeUndefined();
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ state: "failed", code: "review_failed" });
    expect(s.svc.readReview("unit-convert")).toMatchObject({ ok: true });
    expect(s.svc.contextNotes("555", "run_2")).toEqual(['grow: unit-convert failed review (grow_read it with what "review" to see why)']);
  });

  it("backs off 1 h, 6 h, 24 h on an outage, ends review_unavailable on the fourth, and is never offered again", async () => {
    const s = await staged();
    let now = NOW;
    for (const wait of GROW_RETRY_AFTER_MS) {
      await s.tick(down, { now });
      const row = s.store.getGrowStaged(s.id)!;
      expect(row.state).toBe("staged");
      expect(Date.parse(row.next_attempt_at!) - Date.parse(now)).toBe(wait);
      expect(row.claimed_at).toBeNull();
      now = row.next_attempt_at!;
    }
    await s.tick(down, { now });
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ state: "failed", code: "review_unavailable" });
    expect(s.store.getGrowItem("unit-convert")).toBeUndefined();
    expect(s.store.dueGrowReviews("2027-01-01T00:00:00.000Z")).toEqual([]);
    expect(s.store.listGrowReviews("unit-convert").at(-1)).toMatchObject({ pass: false, code: "review_unavailable" });
  });

  it("fails closed when the author's model family is unknown: an outage, never a pass", async () => {
    const s = await staged();
    const spawn = vi.fn(pass);
    await s.tick(spawn, { families: { families: [], unknown: true } });
    expect(spawn).not.toHaveBeenCalled();
    expect(s.store.getGrowStaged(s.id)?.state).toBe("staged");
  });

  it("a review cut short by shutdown frees the claim without using up a retry", async () => {
    const s = await staged();
    const ac = new AbortController();
    await s.tick(async () => { ac.abort(); return { ok: false, provider: "kimi-code", error: "shutdown", aborted: true }; }, { signal: ac.signal });
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ state: "staged", attempts: 0, claimed_at: null });
    expect(s.store.dueGrowReviews(NOW).map((r) => r.id)).toEqual([s.id]);
  });

  it("retries a review whose claim went stale (a crash or a restart mid-review)", async () => {
    const s = await staged();
    s.store.claimGrowReview(s.id, "2026-11-10T10:30:00.000Z");
    await s.tick(pass, { now: "2026-11-10T10:45:00.000Z" });
    expect(s.store.getGrowItem("unit-convert")?.state).toBe("live");
    expect(s.store.listGrowEvents({ actions: ["publish"] })).toHaveLength(1);
  });

  it("a dependency that throws is an outage: the row is backed off one hour and unclaimed, never stranded", async () => {
    const s = await staged();
    await s.tick(async () => { throw new Error("secret skill text"); });
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ state: "staged", claimed_at: null, next_attempt_at: new Date(Date.parse(NOW) + GROW_RETRY_AFTER_MS[0]).toISOString() });
  });

  it("starts no review when the switch is off, but still runs Paco's queued undo", async () => {
    const s = await staged();
    const spawn = vi.fn(pass);
    await s.live(growFields({ name: "other-skill", description: "another skill used to test the queue", body: "x ".repeat(200) }));
    s.store.enqueueGrowRequest({ idempotency_key: "tg:9", kind: "undo", name: "other-skill", reason: null, chat_id: "555", now: NOW });
    expect(await s.tick(spawn, { env: { HOUGE_GROW_ENABLED: "false" } })).toEqual({ requests: 1, reviewed: null });
    expect(spawn).not.toHaveBeenCalled();
    expect(s.store.getGrowItem("other-skill")?.state).toBe("removed");
    expect(s.store.getGrowStaged(s.id)?.state).toBe("staged");
  });

  it("with the switch off an approved row is not published: nothing new goes live", async () => {
    const s = await staged();
    await s.svc.submit(growFields({ name: "approved-one", description: "an approved but unpublished skill for the switch", body: "y ".repeat(200) }), CLEAN);
    const a = s.store.listGrowStaged("staged").find((r) => r.name === "approved-one")!;
    s.svc.recordReview(a.id, PASS);
    expect(s.store.getGrowStaged(a.id)?.state).toBe("approved");
    await s.tick(pass, { env: { HOUGE_GROW_ENABLED: "false" } });
    expect(s.store.getGrowStaged(a.id)?.state).toBe("approved");
    expect(s.store.getGrowItem("approved-one")).toBeUndefined();
  });

  it("a row whose authoring turn is still running does not block a settled one behind it; a row with no run is reviewable", async () => {
    const s = await staged();
    await s.svc.submit(growFields({ name: "second-skill", description: "second skill from another run", body: "z ".repeat(200) }), { ...CLEAN, run_id: "run_9" });
    const second = s.store.listGrowStaged("staged").find((r) => r.name === "second-skill")!;
    const settled = (id: string) => id !== "run_1";
    vi.spyOn(s.store, "runAuthorFamilies").mockReturnValue({ families: ["claude"], unknown: false });
    const r = await runGrowTick({ store: s.store, svc: s.svc, env: {}, now: NOW, signal: new AbortController().signal, chain, spawn: pass, exemplar: async () => "E", settled });
    expect(r.reviewed).toBe(second.id);
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ state: "staged", attempts: 0 });
    // a row with run_id null needs no settled check
    (s.store as unknown as { db: { prepare(q: string): { run(i: number): void } } }).db.prepare("UPDATE grow_staged SET run_id = NULL WHERE id = ?").run(s.id);
    const r2 = await runGrowTick({ store: s.store, svc: s.svc, env: {}, now: NOW, signal: new AbortController().signal, chain, spawn: async () => ({ ok: false, provider: "kimi-code", error: "q" }), exemplar: async () => "E", settled: () => false });
    expect(r2.reviewed).toBe(s.id);
  });

  it("each claim passes spawn its own correlation id, even at the same attempt number after a shutdown unclaim", async () => {
    const s = await staged();
    const ids: string[] = [];
    const ac = new AbortController();
    await s.tick(async (...a: unknown[]) => { ids.push((a[0] as { correlationId: string }).correlationId); ac.abort(); return { ok: false, provider: "kimi-code", error: "x", aborted: true }; }, { signal: ac.signal, now: NOW });
    await s.tick(async (...a: unknown[]) => { ids.push((a[0] as { correlationId: string }).correlationId); return { ok: false, provider: "kimi-code", error: "x" }; }, { now: "2026-11-10T11:05:00.000Z" });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("a database throw after the claim is an outage, not a claim stranded for ten minutes", async () => {
    const s = await staged();
    vi.spyOn(s.store, "listGrowUndoReasons").mockImplementation(() => { throw new Error("db locked"); });
    await s.tick(pass);
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ state: "staged", claimed_at: null, next_attempt_at: new Date(Date.parse(NOW) + GROW_RETRY_AFTER_MS[0]).toISOString() });
  });

  it("a runAuthorFamilies throw is an outage too", async () => {
    const s = await staged();
    const fam = vi.spyOn(s.store, "runAuthorFamilies").mockImplementation(() => { throw new Error("db locked"); });
    await runGrowTick({ store: s.store, svc: s.svc, env: {}, now: NOW, signal: new AbortController().signal, chain, spawn: pass, exemplar: async () => "E", settled: () => true });
    expect(fam).toHaveBeenCalled();
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ claimed_at: null, next_attempt_at: new Date(Date.parse(NOW) + GROW_RETRY_AFTER_MS[0]).toISOString() });
  });

  it("a publish that throws after a recorded pass does not reject the tick; the row stays approved", async () => {
    const s = await staged();
    vi.spyOn(s.svc, "publishStaged").mockRejectedValue(new Error("git exploded"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(s.tick(pass)).resolves.toEqual({ requests: 0, reviewed: s.id });
    expect(s.store.getGrowStaged(s.id)?.state).toBe("approved");
    expect(err.mock.calls.flat().join(" ")).toContain("[grow] tick: publish_failed");
    expect(err.mock.calls.flat().join(" ")).not.toContain("git exploded");
  });

  it("a thrown dependency logs only a code, never its message or the skill text", async () => {
    const s = await staged();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await s.tick(async () => { throw new Error("LEAKED-MESSAGE"); });
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).toContain("[grow]");
    expect(logged).not.toContain("LEAKED-MESSAGE");
    expect(logged).not.toContain("Step 1 of the procedure");
  });

  it("an unusable zone stops the tick before reconcile and review", async () => {
    const s = await staged();
    vi.spyOn(s.svc, "ensureZone").mockResolvedValue(false);
    const rec = vi.spyOn(s.svc, "reconcile");
    const spawn = vi.fn(pass);
    expect(await s.tick(spawn)).toEqual({ requests: 0, reviewed: null });
    expect(rec).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a signal already aborted starts no review", async () => {
    const s = await staged();
    const ac = new AbortController(); ac.abort();
    const spawn = vi.fn(pass);
    expect((await s.tick(spawn, { signal: ac.signal })).reviewed).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ attempts: 0, claimed_at: null });
  });

  it("a throw while shutting down restores the attempt instead of burning a retry", async () => {
    const s = await staged();
    const ac = new AbortController();
    await s.tick(async () => { ac.abort(); throw new Error("killed"); }, { signal: ac.signal });
    expect(s.store.getGrowStaged(s.id)).toMatchObject({ state: "staged", attempts: 0, claimed_at: null });
  });

  it("releases a claim older than ten minutes but not one nine minutes old", async () => {
    const s = await staged();
    s.store.claimGrowReview(s.id, "2026-11-10T10:51:00.000Z");   // 9 min before 11:00
    expect((await s.tick(pass, { settled: false })).reviewed).toBeNull();
    expect(s.store.getGrowStaged(s.id)?.claimed_at).not.toBeNull();
  });
});
