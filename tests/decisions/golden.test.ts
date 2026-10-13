import { describe, expect, it, vi } from "vitest";
import { INJECTION_GOLDEN, runGoldenSetTick } from "../../src/decisions/golden.js";
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
