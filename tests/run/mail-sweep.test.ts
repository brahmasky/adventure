import { describe, expect, it } from "vitest";
import type { GoogleApiDeps } from "../../src/capabilities/google-api.js";
import type { GoogleAuthClient } from "../../src/capabilities/google-auth.js";
import { mailStale, runMailTick, type PollDeps } from "../../src/mail/poller.js";
import { detectViolations, runInvariantSweep } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-09 §7 and Rev 1.1: the sweep is the backstop for a poller that stopped running (mail_poll_failing, through the
// poller's own stale predicate so it never flaps what the poller opened) and the only pager for a sustained Jev outage on
// mail (mail_jev_failing: a Jev timeout opens no Jev incident and mail is paged nowhere else).
const NOW = "2026-11-09T12:00:00.000Z";
const ENV = { HOUGE_MAIL_ENABLED: "1", HOUGE_INVARIANT_SWEEP_ENABLED: "1", HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5" } as NodeJS.ProcessEnv;
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const kinds = (store: RunStore, env = ENV) => detectViolations(store, NOW, env).filter((v) => v.kind.startsWith("mail_")).map((v) => v.kind);
const on = (store: RunStore, patch: Parameters<RunStore["setMailState"]>[0]) => store.setMailState({ enabled: true, enabled_at: ago(600), ...patch });
const decide = (store: RunStore, rung: "fail" | "system_one", min = 10) => store.insertDecision({ entry_id: "mail.triage", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_tool" as never,
  rung: rung as never, verdict: "later", p: null, reason_code: null, fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: ago(min) });

describe("mail_poll_failing in the sweep", () => {
  it("one violation when enabled and the last success is over 2 h old; none when fresh, when disabled, or when the env switch is off", () => {
    const store = RunStore.openInMemory();
    on(store, { last_ok_at: ago(150) });
    expect(kinds(store)).toEqual(["mail_poll_failing"]);
    expect(detectViolations(store, NOW, ENV).find((v) => v.kind === "mail_poll_failing")).toMatchObject({ subject: "paco", detail: { minutes: 150 } });
    store.setMailState({ last_ok_at: ago(30) });
    expect(kinds(store)).toEqual([]);
    store.setMailState({ last_ok_at: ago(150), enabled: false });
    expect(kinds(store)).toEqual([]);
    store.setMailState({ enabled: true });
    expect(kinds(store, {} as NodeJS.ProcessEnv)).toEqual([]);
    store.close();
  });
  it("with no success ever, staleness counts from the switch-on", () => {
    const store = RunStore.openInMemory();
    on(store, { last_ok_at: null, enabled_at: ago(121) });
    expect(kinds(store)).toEqual(["mail_poll_failing"]);
    store.setMailState({ enabled_at: ago(60) });
    expect(kinds(store)).toEqual([]);
    store.close();
  });
  it("the poller opens it with last_ok_at null (stale via enabled_at); a sweep keeps it open, no flap, and resolves it only once mailStale is false", async () => {
    const store = RunStore.openInMemory();
    on(store, { last_ok_at: null, enabled_at: ago(130) });
    const auth: GoogleAuthClient = { getAccessToken: async () => "ya29.t", invalidate: () => undefined };
    const down = { fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch, now: () => new Date(NOW) } as GoogleApiDeps;
    const d: PollDeps = { store, chatId: "555", pacoAddress: "paco@example.com", env: ENV, now: () => new Date(NOW), brokerRedact: (s) => s,
      ask: async () => ({ failed: "outage" }), gmail: { deps: down, auth }, hasRefreshToken: true, signal: new AbortController().signal };
    expect((await runMailTick(d)).ran).toBe(true);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["mail_poll_failing"]);
    const first = runInvariantSweep({ store, now: NOW, env: ENV, chat_id: "555" });
    expect(first).toMatchObject({ resolved: 0 });
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["mail_poll_failing"]);
    expect(store.listOpenIncidents().filter((i) => i.kind === "mail_poll_failing")).toHaveLength(1);
    // the world recovers: a success stamps last_ok_at, so mailStale is false and the next sweep resolves it
    store.setMailState({ last_ok_at: NOW });
    expect(mailStale(store.mailState(), ENV, new Date(NOW))).toBe(false);
    const later = new Date(Date.parse(NOW) + 10 * 60_000).toISOString();
    expect(runInvariantSweep({ store, now: later, env: ENV, chat_id: "555" }).resolved).toBe(1);
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
});

describe("mail_jev_failing in the sweep", () => {
  it("5 fail-rung mail.triage decisions in 24 h and no system_one answer is one violation; 4 is none", () => {
    const store = RunStore.openInMemory();
    for (let i = 0; i < 4; i++) decide(store, "fail", i + 1);
    expect(kinds(store)).toEqual([]);
    decide(store, "fail");
    expect(kinds(store)).toEqual(["mail_jev_failing"]);
    store.close();
  });
  it("one system_one answer in the window clears it; a fail older than 24 h does not count", () => {
    const store = RunStore.openInMemory();
    for (let i = 0; i < 5; i++) decide(store, "fail");
    decide(store, "system_one");
    expect(kinds(store)).toEqual([]);
    const s2 = RunStore.openInMemory();
    for (let i = 0; i < 5; i++) decide(s2, "fail", 25 * 60);
    expect(kinds(s2)).toEqual([]);
    store.close(); s2.close();
  });
  it("is not gated on the mail switch: an outage on mail that Paco switched off still reads from the decisions (and the sweep resolves it when they stop)", () => {
    const store = RunStore.openInMemory();
    for (let i = 0; i < 5; i++) decide(store, "fail");
    const r = runInvariantSweep({ store, now: NOW, env: ENV, chat_id: "555" });
    expect(r.opened).toBe(1);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["mail_jev_failing"]);
    decide(store, "system_one", 1);
    const later = new Date(Date.parse(NOW) + 10 * 60_000).toISOString();
    expect(runInvariantSweep({ store, now: later, env: ENV, chat_id: "555" }).resolved).toBe(1);
    store.close();
  });
});
