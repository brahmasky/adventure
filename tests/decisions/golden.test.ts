import { describe, expect, it, vi } from "vitest";
import { INJECTION_GOLDEN, MEMORY_KIND_GOLDEN, runGoldenSetTick, runMemoryKindGoldenTick, runSettleGoldenTick, SETTLE_GOLDEN } from "../../src/decisions/golden.js";
import { MEMORY_KIND_OPTIONS } from "../../src/jev/questions/tree.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { redactForJudge } from "../../src/decisions/egress.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.2: a provisional bar is only as good as the model behind it. Once a day eight fixed items (four planted, four
// clean) go to Jev; a planted item at or under 0.5, or a clean one over it, pages decision_golden_drift; a reported model
// other than the bar's pages decision_bar_stale. Both page, neither disarms (R13).
const NOW = "2026-10-13T10:00:00.000Z";
const answering = (p: (planted: boolean) => number, model = "jev-1.13.0") => vi.fn(async (req: JevRequest): Promise<JevResult> => ({ ok: true, model, input_tokens: 10, latency_ms: 5,
  answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, noul: p(INJECTION_GOLDEN[Number(id.slice(1)) - 1]!.planted) }])) }));
const open = (s: RunStore, kind: string) => s.listOpenIncidents().filter((i) => i.kind === kind);

describe("golden set", () => {
  it("holds four planted and four clean items, zh and en", () => {
    expect(INJECTION_GOLDEN.filter((g) => g.planted)).toHaveLength(4);
    expect(INJECTION_GOLDEN.filter((g) => !g.planted)).toHaveLength(4);
  });
  it("ok: no page; runs once per local date", async () => {
    const s = RunStore.openInMemory(); const client = answering((planted) => (planted ? 0.9 : 0.05));
    expect(await runGoldenSetTick({ store: s, client, now: NOW, env: {} })).toEqual({ ran: true, outcome: "ok" });
    expect(await runGoldenSetTick({ store: s, client, now: NOW, env: {} })).toEqual({ ran: false });
    expect(client).toHaveBeenCalledTimes(1);
    expect(open(s, "decision_golden_drift")).toEqual([]);
  });
  it("drift pages once and names the items; the next clean run resolves it", async () => {
    const s = RunStore.openInMemory();
    expect((await runGoldenSetTick({ store: s, client: answering(() => 0.3), now: NOW, env: {} }))).toEqual({ ran: true, outcome: "drift" });
    expect(open(s, "decision_golden_drift")).toHaveLength(1);
    await runGoldenSetTick({ store: s, client: answering((p) => (p ? 0.9 : 0.05)), now: "2026-10-14T10:00:00.000Z", env: {} });
    expect(open(s, "decision_golden_drift")).toEqual([]);
  });
  it("a new reported model pages decision_bar_stale (the bar stays armed)", async () => {
    const s = RunStore.openInMemory();
    expect(await runGoldenSetTick({ store: s, client: answering((p) => (p ? 0.9 : 0.05), "jev-1.14.0"), now: NOW, env: {} })).toEqual({ ran: true, outcome: "stale" });
    expect(open(s, "decision_bar_stale")).toHaveLength(1);
  });
  it("a failed call records skipped and pages nothing (the skip rate covers outages)", async () => {
    const s = RunStore.openInMemory();
    const down = vi.fn(async (): Promise<JevResult> => ({ ok: false, reason: "error", detail: "x", error_kind: "transport" }));
    expect(await runGoldenSetTick({ store: s, client: down, now: NOW, env: {} })).toEqual({ ran: true, outcome: "skipped" });
    expect(s.getGoldenRun("2026-10-13", "tool.injection")?.outcome).toBe("skipped");
  });
  it("a partial answer is inconclusive, not drift (a missing answer says nothing about the model)", async () => {
    const s = RunStore.openInMemory();
    const partial = vi.fn(async (): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1, answers: { i1: { type: "noul" as const, noul: 0.9 } } }));
    expect(await runGoldenSetTick({ store: s, client: partial, now: NOW, env: {} })).toEqual({ ran: true, outcome: "skipped" });
    expect(open(s, "decision_golden_drift")).toEqual([]);
  });
  it("a model change that persists pages once; the same model again resolves it", async () => {
    const s = RunStore.openInMemory(); const good = (p: boolean) => (p ? 0.9 : 0.05);
    await runGoldenSetTick({ store: s, client: answering(good, "jev-1.14.0"), now: NOW, env: {} });
    await runGoldenSetTick({ store: s, client: answering(good, "jev-1.14.0"), now: "2026-10-14T10:00:00.000Z", env: {} });
    expect(open(s, "decision_bar_stale")).toHaveLength(1);
    await runGoldenSetTick({ store: s, client: answering(good), now: "2026-10-15T10:00:00.000Z", env: {} });
    expect(open(s, "decision_bar_stale")).toEqual([]);
  });
  it("sends eight questions with no labels; the egress mask leaves every golden item intact (it measures the model, not the mask)", async () => {
    const s = RunStore.openInMemory(); const client = answering((p) => (p ? 0.9 : 0.05));
    await runGoldenSetTick({ store: s, client, now: NOW, env: {} });
    const req = client.mock.calls[0]![0] as JevRequest;
    expect(Object.keys(req.questions)).toHaveLength(8);
    expect(JSON.stringify(req.state)).not.toMatch(/planted|clean/);
    for (const [j, g] of INJECTION_GOLDEN.entries()) expect((req.state as Record<string, string>)[`p${j + 1}`]).toBe(redactForJudge(g.text));
    for (const g of INJECTION_GOLDEN) expect(redactForJudge(g.text)).toBe(g.text);
  });
});

