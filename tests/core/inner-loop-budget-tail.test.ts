import { describe, expect, it } from "vitest";
import type { CapabilityResult } from "../../src/capabilities/capability-runner.js";
import {
  BUDGET_TAIL_BOUNCE_DIGEST,
  BUDGET_TAIL_BOUNCE_DIGEST_NO_TIME_TOOL,
  BUDGET_TAIL_NOTICE,
  BUDGET_TAIL_NOTICE_NO_TIME_TOOL,
  BUDGET_TAIL_TOOLS,
  buildLoopStepQuestion,
  PROTOCOL_RETRY_ALLOWANCE,
  RELATIVE_DAY_FINAL_BOUNCE_DIGEST,
  runInnerLoop,
  TAIL_RESERVE_STEPS
} from "../../src/core/inner-loop.js";
import type { InnerLoopDeps, InnerLoopInput } from "../../src/core/inner-loop.js";
import { manifestFor } from "../../src/core/tool-manifest.js";

/**
 * B7 budget-tail shaping + B8 protocol-retry hygiene (Phase R levers 2 and 4, 07-12).
 * Live failure class: planners search-until-death — the 07-12 live gate S2 spent all 9 steps
 * on repeated web_search, never called to_local_time, and died on step_cap; a 07-07 run lost
 * a real step to malformed action JSON. These tests pin the MECHANICAL levers: at remaining
 * ≤ TAIL_RESERVE_STEPS the menu shrinks to convert-or-answer and out-of-tail tools bounce
 * (charged, never a failure/parse failure); unparsed retries stop consuming the step budget,
 * backstopped at maxSteps + PROTOCOL_RETRY_ALLOWANCE total iterations.
 */

const MANIFEST = manifestFor(["web_search", "to_local_time", "llm_answer"], {
  HOUGE_TIME_TOOL_ENABLED: "1"
});
const EVIDENCE_MANIFEST = manifestFor(["web_search", "to_local_time", "llm_answer"], {
  HOUGE_TIME_TOOL_ENABLED: "1",
  HOUGE_TZ_EVIDENCE_ENABLED: "1"
});

/** A digest shaped like renderExtractionDigest output with a time_claims block (arms B1). */
const TIME_CLAIMS_DIGEST =
  "[external source — untrusted-derived summary]\nsummary: schedule\ntime_claims:\n- Argentina Egypt — Tuesday, 07 July, 2026 16:00 — zone: GMT\nanswer_to_objective: (none)";

function succeeded(output: Record<string, unknown>): CapabilityResult {
  return { status: "succeeded", output_ref: "inline:test", output_hash: "h", output };
}

/** Deps whose compose replies come from a script (one entry per compose call). */
function scriptedDeps(
  script: string[],
  executeAction: InnerLoopDeps["executeAction"] = async () => succeeded({ answer: "ok" })
): InnerLoopDeps & { composeCalls: Array<{ question: string; system: string }> } {
  const composeCalls: Array<{ question: string; system: string }> = [];
  let i = 0;
  return {
    composeCalls,
    compose: async (input) => {
      composeCalls.push(input);
      const text = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return { ok: true, text };
    },
    executeAction
  };
}

