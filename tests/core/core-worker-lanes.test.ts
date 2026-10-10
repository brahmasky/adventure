import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANE_PREFACE, REWRITE_INSTRUCTION, SOURCE_LINE_LABEL } from "../../src/core/lanes/lane-compose.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID, TREE_STATUS_ARM_ID } from "../../src/jev/tree-policy.js";
import { OMP_LOOP_DISCIPLINE } from "../../src/prompt/composer.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { ompWorker } from "../helpers/omp-worker.js";

// Stage B §4–§8 through the real worker: the verdict row must be truthful about what ran (a fall-through is never `act`),
// the save and its verdict stay atomic, a killed turn leaves the record the finaliser's rules allow, and every lane reply
// leaves the catch-up line the next planner turn reads. The model calls are the test-injected seat (no omp spawn).
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REPORTED = "jev-1.13.0";
const n = CATEGORIES.length;
function cat(p: Partial<Record<Category, number>>) {
  const used = Object.values(p).reduce((a, b) => a + (b ?? 0), 0);
  const rest = CATEGORIES.filter((c) => p[c] === undefined);
  const probabilities = Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? (1 - used) / rest.length]));
  const [choice, pMax] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
}
const scope = (ask: number) => ({ type: "choice", choice: ask >= 0.5 ? "ask" : "research", probabilities: { ask, research: 1 - ask }, confidence: Math.abs(2 * ask - 1) });
const level = (probs: number[]) => ({ type: "score", score: probs.reduce((s, p, k) => s + k * p, 0),
  probabilities: Object.fromEntries(probs.map((p, k) => [String(k), p])), confidence: 0.8 });
const LIGHT = [0.1, 0.9, 0, 0]; // expected 0.9
const NONE = [1, 0, 0, 0];      // expected 0
type Says = { category: ReturnType<typeof cat>; sets_rule?: number; breadth?: number[]; reasoning?: number[]; actions?: number[] };
const treeSays = (o: Says) => vi.fn(async (_url?: unknown, _init?: unknown) => json(200, { model: REPORTED, usage: { input_tokens: 900, output_tokens: 0 },
  answers: { category: o.category, sets_rule: { type: "noul", noul: o.sets_rule ?? 0.05 }, rule_scope: scope(0.9), breadth: level(o.breadth ?? LIGHT),
    reasoning: level(o.reasoning ?? LIGHT), actions: level(o.actions ?? NONE) } }));
const ANSWER: Says = { category: cat({ answer: 0.9 }) };                 // actions 0: inside the answer limits
const LOOKUP: Says = { category: cat({ lookup: 0.9 }), actions: LIGHT }; // actions 0.9: inside the lookup limits

