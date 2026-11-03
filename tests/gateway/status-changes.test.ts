import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway, HELP_TEXT } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

const NOW = "2026-10-13T10:00:00.000Z";
const ago = (min: number): string => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const log = (s: RunStore, n: number, text: string, at: string): void => {
  s.logChange({ topic: "incident_log", idempotency_key: `k${n}`, correlation_id: `c${n}`, text, now: at });
};

describe("/status self-check line, /changes reply and /help (spec 2026-11-03 §7)", () => {
  const statusEv = (key: string) => buildTypedTaskEvent({ source: "telegram", type: "status", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" }, idempotency_key: `telegram:${key}`, source_reference: `telegram:update:${key}` });
  it("counts open incidents by route and changes this week; reading writes no change_log row", () => {
    const s = RunStore.openInMemory();
    s.openIncident({ kind: "stuck_run", subject: "run_x", detail: {} });
    s.openIncident({ kind: "core_overflow", subject: "chat:1", detail: {} });
    s.openIncident({ kind: "todo_reminder_seen", subject: "1", detail: {} });
    for (let i = 0; i < 4; i++) log(s, i, `c${i}`, ago(60 * (i + 1)));
    log(s, 9, "old", new Date(Date.parse(NOW) - 8 * 86_400_000).toISOString());
    new Gateway(s).intake(statusEv("c1"), NOW);
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