function loopInput(overrides: Partial<InnerLoopInput> = {}): InnerLoopInput {
  return {
    // No relative-day token: the B1 guard stays inert unless a test arms it deliberately.
    objective: "哪个频道转播世界杯？",
    system: "SYSTEM PROMPT",
    manifest: MANIFEST,
    maxSteps: 6,
    clarifyAllowed: true,
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

describe("B7 tail rendering (buildLoopStepQuestion)", () => {
  const questionAt = (remaining: number, manifest = MANIFEST, clarifyAllowed = true) =>
    buildLoopStepQuestion({ objective: "x", manifest, clarifyAllowed }, [], remaining);

  it("at remaining ≤ TAIL_RESERVE_STEPS only the tail tools + final + clarify render, with the notice", () => {
    for (const remaining of [TAIL_RESERVE_STEPS, 1]) {
      const question = questionAt(remaining);
      expect(question).not.toContain("- web_search:");
      expect(question).toContain("- to_local_time:");
      expect(question).toContain("- llm_answer:");
      expect(question).toContain("- final:");
      expect(question).toContain("- clarify:");
      expect(question).toContain(BUDGET_TAIL_NOTICE);
      expect(question).toContain(`up to ${remaining} more step(s)`);
    }
  });

  it("at remaining = TAIL_RESERVE_STEPS + 1 the full manifest still renders, without the notice", () => {
    const question = questionAt(TAIL_RESERVE_STEPS + 1);
    expect(question).toContain("- web_search:");
    expect(question).toContain("- to_local_time:");
    expect(question).toContain("- llm_answer:");
    expect(question).not.toContain(BUDGET_TAIL_NOTICE);
  });

  it("the zone_evidence inputSketch variant survives tail rendering byte-identical", () => {
    const fullLine = questionAt(TAIL_RESERVE_STEPS + 1, EVIDENCE_MANIFEST)
      .split("\n")
      .find((l) => l.startsWith("- to_local_time:"))!;
    const tailLine = questionAt(TAIL_RESERVE_STEPS, EVIDENCE_MANIFEST)
      .split("\n")
      .find((l) => l.startsWith("- to_local_time:"))!;
    expect(fullLine).toContain("zone_evidence");
    expect(tailLine).toBe(fullLine);
  });

  it("clarify disallowed stays disallowed in the tail (the tail never re-opens protocol lines)", () => {
    const question = questionAt(1, MANIFEST, false);
    expect(question).not.toContain("- clarify:");
    expect(question).toContain("- final:");
  });
});

describe("B7 tail enforcement (mechanical)", () => {
  it("a search action in the tail bounces charged with the instructive digest and rides to step_cap — never 'denial'", async () => {
    const executed: string[] = [];
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"q1"}}',
        '{"action":"web_search","input":{"query":"q2"}}',
        '{"action":"web_search","input":{"query":"q3"}}'
      ],
      async (capability) => {
        executed.push(capability);
        return succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] });
      }
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 3 }), deps);

    // Two tail bounces (remaining 2, then 1) — both CHARGED, so the run exits step_cap after
    // exactly maxSteps compose calls. If a bounce incremented `failures`, FAILURE_CAP (2)
    // would have exited via "denial" instead of the honest B5 fallback.
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    expect(deps.composeCalls.length).toBe(3);
    const bounces = result.steps.filter((s) => !s.ok);
    expect(bounces).toHaveLength(2);
    for (const bounce of bounces) expect(bounce.resultDigest).toBe(BUDGET_TAIL_BOUNCE_DIGEST);
    // The bounced actions never reached the deps seam — only the pre-tail search executed.
    expect(executed).toEqual(["web_search"]);
    // The instructive digest rode the next compose question as a FAILED step result.
    expect(deps.composeCalls[2]!.question).toContain(BUDGET_TAIL_BOUNCE_DIGEST);
  });

  it("tail bounces never touch the failures counter: one real denial + tail bounces still exits step_cap", async () => {
    // FAILURE_CAP is 2: a real denial (failures=1) followed by a tail bounce must NOT reach it.
    const deps = scriptedDeps(
      [
        '{"action":"llm_answer","input":{"question":"q"}}',
        '{"action":"web_search","input":{"query":"q1"}}',
        '{"action":"web_search","input":{"query":"q2"}}'
      ],
      async (capability) =>
        capability === "llm_answer"
          ? ({ status: "denied", reason: "no" } as CapabilityResult)
          : succeeded({ answer: "ok" })
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 3 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    expect(result.steps.filter((s) => s.resultDigest === BUDGET_TAIL_BOUNCE_DIGEST)).toHaveLength(2);
  });

  it("tail bounces never touch the parse-failure counter: two bounces do not exit parse_cap", async () => {
    // PARSE_FAILURE_CAP is also 2 — a valid-but-bounced action must not feed it (the reply WAS
    // a valid protocol action). Two consecutive bounces exiting parse_cap would ship lastRaw.
    const deps = scriptedDeps(
      [
        '{"action":"llm_answer","input":{"question":"q"}}',
        '{"action":"web_search","input":{"query":"q1"}}',
        '{"action":"web_search","input":{"query":"q1"}}' // identical repeat, still in tail
      ],
      async () => succeeded({ answer: "partial answer" })
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 3 }), deps);
    // Even the REPEATED out-of-tail action rides the charged tail bounce, not the ping-pong
    // parse-failure path: the run exhausts its budget and exits step_cap honestly.
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap", answer: "partial answer" });
    expect(result.steps.filter((s) => s.resultDigest === BUDGET_TAIL_BOUNCE_DIGEST)).toHaveLength(2);
  });

  it("to_local_time and llm_answer still execute in the tail", async () => {
    const executed: string[] = [];
    const deps = scriptedDeps(
      [
        '{"action":"to_local_time","input":{"items":[{"when":"2026-07-07 16:00","tz":"UTC"}]}}',
        '{"action":"llm_answer","input":{"question":"summarize"}}'
      ],
      async (capability) => {
        executed.push(capability);
        return executeSchedule(capability, {});
      }
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 2 }), deps); // the whole run is tail
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    expect(executed).toEqual(["to_local_time", "llm_answer"]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it("final and clarify still work in the tail (protocol actions are never blocked)", async () => {
    const finalRun = await runInnerLoop(
      loopInput({ maxSteps: 2 }),
      scriptedDeps(['{"action":"final","answer":"done in the tail"}'])
    );
    expect(finalRun).toMatchObject({ outcome: "final", reason: "final", answer: "done in the tail" });

    const clarifyRun = await runInnerLoop(
      loopInput({ maxSteps: 2 }),
      scriptedDeps(['{"action":"clarify","question":"which cup?"}'])
    );
    expect(clarifyRun).toMatchObject({ outcome: "clarify", reason: "clarify", question: "which cup?" });
  });

  it("B1 still applies in the tail: a relative-day final bounces with the B1 digest (not the tail digest)", async () => {
    // web_search (above the tail) surfaces time_claims; the tail final bounces via B1 — whose
    // guidance says convert first, and to_local_time is exactly what the tail still offers.
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"schedule"}}',
        '{"action":"final","answer":"明天休赛日。"}',
        '{"action":"to_local_time","input":{"items":[{"when":"2026-07-07 16:00","tz":"UTC"}]}}'
      ],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput({ objective: "明天有哪几场世界杯比赛？", maxSteps: 3 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    const bounce = result.steps.find((s) => s.action === "final" && !s.ok);
    expect(bounce?.resultDigest).toBe(RELATIVE_DAY_FINAL_BOUNCE_DIGEST);
    // The tail-converted row leads the honest B5 fallback the step_cap ships.
    if (result.outcome !== "final") return;
    expect(result.answer).toContain("2026-07-07 16:00 (UTC) → 2026-07-08 02:00 (tomorrow)");
  });

  it("B1 cap exhausted → a relative-day final IN THE TAIL is accepted, not tail-bounced (verifier probe)", async () => {
    // RELATIVE_DAY_FINAL_BOUNCE_CAP is 2: after both bounces, a genuinely unconvertible run must
    // still be able to END on a final inside the tail — the tail must never block that exit.
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"schedule"}}', // remaining 4: executes, time_claims
        '{"action":"final","answer":"明天A。"}', // B1 bounce 1 (remaining 3)
        '{"action":"final","answer":"明天B。"}', // B1 bounce 2 (remaining 2 — tail)
        '{"action":"final","answer":"明天C。"}' // cap reached → accepted, in the tail
      ],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput({ objective: "明天有哪几场世界杯比赛？", maxSteps: 4 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "final", answer: "明天C。" });
    const finalBounces = result.steps.filter((s) => s.action === "final" && !s.ok);
    expect(finalBounces).toHaveLength(2);
    for (const b of finalBounces) expect(b.resultDigest).toBe(RELATIVE_DAY_FINAL_BOUNCE_DIGEST);
    expect(result.steps.some((s) => s.resultDigest === BUDGET_TAIL_BOUNCE_DIGEST)).toBe(false);
  });

  it("B1 bounce → tail conversion → final passes (the tail offers exactly what the guard demands)", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"schedule"}}',
        '{"action":"final","answer":"明天休赛日。"}',
        '{"action":"to_local_time","input":{"items":[{"when":"2026-07-07 16:00","tz":"UTC"}]}}',
        '{"action":"final","answer":"明天悉尼时间凌晨2点有一场。"}'
      ],
      executeSchedule
    );
    // maxSteps 4: bounce at remaining 3, convert at remaining 2 (tail), final at remaining 1 (tail).
    const result = await runInnerLoop(loopInput({ objective: "明天有哪几场世界杯比赛？", maxSteps: 4 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "final", answer: "明天悉尼时间凌晨2点有一场。" });
    expect(result.steps.some((s) => s.ok && s.action === "to_local_time")).toBe(true);
  });
});

