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
  RELATIVE_DAY_FINAL_BOUNCE_DIGEST_TAIL,
  RELATIVE_DAY_FINAL_BOUNCE_DIGEST_TAIL_NO_TIME_TOOL,
  RELATIVE_DAY_SEARCH_INSTRUCTION,
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
      // local_tz mirrors the real adapter's envelope (R1) so rendered rows stay representative.
      local_tz: "Australia/Sydney",
      results: [{ when: "2026-07-07 16:00", tz: "UTC", local: "2026-07-08 02:00", relative_day: "tomorrow" }]
    });
  }
  return succeeded({ answer: "ok" });
};

describe("B7 tail rendering (buildLoopStepQuestion)", () => {
  // maxSteps 6 > TAIL_RESERVE_STEPS: the tail arms on the remaining-steps number alone (R3).
  const questionAt = (remaining: number, manifest = MANIFEST, clarifyAllowed = true) =>
    buildLoopStepQuestion({ objective: "x", manifest, clarifyAllowed, maxSteps: 6 }, [], remaining);

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
    // maxSteps 3 (R3: the tail needs maxSteps > TAIL_RESERVE_STEPS to arm): web_search executes
    // above the tail; the convert-or-answer tools execute INSIDE it (remaining 2, then 1).
    const executed: string[] = [];
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"schedule"}}',
        '{"action":"to_local_time","input":{"items":[{"when":"2026-07-07 16:00","tz":"UTC"}]}}',
        '{"action":"llm_answer","input":{"question":"summarize"}}'
      ],
      async (capability) => {
        executed.push(capability);
        return executeSchedule(capability, {});
      }
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 3 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    expect(executed).toEqual(["web_search", "to_local_time", "llm_answer"]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it("final and clarify still work in the tail (protocol actions are never blocked)", async () => {
    // maxSteps 3 with one executed step first, so the final/clarify lands INSIDE an armed tail
    // (remaining 2) — R3: a maxSteps-2 run would not arm the tail at all.
    const finalRun = await runInnerLoop(
      loopInput({ maxSteps: 3 }),
      scriptedDeps(['{"action":"llm_answer","input":{"question":"q"}}', '{"action":"final","answer":"done in the tail"}'])
    );
    expect(finalRun).toMatchObject({ outcome: "final", reason: "final", answer: "done in the tail" });

    const clarifyRun = await runInnerLoop(
      loopInput({ maxSteps: 3 }),
      scriptedDeps(['{"action":"llm_answer","input":{"question":"q"}}', '{"action":"clarify","question":"which cup?"}'])
    );
    expect(clarifyRun).toMatchObject({ outcome: "clarify", reason: "clarify", question: "which cup?" });
  });

  it("B1 still applies in the tail: a relative-day final bounces with the TAIL B1 digest (R2 — never 'search')", async () => {
    // web_search (above the tail) surfaces time_claims; the tail final bounces via B1 — whose
    // TAIL variant says convert-what-you-have (to_local_time is exactly what the tail still
    // offers) and, unlike the base digest, never instructs the search the tail would bounce.
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
    expect(bounce?.resultDigest).toBe(RELATIVE_DAY_FINAL_BOUNCE_DIGEST_TAIL);
    // The tail-converted row leads the honest B5 fallback the step_cap ships (R1: zone named).
    if (result.outcome !== "final") return;
    expect(result.answer).toContain("2026-07-07 16:00 (UTC) → 2026-07-08 02:00 (tomorrow, Australia/Sydney)");
  });

  it("B1 cap exhausted → a relative-day final IN THE TAIL is accepted, not tail-bounced (verifier probe)", async () => {
    // RELATIVE_DAY_FINAL_BOUNCE_CAP is 2: after both bounces, a genuinely unconvertible run must
    // still be able to END on a final inside the tail — the tail must never block that exit.
    // R2 (verifier fix): the digest is gated on the POST-bounce position — the bounce charges
    // a step, so the digest is READ one step later. A bounce at remaining 3 lands in a remaining-2
    // (tail) question: base wording there would instruct a search the menu just banned.
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"schedule"}}', // remaining 5: executes, time_claims
        '{"action":"final","answer":"明天A。"}', // B1 bounce 1 (read at remaining 3 — above the tail)
        '{"action":"final","answer":"明天B。"}', // B1 bounce 2 (read at remaining 2 — tail)
        '{"action":"final","answer":"明天C。"}' // cap reached → accepted, in the tail
      ],
      executeSchedule
    );
    const result = await runInnerLoop(loopInput({ objective: "明天有哪几场世界杯比赛？", maxSteps: 5 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "final", answer: "明天C。" });
    const finalBounces = result.steps.filter((s) => s.action === "final" && !s.ok);
    expect(finalBounces).toHaveLength(2);
    expect(finalBounces[0]!.resultDigest).toBe(RELATIVE_DAY_FINAL_BOUNCE_DIGEST);
    expect(finalBounces[1]!.resultDigest).toBe(RELATIVE_DAY_FINAL_BOUNCE_DIGEST_TAIL);
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
      { objective: "what is the capital of France?", manifest, clarifyAllowed: true, maxSteps: 6 },
      [],
      6
    );
    expect(question).toBe(
      [
        "User message (untrusted data):",
        "what is the capital of France?",
        "",
        "Available actions:",
        '- web_search: Search the live web; returns titles, URLs and content snippets (untrusted data). For time-scoped asks (今天/过去24小时/本周/most recent), ALWAYS set freshness_days so stale articles cannot masquerade as news; check each result\'s published date before calling anything recent. Input: {"query": "<focused search query>", "freshness_days": "<optional number: only results published in the last N days — 1 for a daily digest, 7 for a weekly>"}',
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

  it("R2: the tail B1 variants never instruct searching; only the time-tool variant names to_local_time", () => {
    // The base digest's search instruction is exactly what the tail mechanically bans — a tail
    // bounce must never point the planner at a move that would itself tail-bounce. Asserted via
    // the exported RELATIVE_DAY_SEARCH_INSTRUCTION fragment, never a wording literal (self-write
    // rule: a raw substring pin would freeze the digest wording forever). And the no-time-tool
    // variant (defensive: the B1 guard currently only arms with the tool in the manifest) must
    // never name the disarmed tool (the F1 failure class).
    expect(RELATIVE_DAY_FINAL_BOUNCE_DIGEST).toContain(RELATIVE_DAY_SEARCH_INSTRUCTION);
    for (const digest of [RELATIVE_DAY_FINAL_BOUNCE_DIGEST_TAIL, RELATIVE_DAY_FINAL_BOUNCE_DIGEST_TAIL_NO_TIME_TOOL]) {
      expect(digest).not.toContain(RELATIVE_DAY_SEARCH_INSTRUCTION);
    }
    expect(RELATIVE_DAY_FINAL_BOUNCE_DIGEST_TAIL).toContain("to_local_time");
    expect(RELATIVE_DAY_FINAL_BOUNCE_DIGEST_TAIL_NO_TIME_TOOL).not.toContain("to_local_time");
  });
});

