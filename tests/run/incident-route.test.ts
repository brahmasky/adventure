import { describe, expect, it, vi } from "vitest";
import { JEV_ANSWERED_RESOLVES } from "../../src/jev/jev-incidents.js";
import { JEV_MODEL_INCIDENT_KINDS } from "../../src/decisions/jev-version-job.js";
import { OMP_CONTRACT_DRIFT } from "../../src/omp/omp-probe-runner.js";
import { OMP_READ_FORMAT_DRIFT } from "../../src/omp/read-format.js";
import { SUPERVISOR_ALERT_KINDS } from "../../src/run/incident-alert.js";
import { INCIDENT_ROUTE, incidentNotice, incidentResolvedNotice, isRoutedKind, maskSubject, operatorChat, routeOf } from "../../src/run/incident-route.js";
import { SWEEP_INCIDENT_KINDS } from "../../src/run/invariant-sweep.js";

const ANCHOR_KINDS = ["jev_anchor_missing", "jev_anchor_mixed_models", "jev_anchor_insufficient"];
const CARD_KINDS = ["jev_model_drifted", "jev_model_insufficient", "jev_model_check_stalled", "decision_health"];
const LOG_KINDS = ["heartbeat_gap", "core_overflow", "trust_tap_budget", "decision_record_failed", "decision_fallback", "decision_golden_drift",
  "omp_read_format_drift", "omp_contract_drift", ...ANCHOR_KINDS, "standing_sweep_failed", "standing_settle_failed", "standing_evidence_failed",
  "todo_reminder_seen", "static_list_stale", "model_catalog_unavailable", "triage_overrides", "hostile_schedule_turn"];

describe("every opened kind has a rule", () => {
  const opened = [...SWEEP_INCIDENT_KINDS, ...SUPERVISOR_ALERT_KINDS, ...JEV_ANSWERED_RESOLVES, ...JEV_MODEL_INCIDENT_KINDS, "jev_model_check_stalled",
    ...ANCHOR_KINDS, OMP_READ_FORMAT_DRIFT, OMP_CONTRACT_DRIFT, "hostile_schedule_turn", "trust_card_failed"];
  for (const k of opened) it(`${k} is in the table`, () => expect(isRoutedKind(k)).toBe(true));
});

describe("routes", () => {
  it("every Jev outage class and jev_skip_rate page (ADR 0029: an outage reaches Paco)", () => {
    for (const k of [...JEV_ANSWERED_RESOLVES, "jev_skip_rate"]) expect(routeOf(k)).toBe("page");
  });
  it("decision_fallback_streak pages (Paco 2026-11-07: a daily decider that keeps failing reaches him); the hourly decision_fallback stays a log", () => {
    expect(routeOf("decision_fallback_streak")).toBe("page");
    expect(routeOf("decision_fallback")).toBe("log");
  });
  it("wall_collapsed and lane_fallthrough_rate stay pages (spec 5.4)", () => {
    expect(routeOf("wall_collapsed")).toBe("page");
    expect(routeOf("lane_fallthrough_rate")).toBe("page");
  });
  it("card kinds route card and make no notice of their own", () => {
    for (const k of CARD_KINDS) { expect(routeOf(k)).toBe("card"); expect(incidentNotice(k, "x")).toBeNull(); expect(incidentResolvedNotice(k, "x", 5)).toBeNull(); }
  });
  it("the 19 log kinds route log", () => {
    expect(LOG_KINDS).toHaveLength(19);
    for (const k of LOG_KINDS) expect(routeOf(k)).toBe("log");
  });
  it("every other table row pages, and the table size is pinned (a flipped, added or removed row fails)", () => {
    const keys = Object.keys(INCIDENT_ROUTE);
    // 56 rows, 33 pages: improve_tick_degraded (spec 2026-11-07 §7) is the newest page
    expect(keys).toHaveLength(56);
    const notPage = new Set([...CARD_KINDS, ...LOG_KINDS]);
    const pages = keys.filter((k) => !notPage.has(k));
    expect(pages).toHaveLength(33);
    for (const k of pages) { expect(routeOf(k)).toBe("page"); expect(incidentNotice(k, "x")?.topic).toBe("incident_page"); }
  });
  it("the unknown-kind stderr line prints once per kind per process", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { lines.push(String(c)); return true; });
    try { routeOf("zz_unknown_a"); routeOf("zz_unknown_a"); expect(lines).toHaveLength(1); routeOf("zz_unknown_b"); expect(lines).toHaveLength(2); }
    finally { spy.mockRestore(); }
    expect(lines[0]).toContain("zz_unknown_a");
  });
  it("an unknown kind pages with the generic text and no action line", () => {
    expect(routeOf("no_such_kind")).toBe("page");
    expect(incidentNotice("no_such_kind", "daemon")).toEqual({ topic: "incident_page", text: "⚠️ Something needs a look.\n`no_such_kind` · daemon" });
    expect(isRoutedKind("no_such_kind")).toBe(false);
  });
});