describe("B8 protocol-retry hygiene", () => {
  it("an unparsed reply between two valid actions does not reduce the executed-action count", async () => {
    const executed: string[] = [];
    const deps = scriptedDeps(
      [
        '{"action":"llm_answer","input":{"question":"q1"}}',
        "no json at all",
        '{"action":"llm_answer","input":{"question":"q2"}}'
      ],
      async (capability) => {
        executed.push(capability);
        return succeeded({ answer: "ok" });
      }
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 2 }), deps);
    // Pre-B8 the unparsed retry consumed step 2 of 2 and only ONE action executed.
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    expect(executed).toEqual(["llm_answer", "llm_answer"]);
    expect(deps.composeCalls.length).toBe(3); // 2 charged + 1 free retry
    // The (unparsed) transcript record STAYS — the model must still see the correction.
    const unparsed = result.steps.filter((s) => s.action === "(unparsed)");
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]!.resultDigest).toContain("not a single valid action JSON");
  });

  it("the remaining-steps number shown to the model stays correct across an unparsed retry", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"llm_answer","input":{"question":"q1"}}',
        "garbage",
        '{"action":"llm_answer","input":{"question":"q2"}}'
      ],
      async () => succeeded({ answer: "ok" })
    );
    await runInnerLoop(loopInput({ maxSteps: 2 }), deps);
    expect(deps.composeCalls[0]!.question).toContain("up to 2 more step(s)");
    expect(deps.composeCalls[1]!.question).toContain("up to 1 more step(s)");
    // The retry after the free unparsed iteration shows the SAME budget — nothing was charged.
    expect(deps.composeCalls[2]!.question).toContain("up to 1 more step(s)");
  });

  it("PARSE_FAILURE_CAP consecutive unparsed replies still exits parse_cap (unchanged)", async () => {
    const deps = scriptedDeps(["no json at all", "The answer is channel 7."]);
    const result = await runInnerLoop(loopInput(), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "parse_cap", answer: "The answer is channel 7." });
    expect(deps.composeCalls.length).toBe(2);
  });

  it("alternating unparsed/valid stops at maxSteps + PROTOCOL_RETRY_ALLOWANCE iterations via step_cap", async () => {
    // Each valid reply resets the consecutive parse-failure counter, so PARSE_FAILURE_CAP never
    // fires; the hard iteration backstop must — via the honest step_cap fallback.
    const deps = scriptedDeps(
      [
        "garbage",
        '{"action":"llm_answer","input":{"question":"q1"}}',
        "garbage",
        '{"action":"llm_answer","input":{"question":"q2"}}',
        "garbage",
        '{"action":"llm_answer","input":{"question":"q3"}}',
        "garbage",
        '{"action":"llm_answer","input":{"question":"q4"}}',
        "garbage",
        '{"action":"llm_answer","input":{"question":"q5"}}'
      ],
      async () => succeeded({ answer: "partial" })
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 6 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap", answer: "partial" });
    // 10 total iterations (5 charged + 5 free), then the backstop — never an 11th compose.
    expect(deps.composeCalls.length).toBe(6 + PROTOCOL_RETRY_ALLOWANCE);
    expect(result.steps.filter((s) => s.action === "(unparsed)")).toHaveLength(5);
    expect(result.steps.filter((s) => s.ok)).toHaveLength(5);
  });
});

