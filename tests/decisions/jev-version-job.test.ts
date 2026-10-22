import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDriftDetail } from "../../src/decisions/jev-version-check.js";
import {
  discoverJevModels, JEV_CHECK_PACE_MS, JEV_DEFER_RETRY_MS, resolveLegacyGoldenModelIncidents, JEV_JOB_OUTAGE_BACKOFF_MS, jevJobSettled, jevVersionTick, resetJevJobForTests, runJevCheck, type JevJobDeps
} from "../../src/decisions/jev-version-job.js";
import type { JevAnswer, JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { CATEGORIES } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { treeQuestions } from "../../src/jev/triage-replay.js";
import { RunStore, type JevAnchorRow, type JevAnchorState } from "../../src/run/run-store.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";

// Jev version check spec §2.4–2.5 and §3: the job that checks a new Jev version against Paco's approved anchor. It runs on
// its own promise (never inside the Telegram poll loop's await), one model at a time, survives a stop or an outage without
// losing or double-counting answers, never credits an answer another model gave, and leaves Paco exactly one message per
// outcome: a notice on a pass, an incident with an Accept button on a drift.

const ANCHOR_MODEL = "jev-anchor";
const CAND = "jev-new";
const CHAT = "555";
const NOW = "2026-10-22T03:00:00.000Z";
const N = 120; // zh anchor turns: above JEV_ANCHOR_MIN_ZH (100)
const PLANNER = ["research", "wiki", "machine_task", "schedule", "self_change"] as const;
const turnId = (i: number): string => `t${String(i).padStart(3, "0")}`;
const indexOf = (state: unknown): number => Number(/msg (\d+)/.exec(String((state as { latest_message?: unknown }).latest_message))?.[1] ?? -1);
const MEMORY_TURNS = 6; // turns 0..5: memory rules Paco labelled memory

/** The anchor's answers for turn i: a memory rule on the first few turns, a planner category on the rest. */
const anchorAnswers = (i: number): Record<string, JevAnswer> =>
  i < MEMORY_TURNS ? treeAnswers({ category: "memory", setsRule: 0.95 }) : treeAnswers({ category: PLANNER[i % PLANNER.length]! });

/** The criteria hash the live question has in run A (canonical) or B (permuted): what the import stored. */
const hashOf = (run: "A" | "B", id: string): string => criteriaHash(treeQuestions(run === "B").find((q) => q.id === id)!);
function seedAnchor(store: RunStore, n = N, lang: (i: number) => string = () => "zh"): void {
  const states: JevAnchorState[] = []; const rows: JevAnchorRow[] = [];
  for (let i = 0; i < n; i += 1) {
    states.push({ turn_id: turnId(i), lang: lang(i), state_json: JSON.stringify({ latest_message: `msg ${i}`, last_houge_turn: null, quoted_turn: null }), state_hash: `h${i}` });
    for (const run of ["A", "B"] as const) {
      for (const [question_id, a] of Object.entries(anchorAnswers(i))) rows.push({ turn_id: turnId(i), lang: lang(i), question_id, criteria_hash: hashOf(run, question_id), run, answer_json: JSON.stringify(a), model: ANCHOR_MODEL });
    }
  }
  const labels = Array.from({ length: MEMORY_TURNS }, (_, i) => ({ turn_id: turnId(i), category: "memory", by: "paco", at: NOW }));
  store.importAnchor({ rows, states, labels, meta: { baseline: "{}" }, trustedModel: ANCHOR_MODEL, now: NOW });
}

/** A generic answer for any question the job sends outside the tree (a golden item): first option, low p(yes), level 1. */
function genericAnswers(req: JevRequest): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === "noul") out[id] = { type: "noul", noul: 0.01 };
    else if (q.type === "score") out[id] = treeAnswers({ category: "answer" }).breadth!;
    else { const opts = Object.keys(q.criteria); out[id] = { type: "choice", choice: opts[0]!, probabilities: Object.fromEntries(opts.map((o, k) => [o, k === 0 ? 0.9 : 0.1 / (opts.length - 1)])), confidence: 0.9 }; }
  }
  return out;
}

