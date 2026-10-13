import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { candidateBandRows, createTempRoot, formatNoiseReport, parseNoiseArgs, redactStrings, repeatCalls, spreadStats, withTempRoot } from "../../src/jev/noise-measure.js";
import type { JevAnswer, JevRequest, JevResult } from "../../src/jev/jev-client.js";

// The band is a reviewed number: it must come from repeated identical requests, as the 95th percentile of each request's
// spread, rounded UP, and a partial or mixed-model measurement must print no candidate rows (lessons.md 2026-09-25: a
// verdict over a partial run is not a verdict).
const S = (values: number[], question = "category", model = "jev-1.13.0") => ({ question, criteriaHash: "h", model, values });

describe("noise measurement", () => {
  it("spread per request is max − min; the stat keeps max, p95 (nearest rank) and mean", () => {
    const [s] = spreadStats([S([0.59, 0.65, 0.6]), S([0.7, 0.71]), S([0.5, 0.5])]);
    expect(s).toMatchObject({ question: "category", requests: 3 });
    expect(s!.maxSpread).toBeCloseTo(0.06, 9);
    expect(s!.p95Spread).toBeCloseTo(0.06, 9);
    expect(s!.meanSpread).toBeCloseTo((0.06 + 0.01 + 0) / 3, 9);
  });
  it("candidate rows round the p95 up to 0.01 and leave approved empty for Paco", () => {
    const rows = candidateBandRows(spreadStats([S([0.591, 0.652])]), "2026-10-13");
    expect(JSON.parse(rows[0]!)).toMatchObject({ question: "category", criteriaHash: "h", model: "jev-1.13.0", band: 0.07, approved: "" });
  });
  it("a measurement with failed calls or two models is INCOMPLETE and prints no rows", () => {
    const stats = spreadStats([S([0.6, 0.62])]);
    expect(formatNoiseReport(stats, { requests: 1, k: 2, failed: 1, models: ["jev-1.13.0"], spentUsd: 0, date: "d" })).toMatch(/^INCOMPLETE/);
    expect(formatNoiseReport(stats, { requests: 1, k: 2, failed: 0, models: ["a", "b"], spentUsd: 0, date: "d" })).not.toContain('"approved"');
    expect(formatNoiseReport(stats, { requests: 1, k: 2, failed: 0, models: ["jev-1.13.0"], spentUsd: 0, date: "d" })).toContain('"approved":""');
  });
});

describe("measurement arguments", () => {
  // --tree re-sends Paco's own messages k times; his approval named one replay, so the gate is the flag itself.
  it("refuses --tree without a non-empty --approved, accepts it with one", () => {
    expect(() => parseNoiseArgs(["--tree"])).toThrow(/--approved/);
    expect(() => parseNoiseArgs(["--tree", "--approved"])).toThrow(/--approved/);
    expect(() => parseNoiseArgs(["--tree", "--approved", "   "])).toThrow(/--approved/);
    expect(parseNoiseArgs(["--tree", "--approved", "Paco 2026-10-13: yes, 40 x 5"])).toMatchObject({ tree: true, k: 5, limit: 40 });
  });
  it("needs exactly one mode and bounded k and limit, and rejects unknown flags", () => {
    expect(() => parseNoiseArgs([])).toThrow(/exactly one/);
    expect(() => parseNoiseArgs(["--tree", "--injection", "--approved", "x"])).toThrow(/exactly one/);
    expect(() => parseNoiseArgs(["--injection", "--k", "1"])).toThrow(/--k/);
    expect(() => parseNoiseArgs(["--injection", "--limit", "0"])).toThrow(/--limit/);
    expect(() => parseNoiseArgs(["--injection", "--bogus"])).toThrow(/unknown argument/);
    expect(parseNoiseArgs(["--injection", "--k", "3"])).toMatchObject({ injection: true, tree: false, k: 3 });
  });
});

describe("repeatCalls", () => {
  const noul = (n: number): JevAnswer => ({ type: "noul", noul: n });
  const ok = (n: number, model = "m1"): JevResult => ({ ok: true, model, answers: { q: noul(n) }, input_tokens: 10, latency_ms: 1 });
  const req: JevRequest = { state: {}, questions: {} };
  const none = async (): Promise<void> => undefined;
  const scripted = (rs: JevResult[]) => { const sent: JevRequest[] = []; return { sent, client: async (r: JevRequest): Promise<JevResult> => { sent.push(r); return rs[sent.length - 1]!; } }; };

  it("sends the byte-identical request k times and collects each answer's value", async () => {
    const { sent, client } = scripted([ok(0.5), ok(0.6), ok(0.55)]);
    const got = await repeatCalls(client, req, 3, ["q"], () => ({}), none);
    expect(sent).toHaveLength(3);
    expect(sent.every((r) => r === req)).toBe(true);
    expect(got).toMatchObject({ values: { q: [0.5, 0.6, 0.55] }, failed: 0, tokens: 30 });
    expect([...got.models]).toEqual(["m1"]);
  });
  it("counts a failed call and an answer missing a question as failed, never as a short sample", async () => {
    const missing: JevResult = { ok: true, model: "m1", answers: {}, input_tokens: 5, latency_ms: 1 };
    const { client } = scripted([ok(0.5), { ok: false, reason: "error", detail: "x" }, missing]);
    const got = await repeatCalls(client, req, 3, ["q"], () => ({}), none);
    expect(got.failed).toBe(2);
    expect(got.values.q).toEqual([0.5]);
  });
  it("adds derived values beside the answer value, and records every reported model", async () => {
    const { client } = scripted([ok(0.5, "a"), ok(0.7, "b")]);
    const got = await repeatCalls(client, req, 2, ["q"], (_id, a) => ({ "q:double": a.type === "noul" ? a.noul * 2 : 0 }), none);
    expect(got.values["q:double"]).toEqual([1, 1.4]);
    expect([...got.models].sort()).toEqual(["a", "b"]);
  });
});

describe("egress and temp root", () => {
  it("masks credential material in every string of a request state, however deep", () => {
    const secret = "Zx9Qw3Lm8Vt2Ry7Kp4Nd6Hs1";
    const out = redactStrings({ latest_message: `use api_key=${secret} now`, thread: [{ text: `password: ${secret}` }], n: 3 }) as { n: number };
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.n).toBe(3);
  });
  it("removes the temp root after success, after a throw, and on demand (the SIGINT path)", async () => {
    let seen = "";
    await withTempRoot("hg-noise-test-", tmpdir(), async (p) => { seen = p; expect(existsSync(p)).toBe(true); });
    expect(existsSync(seen)).toBe(false);
    await expect(withTempRoot("hg-noise-test-", tmpdir(), async (p) => { seen = p; throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(seen)).toBe(false);
    const root = createTempRoot("hg-noise-test-", tmpdir());
    expect(existsSync(root.path)).toBe(true);
    root.remove(); root.remove();
    expect(existsSync(root.path)).toBe(false);
  });
});
