import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMIND_KINDS, reminderText, runIncidentReminder } from "../../src/run/incident-alert.js";
import { RunStore } from "../../src/run/run-store.js";
import { runReminderStep } from "../../src/telegram/telegram-daemon.js";

// Spec §5: an actionable incident paged once and then said nothing for three weeks (judge seat 2). A reminder repeats daily
// until it is fixed — but only for kinds Paco can act on, and never for delivery health (a reminder about undelivered alerts
// would multiply during an outage, memory: monitors must not observe their own output).
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const NOW = "2026-11-02T22:00:00.000Z"; // 2026-11-03 09:00 in Sydney
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney" } as NodeJS.ProcessEnv;
const rows = () => (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
  .prepare("SELECT idempotency_key, payload_json FROM notification_outbox").all() as Array<{ idempotency_key: string; payload_json: string }>;

describe("REMIND_KINDS", () => {
  it("is exactly spec §5's set and action lines", () => {
    expect([...REMIND_KINDS]).toEqual([
      ["role_unresolved", "tap the card, or `/models set <key> <pattern>`"],
      ["static_list_stale", "re-pin `STATIC_ROLE_LISTS`"],
      ["model_catalog_unavailable", "check `omp --profile houge models`"],
      ["planner_session_reset_failed", "send `/fresh`, or check the omp session dir"]
    ]);
  });
});

describe("runIncidentReminder", () => {
  it("one message, only kinds in the set, only incidents older than 24 h, with age and action; at most once a day", () => {
    store.openIncident({ kind: "role_unresolved", subject: "judges:2", detail: {}, now: ago(20 * 24 + 7) });
    store.openIncident({ kind: "static_list_stale", subject: "kimi-code/k3", detail: {}, now: ago(23) });        // too young
    store.openIncident({ kind: "undelivered_notification", subject: "telegram:1", detail: {}, now: ago(48) });   // never reminded
    store.openIncident({ kind: "trust_tap_budget", subject: "2026-11-02", detail: {}, now: ago(30) });          // rolls over itself
    expect(runIncidentReminder({ store, chatId: "-1003", env: ENV, now: NOW })).toBe("sent");
    expect(rows().map((r) => [r.idempotency_key, (JSON.parse(r.payload_json) as { text: string }).text])).toEqual([[
      "incident_remind:2026-11-03",
      "🔔 **Still open** (daily reminder)\n- role_unresolved · judges:2 · open 20d7h — tap the card, or `/models set <key> <pattern>`"
    ]]);
    expect(runIncidentReminder({ store, chatId: "-1003", env: ENV, now: new Date(Date.parse(NOW) + 3_600_000).toISOString() })).toBe("already");
    expect(rows()).toHaveLength(1);
  });
  it("nothing old enough → no message; no chat → nothing", () => {
    store.openIncident({ kind: "role_unresolved", subject: "judges:2", detail: {}, now: ago(1) });
    expect(runIncidentReminder({ store, chatId: "-1003", env: ENV, now: NOW })).toBe("none");
    expect(runIncidentReminder({ store, chatId: null, env: ENV, now: NOW })).toBe("no_chat");
    expect(rows()).toEqual([]);
  });
  it("reminderText lists every kind in the set, oldest first", () => {
    expect(reminderText([
      { incident_id: "inc_b", kind: "planner_session_reset_failed", subject: "chat:42", first_seen_at: ago(25) },
      { incident_id: "inc_a", kind: "model_catalog_unavailable", subject: "omp", first_seen_at: ago(49) }
    ], NOW)).toBe("🔔 **Still open** (daily reminder)\n- model_catalog_unavailable · omp · open 2d1h — check `omp --profile houge models`\n"
      + "- planner_session_reset_failed · chat:42 · open 1d1h — send `/fresh`, or check the omp session dir");
  });
});

describe("runReminderStep (the daemon's pre-model-tick step)", () => {
  // Why: the reminder must not depend on HOUGE_MODEL_ROLES or on any model tick finishing; the step is synchronous and
  // self-contained, so a hung catalog read (which lives in the later async tick) cannot delay it.
  it("enqueues once in static mode, needs no model machinery, and never throws", () => {
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    vi.stubEnv("HOUGE_DISPLAY_TZ", "Australia/Sydney");
    store.openIncident({ kind: "model_catalog_unavailable", subject: "omp", detail: {}, now: ago(30) });
    runReminderStep(store, "-1003", NOW);
    runReminderStep(store, "-1003", NOW);
    expect(rows().map((r) => r.idempotency_key)).toEqual(["incident_remind:2026-11-03"]);
    const broken = { listOpenIncidents() { throw new Error("db down"); } } as unknown as RunStore;
    expect(() => runReminderStep(broken, "-1003", NOW)).not.toThrow();
  });
});