type Answerer = (i: number, req: JevRequest) => Record<string, JevAnswer>;
interface Fake { client: (r: JevRequest) => Promise<JevResult>; calls: JevRequest[] }
/** A stub Jev: tree requests answered by `answer(turn index)`, reporting `model(call number)`; every call recorded. */
function fake(o: { answer?: Answerer; model?: (call: number, req: JevRequest) => string; fail?: (call: number) => JevResult | undefined; onCall?: (call: number) => void } = {}): Fake {
  const calls: JevRequest[] = [];
  const client = async (req: JevRequest): Promise<JevResult> => {
    calls.push(req);
    const k = calls.length;
    o.onCall?.(k);
    const failed = o.fail?.(k);
    if (failed) return failed;
    const i = indexOf(req.state);
    const answers = "category" in req.questions ? (o.answer ?? ((t) => anchorAnswers(t)))(i, req) : genericAnswers(req);
    return { ok: true, model: o.model?.(k, req) ?? CAND, answers, input_tokens: 10, latency_ms: 1 };
  };
  return { client, calls };
}

const fresh = (): RunStore => RunStore.open(join(mkdtempSync(join(tmpdir(), "hjvj-")), "h.sqlite"));
function deps(store: RunStore, f: Fake, o: Partial<JevJobDeps> = {}): JevJobDeps {
  return { store, client: f.client, signal: new AbortController().signal, chatId: CHAT, now: () => NOW, golden: [], log: () => {}, paceMs: 0, ...o };
}
/** An answered Jev call in the ledger reporting `model`: what the alias served last. */
const serve = (s: RunStore, model: string): void => s.llmAuditSink({ correlation_id: "t", role: "triage" }).record({ provider: "jev", role: "", outcome: "ok", model, latency_ms: 1 });
const PARSE_FAIL: JevResult = { ok: false, reason: "error", detail: "bad", error_kind: "parse" };
const outbox = (s: RunStore) => {
  const out: Array<{ chat: string; payload: Record<string, unknown> }> = [];
  for (let n = s.claimNextNotification("test", 30); n; n = s.claimNextNotification("test", 30)) {
    out.push({ chat: n.target.kind === "telegram" ? n.target.chat_id : "local", payload: n.payload as Record<string, unknown> });
    s.markNotificationDelivered(n.notification_id, `t:${n.notification_id}`);
  }
  return out;
};
const treeRows = (s: RunStore, model: string, generation: number) => s.listJevCheckRuns(model, generation, "tree");
const sha8 = (m: string) => createHash("sha256").update(m).digest("hex").slice(0, 8);
const acceptData = (s: RunStore, m: string) => `dec:jv:${sha8(m)}:${s.getJevModel(m)!.generation}:acc`;

afterEach(() => resetJevJobForTests());

describe("discovery (spec §2.4): llm_attempt rows after the rowid cursor", () => {
  function attempt(path: string, id: string, provider: string, model: string): void {
    const db = new DatabaseSync(path);
    db.prepare(`INSERT INTO ledger_events (event_id, run_id, correlation_id, event_type, occurred_at, actor, sequence, payload_json)
      VALUES (?, NULL, 'c', 'llm_attempt', ?, 'capability_runner', 1, ?)`).run(id, NOW, JSON.stringify({ provider, model, outcome: "ok" }));
    db.close();
  }
  it("notes each unseen model as checking, leaves a known model's state alone, and advances the cursor past what it read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hjvd-")), "h.sqlite");
    RunStore.open(path).close();
    attempt(path, "e1", "jev", ANCHOR_MODEL); attempt(path, "e2", "jev", CAND); attempt(path, "e3", "omp", "not-jev");
    const s = RunStore.open(path);
    seedAnchor(s);
    expect(discoverJevModels(s, NOW)).toEqual([CAND]);
    expect(s.getJevModel(ANCHOR_MODEL)?.state).toBe("trusted"); // the anchor's model stays trusted
    expect(s.getJevModel(CAND)?.state).toBe("checking");
    expect(s.getJevModel("not-jev")).toBeUndefined();
    const cursor = s.getJevModelCursor();
    expect(cursor).toBeGreaterThan(0);
    expect(discoverJevModels(s, NOW)).toEqual([]); // nothing after the cursor
    expect(s.getJevModelCursor()).toBe(cursor);
    s.close();
  });
});