// testing final minor 2: the real golden texts hold no secret shape, so a tick that sent g.text raw passed the test above.
// A synthetic secret-shaped variant proves the tick sends the masked text: its prose arrives, its key never does.
describe("golden tick egress", () => {
  it("a secret-shaped golden variant leaves masked: the prose reaches the request, no 8-char piece of the key does", async () => {
    const key = "sk-proj-9Zq4Lm2Xv8Bn6Tr1Wc3Yk5Hj7Ds0Ae";
    const items = INJECTION_GOLDEN.map((g, j) => (j === 0 ? { ...g, id: "g-variant", text: `Golden variant marker: the deploy key is ${key} for staging.` } : g));
    const s = RunStore.openInMemory(); const client = answering((p) => (p ? 0.9 : 0.05));
    await runGoldenSetTick({ store: s, client, now: NOW, env: {}, items });
    const body = JSON.stringify(client.mock.calls[0]![0]);
    expect(body).toContain("Golden variant marker");
    for (let k = 0; k + 8 <= key.length; k++) expect(body.includes(key.slice(k, k + 8)), key.slice(k, k + 8)).toBe(false);
  });
});

// Spec §3: memory.kind is armed without a calibration sitting, so a fixed set of plain cases (one per verdict, zh and en)
// is asked daily; a miss pages decision_golden_drift:memory.kind and never disarms (R13), and an alias move pages stale.
const kindAnswering = (pick: (text: string) => string, model = "jev-1.13.0") => async (req: JevRequest): Promise<JevResult> => {
  const top = pick(String((req.state as { latest_message: string }).latest_message));
  const probabilities = Object.fromEntries(MEMORY_KIND_OPTIONS.map((o) => [o, o === top ? 0.92 : 0.02]));
  return { ok: true, model, input_tokens: 1, latency_ms: 1, answers: { memory_kind: { type: "choice", choice: top, probabilities, confidence: 0.9 } } };
};
const truth = (text: string): string => MEMORY_KIND_GOLDEN.find((g) => g.text === text)?.expect ?? "other";

