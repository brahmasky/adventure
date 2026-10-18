import { afterEach, describe, expect, it, vi } from "vitest";
import { recordTriageOverride } from "../../src/gateway/memlane-commands.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import {
  ARM, cat, HEAVY, IdMap, jevDown, jevNotJson, jevStatus, LIGHT, only, picks, projectRun, scriptedLlm, SHADOW, sinkOf, treeSays, triageHarness, webOk,
  type Harness, type HarnessOptions, type Says, type TurnOptions
} from "../helpers/triage-harness.js";

// Spec §6.2 step 1 ("pin"): today's turn.handler behaviour over a corpus covering every exit and every later mutation a
// consumer makes, projected as what triage persists — jev_decisions (state_hash included), the jev_verdicts row, the
// route's link to it, the run's llm_attempt routed_by values, the triage event, the outcome, lane_replies and the catch-up
// boundary — with ids mapped and clocks dropped. The files were written on the pre-ladder code (main @ 3bff437); the
// migration (Task 8b) must leave every one byte-identical. A projection that still matches after a behaviour change would
// be a hole, so it keeps every column a consumer reads (see the consumer table in the plan).

const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };
const notDurable = scriptedLlm({ distill: async () => ({ ok: true, output: { answer: JSON.stringify({ kind: "none" }) } }) });

interface PinCase {
  name: string; text: string; fetch: () => unknown; opts?: HarnessOptions; turn?: TurnOptions;
  before?: (h: Harness) => Promise<string[]> | string[]; // earlier runs to project too (in order)
  prepare?: (h: Harness, run_id: string) => void;        // after the run exists, before triage
  breakCard?: "memory" | "lane" | "finalize";
  after?: (h: Harness, run_id: string, outcome: unknown) => void;
}

/** Cases whose state_hash would be masked as a clock. Must stay empty (asserted below): state_hash is pinned unmasked. */
const CLOCK_CASES: ReadonlySet<string> = new Set<string>([]);

async function runCase(c: PinCase): Promise<Record<string, unknown>> {
  const h = triageHarness(c.fetch(), c.opts ?? {});
  const ids = new IdMap();
  const earlier = c.before ? await c.before(h) : [];
  const t = h.turn(c.text, c.turn ?? {});
  c.prepare?.(h, t.run_id);
  if (c.breakCard === "memory") h.worker.breakMemoryLaneCardForTest();
  if (c.breakCard === "lane") h.worker.breakLaneCardForTest();
  if (c.breakCard === "finalize") h.worker.breakLaneFinalizeOnceForTest();
  const outcome = await h.worker.triageTurn(t.input);
  c.after?.(h, t.run_id, outcome);
  const isStatus = h.store.getJevVerdictForRun(t.run_id)?.lane === "status" && (outcome as { kind?: string }).kind === "lane_reply";
  const shown = isStatus ? { ...(outcome as object), text: "<status text>" } : outcome; // houge_status renders live clocks
  const result = {
    earlier: earlier.map((r) => projectRun(h.store, r, null, ids)),
    run: projectRun(h.store, t.run_id, shown, ids),
    planner_last_answered: h.store.plannerLastAnsweredAt("555") === null ? null : "set"
  };
  h.store.close();
  return result;
}

/** A plain Houge answer as the chat's last turn (the ack rule needs one). */
const seedPlainAnswer = (h: Harness): string[] => {
  const run_id = createQueuedTurnRun(h.store, "明天悉尼天气怎么样？");
  h.store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: "明天悉尼天气怎么样？" });
  h.store.recordChatTurn({ chat_id: "555", run_id, role: "assistant", text: "明天悉尼晴，最高 22 度。", intent: "loop" });
  return [];
};
/** One routed turn first, so the next one can label it (think harder) or be compared against it. */
const priorRouted = async (h: Harness): Promise<string[]> => {
  const t = h.turn("帮我查一下明天悉尼天气");
  await h.worker.triageTurn(t.input);
  return [t.run_id];
};