describe("maskSubject", () => {
  it.each([
    ["chat:-1001234567890", "a chat"], ["8123456789", "a chat"], ["run:run_0f6c-uuid", "a run"], ["run_0f6c1b2a", "a run"],
    ["appr_x", "an approval"], ["uses:run_0f6c-uuid", "a run"], ["x:appr_1", "an approval"], ["x:8123456789", "a chat"], ["judges:2", "judges:2"], ["standing:std_1", "standing:std_1"],
    // codex whole-diff: a bare short chat id (todo_reminder_seen's subject is the chat id itself) is still a chat
    ["555", "a chat"], ["-42", "a chat"]
  ])("%s -> %s", (s, want) => expect(maskSubject(s)).toBe(want));
});

describe("notice text", () => {
  it("a page notice is says, action, then kind and masked subject", () => {
    expect(incidentNotice("wrapper_mismatch", "chat:-100123456789")).toEqual({ topic: "incident_page",
      text: "⚠️ My planner wrapper changed; every answer fails until a restart.\nWhat to do: restart the daemon\n`wrapper_mismatch` · a chat" });
  });
  it("a page row without an action prints no action line", () => {
    expect(incidentNotice("stuck_run", "run:r1")!.text.split("\n")).toHaveLength(3);
    expect(incidentNotice("undelivered_notification", "daemon")!.text).not.toContain("What to do");
  });
  it("a log notice is one line in the log topic", () => {
    expect(incidentNotice("core_overflow", "chat:-100123456789")).toEqual({ topic: "incident_log",
      text: "A chat holds more core facts than the cap; the oldest are left out. (`core_overflow` · a chat)" });
  });
  it("no notice carries JSON detail", () => {
    for (const k of Object.keys(INCIDENT_ROUTE)) expect(incidentNotice(k, "chat:-100123456789")?.text ?? "").not.toContain("{");
  });
  it("resolved: page kinds go to chat, log kinds to the log, same words", () => {
    expect(incidentResolvedNotice("wrapper_mismatch", "chat:1", 75)).toEqual({ topic: "incident_page", text: "✅ Fixed: My planner wrapper changed; every answer fails until a restart. — open 75 min" });
    expect(incidentResolvedNotice("core_overflow", "chat:1", 75)).toEqual({ topic: "incident_log", text: "✅ Fixed: A chat holds more core facts than the cap; the oldest are left out. — open 75 min" });
  });
});

describe("operatorChat (P4)", () => {
  it("prefers the working chat, falls back to the trimmed env chat, else null", () => {
    expect(operatorChat("7", { HOUGE_TELEGRAM_CHAT_ID: "9" })).toBe("7");
    expect(operatorChat(null, { HOUGE_TELEGRAM_CHAT_ID: " 9 " })).toBe("9");
    expect(operatorChat(undefined, {})).toBeNull();
    expect(operatorChat(null, { HOUGE_TELEGRAM_CHAT_ID: "  " })).toBeNull();
    expect(operatorChat("", { HOUGE_TELEGRAM_CHAT_ID: " 9 " })).toBe("9");
    expect(operatorChat("  ", {})).toBeNull();
  });
});
