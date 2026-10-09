import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeInput, ProbeResult } from "../../src/omp/omp-contract-probe.js";
import { createOmpProbeRunner, OMP_CONTRACT_DRIFT, pickProbeModel, settleProbe } from "../../src/omp/omp-probe-runner.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import type { ModelString } from "../../src/omp/model-string.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §5: a drift pages ONCE and every spawn continues; a pass clears drift; an old binary's late answer must not touch
// the incident for the new one; inconclusive retries next boot; the probe never runs twice at once and never on a turn's path.
const NOW = "2026-10-09T00:00:00.000Z";
const TINY: ModelString = { provider: "kimi-code", model: "k3", effort: "low" };
const FAST: ModelString = { provider: "zai", model: "glm", effort: "low" };

const result = (version: string, r: ProbeResult["result"]): ProbeResult => ({
  version, result: r, model: "kimi-code/k3:low",
  checks: { catalog: "pass", start_refusal: r === "fail" ? "fail:unclassified" : "pass", session_open: "pass", pin_refusal: "pass",
    effort: "pass", new_session: "pass", prompt: r === "inconclusive" ? "inconclusive:timeout" : "pass" },
  usage: null, started_at: NOW, finished_at: NOW
});

let store: RunStore; let ctl: AbortController; let calls: ProbeInput[];
beforeEach(() => { store = RunStore.openInMemory(); ctl = new AbortController(); calls = []; vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", "42"); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
const notes = () => {
  const out: Array<Record<string, unknown>> = [];
  for (let n = store.claimNextNotification(`t${out.length}`, 30); n; n = store.claimNextNotification(`t${out.length}`, 30)) out.push(n.payload);
  return out;
};
const probeRows = () => store.getLedgerEvents().filter((e) => e.event_type === "omp_contract_probe").length;
const drift = () => store.listOpenIncidents().filter((i) => i.kind === OMP_CONTRACT_DRIFT);
const roles = (tiny: ModelString[] = [TINY], fast: ModelString[] = [FAST]) =>
  ({ candidates: (role: string) => (role === "tiny" ? tiny : role === "fast" ? fast : []) });

function runner(answer: (v: string) => Promise<ProbeResult>, current: string | null = "18.7.0") {
  return createOmpProbeRunner({
    store, cfg: resolveOmpConfig({}), ctx: { home: "/h", repo: "/r", data: "/d" }, roles: roles(),
    currentVersion: () => current, signal: ctl.signal, now: () => NOW,
    probe: (i) => { calls.push(i); return answer(i.version); }
  });
}
const answering = (r: ProbeResult["result"]) => (v: string) => Promise.resolve(result(v, r));

describe("omp probe runner", () => {
  it("a drift on the current version pages once; a second fail opens nothing new", async () => {
    runner(answering("fail")).maybeProbe("18.7.0");
    await flush();
    expect(drift().map((i) => [i.subject, JSON.parse(i.detail_json)])).toEqual([
      ["omp:18.7.0", { version: "18.7.0", failed: { start_refusal: "fail:unclassified" } }]
    ]);
    expect(notes()).toHaveLength(1);
    runner(answering("fail")).maybeProbe("18.7.0");
    await flush();
    expect(calls).toHaveLength(2);
    expect(drift()).toHaveLength(1);
    expect(notes()).toHaveLength(0);
  });

  it("a pass on the current version clears an open drift and records the row", async () => {
    settleProbe(store, result("18.7.0", "fail"), "18.7.0", NOW);
    runner(answering("pass")).maybeProbe("18.7.0");
    await flush();
    expect(drift()).toHaveLength(0);
    expect(store.latestOmpProbe("18.7.0", { result: "pass" })).toBeDefined();
  });

  it("a late fail for a binary no longer current records its row but opens no incident", async () => {
    runner(answering("fail"), "18.8.0").maybeProbe("18.7.0");
    await flush();
    expect(probeRows()).toBe(1);
    expect(drift()).toHaveLength(0);
  });

  it("inconclusive records a row, pages nothing, and the next boot probes the version again", async () => {
    runner(answering("inconclusive")).maybeProbe("18.7.0");
    await flush();
    expect(probeRows()).toBe(1);
    expect(store.listOpenIncidents()).toHaveLength(0);
    runner(answering("inconclusive")).maybeProbe("18.7.0");
    await flush();
    expect(calls.map((c) => c.version)).toEqual(["18.7.0", "18.7.0"]);
  });

  it("a version with a pass row is never probed again (no prompt spent per boot)", async () => {
    store.recordOmpProbe(result("18.7.0", "pass"));
    runner(answering("pass")).maybeProbe("18.7.0");
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("a version with only a fail row is probed again (a Houge-side fix can clear it)", async () => {
    store.recordOmpProbe(result("18.7.0", "fail"));
    runner(answering("pass")).maybeProbe("18.7.0");
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("one probe at a time, and the latest version queued while it runs wins", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const r = runner(async (v) => { if (v === "18.7.0") await held; return result(v, "pass"); });
    r.maybeProbe("18.7.0");
    r.maybeProbe("18.8.0");
    r.maybeProbe("18.9.0");
    await flush();
    expect(calls).toHaveLength(1);
    release();
    await flush();
    expect(calls.map((c) => c.version)).toEqual(["18.7.0", "18.9.0"]);
  });

  // The cache listener fires inside a turn's version check: the probe's synchronous setup (mkdir, config writes, spawn)
  // must never run on that caller's stack.
  it("maybeProbe returns before the probe starts; the probe starts on the next tick", async () => {
    runner(answering("pass")).maybeProbe("18.7.0");
    expect(calls).toHaveLength(0);
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
  });

  it("one attempt per version per process", async () => {
    const r = runner(answering("inconclusive"));
    r.maybeProbe("18.7.0");
    await flush();
    r.maybeProbe("18.7.0");
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("a probe the stop signal cut records nothing, even when it reports pass, and nothing runs after", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const r = runner(async (v) => { await held; return result(v, "pass"); });
    r.maybeProbe("18.7.0");
    await flush();
    ctl.abort();
    release();
    await flush();
    expect(probeRows()).toBe(0);
    expect(store.listOpenIncidents()).toHaveLength(0);
    r.maybeProbe("18.8.0");
    await flush();
    expect(calls).toHaveLength(1);
  });

  const boom = () => Object.assign(new Error("omp said /secret/path"), { code: "EACCES" });
  it.each([
    ["rejects", () => Promise.reject(boom())],
    ["throws synchronously (a setup throw)", (): Promise<ProbeResult> => { throw boom(); }]
  ])("a probe that %s logs a fixed code only, records nothing, and maybeProbe does not throw", async (_n, answer) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = runner(answer);
    expect(() => r.maybeProbe("18.7.0")).not.toThrow();
    await flush();
    expect(err).toHaveBeenCalledWith("[omp-probe] failed: EACCES");
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret");
    expect(probeRows()).toBe(0);
  });

  it("pickProbeModel takes Tiny's head at low effort, else Fast's, else none", () => {
    const seen: unknown[] = [];
    const spy = (tiny: ModelString[], fast: ModelString[]) =>
      ({ candidates: (role: string, o?: unknown) => { seen.push([role, o]); return role === "tiny" ? tiny : fast; } });
    expect(pickProbeModel(spy([TINY], [FAST]) as never)).toEqual(TINY);
    expect(seen[0]).toEqual(["tiny", { effort: "low" }]);
    expect(pickProbeModel(spy([], [FAST]) as never)).toEqual(FAST);
    expect(pickProbeModel(spy([], []) as never)).toBeNull();
  });

  it("the row and the incident commit together: a failed page rolls the row back", () => {
    vi.spyOn(store, "openIncident").mockImplementation(() => { throw new Error("boom"); });
    expect(() => settleProbe(store, result("18.7.0", "fail"), "18.7.0", NOW)).toThrow("boom");
    expect(probeRows()).toBe(0);
  });
});
