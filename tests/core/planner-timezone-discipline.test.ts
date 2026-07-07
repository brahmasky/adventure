import { describe, expect, it } from "vitest";
import { digestOutput } from "../../src/core/inner-loop.js";
import { manifestFor, renderManifestLines } from "../../src/core/tool-manifest.js";
import { LOOP_DISCIPLINE } from "../../src/prompt/composer.js";

describe("planner timezone discipline", () => {
  it("requires relative-day event filtering to come from to_local_time", () => {
    expect(LOOP_DISCIPLINE).toContain("filter solely by the relative_day returned by to_local_time");
    expect(LOOP_DISCIPLINE).toContain("do not filter by the source date");
  });

  it("tells the planner to reject missing source timezone markers instead of guessing", () => {
    const [line] = renderManifestLines(manifestFor(["to_local_time"], { HOUGE_TIME_TOOL_ENABLED: "1" }));

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
