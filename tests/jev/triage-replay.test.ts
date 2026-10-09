import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatContextSince, resolveChatContextTurnChars, resolveChatContextTurns } from "../../src/capabilities/intent.js";
import { stateHash } from "../../src/jev/decide.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { buildTreeState, lastHougeTurnOf, quotedTurnFromRow, TREE_CATEGORY, TREE_QUESTIONS } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { loadLabels, proxyLabel, runTreeReplay, TREE_CATEGORY_PERMUTED, TREE_LABEL_SINCE, TREE_REPLAY_OUT } from "../../src/jev/triage-replay.js";
import { RunStore } from "../../src/run/run-store.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

/** The versioned id Jev reports (the request names the alias `jev-latest`; rows and calibration key on the reported id). */
const REPORTED = "jev-1.13.0";
const fakeJev = async (req: JevRequest): Promise<JevResult> => {
  const msg = String((req.state as { latest_message: string }).latest_message);
  const answers = /以后/.test(msg) ? treeAnswers({ category: "memory", setsRule: 0.95 })
    : /天气/.test(msg) ? treeAnswers({ category: "lookup", breadth: 1, actions: 1 }) : treeAnswers({ category: "answer" });
  return { ok: true, model: REPORTED, input_tokens: 500, latency_ms: 200, answers };
};
const step = (n: number, capability: string) => ({ step: n, action: "tool", capability, ok: true, result_digest: "d" });

/** One Telegram run born at `at` (its first ledger event = the replay anchor), with its user + assistant turns. */
function seedRun(store: RunStore, text: string, at: string, caps: string[], reply = "好的", quoted_turn_id?: string): string {
  vi.setSystemTime(new Date(at));
  const run = createQueuedTurnRun(store, text);
  const done = new Date(Date.parse(at) + 20_000).toISOString(); // chat_turns are written at completion
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text, created_at: done, ...(quoted_turn_id ? { quoted_turn_id } : {}) });
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "assistant", text: reply, intent: "answer", created_at: done });
  caps.forEach((c, i) => store.appendRunLedgerEvent(run, "loop_step", "core", step(i + 1, c)));
  return run;
}
function seed(store: RunStore) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const a = seedRun(store, "以后回复短一点", "2026-08-01T00:00:00.000Z", ["lesson_write"]);
  const b = seedRun(store, "明天天气怎么样", "2026-08-01T00:10:00.000Z", ["web_search"]);
  const c = seedRun(store, "old", "2026-06-20T00:00:00.000Z", []); // before the label epoch
  vi.useRealTimers();
  return { a, b, c };
}
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), "tr-")), name);

afterEach(() => vi.useRealTimers());

// Spec §7: the label is the FIRST matching rule. A turn that checked status and also wrote a lesson must count as
// status; a correction must never be read as a new rule; three searches are research, one is a lookup.
describe("proxyLabel (spec §7 precedence)", () => {
  const cases: Array<[string, Record<string, number>, string | null, string | null, string]> = [
    ["status beats a lesson", { houge_status: 1, lesson_write: 1 }, null, "status", "houge_status"],
    ["a correction beats a rule", { memory_correct_write: 1, lesson_write: 1 }, null, "memory", "memory_correct_write"],
    ["a rule beats a search", { lesson_write: 1, web_search: 4 }, null, "memory", "lesson_write"],
    ["self-write beats shell", { self_write_propose: 1, shell: 2 }, null, "self_change", "self_change"],
    ["skill_author is self_change", { skill_author: 1 }, null, "self_change", "self_change"],
    ["wiki beats schedule", { wiki_refine: 1, schedule_task: 1 }, null, "wiki", "wiki"],
    ["schedule beats mail", { schedule_task: 1, gmail_read: 1 }, null, "schedule", "schedule_task"],
    ["gmail_* is mail_calendar", { gmail_read: 1, web_search: 1 }, null, "mail_calendar", "mail_calendar"],
    ["shell beats search", { shell: 1, web_search: 3 }, null, "machine_task", "machine_task"],
    ["fs_* is machine_task", { fs_read: 1 }, null, "machine_task", "machine_task"],
    ["three web steps with a search is research", { web_search: 2, http_fetch: 1 }, null, "research", "research"],
    ["two fetches are research", { http_fetch: 2 }, null, "research", "research"],
    ["one search and one fetch is a lookup", { web_search: 1, http_fetch: 1 }, null, "lookup", "lookup"],
    ["a helper tool beside a lookup is ignored", { web_search: 1, to_local_time: 1 }, null, "lookup", "lookup"],
    ["only unmatched tools: unlabelled, not answer", { to_local_time: 1 }, null, null, "unmatched_tools"],
    ["no tool after an answer is answer", {}, "answer", "answer", "no_tool"],
    ["no tool after a proposal is unlabelled (the ack ambiguity)", {}, "proposal", null, "ack_after_proposal"]
  ];
  it.each(cases)("%s", (_name, tools, prev, category, rule) => {
    expect(proxyLabel(tools, prev as "answer" | "proposal" | null)).toEqual({ category, rule });
  });
});

