import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunStore } from "../../src/run/run-store.js";
import { cat, LIGHT, treeSays, triageHarness } from "../helpers/triage-harness.js";

// Plan ruling 19 through the ladder: where a throw lands decides what Paco's turn persists. A throw before today's
// `held.answered` (calibrationRows, arming, routeTree) settles skipped `error` and drops Jev's rows; a throw in urlRule
// (after it) keeps Jev's rows as an answered `fallback`. Either way the throw is logged with its message (AGENTS.md: no
// silent failure). The frozen pin snapshots only the routeTree throw; these hold the other two exits and the log line.
// Its own file because vi.mock replaces the modules for the whole file.
const fault = vi.hoisted(() => ({ policy: false, url: false, calibration: false }));
vi.mock("../../src/jev/tree-policy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/jev/tree-policy.js")>();
  return {
    ...real,
    routeTree: (...a: Parameters<typeof real.routeTree>) => {
      if (fault.policy) { fault.policy = false; throw new Error("policy fault test"); }
      // urlRule's own call: the policy again with the lookup lane unarmed
      if (fault.url && a[1].armed.lookup === false) { fault.url = false; throw new Error("url fault test"); }
      return real.routeTree(...a);
    }
  };
});
vi.mock("../../src/jev/calibration.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/jev/calibration.js")>();
  return {
    ...real,
    calibrationRows: (...a: Parameters<typeof real.calibrationRows>) => {
      if (fault.calibration) { fault.calibration = false; throw new Error("calibration fault test"); }
      return real.calibrationRows(...a);
    }
  };
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); Object.assign(fault, { policy: false, url: false, calibration: false }); });

const handlerRows = (store: RunStore, run_id: string) => store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "turn.handler");
const triageEvents = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "triage").map((e) => e.payload as Record<string, unknown>);
const logged = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

describe("turn.handler: a throw after Jev answered, through the ladder", () => {
  it("an arming/routeTree throw logs today's line with its message and settles skipped error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = triageHarness(treeSays());
    const t = h.turn("帮我整理一下这周的待办");
    fault.policy = true;
    const out = await h.worker.triageTurn(t.input);
    expect(fault.policy).toBe(false); // the fault fired
    expect(logged(err)).toContain("triage: threw: policy fault test");
    expect(out).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ skip_reason: "error", route_outcome: "fallback" });
    expect(h.store.listJevDecisions(t.run_id).map((r) => [r.status, r.skip_reason, r.question_id])).toEqual([["skipped", "error", null]]); // Jev's answered rows dropped: only the skipped row
    h.store.close();
  });

  it("a urlRule throw: answered fallback, Jev's rows kept (decision fallback) and linked, the message logged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = triageHarness(treeSays({ category: cat({ lookup: 0.9 }), actions: LIGHT }));
    const t = h.turn("帮我看看 https://weather.example/sydney 说了什么");
    fault.url = true;
    const out = await h.worker.triageTurn(t.input);
    expect(fault.url).toBe(false);
    expect(logged(err)).toContain("triage: threw: url fault test");
    expect(out).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    const v = h.store.getJevVerdictForRun(t.run_id)!;
    expect(v).toMatchObject({ lane: "planner", reason: "jev_skipped", route_outcome: "fallback", skip_reason: null });
    const jd = h.store.listJevDecisions(t.run_id);
    expect(jd.length).toBeGreaterThan(0);
    expect(jd.every((r) => r.decision === "fallback")).toBe(true);
    expect(triageEvents(h.store, t.run_id)).toEqual([expect.objectContaining({ status: "answered", decision: "fallback" })]);
    const rows = handlerRows(h.store, t.run_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rung: "fail", reason_code: "error", fallback_reason: "threw", fallback_rung: "system_one" });
    expect(v.decision_id).toBe(rows[0]!.decision_id);
    expect(jd.every((r) => r.ladder_decision_id === rows[0]!.decision_id)).toBe(true);
    h.store.close();
  });

  it("a calibrationRows throw: skipped error, Jev's rows dropped, the message logged, the handler row linked", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = triageHarness(treeSays({ category: cat({ research: 0.9 }) }));
    const t = h.turn("帮我比较三款 NAS");
    fault.calibration = true;
    const out = await h.worker.triageTurn(t.input);
    expect(fault.calibration).toBe(false);
    expect(logged(err).some((l) => l.includes("calibration fault test"))).toBe(true);
    expect(out).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    const v = h.store.getJevVerdictForRun(t.run_id)!;
    expect(v).toMatchObject({ skip_reason: "error", route_outcome: "fallback", reason: "jev_skipped" });
    expect(h.store.listJevDecisions(t.run_id).map((r) => [r.status, r.skip_reason, r.question_id])).toEqual([["skipped", "error", null]]); // Jev's answered rows dropped: only the skipped row
    expect(triageEvents(h.store, t.run_id)).toEqual([expect.objectContaining({ status: "skipped", skip_reason: "error" })]);
    const rows = handlerRows(h.store, t.run_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rung: "fail", reason_code: null, fallback_reason: "threw", fallback_rung: "system_one" });
    expect(v.decision_id).toBe(rows[0]!.decision_id);
    expect(h.store.listJevDecisions(t.run_id)[0]!.ladder_decision_id).toBe(rows[0]!.decision_id);
    h.store.close();
  });
});
