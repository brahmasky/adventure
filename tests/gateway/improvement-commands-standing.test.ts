import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { handleImprovementTap, TAP_HANDLED_TEXT } from "../../src/gateway/improvement-commands.js";
import { standingRevokedText } from "../../src/decisions/standing-approval.js";
import { RunStore } from "../../src/run/run-store.js";
import { SkillStore } from "../../src/skills/skill-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Stage 4A §7: Revoke works for the grant's whole 30 days (no 14-day tap window), only from the row's own chat, once; the row and
// its ladder move end in one transaction, so a revoked grant can never leave an active move behind (or the reverse).
const GRANTED = "2026-10-01T10:00:00.000Z";
const NOW = "2026-10-29T10:00:00.000Z"; // 28 days later: past TAP_STALE_DAYS (14), inside the 30-day grant
let cb = 0;
const tap = (id: string, chat_id = "555", callback = `cb${++cb}`) => buildTypedTaskEvent({ source: "telegram", type: "improvement_tap", requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id }, idempotency_key: `telegram:1:callback:${callback}`, source_reference: `telegram:update:1:callback:${callback}`,
  metadata: { telegram_update_id: 1, telegram_callback_id: callback, kind: "sa", id, action: "revoke" } });
const skills = () => new SkillStore({ root: mkdtempSync(join(tmpdir(), "hg-skills-")) });
const reply = (s: RunStore) => [...drainOutbox(s).values()].map((p) => String(p.text));
function granted(s: RunStore, state: "standing" | "candidate" = "standing") {
  const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true, created_at: GRANTED });
  return s.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id: "555", action_fingerprint: "fp", state, move_id, expires_at: "2026-10-31T10:00:00.000Z", created_at: GRANTED });
}

describe("Revoke tap", () => {
  it("28 days after the grant: ends the row and its move, records one tap, replies; a second tap on the row is handled", () => {
    const s = RunStore.openInMemory(); const row = granted(s);
    expect(handleImprovementTap(s, skills(), tap(row.standing_id), NOW)).toMatchObject({ ok: true, status: "improvement_tapped" });
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "revoked", ended_at: NOW });
    expect(s.getLadderMove(row.move_id!)?.state).toBe("ended");
    expect(reply(s)).toEqual([standingRevokedText("HTTP write")]);
    handleImprovementTap(s, skills(), tap(row.standing_id), NOW);
    expect(reply(s)).toEqual([TAP_HANDLED_TEXT]);
    expect(s.listImprovementTaps(row.standing_id).map((t) => [t.subject_kind, t.action, t.result])).toEqual([["move", "revoke", "applied"], ["move", "revoke", "handled"]]);
  });
  it("a redelivered callback replays the stored answer and writes nothing new", () => {
    const s = RunStore.openInMemory(); const row = granted(s);
    handleImprovementTap(s, skills(), tap(row.standing_id, "555", "same"), NOW); drainOutbox(s);
    handleImprovementTap(s, skills(), tap(row.standing_id, "555", "same"), NOW);
    expect(s.listImprovementTaps(row.standing_id)).toHaveLength(1);
  });
  it("from another chat: handled, the grant stands", () => {
    const s = RunStore.openInMemory(); const row = granted(s);
    handleImprovementTap(s, skills(), tap(row.standing_id, "-999"), NOW);
    expect(reply(s)).toEqual([TAP_HANDLED_TEXT]);
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("standing");
    expect(s.getLadderMove(row.move_id!)?.state).toBe("active");
  });
  it("a row that is not standing (or is unknown) is handled and untouched", () => {
    const s = RunStore.openInMemory(); const row = granted(s, "candidate");
    handleImprovementTap(s, skills(), tap(row.standing_id), NOW);
    handleImprovementTap(s, skills(), tap("sa_0f8fad5b-d9cb-469f-a165-70867728950e"), NOW);
    expect(reply(s)).toEqual([TAP_HANDLED_TEXT, TAP_HANDLED_TEXT]);
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("candidate");
  });
});
