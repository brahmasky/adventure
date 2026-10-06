import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkipReason } from "../../src/jev/decide.js";
import { checkJevSkipRate, runInvariantSweep, SWEEP_INCIDENT_KINDS } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

// `jev_skip_rate` (ADR 0029 §3.7): timeout / parse / transport failures open no incident per call, so a Jev layer that
// mostly fails looks exactly like a quiet one — triage falls through to the planner and Houge seems normal. The sweep
// must make that loud, without counting skips that are not failures (flag off, posture, modality, override, oversize).
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1", HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5" };
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const nowIso = (plusMin = 0) => new Date(NOW + plusMin * 60_000).toISOString();
const open = () => store.listOpenIncidents().filter((i) => i.kind === "jev_skip_rate");
const sweep = (plusMin = 0) => runInvariantSweep({ store, now: nowIso(plusMin), env: ARMED, chat_id: "555" });
let seq = 0;

const NUMBERS = { criteria_hash: "h", model_reported: "jev-1.13.0", state_hash: "s", answers_json: "{}", confidence: 0.9, top_prob: 0.9,
  margin: 0.8, threshold_version: "v", threshold_used: null, decision: "shadow" as const, latency_ms: 300, input_tokens: 100 };

/** One answered triage call: three question rows, as decide() writes them (one call, not three). */
function answered(minutesAgo: number): void {
  seq += 1;
  for (const q of ["lane", "complete", "scope"]) {
    store.insertJevDecision({ ...NUMBERS, run_id: `run-${seq}`, point: "triage", question_id: q, lang: "en", status: "answered", skip_reason: null,
      created_at: iso(minutesAgo) });
  }
}
function skipped(minutesAgo: number, reason: SkipReason, point = "triage"): void {
  seq += 1;
  store.insertJevDecision({ run_id: `run-${seq}`, point, question_id: null, criteria_hash: null, model_reported: null, state_hash: null,
    lang: "en", answers_json: null, confidence: null, top_prob: null, margin: null, threshold_version: null, threshold_used: null, decision: null,
    latency_ms: null, input_tokens: null, status: "skipped", skip_reason: reason, created_at: iso(minutesAgo) });
}

describe("jev_skip_rate", () => {
  it("is one of the sweep's own kinds, so the sweep may resolve it", () => {
    expect(SWEEP_INCIDENT_KINDS).toContain("jev_skip_rate");
  });

  it("opens when most attempted calls in the window failed silently, counting an answered call once", () => {
    answered(60); answered(50);
    skipped(40, "timeout"); skipped(30, "parse"); skipped(20, "transport"); skipped(10, "error");
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: true, attempts: 6, failed: 4 });
    sweep();
    expect(open()).toHaveLength(1);
    expect(open()[0]!.subject).toBe("jev");
  });

  it("does not count non-failure skips: a disabled, posture-gated or overridden layer is not a dead one", () => {
    answered(60);
    for (const r of ["disabled", "posture", "modality", "override", "state_too_large"] as const) skipped(30, r);
    skipped(20, "timeout");
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: false, attempts: 2, failed: 1 });
  });

  it("does not double-page the classes that already open their own jev_* incident", () => {
    // auth / 429 / 529 / bad question / no key / fuse page on the first failure; they are attempts, not silent failures.
    answered(60);
    for (const r of ["auth", "rate_limited", "overloaded", "malformed_question", "no_key", "fused"] as const) skipped(30, r);
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: false, attempts: 7, failed: 0 });
  });

  it("needs a floor of 3 attempts: two timeouts on a quiet day are noise, three dead calls are not", () => {
    skipped(20, "timeout"); skipped(10, "timeout");
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: false, attempts: 2, failed: 2 });
    skipped(5, "parse");
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: true, attempts: 3, failed: 3 });
  });

  it("exactly half failed opens (the bar is inclusive)", () => {
    answered(60); answered(50); skipped(20, "timeout"); skipped(10, "transport");
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: true, attempts: 4, failed: 2 });
  });

  it("counts only triage rows, and a row exactly one window old is out", () => {
    for (let k = 0; k < 4; k++) skipped(10 + k, "timeout", "other_point");
    skipped(24 * 60, "timeout"); skipped(24 * 60, "timeout"); skipped(24 * 60, "timeout");
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: false, attempts: 0, failed: 0 });
  });

  it("stays open while Jev answers nothing, even after the failed rows age out of the window", () => {
    for (let k = 0; k < 3; k++) skipped(30 + k, "timeout");
    sweep(0);
    expect(open()).toHaveLength(1);
    sweep(25 * 60); // a day later: no calls at all in the window, still no evidence Jev came back
    expect(open()).toHaveLength(1);
    answered(-25 * 60 - 1);
    sweep(25 * 60 + 10);
    expect(open()).toEqual([]);
  });

  it("an empty exclusion list counts every skip as an attempt (no NOT IN (NULL) trap)", () => {
    skipped(30, "disabled"); skipped(20, "timeout");
    expect(store.countJevCalls("triage", iso(60), nowIso(), [], [])).toEqual({ attempts: 2, failed: 0 });
  });

  it("stays shut below half: a layer answering most calls is degraded, not dead", () => {
    answered(60); answered(50); answered(40);
    skipped(30, "timeout"); skipped(20, "timeout");
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: false, attempts: 5, failed: 2 });
  });

  it("calls older than the window are not evidence", () => {
    for (let k = 0; k < 6; k++) skipped(25 * 60 + k, "timeout");
    expect(checkJevSkipRate(store, nowIso())).toMatchObject({ open: false, attempts: 0 });
  });

  it("resolves on the sweep after answers return", () => {
    for (let k = 0; k < 5; k++) skipped(30 + k, "timeout");
    sweep(0);
    expect(open()).toHaveLength(1);
    for (let k = 0; k < 6; k++) answered(-1 - k);
    sweep(10);
    expect(open()).toEqual([]);
  });
});