type Llm = (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
const READ_OK = JSON.stringify({ summary: "Sydney tomorrow", facts: ["Sunny, max 22°C"], time_claims: [], answer_to_objective: "Sunny, 22°C", contains_instructions: false });
interface LlmScript { compose?: Llm; reader?: Llm; rewrite?: Llm; seen?: Array<Record<string, unknown>> }
/** The injected seat, told apart by the prompt (lane compose, rewrite, reader) or the system (the lesson-write service's two calls). */
const laneLlm = (s: LlmScript = {}): Llm => async (input) => {
  s.seen?.push(input);
  const q = String(input.question ?? "");
  if (q.startsWith(LANE_PREFACE)) return s.compose ? s.compose(input) : { ok: true, output: { answer: "放在书房更好。", model: "claude-sonnet-5-5" } };
  if (q.startsWith(REWRITE_INSTRUCTION)) return s.rewrite ? s.rewrite(input) : { ok: true, output: { answer: "SAME" } };
  if (q.includes("<<<UNTRUSTED>>>")) return s.reader ? s.reader(input) : { ok: true, output: { answer: READ_OK } };
  if (/durable/i.test(String(input.system ?? ""))) return { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short." }) } };
  return { ok: true, output: { answer: JSON.stringify({ verdict: "ADD", theme: "format" }) } };
};
const web = () => vi.fn(async (_input: Record<string, unknown>): Promise<ToolAdapterResult> => ({ ok: true,
  output: { query: "q", provider: "tavily", results: [{ title: "BOM", url: "https://weather.example/sydney", content: "Tomorrow: sunny, max 22." }] } }));

/** The gate-only rows: the six questions, status, and the two stage B lane rows, zh + en. */
function calibrationFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), "hlane-cal-")), "rows.json");
  const ids = [...TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const),
    ...[TREE_STATUS_ARM_ID, TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID].map((id) => [id, criteriaHash(TREE_CATEGORY)] as const)];
  writeFileSync(f, JSON.stringify(ids.flatMap(([question_id, criteria_hash]) => (["zh", "en"] as const).map((lang) =>
    ({ question_id, criteria_hash, model: REPORTED, lang, approved: "test", evidence: "test" })))));
  return f;
}
function setup(fetchImpl: unknown, o: { llm?: Llm; web?: Llm; http?: Llm } = {}) {
  vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", calibrationFile()); vi.stubEnv("HOUGE_JEV_GATE", "1");
  vi.stubEnv("HOUGE_JEV_ENABLED", "1"); vi.stubEnv("HOUGE_JEV_TRIAGE_ENABLED", "arm"); vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  const store = RunStore.openInMemory();
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hlane-")), { llm: o.llm ?? laneLlm(), jevFetch: fetchImpl as typeof fetch,
    ...(o.web ? { web: o.web } : {}), ...(o.http ? { http: o.http } : {}) });
  const turn = (text: string, signal: AbortSignal = new AbortController().signal) => {
    const run_id = createQueuedTurnRun(store, text);
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555");
    return { run_id, input: { claim, text, userText: text, modality: "text" as const, posture: null, signal } };
  };
  return { store, worker, turn };
}
const verdictOf = (store: RunStore, run_id: string) => store.getJevVerdictForRun(run_id);
const triageRows = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "triage").map((e) => e.payload);
const decisions = (store: RunStore, run_id: string) => store.listJevDecisions(run_id);
const ledger = (store: RunStore, run_id: string, type: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === type).map((e) => e.payload);
const DIG = (run_id: string) => ({ text: "🔍 Dig deeper", data: `lane:ask:${run_id}` });

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the answer lane through the worker (stage B §4)", () => {
  it("no save: the lane replies, then ONE settle after it (act, lane_reply, the compose's model); Dig deeper; a lane_replies row", async () => {
    const atCompose: unknown[] = [];
    let store!: RunStore; let runId = "";
    const llm = laneLlm({ compose: async () => { atCompose.push(store.getJevVerdictForRun(runId)); return { ok: true, output: { answer: "放在书房更好。", model: "claude-sonnet-5-5" } }; } });
    const s = setup(treeSays(ANSWER), { llm }); store = s.store;
    const t = s.turn("你觉得 NAS 放在客厅还是书房更好？"); runId = t.run_id;
    expect(await s.worker.triageTurn(t.input)).toEqual({ kind: "lane_reply", text: "放在书房更好。", buttons: [DIG(t.run_id)] });
    expect(atCompose).toEqual([undefined]); // nothing was settled before the lane ran (Decision 5)
    const v = verdictOf(store, t.run_id)!;
    expect(v).toMatchObject({ category: "answer", lane: "answer", role: "fast", effort: "low", reason: "routed", route_outcome: "act",
      handler_outcome: "lane_reply", model: "test/claude-sonnet-5-5", save_outcome: "none" }); // provider/model: the injected seat's provider is "test"
    expect(triageRows(store, t.run_id)).toMatchObject([{ route_lane: "answer", decision: "act", verdict: "routed", verdict_id: v.verdict_id }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "act" && r.threshold_used === "2026-10-10.1:routed")).toBe(true);
    expect(store.laneTurnsSince("555", null)).toMatchObject([{ run_id: t.run_id, lane: "answer", verdict_id: v.verdict_id, catch_up: "Houge replied: 放在书房更好。" }]);
    store.close();
  });
  it("the compose prompt carries the planner's own system prompt (the same lessons), with the lane preface first", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const s = setup(treeSays(ANSWER), { llm: laneLlm({ seen }) });
    await s.worker.triageTurn(s.turn("你觉得呢？").input);
    const q = String(seen.find((i) => String(i.question).startsWith(LANE_PREFACE))?.question);
    expect(q).toContain(OMP_LOOP_DISCIPLINE);
    expect(q.endsWith("Paco: 你觉得呢？")).toBe(true);
    s.store.close();
  });
  it("a compose failure falls through: the planner on Default; the verdict keeps lane answer, reason routed, route_outcome fallback", async () => {
    const s = setup(treeSays(ANSWER), { llm: laneLlm({ compose: async () => ({ ok: false, error: "all lane legs failed — anthropic/claude-sonnet-5-5: quota" }) }) });
    const t = s.turn("你觉得呢？");
    const out = await s.worker.triageTurn(t.input);
    const v = verdictOf(s.store, t.run_id)!;
    expect(out).toEqual({ kind: "fallthrough", route: { role: "default", effort: null, verdict_id: v.verdict_id } });
    expect(v).toMatchObject({ lane: "answer", reason: "routed", route_outcome: "fallback", handler_outcome: "fallthrough:compose_failed" });
    expect(triageRows(s.store, t.run_id)).toMatchObject([{ route_lane: "answer", decision: "fallback", verdict: "routed" }]);
    expect(decisions(s.store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    expect(s.store.laneTurnsSince("555", null)).toEqual([]);
    s.store.close();
  });
  it("a card that fails to render after a reply: fallthrough:render_failed, fallback; the reply text is discarded", async () => {
    const s = setup(treeSays(ANSWER));
    s.worker.breakLaneCardForTest();
    const t = s.turn("你觉得呢？");
    expect(await s.worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(verdictOf(s.store, t.run_id)).toMatchObject({ lane: "answer", route_outcome: "fallback", handler_outcome: "fallthrough:render_failed" });
    s.store.close();
  });
  it("HOUGE_JEV_LANES_OFF=answer: an answer turn runs the planner on the gear's role, reason routed, as if its rows were absent", async () => {
    const s = setup(treeSays(ANSWER));
    vi.stubEnv("HOUGE_JEV_LANES_OFF", "answer");
    const t = s.turn("你觉得呢？");
    expect(await s.worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "fast", effort: "low" } });
    expect(verdictOf(s.store, t.run_id)).toMatchObject({ category: "answer", lane: "planner", reason: "routed" });
    s.store.close();
  });
});

