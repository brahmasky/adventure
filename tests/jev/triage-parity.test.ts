import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { runTreeReplay } from "../../src/jev/triage-replay.js";
import { RunStore } from "../../src/run/run-store.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";
import { ompWorker } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// The replay is evidence for arming only if a turn with no real difference replays to the SAME state_hash as its live
// decision row: live cuts the thread at the claim and computes ages when it builds the state, and the replay must use
// those two recorded instants. Otherwise the report compares Jev on a state live never sent.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ANSWERS = treeAnswers({ category: "lookup" });
/** The versioned id Jev reports (the request names the alias `jev-latest`; rows and calibration key on the reported id). */
const REPORTED = "jev-1.13.0";
const liveFetch = vi.fn(async () => json(200, { model: REPORTED, usage: { input_tokens: 800, output_tokens: 0 }, answers: ANSWERS }));
const replayJev = async (_r: JevRequest): Promise<JevResult> => ({ ok: true, model: REPORTED, input_tokens: 800, latency_ms: 300, answers: ANSWERS });
const ENV = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", HOUGE_CHAT_CONTEXT_WINDOW_MINUTES: "60" };
const at = (iso: string) => new Date(iso);

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("tree state parity: live decision ↔ replay", () => {
  it("replays to the live state_hash despite age rounding, a message mid-decision, a turn on the window edge and one in the cut's millisecond", async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    const claimAt = "2026-10-06T10:00:00.000Z";
    store.recordChatTurn({ chat_id: "555", run_id: "old", role: "user", text: "edge turn", created_at: "2026-10-06T09:00:00.100Z" });
    store.recordChatTurn({ chat_id: "555", run_id: "prev", role: "assistant", text: "earlier answer", intent: "answer", created_at: "2026-10-06T09:59:50.000Z" });
    store.recordChatTurn({ chat_id: "555", run_id: "same-ms", role: "user", text: "same ms turn", created_at: claimAt });
    const ticks = [at("2026-10-06T10:00:00.400Z"), at("2026-10-06T10:00:00.700Z")];
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hpar-")), { jevFetch: liveFetch as unknown as typeof fetch,
      jevNow: () => ticks.length > 1 ? ticks.shift()! : ticks[0]! });
    vi.setSystemTime(at(claimAt));
    const run_id = createQueuedTurnRun(store, "how is the weather");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555"); // the live thread is cut here, at the claim
    store.recordChatTurn({ chat_id: "555", run_id: "next", role: "user", text: "also this", created_at: "2026-10-06T10:00:00.200Z" });
    // No tree calibration row exists, so the live route is `uncalibrated` → planner; the state is what matters here.
    expect(await worker.triageTurn({ claim, text: "how is the weather", userText: "how is the weather", modality: "text", posture: null,
      signal: new AbortController().signal })).toMatchObject({ kind: "fallthrough" });
    const sent = JSON.parse(String((liveFetch.mock.calls.at(-1) as unknown as [unknown, RequestInit])[1].body)) as { state: { recent_turns: Array<{ text: string }> } };
    expect(sent.state.recent_turns.map((t) => t.text)).toEqual(["edge turn", "earlier answer", "same ms turn"]); // not "also this"
    const live = store.listJevDecisions(run_id).find((r) => r.question_id === "category")!;
    expect(live).toMatchObject({ thread_cut_at: claimAt, state_built_at: "2026-10-06T10:00:00.400Z" });
    store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: "how is the weather", created_at: "2026-10-06T10:00:20.000Z" });
    store.recordChatTurn({ chat_id: "555", run_id, role: "assistant", text: "sunny", intent: "answer", created_at: "2026-10-06T10:00:21.000Z" });
    vi.useRealTimers();
    const r = await runTreeReplay({ store, env: { HOUGE_CHAT_CONTEXT_WINDOW_MINUTES: "60" }, jev: replayJev,
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
