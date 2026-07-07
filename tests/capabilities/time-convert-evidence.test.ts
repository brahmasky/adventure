import { describe, expect, it } from "vitest";
import type { CapabilityResult } from "../../src/capabilities/capability-runner.js";
import {
  createTimeConvertAdapter,
  resolveTzEvidenceEnabled,
  TIME_CONVERT_PRIOR_DIGESTS_FIELD,
  ZONE_EVIDENCE_ERROR
} from "../../src/capabilities/time-convert.js";
import { buildLoopStepQuestion, runInnerLoop } from "../../src/core/inner-loop.js";
import type { InnerLoopDeps, InnerLoopInput } from "../../src/core/inner-loop.js";
import { manifestFor } from "../../src/core/tool-manifest.js";

const NOW = new Date("2026-07-06T05:00:00Z"); // 2026-07-06 15:00 Australia/Sydney
const CONFIG = { now: NOW, localTz: "Australia/Sydney" };
const ET = "America/New_York";
const SOURCE_FRAGMENT = "Portugal vs Spain — Mon Jul 6, 2026 2:00 PM ET";

function succeeded(output: Record<string, unknown>): CapabilityResult {
  return { status: "succeeded", output_ref: "inline:test", output_hash: "h", output };
}

function loopInput(overrides: Partial<InnerLoopInput> = {}): InnerLoopInput {
  return {
    objective: "convert the fixture time",
    system: "SYSTEM PROMPT",
    manifest: [],
    maxSteps: 4,
    clarifyAllowed: true,
    ...overrides
  };
}

describe("resolveTzEvidenceEnabled (default OFF; explicit truthy arms it)", () => {
  it("defaults OFF and accepts the same truthy spellings as Dual-LLM", () => {
    expect(resolveTzEvidenceEnabled({})).toBe(false);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "1" })).toBe(true);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "true" })).toBe(true);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "yes" })).toBe(true);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "on" })).toBe(true);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "0" })).toBe(false);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "off" })).toBe(false);
  });
});

describe("createTimeConvertAdapter zone_evidence gate", () => {
  it("OFF preserves legacy conversion without zone_evidence", async () => {
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: false });
    const result = await adapter({ items: [{ when: "2026-07-06 14:00", tz: ET }] });
    expect(result).toEqual({
      ok: true,
      output: {
        results: [{ when: "2026-07-06 14:00", tz: ET, local: "2026-07-07 04:00", relative_day: "tomorrow" }]
      }
    });
  });

  it("ON accepts evidence whose timezone label appears in a prior step digest", async () => {
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: true });
    const result = await adapter({
      items: [{ when: "2026-07-06 14:00", tz: ET, zone_evidence: SOURCE_FRAGMENT }],
      [TIME_CONVERT_PRIOR_DIGESTS_FIELD]: [`Schedule digest: ${SOURCE_FRAGMENT}`]
    });
    expect(result).toEqual({
      ok: true,
      output: {
        results: [{ when: "2026-07-06 14:00", tz: ET, local: "2026-07-07 04:00", relative_day: "tomorrow" }]
      }
    });
  });

  it("ON rejects forged evidence that is not present in previous digests", async () => {
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: true });
    const result = await adapter({
      items: [{ when: "2026-07-06 14:00", tz: ET, zone_evidence: SOURCE_FRAGMENT }],
      [TIME_CONVERT_PRIOR_DIGESTS_FIELD]: ["Schedule digest: no matching fragment here"]
    });
    expect(result).toEqual({
      ok: true,
      output: {
        results: [{ when: "2026-07-06 14:00", tz: ET, error: ZONE_EVIDENCE_ERROR }]
      }
    });
  });

  it("ON rejects evidence that does not state the timezone label", async () => {
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: true });
    const fragment = "Portugal vs Spain — Mon Jul 6, 2026 2:00 PM";
    const result = await adapter({
      items: [{ when: "2026-07-06 14:00", tz: ET, zone_evidence: fragment }],
      [TIME_CONVERT_PRIOR_DIGESTS_FIELD]: [`Schedule digest: ${fragment}`]
    });
    expect(result).toEqual({
      ok: true,
      output: {
        results: [{ when: "2026-07-06 14:00", tz: ET, error: ZONE_EVIDENCE_ERROR }]
      }
    });
  });
});

describe("runInnerLoop to_local_time evidence wiring", () => {
  it("OFF keeps the model contract and loop execution on the legacy {when,tz} shape", () => {
    const manifest = manifestFor(["to_local_time"], { HOUGE_TIME_TOOL_ENABLED: "1" });
    const question = buildLoopStepQuestion(loopInput({ manifest }), [], 1);
    expect(question).toContain('"tz":"America/New_York"');
    expect(question).not.toContain("zone_evidence");
  });

  it("ON exposes zone_evidence in the model contract", () => {
    const manifest = manifestFor(["to_local_time"], {
      HOUGE_TIME_TOOL_ENABLED: "1",
      HOUGE_TZ_EVIDENCE_ENABLED: "1"
    });
    const question = buildLoopStepQuestion(loopInput({ manifest }), [], 1);
    expect(question).toContain("zone_evidence");
  });

  it("ON injects previous step digests into to_local_time without changing recorded step input", async () => {
    const manifest = manifestFor(["web_search", "to_local_time"], {
      HOUGE_TIME_TOOL_ENABLED: "1",
      HOUGE_TZ_EVIDENCE_ENABLED: "1"
    });
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: true });
    const executed: Array<{ capability: string; input: Record<string, unknown> }> = [];
    const composeQuestions: string[] = [];
    const script = [
      '{"action":"web_search","input":{"query":"world cup schedule"},"why":"find source"}',
      `{"action":"to_local_time","input":{"items":[{"when":"2026-07-06 14:00","tz":"${ET}","zone_evidence":"${SOURCE_FRAGMENT}"}]},"why":"convert stated time"}`,
      '{"action":"final","answer":"done"}'
    ];
    let i = 0;
    const deps: InnerLoopDeps = {
      compose: async (input) => {
        composeQuestions.push(input.question);
        const text = script[i]!;
        i += 1;
        return { ok: true, text };
      },
      executeAction: async (capability, input) => {
        executed.push({ capability, input });
        if (capability === "web_search") {
          return succeeded({ results: [{ title: "Schedule", url: "https://example.test", content: SOURCE_FRAGMENT }] });
        }
        const result = await adapter(input);
        return result.ok ? succeeded(result.output) : { status: "failed", error_ref: result.error };
      }
    };

    const result = await runInnerLoop(loopInput({ manifest }), deps);

    expect(result.outcome).toBe("final");
    expect(composeQuestions[0]).toContain("zone_evidence");
    expect(executed[1]!.input[TIME_CONVERT_PRIOR_DIGESTS_FIELD]).toEqual([
      expect.stringContaining(SOURCE_FRAGMENT)
    ]);
    expect(result.steps[1]!.input).toEqual({
      items: [{ when: "2026-07-06 14:00", tz: ET, zone_evidence: SOURCE_FRAGMENT }]
    });
    expect(result.steps[1]!.resultDigest).toContain("2026-07-07 04:00 (tomorrow)");
  });
});