describe("a stated rule with a lane (stage B §4: save first, then settle-after or patch)", () => {
  const RULE_ANSWER: Says = { ...ANSWER, sets_rule: 0.95 };
  it("a save the lesson service refuses (not durable): the lane still replies and settles ONCE after it, save_outcome not_durable", async () => {
    const notDurable: Llm = async (input) =>
      (/durable/i.test(String(input.system ?? "")) ? { ok: true, output: { answer: JSON.stringify({ durable: false }) } } : laneLlm()(input));
    const s = setup(treeSays(RULE_ANSWER), { llm: notDurable });
    const t = s.turn("以后回复短一点，你觉得 NAS 放哪里好？");
    expect((await s.worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(verdictOf(s.store, t.run_id)).toMatchObject({ lane: "answer", save_outcome: "not_durable", handler_outcome: "lane_reply", route_outcome: "act" });
    expect(triageRows(s.store, t.run_id)).toHaveLength(1);
    expect(s.store.getActiveLessons("ask")).toHaveLength(0);
    s.store.close();
  });
  it("a committed save: pending inside the save, patched lane_reply with the model; the card ends with the saved line; the prompt has the [memory] note", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let atCompose: string | undefined; let store!: RunStore; let runId = "";
    const llm = laneLlm({ seen, compose: async () => { atCompose = store.getJevVerdictForRun(runId)?.handler_outcome; return { ok: true, output: { answer: "书房。", model: "claude-sonnet-5-5" } }; } });
    const s = setup(treeSays(RULE_ANSWER), { llm }); store = s.store;
    const t = s.turn("以后回复短一点，你觉得 NAS 放哪里好？"); runId = t.run_id;
    const out = await s.worker.triageTurn(t.input);
    expect(atCompose).toBe("pending");
    expect(out.kind).toBe("lane_reply");
    if (out.kind === "lane_reply") expect(out.text).toMatch(/^书房。\n\n📒 Saved lesson #\d+ · format$/);
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "answer", save_outcome: "saved", handler_outcome: "lane_reply", route_outcome: "act", model: "test/claude-sonnet-5-5" });
    expect(String(seen.find((i) => String(i.question).startsWith(LANE_PREFACE))?.question)).toMatch(/\[memory\] Lesson #\d+ \(format\) was just saved/);
    expect(triageRows(store, t.run_id)).toMatchObject([{ decision: "act" }]);
    store.close();
  });
  it("a committed save, then a fall-through: the verdict is patched route_outcome fallback; the planner gets the [memory] note on Default", async () => {
    const s = setup(treeSays(RULE_ANSWER), { llm: laneLlm({ compose: async () => ({ ok: true, output: { answer: "  " } }) }) });
    const t = s.turn("以后回复短一点，你觉得 NAS 放哪里好？");
    const out = await s.worker.triageTurn(t.input);
    const v = verdictOf(s.store, t.run_id)!;
    expect(out).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+/), route: { role: "default", verdict_id: v.verdict_id } });
    expect(v).toMatchObject({ save_outcome: "saved", route_outcome: "fallback", handler_outcome: "fallthrough:empty_reply" });
    expect(triageRows(s.store, t.run_id)).toMatchObject([{ decision: "act" }]); // the save-time decision: the save did act
    s.store.close();
  });
});

