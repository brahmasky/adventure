import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";

// Spec 2b-ii §2 table: a captured rating labels the chat's latest planner run (rating value 0–3); a low rating also writes a
// correction (first correction wins); a rating with no run in the chat is an improve_signal_skipped no_run event, never a throw;
// /deny on a tool approval writes approval_denied with the capability (a denial on a schedule-born run is never a signal, R11).
const NOW = "2026-10-21T10:00:00.000Z";
let seq = 0;
const event = (type: "turn" | "deny", goal: string, extra: Record<string, unknown> = {}) => buildTypedTaskEvent({ source: "telegram", type, program: "turn", goal, requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `t:${++seq}`, source_reference: `telegram:update:${seq}:message:1`, ...extra } as never);
// created_at fixed BEFORE NOW: latestJevVerdictForChat(chat, NOW) reads `created_at <= NOW` (run-store.ts:4708), and the real clock is past it (senior N3 / codex)
const verdictOf = (s: RunStore, run_id: string) => s.insertJevVerdict({ run_id, category: "answer", breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "answer",
  role: "default", effort: null, cascade: null, save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null, created_at: "2026-10-21T09:30:00.000Z" });
const rows = (s: RunStore) => s.listUnconsumedSignals(10).map((r) => [r.signal, r.value, r.about_run_id]);
const skipped = (s: RunStore) => s.listLedgerEventsByTypeSince("improve_signal_skipped", "2026-01-01T00:00:00.000Z").map((e) => e.payload);

describe("gateway producers", () => {
  it("a bare rating writes rating on the chat's latest verdict run; a 0 also writes correction; with no verdict → skipped no_run", () => {
    const s = RunStore.openInMemory();
    const g = new Gateway(s);
    s.writePendingRating({ chat_id: "555", asked_at: NOW, window_start: "2026-10-21T09:00:00.000Z" });
    expect(g.intake(event("turn", "3"), NOW)).toMatchObject({ ok: true, status: "rating_captured" });      // no planner run in the chat yet
    expect(skipped(s)).toEqual([{ signal: "rating", code: "no_run" }]);
    const run_id = createTelegramTurn(s, "what time is it").run_id; verdictOf(s, run_id);
    s.writePendingRating({ chat_id: "555", asked_at: NOW, window_start: "2026-10-21T09:00:00.000Z" });
    expect(g.intake(event("turn", "0"), NOW)).toMatchObject({ ok: true, status: "rating_captured" });
    expect(rows(s)).toEqual([["rating", "0", run_id], ["correction", "answer", run_id]]);
    expect(s.getJevVerdictForRun(run_id)?.paco_correction).toBe("low_rating");
  });
  it("/deny on a tool approval writes approval_denied with the capability", () => {
    const s = RunStore.openInMemory();
    const run_id = createTelegramTurn(s, "run the thing").run_id;
    const claim = s.claimRun(run_id, "planner:555", 60)!;
    const approval = s.createToolApproval({ run_id: claim.run_id, worker_id: "planner:555", tool_call_id: "c1", capability: "shell_external", input_hash: "h", action_fingerprint: "f",
      requester: { kind: "user", id: "paco" }, summary: "ls", side_effect_level: "external_write", expires_at: "2099-01-01T00:00:00.000Z" }); // the event's created_at is the real clock; resolution refuses an expired approval
    const deny = event("deny", "", { approval_id: approval.approval_id });
    const g = new Gateway(s);
    expect(g.intake(deny, NOW)).toMatchObject({ ok: true, status: "approval_resolved" });
    expect(g.intake(deny, NOW)).toMatchObject({ ok: true, status: "approval_resolved" }); // a redelivered update replays the cached result; still one row
    expect(rows(s)).toEqual([["approval_denied", "shell_external", run_id]]);
  });
});
