import { describe, expect, it, vi } from "vitest";
import { GROW_RETRY_AFTER_MS, runGrowTick } from "../../src/grow/tick.js";
import type { LlmResult } from "../../src/llm/types.js";
import { parseModelString } from "../../src/omp/model-string.js";
import { CLEAN, growFields, growSetup } from "../helpers/grow.js";

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
});