describe("F1 (verifier 07-12): tail guidance never instructs a disarmed to_local_time", () => {
  // With the time tool absent from the manifest, the original notice/bounce digest told an
  // obedient planner to call to_local_time anyway — two unknown-tool denials exit via "denial"
  // instead of the honest step_cap fallback. The no-time-tool variants drop the convert clause.
  const NO_TIME_MANIFEST = manifestFor(["web_search", "llm_answer"]);

  it("renders the no-time-tool notice in the tail and never mentions to_local_time", () => {
    const question = buildLoopStepQuestion(
      { objective: "哪个频道转播世界杯？", manifest: NO_TIME_MANIFEST, clarifyAllowed: false, maxSteps: 6 },
      [],
      TAIL_RESERVE_STEPS
    );
    expect(question).toContain(BUDGET_TAIL_NOTICE_NO_TIME_TOOL);
    expect(question).not.toContain(BUDGET_TAIL_NOTICE);
    expect(question).not.toContain("to_local_time");
  });

  it("tail-bounces with the no-time-tool digest, still riding to step_cap (never denial)", async () => {
    // maxSteps 3 (R3): the first search executes above the tail; the next two bounce inside it.
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"q1"}}',
        '{"action":"web_search","input":{"query":"q2"}}',
        '{"action":"web_search","input":{"query":"q3"}}'
      ],
      async () => succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] })
    );
    const result = await runInnerLoop(loopInput({ manifest: NO_TIME_MANIFEST, maxSteps: 3 }), deps);
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
      { objective: "哪个频道转播世界杯？", manifest: MANIFEST, clarifyAllowed: false, maxSteps: 6 },
      [],
      TAIL_RESERVE_STEPS
    );
    expect(question).toContain(BUDGET_TAIL_NOTICE);
    expect(question).not.toContain(BUDGET_TAIL_NOTICE_NO_TIME_TOOL);
  });
});

