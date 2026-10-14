import { describe, expect, it } from "vitest";
import { checkSelfWriteDiff, parseDiffRaw } from "../../src/capabilities/self-write-guard.js";

// Senior W13: tool.injection's answers flow through src/jev/decide.ts (the re-ask) and src/jev/jev-client.ts (validation).
// A self-write there could zero every injection answer and so remove every hostile tap: both are Paco's hand from stage 2a.
describe("self-write guard — the injection path", () => {
  it("hard-denies a self-write touching src/jev/decide.ts or src/jev/jev-client.ts", () => {
    for (const f of ["src/jev/decide.ts", "src/jev/jev-client.ts"]) expect(checkSelfWriteDiff(parseDiffRaw(`:100644 100644 7898192 422c2b7 M\t${f}`)).allowed).toBe(false);
    expect(checkSelfWriteDiff(parseDiffRaw(":100644 100644 7898192 422c2b7 M\tsrc/jev/triage-report.ts")).allowed).toBe(true);
  });
});
