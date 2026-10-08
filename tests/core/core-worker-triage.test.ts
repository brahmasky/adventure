import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretBroker } from "../../src/config/secret-broker.js";
import { CASCADE_TIMEOUT_MS, parseCascadePick, type CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { JEV_INCIDENT_SUBJECT } from "../../src/jev/jev-incidents.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_STATUS_ARM_ID } from "../../src/jev/tree-policy.js";
import type { TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { drainOutbox, ompWorker } from "../helpers/omp-worker.js";

// Spec §2 / §6: ONE decision point per Telegram text turn. Every eligible, still-active exit writes exactly one `triage`
// event, one verdict row and its decision rows, in one transaction (inside the lesson's save transaction when a rule
// saved). A turn that ended writes nothing late. The route it returns is what the planner pins: a wrong role here is
// the user-visible change of stage A, so each case asserts the role, not just "fell through". And every verdict ends:
// one left `pending` skews the §7/§9 evidence and the lane sweep forever (F12).
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The versioned id Jev reports; the gate file's rows key on it (the request names the alias `jev-latest`, which never arms). */
const REPORTED = "jev-1.13.0";
const n = CATEGORIES.length;
/** A category answer: the given probabilities, the rest split evenly (sums to 1, as Jev's do). */
function cat(p: Partial<Record<Category, number>>) {
  const used = Object.values(p).reduce((a, b) => a + (b ?? 0), 0);
  const rest = CATEGORIES.filter((c) => p[c] === undefined);
  const probabilities = Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? (1 - used) / rest.length]));
  const [choice, pMax] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
}
const only = (p: Partial<Record<Category, number>>) => cat(Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? 0])));
const scope = (ask: number) => ({ type: "choice", choice: ask >= 0.5 ? "ask" : "research", probabilities: { ask, research: 1 - ask }, confidence: Math.abs(2 * ask - 1) });
const level = (probs: number[]) => ({ type: "score", score: probs.reduce((s, p, k) => s + k * p, 0),
  probabilities: Object.fromEntries(probs.map((p, k) => [String(k), p])), confidence: 0.8 });
const LIGHT = [0.1, 0.9, 0, 0];   // expected 0.9 → Fast, effort low
const HEAVY = [0, 0, 0.2, 0.8];   // expected 2.8 → Thinking, effort high
type Says = { category?: ReturnType<typeof cat>; sets_rule?: number; ask?: number; gear?: number[]; model?: string };
const treeSays = (o: Says = {}) => vi.fn(async (_url?: unknown, _init?: unknown) => json(200, {
  model: o.model ?? REPORTED, usage: { input_tokens: 900, output_tokens: 0 }, answers: {
    category: o.category ?? cat({ other: 0.9 }), sets_rule: { type: "noul", noul: o.sets_rule ?? 0.05 }, rule_scope: scope(o.ask ?? 0.9),
    breadth: level(o.gear ?? LIGHT), reasoning: level(o.gear ?? LIGHT), actions: level(o.gear ?? LIGHT) } }));
const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };

type Llm = (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
const isDistill = (input: Record<string, unknown>) => /durable/i.test(String(input.system ?? ""));
const isCascade = (input: Record<string, unknown>) => /exactly one of these two words/.test(String(input.system ?? ""));
/**
 * The test-injected seat: the lesson-write service's two calls and the cascade's one (Decision 14), told apart by their
 * system prompt. With no `cascade` fake a cascade call fails, which must read as cascade_failed, never as a pick.
 */
const lessonLlm = (h: { distill?: () => void; reconcile?: () => void; cascade?: Llm } = {}): Llm => async (input) => {
  if (isCascade(input)) return h.cascade ? h.cascade(input) : { ok: false, error: "no cascade fake" };
  if (isDistill(input)) { h.distill?.(); return { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short." }) } }; }
  h.reconcile?.();
  return { ok: true, output: { answer: JSON.stringify({ verdict: "ADD", theme: "format" }) } };
};
/** A cascade that answers `answer`, recording what it was asked. */
const picks = (answer: string, seen: Record<string, unknown>[] = []): Llm => async (input) => { seen.push(input); return { ok: true, output: { answer } }; };

/**
 * Arming needs calibration rows (none ship, plan Decision 6): the gate-only file names the six questions plus the status
 * row, minus any id in `omit` (a partial row commit, the case F6 guards).
 */
function calibrationFile(omit: readonly string[] = []): string {
  const f = join(mkdtempSync(join(tmpdir(), "htri-cal-")), "rows.json");
  const ids = [...TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const), [TREE_STATUS_ARM_ID, criteriaHash(TREE_CATEGORY)] as const]
    .filter(([id]) => !omit.includes(id));
  writeFileSync(f, JSON.stringify(ids.flatMap(([question_id, criteria_hash]) => (["zh", "en"] as const).map((lang) =>
    ({ question_id, criteria_hash, model: REPORTED, lang, approved: "test", evidence: "test" })))));
  return f;
}
const ARM = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" };
const SHADOW = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow" };

function setup(fetchImpl: unknown, env: Record<string, string> = ARM, o: { llm?: Llm; jevNow?: () => Date; omit?: string[] } = {}) {
  vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", calibrationFile(o.omit)); vi.stubEnv("HOUGE_JEV_GATE", "1");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  const store = RunStore.openInMemory();
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "htri-")), { llm: o.llm ?? lessonLlm(), jevFetch: fetchImpl as typeof fetch, ...(o.jevNow ? { jevNow: o.jevNow } : {}) });
  const claimed = (run_id: string, text: string, w: CoreWorker = worker) => {
    const claim = store.claimRun(run_id, "w", 120)!;
    w.buildOmpTools(claim, "555");
    return { run_id, claim, input: { claim, text, userText: text, modality: "text" as const, posture: null, signal: new AbortController().signal } };
  };
  const turn = (text: string) => claimed(createQueuedTurnRun(store, text), text);
  return { store, worker, turn, claimed };
}
const triageRows = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "triage").map((e) => e.payload);
const decisions = (store: RunStore, run_id: string) => store.listJevDecisions(run_id);
const verdictOf = (store: RunStore, run_id: string) => store.getJevVerdictForRun(run_id);
const sinkOf = (w: CoreWorker) => (w as unknown as { ompOutcomeSink: (chat: string) => TurnOutcomeSink }).ompOutcomeSink("555");
/** A pending verdict on a run that never reached triageTurn in this test (the terminal-path cases need only the row). */
const pendingVerdict = (store: RunStore, run_id: string) => store.insertJevVerdict({ run_id, category: "answer", breadth: 0.9, reasoning: 0.9,
  actions: 0.9, sets_rule: 0.05, rule_scope: null, lane: "planner", role: "fast", effort: "low", cascade: null, save_outcome: "none",
  route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });

