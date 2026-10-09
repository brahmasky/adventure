import { describe, expect, it } from "vitest";
import type { ProbeResult } from "../../src/omp/omp-contract-probe.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §5: the probe row is the record that a version is known-good; the skip rule reads only a PASS for that exact version.
// A wrong read here either re-probes on every boot (spending a prompt) or skips a version that never passed.
const result = (version: string, r: ProbeResult["result"]): ProbeResult => ({
  version, result: r, model: "kimi-code/k3:low",
  checks: { catalog: "pass", start_refusal: r === "fail" ? "fail:unclassified" : "pass", session_open: "pass", pin_refusal: "pass",
    effort: "pass", new_session: "pass", prompt: r === "inconclusive" ? "inconclusive:timeout" : "pass" },
  usage: null, started_at: "2026-10-09T00:00:00.000Z", finished_at: "2026-10-09T00:00:05.000Z"
});

describe("RunStore — omp contract probe rows", () => {
  it("records and reads back the latest probe per version and result", () => {
    const store = RunStore.openInMemory();
    try {
      store.recordOmpProbe(result("18.7.0", "fail"));
      store.recordOmpProbe(result("18.7.0", "pass"));
      store.recordOmpProbe(result("18.8.0", "inconclusive"));
      expect(store.latestOmpProbe("18.7.0")?.result).toBe("pass");
      expect(store.latestOmpProbe("18.7.0", { result: "fail" })?.result).toBe("fail");
      expect(store.latestOmpProbe("18.7.0", { result: "fail" })?.checks.start_refusal).toBe("fail:unclassified");
      expect(store.latestOmpProbe("18.8.0", { result: "pass" })).toBeUndefined();
      expect(store.latestOmpProbe("18.9.0")).toBeUndefined();
    } finally { store.close(); }
  });
});
