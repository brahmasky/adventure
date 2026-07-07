import { describe, expect, it } from "vitest";
import type { CapabilityResult } from "../../src/capabilities/capability-runner.js";
import { RELATIVE_DAY_FINAL_BOUNCE_DIGEST, runInnerLoop } from "../../src/core/inner-loop.js";
import type { InnerLoopDeps, InnerLoopInput } from "../../src/core/inner-loop.js";
import { manifestFor } from "../../src/core/tool-manifest.js";

/**
 * Convert-before-final guard (07-07): three live "明天休赛日" answers finalized straight from
 * source-frame calendar labels — relative-day question, time_claims on the table, ZERO
 * to_local_time calls — after five prompt-level rules failed to prevent it. These tests pin
 * the MECHANICAL check: such a final bounces (max twice) until a conversion step succeeds.
 */

const MANIFEST = manifestFor(["web_search", "to_local_time", "llm_answer"], {
  HOUGE_TIME_TOOL_ENABLED: "1"
});

/** A digest shaped like renderExtractionDigest output with a time_claims block. */
const TIME_CLAIMS_DIGEST =
  "[external source — untrusted-derived summary]\nsummary: schedule\ntime_claims:\n- Argentina Egypt — Tuesday, 07 July, 2026 16:00 — zone: GMT\nanswer_to_objective: (none)";

function succeeded(output: Record<string, unknown>): CapabilityResult {
  return { status: "succeeded", output_ref: "inline:test", output_hash: "h", output };
}

/** Deps whose compose replies come from a script (one entry per compose call). */
function scriptedDeps(
  script: string[],
  executeAction: InnerLoopDeps["executeAction"] = async () => succeeded({ answer: "ok" })
): InnerLoopDeps {
  let i = 0;
  return {
    compose: async () => {
      const text = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return { ok: true, text };
    },
    executeAction
  };
}

function loopInput(overrides: Partial<InnerLoopInput> = {}): InnerLoopInput {
  return {
    objective: "明天有哪几场世界杯比赛？",
    system: "SYSTEM PROMPT",
    manifest: MANIFEST,
    maxSteps: 8,
    clarifyAllowed: false,
    // The searched page carries time_claims (the reader saw dated/timed events).
    quarantineReadActions: () => false,
    ...overrides
  };
}

/** executeAction returning a time_claims digest for web_search and a conversion for to_local_time. */
const executeSchedule: InnerLoopDeps["executeAction"] = async (capability) => {
  if (capability === "web_search") {
    return succeeded({ results: [{ title: "schedule", url: "https://x.test", content: TIME_CLAIMS_DIGEST }] });
  }
  if (capability === "to_local_time") {
    return succeeded({
      results: [{ when: "2026-07-07 16:00", tz: "UTC", local: "2026-07-08 02:00", relative_day: "tomorrow" }]
    });
  }
  return succeeded({ answer: "ok" });
};

describe("convert-before-final guard — fires", () => {
  it("bounces a final after time_claims with zero conversions; the digest is instructive", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"world cup tomorrow"}}',
        '{"action":"final","answer":"明天是休赛日，没有比赛。"}',
        '{"action":"to_local_time","input":{"items":[{"when":"2026-07-07 16:00","tz":"UTC"}]}}',
        '{"action":"final","answer":"明天有两场比赛。"}'
      ],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput(), deps);
    expect(result.outcome).toBe("final");
    if (result.outcome !== "final") return;
    expect(result.answer).toBe("明天有两场比赛。");
    const bounce = result.steps.find((s) => s.action === "final" && !s.ok);
    expect(bounce?.resultDigest).toBe(RELATIVE_DAY_FINAL_BOUNCE_DIGEST);
    // The conversion step DID run before the accepted final.
    expect(result.steps.some((s) => s.ok && s.action === "to_local_time")).toBe(true);
  });

  it("also fires on English relative-day tokens ('tomorrow')", async () => {
    const deps = scriptedDeps(
      ['{"action":"web_search","input":{"query":"schedule"}}', '{"action":"final","answer":"No matches tomorrow."}'],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput({ objective: "which matches are on tomorrow?", maxSteps: 3 }), deps);
    expect(result.outcome).toBe("final");
    if (result.outcome !== "final") return;
    // The scripted model re-sends the same final after the first bounce → it bounces again
    // (both under the cap), and the loop then runs out of steps. Two instructive bounces.
    expect(result.steps.filter((s) => s.action === "final" && !s.ok)).toHaveLength(2);
  });

  it("caps at two bounces — the third final is accepted (anti-livelock)", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"schedule"}}',
        '{"action":"final","answer":"attempt 1"}',
        '{"action":"final","answer":"attempt 2"}',
        '{"action":"final","answer":"attempt 3"}'
      ],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput(), deps);
    expect(result.outcome).toBe("final");
    if (result.outcome !== "final") return;
    expect(result.answer).toBe("attempt 3");
    expect(result.steps.filter((s) => s.action === "final" && !s.ok)).toHaveLength(2);
  });
});