/** A delivered Houge reply: its run, its one assistant turn, its final_report delivered as Telegram message `mid`. */
function deliveredReply(store: RunStore, text: string, mid: number): string {
  const run = createQueuedTurnRun(store, "明天天气怎么样");
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "assistant", text });
  store.enqueueFinalReportNotification(run, { text, report_path: "/tmp/houge-test-report.md" });
  const sent = store.claimNextNotification("test", 30)!;
  store.markNotificationDelivered(sent.notification_id, `telegram:${mid}`);
  return run;
}
/** A turn born from a Telegram reply to message `replyTo` (the adapter puts reply_to_message_id in the event metadata). */
function quotingRun(store: RunStore, text: string, replyTo: number): string {
  const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `q:${replyTo}:${text}`, source_reference: `telegram:update:9:message:${replyTo + 1}`,
    metadata: { telegram_update_id: 9, telegram_message_id: replyTo + 1, reply_to_message_id: replyTo } }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("triageTurn — the code-owned exits (one triage row, one verdict row, the Default route)", () => {
  // F13 / spec §4.3: off is the rollback. It still leaves the §6 row and the denominator event, but attaches NO route, so
  // the supervisor pins nothing and (with HOUGE_MODEL_ROLES=static) the model path is the pre-stage-A one.
  it("flag off: skipped{disabled}, no fetch, one verdict and one triage event, and NO route", async () => {
    const fetchImpl = vi.fn();
    const { store, worker, turn } = setup(fetchImpl, { HOUGE_JEV_ENABLED: "0" });
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    expect(out).toEqual({ kind: "fallthrough" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const v = verdictOf(store, t.run_id)!;
    expect(v).toMatchObject({ category: null, lane: "planner", role: "default", route_outcome: "fallback", reason: "jev_skipped", skip_reason: "disabled",
      save_outcome: "none", handler_outcome: "pending" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "disabled", decision: "fallback", category: null,
      route_lane: "planner", role: "default", verdict_id: v.verdict_id, verdict: "jev_skipped", margin: null }]);
    expect(decisions(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "disabled" }]);
    store.close();
  });
  it("photo turn: skipped{modality}; killed posture: skipped{posture}; neither asks Jev", async () => {
    const fetchImpl = treeSays(RULE);
    const { store, worker, turn } = setup(fetchImpl);
    const photo = turn("caption");
    expect(await worker.triageTurn({ ...photo.input, modality: "photo" })).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, photo.run_id)).toMatchObject([{ skip_reason: "modality" }]);
    const killed = turn("以后回复短一点");
    await worker.triageTurn({ ...killed.input, posture: "killed" });
    expect(triageRows(store, killed.run_id)).toMatchObject([{ skip_reason: "posture" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
    store.close();
  });
  it("think harder on a skipped turn still routes Thinking (Paco's word is code, not a judgment)", async () => {
    const { store, worker, turn } = setup(vi.fn());
    const t = turn("认真想一下这个方案");
    expect(await worker.triageTurn({ ...t.input, modality: "photo" })).toMatchObject({ route: { role: "thinking", effort: null } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ role: "thinking", skip_reason: "modality" });
    store.close();
  });
  it("think harder with the flag off: still no route, and the verdict says Default (the rollback ignores it)", async () => {
    const { store, worker, turn } = setup(vi.fn(), { HOUGE_JEV_ENABLED: "0" });
    const t = turn("认真想一下这个方案");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(verdictOf(store, t.run_id)).toMatchObject({ role: "default", reason: "jev_skipped", skip_reason: "disabled" });
    store.close();
  });
  it("an ack of a plain answer is answer on Fast with no Jev call; still one triage row and one skipped row", async () => {
    const fetchImpl = treeSays();
    const { store, worker, turn } = setup(fetchImpl);
    store.recordChatTurn({ chat_id: "555", run_id: "prev", role: "assistant", text: "明天晴，最高 25 度。" });
    const t = turn("谢谢");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "fast", effort: "low" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "answer", role: "fast", reason: "ack_rule", skip_reason: "ack_rule", route_outcome: "act" });
    expect(decisions(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "ack_rule" }]);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", decision: "act", verdict: "ack_rule" }]);
    store.close();
  });
  it("the same ack after a proposal is judged by Jev (the ack ambiguity)", async () => {
    const fetchImpl = treeSays();
    const { store, worker, turn } = setup(fetchImpl);
    store.recordChatTurn({ chat_id: "555", run_id: "prev", role: "assistant", text: "要不要我帮你订明天的票？" });
    await worker.triageTurn(turn("好").input);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    store.close();
  });
  it("an override run (Ask Houge anyway) is never triaged again", async () => {
    const fetchImpl = treeSays(RULE);
    const { store, worker, turn } = setup(fetchImpl);
    const t = turn("以后回复短一点");
    store.recordMemoryEvent("triage_override", { run_id: "run_old", new_run_id: t.run_id, change_id: null });
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(triageRows(store, t.run_id)).toMatchObject([{ skip_reason: "override" }]);
    store.close();
  });
});