describe("the background job (spec §2.4)", () => {
  it("starts from the tick without being awaited: the tick returns while the first Jev call is still in flight, and one model runs at a time", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel("jev-other", NOW); serve(s, CAND);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const f = fake();
    const slow = async (req: JevRequest): Promise<JevResult> => { await gate; return f.client(req); };
    const tick = () => jevVersionTick({ store: s, makeClient: () => slow, signal: new AbortController().signal, chatId: CHAT, now: () => NOW, golden: [], log: () => {}, paceMs: 0 });
    const first = tick();
    expect(first.started).toBe(CAND); // returned synchronously, the job's first call is parked on the gate
    expect(tick().started).toBeNull(); // one model at a time
    release();
    await jevJobSettled();
    expect(s.getJevModel(CAND)?.state).toBe("trusted");
    s.close();
  });

  it("resumes after a stop: answers already recorded are not asked again, and the generation is kept", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const stop = new AbortController();
    const f1 = fake({ onCall: (k) => { if (k === 50) stop.abort(); } });
    expect(await runJevCheck(deps(s, f1, { signal: stop.signal }), CAND)).toBe("stopped");
    const row = s.getJevModel(CAND)!;
    expect(row.state).toBe("checking");
    expect(row.checked_at).toBeNull(); // checked_at only on a terminal state
    expect(JSON.parse(row.detail_json!)).toMatchObject({ progress: { generation: row.generation } });
    expect(treeRows(s, CAND, row.generation)).toHaveLength(50);
    const f2 = fake();
    expect(await runJevCheck(deps(s, f2), CAND)).toBe("trusted");
    expect(f2.calls).toHaveLength(3 * N - 50); // A, A2 and B over the zh turns, minus what the first start recorded
    expect(s.getJevModel(CAND)?.generation).toBe(row.generation);
    s.close();
  });

  it("an ask is retried at most 3 times on another model, skipped, re-asked once at the end; no candidate answers → deferred, another model's answers never recorded", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const f = fake({ model: () => "jev-old" });
    expect(await runJevCheck(deps(s, f), CAND)).toBe("deferred");
    expect(f.calls).toHaveLength(3 * N * 4 * 2); // every ask: the first try and 3 retries, then once more at the end of the pass
    const row = s.getJevModel(CAND)!;
    expect(row.state).toBe("deferred");
    expect(row.checked_at).toBe(NOW);
    expect(treeRows(s, CAND, row.generation)).toEqual([]);
    s.close();
  });

  it("a retry that the candidate answers is credited with the candidate's answer only", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const f = fake({ model: (k) => (k === 1 ? "jev-old" : CAND), answer: (i, req) => (f.calls.length === 1 ? treeAnswers({ category: "status" }) : anchorAnswers(i)) });
    expect(await runJevCheck(deps(s, f), CAND)).toBe("trusted");
    const g = s.getJevModel(CAND)!.generation;
    const first = treeRows(s, CAND, g).find((r) => r.run === `A:${turnId(0)}`)!;
    expect(JSON.parse(first.detail_json).category.choice).toBe("memory"); // the other model's "status" answer was dropped
    s.close();
  });

  it("an outage stops the start and is retried at a later start (after the backoff), resuming where it stopped", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    let t = Date.parse(NOW);
    const clock = () => new Date(t).toISOString();
    serve(s, CAND);
    const f = fake({ fail: (k) => (k === 10 ? { ok: false, reason: "error", detail: "HTTP 429", error_kind: "rate_limited" } : undefined) });
    const tick = () => jevVersionTick({ store: s, makeClient: () => f.client, signal: new AbortController().signal, chatId: CHAT, now: clock, golden: [], log: () => {}, paceMs: 0 });
    expect(tick().started).toBe(CAND);
    await jevJobSettled();
    expect(s.getJevModel(CAND)?.state).toBe("checking");
    expect(s.listOpenIncidents().map((i) => i.kind)).toContain("jev_rate_limited"); // the outage reaches Paco
    expect(tick().started).toBeNull(); // within the backoff: not hammered every poll cycle
    t += JEV_JOB_OUTAGE_BACKOFF_MS + 1;
    expect(tick().started).toBe(CAND);
    await jevJobSettled();
    expect(s.getJevModel(CAND)?.state).toBe("trusted");
    expect(f.calls).toHaveLength(3 * N + 1); // 9 answered, 1 failed, then the rest: nothing asked twice
    expect(s.listOpenIncidents().map((i) => i.kind)).not.toContain("jev_rate_limited"); // the job's own answers clear the outage it opened
    s.close();
  });

  it("a new check bumps the generation and only current-generation rows count", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake()), CAND)).toBe("trusted");
    const g1 = s.getJevModel(CAND)!.generation;
    expect(s.setJevModelState(CAND, "trusted", "checking", "{}", NOW)).toBe(true); // `houge jev check`
    const drift = fake({ answer: (i) => (i % 3 === 0 && i >= MEMORY_TURNS ? treeAnswers({ category: "lookup" }) : anchorAnswers(i)) });
    expect(await runJevCheck(deps(s, drift), CAND)).toBe("drifted"); // the older generation's matching answers never count
    expect(drift.calls).toHaveLength(3 * N);
    expect(s.getJevModel(CAND)!.generation).toBe(g1 + 1);
    s.close();
  });

  it("a deferred model is retried after the deferral wait (an hour), not at the next tick", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake({ model: () => "jev-old" })), CAND)).toBe("deferred");
    serve(s, CAND);
    let t = Date.parse(NOW) + 60_000;
    const tick = () => jevVersionTick({ store: s, makeClient: () => fake().client, signal: new AbortController().signal, chatId: CHAT, now: () => new Date(t).toISOString(), golden: [], log: () => {}, paceMs: 0 });
    expect(tick().started).toBeNull();
    t = Date.parse(NOW) + JEV_DEFER_RETRY_MS + 1;
    expect(tick().started).toBe(CAND);
    await jevJobSettled();
    expect(s.getJevModel(CAND)?.state).toBe("trusted");
    s.close();
  });
});