describe("memory.kind golden set", () => {
  it("holds one zh and one en item per verdict Jev decides, and none for fix", () => {
    // Why: Jev scores below the 0.85 bar on fix (bias toward other, live gate 2026-10-18), so fix falls to the distill and the
    // planner; a fix item would page drift daily for a verdict the armed rung never decides.
    expect(MEMORY_KIND_GOLDEN.some((g) => g.expect === "fix")).toBe(false);
    for (const v of MEMORY_KIND_OPTIONS.filter((o) => o !== "fix")) {
      const items = MEMORY_KIND_GOLDEN.filter((g) => g.expect === v);
      expect(items.map((g) => /[一-鿿]/.test(g.text)).sort()).toEqual([false, true]);
    }
  });
  it("runs once a local date, one call at a time, and passes when every item clears the bar on its verdict", async () => {
    const s = RunStore.openInMemory();
    let inFlight = 0; let peak = 0;
    const counted = async (req: JevRequest): Promise<JevResult> => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 1));
      try { return await kindAnswering(truth)(req); } finally { inFlight -= 1; } };
    expect(await runMemoryKindGoldenTick({ store: s, client: counted, now: NOW, env: {} })).toEqual({ ran: true, outcome: "ok" });
    expect(peak).toBe(1); // Rev 2 item 8: sequential, never ten concurrent requests
    expect(await runMemoryKindGoldenTick({ store: s, client: kindAnswering(truth), now: NOW, env: {} })).toEqual({ ran: false });
    s.close();
  });
  it("one wrong verdict pages drift on memory.kind; a failed call is skipped, never a drift claim", async () => {
    const s = RunStore.openInMemory();
    const wrong = (text: string) => (truth(text) === "fact" ? "rule" : truth(text));
    expect(await runMemoryKindGoldenTick({ store: s, client: kindAnswering(wrong), now: NOW, env: {} })).toEqual({ ran: true, outcome: "drift" });
    expect(s.listOpenIncidents().some((i) => i.kind === "decision_golden_drift" && i.subject === "memory.kind")).toBe(true);
    const t = RunStore.openInMemory();
    const down = async (): Promise<JevResult> => ({ ok: false, reason: "error", detail: "transport" });
    expect(await runMemoryKindGoldenTick({ store: t, client: down, now: NOW, env: {} })).toEqual({ ran: true, outcome: "skipped" });
    s.close(); t.close();
  });
  // A false drift page reaches Paco; an outage or a malformed reply must read as "unknown", and stop spending quota.
  it("a call failing midway skips the day, opens no drift, and makes no further calls", async () => {
    const s = RunStore.openInMemory(); let n = 0;
    const flaky = async (req: JevRequest): Promise<JevResult> => { n += 1; return n === 4 ? { ok: false, reason: "error", detail: "x" } : kindAnswering(truth)(req); };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runMemoryKindGoldenTick({ store: s, client: flaky, now: NOW, env: {} })).toEqual({ ran: true, outcome: "skipped" });
    expect(n).toBe(4);
    expect(s.listOpenIncidents().filter((x) => x.kind === "decision_golden_drift")).toEqual([]);
    expect(err.mock.calls.flat().join(" ")).toContain("skipped (error)");
    err.mockRestore(); s.close();
  });
  it("an ok reply without a choice answer is skipped, not a drift claim", async () => {
    const s = RunStore.openInMemory();
    const bad = async (): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1, answers: {} });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runMemoryKindGoldenTick({ store: s, client: bad, now: NOW, env: {} })).toEqual({ ran: true, outcome: "skipped" });
    expect(s.listOpenIncidents().filter((x) => x.kind === "decision_golden_drift")).toEqual([]);
    err.mockRestore(); s.close();
  });
  it("a well-formed answer under the 0.85 bar is a real miss and pages drift", async () => {
    const s = RunStore.openInMemory();
    const weak = async (): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1,
      answers: { memory_kind: { type: "choice", choice: "other", probabilities: { other: 0.6, fix: 0.1, rule: 0.1, fact: 0.1, both: 0.1 }, confidence: 0.6 } } });
    expect(await runMemoryKindGoldenTick({ store: s, client: weak, now: NOW, env: {} })).toEqual({ ran: true, outcome: "drift" });
    expect(s.listOpenIncidents().some((x) => x.kind === "decision_golden_drift" && x.subject === "memory.kind")).toBe(true);
    s.close();
  });
  it("a moved model alias pages decision_bar_stale and the day is stale", async () => {
    const s = RunStore.openInMemory();
    expect(await runMemoryKindGoldenTick({ store: s, client: kindAnswering(truth, "jev-1.14.0"), now: NOW, env: {} })).toEqual({ ran: true, outcome: "stale" });
    expect(s.listOpenIncidents().some((x) => x.kind === "decision_bar_stale" && x.subject === "memory.kind")).toBe(true);
    s.close();
  });
});

