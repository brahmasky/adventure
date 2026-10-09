import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let lines: string[]; let probed: string[]; let cwd: string; let opens: number;
// A project root: the CLI refuses to run anywhere without a houge.sqlite (it would create a stray DB there).
beforeEach(() => { lines = []; probed = []; opens = 0; cwd = mkdtempSync(join(tmpdir(), "probe-cli-")); writeFileSync(join(cwd, "houge.sqlite"), ""); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
const openStore = () => { opens += 1; return RunStore.openInMemory(); };

const run = (r: ProbeResult["result"] | null) => runOmpProbeCli({
  openStore, env: process.env, cwd, out: (l) => { lines.push(l); },
  runner: () => ({ probeNow: async (v) => { probed.push(v); return result(r ?? "pass"); } }),
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
      openStore, env: process.env, cwd, out: (l) => { lines.push(l); },
      runner: () => ({ probeNow: () => Promise.reject(Object.assign(new Error("omp said /secret/path"), { code: "EACCES" })) }),
      versionCheck: async () => ({ ok: true, version: "18.7.0" })
    });
    expect(code).toBe(3);
    expect(lines).toEqual(["omp probe failed: EACCES"]);
  });

  // Opening the store would create an empty houge.sqlite wherever the CLI was run, and record the probe into it.
  it("outside a project root it refuses before opening any store, exit 3", async () => {
    rmSync(join(cwd, "houge.sqlite"));
    expect(await run("pass")).toBe(3);
    expect(lines).toEqual(["run from the Houge project root (no houge.sqlite here)"]);
    expect(opens).toBe(0);
    expect(probed).toEqual([]);
  });

  // Ctrl-C must stop the probe's omp children and remove its dirs (the runner's stop signal), not orphan them; and an
  // interrupted probe is no verdict, so it exits 2 and never reads as pass or drift.
  it("SIGINT aborts the runner's stop signal and exits 2 interrupted", async () => {
    const ac = new AbortController();
    let runnerSignal: AbortSignal | undefined;
    const code = runOmpProbeCli({
      openStore, env: process.env, cwd, out: (l) => { lines.push(l); }, signal: ac.signal,
      runner: (signal) => { runnerSignal = signal; return { probeNow: () => new Promise<ProbeResult>((_res, rej) => {
        signal.addEventListener("abort", () => rej(new Error("probe_aborted")), { once: true });
      }) }; },
      versionCheck: async () => ({ ok: true, version: "18.7.0" })
    });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    expect(await code).toBe(2);
    expect(runnerSignal?.aborted).toBe(true);
    expect(lines).toEqual(["omp probe interrupted"]);
  });
});