const CASES: PinCase[] = [
  { name: "off", text: "以后回复短一点", fetch: () => vi.fn(), opts: { env: { HOUGE_JEV_ENABLED: "0" } } },
  { name: "off-think-harder", text: "认真想：以后回复短一点", fetch: () => vi.fn(), opts: { env: { HOUGE_JEV_ENABLED: "0" } } },
  { name: "posture", text: "以后回复短一点", fetch: () => vi.fn(), turn: { posture: "killed" } },
  { name: "modality-photo", text: "这是什么？", fetch: () => vi.fn(), turn: { modality: "photo" } },
  { name: "override", text: "明天悉尼天气怎么样？", fetch: () => treeSays(),
    prepare: (h, run_id) => recordTriageOverride(h.store, createQueuedTurnRun(h.store, "原来的消息"), run_id, "555") },
  { name: "no-turn-state", text: "以后回复短一点", fetch: () => treeSays(RULE), turn: { noState: true } },
  { name: "ack-rule", text: "谢谢", fetch: () => treeSays(), before: seedPlainAnswer },
  { name: "state-too-large", text: "长".repeat(8_001), fetch: () => treeSays() },
  { name: "jev-transport", text: "以后回复短一点", fetch: jevDown },
  { name: "jev-429", text: "以后回复短一点", fetch: () => jevStatus(429) },
  { name: "jev-parse", text: "以后回复短一点", fetch: jevNotJson },
  { name: "jev-transport-think-harder", text: "认真想：这个怎么办", fetch: jevDown },
  { name: "shadow", text: "以后回复短一点", fetch: () => treeSays(RULE), opts: { env: SHADOW } },
  { name: "uncalibrated-model", text: "明天悉尼天气怎么样？", fetch: () => treeSays({ model: "jev-9.9.9" }) },
  { name: "routed-other-light", text: "帮我整理一下这周的待办", fetch: () => treeSays({ category: cat({ other: 0.9 }) }) },
  { name: "routed-research-heavy", text: "帮我比较三款 NAS", fetch: () => treeSays({ category: cat({ research: 0.9 }), breadth: HEAVY, reasoning: HEAVY, actions: HEAVY }) },
  { name: "think-harder-correction", text: "认真想：再比较一下", fetch: () => treeSays({ category: cat({ research: 0.9 }) }), before: priorRouted },
  { name: "correction", text: "那条规则不对，删掉它", fetch: () => treeSays({ category: cat({ memory: 0.9 }), sets_rule: 0.5 }) },
  { name: "bare-ack-guard-status", text: "好", fetch: () => treeSays({ category: only({ status: 0.95, other: 0.05 }) }) },
  { name: "cascade-pick", text: "这个周末去哪玩", fetch: () => treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }), opts: { llm: scriptedLlm({ cascade: picks("lookup") }) } },
  { name: "cascade-failed", text: "这个周末去哪玩", fetch: () => treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }) },
  { name: "cascade-pick-with-rule", text: "以后都用摄氏度，这周末去哪", fetch: () => treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }), sets_rule: 0.95 }),
    opts: { llm: scriptedLlm({ cascade: picks("answer") }) } },
  { name: "status-lane", text: "你刚才重启过吗？", fetch: () => treeSays({ category: only({ status: 0.95, other: 0.05 }) }) },
  { name: "memory-lane-saved", text: "从现在起，回复请控制在三句话以内。", fetch: () => treeSays(RULE) },
  { name: "memory-lane-not-durable", text: "从现在起，回复请控制在三句话以内。", fetch: () => treeSays(RULE), opts: { llm: notDurable } },
  { name: "memory-card-throws-after-save", text: "从现在起，回复请控制在三句话以内。", fetch: () => treeSays(RULE), breakCard: "memory" },
  { name: "memory-lane-finalize-rolled-back", text: "从现在起，回复请控制在三句话以内。", fetch: () => treeSays(RULE), breakCard: "finalize" },
  { name: "two-request", text: "以后用摄氏度。顺便帮我订明天的会议室", fetch: () => treeSays({ ...RULE, actions: HEAVY }) },
  { name: "rule-on-lookup", text: "以后温度都用摄氏度。明天悉尼天气怎么样？", fetch: () => treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, actions: LIGHT }), opts: { web: webOk() } },
  { name: "answer-lane", text: "你觉得 NAS 放在客厅还是书房更好？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }) },
  { name: "answer-lane-compose-failed", text: "你觉得呢？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }),
    opts: { llm: scriptedLlm({ compose: async () => ({ ok: false, error: "all lane legs failed" }) }) } },
  { name: "answer-lane-card-throws", text: "你觉得呢？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }), breakCard: "lane" },
  { name: "answer-lane-off", text: "你觉得呢？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }), opts: { env: { ...ARM, HOUGE_JEV_LANES_OFF: "answer" } } },
  { name: "lookup-lane", text: "明天悉尼天气怎么样？", fetch: () => treeSays({ category: cat({ lookup: 0.9 }), actions: LIGHT }), opts: { web: webOk() } },
  { name: "lookup-url-rule", text: "帮我看看 https://weather.example/sydney 说了什么", fetch: () => treeSays({ category: cat({ lookup: 0.9 }), actions: LIGHT }) },
  { name: "routed-then-routeEnd-escalation", text: "帮我整理一下这周的待办", fetch: () => treeSays({ category: cat({ other: 0.9 }) }),
    after: (h, run_id, out) => {
      h.store.appendRunLedgerEvent(run_id, "routed_escalation", "core", { from: "default", to: "thinking", kind: "timeout" });
      const verdict_id = (out as { route?: { verdict_id?: string } }).route?.verdict_id ?? "";
      sinkOf(h.worker).routeEnd!({ run_id, verdict_id, handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: true, pin_failed: false });
    } },
  { name: "routed-then-complete", text: "帮我整理一下这周的待办", fetch: () => treeSays({ category: cat({ other: 0.9 }) }),
    after: (h, run_id) => sinkOf(h.worker).complete({ run_id, worker_id: "w", text: "好的", attachments: [], duration_ms: 1, tool_calls: 0 }) },
  { name: "answer-lane-then-dig-deeper", text: "你觉得 NAS 放在客厅还是书房更好？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }),
    after: (h, run_id) => recordTriageOverride(h.store, run_id, createQueuedTurnRun(h.store, "你觉得 NAS 放在客厅还是书房更好？"), "555") }
];

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("turn.handler pin (spec §6.2: behaviour, not only verdicts)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const result = await runCase(c);
      await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__pins__/turn-handler/${c.name}.json`);
    });
  }

  // A killed turn writes nothing after Jev (the abort lands while Jev answers): the pin of "nothing" is the point.
  it("aborted-during-jev", async () => {
    const ctl = new AbortController();
    const says = treeSays(RULE);
    const h = triageHarness(vi.fn(async (u: unknown, i: unknown) => { ctl.abort(); return says(u, i); }));
    const t = h.turn("从现在起，回复请控制在三句话以内。", { signal: ctl.signal });
    const outcome = await h.worker.triageTurn(t.input);
    const ids = new IdMap();
    await expect(`${JSON.stringify(projectRun(h.store, t.run_id, outcome, ids), null, 2)}\n`).toMatchFileSnapshot("./__pins__/turn-handler/aborted-during-jev.json");
    h.store.close();
  });

  // No clock mask is in use: state_hash stays in every snapshot, because it pins the Jev request content Task 8b moves.
  it("keeps state_hash unmasked in every snapshot", async () => {
    expect(CLOCK_CASES.size).toBe(0);
    const result = await runCase(CASES.find((c) => c.name === "routed-other-light")!);
    const rows = (result.run as { jev_decisions: Array<Record<string, unknown>> }).jev_decisions;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.state_hash).not.toBe("<clock>");
    expect(rows.some((r) => typeof r.state_hash === "string" && r.state_hash.length > 0)).toBe(true);
  });
});
