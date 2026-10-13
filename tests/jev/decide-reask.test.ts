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

// 429 / 529 / auth must reach Paco (ADR 0029): a failed re-ask keeps the first answer for the turn, but the outage it
// revealed still opens its incident, exactly as on a first call. Per-call noise (timeout, a plain 5xx = transport) opens none.
describe("decide: a failed re-ask still reports an outage", () => {
  const fail = (error_kind: "rate_limited" | "overloaded" | "transport" | "timeout"): JevResult => ({ ok: false, reason: "error", detail: "x", error_kind });
  const AUTH: JevResult = { ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" };
  async function second(r: JevResult | (() => Promise<JevResult>), boundMs?: number): Promise<{ d: Decision; kinds: string[] }> {
    const store = RunStore.openInMemory();
    const client = vi.fn<(q: JevRequest) => Promise<JevResult>>().mockResolvedValueOnce(ok(0.55));
    if (typeof r === "function") client.mockImplementationOnce(r); else client.mockResolvedValueOnce(r);
    const d = await decide({ point: "injection", run_id: null, state: { p1: "x" }, questions: [Q], lang: "en", client, store, thresholdVersion: "t",
      reask: { ...near, ...(boundMs === undefined ? {} : { boundMs: () => boundMs }) } as never });
    await new Promise((res) => setTimeout(res, 40)); // a late result past the bound settles here
    return { d, kinds: store.listOpenIncidents().map((i) => i.kind) };
  }
  it.each([["rate_limited", fail("rate_limited"), "jev_rate_limited"], ["overloaded (529)", fail("overloaded"), "jev_overloaded"], ["auth", AUTH, "jev_auth"]] as const)(
    "second call %s: the incident opens and the first answer stands", async (_n, r, kind) => {
      const { d, kinds } = await second(r);
      expect(d).toMatchObject({ status: "answered", reask: "failed", answers: { i1: { noul: 0.55 } } });
      expect(kinds).toContain(kind);
    });
  it.each([["timeout", fail("timeout")], ["a plain 5xx (transport)", fail("transport")]] as const)("second call %s: no incident, the first answer stands", async (_n, r) => {
    const { d, kinds } = await second(r);
    expect(d).toMatchObject({ status: "answered", reask: "failed", answers: { i1: { noul: 0.55 } } });
    expect(kinds).toEqual([]);
  });
  it("a bound overrun is no incident; a 429 arriving after the bound still opens one (a short bound hides no outage)", async () => {
    const quiet = await second(() => new Promise<JevResult>(() => undefined), 10);
    expect(quiet.d).toMatchObject({ reask: "failed", answers: { i1: { noul: 0.55 } } });
    expect(quiet.kinds).toEqual([]);
    const late = await second(() => new Promise<JevResult>((res) => setTimeout(() => res(fail("rate_limited")), 25)), 5);
    expect(late.d).toMatchObject({ reask: "failed", answers: { i1: { noul: 0.55 } } });
    expect(late.kinds).toContain("jev_rate_limited");
  });
  it("a first call past its bound skips as timeout, and its late 429 still opens the incident", async () => {
    const store = RunStore.openInMemory();
    const client = vi.fn<(q: JevRequest) => Promise<JevResult>>(() => new Promise<JevResult>((res) => setTimeout(() => res(fail("rate_limited")), 25)));
    expect(await decide({ point: "injection", run_id: null, state: {}, questions: [Q], lang: "en", client, store, thresholdVersion: "t", boundMs: 5 }))
      .toEqual({ status: "skipped", reason: "timeout" });
    await new Promise((res) => setTimeout(res, 40));
    expect(store.listOpenIncidents().map((i) => i.kind)).toContain("jev_rate_limited");
  });
});