describe("triageTurn — routed planner turns (the role the planner pins)", () => {
  it.each([
    ["self_change on a light gear is floored to Default", cat({ self_change: 0.9 }), LIGHT, { role: "default", effort: "low" }],
    ["research on a light gear is floored to Thinking", cat({ research: 0.9 }), LIGHT, { role: "thinking", effort: "low" }],
    ["answer on a light gear runs Fast", cat({ answer: 0.9 }), LIGHT, { role: "fast", effort: "low" }],
    ["answer on a heavy gear runs Thinking, effort high", cat({ answer: 0.9 }), HEAVY, { role: "thinking", effort: "high" }]
  ] as const)("%s", async (_name, category, gear, route) => {
    const { store, worker, turn } = setup(treeSays({ category, gear: [...gear] }));
    const t = turn("明天天气怎么样");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route });
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "planner", ...route, reason: "routed", route_outcome: "act", handler_outcome: "pending" });
    expect(decisions(store, t.run_id)).toHaveLength(6);
    expect(decisions(store, t.run_id).every((r) => r.decision === "act" && r.threshold_used === "2026-10-07.1:routed")).toBe(true);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", route_lane: "planner", role: route.role, decision: "act" }]);
    store.close();
  });
  it("the verdict records the three expected levels and p(sets_rule)", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.1 }));
    const t = turn("明天天气怎么样");
    await worker.triageTurn(t.input);
    const v = verdictOf(store, t.run_id)!;
    expect(v.breadth).toBeCloseTo(0.9); expect(v.reasoning).toBeCloseTo(0.9); expect(v.actions).toBeCloseTo(0.9); expect(v.sets_rule).toBeCloseTo(0.1);
    store.close();
  });
  it("think harder: Thinking, and the chat's previous verdict gets the think_harder correction", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ answer: 0.9 }) }));
    const first = turn("明天天气怎么样");
    await worker.triageTurn(first.input);
    const second = turn("认真想一下，明天要不要带伞");
    expect(await worker.triageTurn(second.input)).toMatchObject({ route: { role: "thinking" } });
    expect(verdictOf(store, first.run_id)?.paco_correction).toBe("think_harder");
    expect(verdictOf(store, second.run_id)?.paco_correction).toBeNull();
    store.close();
  });
  it("memory with sets_rule no is a correction: the planner on Default, nothing saved, no seat call", async () => {
    const llm = vi.fn(lessonLlm());
    const { store, worker, turn } = setup(treeSays({ category: cat({ memory: 0.9 }), sets_rule: 0.1 }), ARM, { llm });
    const t = turn("上次记错了，我不住在北京");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "memory", lane: "planner", reason: "correction", save_outcome: "none" });
    expect(llm).not.toHaveBeenCalled();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("bare-ack guard: a 好 Jev calls status goes to the planner, not the status lane", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ status: 0.9 }) }));
    const t = turn("好");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "status", lane: "planner", reason: "bare_ack_guard" });
    store.close();
  });
});

