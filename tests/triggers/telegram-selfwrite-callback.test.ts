import { describe, expect, it } from "vitest";
import { parseSelfWriteCallback } from "../../src/triggers/telegram-command-parser.js";

describe("parseSelfWriteCallback", () => {
  it("parses valid selfwrite:<action>:<run-id> for each action", () => {
    expect(parseSelfWriteCallback("selfwrite:merge:run_x")).toEqual({ action: "merge", runId: "run_x" });
    expect(parseSelfWriteCallback("selfwrite:view:run_42")).toEqual({ action: "view", runId: "run_42" });
    expect(parseSelfWriteCallback("selfwrite:discard:run_42")).toEqual({ action: "discard", runId: "run_42" });
  });

  it("returns null on garbage / wrong prefix / unknown action / missing run id", () => {
    expect(parseSelfWriteCallback("garbage")).toBeNull();
    expect(parseSelfWriteCallback("")).toBeNull();
    expect(parseSelfWriteCallback("approve:appr_1")).toBeNull(); // a normal command, not a callback
    expect(parseSelfWriteCallback("other:merge:run_x")).toBeNull(); // wrong prefix
    expect(parseSelfWriteCallback("selfwrite:explode:run_x")).toBeNull(); // unknown action
    expect(parseSelfWriteCallback("selfwrite:merge")).toBeNull(); // missing run id
    expect(parseSelfWriteCallback("selfwrite:merge:")).toBeNull(); // empty run id
    expect(parseSelfWriteCallback("selfwrite:merge:run_x:extra")).toBeNull(); // extra segment
    expect(parseSelfWriteCallback(undefined)).toBeNull();
    expect(parseSelfWriteCallback(123)).toBeNull();
  });
});
