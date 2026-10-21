import { describe, expect, it } from "vitest";
import { createLedgerEvent, validateLedgerEvent } from "../../src/run/run-ledger.js";

// Spec 2b-ii §2, §3.1, §5.2: three run-less events; ids, counts and closed enums only. Required fields pinned so a writer
// that forgets the job id or the phase fails validation, not silently thins the trail the live gate's case 9 reads.
const ev = (event_type: "improve_signal_skipped" | "improve_tick" | "improvement_job", payload: Record<string, unknown>) =>
  validateLedgerEvent(createLedgerEvent({ correlation_id: "improve", event_type, actor: "system", sequence: 1, payload }));
describe("improve ledger events", () => {
  it("improve_signal_skipped needs signal and code; improve_tick a phase and local_date; improvement_job job_id, from, to, attempt", () => {
    expect(ev("improve_signal_skipped", { signal: "rating", code: "no_run" })).toEqual({ ok: true });
    expect(ev("improve_signal_skipped", { signal: "rating" }).ok).toBe(false);
    expect(ev("improve_tick", { phase: "start", local_date: "2026-10-21" })).toEqual({ ok: true });
    expect(ev("improve_tick", { phase: "start" }).ok).toBe(false);
    expect(ev("improvement_job", { job_id: "job_1", from: "queued", to: "running", attempt: 1 })).toEqual({ ok: true });
    expect(ev("improvement_job", { job_id: "job_1", from: "queued", to: "running" }).ok).toBe(false);
  });
});
