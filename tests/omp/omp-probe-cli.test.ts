import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProbeResult } from "../../src/omp/omp-contract-probe.js";
import { runOmpProbeCli } from "../../src/omp/omp-probe-cli.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinOmpEnv } from "../helpers/omp-env.js";

// Spec §5 Manual: `houge omp probe` is how Paco checks an omp upgrade by hand. Its exit code must tell pass, drift,
// inconclusive and "omp not even runnable" apart (scripts branch on it), and an unrunnable omp must not spend a probe.
pinOmpEnv();

const NOW = "2026-10-09T00:00:00.000Z";
const result = (r: ProbeResult["result"]): ProbeResult => ({
  version: "18.7.0", result: r, model: "kimi-code/k3:low",
  checks: { catalog: "pass", start_refusal: r === "fail" ? "fail:unclassified" : "pass", session_open: "pass", pin_refusal: "pass",
    effort: "pass", new_session: "pass", prompt: r === "inconclusive" ? "inconclusive:timeout" : "pass" },
  usage: null, started_at: NOW, finished_at: NOW
});

let store: RunStore; let lines: string[]; let probed: string[];
beforeEach(() => { store = RunStore.openInMemory(); lines = []; probed = []; });
afterEach(() => { store.close(); });

const run = (r: ProbeResult["result"] | null) => runOmpProbeCli({
  store, env: process.env, cwd: "/nonexistent/houge-tests/repo", out: (l) => { lines.push(l); },
  runner: { probeNow: async (v) => { probed.push(v); return result(r ?? "pass"); } },
  versionCheck: async () => (r === null
    ? { ok: false, kind: "not_runnable", version: null, reason: "omp not runnable: ENOENT" }
    : { ok: true, version: "18.7.0" })
});

describe("houge omp probe", () => {
  it("pass exits 0 and prints every check and the summary", async () => {
    expect(await run("pass")).toBe(0);
    expect(probed).toEqual(["18.7.0"]);
    expect(lines).toEqual([
      "  catalog         pass", "  start_refusal   pass", "  session_open    pass", "  pin_refusal     pass",
      "  effort          pass", "  new_session     pass", "  prompt          pass",
      "omp 18.7.0: pass (model kimi-code/k3:low)"
    ]);
  });

  it("fail exits 1 and names the failed check", async () => {
    expect(await run("fail")).toBe(1);
    expect(lines).toContain("  start_refusal   fail:unclassified");
    expect(lines.at(-1)).toBe("omp 18.7.0: fail (model kimi-code/k3:low)");
  });

  it("inconclusive exits 2", async () => {
    expect(await run("inconclusive")).toBe(2);
  });

  it("an unrunnable omp exits 3 with its reason and never probes", async () => {
    expect(await run(null)).toBe(3);
    expect(lines).toEqual(["omp unavailable: omp not runnable: ENOENT"]);
    expect(probed).toEqual([]);
  });

  // An unexpected throw must not read as drift (exit 1): it is "could not probe", and omp's text never reaches the terminal.
  it("a probe that throws exits 3 with its code only", async () => {
    const code = await runOmpProbeCli({
      store, env: process.env, cwd: "/nonexistent/houge-tests/repo", out: (l) => { lines.push(l); },
      runner: { probeNow: () => Promise.reject(Object.assign(new Error("omp said /secret/path"), { code: "EACCES" })) },
      versionCheck: async () => ({ ok: true, version: "18.7.0" })
    });
    expect(code).toBe(3);
    expect(lines).toEqual(["omp probe failed: EACCES"]);
  });
});