describe("the outcome (spec §2.5 d)", () => {
  it("a pass sets trusted and sends one notice with the margins and any recall drop: no incident, no button", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    // the candidate stops routing 5 of Paco's 6 memory turns to memory: a recall drop, reported only
    const f = fake({ answer: (i) => (i >= 1 && i < MEMORY_TURNS ? treeAnswers({ category: "research" }) : anchorAnswers(i)) });
    expect(await runJevCheck(deps(s, f), CAND)).toBe("trusted");
    const row = s.getJevModel(CAND)!;
    expect(row.state).toBe("trusted");
    expect(row.checked_at).toBe(NOW);
    expect(s.listOpenIncidents()).toEqual([]);
    const sent = outbox(s);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe(CHAT);
    expect(sent[0]!.payload.button_rows).toBeUndefined();
    const text = String(sent[0]!.payload.text);
    expect(text).toContain(CAND);
    expect(text).toMatch(/passed/);
    expect(text).toMatch(/category/);
    expect(text).toMatch(/memory 6 → 1/); // the recall drop's numbers
    expect(text).not.toMatch(/msg \d/); // never state or turn text
    s.close();
  });

  it("a drift sets drifted, opens one incident and sends one card with the Accept button (data, not callback_data)", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const f = fake({ answer: (i) => (i % 3 === 0 && i >= MEMORY_TURNS ? treeAnswers({ category: "lookup" }) : anchorAnswers(i)) });
    expect(await runJevCheck(deps(s, f), CAND)).toBe("drifted");
    const row = s.getJevModel(CAND)!;
    expect(row.state).toBe("drifted");
    const d = parseDriftDetail(row.detail_json)!;
    expect(d.failed_questions).toContain("category");
    expect(d.route_failed).toBe(true);
    expect(s.listOpenIncidents().map((i) => i.kind)).toEqual(["jev_model_drifted"]);
    const sent = outbox(s);
    expect(sent).toHaveLength(1); // the card only: never also the generic incident text
    expect(sent[0]!.chat).toBe(CHAT);
    expect(sent[0]!.payload.button_rows).toEqual([[{ text: `Accept ${CAND}`, data: acceptData(s, CAND) }]]);
    expect(String(sent[0]!.payload.text)).toMatch(/drifted/);
    s.close();
  });

  it("an anchor under 100 zh turns makes the model insufficient: nothing armed, one incident naming the import, with Accept", async () => {
    const s = fresh(); seedAnchor(s, 60); s.noteJevModel(CAND, NOW);
    const f = fake();
    expect(await runJevCheck(deps(s, f), CAND)).toBe("insufficient");
    expect(f.calls).toHaveLength(0);
    expect(s.getJevModel(CAND)?.state).toBe("insufficient");
    expect(s.listOpenIncidents().map((i) => i.kind)).toEqual(["jev_model_insufficient"]);
    const sent = outbox(s);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toContain("houge jev anchor import");
    expect(acceptData(s, CAND)).toMatch(/^dec:jv:[0-9a-f]{8}:\d+:acc$/);
    expect(sent[0]!.payload.button_rows).toEqual([[{ text: `Accept ${CAND}`, data: acceptData(s, CAND) }]]);
    s.close();
  });

  it("a golden-set drift goes into the outcome notice only (no separate incident from the check) and never disarms the tree", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake(), { golden: ["tool.injection"] }), CAND)).toBe("trusted"); // the generic stub misses every planted item
    const g = s.getJevModel(CAND)!.generation;
    expect(s.getJevCheckRun(CAND, g, "tool.injection", "golden")?.outcome).toBe("drift");
    expect(s.listOpenIncidents()).toEqual([]); // the daily ticks keep their own golden incidents; the check pages nothing for it
    const sent = outbox(s);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toMatch(/Golden sets: tool\.injection drift/);
    expect(s.getJevModel(CAND)?.state).toBe("trusted");
    s.close();
  });

  it("a golden item reporting another model is retried, never credited: no golden row, the model is deferred", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const f = fake({ model: (k) => (k > 3 * N ? "jev-old" : CAND) }); // the tree on the candidate, then the alias moves back
    expect(await runJevCheck(deps(s, f, { golden: ["memory.kind"] }), CAND)).toBe("deferred");
    expect(f.calls).toHaveLength(3 * N + 4);
    const g = s.getJevModel(CAND)!.generation;
    expect(s.getJevCheckRun(CAND, g, "memory.kind", "golden")).toBeUndefined();
    s.close();
  });
});

