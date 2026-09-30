import { describe, expect, it } from "vitest";
import { digestOutput } from "../../src/core/output-digest.js";
import { loadToolDeclarations, TOOL_DECLS_DIR } from "../../src/omp/tool-decls.js";
import { LOOP_TIME_PRESENTATION_RULE, OMP_LOOP_DISCIPLINE, READER_DISCIPLINE } from "../../src/prompt/composer.js";

describe("planner timezone discipline", () => {
  it("requires relative-day event filtering to come from to_local_time (the omp planner's discipline)", () => {
    expect(OMP_LOOP_DISCIPLINE).toContain("convert explicitly-zoned times with to_local_time and filter by its relative_day");
  });

  it("R5: the timezone block carries the lead-with-local-zone presentation rule (via the exported constant)", () => {
    // Asserted through the constant, never a pinned literal — a future self-write may reword
    // the rule; this test only pins that the planner's discipline actually carries it.
    expect(OMP_LOOP_DISCIPLINE).toContain(LOOP_TIME_PRESENTATION_RULE);
  });

  it("forbids the reader from making relative-day judgments (frame poisoning, 07-07)", () => {
    expect(READER_DISCIPLINE).toContain("NEVER evaluate whether an event is 'today', 'tomorrow', 明天");
    expect(READER_DISCIPLINE).toContain("timezone conversion you cannot perform");
    expect(READER_DISCIPLINE).toContain('never conclude "no matches tomorrow", "rest day"');
  });

  it("tells the planner to reject missing source timezone markers instead of guessing (the to_local_time declaration)", () => {
    const decls = loadToolDeclarations(TOOL_DECLS_DIR);
    if (!decls.ok) throw new Error(decls.error);
    const line = decls.decls.find((d) => d.name === "to_local_time")?.description ?? "";

    expect(line).toContain("If the source does not explicitly state a timezone marker");
    expect(line).toContain("search for another source that does");
    expect(line).toContain("returned relative_day");
  });

  it("keeps the relative_day filter rule next to converted time results", () => {
    const digest = digestOutput(
      {
        results: [
          {
            when: "2026-07-06 20:00",
            tz: "America/New_York",
            local: "2026-07-07 10:00",
            relative_day: "tomorrow"
          }
        ]
      },
      1_000
    );

    expect(digest).toContain("Use only each row's relative_day");
    expect(digest).toContain("2026-07-07 10:00 (tomorrow)");
  });
});