/**
 * R3 (B9): the tail floor. Compiled contracts carry budgets as low as max_tool_calls 2 — before
 * the floor, such a run was whole-run-tail from step 1: the manifest it was compiled with was
 * never offered and every non-tail tool bounced without ever being callable. The tail only
 * arms when maxSteps > TAIL_RESERVE_STEPS, via ONE predicate shared by menu and enforcement.
 */
describe("R3: tail floor for tiny contracts (maxSteps ≤ TAIL_RESERVE_STEPS never arms the tail)", () => {
  it("maxSteps 2: the full manifest renders at every step, without the tail notice", () => {
    for (const remaining of [2, 1]) {
      const question = buildLoopStepQuestion(
        { objective: "x", manifest: MANIFEST, clarifyAllowed: true, maxSteps: TAIL_RESERVE_STEPS },
        [],
        remaining
      );
      expect(question).toContain("- web_search:");
      expect(question).toContain("- to_local_time:");
      expect(question).toContain("- llm_answer:");
      expect(question).not.toContain(BUDGET_TAIL_NOTICE);
      expect(question).not.toContain(BUDGET_TAIL_NOTICE_NO_TIME_TOOL);
    }
  });

  it("maxSteps 2: web_search executes on BOTH steps — no tail bounce anywhere in the run", async () => {
    const executed: string[] = [];
    const deps = scriptedDeps(
      ['{"action":"web_search","input":{"query":"q1"}}', '{"action":"web_search","input":{"query":"q2"}}'],
      async (capability) => {
        executed.push(capability);
        return succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] });
      }
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 2 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    expect(executed).toEqual(["web_search", "web_search"]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    for (const call of deps.composeCalls) {
      expect(call.question).toContain("- web_search:");
      expect(call.question).not.toContain(BUDGET_TAIL_NOTICE);
    }
  });

  it("maxSteps 3: the tail arms exactly at remaining ≤ TAIL_RESERVE_STEPS (the floor is not a blanket off-switch)", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"q1"}}',
        '{"action":"web_search","input":{"query":"q2"}}',
        '{"action":"web_search","input":{"query":"q3"}}'
      ],
      async () => succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] })
    );
    const result = await runInnerLoop(loopInput({ maxSteps: 3 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "step_cap" });
    // Step 1 (remaining 3): full menu, executes. Steps 2-3 (remaining 2, 1): tail — bounced.
    expect(deps.composeCalls[0]!.question).not.toContain(BUDGET_TAIL_NOTICE);
    expect(deps.composeCalls[1]!.question).toContain(BUDGET_TAIL_NOTICE);
    expect(deps.composeCalls[1]!.question).not.toContain("- web_search:");
    expect(result.steps.filter((s) => s.resultDigest === BUDGET_TAIL_BOUNCE_DIGEST)).toHaveLength(2);
  });
});

/**
 * R4 (B9, residual F2 from 07-12): an evolution-lane kickoff (self_diagnose / self_write_propose /
 * skill_author — the actions the wiring marks `terminalAfterSuccess`) charges exactly ONE step
 * and ENDS the run, so it cannot waste tail budget. Before the carve-out, a kickoff parsed at
 * charged step 13+ of 14 was tail-bounced before dispatch and silently lost.
 */
