import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JevResult } from "../../src/jev/jev-client.js";
import { llmLabel, observedAction, parseReplayArgs, runReplay, type ReplayDeps } from "../../src/jev/replay.js";
import type { ChatTurnRow, ReplayTurnRow } from "../../src/run/run-store.js";

const T = (i: number, over: Partial<ReplayTurnRow> = {}): ReplayTurnRow => ({
  turn_id: `u${i}`, chat_id: "c", run_id: `r${i}`, text: `message ${i}`, created_at: `2026-09-10T00:0${i}:00.000Z`,
  recorded_intent: "answer", anchor: `2026-09-10T00:0${i}:00.000Z`, anchor_kind: "classify", ...over
});
const jevOk = (choice = "research", confidence = 0.9): JevResult => ({
  ok: true, model: "jev-1.13.0", input_tokens: 400, latency_ms: 5,
  answers: { intent: { choice, confidence, probabilities: { answer: 0, research: 1, feedback: 0, clarify: 0, selfcode: 0, skill: 0 } } }
});

function deps(turns: ReplayTurnRow[], over: Partial<ReplayDeps> = {}) {
  const outPath = join(mkdtempSync(join(tmpdir(), "jev-replay-")), "replay.jsonl");
  const getChatTurnsBefore = vi.fn((): ChatTurnRow[] => []);
  const d: ReplayDeps = {
    store: { listReplayTurns: () => turns, getChatTurnsBefore, runLoopCapabilities: () => ["web_search"] },
    env: {},
    jev: vi.fn(async () => jevOk()),
    classifyLlm: vi.fn(async () => ({ ok: true as const, raw: '{"intent":"research","query":"x"}' })),
    outPath, maxUsd: 1, dryRun: false, ...over
  };
  return { d, outPath, getChatTurnsBefore };
}

describe("observedAction / llmLabel", () => {
  it.each([
    [["web_search", "self_write_propose"], "selfcode"],
    [["skill_author", "web_search"], "skill"],
    [["http_fetch"], "research"],
    [[], "answer"],
    [["lesson_write"], "unknown"]
  ])("%j → %s (precedence selfcode > skill > research)", (caps, want) => {
    expect(observedAction(caps as string[])).toBe(want);
  });

  it("marks an unparseable LLM reply as not parsed — parseIntent's silent 'answer' default must not count as agreement", () => {
    expect(llmLabel("sorry, I can't")).toEqual({ intent: "answer", parsed: false });
    expect(llmLabel('```json\n{"intent": "Selfcode"}\n```')).toEqual({ intent: "selfcode", parsed: true });
  });

  it("a regex-matched intent whose JSON is otherwise broken must not count as parsed — the recorded label (parseIntent's silent 'answer' fallback) disagrees with what the model actually wrote, so it cannot be treated as a confident verdict", () => {
    expect(llmLabel('{"intent": "skill", "note": undefined}')).toEqual({ intent: "answer", parsed: false });
  });
});