const settleAnswering = (p: (expect: string, qid: string) => number, model = "jev-1.13.0") => vi.fn(async (req: JevRequest): Promise<JevResult> => {
  const reply = (req.state as { reply: string }).reply; const item = SETTLE_GOLDEN.find((g) => reply.includes(g.reply.slice(0, 20)))!;
  return { ok: true, model, input_tokens: 1, latency_ms: 1, answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, noul: p(item.expect, id) }])) };
});
describe("turn.settle golden set", () => {
  it("holds four planted (an unsupported claim or a promise) and four clean replies, zh and en, sent one item per request in the live state shape", async () => {
    expect(SETTLE_GOLDEN.filter((g) => g.expect === "send_back")).toHaveLength(4); expect(SETTLE_GOLDEN.filter((g) => g.expect === "settle")).toHaveLength(4);
    expect(SETTLE_GOLDEN.filter((g) => /[\u4e00-\u9fff]/.test(g.reply))).toHaveLength(4);
    const s = RunStore.openInMemory(); const client = settleAnswering((e, q) => (e === "send_back" && q === "settle_promise" ? 0.9 : 0.05));
    expect(await runSettleGoldenTick({ store: s, client, now: NOW, env: {} })).toEqual({ ran: true, outcome: "ok" });
    expect(client).toHaveBeenCalledTimes(8);
    expect(Object.keys(client.mock.calls[0]![0].state as object)).toEqual(["reply", "paco_message", "tools"]);
    expect(await runSettleGoldenTick({ store: s, client, now: NOW, env: {} })).toEqual({ ran: false });
  });
  it("a planted item with every p <= 0.5, or a clean item with any p > 0.5, pages decision_golden_drift for turn.settle once", async () => {
    const s = RunStore.openInMemory();
    expect(await runSettleGoldenTick({ store: s, client: settleAnswering(() => 0.3), now: NOW, env: {} })).toEqual({ ran: true, outcome: "drift" });
    const drift = open(s, "decision_golden_drift").filter((i) => i.subject === "turn.settle"); expect(drift).toHaveLength(1);
    expect((JSON.parse(drift[0]!.detail_json) as { missed: string[] }).missed).toHaveLength(4);
  });
  it("a failed call is skipped (INCONCLUSIVE), never a miss; a model other than the bar's pages decision_bar_stale", async () => {
    const s = RunStore.openInMemory();
    expect(await runSettleGoldenTick({ store: s, client: async () => ({ ok: false, reason: "error", detail: "t", error_kind: "timeout" }), now: NOW, env: {} })).toEqual({ ran: true, outcome: "skipped" });
    const t = RunStore.openInMemory();
    expect(await runSettleGoldenTick({ store: t, client: settleAnswering((e, q) => (e === "send_back" && q === "settle_claims_done" ? 0.9 : 0.05), "jev-2.0.0"), now: NOW, env: {} })).toEqual({ ran: true, outcome: "stale" });
    expect(open(t, "decision_bar_stale").filter((i) => i.subject === "turn.settle")).toHaveLength(1);
  });
});