describe("triageTurn — below the choice bar: the live cascade (Decision 14, Tiny role, 20 s)", () => {
  // Spec §2.4: an unsure category is settled by one cheap model pick between Jev's top two, never by guessing; a failure
  // anywhere is the Default planner with nothing saved. The 20 s bound is Paco's: the user waits at most that long.
  const BELOW = { category: cat({ lookup: 0.5, research: 0.3 }) };
  it("a pick routes as that category: its floor, reason cascade, cascade tiny, the pair on the triage event", async () => {
    const seen: Record<string, unknown>[] = [];
    const { store, worker, turn } = setup(treeSays(BELOW), ARM, { llm: lessonLlm({ cascade: picks("research", seen) }) });
    const t = turn("比较一下这三个城市的冬天");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "thinking" } }); // research floors at Thinking
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "research", cascade: "tiny", reason: "cascade", route_outcome: "act", save_outcome: "none" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", verdict: "cascade", decision: "act", category: "research",
      cascade_between: ["lookup", "research"] }]);
    expect(seen).toHaveLength(1); // exactly one call per below-bar turn
    expect(String(seen[0]!.system)).toMatch(/lookup, research/);
    expect(String(seen[0]!.question)).toContain("比较一下这三个城市的冬天");
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal); // the turn's abort and the bound both reach the seat
    store.close();
  });
  it("a pick with a stated rule saves first under the pick's scope, then the planner runs on the pick's role", async () => {
    const { store, worker, turn } = setup(treeSays({ ...BELOW, sets_rule: 0.95 }), ARM, { llm: lessonLlm({ cascade: picks("lookup") }) });
    const t = turn("以后短一点，比较一下这三个城市的冬天");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+/), route: { role: "fast" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "lookup", cascade: "tiny", reason: "cascade", save_outcome: "saved", rule_scope: "ask" });
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it.each([
    ["an answer outside the two", picks("lookup or research")],
    ["a no-pick answer", picks("memory")],
    ["a failed seat call", (async () => ({ ok: false, error: "all cascade legs failed" })) as Llm],
    ["a thrown seat call", (async () => { throw new Error("boom"); }) as Llm]
  ])("%s: cascade_failed on Default, and despite sets_rule yes nothing saves (a failure anywhere saves nothing)", async (_name, cascade) => {
    const distill = vi.fn();
    const { store, worker, turn } = setup(treeSays({ ...BELOW, sets_rule: 0.95 }), ARM, { llm: lessonLlm({ cascade, distill }) });
    const t = turn("比较一下这三个城市的冬天");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(distill).not.toHaveBeenCalled();
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: null, cascade: "tiny", reason: "cascade_failed", route_outcome: "fallback", save_outcome: "none" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ verdict: "cascade_failed", decision: "fallback", cascade_between: ["lookup", "research"] }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a cascade that hangs is cut at CASCADE_TIMEOUT_MS: the in-flight call is aborted and the turn takes Default", async () => {
    let abortedAtBound: boolean | undefined;
    const hang: Llm = (input) => {
      vi.advanceTimersByTime(CASCADE_TIMEOUT_MS); // the bound passes while the call is in flight (its timer is armed first)
      abortedAtBound = (input.signal as AbortSignal).aborted;
      return new Promise<ToolAdapterResult>(() => {}); // never answers: only the bound ends the user's wait
    };
    const { store, worker, turn } = setup(treeSays(BELOW), ARM, { llm: lessonLlm({ cascade: hang }) });
    const t = turn("比较一下这三个城市的冬天");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(await worker.triageTurn(t.input)).toMatchObject({ route: { role: "default" } });
    expect(abortedAtBound).toBe(true); // omp kills the leg on abort; a hung leg never outlives the turn's wait
    expect(verdictOf(store, t.run_id)).toMatchObject({ cascade: "tiny", reason: "cascade_failed" });
    expect(CASCADE_TIMEOUT_MS).toBe(20_000); // Paco's bound (2026-10-07); a change is his call, not a refactor's
    store.close();
  });
  it("think harder still routes Thinking when the cascade fails", async () => {
    const { store, worker, turn } = setup(treeSays(BELOW));
    expect(await worker.triageTurn(turn("认真想一下，比较这三个城市").input)).toMatchObject({ route: { role: "thinking" } });
    store.close();
  });
  it("memory and status are removed: with one candidate left it is taken, with no call", async () => {
    const cascade = vi.fn(picks("lookup"));
    const { store, worker, turn } = setup(treeSays({ category: only({ memory: 0.5, status: 0.3, lookup: 0.2 }) }), ARM, { llm: lessonLlm({ cascade }) });
    const t = turn("记一下明天的天气");
    expect(await worker.triageTurn(t.input)).toMatchObject({ route: { role: "fast" } });
    expect(cascade).not.toHaveBeenCalled();
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "lookup", cascade: null, reason: "cascade" });
    expect(triageRows(store, t.run_id)[0]).not.toHaveProperty("cascade_between");
    store.close();
  });
  it("shadow arms nothing, so a below-bar answer never reaches the cascade (shadow never changes behaviour)", async () => {
    const cascade = vi.fn(picks("research"));
    const { store, worker, turn } = setup(treeSays(BELOW), SHADOW, { llm: lessonLlm({ cascade }) });
    await worker.triageTurn(turn("比较一下这三个城市的冬天").input);
    expect(cascade).not.toHaveBeenCalled();
    store.close();
  });
  // Exact token (Decision 14): wrappers a model adds around one word are stripped; anything with more words is no pick.
  it("parseCascadePick takes exactly one of the two names", () => {
    const pair = ["lookup", "research"] as const;
    expect(["research", " Research. ", "`lookup`", "**lookup**", "\"research\""].map((a) => parseCascadePick(a, pair)))
      .toEqual(["research", "research", "lookup", "lookup", "research"]);
    expect(["lookup or research", "answer", "", "research\nbecause"].map((a) => parseCascadePick(a, pair))).toEqual([null, null, null, null]);
  });
});

describe("triageTurn — the memory lane and save-then-route (spec §3)", () => {
  it("memory + sets_rule yes: saves, replies with the card, decisions act, verdict lane_reply", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind !== "lane_reply") return;
    expect(out.text).toMatch(/^📒 Saved lesson #\d+ · format/);
    expect(out.buttons.map((b) => b.data.split(":")[1])).toEqual(["undo", "ask"]);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", category: "memory", route_lane: "memory", decision: "act", lang: "zh" }]);
    expect(decisions(store, t.run_id)).toHaveLength(6);
    expect(decisions(store, t.run_id).every((r) => r.decision === "act")).toBe(true);
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "memory", save_outcome: "saved", handler_outcome: "lane_reply", rule_scope: "ask", route_outcome: "act" });
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("rule_scope research at p 0.6 saves under research", async () => {
    const { store, worker, turn } = setup(treeSays({ ...RULE, ask: 0.4 }));
    await worker.triageTurn(turn("以后查资料优先用官方来源").input);
    expect(store.getActiveLessons("research")).toHaveLength(1);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("the card names the saved row's theme: an UPDATE onto a themed lesson shows that theme, not the verdict's", async () => {
    const llm: Llm = async (input) => isDistill(input)
      ? { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short and lead with the result." }) } }
      : { ok: true, output: { answer: JSON.stringify({ verdict: "UPDATE", id: 1, text: "Be concise; lead with the result.", theme: "nonsense" }) } };
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm });
    store.addLesson({ scope: "ask", text: "Be concise.", theme: "format", source: "loop", created_at: new Date().toISOString() });
    const out = await worker.triageTurn(turn("以后回复先说结论").input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind === "lane_reply") expect(out.text).toMatch(/· format/);
    store.close();
  });
  it("a rule on a lookup saves first, then the planner runs on the lookup's role with the [memory] note", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95 }));
    const t = turn("以后短一点，另外明天天气怎么样？");
    const out = await worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+ \(format\)/), route: { role: "fast", effort: "low" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "lookup", lane: "planner", save_outcome: "saved", handler_outcome: "pending" });
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("memory lane, nothing durable: no card, the planner on Default, decision fallback, verdict fallthrough:not_durable", async () => {
    const notDurable: Llm = async () => ({ ok: true, output: { answer: JSON.stringify({ durable: false }) } });
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: notDurable });
    const t = turn("谢谢你");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ route_lane: "memory", decision: "fallback" }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "memory", save_outcome: "not_durable", handler_outcome: "fallthrough:not_durable" });
    store.close();
  });
});