describe("runTreeReplay", () => {
  // Spec §7: universe = Telegram turns since 2026-07-02; every row carries the proxy, the tools and Jev's per-question
  // answers (ids, enums and numbers only: the file is never allowed to hold message text).
  it("replays the universe with all six questions and records proxy, tools and answers, never text", async () => {
    const store = RunStore.openInMemory(); const { a, b } = seed(store);
    const sent: JevRequest[] = [];
    const out = tmp("replay.jsonl");
    const r = await runTreeReplay({ store, env: {}, jev: async (q) => { sent.push(q); return fakeJev(q); }, outPath: out, maxUsd: 1, dryRun: false });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "ok"]); // "old" is before TREE_LABEL_SINCE
    expect(Object.keys(sent[0]!.questions)).toEqual(TREE_QUESTIONS.map((q) => q.id));
    const mem = r.rows.find((x) => x.run_id === a)!;
    expect(mem).toMatchObject({ proxy: "memory", proxy_rule: "lesson_write", tools: { lesson_write: 1 }, lang: "zh", pre_judge: "judge", quoted: false });
    expect(mem.criteria_hashes).toEqual(Object.fromEntries(TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)])));
    expect(mem.answers?.category).toMatchObject({ type: "choice", choice: "memory" });
    expect(mem.answers?.sets_rule).toEqual({ type: "noul", noul: 0.95 });
    expect(r.rows.find((x) => x.run_id === b)).toMatchObject({ proxy: "lookup", proxy_rule: "lookup" });
    const file = readFileSync(out, "utf8");
    expect(file).not.toContain("以后回复短一点");
    expect(file).not.toContain("明天天气");
    expect(TREE_LABEL_SINCE).toBe("2026-07-02T00:00:00.000Z");
    store.close();
  });

  // Spec §2.2.1 / §7: a quoted "好" must replay with the quoted proposal in its state (as live saw it), is never settled
  // by the ack rule, and its tool proxy is unlabelled, because with no tool the proxy cannot tell agreement from chat.
  it("rebuilds quoted_turn from chat_turns.quoted_turn_id; the state hash equals the live builder's", async () => {
    const store = RunStore.openInMemory();
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = seedRun(store, "明天天气怎么样", "2026-08-01T00:00:00.000Z", [], "要不要我帮你查一下明天的天气？");
    const offer = store.getRecentChatTurns("555", 10).find((t) => t.run_id === a && t.role === "assistant")!;
    const b = seedRun(store, "好", "2026-08-01T01:00:00.000Z", [], "好的", offer.turn_id);
    vi.useRealTimers();
    const sent: JevRequest[] = [];
    const r = await runTreeReplay({ store, env: {}, jev: async (q) => { sent.push(q); return fakeJev(q); }, outPath: tmp("q.jsonl"), maxUsd: 1, dryRun: false });
    const row = r.rows.find((x) => x.run_id === b)!;
    expect(row).toMatchObject({ quoted: true, pre_judge: "judge", proxy: null, proxy_rule: "ack_after_proposal", bare_ack: true });
    const anchor = "2026-08-01T01:00:00.000Z";
    const recent = store.getChatTurnsBefore("555", resolveChatContextTurns({}), chatContextSince({}, new Date(anchor)), anchor, b);
    const quotedTurn = quotedTurnFromRow(store.getChatTurnById(offer.turn_id)!, Date.parse(anchor));
    expect(quotedTurn).toMatchObject({ role: "houge", kind: "proposal", age_s: 3580 });
    const built = buildTreeState({ userText: "好", recentTurns: recent, turnChars: resolveChatContextTurnChars({}), modality: "text",
      lastHougeTurn: lastHougeTurnOf(recent, Date.parse(anchor)), quotedTurn });
    if (!built.ok) throw new Error("state");
    expect(row.state_hash).toBe(stateHash(built.state));
    const sentState = sent.find((q) => (q.state as { latest_message: string }).latest_message === "好")!.state as Record<string, unknown>;
    expect(sentState.quoted_turn).toMatchObject({ role: "houge", kind: "proposal" });
    store.close();
  });

  // Lane 1 review fix, kept: live built the state at its decision instant, not at the anchor; a replay cut at the
  // anchor would never join jev_decisions.state_hash for a turn decided live.
  it("a turn the live path decided is rebuilt at the live instant: thread cut and last_houge_turn age both", async () => {
    const store = RunStore.openInMemory(); const { a, b } = seed(store);
    const live = "2026-08-01T00:10:03.000Z";
    store.recordChatTurn({ chat_id: "555", run_id: a, role: "assistant", text: "补充一句", intent: "answer", created_at: "2026-08-01T00:10:01.000Z" });
    store.insertJevDecision({ run_id: b, point: "triage", question_id: "category", criteria_hash: "c", model_reported: REPORTED, state_hash: "s", lang: "zh",
      answers_json: "{}", confidence: 0.9, top_prob: 0.9, margin: 0.8, threshold_version: "v", threshold_used: null, decision: "fallback", latency_ms: 1,
      input_tokens: 1, status: "answered", skip_reason: null, created_at: live });
    const r = await runTreeReplay({ store, env: {}, jev: fakeJev, outPath: tmp("r.jsonl"), maxUsd: 1, dryRun: false });
    const build = (at: string) => {
      const recent = store.getChatTurnsBefore("555", resolveChatContextTurns({}), chatContextSince({}, new Date(at)), at, b);
      const built = buildTreeState({ userText: "明天天气怎么样", recentTurns: recent, turnChars: resolveChatContextTurnChars({}), modality: "text",
        lastHougeTurn: lastHougeTurnOf(recent, Date.parse(at)), quotedTurn: null });
      if (!built.ok) throw new Error("state");
      return built.state;
    };
    const liveState = build(live);
    expect((liveState.recent_turns as unknown[]).length).toBe(3); // the turn written after the anchor is in the live thread
    const row = r.rows.find((x) => x.run_id === b)!;
    expect(row.state_hash).toBe(stateHash(liveState));
    expect(row.state_hash).not.toBe(stateHash(build("2026-08-01T00:10:00.000Z")));
    store.close();
  });

  it("resumes: a second run over the same file dispatches nothing new", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = tmp("replay.jsonl");
    let calls = 0; const counting = async (q: JevRequest) => { calls++; return fakeJev(q); };
    await runTreeReplay({ store, env: {}, jev: counting, outPath: out, maxUsd: 1, dryRun: false });
    const again = await runTreeReplay({ store, env: {}, jev: counting, outPath: out, maxUsd: 1, dryRun: false });
    expect(calls).toBe(2);
    expect(again).toMatchObject({ universe: 2, alreadyDone: 2 });
    store.close();
  });

  // Rev 5 (c026e5c): the request names the alias, so a reported model that changes mid-run, or across a resume, is the
  // alias moving. Warn once per new model (the report refuses the mixed file); a run wholly on one model warns nothing.
  it("warns when the reported model changes mid-run or across a resume, never on a run wholly on one model", async () => {
    const warnings = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("warning"));
    const newer = async (q: JevRequest): Promise<JevResult> => ({ ...(await fakeJev(q)), model: "jev-1.14.0" } as JevResult);
    const store = RunStore.openInMemory(); seed(store);
    let n = 0; const mid = vi.fn();
    const moving = async (q: JevRequest): Promise<JevResult> => (n++ === 0 ? fakeJev(q) : newer(q));
    await runTreeReplay({ store, env: {}, jev: moving, outPath: tmp("m.jsonl"), maxUsd: 1, dryRun: false, log: mid });
    expect(warnings(mid)).toHaveLength(1);
    expect(warnings(mid)[0]).toContain(REPORTED); expect(warnings(mid)[0]).toContain("jev-1.14.0");
    const quiet = vi.fn();
    await runTreeReplay({ store, env: {}, jev: newer, outPath: tmp("q2.jsonl"), maxUsd: 1, dryRun: false, log: quiet });
    expect(warnings(quiet)).toHaveLength(0);
    const out = tmp("resume.jsonl");
    await runTreeReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: false, limit: 1 }); // one turn on REPORTED
    const resumed = vi.fn();
    await runTreeReplay({ store, env: {}, jev: newer, outPath: out, maxUsd: 1, dryRun: false, log: resumed });
    expect(warnings(resumed)).toHaveLength(1);
    store.close();
  });

  // A partial run must never read as evidence (lessons, "a verdict over a partial run is not a verdict").
  it("stops on auth; a dry run spends nothing, writes nothing and keeps the state out of the outcome", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = tmp("replay.jsonl");
    const dry = await runTreeReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: true });
    expect(dry.rows.every((x) => x.status === "dry_run")).toBe(true); expect(dry.spentUsd).toBe(0);
    expect(dry).toMatchObject({ universe: 2, wouldDispatch: 2 });
    expect(JSON.stringify(dry.rows)).not.toContain("以后回复短一点");
    expect(dry.rows.every((x) => !("state" in x) && !("chars" in x))).toBe(true);
    expect(() => readFileSync(out)).toThrow();
    const auth = async (): Promise<JevResult> => ({ ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" });
    const r = await runTreeReplay({ store, env: {}, jev: auth, outPath: tmp("r.jsonl"), maxUsd: 1, dryRun: false });
    expect(r.stopped).toBe("auth");
    expect(r.rows[0]).toMatchObject({ status: "jev_failed", error: "auth" });
    expect(JSON.stringify(r.rows[0])).not.toContain("HTTP 401"); // the reason enum only, never the client's detail
    store.close();
  });

  // Spec §7 "permutation agreement": jev leans to the first option; `category` is asked reversed into its own file.
  it("permute: asks `category` with its options reversed, keys rows apart, and refuses the canonical file", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const sent: JevRequest[] = [];
    const out = tmp("replay-permuted.jsonl");
    const r = await runTreeReplay({ store, env: {}, jev: async (q) => { sent.push(q); return fakeJev(q); }, outPath: out, maxUsd: 1, dryRun: false, permute: true });
    expect(Object.keys(sent[0]!.questions.category!.criteria as Record<string, string>)).toEqual(TREE_CATEGORY.criteria.map(([k]) => k).reverse());
    expect(Object.keys(sent[0]!.questions.rule_scope!.criteria as Record<string, string>)).toEqual(["ask", "research"]); // only `category` is permuted
    expect(r.rows.every((x) => x.key.endsWith(":perm"))).toBe(true);
    expect(r.rows[0]!.criteria_hashes?.category).toBe(criteriaHash(TREE_CATEGORY_PERMUTED));
    expect(r.rows[0]!.criteria_hashes?.category).not.toBe(criteriaHash(TREE_CATEGORY));
    await expect(runTreeReplay({ store, env: {}, jev: fakeJev, outPath: TREE_REPLAY_OUT, maxUsd: 1, dryRun: true, permute: true })).rejects.toThrow(/permuted/);
    store.close();
  });

  it("loadLabels reads Paco's category labels keyed by turn_id, and refuses a malformed line rather than drop it", () => {
    const p = tmp("labels.jsonl");
    writeFileSync(p, `${JSON.stringify({ turn_id: "t1", category: "lookup", by: "paco", at: "2026-10-08T00:00:00.000Z" })}\n`);
    expect(loadLabels(p).get("t1")).toEqual({ category: "lookup", by: "paco", at: "2026-10-08T00:00:00.000Z" });
    expect(loadLabels(tmp("absent.jsonl")).size).toBe(0);
    writeFileSync(p, `${JSON.stringify({ turn_id: "t1", category: "weather", by: "paco", at: "" })}\n`);
    expect(() => loadLabels(p)).toThrow(/line 1/);
  });
});
