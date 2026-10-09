import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
// Generous defaults: a slow CI box must not turn a healthy step into a timeout. A test that needs a timeout to fire sets
// its own small value (FAST_TIMEOUTS) explicitly.
const FAST_TIMEOUTS = { startMs: 100, commandMs: 100, frameMs: 100, promptMs: 100 };

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
  timeouts: { startMs: 2_000, commandMs: 2_000, frameMs: 2_000, promptMs: 2_000 }, ...o
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
    expect((await run({ start: () => new Promise(() => {}) }, { timeouts: FAST_TIMEOUTS })).checks.session_open).toBe("inconclusive:timeout");
  });

  // Spec Rev 3: any step timeout is inconclusive. PlannerSession.start() itself rejects `timeout:open_session` when omp
  // reaches ready but never answers open_session; mapping that to fail:start would page drift for a slow omp.
  it("a start that rejects with a timeout code is inconclusive, not drift", async () => {
    const r = await run({ start: () => Promise.reject(new PlannerRpcError("timeout:open_session")) });
    expect(r.checks.session_open).toBe("inconclusive:timeout");
    expect(r.result).toBe("inconclusive");
  });

  // A hung command is a timing hiccup, never drift: each of these must leave the probe inconclusive (no page).
  it.each([
    ["set_model (pin)", { pin: () => new Promise<void>(() => {}) }, "pin_refusal"],
    ["set_thinking_level (effort)", { effort: () => new Promise<void>(() => {}) }, "effort"],
    ["new_session", { newSession: () => new Promise<{ cancelled: boolean }>(() => {}) }, "new_session"]
  ])("a %s that never answers is inconclusive:timeout, not drift", async (_n, script, check) => {
    const r = await run(script as Script, { timeouts: FAST_TIMEOUTS });
    expect(r.checks[check as "pin_refusal"]).toBe("inconclusive:timeout");
    expect(r.result).toBe("inconclusive");
    // later checks still run on the same child (a timeout does not end the probe)
    expect(r.checks.prompt).toBe("pass");
  });

  it.each([
    ["accepted", async () => {}, "fail:accepted"],
    ["reworded", () => Promise.reject(new PlannerRpcError("command_failed:set_model", "no such thing")), "fail:unclassified"]
  ])("pin refusal %s → %s", async (_n, pin, want) => {
    expect((await run({ pin })).checks.pin_refusal).toBe(want);
  });

  it("effort passes only on the thinking_level_changed frames, since omp answers success to any level", async () => {
    expect((await run({})).checks.effort).toBe("pass");
    expect((await run({ effortFrame: null }, { timeouts: { ...FAST_TIMEOUTS, commandMs: 2_000, promptMs: 2_000 } })).checks.effort).toBe("fail:no_frame");
    expect((await run({ effortFrame: { type: "thinking_level_changed", thinkingLevel: "xhigh" } }, { timeouts: { ...FAST_TIMEOUTS, commandMs: 2_000, promptMs: 2_000 } })).checks.effort).toBe("fail:no_frame");
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
  it.each([
    ["quota", "429 rate limit"], ["auth", "401 not logged in"], ["transport", "ECONNRESET socket hang up"],
    ["timeout", "upstream timed out"], ["model_missing", "unknown model kimi-x"]
  ])("a prompt refused with a provider %s error is inconclusive and its detail is not kept", async (kind, detail) => {
    const r = await run({ prompt: () => Promise.reject(new PlannerRpcError("command_failed:prompt", detail)) });
    expect(r.checks.prompt).toBe(`inconclusive:provider_${kind}`);
    expect(JSON.stringify(r)).not.toContain(detail);
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

  // A real PlannerSession.stop() takes up to seconds (abort, SIGTERM, SIGKILL) and a second stop() returns at once: the
  // probe must wait for the FIRST stop (the abort's) before deleting the dirs the child may still be writing into.
  it("an abort waits for the child's stop to finish before removing the probe dirs", async () => {
    const ac = new AbortController();
    const log: string[] = [];
    const base = fakeSession({ start: () => { setTimeout(() => ac.abort(), 10); return new Promise(() => {}); } });
    const slowStop = (o: PlannerSessionOptions): ProbeSessionLike => {
      const s = base(o);
      let first: Promise<void> | null = null;
      return { ...s, stop: () => {
        if (first) return Promise.resolve(); // like PlannerSession: a repeat stop() returns at once
        first = new Promise<void>((res) => setTimeout(() => {
          log.push(`stopped dirs=${existsSync(o.cwd) && existsSync(o.sessionDir)}`); void s.stop().then(res);
        }, 50));
        return first;
      } };
    };
    await run({}, { signal: ac.signal, session: slowStop, timeouts: { startMs: 5_000, commandMs: 5_000, frameMs: 5_000, promptMs: 5_000 } });
    // every child's stop finished before the probe returned, each while its dirs still existed
    expect(log).toEqual(opened.map(() => "stopped dirs=true"));
    expect(readdirSync(join(data, "omp", "workspace"))).toEqual([]);
  });

  // The catalog read is a child too: the stop signal must reach it, not just the RPC children.
  it("an abort during the catalog check reaches the catalog read's signal", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const r = await run({}, { signal: ac.signal, catalog: (signal) => {
      seen = signal; setTimeout(() => ac.abort(), 10); return new Promise(() => {});
    } });
    expect(seen?.aborted).toBe(true);
    expect(r.checks.catalog).toBe("skipped");
  });
});
