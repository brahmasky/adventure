import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_MODEL, type JevRequest, type JevResult } from "../../src/jev/jev-client.js";
import { runTriageReplay } from "../../src/jev/triage-replay.js";
import { RunStore } from "../../src/run/run-store.js";
import { ompWorker } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// The calibration report blocks ROWS TO ADD on any state-parity mismatch between a live shadow decision and its replay
// (triage-report parityCheck). That is only safe if a turn with no real difference replays to the SAME state_hash: live
// cuts the thread when the turn is claimed and computes `last_houge_turn.age_s` when it builds the state, and the replay
// must use those two recorded instants, not the row's write time. Otherwise benign timing drift stalls arming forever.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const choice = (c: string, probabilities: Record<string, number>) => ({ type: "choice", choice: c, probabilities, confidence: 0.85 });
const ANSWERS = { lane: choice("none", { none: 0.9, status: 0.05, memory: 0.05 }), complete: choice("pure", { mixed: 0.1, pure: 0.9 }),
  scope: choice("ask", { ask: 0.9, research: 0.1 }) };
const liveFetch = vi.fn(async () => json(200, { model: JEV_MODEL, usage: { input_tokens: 800, output_tokens: 0 }, answers: ANSWERS }));
const replayJev = async (_r: JevRequest): Promise<JevResult> => ({ ok: true, model: JEV_MODEL, input_tokens: 800, latency_ms: 300, answers: ANSWERS as never });
const ENV = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow", HOUGE_CHAT_CONTEXT_WINDOW_MINUTES: "60" };
const at = (iso: string) => new Date(iso);

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("triage state parity: live shadow decision ↔ replay", () => {
  it("replays to the live state_hash despite age rounding, a message mid-triage, a turn on the window edge and one in the cut's millisecond", async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    const claimAt = "2026-10-06T10:00:00.000Z";
    // On the window edge: inside the claim-time window (60 min), outside one measured from any later instant.
    store.recordChatTurn({ chat_id: "555", run_id: "old", role: "user", text: "edge turn", created_at: "2026-10-06T09:00:00.100Z" });
    store.recordChatTurn({ chat_id: "555", run_id: "prev", role: "assistant", text: "earlier answer", intent: "answer", created_at: "2026-10-06T09:59:50.000Z" });
    // Stamped in the claim's own millisecond (a queued turn claimed right after the previous reply): live read it.
    store.recordChatTurn({ chat_id: "555", run_id: "same-ms", role: "user", text: "same ms turn", created_at: claimAt });
    // The state is built at x.4 s (age 10.4 → 10); decide() stamps the row at x.7 s (age 10.7 → 11).
    const ticks = [at("2026-10-06T10:00:00.400Z"), at("2026-10-06T10:00:00.700Z")];
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hpar-")), { jevFetch: liveFetch as unknown as typeof fetch,
      jevNow: () => ticks.length > 1 ? ticks.shift()! : ticks[0]! });
    vi.setSystemTime(at(claimAt));
    const run_id = createQueuedTurnRun(store, "how is the weather");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555"); // the live thread is cut here, at the claim
    // A second message lands after the claim, before the decision: not in the live thread.
    store.recordChatTurn({ chat_id: "555", run_id: "next", role: "user", text: "also this", created_at: "2026-10-06T10:00:00.200Z" });
    expect(await worker.triageTurn({ claim, text: "how is the weather", userText: "how is the weather", modality: "text", posture: null,
      signal: new AbortController().signal })).toEqual({ kind: "fallthrough" });
    const sent = JSON.parse(String((liveFetch.mock.calls.at(-1) as unknown as [unknown, RequestInit])[1].body)) as { state: { recent_turns: Array<{ text: string }> } };
    expect(sent.state.recent_turns.map((t) => t.text)).toEqual(["edge turn", "earlier answer", "same ms turn"]); // not "also this"
    const live = store.listJevDecisions(run_id).find((r) => r.question_id === "lane")!;
    expect(live).toMatchObject({ decision: "shadow", thread_cut_at: claimAt, state_built_at: "2026-10-06T10:00:00.400Z" });
    // The planner then records the turn and its reply (what makes it part of the replay universe).
    store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: "how is the weather", created_at: "2026-10-06T10:00:20.000Z" });
    store.recordChatTurn({ chat_id: "555", run_id, role: "assistant", text: "sunny", intent: "answer", created_at: "2026-10-06T10:00:21.000Z" });
    vi.useRealTimers();
    const r = await runTriageReplay({ store, env: { HOUGE_CHAT_CONTEXT_WINDOW_MINUTES: "60" }, jev: replayJev,
      outPath: join(mkdtempSync(join(tmpdir(), "hpar-")), "r.jsonl"), maxUsd: 1, dryRun: false });
    expect(r.rows.find((x) => x.run_id === run_id)!.state_hash).toBe(live.state_hash);
    store.close();
  });

  it("skipped rows carry no instants (they have no state)", async () => {
    vi.stubEnv("HOUGE_JEV_ENABLED", "0");
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hpar-")), { jevFetch: liveFetch as unknown as typeof fetch });
    const run_id = createQueuedTurnRun(store, "hi");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555");
    await worker.triageTurn({ claim, text: "hi", userText: "hi", modality: "text", posture: null, signal: new AbortController().signal });
    expect(store.listJevDecisions(run_id)).toMatchObject([{ status: "skipped", thread_cut_at: null, state_built_at: null }]);
    store.close();
  });
});