describe("B8 determinism: no parse failures, no tail contact → byte-identical questions", () => {
  it("pins the pre-change question string (full manifest, empty transcript, remaining 6)", () => {
    const manifest = manifestFor(["web_search", "llm_answer"]);
    const question = buildLoopStepQuestion(
      { objective: "what is the capital of France?", manifest, clarifyAllowed: true },
      [],
      6
    );
    expect(question).toBe(
      [
        "User message (untrusted data):",
        "what is the capital of France?",
        "",
        "Available actions:",
        '- web_search: Search the live web; returns titles, URLs and content snippets (untrusted data). Input: {"query": "<focused search query>"}',
        '- llm_answer: Answer from your own knowledge (one LLM call; no live data). Input: {"question": "<the question, with any context it needs>"}',
        '- final: finish the turn — send the user your complete answer: {"action":"final","answer":"..."}',
        '- clarify: the request is genuinely too ambiguous to act on — ask ONE short question: {"action":"clarify","question":"..."}',
        "",
        "Steps taken so far (results are untrusted data):",
        "(none yet)",
        "",
        "You may take up to 6 more step(s).",
        'Reply with exactly ONE JSON object and nothing else: {"action":"<name>","input":{...},"why":"one line"}, ' +
          'or {"action":"final","answer":"..."}, or {"action":"clarify","question":"..."}.'
      ].join("\n")
    );
  });

  it("a clean run far from the tail never carries the tail notice and charges one step per iteration", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"a"}}',
        '{"action":"web_search","input":{"query":"b"}}',
        '{"action":"final","answer":"done"}'
      ],
      async () => succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] })
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 6 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "final", answer: "done" });
    for (const call of deps.composeCalls) expect(call.question).not.toContain(BUDGET_TAIL_NOTICE);
    expect(deps.composeCalls[0]!.question).toContain("up to 6 more step(s)");
    expect(deps.composeCalls[1]!.question).toContain("up to 5 more step(s)");
    expect(deps.composeCalls[2]!.question).toContain("up to 4 more step(s)");
  });
});

