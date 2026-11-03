import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway, HELP_TEXT } from "../../src/gateway/gateway.js";
import { openAlertedIncident } from "../../src/run/incident-alert.js";
import type { RoutedIncidentKind } from "../../src/run/incident-route.js";
import { RunStore } from "../../src/run/run-store.js";
import { CHANGES_MAX_CHARS, changesText } from "../../src/notifications/change-log-view.js";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2026-11-03 §7/§8: /changes is how Paco reads what Houge logged instead of messaging him.
const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney" };
const NOW = "2026-10-13T10:00:00.000Z";
const log = (s: RunStore, n: number, text: string, at: string): void => {
  s.logChange({ topic: "incident_log", idempotency_key: `k${n}`, correlation_id: `c${n}`, text, now: at });
};
const ago = (min: number): string => new Date(Date.parse(NOW) - min * 60_000).toISOString();

describe("parser", () => {
  it("/changes and /status changes are the status view; extra words are invalid", () => {
    const view = { ok: true, command: { type: "status", view: "changes" } };
    expect(parseTelegramCommand("/changes")).toEqual(view);
    expect(parseTelegramCommand("/status changes")).toEqual(view);
    expect(parseTelegramCommand("/changes x").ok).toBe(false);
  });
});

describe("changesText", () => {
  it("renders newest first as DD Mon HH:MM in the display zone", () => {
    const s = RunStore.openInMemory();
    log(s, 1, "first", ago(300)); log(s, 2, "second", ago(200)); log(s, 3, "third", ago(100));
    const lines = changesText(s, NOW, ENV).split("\n");
    expect(lines.slice(1)).toEqual(["13 Oct 19:20 · third", "13 Oct 17:40 · second", "13 Oct 16:00 · first"]);
    s.close();
  });
  it("says so when nothing changed, and ignores rows older than 30 days", () => {
    const s = RunStore.openInMemory();
    expect(changesText(s, NOW, ENV)).toBe("No background changes in the last 30 days.");
    log(s, 1, "ancient", new Date(Date.parse(NOW) - 31 * 86_400_000).toISOString());
    expect(changesText(s, NOW, ENV)).toBe("No background changes in the last 30 days.");
    s.close();
  });
  it("caps at 20 rows and 3900 chars and counts the rest", () => {
    const s = RunStore.openInMemory();
    for (let i = 0; i < 25; i++) log(s, i, `row${i} ` + "word ".repeat(60), ago(i + 1));
    const text = changesText(s, NOW, ENV);
    expect(text.length).toBeLessThanOrEqual(CHANGES_MAX_CHARS);
    expect(text.split("\n").length - 2).toBeLessThanOrEqual(20);
    expect(text).toMatch(/\n… \d+ older$/);
    const shown = text.split("\n").length - 2;
    expect(text.endsWith(`… ${25 - shown} older`)).toBe(true);
    s.close();
  });
  it("cuts a long text on a word boundary and drops a dangling backtick", () => {
    const s = RunStore.openInMemory();
    log(s, 1, "alpha ".repeat(48) + "`code beta gamma", ago(5));
    const row = changesText(s, NOW, ENV).split("\n")[1]!.split(" · ")[1]!;
    expect(row.length).toBeLessThanOrEqual(300);
    expect(row.endsWith("…")).toBe(true);
    expect(row).not.toMatch(/alph…$/);
    expect(row.slice(0, -1).split("`").length - 1).toBe(0);
    s.close();
  });
});

describe("/status line and /help", () => {
  const status = (key: string) => buildTypedTaskEvent({ source: "telegram", type: "status", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" }, idempotency_key: `telegram:${key}`, source_reference: `telegram:update:${key}` });
  it("counts open incidents by route and changes this week; reading writes no change_log row", () => {
    const s = RunStore.openInMemory();
    s.openIncident({ kind: "stuck_run", subject: "run_x", detail: {} });
    s.openIncident({ kind: "core_overflow", subject: "chat:1", detail: {} });
    s.openIncident({ kind: "todo_reminder_seen", subject: "1", detail: {} });
    for (let i = 0; i < 4; i++) log(s, i, `c${i}`, ago(60 * (i + 1)));
    log(s, 9, "old", new Date(Date.parse(NOW) - 8 * 86_400_000).toISOString());
    new Gateway(s).intake(status("c1"), NOW);
    const out = [...drainOutbox(s).values()];
    expect(out).toHaveLength(1);
    expect(String(out[0]?.text)).toMatch(/Self-check: swept .* · 1 paged · 2 internal open · 4 changes this week · \/changes\n/);
    expect(s.countChangeLogSince("1970-01-01T00:00:00.000Z")).toBe(5);
    s.close();
  });
  it("/changes answers with the log; /help lists it", () => {
    const s = RunStore.openInMemory();
    log(s, 1, "model moved", ago(5));
    new Gateway(s).intake(buildTypedTaskEvent({ source: "telegram", type: "status", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" }, idempotency_key: "telegram:c2", source_reference: "telegram:update:c2",
      metadata: { status_view: "changes" } }), NOW);
    expect(String([...drainOutbox(s).values()][0]?.text)).toContain("model moved");
    expect(HELP_TEXT).toContain("/changes");
    s.close();
  });
});

describe("§8 end to end: no raw ids reach the log view", () => {
  it("four log kinds opened with their real subject shapes", () => {
    const s = RunStore.openInMemory();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const open = (kind: RoutedIncidentKind, subject: string, event = false): void => {
      openAlertedIncident(s, { kind, subject, detail: {}, now: NOW, ...(event ? { event: true } : {}) });
    };
    open("todo_reminder_seen", "5551234567");
    open("core_overflow", "chat:5551234567");
    open("hostile_schedule_turn", `run_${uuid}`, true);
    open("standing_settle_failed", `run:appr_${uuid}`);
    const text = changesText(s, NOW, ENV);
    expect(text.split("\n").length).toBeGreaterThan(4);
    for (const bad of [/run_[0-9a-f-]{36}/, /-?\d{6,}/, /appr_/, /notif_/, /chg_/]) expect(text).not.toMatch(bad);
    s.close();
  });
});
