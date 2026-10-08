import { describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";
import type { CalibrationRow } from "../../src/jev/calibration.js";
import { checkJevModelCalibrated, JEV_MODEL_UNCALIBRATED, jevIncidentKind, openJevIncident } from "../../src/jev/jev-incidents.js";

// Spec §3.3: every Jev outage class reaches Paco as an alerted incident on the FIRST failure;
// a second identical failure must not page again (fingerprint dedupe in openAlertedIncident).
describe("jev incidents", () => {
  it("maps each failure class to its own kind", () => {
    expect(jevIncidentKind({ ok: false, reason: "no_key", detail: "", error_kind: "auth" })).toBe("jev_no_key");
    expect(jevIncidentKind({ ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" })).toBe("jev_auth");
    expect(jevIncidentKind({ ok: false, reason: "error", detail: "HTTP 429", error_kind: "rate_limited" })).toBe("jev_rate_limited");
    expect(jevIncidentKind({ ok: false, reason: "error", detail: "HTTP 529", error_kind: "overloaded" })).toBe("jev_overloaded");
    expect(jevIncidentKind({ ok: false, reason: "error", detail: "HTTP 422", error_kind: "malformed_question" })).toBe("jev_question_invalid");
    // fused rides ADR 0019's own alert; timeout/parse/transport are per-call noise, not outages
    expect(jevIncidentKind({ ok: false, reason: "fused", detail: "" })).toBeUndefined();
    expect(jevIncidentKind({ ok: false, reason: "error", detail: "", error_kind: "timeout" })).toBeUndefined();
  });
  it("opens one incident per kind and does not re-page while it is open", () => {
    const store = RunStore.openInMemory();
    const r = { ok: false as const, reason: "error" as const, detail: "HTTP 429", error_kind: "rate_limited" as const };
    openJevIncident(store, r, { point: "triage", question_id: null });
    openJevIncident(store, r, { point: "triage", question_id: null });
    const open = store.listOpenIncidents().filter((i) => i.kind === "jev_rate_limited");
    expect(open).toHaveLength(1);
    expect(open[0]?.subject).toBe("jev");
    store.close();
  });
});

// The request sends the moving alias `jev-latest`; calibration rows key on the REPORTED model. When TypeSafe moves the alias,
// every lane silently falls through to the planner — safe, but the armed lanes are lost until Paco approves new rows, so
// it pages him once per new model. Nothing armed (no rows at all) means nothing was lost: no page.
describe("jev_model_uncalibrated", () => {
  const row = (model: string): CalibrationRow => ({ question_id: "lane", criteria_hash: "h", model, lang: "zh", approved: "Paco", evidence: "e" });
  const ENV = { HOUGE_TELEGRAM_CHAT_ID: "555" };
  const notes = (store: RunStore) => [...drainOutbox(store).values()].map((p) => String(p.text));

  it("opens one alerted incident for an uncalibrated reported model when rows exist for another model, and pages once", () => {
    const store = RunStore.openInMemory();
    const rows = [row("jev-1.13.0"), row("jev-1.13.0")];
    checkJevModelCalibrated(store, "jev-1.14.0", rows, ENV);
    checkJevModelCalibrated(store, "jev-1.14.0", rows, ENV);
    const open = store.listOpenIncidents().filter((i) => i.kind === JEV_MODEL_UNCALIBRATED);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ subject: "jev-1.14.0" });
    expect(JSON.parse(open[0]!.detail_json)).toMatchObject({ model: "jev-1.14.0", calibrated_models: ["jev-1.13.0"] });
    const sent = notes(store);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Jev moved to jev-1.14.0");
    expect(sent[0]).toMatch(/fall back to the planner until new calibration rows are approved/);
    store.close();
  });

  it("does not open when no calibration rows exist at all, nor when the reported model is calibrated", () => {
    const store = RunStore.openInMemory();
    checkJevModelCalibrated(store, "jev-1.14.0", [], ENV);
    checkJevModelCalibrated(store, "jev-1.13.0", [row("jev-1.13.0")], ENV);
    expect(store.listOpenIncidents().filter((i) => i.kind === JEV_MODEL_UNCALIBRATED)).toHaveLength(0);
    expect(notes(store)).toHaveLength(0);
    store.close();
  });

  const open = (store: RunStore) => store.listOpenIncidents().filter((i) => i.kind === JEV_MODEL_UNCALIBRATED);

  it("resolves a model's incident once rows name THAT model (Paco approved it)", () => {
    const store = RunStore.openInMemory();
    checkJevModelCalibrated(store, "jev-1.14.0", [row("jev-1.13.0")], ENV);
    expect(open(store)).toHaveLength(1);
    checkJevModelCalibrated(store, "jev-1.14.0", [row("jev-1.13.0"), row("jev-1.14.0")], ENV); // Paco approved rows
    expect(open(store)).toHaveLength(0);
    store.close();
  });

  // A canary serving two ids behind the alias: M2 uncalibrated, then M1 (calibrated), then M2 again past the flap window.
  // Resolving M2 on M1's answer would re-page on every flip; the M2 incident stays open and pages exactly once.
  it("a canary flip (M2, calibrated M1, M2 again > 10 min later) pages once and the M2 incident stays open", () => {
    const store = RunStore.openInMemory();
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      const rows = [row("jev-1.13.0")];
      vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
      checkJevModelCalibrated(store, "jev-1.14.0", rows, ENV);
      vi.setSystemTime(new Date("2026-10-07T00:01:00.000Z"));
      checkJevModelCalibrated(store, "jev-1.13.0", rows, ENV);
      vi.setSystemTime(new Date("2026-10-07T00:20:00.000Z"));
      checkJevModelCalibrated(store, "jev-1.14.0", rows, ENV);
      vi.useRealTimers();
      expect(open(store)).toMatchObject([{ subject: "jev-1.14.0" }]);
      expect(notes(store)).toHaveLength(1);
    } finally { vi.useRealTimers(); store.close(); }
  });

  // Nothing armed → nothing lost: once the calibrated set is empty (rows withdrawn, or only rows naming the alias, which
  // never arm), an open move incident no longer describes a loss and resolves.
  it("resolves every open jev_model_uncalibrated incident when the calibrated set becomes empty", () => {
    const store = RunStore.openInMemory();
    checkJevModelCalibrated(store, "jev-1.14.0", [row("jev-1.13.0")], ENV);
    checkJevModelCalibrated(store, "jev-1.15.0", [row("jev-1.13.0")], ENV);
    expect(open(store)).toHaveLength(2);
    checkJevModelCalibrated(store, "jev-1.15.0", [row("jev-latest")], ENV); // alias rows never arm: the set is empty
    expect(open(store)).toHaveLength(0);
    checkJevModelCalibrated(store, "jev-1.14.0", [row("jev-1.13.0")], ENV);
    checkJevModelCalibrated(store, "jev-1.14.0", [], ENV);
    expect(open(store)).toHaveLength(0);
    store.close();
  });
});
