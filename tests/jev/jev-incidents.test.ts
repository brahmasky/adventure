import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { jevIncidentKind, openJevIncident } from "../../src/jev/jev-incidents.js";

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
