import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatContextSince, resolveChatContextTurnChars, resolveChatContextTurns } from "../../src/capabilities/intent.js";
import { stateHash } from "../../src/jev/decide.js";
import { type JevRequest, type JevResult } from "../../src/jev/jev-client.js";
import { buildTriageState, lastHougeTurnOf, TRIAGE_LANE } from "../../src/jev/questions/triage.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { loadLabels, runTriageReplay, TRIAGE_LABEL_SINCE, TRIAGE_REPLAY_OUT } from "../../src/jev/triage-replay.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

/** The versioned id Jev REPORTS (the request sends the moving alias `jev-latest`); calibration rows key on it. */
const REPORTED = "jev-1.13.0";

const choice = (c: string, probabilities: Record<string, number>) => {
  const n = Object.keys(probabilities).length; const pMax = Math.max(...Object.values(probabilities));
  return { type: "choice" as const, choice: c, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
};
const fakeJev = async (req: JevRequest): Promise<JevResult> => {
  const msg = String((req.state as { latest_message: string }).latest_message);
  const memory = /以后|记住/.test(msg);
  return { ok: true, model: REPORTED, input_tokens: 500, latency_ms: 200, answers: {
    lane: choice(memory ? "memory" : "none", memory ? { none: 0.05, status: 0.05, memory: 0.9 } : { none: 0.95, status: 0.03, memory: 0.02 }),
    complete: choice("pure", { mixed: 0.1, pure: 0.9 }), scope: choice("ask", { ask: 0.9, research: 0.1 }) } };
};
const step = (n: number, capability: string) => ({ step: n, action: "tool", capability, ok: true, result_digest: "d" });

/** One Telegram run born at `at` (its first ledger event = the replay anchor), with its user + assistant turns. */
function seedRun(store: RunStore, text: string, at: string, caps: string[]): string {
  vi.setSystemTime(new Date(at));
  const run = createQueuedTurnRun(store, text);
  const done = new Date(Date.parse(at) + 20_000).toISOString(); // chat_turns are written at completion
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text, created_at: done });
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "assistant", text: "好的", intent: "answer", created_at: done });
  caps.forEach((c, i) => store.appendRunLedgerEvent(run, "loop_step", "core", step(i + 1, c)));
  return run;
}
function seed(store: RunStore) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const a = seedRun(store, "以后回复短一点", "2026-08-01T00:00:00.000Z", ["lesson_write"]);
  const b = seedRun(store, "今天天气？", "2026-08-01T00:10:00.000Z", ["web_search"]);
  const c = seedRun(store, "old", "2026-06-20T00:00:00.000Z", []); // before the label epoch
  vi.useRealTimers();
  return { a, b, c };
}
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), "tr-")), name);

afterEach(() => vi.useRealTimers());