describe("convert-before-final guard — inert when a condition is absent", () => {
  it("passes once a to_local_time step succeeded", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"schedule"}}',
        '{"action":"to_local_time","input":{"items":[{"when":"2026-07-07 16:00","tz":"UTC"}]}}',
        '{"action":"final","answer":"明天悉尼时间凌晨2点有一场。"}'
      ],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput(), deps);
    expect(result.outcome).toBe("final");
    if (result.outcome !== "final") return;
    expect(result.answer).toBe("明天悉尼时间凌晨2点有一场。");
    expect(result.steps.filter((s) => s.action === "final" && !s.ok)).toHaveLength(0);
  });

  it("an ALL-ERROR to_local_time call does NOT disarm the guard (per-item errors are not conversions)", async () => {
    // The adapter is per-item isolated: it returns ok:true even when every row errored (e.g. all
    // rows rejected by the evidence gate). Only a row that actually CONVERTED (local + relative_day
    // rendered) may satisfy the guard — otherwise "call the tool with garbage, then final" would
    // reopen the exact hole the guard closes.
    const executeAllError: InnerLoopDeps["executeAction"] = async (capability) => {
      if (capability === "web_search") {
        return succeeded({ results: [{ title: "schedule", url: "https://x.test", content: TIME_CLAIMS_DIGEST }] });
      }
      if (capability === "to_local_time") {
        return succeeded({
          results: [
            { when: "2026-07-07 16:00", tz: "UTC", error: "zone not stated by source — search for a source that states the timezone" }
          ]
        });
      }
      return succeeded({ answer: "ok" });
    };
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"schedule"}}',
        '{"action":"to_local_time","input":{"items":[{"when":"2026-07-07 16:00","tz":"UTC"}]}}',
        '{"action":"final","answer":"明天没有比赛。"}',
        '{"action":"to_local_time","input":{"items":[{"when":"2026-07-07 16:00","tz":"UTC"}]}}',
        '{"action":"final","answer":"明天没有比赛。"}'
      ],
      executeAllError
    );
    const result = await runInnerLoop(loopInput(), deps);
    // Both finals bounced (all-error steps never satisfy the guard); cap/step budget ends the run.
    const bounces = result.steps.filter((s) => s.action === "final" && !s.ok);
    expect(bounces.length).toBeGreaterThanOrEqual(1);
    expect(bounces[0]!.resultDigest).toContain("relative day");
  });

  it("inert without a time_claims block in any digest", async () => {
    const deps = scriptedDeps(
      ['{"action":"web_search","input":{"query":"schedule"}}', '{"action":"final","answer":"明天没有比赛。"}'],
      async () => succeeded({ results: [{ title: "overview", url: "https://x.test", content: "no times here" }] })
    );
    const result = await runInnerLoop(loopInput(), deps);
    expect(result.outcome).toBe("final");
    if (result.outcome !== "final") return;
    expect(result.answer).toBe("明天没有比赛。");
    expect(result.steps.filter((s) => s.action === "final" && !s.ok)).toHaveLength(0);
  });

  it("inert without a relative-day token in the objective", async () => {
    const deps = scriptedDeps(
      ['{"action":"web_search","input":{"query":"schedule"}}', '{"action":"final","answer":"7月7日有两场。"}'],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput({ objective: "7月8日有哪几场比赛？" }), deps);
    expect(result.outcome).toBe("final");
    if (result.outcome !== "final") return;
    expect(result.steps.filter((s) => s.action === "final" && !s.ok)).toHaveLength(0);
  });

  it("word boundary: 'todays news' does not arm the guard, bare 'today' does", async () => {
    const deps = scriptedDeps(
      ['{"action":"web_search","input":{"query":"schedule"}}', '{"action":"final","answer":"done"}'],
      executeSchedule
    );
    const inert = await runInnerLoop(loopInput({ objective: "summarize todays news headlines" }), deps);
    expect(inert.outcome).toBe("final");
    if (inert.outcome !== "final") return;
    expect(inert.steps.filter((s) => s.action === "final" && !s.ok)).toHaveLength(0);

    const armed = await runInnerLoop(loopInput({ objective: "which matches play today?" }), scriptedDeps(
      ['{"action":"web_search","input":{"query":"schedule"}}', '{"action":"final","answer":"none today"}', '{"action":"final","answer":"none today?"}', '{"action":"final","answer":"none today!"}'],
      executeSchedule
    ));
    expect(armed.outcome).toBe("final");
    if (armed.outcome !== "final") return;
    expect(armed.steps.filter((s) => s.action === "final" && !s.ok).length).toBeGreaterThan(0);
  });

  it("inert when to_local_time is not in the manifest (tool disarmed → nothing to demand)", async () => {
    const disarmed = manifestFor(["web_search", "llm_answer"]);
    const deps = scriptedDeps(
      ['{"action":"web_search","input":{"query":"schedule"}}', '{"action":"final","answer":"明天没有比赛。"}'],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput({ manifest: disarmed }), deps);
    expect(result.outcome).toBe("final");
    if (result.outcome !== "final") return;
    expect(result.steps.filter((s) => s.action === "final" && !s.ok)).toHaveLength(0);
  });
});