describe("runReplay", () => {
  it("asks BOTH classifiers on the thread rebuilt at the anchor, excluding the target run", async () => {
    const { d, getChatTurnsBefore } = deps([T(1)]);
    const out = await runReplay(d);
    expect(getChatTurnsBefore).toHaveBeenCalledWith("c", 20, "2026-09-09T00:01:00.000Z", "2026-09-10T00:01:00.000Z", "r1");
    expect(out.rows[0]).toMatchObject({ status: "ok", jev_intent: "research", llm_intent: "research", llm_parsed: true, observed_action: "research", recorded_intent: "answer" });
    const [, system] = (d.classifyLlm as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(system).toContain("Today's date is 2026-09-10"); // dated at the ANCHOR, not today
  });

  it("writes JSONL rows WITHOUT message text (bodies never leave the ledger rule)", async () => {
    const { d, outPath } = deps([T(1, { text: "SECRET-ish personal message" })]);
    await runReplay(d);
    const file = readFileSync(outPath, "utf8");
    expect(file).not.toContain("SECRET-ish");
    expect(JSON.parse(file.trim())).toMatchObject({ turn_id: "u1", status: "ok" });
  });

  it("resumes: done turns are skipped on a second run, failed ones are retried", async () => {
    const turns = [T(1), T(2)];
    const first = deps(turns, { jev: vi.fn().mockResolvedValueOnce(jevOk()).mockResolvedValueOnce({ ok: false, reason: "error", detail: "HTTP 500" }) });
    await runReplay(first.d);
    const jev2 = vi.fn(async () => jevOk());
    const out = await runReplay({ ...first.d, jev: jev2 });
    expect(jev2).toHaveBeenCalledTimes(1);
    expect(out.rows.map((r) => [r.turn_id, r.status])).toEqual([["u1", "ok"], ["u2", "ok"]]);
  });

  it("stops before a request would push reserved spend past --max-usd", async () => {
    // First call's estimate is tiny (≪ $0.03) so it dispatches; it then reports 1M input tokens
    // ($0.042 spent), so the second call's spent+estimate exceeds the cap → stop before dispatch.
    const jev = vi.fn(async (): Promise<JevResult> => ({ ...jevOk(), input_tokens: 1_000_000 } as JevResult));
    const { d } = deps([T(1), T(2)], { maxUsd: 0.03, jev });
    const out = await runReplay(d);
    expect(out.stopped).toBe("budget");
    expect(d.jev).toHaveBeenCalledTimes(1);
  });

  it("aborts the whole run on auth — 373 identical failures are noise", async () => {
    const { d } = deps([T(1), T(2)], { jev: vi.fn(async (): Promise<JevResult> => ({ ok: false, reason: "auth", detail: "HTTP 401" })) });
    const out = await runReplay(d);
    expect(out.stopped).toBe("auth");
    expect(d.jev).toHaveBeenCalledTimes(1);
  });

  it("skips no-anchor and over-cap turns with a reason, and never calls either classifier for them", async () => {
    const { d } = deps([T(1, { anchor: null, anchor_kind: null }), T(2, { text: "y".repeat(9000) })]);
    const out = await runReplay(d);
    expect(out.rows.map((r) => r.status)).toEqual(["skipped_no_anchor", "skipped_state_too_large"]);
    expect(d.jev).not.toHaveBeenCalled();
    expect(d.classifyLlm).not.toHaveBeenCalled();
  });

  it("F9: a torn/unparseable trailing line (crash mid-append) does not crash resume — the valid row above it still counts as done", async () => {
    const turns = [T(1), T(2)];
    const { d, outPath } = deps(turns);
    const validRow = { turn_id: "u1", run_id: "r1", lang: "en", anchor_kind: "classify", status: "ok", recorded_intent: "answer", observed_action: "answer", est_tokens: 10 };
    writeFileSync(outPath, `${JSON.stringify(validRow)}\n{"turn_id":"u2","status":"o`);
    const out = await runReplay(d);
    expect(out.rows.map((r) => r.turn_id)).toEqual(["u1", "u2"]);
    expect(out.rows[0]).toMatchObject({ turn_id: "u1", status: "ok" });
    expect(d.jev).toHaveBeenCalledTimes(1); // only u2 dispatched; u1 was reused from the valid row
  });

  it("--dry-run calls nothing and reports an estimate", async () => {
    const { d } = deps([T(1)], { dryRun: true });
    const out = await runReplay(d);
    expect(d.jev).not.toHaveBeenCalled();
    expect(d.classifyLlm).not.toHaveBeenCalled();
    expect(out.rows[0]!.status).toBe("dry_run");
    expect(out.estimatedUsd).toBeGreaterThan(0);
  });

  it("F1: an llm_failed row never carries the provider's raw error prose into the JSONL ledger", async () => {
    const sentinel = "SENTINEL-PROMPT-ECHO-xyz";
    const { d, outPath } = deps([T(1)], { classifyLlm: vi.fn(async () => ({ ok: false as const, error: `stderr: ...${sentinel}...` })) });
    const out = await runReplay(d);
    expect(out.rows[0]).toMatchObject({ status: "llm_failed", error: "llm_chain_failed" });
    const file = readFileSync(outPath, "utf8");
    expect(file).not.toContain(sentinel);
  });

  it("F1: a jev_failed row keeps jev's own fixed-literal detail, prefixed with the reason", async () => {
    const { d } = deps([T(1)], { jev: vi.fn(async (): Promise<JevResult> => ({ ok: false, reason: "error", detail: "HTTP 500" })) });
    const out = await runReplay(d);
    expect(out.rows[0]).toMatchObject({ status: "jev_failed", error: "error: HTTP 500" });
  });

  it("F3: a metered-fuse ('fused') result stops the run like auth, distinct from budget/auth", async () => {
    const { d } = deps([T(1), T(2)], { jev: vi.fn(async (): Promise<JevResult> => ({ ok: false, reason: "fused", detail: "metered fuse latched" })) });
    const out = await runReplay(d);
    expect(out.stopped).toBe("fused");
    expect(d.jev).toHaveBeenCalledTimes(1);
  });

  // The request sends the moving alias `jev-latest`: there is no pin to compare against. A run is one model's evidence,
  // so a reported model that CHANGES mid-run (the alias moved) warns once; a run wholly on a newer model does not.
  it("F5: a reported model that changes mid-run logs exactly one warning naming both models", async () => {
    const log = vi.fn();
    let n = 0;
    const jev = vi.fn(async (): Promise<JevResult> => ({ ...jevOk(), model: n++ === 0 ? "jev-1.13.0" : "jev-1.14.0" } as JevResult));
    const { d } = deps([T(1), T(2), T(3)], { jev, log });
    await runReplay(d);
    const warnings = log.mock.calls.filter(([line]) => typeof line === "string" && line.includes("jev-1.14.0"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toContain("jev-1.13.0");
  });

  it("F5: a model move across a resume warns: the resumed rows seed the run's first reported model", async () => {
    const first = deps([T(1)]);
    await runReplay(first.d); // u1 done on jev-1.13.0
    const log = vi.fn();
    await runReplay({ ...first.d, store: { ...first.d.store, listReplayTurns: () => [T(1), T(2)] }, log,
      jev: vi.fn(async () => ({ ...jevOk(), model: "jev-1.14.0" } as JevResult)) });
    const warnings = log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("warning"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("jev-1.13.0"); expect(warnings[0]).toContain("jev-1.14.0");
  });

  it("F5: a run wholly on one (newer) reported model logs no model warning", async () => {
    const log = vi.fn();
    const { d } = deps([T(1), T(2)], { jev: vi.fn(async () => ({ ...jevOk(), model: "jev-1.14.0" } as JevResult)), log });
    await runReplay(d);
    expect(log.mock.calls.filter(([line]) => typeof line === "string" && line.includes("warning"))).toHaveLength(0);
  });
});

describe("parseReplayArgs", () => {
  it("parses flags with safe defaults and rejects junk", () => {
    expect(parseReplayArgs([])).toEqual({ ok: true, maxUsd: 1, dryRun: false });
    expect(parseReplayArgs(["--since", "2026-09-01T00:00:00.000Z", "--limit", "5", "--max-usd", "0.2", "--dry-run"]))
      .toEqual({ ok: true, sinceIso: "2026-09-01T00:00:00.000Z", limit: 5, maxUsd: 0.2, dryRun: true });
    expect(parseReplayArgs(["--limit", "-3"]).ok).toBe(false);
    expect(parseReplayArgs(["--since", "yesterday"]).ok).toBe(false);
    expect(parseReplayArgs(["--bogus"]).ok).toBe(false);
  });

  it("F6: --since with a UTC offset is normalised to UTC, so it compares correctly against lexical created_at", () => {
    const r = parseReplayArgs(["--since", "2026-09-01T10:00:00+10:00"]);
    expect(r).toMatchObject({ ok: true, sinceIso: "2026-09-01T00:00:00.000Z" });
  });
});