describe("triageTurn — the status lane", () => {
  it("code-rendered houge_status text, no planner, no LLM; verdict lane_reply", async () => {
    const llm = vi.fn(lessonLlm());
    const { store, worker, turn } = setup(treeSays({ category: cat({ status: 0.85 }) }), ARM, { llm });
    const t = turn("did you restart?");
    const out = await worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind === "lane_reply") { expect(out.buttons).toEqual([]); expect(out.text.length).toBeGreaterThan(10); }
    expect(triageRows(store, t.run_id)).toMatchObject([{ route_lane: "status", decision: "act", lang: "en" }]);
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "status", handler_outcome: "lane_reply" });
    expect(llm).not.toHaveBeenCalled();
    store.close();
  });
  // A broken status renderer must stay visible: the verdict keeps lane=status with handler fallthrough:render_failed, so the
  // lane_fallthrough_rate sweep counts it (a planner-lane re-settle would hide it). Its decision rows stay `fallback`: an `act`
  // row on a turn the planner then answered corrupts the status precision evidence the arm decision reads. Settled once.
  it("a render throw settles once on the status lane as fallthrough:render_failed (never act) and the planner answers on Default", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ status: 0.85 }) }));
    vi.spyOn(worker as unknown as { hougeStatusText: () => string }, "hougeStatusText").mockImplementation(() => { throw new Error("render"); });
    const t = turn("did you restart?");
    const out = await worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    const v = verdictOf(store, t.run_id);
    // the status route did not act (the planner answered): route_outcome and the triage verdict read as any other fallback
    expect(v).toMatchObject({ category: "status", lane: "status", handler_outcome: "fallthrough:render_failed", route_outcome: "fallback",
      reason: "jev_skipped" });
    if (out.kind === "fallthrough") expect(out.route?.verdict_id).toBe(v!.verdict_id);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", route_lane: "status", decision: "fallback", verdict: "jev_skipped" }]);
    expect(triageRows(store, t.run_id)).toHaveLength(1);
    expect(decisions(store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    store.close();
  });
});

describe("triageTurn — a partial row commit (F6: each decision arms on its own rows)", () => {
  // Paco may commit rows question by question. Without the rule rows a stated rule cannot be read, so it must not be
  // swallowed by the status lane's code reply, and the memory lane (which exists to save rules) must not act either.
  it("status armed, rule rows not: the status lane does not act; the planner answers on Default", async () => {
    const llm = vi.fn(lessonLlm());
    const { store, worker, turn } = setup(treeSays({ category: cat({ status: 0.9 }), sets_rule: 0.95 }), ARM, { llm, omit: ["sets_rule", "rule_scope"] });
    const t = turn("did you restart? and from now on reply in English");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "status", lane: "planner", reason: "uncalibrated", save_outcome: "none" });
    expect(llm).not.toHaveBeenCalled();
    store.close();
  });
  it("category armed, rule rows not: a memory turn is uncalibrated and nothing saves", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { omit: ["sets_rule", "rule_scope"] });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "memory", lane: "planner", reason: "uncalibrated" });
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
});

