import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevClient } from "../../src/jev/jev-client.js";
import { decide, marginOf, persistDecisionRows, recordSkip, stateHash } from "../../src/jev/decide.js";
import { TRIAGE_QUESTIONS } from "../../src/jev/questions/triage.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { JEV_INCIDENT_SUBJECT } from "../../src/jev/jev-incidents.js";
import { ALERT_REOPEN_QUIET_MS } from "../../src/run/incident-alert.js";
import { RunStore } from "../../src/run/run-store.js";
import { recordingSink } from "../helpers/llm-audit.js";

/** The versioned id Jev REPORTS (the request sends the moving alias `jev-latest`); calibration rows key on it. */
const REPORTED = "jev-1.13.0";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const choice = (choice: string, probabilities: Record<string, number>) => {
  const n = Object.keys(probabilities).length; const pMax = Math.max(...Object.values(probabilities));
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
};
const okBody = () => ({ model: REPORTED, usage: { input_tokens: 900, output_tokens: 0 }, answers: {
  lane: choice("memory", { none: 0.05, status: 0.05, memory: 0.9 }), complete: choice("pure", { mixed: 0.1, pure: 0.9 }), scope: choice("ask", { ask: 0.8, research: 0.2 }) } });
function setup(fetchImpl: typeof fetch, apiKey: string | null = "k") {
  const store = RunStore.openInMemory();
  const client = createJevClient({ apiKey: apiKey ?? undefined, audit: recordingSink(), meteredBreached: () => false, retries: 0, timeoutMs: 1000, fetchImpl });
  return { store, client, input: { point: "triage" as const, run_id: "run_1", state: { latest_message: "x" }, questions: TRIAGE_QUESTIONS, lang: "zh" as const, client, store, thresholdVersion: "v1" } };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

// Spec §3.2/§3.4: decide() never applies a threshold and never writes; the caller persists rows in its own transaction.
describe("decide", () => {
  it("answers with one row per question as data; nothing is written until persistDecisionRows", async () => {
    const { store, input } = setup(vi.fn(async () => json(200, okBody())) as unknown as typeof fetch);
    const d = await decide(input);
    expect(d.status).toBe("answered");
    if (d.status !== "answered") return;
    expect(d.rows.map((r) => r.question_id)).toEqual(["lane", "complete", "scope"]);
    expect(d.rows[0]).toMatchObject({ criteria_hash: criteriaHash(TRIAGE_QUESTIONS[0]!), model_reported: REPORTED, state_hash: stateHash({ latest_message: "x" }),
      top_prob: 0.9, status: "answered", threshold_version: "v1", decision: null, threshold_used: null, input_tokens: 900 });
    expect(d.rows[0]!.margin).toBeCloseTo(0.85, 5);
    expect(d.rows[0]!.answers_json).not.toContain("latest_message"); // numbers only
    expect(store.listJevDecisions("run_1")).toHaveLength(0);
    const ids = persistDecisionRows(store, d.rows, "act", "v1:memory");
    expect(ids).toHaveLength(3);
    const rows = store.listJevDecisions("run_1");
    expect(rows.map((r) => r.decision_id)).toEqual(ids);
    expect(rows.every((r) => r.decision === "act" && r.threshold_used === "v1:memory")).toBe(true);
    store.close();
  });
  it("returns skipped without writing a row (the caller persists after its cancellation check) and opens the incident on a 429", async () => {
    const { store, input } = setup(vi.fn(async () => json(429, {})) as unknown as typeof fetch);
    const d = await decide(input);
    expect(d).toEqual({ status: "skipped", reason: "rate_limited" });
    expect(store.listJevDecisions("run_1")).toHaveLength(0);
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_rate_limited")).toBe(true);
    recordSkip(store, "triage", "run_1", "zh", "rate_limited");
    expect(store.listJevDecisions("run_1")).toMatchObject([{ status: "skipped", skip_reason: "rate_limited", question_id: null }]);
    store.close();
  });
  it("no key is skipped{no_key} with the jev_no_key incident, never a fetch", async () => {
    const fetchImpl = vi.fn();
    const { store, input } = setup(fetchImpl as unknown as typeof fetch, null);
    expect(await decide(input)).toEqual({ status: "skipped", reason: "no_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_no_key")).toBe(true);
    store.close();
  });
  it("a malformed response is skipped as parse with no incident (per-call noise, visible in rows)", async () => {
    const { store, input } = setup(vi.fn(async () => json(200, { model: REPORTED, answers: {}, usage: { input_tokens: 1 } })) as unknown as typeof fetch);
    expect(await decide(input)).toEqual({ status: "skipped", reason: "parse" });
    expect(store.listOpenIncidents()).toHaveLength(0);
    store.close();
  });
  // Final review I1: openAlertedIncident dedupes on the OPEN fingerprint, so an incident nothing resolves swallows every
  // later outage of its kind. An answered call proves Jev is reachable, authorised and the questions valid: it resolves
  // the open Jev outage incidents so the next 429 pages again (the standing direction: 429 / auth must reach Paco).
  it("429 → answered → 429 (past the flap quiet window) opens and pages twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", "555");
    const replies = [json(429, {}), json(200, okBody()), json(429, {})];
    const { store, input } = setup(vi.fn(async () => replies.shift()!) as unknown as typeof fetch);
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    expect(await decide(input)).toEqual({ status: "skipped", reason: "rate_limited" });
    vi.setSystemTime(new Date("2026-10-01T00:01:00.000Z"));
    expect((await decide(input)).status).toBe("answered");
    expect(store.listOpenIncidents()).toHaveLength(0);
    vi.setSystemTime(new Date(Date.parse("2026-10-01T00:01:00.000Z") + ALERT_REOPEN_QUIET_MS + 1000));
    expect(await decide(input)).toEqual({ status: "skipped", reason: "rate_limited" });
    const alerts: unknown[] = [];
    for (let n = store.claimNextNotification("t", 30); n; n = store.claimNextNotification("t", 30)) alerts.push(n.payload);
    expect(alerts).toHaveLength(2);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["jev_rate_limited"]);
    store.close();
  });
  it("an answered call resolves every open Jev outage kind on the jev subject, and nothing else", async () => {
    const { store, input } = setup(vi.fn(async () => json(200, okBody())) as unknown as typeof fetch);
    for (const kind of ["jev_auth", "jev_rate_limited", "jev_overloaded", "jev_no_key", "jev_question_invalid", "triage_overrides"]) {
      store.openIncident({ kind, subject: JEV_INCIDENT_SUBJECT, detail: {} });
    }
    store.openIncident({ kind: "jev_auth", subject: "elsewhere", detail: {} });
    expect((await decide(input)).status).toBe("answered");
    expect(store.listOpenIncidents().map((i) => `${i.kind}:${i.subject}`).sort()).toEqual([`triage_overrides:${JEV_INCIDENT_SUBJECT}`, "jev_auth:elsewhere"].sort());
    store.close();
  });
  // Final review (T5 minor): a requested question with no answer must fail loud, never return a partial answer set that
  // a gate would read as "no row for that question". A client that skipped its own validation is the realistic case.
  it("a requested question with no answer is skipped{parse} (fail loud), never a partial answer set", async () => {
    const { store, input } = setup(vi.fn() as unknown as typeof fetch);
    const answers = okBody().answers as Record<string, unknown>; delete answers.scope;
    const client = vi.fn(async () => ({ ok: true as const, model: REPORTED, answers, latency_ms: 5, input_tokens: 9, output_tokens: 0 }));
    expect(await decide({ ...input, client: client as unknown as typeof input.client })).toEqual({ status: "skipped", reason: "parse" });
    store.close();
  });
  it("recordSkip writes the pre-call skipped row for disabled/posture/modality", () => {
    const store = RunStore.openInMemory();
    recordSkip(store, "triage", "run_9", "en", "posture");
    expect(store.listJevDecisions("run_9")).toMatchObject([{ status: "skipped", skip_reason: "posture", lang: "en", point: "triage" }]);
    store.close();
  });
  it("marginOf is p1 − p2 over the two largest probabilities", () => {
    expect(marginOf({ choice: "a", probabilities: { a: 0.5, b: 0.3, c: 0.2 }, confidence: 0 })).toBeCloseTo(0.2, 9);
  });
});
