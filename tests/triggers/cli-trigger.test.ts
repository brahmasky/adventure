import { describe, expect, it } from "vitest";
import { parseCliTrigger } from "../../src/triggers/cli-trigger.js";

describe("parseCliTrigger", () => {
  it("normalizes local run commands into TypedTaskEvent", () => {
    const result = parseCliTrigger(["run", "research-brief", "compare gateway designs"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("run");
      expect(result.event.program).toBe("research-brief");
      expect(result.event.source).toBe("cli");
    }
  });

  it("uses explicit run flags instead of folding them into the goal", () => {
    const result = parseCliTrigger([
      "run",
      "research-brief",
      "--objective",
      "Review local run engine smoke path",
      "--source",
      "local",
      "--idempotency-key",
      "review-smoke",
      "--payload",
      "{\"topic\":\"local run smoke\"}"
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.goal).toBe("Review local run engine smoke path");
      expect(result.event.idempotency_key).toBe("review-smoke");
      expect(result.event.source).toBe("cli");
      expect(result.event.source_reference).toContain("source:local");
    }
  });

  it("rejects malformed JSON payload flags", () => {
    const result = parseCliTrigger([
      "run",
      "research-brief",
      "--objective",
      "Review local run engine smoke path",
      "--payload",
      "{"
    ]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CLI_TRIGGER_INVALID",
        message: "Payload must be valid JSON"
      }
    });
  });

  it("rejects unknown run flags", () => {
    const result = parseCliTrigger(["run", "research-brief", "--unknown", "value"]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CLI_TRIGGER_INVALID",
        message: "Unknown option: --unknown"
      }
    });
  });

  it("rejects unsupported commands", () => {
    const result = parseCliTrigger(["status"]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CLI_TRIGGER_INVALID",
        message: "Unsupported CLI command: status"
      }
    });
  });

  it("rejects missing program", () => {
    const result = parseCliTrigger(["run"]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CLI_TRIGGER_INVALID",
        message: "Program is required"
      }
    });
  });

  it("rejects missing goal", () => {
    const result = parseCliTrigger(["run", "research-brief"]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CLI_TRIGGER_INVALID",
        message: "Goal is required"
      }
    });
  });
});