describe("triageTurn — arming, shadow and outages", () => {
  it("shadow: rows say shadow, the route is Default, nothing acts", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), SHADOW);
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "shadow" }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "shadow")).toBe(true);
    expect(verdictOf(store, t.run_id)).toMatchObject({ reason: "uncalibrated", route_outcome: "fallback" });
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    store.close();
  });
  it("armed with no gate file: the committed rows are empty (Decision 6), so the turn is uncalibrated and nothing saves", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", ""); vi.stubEnv("HOUGE_JEV_GATE", "");
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ reason: "uncalibrated", category: null });
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a model the rows do not name: answered, uncalibrated, decision fallback", async () => {
    const { store, worker, turn } = setup(treeSays({ ...RULE, model: "jev-1.14.0" }));
    const t = turn("以后回复短一点");
    await worker.triageTurn(t.input);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback", verdict: "uncalibrated" }]);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  // The request names `jev-latest`; calibration keys on the REPORTED id (shipped 2026-10-07, c026e5c). An alias move leaves
  // every tree decision unarmed, which is safe but silent, so the answered call pages Paco once per model. The incident
  // resolves only once rows name that model, never because a calibrated id answered in between (a canary would re-page).
  const uncalibrated = (store: RunStore) => store.listOpenIncidents().filter((i) => i.kind === "jev_model_uncalibrated");
  it("an alias move (arm): one jev_model_uncalibrated incident for the new id; a calibrated id answering leaves it open", async () => {
    const m = { model: "jev-1.14.0" };
    const { store, worker, turn } = setup(vi.fn(async (u?: unknown, i?: unknown) => treeSays({ model: m.model })(u, i)));
    await worker.triageTurn(turn("明天天气怎么样").input);
    await worker.triageTurn(turn("后天呢").input);
    expect(uncalibrated(store)).toMatchObject([{ subject: "jev-1.14.0" }]);
    m.model = REPORTED;
    await worker.triageTurn(turn("大后天呢").input);
    expect(uncalibrated(store)).toMatchObject([{ subject: "jev-1.14.0" }]);
    store.close();
  });
  it("no page in shadow, and none when no live tree row exists (nothing armed, nothing lost)", async () => {
    const shadow = setup(treeSays({ model: "jev-1.14.0" }), SHADOW);
    await shadow.worker.triageTurn(shadow.turn("明天天气怎么样").input);
    expect(uncalibrated(shadow.store)).toHaveLength(0);
    shadow.store.close();
    const ids = [...TREE_QUESTIONS.map((q) => q.id), TREE_STATUS_ARM_ID];
    const bare = setup(treeSays({ model: "jev-1.14.0" }), ARM, { omit: ids });
    await bare.worker.triageTurn(bare.turn("明天天气怎么样").input);
    expect(uncalibrated(bare.store)).toHaveLength(0);
    bare.store.close();
  });
  it("Jev 429: skipped{rate_limited}, incident jev_rate_limited, Default", async () => {
    const { store, worker, turn } = setup(vi.fn(async () => json(429, {})));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "rate_limited" }]);
    expect(verdictOf(store, t.run_id)).toMatchObject({ skip_reason: "rate_limited", reason: "jev_skipped", category: null });
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_rate_limited")).toBe(true);
    store.close();
  });
  it("triage_overrides resolves on the next turn once the disarm marker is gone, and stays open while it exists", async () => {
    const { store, worker, turn } = setup(treeSays());
    const marker = join(mkdtempSync(join(tmpdir(), "htri-mk-")), "houge.jev-disarmed");
    vi.stubEnv("HOUGE_JEV_DISARM_PATH", marker);
    writeFileSync(marker, JSON.stringify({ reason: "triage_overrides", at: "x" }));
    store.openIncident({ kind: "triage_overrides", subject: JEV_INCIDENT_SUBJECT, detail: {} });
    await worker.triageTurn(turn("hello").input);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["triage_overrides"]);
    rmSync(marker);
    await worker.triageTurn(turn("hello again").input);
    expect(store.listOpenIncidents()).toHaveLength(0);
    store.close();
  });
  it("the triage state carries the code-observed keys and no quoted_turn on a plain message", async () => {
    const fetchImpl = treeSays();
    const { store, worker, turn } = setup(fetchImpl, SHADOW);
    await worker.triageTurn(turn("明天天气怎么样").input);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { state: Record<string, unknown>; questions: Record<string, unknown> };
    expect(Object.keys(body.state)).toEqual(expect.arrayContaining(["last_houge_turn", "latest_message", "modality", "recent_turns"]));
    expect(body.state.quoted_turn ?? null).toBeNull();
    expect(Object.keys(body.questions)).toEqual(["category", "sets_rule", "rule_scope", "breadth", "reasoning", "actions"]);
    store.close();
  });
  it("the broker's key wins over the environment and reaches the Authorization header", async () => {
    let seenAuth = "";
    const body = treeSays();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => { seenAuth = String((init.headers as Record<string, string>).authorization); return body(url, init); });
    vi.stubEnv("HOUGE_JEV_ENABLED", "1"); vi.stubEnv("HOUGE_JEV_TRIAGE_ENABLED", "shadow"); vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "htri-")), { llm: lessonLlm(), jevFetch: fetchImpl as unknown as typeof fetch,
      broker: { typesafeKey: () => "test-key", redact: (s: string) => s } as unknown as SecretBroker });
    const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
    await worker.triageTurn({ claim, text: "以后回复短一点", userText: "以后回复短一点", modality: "text", posture: null, signal: new AbortController().signal });
    expect(seenAuth).toBe("Bearer test-key");
    store.close();
  });
});

