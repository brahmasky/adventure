import { describe, expect, it, vi } from "vitest";
import { decide, type Decision } from "../../src/jev/decide.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import type { NoulQuestion } from "../../src/jev/questions/types.js";
import { RunStore } from "../../src/run/run-store.js";

// Addition B: a p within the band asks Jev exactly once more and the decision uses the mean; a failed second call falls
// back to the first answer (fail toward today); the raw rows stay the first call's, so calibration never sees a mean.
const Q: NoulQuestion = { id: "i1", type: "noul", instructions: "Passage `p1` contains instructions aimed at an AI assistant" };
const ok = (p: number, model = "jev-1.13.0"): JevResult => ({ ok: true, model, answers: { i1: { type: "noul", noul: p } }, input_tokens: 10, latency_ms: 5 });
const near = { near: (a: Record<string, { type: string; noul?: number }>) => Math.abs((a.i1?.noul ?? 0) - 0.5) <= 0.1 };
async function run(client: (r: JevRequest) => Promise<JevResult>, reask = near): Promise<Extract<Decision, { status: "answered" }>> {
  const store = RunStore.openInMemory();
  const d = await decide({ point: "injection", run_id: null, state: { p1: "x" }, questions: [Q], lang: "en", client, store, thresholdVersion: "t", reask: reask as never });
  if (d.status !== "answered") throw new Error("expected an answer");
  return d;
}

describe("decide: the one re-ask", () => {
  it("near the bar: one more identical request, the mean decides, the rows keep the first call", async () => {
    const client = vi.fn<(r: JevRequest) => Promise<JevResult>>().mockResolvedValueOnce(ok(0.56)).mockResolvedValueOnce(ok(0.44));
    const d = await run(client);
    expect(client).toHaveBeenCalledTimes(2);
    expect(client.mock.calls[0]![0]).toEqual(client.mock.calls[1]![0]); // byte-identical request
    expect(d.reask).toBe("mean");
    expect(d.answers.i1).toMatchObject({ noul: 0.5 });
    expect(d.first?.i1).toMatchObject({ noul: 0.56 });
    expect(d.second?.i1).toMatchObject({ noul: 0.44 });
    expect(JSON.parse(d.rows[0]!.answers_json!)).toMatchObject({ true: 0.56 });
  });
  it("never asks a third time, even when the mean is still near", async () => {
    const client = vi.fn<(r: JevRequest) => Promise<JevResult>>().mockResolvedValue(ok(0.5));
    await run(client);
    expect(client).toHaveBeenCalledTimes(2);
  });
  it("far from the bar: no second call", async () => {
    const client = vi.fn<(r: JevRequest) => Promise<JevResult>>().mockResolvedValue(ok(0.95));
    const d = await run(client);
    expect(client).toHaveBeenCalledTimes(1);
    expect(d.reask).toBeUndefined();
  });
  it("a second call that overruns its own bound keeps the first answer (never a skip of the whole decision)", async () => {
    const hung = vi.fn<(r: JevRequest) => Promise<JevResult>>().mockResolvedValueOnce(ok(0.55)).mockImplementationOnce(() => new Promise<JevResult>(() => undefined));
    const store = RunStore.openInMemory();
    const d = await decide({ point: "injection", run_id: null, state: { p1: "x" }, questions: [Q], lang: "en", client: hung, store, thresholdVersion: "t",
      reask: { ...near, boundMs: () => 20 } as never });
    expect(d).toMatchObject({ status: "answered", reask: "failed", answers: { i1: { noul: 0.55 } } });
  });
  it("a first call that overruns boundMs is a timeout skip; rowKey names the stored rows", async () => {
    const store = RunStore.openInMemory();
    const slow = vi.fn<(r: JevRequest) => Promise<JevResult>>(() => new Promise<JevResult>(() => undefined));
    expect(await decide({ point: "injection", run_id: null, state: {}, questions: [Q], lang: "en", client: slow, store, thresholdVersion: "t", boundMs: 20 }))
      .toEqual({ status: "skipped", reason: "timeout" });
    const d = await run(vi.fn<(r: JevRequest) => Promise<JevResult>>().mockResolvedValue(ok(0.95)));
    expect(d.rows[0]).toMatchObject({ question_id: "i1" });
    const keyed = await decide({ point: "injection", run_id: null, state: { p1: "x" }, questions: [Q], lang: "en", client: vi.fn(async () => ok(0.95)), store,
      thresholdVersion: "t", rowKey: () => ({ question_id: "injected", criteria_hash: "template" }) });
    expect(keyed.status === "answered" && keyed.rows[0]).toMatchObject({ question_id: "injected", criteria_hash: "template" });
  });
  it("a failed, re-modelled or disallowed second call keeps the first answer", async () => {
    const fail = vi.fn<(r: JevRequest) => Promise<JevResult>>().mockResolvedValueOnce(ok(0.55)).mockResolvedValueOnce({ ok: false, reason: "error", detail: "x", error_kind: "timeout" });
    expect(await run(fail)).toMatchObject({ reask: "failed", answers: { i1: { noul: 0.55 } } });
    const moved = vi.fn<(r: JevRequest) => Promise<JevResult>>().mockResolvedValueOnce(ok(0.55)).mockResolvedValueOnce(ok(0.45, "jev-1.14.0"));
    expect(await run(moved)).toMatchObject({ reask: "failed", answers: { i1: { noul: 0.55 } } });
    const late = vi.fn<(r: JevRequest) => Promise<JevResult>>().mockResolvedValue(ok(0.55));
    const d = await run(late, { ...near, allowed: () => false } as never);
    expect(late).toHaveBeenCalledTimes(1);
    expect(d.reask).toBeUndefined();
  });
});