describe("the check job writes only the agreed vocabularies", () => {
  it("jev_check_runs refuses an unknown run or outcome", () => {
    const s = fresh();
    const base = { model: "m", generation: 1, created_at: NOW, detail_json: "{}" };
    expect(() => s.recordJevCheckRun({ ...base, entry_id: "tree", run: "C:t1", outcome: "answered" })).toThrow();
    expect(() => s.recordJevCheckRun({ ...base, entry_id: "tree", run: "A:t1", outcome: "ok" })).toThrow();
    expect(() => s.recordJevCheckRun({ ...base, entry_id: "memory.kind", run: "golden", outcome: "bad" })).toThrow();
    s.recordJevCheckRun({ ...base, entry_id: "tree", run: "A2:t1", outcome: "answered" });
    s.recordJevCheckRun({ ...base, entry_id: "memory.kind", run: "golden", outcome: "drift" });
    expect(s.listJevCheckRuns("m", 1, "tree")).toHaveLength(1);
    s.close();
  });
});

describe("categories used by the fixtures exist", () => {
  it("lookup, research and memory are tree categories", () => {
    for (const c of ["lookup", "research", "memory", "status"]) expect(CATEGORIES).toContain(c);
  });
});

describe("fix round 1", () => {
  it("too few fully answered zh turns from the candidate is not the no-anchor case: retried once at the next start, then insufficient with its own reason and text", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const failing = () => fake({ fail: (k) => (k > 30 ? PARSE_FAIL : undefined) });
    expect(await runJevCheck(deps(s, failing()), CAND)).toBe("retrying");
    expect(s.getJevModel(CAND)?.state).toBe("checking");
    expect(outbox(s)).toEqual([]);
    expect(await runJevCheck(deps(s, failing()), CAND)).toBe("insufficient");
    const row = s.getJevModel(CAND)!;
    expect(row.state).toBe("insufficient");
    expect(JSON.parse(row.detail_json!)).toMatchObject({ reason: "answered_too_few", answered_zh: expect.any(Number) });
    const text = String(outbox(s)[0]!.payload.text);
    expect(text).not.toContain("anchor import"); // the anchor exists: never tell Paco to import it
    expect(text).toContain("houge jev check");
    s.close();
  });

  it("the retry re-asks the failed turns and can pass", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake({ fail: (k) => (k > 30 ? PARSE_FAIL : undefined) })), CAND)).toBe("retrying");
    expect(await runJevCheck(deps(s, fake()), CAND)).toBe("trusted");
    s.close();
  });

  it("insufficient (no anchor) → the anchor import moves it back to checking → the job trusts it", async () => {
    const s = fresh(); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake()), CAND)).toBe("insufficient");
    seedAnchor(s);
    expect(s.getJevModel(CAND)).toMatchObject({ state: "checking", detail_json: "{}" });
    expect(s.getJevModel(ANCHOR_MODEL)?.state).toBe("trusted");
    expect(await runJevCheck(deps(s, fake()), CAND)).toBe("trusted");
    s.close();
  });

  it("paces its asks (JEV_CHECK_PACE_MS) and the pause honours the stop signal", async () => {
    vi.useFakeTimers();
    try {
      const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
      const f = fake(); const stop = new AbortController();
      const { paceMs: _zero, ...unpaced } = deps(s, f, { signal: stop.signal }); // the default pace
      const run = runJevCheck(unpaced, CAND);
      await vi.advanceTimersByTimeAsync(JEV_CHECK_PACE_MS - 1);
      expect(f.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(JEV_CHECK_PACE_MS);
      expect(f.calls).toHaveLength(2);
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await run).toBe("stopped");
      expect(f.calls).toHaveLength(2);
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("only the model the alias serves is started: a deferred id the alias no longer serves is never retried", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake({ model: () => "jev-old" })), CAND)).toBe("deferred");
    serve(s, "jev-newer");
    const t = Date.parse(NOW) + JEV_DEFER_RETRY_MS + 1;
    const r = jevVersionTick({ store: s, makeClient: () => fake({ model: () => "jev-newer" }).client, signal: new AbortController().signal, chatId: CHAT, now: () => new Date(t).toISOString(), golden: [], log: () => {}, paceMs: 0 });
    expect(r.started).toBe("jev-newer");
    await jevJobSettled();
    expect(s.getJevModel(CAND)?.state).toBe("deferred");
    s.close();
  });

  it("resuming after a deferral keeps the generation and its recorded answers", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake({ model: (k) => (k > 20 ? "jev-old" : CAND) })), CAND)).toBe("deferred");
    const g = s.getJevModel(CAND)!.generation;
    serve(s, CAND);
    const f = fake();
    const t = Date.parse(NOW) + JEV_DEFER_RETRY_MS + 1;
    expect(jevVersionTick({ store: s, makeClient: () => f.client, signal: new AbortController().signal, chatId: CHAT, now: () => new Date(t).toISOString(), golden: [], log: () => {}, paceMs: 0 }).started).toBe(CAND);
    await jevJobSettled();
    expect(s.getJevModel(CAND)).toMatchObject({ state: "trusted", generation: g });
    expect(f.calls).toHaveLength(3 * N - 20);
    s.close();
  });
});

