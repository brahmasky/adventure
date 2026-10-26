import { TOOL_SHELL_CLASS } from "../../src/decisions/entries/tool-shell-class.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("tool.shell_class entry", () => {
  it("classifies a plain command as plain", () => {
    const r = decideSync(TOOL_SHELL_CLASS, { command: "ls -la" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("plain");
  });
  it("classifies an HTTP write as external_write", () => {
    const r = decideSync(TOOL_SHELL_CLASS, { command: "curl -X POST https://x" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("external_write");
  });
  it("classifies rm -rf as destructive", () => {
    const r = decideSync(TOOL_SHELL_CLASS, { command: "rm -rf /" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("destructive");
  });
});
