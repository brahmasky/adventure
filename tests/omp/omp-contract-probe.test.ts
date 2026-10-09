import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_BOGUS_MODEL, runOmpContractProbe, type ProbeInput, type ProbeSessionLike } from "../../src/omp/omp-contract-probe.js";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { PlannerRpcError, type PlannerSessionOptions } from "../../src/omp/planner-session.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import type { ModelString } from "../../src/omp/model-string.js";

// Spec §4: the probe is the only thing standing between a quiet omp contract change and silently broken fallback,
// attribution or session reset. Every drift shape must FAIL (page), every provider or timing hiccup must be INCONCLUSIVE
// (no page), the probe child must never get tools, and omp's text must never leave the probe.
const MODEL: ModelString = { provider: "kimi-code", model: "k3", effort: "low" };
const GOOD_END: OmpFrame = { type: "message_end", message: { role: "assistant", provider: "kimi-code", model: "k3", stopReason: "stop",
  usage: { input: 12, output: 2 }, content: [{ type: "text", text: "OK" }] } };

interface Script {
  startRefusal?: () => Promise<{ resumed: boolean; sessionId: string }>;
  start?: () => Promise<{ resumed: boolean; sessionId: string }>;
  pin?: () => Promise<void>;
  effort?: () => Promise<void>;
  effortFrame?: OmpFrame | null;
  newSession?: () => Promise<{ cancelled: boolean }>;
  promptFrames?: OmpFrame[];
  prompt?: () => Promise<void>;
}
let data: string; let opened: PlannerSessionOptions[]; let stopped: number;

function fakeSession(s: Script) {
  return (o: PlannerSessionOptions): ProbeSessionLike => {
    opened.push(o);
    const cbs: Array<(f: OmpFrame) => void> = [];
    let current = o.model.effort; let wasStopped = false;
    const emit = (f: OmpFrame) => { for (const cb of cbs) cb(f); };
    const bogus = o.model.provider === PROBE_BOGUS_MODEL.provider;
    return {
      start: () => (bogus ? (s.startRefusal ?? (() => Promise.reject(new PlannerRpcError("exited:model_missing"))))()
        : (s.start ?? (async () => ({ resumed: false, sessionId: "s1" })))()),
      setModel: async (m) => {
        if (m.provider === PROBE_BOGUS_MODEL.provider) return (s.pin ?? (() => Promise.reject(new PlannerRpcError("command_failed:set_model", "Model not found: houge-probe/no-such-model"))))();
      },
      // omp emits the frame BEFORE its reply, and only on a change: a probe that subscribes late, or re-sets the level the
      // child already has, must fail here as it would live
      setThinkingLevel: async (level) => {
        await (s.effort ?? (async () => {}))();
        const f = s.effortFrame === undefined ? (level !== current ? { type: "thinking_level_changed", thinkingLevel: level } : null) : s.effortFrame;
        current = level;
        if (f) emit(f);
      },
      newSession: () => (s.newSession ?? (async () => ({ cancelled: false })))(),
      prompt: async () => { if (s.prompt) return s.prompt(); setTimeout(() => { for (const f of s.promptFrames ?? [GOOD_END, { type: "agent_end" }]) emit(f); }, 0); },
      onFrame: (cb) => { cbs.push(cb); },
      stop: async () => { if (!wasStopped) { wasStopped = true; stopped += 1; } }
    };
  };
}
const run = (s: Script, o: Partial<ProbeInput> = {}) => runOmpContractProbe({
  cfg: resolveOmpConfig({}), ctx: { home: data, repo: data, data }, version: "18.7.0", model: MODEL,
  session: fakeSession(s), catalog: async () => ({ kind: "ok", models: [{ provider: "kimi-code", id: "k3", thinking: ["low", "medium", "high"] }] }),
  prepare: () => ({ configFile: join(data, "c.yml"), plannerProfile: join(data, "p.sb") }),
  timeouts: { startMs: 200, commandMs: 200, frameMs: 100, promptMs: 200 }, ...o
});