// Final fix A (correctness Imp, adversarial 2): while the alias serves two ids the check must not stall the lanes silently.
describe("canary days (final fix A)", () => {
  const isTurn = (req: JevRequest, i: number): boolean => indexOf(req.state) === i;
  const canaryText = /Jev is serving two versions; the check retries/;

  it("a turn whose answers keep reporting another id is skipped, not a deferral: re-asked once at the end of the pass, and the check finishes", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    let oldTries = 0; // turn 7's first ask of run A: all four tries come back from the old id; its re-ask at the end reaches the candidate
    const f = fake({ model: (_k, req) => (isTurn(req, 7) && oldTries < 4 ? (oldTries += 1, "jev-old") : CAND) });
    expect(await runJevCheck(deps(s, f), CAND)).toBe("trusted");
    expect(f.calls).toHaveLength(3 * N + 4);
    expect(treeRows(s, CAND, s.getJevModel(CAND)!.generation).filter((r) => r.outcome === "answered")).toHaveLength(3 * N);
    expect(outbox(s).map((m) => String(m.payload.text)).some((t) => canaryText.test(t))).toBe(false);
    s.close();
  });

  it("a turn the alias never serves from the candidate is left unanswered after its one re-ask; enough zh turns still finish the check", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const f = fake({ model: (_k, req) => (isTurn(req, 7) ? "jev-old" : CAND) });
    expect(await runJevCheck(deps(s, f), CAND)).toBe("trusted");
    expect(f.calls).toHaveLength(3 * (N - 1) + 3 * 4 * 2); // turn 7 in A, A2 and B: four tries, then four more at the end
    s.close();
  });

  it("defers only when, after the whole pass, fewer than 100 zh turns have candidate answers in every run; one notice, no page", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const f = fake({ model: (_k, req) => (indexOf(req.state) % 2 === 0 ? "jev-old" : CAND) }); // 60 of 120 zh turns reach the candidate
    expect(await runJevCheck(deps(s, f), CAND)).toBe("deferred");
    expect(s.getJevModel(CAND)?.state).toBe("deferred");
    expect(s.listOpenIncidents()).toEqual([]); // a notice, never an alerted page
    const sent = outbox(s);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe(CHAT);
    expect(sent[0]!.payload.button_rows).toBeUndefined();
    expect(String(sent[0]!.payload.text)).toContain(CAND);
    expect(String(sent[0]!.payload.text)).toMatch(canaryText);
    s.close();
  });

  it("a deferral again in the same check sends no second notice", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake({ model: () => "jev-old" })), CAND)).toBe("deferred");
    expect(outbox(s)).toHaveLength(1);
    expect(s.setJevModelState(CAND, "deferred", "checking", s.getJevModel(CAND)!.detail_json!, NOW)).toBe(true);
    expect(await runJevCheck(deps(s, fake({ model: () => "jev-old" })), CAND)).toBe("deferred");
    expect(outbox(s)).toEqual([]);
    s.close();
  });

  it("a deferred model is retried sooner when the newest 5 Jev answers all report it", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    expect(await runJevCheck(deps(s, fake({ model: () => "jev-old" })), CAND)).toBe("deferred");
    const tick = () => jevVersionTick({ store: s, makeClient: () => fake().client, signal: new AbortController().signal, chatId: CHAT, now: () => new Date(Date.parse(NOW) + 60_000).toISOString(), golden: [], log: () => {}, paceMs: 0 });
    serve(s, "jev-old");
    for (let k = 0; k < 4; k += 1) serve(s, CAND);
    expect(tick().started).toBeNull(); // 4 of the newest 5 only
    serve(s, CAND);
    expect(tick().started).toBe(CAND);
    await jevJobSettled();
    expect(s.getJevModel(CAND)?.state).toBe("trusted");
    s.close();
  });

  it("the deferral wait is an hour", () => {
    expect(JEV_DEFER_RETRY_MS).toBe(3_600_000);
  });
});