describe("triageTurn — a Telegram quote anchors the turn (spec §2.2.1)", () => {
  it("a reply to a delivered Houge proposal: quoted_turn reaches Jev, the outcome carries the quote, the ack rule does not settle it", async () => {
    const fetchImpl = treeSays();
    const { store, worker, claimed } = setup(fetchImpl);
    deliveredReply(store, "要不要我帮你订一张明天的票？", 42);
    store.recordChatTurn({ chat_id: "555", run_id: "later", role: "assistant", text: "明天晴，最高 25 度。" }); // the latest Houge turn is a plain answer
    const resolved = store.resolveQuotedTurn("555", 42);
    if (!resolved.ok) throw new Error("fixture did not resolve");
    const t = claimed(quotingRun(store, "好", 42), "好");
    const out = await worker.triageTurn(t.input);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // without the quote this "好" after an answer would be the ack rule
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { state: Record<string, unknown> };
    expect(body.state.quoted_turn).toMatchObject({ role: "houge", kind: "proposal", text: "要不要我帮你订一张明天的票？" });
    expect(out).toMatchObject({ quote: { turn_id: resolved.turn.turn_id, line: expect.stringMatching(/^\[replying to houge/) } });
    expect(verdictOf(store, t.run_id)?.quoted_turn_id).toBe(resolved.turn.turn_id);
    store.close();
  });
  // Spec §2.2.1 "In the handlers": the reply being corrected is the quoted one, not whatever Houge said last.
  it("a rule quoting an older Houge reply hands THAT reply to the distill as the prior answer", async () => {
    const questions: string[] = [];
    const base = lessonLlm();
    const llm: Llm = async (input) => { if (isDistill(input)) questions.push(String(input.question)); return base(input); };
    const { store, worker, claimed } = setup(treeSays(RULE), ARM, { llm });
    deliveredReply(store, "明天的行程我列了十二条，每条都附了说明。", 42);
    store.recordChatTurn({ chat_id: "555", run_id: "later", role: "assistant", text: "明天晴，最高 25 度。" });
    const t = claimed(quotingRun(store, "以后这种回复短一点", 42), "以后这种回复短一点");
    expect((await worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("明天的行程我列了十二条");
    expect(questions[0]).not.toContain("最高 25 度");
    store.close();
  });
  it("a quote that does not resolve: one quote_unresolved note, no quoted_turn, a plain message", async () => {
    const fetchImpl = treeSays();
    const { store, worker, claimed } = setup(fetchImpl);
    const t = claimed(quotingRun(store, "好的，就这样", 99), "好的，就这样");
    const out = await worker.triageTurn(t.input);
    expect(store.getLedgerEvents(t.run_id).filter((e) => e.event_type === "quote_unresolved").map((e) => e.payload)).toEqual([{ reason: "no_mapping" }]);
    expect(out).not.toHaveProperty("quote");
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { state: Record<string, unknown> };
    expect(body.state.quoted_turn ?? null).toBeNull();
    store.close();
  });
});

describe("triageTurn — one finalisation per turn, atomic with the lane's save", () => {
  it("a throw after the save (card builder) yields inform, decisions act, one triage row, verdict still pending", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    worker.breakMemoryLaneCardForTest();
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+/), route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toHaveLength(1);
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ decision: "act", route_lane: "memory" });
    expect(decisions(store, t.run_id).every((r) => r.decision === "act")).toBe(true);
    expect(verdictOf(store, t.run_id)).toMatchObject({ save_outcome: "saved", handler_outcome: "pending" }); // the planner answers; routeEnd closes it
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("a rolled-back inTx hook leaves no lesson, no guard, exactly one fallback triage row and one verdict", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    worker.breakLaneFinalizeOnceForTest();
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    expect(store.getLedgerEvents(t.run_id).filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback" }]);
    expect(decisions(store, t.run_id).filter((r) => r.decision === "fallback")).toHaveLength(6);
    expect(verdictOf(store, t.run_id)).toMatchObject({ save_outcome: "not_durable", handler_outcome: "fallthrough:not_durable" });
    const again = await worker.runLessonWrite(t.claim, "555", { scope: "ask" }, { source: "loop" });
    expect(again.committed).toBe(true);
    store.close();
  });
  it("decision rows, verdict and triage event share the lesson's transaction (a failing event write rolls all back)", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    const original = store.appendRunLedgerEvent.bind(store);
    const spy = vi.spyOn(store, "appendRunLedgerEvent").mockImplementation((run_id, type, actor, payload) => {
      if (type === "triage") throw new Error("disk");
      return original(run_id, type, actor, payload);
    });
    await worker.triageTurn(t.input).catch(() => undefined);
    spy.mockRestore();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    expect(decisions(store, t.run_id).filter((r) => r.status === "answered")).toHaveLength(0);
    expect(verdictOf(store, t.run_id)).toBeUndefined();
    store.close();
  });
  it("an aborted turn writes nothing after Jev: no rows, no verdict, no event, no lesson", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点"); const ac = new AbortController();
    const p = worker.triageTurn({ ...t.input, signal: ac.signal }); ac.abort();
    expect(await p).toMatchObject({ kind: "fallthrough", route: { verdict_id: null } });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(verdictOf(store, t.run_id)).toBeUndefined();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
});

describe("triageTurn — per-stage failures (exactly one triage row each, or none for a lost turn)", () => {
  it("Jev transport failure: skipped{transport}, one row", async () => {
    const { store, worker, turn } = setup(vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "transport", decision: "fallback" }]);
    expect(decisions(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "transport" }]);
    store.close();
  });
  it("a throw before Jev answered (the clock seam): skipped{error}, one row", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { jevNow: () => { throw new Error("clock"); } });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "error" }]);
    store.close();
  });
  it("distill throws: answered fallback, six fallback rows, no lesson", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: lessonLlm({ distill: () => { throw new Error("seat down"); } }) });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", route_lane: "memory", decision: "fallback" }]);
    expect(decisions(store, t.run_id).map((r) => r.decision)).toEqual(Array(6).fill("fallback"));
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("reconcile seat throws: the service's own fallback (ADD) still saves, so the lane acts once", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: lessonLlm({ reconcile: () => { throw new Error("seat down"); } }) });
    const t = turn("以后回复短一点");
    expect((await worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "act" }]);
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("the save itself throws (store error): rolled back, answered fallback, one row, no lesson", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    vi.spyOn(store, "saveReconciledLesson").mockImplementation(() => { throw new Error("disk"); });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback" }]);
    expect(decisions(store, t.run_id).map((r) => r.decision)).toEqual(Array(6).fill("fallback"));
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it.each(["distill", "reconcile"] as const)("a turn aborted during %s writes nothing", async (stage) => {
    const ac = new AbortController();
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: lessonLlm({ [stage]: () => ac.abort() }) });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn({ ...t.input, signal: ac.signal })).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(verdictOf(store, t.run_id)).toBeUndefined();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a turn whose state was replaced mid-lane (identity changed) writes nothing", async () => {
    let replace = () => undefined as void;
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: lessonLlm({ distill: () => replace() }) });
    const t = turn("以后回复短一点");
    replace = () => { worker.buildOmpTools(t.claim, "555"); };
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a turn aborted while a skip is pending (Jev 429) writes nothing", async () => {
    const ac = new AbortController();
    const { store, worker, turn } = setup(vi.fn(async () => { ac.abort(); return json(429, {}); }));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn({ ...t.input, signal: ac.signal })).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    store.close();
  });
});

