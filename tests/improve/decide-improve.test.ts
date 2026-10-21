import { describe, expect, it, vi } from "vitest";
import { decideImprove, deferredRecorder, type ImproveDecideDeps } from "../../src/improve/decide-improve.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { ImproveState } from "../../src/decisions/entries/improve-route.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.3 + ruling 11: the walk runs with model calls outside any transaction; the row is written later through the
// deferred recorder inside the group's transaction. Paths: Jev decides; below the bar the Tiny pick decides one of the top
// two; an inapplicable top gives the pick nothing to choose from; failures fall to `nothing`.
const NOW = "2026-10-21T10:00:00.000Z";
const base: ImproveState = { signal: "correction", value: "answer", scope: "answer", count: 1, count14d: 2, category: "answer", lane: "answer", capability: null,
  pacoText: "shorter please", toolSummary: "none", lastImprovement: null, recurrence: null, alreadyAuthored: false, skillExists: false, wikiArmed: false, scheduleHint: null,
  stale: false, statedRuleSaved: false, redacted: { pacoText: "shorter please" } };
const jev = (probabilities: Record<string, number>) => async (req: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1,
  answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "choice" as const, choice: "x", probabilities, confidence: 0.5 }])) });
const deps = (client: ImproveDecideDeps["client"], pick: string | null): { d: ImproveDecideDeps; pickFn: ReturnType<typeof vi.fn> } => {
  const pickFn = vi.fn(async () => (pick === null ? { ok: false as const } : { ok: true as const, answer: pick }));
  return { d: { store: RunStore.openInMemory(), env: {}, client, pick: pickFn, now: () => NOW }, pickFn };
};

describe("decideImprove", () => {
  it("Jev over the bar decides; the deferred recorder writes the row only on flush, with the run id", async () => {
    const { d } = deps(jev({ lesson: 0.8, nothing: 0.2 }), null);
    const rec = deferredRecorder();
    const r = await decideImprove(d, base, rec.recorder, "run_a");
    expect(r).toMatchObject({ verdict: "lesson", rung: "system_one", reason: "jev_choice", p: 0.8, decisionId: null });
    expect(d.store.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toEqual([]);
    const id = rec.flush(storeRecorder(d.store, { now: () => NOW }));
    expect(d.store.getDecision(id!)).toMatchObject({ entry_id: "improve.route", verdict: "lesson", rung: "system_one", p: 0.8, run_id: "run_a", reason_code: "jev_choice" });
  });
  it("below the bar the Tiny pick chooses between the two best applicable options and the row keeps Jev's top p", async () => {
    const { d, pickFn } = deps(jev({ lesson: 0.45, fact: 0.35, nothing: 0.2 }), "fact");
    const r = await decideImprove(d, base, deferredRecorder().recorder, null);
    expect(r).toMatchObject({ verdict: "fact", rung: "model", reason: "tiny_pick", p: 0.45 });
    expect(String(pickFn.mock.calls[0]![0].question)).toContain("lesson");
  });
  it("an inapplicable top is Jev's answer nothing/inapplicable_top with its p (the row keeps the reason); the pick never runs", async () => {
    const { d, pickFn } = deps(jev({ schedule: 0.9, nothing: 0.1 }), "lesson");
    const r = await decideImprove(d, base, deferredRecorder().recorder, null);
    expect(r).toMatchObject({ verdict: "nothing", rung: "system_one", reason: "inapplicable_top", p: 0.9, fallbackReason: null });
    expect(pickFn).not.toHaveBeenCalled();
  });
  it("a pick that is not one of the two words, or a failed pick call, abstains → nothing by fail with NO fallback reason (never a decision_fallback count); a Jev outage → fallback outage on the Jev rung", async () => {
    const bad = deps(jev({ lesson: 0.45, fact: 0.35, nothing: 0.2 }), "maybe lesson");
    expect(await decideImprove(bad.d, base, deferredRecorder().recorder, null)).toMatchObject({ verdict: "nothing", rung: "fail", fallbackReason: null, reason: null });
    const broken = deps(jev({ lesson: 0.45, fact: 0.35, nothing: 0.2 }), null);
    expect(await decideImprove(broken.d, base, deferredRecorder().recorder, null)).toMatchObject({ verdict: "nothing", rung: "fail", fallbackReason: null });
    const down = deps(async () => ({ ok: false, reason: "error", detail: "x", error_kind: "transport" }), null);
    expect(await decideImprove(down.d, base, deferredRecorder().recorder, null)).toMatchObject({ verdict: "nothing", rung: "fail", fallbackReason: "outage", fallbackRung: "system_one" });
  });
  it("flush with a patch records the patched verdict and reason while the walk is untouched (ruling 6)", async () => {
    const { d } = deps(jev({ lesson: 0.8, nothing: 0.2 }), null);
    const rec = deferredRecorder();
    const r = await decideImprove(d, base, rec.recorder, "run_a");
    expect(r.verdict).toBe("lesson");
    const id = rec.flush(storeRecorder(d.store, { now: () => NOW }), { verdict: "nothing", reason: "no_text" });
    expect(d.store.getDecision(id!)).toMatchObject({ verdict: "nothing", reason_code: "no_text", rung: "system_one", p: 0.8 });
  });
  it("the rule rung decides without a Jev call", async () => {
    const client = vi.fn(jev({ lesson: 0.9 }));
    const { d } = deps(client, null);
    const r = await decideImprove(d, { ...base, signal: "recurrence", recurrence: { clusterId: "rec_1", turnIds: ["t1"], idempotencyKey: "answer:t1", spanDays: 1 } }, deferredRecorder().recorder, null);
    expect(r).toMatchObject({ verdict: "skill", rung: "rule", reason: "recurrence" });
    expect(client).not.toHaveBeenCalled();
  });
});