// Final fix B (adversarial 3, correctness Minor): a check that cannot finish reaches Paco once and never loops forever.
describe("a stuck check (final fix B)", () => {
  const TIMEOUT: JevResult = { ok: false, reason: "error", detail: "timed out", error_kind: "timeout" };

  it("a turn that hits an outage on 3 separate starts is recorded as unanswered and the pass moves on", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const f = fake({ fail: (k) => (indexOf(f.calls[k - 1]!.state) === 0 ? TIMEOUT : undefined) }); // turn 0 always times out, in every run
    const results: string[] = [];
    for (let start = 0; start < 12 && results.at(-1) !== "trusted"; start += 1) results.push(await runJevCheck(deps(s, f), CAND));
    expect(results).toEqual(["outage", "outage", "outage", "outage", "outage", "outage", "trusted"]); // A, A2 and B of turn 0: three starts each
    const g = s.getJevModel(CAND)!.generation;
    const failed = treeRows(s, CAND, g).filter((r) => r.outcome === "failed");
    expect(failed.map((r) => r.run).sort()).toEqual([`A2:${turnId(0)}`, `A:${turnId(0)}`, `B:${turnId(0)}`]);
    expect(JSON.parse(failed[0]!.detail_json)).toMatchObject({ error_kind: "timeout", outages: 3 });
    s.close();
  });

  it("a model checking for more than 3 h from its generation's start opens ONE alerted incident, resolved when the check finishes", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW); serve(s, CAND);
    expect(await runJevCheck(deps(s, fake(), { signal: AbortSignal.abort() }), CAND)).toBe("stopped"); // the generation starts at NOW
    let t = Date.parse(NOW) + 3 * 3_600_000 - 1;
    const stopped = AbortSignal.abort(); // the tick only reads; no check starts
    const tick = () => jevVersionTick({ store: s, makeClient: () => fake().client, signal: stopped, chatId: CHAT, now: () => new Date(t).toISOString(), golden: [], log: () => {}, paceMs: 0 });
    tick();
    expect(s.listOpenIncidents()).toEqual([]);
    t += 2;
    tick(); tick();
    expect(s.listOpenIncidents().map((i) => [i.kind, i.subject])).toEqual([["jev_model_check_stalled", `jev:model:${CAND}`]]);
    const sent = outbox(s);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toContain(`the Jev version check for ${CAND} is not finishing; lanes stay on the planner`);
    expect(await runJevCheck(deps(s, fake(), { now: () => new Date(t).toISOString() }), CAND)).toBe("trusted");
    tick();
    expect(s.listOpenIncidents()).toEqual([]);
    s.close();
  });
});