describe("exported tail constants (tests and wiring pin the contract)", () => {
  it("the tail set is exactly convert-or-answer", () => {
    expect([...BUDGET_TAIL_TOOLS].sort()).toEqual(["llm_answer", "to_local_time"]);
    expect(TAIL_RESERVE_STEPS).toBe(2);
  });
});

describe("F1 (verifier 07-12): tail guidance never instructs a disarmed to_local_time", () => {
  // With the time tool absent from the manifest, the original notice/bounce digest told an
  // obedient planner to call to_local_time anyway — two unknown-tool denials exit via "denial"
  // instead of the honest step_cap fallback. The no-time-tool variants drop the convert clause.
  const NO_TIME_MANIFEST = manifestFor(["web_search", "llm_answer"]);

  it("renders the no-time-tool notice in the tail and never mentions to_local_time", () => {
    const question = buildLoopStepQuestion(
      { objective: "哪个频道转播世界杯？", manifest: NO_TIME_MANIFEST, clarifyAllowed: false },
      [],
      TAIL_RESERVE_STEPS
    );
    expect(question).toContain(BUDGET_TAIL_NOTICE_NO_TIME_TOOL);
    expect(question).not.toContain(BUDGET_TAIL_NOTICE);
    expect(question).not.toContain("to_local_time");
  });

  it("tail-bounces with the no-time-tool digest, still riding to step_cap (never denial)", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"q1"}}',
        '{"action":"web_search","input":{"query":"q2"}}'
      ],
      async () => succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] })
    );
    const result = await runInnerLoop(loopInput({ manifest: NO_TIME_MANIFEST, maxSteps: 2 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    const bounces = result.steps.filter((s) => !s.ok);
    expect(bounces).toHaveLength(2);
    for (const bounce of bounces) {
      expect(bounce.resultDigest).toBe(BUDGET_TAIL_BOUNCE_DIGEST_NO_TIME_TOOL);
      expect(bounce.resultDigest).not.toContain("to_local_time");
    }
  });

  it("keeps the convert-instructing variants when to_local_time IS armed (unchanged behavior)", () => {
    const question = buildLoopStepQuestion(
      { objective: "哪个频道转播世界杯？", manifest: MANIFEST, clarifyAllowed: false },
      [],
      TAIL_RESERVE_STEPS
    );
    expect(question).toContain(BUDGET_TAIL_NOTICE);
    expect(question).not.toContain(BUDGET_TAIL_NOTICE_NO_TIME_TOOL);
  });
});
