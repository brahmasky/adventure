import { describe, expect, it, vi } from "vitest";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { askMemoryKind } from "../../src/jev/memory-kind-ask.js";
import { RunStore } from "../../src/run/run-store.js";
import { choiceAns } from "../helpers/jev-tree-answers.js";

// Spec Rev 3 §3: the memory_kind call is one question in its own request. An answer is used; any failure is a rung
// failure the distill covers (the save never blocks on Jev), and an outage still opens the existing Jev incident.
const OPTIONS = ["other", "fix", "rule", "fact", "both"];
const state = { userText: "记下来吧", recentTurns: [], turnChars: 400, modality: "text" as const, lastHougeTurn: null, quotedTurn: null };
const ok = (top: string, p: number) => vi.fn(async (_r: JevRequest): Promise<JevResult> =>
  ({ ok: true, model: "jev-1.13.0", input_tokens: 100, latency_ms: 300, answers: { memory_kind: choiceAns(OPTIONS, top, p) } }));

describe("askMemoryKind", () => {
  it("sends exactly one question, memory_kind, and returns its answer", async () => {
    const store = RunStore.openInMemory();
    const client = ok("fact", 0.93);
    const r = await askMemoryKind({ run_id: "run_1", state, lang: "zh", client, store });
    expect(Object.keys(client.mock.calls[0]![0].questions)).toEqual(["memory_kind"]);
    expect(r).toMatchObject({ answer: { type: "choice", choice: "fact" } });
    store.close();
  });
  it("a 429 is an outage: the existing Jev incident opens, and the rung fails as outage (the distill decides)", async () => {
    const store = RunStore.openInMemory();
    const client = async (): Promise<JevResult> => ({ ok: false, reason: "error", detail: "HTTP 429", error_kind: "rate_limited" });
    expect(await askMemoryKind({ run_id: "run_1", state, lang: "zh", client, store })).toEqual({ failed: "outage" });
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_rate_limited")).toBe(true);
    store.close();
  });
  it("a timeout and an unparseable answer are named as such (the live gate fails on either)", async () => {
    const store = RunStore.openInMemory();
    const timeout = async (): Promise<JevResult> => ({ ok: false, reason: "error", detail: "timed out", error_kind: "timeout" });
    const parse = async (): Promise<JevResult> => ({ ok: false, reason: "error", detail: "answer_missing:memory_kind", error_kind: "parse" });
    expect(await askMemoryKind({ run_id: "run_1", state, lang: "zh", client: timeout, store })).toEqual({ failed: "timeout" });
    expect(await askMemoryKind({ run_id: "run_1", state, lang: "zh", client: parse, store })).toEqual({ failed: "parse" });
    store.close();
  });
  it("writes no jev_decisions row: the memory.kind decision row carries the verdict and p (Spec deviation D14)", async () => {
    const store = RunStore.openInMemory();
    await askMemoryKind({ run_id: "run_1", state, lang: "zh", client: ok("rule", 0.9), store });
    expect(store.listJevDecisions("run_1")).toEqual([]);
    store.close();
  });
});