describe("a killed lane turn (stage B §8 aborted)", () => {
  it("no save committed: NO verdict and no triage row (the run's own failure record is the record)", async () => {
    const ctl = new AbortController();
    const s = setup(treeSays(ANSWER), { llm: laneLlm({ compose: async () => { ctl.abort(); return { ok: false, error: "aborted" }; } }) });
    const t = s.turn("你觉得呢？", ctl.signal);
    await s.worker.triageTurn(t.input);
    expect(verdictOf(s.store, t.run_id)).toBeUndefined();
    expect(triageRows(s.store, t.run_id)).toEqual([]);
    s.store.close();
  });
  it("a save committed: fallthrough:aborted, even when the supervisor's planner_failed close landed first", async () => {
    const ctl = new AbortController();
    let store!: RunStore; let runId = "";
    const llm = laneLlm({ compose: async () => { store.closePendingJevVerdict(runId, "planner_failed"); ctl.abort(); return { ok: false, error: "aborted" }; } });
    const s = setup(treeSays({ ...ANSWER, sets_rule: 0.95 }), { llm }); store = s.store;
    const t = s.turn("以后回复短一点，你觉得 NAS 放哪里好？", ctl.signal); runId = t.run_id;
    await s.worker.triageTurn(t.input);
    expect(verdictOf(store, t.run_id)).toMatchObject({ save_outcome: "saved", route_outcome: "fallback", handler_outcome: "fallthrough:aborted" });
    store.close();
  });
});