describe("the outcome sink: buttons, the saved-lesson failure line, and routeEnd on the verdict", () => {
  it("ompComplete hands the card's buttons to the final-report notification", () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    const buttons = [{ text: "↩️ Undo", data: "memlane:undo:lc_x" }];
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "📒 Saved lesson #1 · format", attachments: [], duration_ms: 1, tool_calls: 0, buttons });
    const sent = [...drainOutbox(store).values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ buttons });
    store.close();
  });
  it("ompFail after a committed save appends the saved lesson's id; without one the text is unchanged", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95 }));
    const t = turn("以后短一点，另外明天天气？");
    const out = await worker.triageTurn(t.input);
    const id = Number(/Lesson #(\d+)/.exec(out.kind === "inform" ? out.note : "")?.[1]);
    expect(id).toBeGreaterThan(0);
    sinkOf(worker).fail({ run_id: t.run_id, worker_id: "w", error_type: "planner_exit", error_ref: "x" });
    const plain = turn("hello");
    sinkOf(worker).fail({ run_id: plain.run_id, worker_id: "w", error_type: "planner_exit", error_ref: "x" });
    const texts = [...drainOutbox(store).values()].map((p) => String(p.text));
    expect(texts).toHaveLength(2);
    expect(texts[0]!.endsWith(`\n\n📒 Lesson #${id} was saved before the failure.`)).toBe(true);
    expect(texts[1]).not.toContain("📒");
    store.close();
  });
  // Spec §6: the handler's end closes the verdict. A lane fall-through keeps its reason (the lane_fallthrough_rate sweep
  // counts it), a failed pin is marked, and an escalation the supervisor ledgered becomes the turn's correction.
  const routed = async () => {
    const s = setup(treeSays({ category: cat({ answer: 0.9 }) }));
    const t = s.turn("明天天气怎么样");
    const out = await s.worker.triageTurn(t.input);
    const verdict_id = out.kind === "fallthrough" ? out.route!.verdict_id! : "";
    return { ...s, t, verdict_id };
  };
  it("routeEnd writes the answering model, fast_used_tool and the handler outcome", async () => {
    const { store, worker, t, verdict_id } = await routed();
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: true, pin_failed: false });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: 1,
      route_outcome: "act", paco_correction: null });
    store.close();
  });
  it("routeEnd marks a failed pin and copies a ledgered escalation onto the verdict", async () => {
    const { store, worker, t, verdict_id } = await routed();
    store.appendRunLedgerEvent(t.run_id, "routed_escalation", "core", { from: "fast", to: "default", kind: "quota" });
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_failed", model: null, fast_used_tool: false, pin_failed: true });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "planner_failed", route_outcome: "pin_failed", paco_correction: "escalation" });
    store.close();
  });
  // Task 8: a failed first pin leaves the child on whatever model it held, so the turn's tool use is not Fast's: crediting
  // it to Fast would skew the gear evidence the §7 calibration reads.
  it("routeEnd on a failed pin never credits a tool use to Fast", async () => {
    const { store, worker, t, verdict_id } = await routed();
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_done", model: "anthropic/claude-opus-5-5", fast_used_tool: true, pin_failed: true });
    expect(verdictOf(store, t.run_id)).toMatchObject({ route_outcome: "pin_failed", fast_used_tool: 0, model: "anthropic/claude-opus-5-5" });
    store.close();
  });
  it("routeEnd after the terminal already closed the verdict: the model lands, the outcome is not rewritten", async () => {
    const { store, worker, t, verdict_id } = await routed();
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "明天晴", attachments: [], duration_ms: 1, tool_calls: 0 });
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_failed", model: "anthropic/claude-sonnet-5-5", fast_used_tool: false, pin_failed: false });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5" });
    store.close();
  });
  it("routeEnd never overwrites a lane fall-through, and ignores a verdict id that is not the run's", async () => {
    const notDurable: Llm = async () => ({ ok: true, output: { answer: JSON.stringify({ durable: false }) } });
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: notDurable });
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    const verdict_id = out.kind === "fallthrough" ? out.route!.verdict_id! : "";
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id: "jv_other", handler_outcome: "planner_done", model: "x/y", fast_used_tool: false, pin_failed: false });
    expect(verdictOf(store, t.run_id)?.model).toBeNull();
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_done", model: "kimi-code/k3", fast_used_tool: false, pin_failed: false });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "fallthrough:not_durable", model: "kimi-code/k3" });
    store.close();
  });
});

describe("every terminal path closes a pending verdict (F12)", () => {
  it("ompComplete closes a routed turn's verdict planner_done", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ answer: 0.9 }) }));
    const t = turn("明天天气怎么样");
    await worker.triageTurn(t.input);
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "明天晴", attachments: [], duration_ms: 1, tool_calls: 0 });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "planner_done", model: null });
    store.close();
  });
  it("ompComplete leaves a lane reply's outcome alone (the guard, not the caller, protects it)", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    expect((await worker.triageTurn(t.input)).kind).toBe("lane_reply");
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "📒 Saved lesson #1 · format", attachments: [], duration_ms: 1, tool_calls: 0 });
    expect(verdictOf(store, t.run_id)?.handler_outcome).toBe("lane_reply");
    store.close();
  });
  it("a run failed the way abortAll / shutdown fail a queued run (planner owner, outcome.fail killed) closes planner_failed", () => {
    const { store, worker } = setup(treeSays());
    const run_id = createQueuedTurnRun(store, "明天天气怎么样");
    pendingVerdict(store, run_id);
    expect(store.claimRun(run_id, "planner:555:q", 120)).toBeTruthy();
    sinkOf(worker).fail({ run_id, worker_id: "planner:555:q", error_type: "killed", error_ref: "killed" });
    expect(verdictOf(store, run_id)?.handler_outcome).toBe("planner_failed");
    store.close();
  });
  it("restart: failStrandedTurns closes the verdict of a turn queued before boot", () => {
    const { store, worker } = setup(treeSays());
    const run_id = createQueuedTurnRun(store, "明天天气怎么样");
    pendingVerdict(store, run_id);
    expect(worker.failStrandedTurns(new Date(Date.now() + 60_000).toISOString())).toBe(1);
    expect(verdictOf(store, run_id)?.handler_outcome).toBe("planner_failed");
    store.close();
  });
  it("a crashed turn's expired lease: recoverPlannerLeases closes the verdict", () => {
    const { store, worker } = setup(treeSays());
    const run_id = createQueuedTurnRun(store, "明天天气怎么样");
    pendingVerdict(store, run_id);
    expect(store.claimRun(run_id, "planner:555:crashed", 1)).toBeTruthy();
    expect(worker.recoverPlannerLeases(new Date(Date.now() + 60_000).toISOString())).toBe(1);
    expect(verdictOf(store, run_id)?.handler_outcome).toBe("planner_failed");
    store.close();
  });
});