// Final fix D (codex W2, adversarial 4, correctness Minor): a golden run that did not run is not a pass.
describe("golden runs (final fix D)", () => {
  const isGolden = (req: JevRequest): boolean => !("category" in req.questions);

  it("a golden run that fails to run stays pending: no row, no outcome; the next start asks only the golden set and can then pass", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const bad = fake({ fail: (k) => (isGolden(bad.calls[k - 1]!) ? PARSE_FAIL : undefined) });
    expect(await runJevCheck(deps(s, bad, { golden: ["memory.kind"] }), CAND)).toBe("pending");
    const g = s.getJevModel(CAND)!.generation;
    expect(s.getJevModel(CAND)?.state).toBe("checking"); // never trusted while a golden entry is pending
    expect(s.getJevCheckRun(CAND, g, "memory.kind", "golden")).toBeUndefined();
    expect(outbox(s)).toEqual([]);
    const good = fake();
    expect(await runJevCheck(deps(s, good, { golden: ["memory.kind"] }), CAND)).toBe("trusted");
    expect(good.calls.every(isGolden)).toBe(true); // the tree rows were kept
    expect(s.getJevCheckRun(CAND, g, "memory.kind", "golden")?.outcome).toBeDefined();
    s.close();
  });

  it("a golden outage pauses the start (backoff) and the golden entry is retried", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW);
    const down = fake({ fail: (k) => (isGolden(down.calls[k - 1]!) ? { ok: false, reason: "error", detail: "HTTP 503", error_kind: "transport" } : undefined) });
    expect(await runJevCheck(deps(s, down, { golden: ["tool.injection"] }), CAND)).toBe("outage");
    expect(s.getJevModel(CAND)?.state).toBe("checking");
    expect(await runJevCheck(deps(s, fake(), { golden: ["tool.injection"] }), CAND)).toBe("trusted");
    s.close();
  });

  it("a pending golden run backs the tick off like an outage", async () => {
    const s = fresh(); seedAnchor(s); s.noteJevModel(CAND, NOW); serve(s, CAND);
    const bad = fake({ fail: (k) => (isGolden(bad.calls[k - 1]!) ? PARSE_FAIL : undefined) });
    let t = Date.parse(NOW);
    const tick = (c: Fake) => jevVersionTick({ store: s, makeClient: () => c.client, signal: new AbortController().signal, chatId: CHAT, now: () => new Date(t).toISOString(), golden: ["memory.kind"], log: () => {}, paceMs: 0 });
    expect(tick(bad).started).toBe(CAND);
    await jevJobSettled();
    expect(tick(fake()).started).toBeNull();
    t += JEV_JOB_OUTAGE_BACKOFF_MS + 1;
    expect(tick(fake()).started).toBe(CAND);
    await jevJobSettled();
    expect(s.getJevModel(CAND)?.state).toBe("trusted");
    s.close();
  });

  it("boot resolves the model-keyed golden drift incidents the old check left open; the daily ticks' own stay", () => {
    const s = fresh();
    s.openIncident({ kind: "decision_golden_drift", subject: `tool.injection:${CAND}`, detail: {}, now: NOW });
    s.openIncident({ kind: "decision_golden_drift", subject: "memory.kind:jev-old", detail: {}, now: NOW });
    s.openIncident({ kind: "decision_golden_drift", subject: "tool.injection", detail: {}, now: NOW });
    expect(resolveLegacyGoldenModelIncidents(s, NOW)).toBe(2);
    expect(s.listOpenIncidents().map((i) => i.subject)).toEqual(["tool.injection"]);
    s.close();
  });
});

// Final fix F4 (correctness Minor): a tree question whose criteria changed after the import makes the anchor answers to
// another question; comparing them would page a false drift or pass on agreement that means nothing.
describe("a stale anchor (final fix F4)", () => {
  it("an anchor row whose criteria hash differs from the live question's is insufficient (anchor_criteria_stale), asks nothing, and names the re-import", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "hjvs-")), "h.sqlite");
    const seed = RunStore.open(path); seedAnchor(seed); seed.close();
    const db = new DatabaseSync(path);
    db.prepare(`UPDATE jev_anchor SET criteria_hash = 'old' WHERE turn_id = ? AND question_id = 'breadth' AND run = 'B'`).run(turnId(3));
    db.close();
    const s = RunStore.open(path); s.noteJevModel(CAND, NOW);
    const f = fake();
    expect(await runJevCheck(deps(s, f), CAND)).toBe("insufficient");
    expect(f.calls).toHaveLength(0);
    expect(JSON.parse(s.getJevModel(CAND)!.detail_json!)).toMatchObject({ reason: "anchor_criteria_stale", questions: ["breadth"] });
    const text = String(outbox(s)[0]!.payload.text);
    expect(text).toContain("houge jev anchor import --replace");
    expect(text).not.toMatch(/has \d+ zh turns/); // never the too-small text
    s.close();
  });
});