describe("the lookup lane through the worker (stage B §5)", () => {
  it("one search with its provenance row, the reader wall, a source line, the catch-up line; no loop_step", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const search = web();
    const s = setup(treeSays(LOOKUP), { llm: laneLlm({ seen, compose: async () => ({ ok: true, output: { answer: "明天晴，最高 22 度 [1]。", model: "claude-sonnet-5-5" } }) }), web: search });
    const t = s.turn("明天悉尼天气怎么样？");
    const out = await s.worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "lane_reply", text: `明天晴，最高 22 度 [1]。\n\n${SOURCE_LINE_LABEL} https://weather.example/sydney`, buttons: [DIG(t.run_id)] });
    expect(search).toHaveBeenCalledWith({ query: "明天悉尼天气怎么样？", max_results: 5 });
    expect(ledger(s.store, t.run_id, "web_search_performed")).toEqual([{ query: "明天悉尼天气怎么样？", provider: "tavily", source_urls: ["https://weather.example/sydney"], result_count: 1 }]);
    expect(seen.some((i) => String(i.question).includes("<<<UNTRUSTED>>>") && String(i.question).includes("Tomorrow: sunny"))).toBe(true);
    expect(String(seen.find((i) => String(i.question).startsWith(LANE_PREFACE))?.question)).not.toContain("Tomorrow: sunny, max 22.");
    expect(verdictOf(s.store, t.run_id)).toMatchObject({ lane: "lookup", handler_outcome: "lane_reply", route_outcome: "act" });
    expect(s.store.laneTurnsSince("555", null)).toMatchObject([{ lane: "lookup", catch_up: "Houge answered from weather.example — facts: Sunny, max 22°C" }]);
    expect(ledger(s.store, t.run_id, "loop_step")).toEqual([]);
    s.store.close();
  });
  it("a thin read fetches the top page once (http_fetch_performed) and reads it through the wall again", async () => {
    const thin = JSON.stringify({ summary: "s", facts: ["f"], time_claims: [], answer_to_objective: null, contains_instructions: false });
    const http = vi.fn(async (_input: Record<string, unknown>): Promise<ToolAdapterResult> => ({ ok: true, output: { url: "https://weather.example/sydney", status: 200, bytes: 300, content: "page" } }));
    const s = setup(treeSays(LOOKUP), { llm: laneLlm({ reader: async () => ({ ok: true, output: { answer: thin } }) }), web: web(), http });
    const t = s.turn("明天悉尼天气怎么样？");
    expect((await s.worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(http).toHaveBeenCalledTimes(1);
    expect(ledger(s.store, t.run_id, "http_fetch_performed")).toEqual([{ url: "https://weather.example/sydney", status: 200, bytes: 300 }]);
    s.store.close();
  });
  it("a lookup naming a URL goes to the planner (lane_limits) on the gear's role, acted; no search runs", async () => {
    const search = web();
    const s = setup(treeSays(LOOKUP), { web: search });
    const t = s.turn("https://example.com/post 这篇说了什么？");
    expect(await s.worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "fast", effort: "low" } });
    expect(verdictOf(s.store, t.run_id)).toMatchObject({ category: "lookup", lane: "planner", reason: "lane_limits", route_outcome: "act" });
    expect(triageRows(s.store, t.run_id)).toMatchObject([{ decision: "act", verdict: "lane_limits" }]);
    expect(search).not.toHaveBeenCalled();
    s.store.close();
  });
});

describe("the status and memory lanes leave their catch-up lines too (stage B §7, §9)", () => {
  it("the status card carries Dig deeper and a 'Houge reported its status' row", async () => {
    const s = setup(treeSays({ category: cat({ status: 0.85 }) }));
    const t = s.turn("did you restart?");
    expect(await s.worker.triageTurn(t.input)).toMatchObject({ kind: "lane_reply", buttons: [DIG(t.run_id)] });
    expect(s.store.laneTurnsSince("555", null)).toMatchObject([{ run_id: t.run_id, lane: "status", catch_up: "Houge reported its status" }]);
    s.store.close();
  });
  it("the memory lane leaves 'Houge saved a rule: <lesson>'", async () => {
    const s = setup(treeSays({ category: cat({ memory: 0.9 }), sets_rule: 0.95 }));
    const t = s.turn("以后回复短一点");
    expect((await s.worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(s.store.laneTurnsSince("555", null)).toMatchObject([{ run_id: t.run_id, lane: "memory", catch_up: "Houge saved a rule: Keep replies short." }]);
    s.store.close();
  });
});