describe("R4: terminal-after-success kickoffs are exempt from the tail", () => {
  const EVOLUTION_MANIFEST = manifestFor(["web_search", "to_local_time", "llm_answer", "self_write_propose"], {
    HOUGE_TIME_TOOL_ENABLED: "1",
    HOUGE_SELFWRITE_ENABLED: "1"
  });
  const isKickoff = (action: string) => action === "self_write_propose";

  it("a kickoff at remaining 1 executes (not bounced) and terminates with the kickoff final", async () => {
    const executed: string[] = [];
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"q1"}}', // remaining 3: executes
        '{"action":"web_search","input":{"query":"q2"}}', // remaining 2: tail bounce (non-terminal)
        '{"action":"self_write_propose","input":{"focus":"fix the digest"}}' // remaining 1: kickoff
      ],
      async (capability) => {
        executed.push(capability);
        if (capability === "self_write_propose") return succeeded({ answer: "self-write pipeline started" });
        return succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] });
      }
    );
    const result = await runInnerLoop(
      loopInput({ manifest: EVOLUTION_MANIFEST, maxSteps: 3, terminalAfterSuccess: isKickoff }),
      deps
    );
    // The kickoff reached the deps seam INSIDE the tail and ended the run as a kickoff final.
    expect(executed).toEqual(["web_search", "self_write_propose"]);
    expect(result).toMatchObject({ outcome: "final", reason: "kickoff", answer: "self-write pipeline started" });
    // The non-terminal search still bounced — the carve-out admits ONLY terminal actions.
    expect(result.steps.filter((s) => s.resultDigest === BUDGET_TAIL_BOUNCE_DIGEST)).toHaveLength(1);
  });

  it("the tail menu offers the kickoff (menu and enforcement share tailAllowsAction)", () => {
    const question = buildLoopStepQuestion(
      {
        objective: "x",
        manifest: EVOLUTION_MANIFEST,
        clarifyAllowed: true,
        maxSteps: 6,
        terminalAfterSuccess: isKickoff
      },
      [],
      TAIL_RESERVE_STEPS
    );
    expect(question).toContain("- self_write_propose:");
    expect(question).toContain("- to_local_time:");
    expect(question).toContain("- llm_answer:");
    expect(question).not.toContain("- web_search:");
  });

  it("a kickoff that FAILS at dispatch in the tail stays bounded — honest denial exit, never a livelock (verifier B9)", async () => {
    // R4 admits the kickoff through the tail on the promise it "charges 1 and ends the run" —
    // but that only holds when dispatch SUCCEEDS. A failing kickoff must ride the ordinary
    // failure counter (FAILURE_CAP) to the honest denial fallback, with iterations bounded.
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"q1"}}', // remaining 4: executes
        '{"action":"web_search","input":{"query":"q2"}}', // remaining 3: executes
        '{"action":"self_write_propose","input":{"focus":"a"}}', // remaining 2 (tail): dispatched, FAILS
        '{"action":"self_write_propose","input":{"focus":"b"}}' // remaining 1 (tail): dispatched, FAILS → denial
      ],
      async (capability) => {
        if (capability === "self_write_propose") return { status: "denied", reason: "lane busy" } as CapabilityResult;
        return succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] });
      }
    );
    const result = await runInnerLoop(
      loopInput({ manifest: EVOLUTION_MANIFEST, maxSteps: 4, terminalAfterSuccess: isKickoff }),
      deps
    );
    expect(result).toMatchObject({ outcome: "final", reason: "denial" });
    // Both kickoff attempts reached dispatch (the tail admitted them) and were recorded as
    // failures — never as tail bounces: the carve-out and the failure path stay distinct.
    const kickoffSteps = result.steps.filter((s) => s.action === "self_write_propose");
    expect(kickoffSteps).toHaveLength(2);
    expect(kickoffSteps.every((s) => !s.ok && s.resultDigest !== BUDGET_TAIL_BOUNCE_DIGEST)).toBe(true);
    expect(deps.composeCalls.length).toBeLessThanOrEqual(4 + PROTOCOL_RETRY_ALLOWANCE);
  });

  it("without the terminalAfterSuccess marker the same action still tail-bounces (no blanket evolution pass)", async () => {
    const deps = scriptedDeps(
      [
        '{"action":"web_search","input":{"query":"q1"}}',
        '{"action":"self_write_propose","input":{"focus":"fix the digest"}}',
        '{"action":"final","answer":"done"}'
      ],
      async () => succeeded({ results: [{ title: "T", url: "https://t.test", content: "c" }] })
    );
    const result = await runInnerLoop(loopInput({ manifest: EVOLUTION_MANIFEST, maxSteps: 3 }), deps);
    expect(result).toMatchObject({ outcome: "final", reason: "final", answer: "done" });
    const bounce = result.steps.find((s) => s.action === "self_write_propose");
    expect(bounce?.ok).toBe(false);
    expect(bounce?.resultDigest).toBe(BUDGET_TAIL_BOUNCE_DIGEST);
  });
});