// Spec §5.9: universe = Telegram turns since 2026-07-02; comparator = observed lesson_write; rows are ids and numbers; resumable.
describe("runTriageReplay", () => {
  it("replays the labelled universe, records the observed action and Jev's numbers, never text", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = tmp("replay.jsonl");
    const r = await runTriageReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: false });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "ok"]); // "old" is before TRIAGE_LABEL_SINCE
    const mem = r.rows.find((x) => x.observed_lesson_write)!;
    // No calibration row exists yet: the replay judges "as if armed", or every verdict would be `uncalibrated`.
    expect(mem).toMatchObject({ jev_lane: "memory", verdict: "memory_pure", lang: "zh", observed_other_tools: false, criteria_hash_lane: criteriaHash(TRIAGE_LANE) });
    expect(mem.p_memory).toBeCloseTo(0.9, 9);
    expect(r.rows.find((x) => !x.observed_lesson_write)).toMatchObject({ observed_other_tools: true, verdict: "fallthrough" });
    const file = readFileSync(out, "utf8");
    expect(file).not.toContain("以后回复短一点");
    expect(file).not.toContain("今天天气");
    expect(TRIAGE_LABEL_SINCE).toBe("2026-07-02T00:00:00.000Z");
    store.close();
  });

  it("builds the LIVE state: the row's state_hash joins to jev_decisions.state_hash", async () => {
    const store = RunStore.openInMemory(); const { b } = seed(store);
    const sent: JevRequest[] = [];
    const r = await runTriageReplay({ store, env: {}, jev: async (q) => { sent.push(q); return fakeJev(q); }, outPath: tmp("r.jsonl"), maxUsd: 1, dryRun: false });
    const row = r.rows.find((x) => x.run_id === b)!;
    const anchor = "2026-08-01T00:10:00.000Z";
    const recent = store.getChatTurnsBefore("555", resolveChatContextTurns({}), chatContextSince({}, new Date(anchor)), anchor, b);
    expect(recent.map((t) => t.role)).toEqual(["user", "assistant"]); // run a's turns are the thread
    const built = buildTriageState({ userText: "今天天气？", recentTurns: recent, turnChars: resolveChatContextTurnChars({}), modality: "text",
      lastHougeTurn: lastHougeTurnOf(recent, Date.parse(anchor)) });
    if (!built.ok) throw new Error("state");
    expect(row.state_hash).toBe(stateHash(built.state));
    expect((built.state.last_houge_turn as { age_s: number }).age_s).toBe(580); // anchored, not "now"
    store.close();
  });

  // Review fix 1/2: live built the state at its decision instant, not at the anchor; a replay cut at the anchor would
  // never join jev_decisions for a shadowed turn.
  it("a turn the live path decided is rebuilt at the live instant: thread cut and last_houge_turn age both", async () => {
    const store = RunStore.openInMemory(); const { a, b } = seed(store);
    const live = "2026-08-01T00:10:03.000Z";
    store.recordChatTurn({ chat_id: "555", run_id: a, role: "assistant", text: "补充一句", intent: "answer", created_at: "2026-08-01T00:10:01.000Z" });
    store.insertJevDecision({ run_id: b, point: "triage", question_id: "lane", criteria_hash: "c", model_reported: REPORTED, state_hash: "s", lang: "zh",
      answers_json: "{}", confidence: 0.9, top_prob: 0.9, margin: 0.8, threshold_version: "v", threshold_used: null, decision: "shadow", latency_ms: 1,
      input_tokens: 1, status: "answered", skip_reason: null, created_at: live });
    const r = await runTriageReplay({ store, env: {}, jev: fakeJev, outPath: tmp("r.jsonl"), maxUsd: 1, dryRun: false });
    const build = (at: string) => {
      const recent = store.getChatTurnsBefore("555", resolveChatContextTurns({}), chatContextSince({}, new Date(at)), at, b);
      const built = buildTriageState({ userText: "今天天气？", recentTurns: recent, turnChars: resolveChatContextTurnChars({}), modality: "text",
        lastHougeTurn: lastHougeTurnOf(recent, Date.parse(at)) });
      if (!built.ok) throw new Error("state");
      return built.state;
    };
    const liveState = build(live);
    expect((liveState.recent_turns as unknown[]).length).toBe(3); // the turn written after the anchor is in the live thread
    expect((liveState.last_houge_turn as { age_s: number }).age_s).toBe(2);
    const row = r.rows.find((x) => x.run_id === b)!;
    expect(row.state_hash).toBe(stateHash(liveState));
    expect(row.state_hash).not.toBe(stateHash(build("2026-08-01T00:10:00.000Z")));
    store.close();
  });

  // The request sends `jev-latest`: a reported model that changes mid-run is the alias moving; warn once per new model
  // (the report refuses the mixed file). A run on one model, whichever it is, warns nothing.
  it("warns when the reported model changes mid-run, not when a run is wholly on one model", async () => {
    const store = RunStore.openInMemory(); seed(store);
    let n = 0; const log = vi.fn();
    const moving = async (q: JevRequest): Promise<JevResult> => ({ ...(await fakeJev(q)), model: n++ === 0 ? REPORTED : "jev-1.14.0" } as JevResult);
    await runTriageReplay({ store, env: {}, jev: moving, outPath: tmp("r.jsonl"), maxUsd: 1, dryRun: false, log });
    const warned = log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("warning"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(REPORTED); expect(warned[0]).toContain("jev-1.14.0");
    const quiet = vi.fn();
    const newer = async (q: JevRequest): Promise<JevResult> => ({ ...(await fakeJev(q)), model: "jev-1.14.0" } as JevResult);
    await runTriageReplay({ store, env: {}, jev: newer, outPath: tmp("r2.jsonl"), maxUsd: 1, dryRun: false, log: quiet });
    expect(quiet.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("warning"))).toHaveLength(0);
    store.close();
  });

  it("a model move across a resume warns: rows already in the file seed the models seen", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = tmp("replay.jsonl");
    await runTriageReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: false, limit: 1 }); // one turn on REPORTED
    const log = vi.fn();
    const newer = async (q: JevRequest): Promise<JevResult> => ({ ...(await fakeJev(q)), model: "jev-1.14.0" } as JevResult);
    await runTriageReplay({ store, env: {}, jev: newer, outPath: out, maxUsd: 1, dryRun: false, log });
    const warned = log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("warning"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(REPORTED); expect(warned[0]).toContain("jev-1.14.0");
    store.close();
  });

  it("resumes: a second run over the same file dispatches nothing new", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = tmp("replay.jsonl");
    let calls = 0; const counting = async (q: JevRequest) => { calls++; return fakeJev(q); };
    await runTriageReplay({ store, env: {}, jev: counting, outPath: out, maxUsd: 1, dryRun: false });
    const again = await runTriageReplay({ store, env: {}, jev: counting, outPath: out, maxUsd: 1, dryRun: false });
    expect(calls).toBe(2);
    expect(again).toMatchObject({ universe: 2, alreadyDone: 2 });
    store.close();
  });

  it("stops on auth (INCOMPLETE through `stopped`); a dry run spends nothing and writes nothing", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = tmp("replay.jsonl");
    const dry = await runTriageReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: true });
    expect(dry.rows.every((x) => x.status === "dry_run")).toBe(true); expect(dry.spentUsd).toBe(0);
    expect(dry).toMatchObject({ universe: 2, wouldDispatch: 2 });
    expect(JSON.stringify(dry.rows)).not.toContain("以后回复短一点"); // the prepared state never reaches the outcome
    expect(dry.rows.every((x) => !("state" in x) && !("chars" in x))).toBe(true);
    expect(() => readFileSync(out)).toThrow();
    const auth = async (): Promise<JevResult> => ({ ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" });
    const r = await runTriageReplay({ store, env: {}, jev: auth, outPath: tmp("r.jsonl"), maxUsd: 1, dryRun: false });
    expect(r.stopped).toBe("auth");
    expect(r.rows[0]).toMatchObject({ status: "jev_failed", error: "auth" });
    store.close();
  });

  // Spec §1.1/§3.6: jev-1.13 leans to the first option; the order-bias measurement asks `lane` reversed, into its own file.
  it("permute: asks `lane` with its options reversed and keys rows apart from the canonical run", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const sent: JevRequest[] = [];
    const out = tmp("replay-permuted.jsonl");
    const r = await runTriageReplay({ store, env: {}, jev: async (q) => { sent.push(q); return fakeJev(q); }, outPath: out, maxUsd: 1, dryRun: false, permute: true });
    expect(Object.keys(sent[0]!.questions.lane!.criteria)).toEqual(["memory", "status", "none"]);
    expect(Object.keys(sent[0]!.questions.complete!.criteria)).toEqual(["mixed", "pure"]); // only `lane` is permuted
    expect(r.rows.every((x) => x.key.endsWith(":perm"))).toBe(true);
    expect(r.rows[0]!.criteria_hash_lane).not.toBe(criteriaHash(TRIAGE_LANE));
    expect(readFileSync(out, "utf8")).toContain(":perm");
    await expect(runTriageReplay({ store, env: {}, jev: fakeJev, outPath: TRIAGE_REPLAY_OUT, maxUsd: 1, dryRun: true, permute: true })).rejects.toThrow(/permuted/);
    store.close();
  });

  it("loadLabels reads Paco's JSONL keyed by turn_id, and refuses a malformed line rather than drop a label", () => {
    const p = tmp("labels.jsonl");
    writeFileSync(p, `${JSON.stringify({ turn_id: "t1", memory: true, status: false, pure: true, scope: "ask", by: "paco", at: "2026-10-05T00:00:00.000Z" })}\n`);
    expect(loadLabels(p).get("t1")).toMatchObject({ memory: true, pure: true });
    expect(loadLabels(tmp("absent.jsonl")).size).toBe(0);
    writeFileSync(p, `${JSON.stringify({ turn_id: "t1", memory: "yes", status: false, pure: null, scope: null, by: "paco", at: "" })}\n`);
    expect(() => loadLabels(p)).toThrow(/line 1/);
  });
});
