import { describe, expect, it } from "vitest";
import { askCandidate, IMPROVE_GOLDEN, runGoldenForModel } from "../../src/decisions/golden.js";
import { applicableTargets, improveRule } from "../../src/decisions/entries/improve-route.js";
import type { JevAnswer, JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";

// Jev version check spec §2.5 e: each ladder entry's golden set runs on the candidate, keyed by model. Every item's answer
// must come from the candidate (the alias may still serve the old id): another model's answer is retried and never credited.
// improve.route's golden items must reach the Jev rung, so the rule rung abstains on every one of them.

const choice = (opts: string[], top: string, p = 0.9): JevAnswer =>
  ({ type: "choice", choice: top, probabilities: Object.fromEntries(opts.map((o) => [o, o === top ? p : (1 - p) / (opts.length - 1)])), confidence: p });

describe("IMPROVE_GOLDEN", () => {
  it("every item reaches the Jev rung (the rule rung abstains) and expects a target Houge can act on", () => {
    expect(IMPROVE_GOLDEN.length).toBeGreaterThanOrEqual(4);
    for (const g of IMPROVE_GOLDEN) {
      expect(improveRule(g.state)).toEqual({ abstain: true });
      expect(applicableTargets(g.state)).toContain(g.expect);
    }
    const nothing = IMPROVE_GOLDEN.find((g) => g.expect === "nothing")!;
    expect(nothing.state).toMatchObject({ signal: "rating", value: "3" }); // a "fine" text with the top rating: no contradicting signal
  });
});

describe("askCandidate", () => {
  it("retries an answer from another model at most 3 times and reports the other model", async () => {
    let calls = 0;
    const client = async (): Promise<JevResult> => { calls += 1; return { ok: true, model: "jev-old", answers: {}, input_tokens: 1, latency_ms: 1 }; };
    expect(await askCandidate(client, { state: {}, questions: {} }, "jev-new")).toEqual({ ok: false, why: "other_model", reported: "jev-old" });
    expect(calls).toBe(4);
  });
});

describe("askCandidate and the stop signal", () => {
  it("stops between retries once the signal aborts", async () => {
    const stop = new AbortController(); let calls = 0;
    const client = async (): Promise<JevResult> => { calls += 1; stop.abort(); return { ok: true, model: "jev-old", answers: {}, input_tokens: 1, latency_ms: 1 }; };
    expect(await askCandidate(client, { state: {}, questions: {} }, "jev-new", { signal: stop.signal })).toEqual({ ok: false, why: "stopped" });
    expect(calls).toBe(1);
  });
});

describe("runGoldenForModel", () => {
  it("improve.route judges each item by its top option on the candidate", async () => {
    const s = RunStore.openInMemory();
    const client = async (req: JevRequest): Promise<JevResult> => {
      const text = String((req.state as { paco_text?: string }).paco_text);
      const g = IMPROVE_GOLDEN.find((x) => x.state.redacted.pacoText === text)!;
      return { ok: true, model: "jev-new", answers: { improve_target: choice(["nothing", "lesson", "fact", "skill", "schedule", "knowledge", "tool_gap", "ladder"], g.expect) }, input_tokens: 1, latency_ms: 1 };
    };
    expect(await runGoldenForModel("improve.route", "jev-new", client, s)).toEqual({ kind: "judged", outcome: "ok", missed: [] });
  });

  it("an item another model answered is never credited: wrong_model after the retries", async () => {
    const s = RunStore.openInMemory();
    let calls = 0;
    const client = async (): Promise<JevResult> => { calls += 1; return { ok: true, model: calls === 1 ? "jev-new" : "jev-old", answers: { memory_kind: choice(["other", "fix", "rule", "fact", "both"], "other") }, input_tokens: 1, latency_ms: 1 }; };
    expect(await runGoldenForModel("memory.kind", "jev-new", client, s)).toEqual({ kind: "wrong_model", reported: "jev-old" });
    expect(calls).toBe(5); // item 1 on the candidate, item 2 asked 4 times
  });
});