beforeEach(() => { data = mkdtempSync(join(tmpdir(), "probe-")); opened = []; stopped = 0; });
afterEach(() => { rmSync(data, { recursive: true, force: true }); });

describe("omp contract probe", () => {
  it("passes all seven checks on a healthy omp, records usage, and cleans up", async () => {
    const r = await run({});
    expect(r.result).toBe("pass");
    expect(Object.values(r.checks)).toEqual(Array(7).fill("pass"));
    expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 2 });
    expect(r.model).toBe("kimi-code/k3:low");
    expect(stopped).toBe(opened.length);
    expect(readdirSync(join(data, "omp", "workspace"))).toEqual([]);
    expect(readdirSync(join(data, "omp", "sessions"))).toEqual([]);
  });

  it("never gives a probe child tools, a bridge, or a log line of omp's text", async () => {
    await run({});
    for (const o of opened) expect(o).toMatchObject({ tools: "none", quietRpcErrors: true, extensions: [], bridgeSock: "", bridgeToken: "" });
    expect(opened.every((o) => o.cwd.startsWith(join(data, "omp", "workspace", "probe-")))).toBe(true);
    expect(opened.every((o) => o.sessionDir.startsWith(join(data, "omp", "sessions", "probe-")))).toBe(true);
  });

  it.each([
    ["catalog unparsed is drift", { catalog: async () => ({ kind: "unparsed" as const }) }, "catalog", "fail:unparsed"],
    ["catalog unavailable is not", { catalog: async () => ({ kind: "unavailable" as const, code: "ETIMEDOUT" }) }, "catalog", "inconclusive:catalog_unavailable"]
  ])("%s", async (_n, o, check, code) => {
    const r = await run({}, o);
    expect(r.checks[check as "catalog"]).toBe(code);
  });

  it("a reworded start refusal is drift", async () => {
    const r = await run({ startRefusal: () => Promise.reject(new PlannerRpcError("exited:other")) });
    expect(r.checks.start_refusal).toBe("fail:unclassified");
    expect(r.result).toBe("fail");
  });

  it("a bogus model that starts is drift", async () => {
    expect((await run({ startRefusal: async () => ({ resumed: false, sessionId: "x" }) })).checks.start_refusal).toBe("fail:started");
  });

  it.each([
    ["exited:quota", "inconclusive:start_quota"], ["exited:auth", "inconclusive:start_auth"],
    ["exited:transport", "inconclusive:start_transport"], ["exited:model_missing", "inconclusive:start_model_missing"],
    ["exited:other", "fail:start"]
  ])("session_open start failure %s → %s, later checks skipped", async (code, want) => {
    const r = await run({ start: () => Promise.reject(new PlannerRpcError(code)) });
    expect(r.checks.session_open).toBe(want);
    expect([r.checks.pin_refusal, r.checks.effort, r.checks.new_session, r.checks.prompt]).toEqual(Array(4).fill("skipped"));
  });

  it("an open_session reply without a sessionId is drift", async () => {
    expect((await run({ start: async () => ({ resumed: false, sessionId: "" }) })).checks.session_open).toBe("fail:shape");
  });

  it("a start that never reaches ready is inconclusive, not drift", async () => {
    expect((await run({ start: () => new Promise(() => {}) })).checks.session_open).toBe("inconclusive:timeout");
  });

  it.each([
    ["accepted", async () => {}, "fail:accepted"],
    ["reworded", () => Promise.reject(new PlannerRpcError("command_failed:set_model", "no such thing")), "fail:unclassified"]
  ])("pin refusal %s → %s", async (_n, pin, want) => {
    expect((await run({ pin })).checks.pin_refusal).toBe(want);
  });

  it("effort passes only on the thinking_level_changed frames, since omp answers success to any level", async () => {
    expect((await run({})).checks.effort).toBe("pass");
    expect((await run({ effortFrame: null })).checks.effort).toBe("fail:no_frame");
    expect((await run({ effortFrame: { type: "thinking_level_changed", thinkingLevel: "xhigh" } })).checks.effort).toBe("fail:no_frame");
    expect((await run({ effort: () => Promise.reject(new PlannerRpcError("command_failed:set_thinking_level", "x")) })).checks.effort).toBe("fail:rejected");
  });

  it("effort is skipped when the model has no other catalogued level", async () => {
    const r = await run({}, { catalog: async () => ({ kind: "ok", models: [{ provider: "kimi-code", id: "k3", thinking: ["low"] }] }) });
    expect(r.checks.effort).toBe("skipped");
    expect(r.result).toBe("pass");
  });

  it("new_session without a boolean cancelled is drift", async () => {
    expect((await run({ newSession: () => Promise.reject(new PlannerRpcError("new_session_malformed")) })).checks.new_session).toBe("fail:shape");
  });

  it.each([
    ["usage missing", { ...GOOD_END, message: { ...(GOOD_END.message as object), usage: undefined } }],
    ["usage mistyped", { ...GOOD_END, message: { ...(GOOD_END.message as object), usage: { input: "12", output: 2 } } }],
    ["provider missing", { ...GOOD_END, message: { ...(GOOD_END.message as object), provider: undefined } }],
    ["empty text", { ...GOOD_END, message: { ...(GOOD_END.message as object), content: [] } }]
  ])("a message_end with %s is drift", async (_n, end) => {
    const r = await run({ promptFrames: [end as OmpFrame, { type: "agent_end" }] });
    expect(r.checks.prompt).toBe("fail:shape");
    expect(r.usage).toBeNull();
  });

  it.each([
    ["an error frame", { type: "error", error: "429 rate limit, resets in 3h" }],
    ["a failed prompt_result", { type: "prompt_result", agentInvoked: false, status: "error", error: "429 rate limit, resets in 3h" }]
  ])("%s is a provider condition, not drift", async (_n, f) => {
    const r = await run({ promptFrames: [f as OmpFrame] });
    expect(r.checks.prompt).toBe("inconclusive:provider_quota");
    expect(JSON.stringify(r)).not.toContain("resets in");
  });

  it("a rate-limited reply is inconclusive and its text is not kept", async () => {
    const end = { ...GOOD_END, message: { ...(GOOD_END.message as object), stopReason: "error", errorMessage: "429 rate limit, resets in 3h" } };
    const r = await run({ promptFrames: [end as OmpFrame, { type: "agent_end" }] });
    expect(r.checks.prompt).toBe("inconclusive:provider_quota");
    expect(JSON.stringify(r)).not.toContain("resets in");
  });

  // A refused prompt command carries omp's error detail: a provider condition is not drift (no page), anything else is.
  it("a prompt refused with a provider error is inconclusive and its detail is not kept", async () => {
    const r = await run({ prompt: () => Promise.reject(new PlannerRpcError("command_failed:prompt", "429 rate limit")) });
    expect(r.checks.prompt).toBe("inconclusive:provider_quota");
    expect(JSON.stringify(r)).not.toContain("rate limit");
  });

  it("a prompt refused for any other reason is drift", async () => {
    const r = await run({ prompt: () => Promise.reject(new PlannerRpcError("command_failed:prompt", "bad request shape")) });
    expect(r.checks.prompt).toBe("fail:rejected");
    expect(JSON.stringify(r)).not.toContain("bad request");
  });

  it("no model: start refusal still checked, the rest inconclusive or skipped", async () => {
    const r = await run({}, { model: null });
    expect(r.checks.start_refusal).toBe("pass");
    expect(r.checks.session_open).toBe("inconclusive:no_model");
    expect(r.result).toBe("inconclusive");
  });

  it("an abort stops the live child at once and skips the rest", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const r = await run({ start: () => { setTimeout(() => ac.abort(), 10); return new Promise(() => {}); } },
      { signal: ac.signal, timeouts: { startMs: 5_000, commandMs: 5_000, frameMs: 5_000, promptMs: 5_000 } });
    expect(Date.now() - t0).toBeLessThan(1_000); // the abort, not the 5 s start timeout, ended it
    expect(r.checks.prompt).toBe("skipped");
    expect(stopped).toBe(opened.length);
  });
});
