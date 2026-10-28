# Decision ladder, stage 4A — standing approval for a scheduled command: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After Paco approves the same `shell_external` command from the same schedule on three distinct runs, the fourth approved run executes in the clean room; once its code-owned seal facts, the completed run and the delivered report are all in, the grant is automatic (Decision 1-A: `granted_by: "auto"`, `granted_via: "approval.standing"`, urgent card with Revoke). Later byte-identical scheduled runs proceed without a card, one use per run, authorised by a store CAS at the execution boundary; Revoke, expiry (30 d), schedule end, a denial anywhere on the bytes (30-day block) and a stale streak end it. No model path opens, advances or grants anything.

**Architecture:** `run-store.ts` owns the rows (`standing_approvals`, `standing_uses`) and every transition (consume hook, deny hook, use CAS, grant CAS). `capability-runner.ts` computes the fingerprint before policy, exports it, and turns a gated ask into an allow only after the sink's CAS wins. `bridge-handler.ts` is a selector only (reads the row, sets `standing` / `standing_trial` and `executor: "cleanroom"`). New `src/decisions/standing-approval.ts` owns settlement (`settleSealing` truth table, grant, sweep, cards, `/schedule` section). The dispatcher calls settlement after `markDelivered`; the per-cycle sweep catches the rest.

**Tech Stack:** Node 25 stdlib only (`dependencies: {}`), TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest, macOS `sandbox-exec` through Slice 1's `runCleanroomShell`.

**Spec:** `docs/superpowers/specs/2026-10-28-ladder-stage4a-standing-approval-design.md` Rev 4, approved 2026-10-28 with **Decision 1-A**. The 1-B text (✅/❌ card, 7-day `sealed` window, `granted_by: paco`) is **not built**; the callback family is `dec:sa:<standing_id>:revoke` only. Context: ADR 0030 §8.3 / §4.3 (`docs/superpowers/specs/2026-10-12-decision-ladder-design.md:907–1020`), clean-room Slice 1 spec §Hand-off to Stage 4A.

## Global Constraints

- `dependencies: {}` stays empty. Node stdlib + devDeps only.
- Functions under 50 lines. Match surrounding style (dense one-liners, comments say *why*). No filename-header comments. No review tags (`B14`, `senior`, `codex`) in code comments or test names — write the reason instead.
- `exactOptionalPropertyTypes`: omit keys with spreads (`...(x !== undefined ? { x } : {})`), never assign `undefined`. `noUncheckedIndexedAccess`: every indexed read is `T | undefined`.
- Telegram output goes through the outbox and the rich renderer (`enqueueNotification` / `enqueueUrgentCard`); never a direct send, never plain text.
- Every test encodes why the behaviour matters: a test that still passes with the rule removed is wrong. Tests live in `tests/<area>/` mirroring `src/`.
- Protected files edited under the approved spec (list them in the slice report): `src/capabilities/capability-runner.ts`, `src/run/run-store.ts`, `src/run/run-ledger.ts`, `src/policy/capability-policy.ts` (dir `src/policy`), `src/decisions/entries/tool-policy.ts`, `src/decisions/urgent.ts`, `src/decisions/digest.ts`, `src/decisions/standing-approval.ts` (new, dir `src/decisions`), `src/omp/bridge-handler.ts`, `src/omp/tool-approval-sink.ts`, `src/omp/cleanroom-run.ts` (dir `src/omp`), `src/gateway/improvement-commands.ts`, `docs/decisions/0030-decision-ladder.md` + `docs/decisions/README.md` (dir `docs/decisions`). Not protected: `src/gateway/gateway.ts`, `src/triggers/telegram-command-parser.ts`, `src/notifications/notification-dispatcher.ts`, `src/run/schedule-tick.ts`, `src/telegram/telegram-daemon.ts`, `scripts/`.
- Commit per task, Conventional Commits, stage by name (never `git add -A`), each commit body ends with `Co-Authored-By: Claude <model> <noreply@anthropic.com>` for the implementing model.
- Run `set -o pipefail; npm run typecheck && npx vitest run <files>` after every green step; never `| tail` without pipefail. Full suite (`npm test`) before each commit of Tasks 2, 3, 5, 6, 7.
- Work in the worktree `.worktrees/stage4a` on branch `feat/stage4a-standing` (created by the orchestrator). Gate scripts need `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env` and a built `dist/` **in the worktree** (`npm run build` there; never build in the main checkout — the daemon runs its `dist/`).
- The live gate never opens the live DB for writing (VACUUM copy under its own temp root), never messages any chat (Telegram tokens deleted from `process.env`, the stub adapter delivers), never fires a scheduled job outside its schedule (the gate intakes its own runs on a copy), and leaves nothing under the real `<cache>/cleanroom/`.
- Durations (spec §Decision 4): expiry 30 d, deny block 30 d, `sealing` TTL 24 h, stale 30 d. Streak = 3 distinct consumed runs.
- Test clocks: a fixture date that a **real-clock** path compares (`resolveToolApprovalForTest`, the omp sink's `standingUse`, a lease from `claimRun`) is relative to `Date.now()` (`FUTURE = now + 90 d`, leases `86_400 * 400` s), never a literal year; fixed `NOW` stays for store calls that take `now` as an argument.

### Rulings (binding)

Rulings 1–5 are the orchestrator's; 6–10 encode plan-review findings (codex) the same way. Each is overturnable only by the orchestrator.


- **Ruling 1 — the deny hook never throws out of intake.** A `StandingHookError` rolls the resolution back whole, opens `standing_hook_failed`, and `processApprovalTrigger` / `resolveToolApprovalForTest` **return** the refusal `STANDING_HOOK_FAILED`; `gateway.ts`'s `APPROVAL_REFUSAL_TEXT` gives Paco a rich-renderer line that the standing approval may still be live and to use `/schedule` → Revoke (or tap again). Nothing is recorded in `processed_triggers` on that path, so a retap re-runs the hook — intended. — Why: a throw out of `gateway.intake` leaves the Telegram offset unadvanced, so the same update is redelivered forever and every later update, the kill switch included, is blocked (a hard line). — Cost if wrong: a deny that could not end standing authority is refused rather than half-applied; Paco reads one extra line and taps again.
- **Ruling 2 — a standing-credit fault never blocks the approved command.** The `approved → consumed` CAS commits on its own (one guarded UPDATE, as today); the credit / `candidate → sealing` transition runs in its **own** `inTransaction` immediately after; a fault there opens `standing_credit_failed`, returns `sealing: false`, credits nothing, and the command runs (sealed when the bridge selected the room, uncredited). `startSealing` re-reads the approval as `consumed`, so sealing records intent for sealed execution after a committed consume; a sealing row with no call facts (a crash after the credit, before the adapter ran) ends at its TTL. There is no SAVEPOINT precedent in `run-store.ts`, hence two transactions. — Why: Paco approved the command; a bookkeeping table must not take that away. — Cost if wrong (residual, stated): a crash between the two transactions loses one credit; harmless, the next scheduled run credits.
- **Ruling 3 — a post-grant tamper ends the grant.** A standing use whose `tool_finished.cleanroom` facts show `tampered`, `escaped`, `check_failed`, or `ran` with `torn_down: false` ends the row `tampered_use` (its move ends with it) and sends Paco an urgent card. It lives in the settle path, `settleStandingUses(store, run_id)` in `standing-approval.ts`, called from `settleDeliveredReport` and from `runStandingSweep` over every `standing_uses` run of each `standing` row. — Why the settle path and not the bridge's `finish()`: the bridge is a selector only (§7) and `finish()` is skipped when a run dies between the adapter and the ledger write; the settle path reads the same code-owned facts once they are durable, runs every cycle whatever the run's fate (total), and is a store-only function testable by seeding events. — Cost if wrong: the end lands at delivery or the next cycle, not at the call; harmless, because the per-run cap already refuses a second use in that run and the sweep runs before the next fire.
- **Ruling 4 — the runner requires the clean room before a standing use.** `authoriseStanding` calls `standingUse` only when the execution context carries `executor: "cleanroom"`; otherwise `requires_approval` / `standing_mismatch` and the CAS is never consulted. — Why: the shell adapter selects the room from `ctx.executor` alone, so a direct runner caller with a valid sink could otherwise spend a grant on an ordinary shell. — Cost if wrong: a caller that forgets the ctx asks Paco instead of running; fail closed.
- **Ruling 5 — `{ ok, sealing }` from the consume is audit/test-only.** No production code reads `sealing` (the core-worker sink wraps the run-level approvals table and never calls `consumeToolApproval`); it exists so tests and the live gate can see the transition. — Why: the store owns the transition; a caller branching on `sealing` would make the runner a second owner. — Cost if wrong: none at runtime; a future reader must add its own test.
- **Ruling 6 (review-derived: codex B1, round 2) — the grant re-verifies its whole evidence inside its own transaction.** `grantStanding` re-reads the standing row itself inside its `inTransaction` and takes every evidence, card and transition field from that read; if the trial ids (`sealing_approval_id`, `sealed_run_id`, `sealed_tool_call_id`) differ from the row `settleSealing` observed, the outcome is `lost` (reported as `wait`) and the newer trial is neither granted nor ended on the older one's evidence. It then re-reads, before `markStandingGranted` and in the same transaction: three distinct consumed approvals on three distinct scheduled runs of this key (in `credited_runs_json` order), the consumed fourth approval on `sealed_run_id` with `tool_call_id = sealed_tool_call_id`, the sealed call's facts, the completed run and the delivered final report (`sealVerdict` again `seal`). A gap ends the row `sealed_trial_failed` inside that transaction and opens `standing_evidence_failed` naming the gap. It runs **only on a `seal` verdict**, so a trial that fails its facts ends for that reason, never for missing evidence. — Why: a row that merely says `sealing` must never stand up a command. — Cost if wrong: a trial with corrupted bookkeeping ends instead of granting; the next three runs earn it again.
- **Ruling 7 (review-derived: codex B2) — the 24 h TTL is checked before delivery**, right after the pre-spawn reset check: a trial whose report is delivered at or after `sealing_started_at + 24 h` ends. — Why: spec §6 bounds a sealing trial at 24 h; a late delivery must not stand a command up. — Cost if wrong: a slow delivery ends one trial; the next run asks again.
- **Ruling 8 (review-derived: codex B3) — a stale streak ends inside the consume, before it is credited**, and the approval starts a fresh streak. — Why: after downtime no sweep has run, and a consume must not refresh a 30-day-dead streak. — Cost if wrong: none; the sweep would end the same row later.
- **Ruling 9 (review-derived: codex B4) — a grant whose Revoke card cannot be queued does not commit.** `enqueueUrgentCard` returning `null` (an outbox conflict on `urgent:standing_grant:<id>`) throws inside the grant transaction, rolling back the row, the move and the events; the dispatcher hook / sweep turn it into an incident and the sweep retries until the TTL ends the trial. — Why: a grant Paco cannot see or revoke from its card breaks §7's "the card carries Revoke". — Cost if wrong: a trial whose card key is poisoned never grants; the incident names it.
- **Ruling: the grant race is tested as an interleaving on one store** — the daemon holds one node:sqlite connection, so that is the race Houge can have; cost if wrong: a multi-process topology would need its own test.
- **Ruling 10 (review-derived: codex warning) — the standing-use CAS checks the caller's binding first.** `schedule_mismatch` / `chat_mismatch` are decided before a fingerprint mismatch may end the row. — Why: a foreign schedule's run with other bytes must not be able to revoke this key's grant. — Cost if wrong: none; a real mismatch from the right caller still ends the row.

## File structure

| File | Responsibility |
|---|---|
| `src/run/run-ledger.ts` (modify) | six `standing_*` event types + required keys |
| `src/run/run-store.ts` (modify) | migration `2026-10-28-standing-approval`; `StandingApprovalRow` et al.; reads; `endStandingApproval`; consume hook (CAS, then `creditAfterConsume` → `standingCredit` with the stale check, `startSealing`); deny hook (`standingDeny`, `STANDING_HOOK_FAILED` refusal); `approvalChatBound`; `standingUse` CAS (caller binding first); `markStandingGranted`, `resetStandingToCandidate`, `listStandingUses`; `lastSentDecisionDigestAt`; `cancelScheduledTask` ends rows |
| `src/policy/capability-policy.ts` (modify) | `standing` input echoed on a gated ask with no trust ask; `STANDING_REASON`, `STANDING_MISMATCH_REASON` |
| `src/decisions/entries/tool-policy.ts` (modify) | v3: `standing`, `standing_mismatch` reason codes |
| `src/capabilities/capability-runner.ts` (modify) | `actionFingerprint` export, fingerprint before policy, `standing` / `standing_trial` on the input, sink `standingUse?`, `authoriseStanding` (clean-room ctx required) |
| `src/omp/tool-approval-sink.ts` (modify) | forwards `standing_trial`, returns `sealing`, implements `standingUse` |
| `src/omp/cleanroom-run.ts` (modify) | `cleanroomAvailable` exported (step 1 of `runCleanroomShell`) |
| `src/omp/bridge-handler.ts` (modify) | seal facts (`exit_code`, `truncated`, `check_failed`, `room`, `reason`); `standingSelect`; fourth-card line through the sink's `reason`; `executor: "cleanroom"` on the right context |
| `src/decisions/standing-approval.ts` (create) | `sealVerdict`, `settleSealing`, grant (evidence re-read + move + card), `settleStandingUses` (post-grant tamper), `settleDeliveredReport`, `runStandingSweep`, `grantCardText`, `tamperedUseText`, `revokeButton`, `/schedule` section, `SA_PREFIX` |
| `src/decisions/urgent.ts` (modify) | `enqueueUrgentCard` returns the notification id |
| `src/notifications/notification-dispatcher.ts` (modify) | `onDelivered` hook after `markDelivered` |
| `src/telegram/telegram-daemon.ts` (modify) | `createOutboxDispatcher(store, adapters)` (the daemon's one sender, `onDelivered` → `settleDeliveredReport`) |
| `src/run/schedule-tick.ts` (modify) | `runStandingSweep` before the scheduler-flag early return |
| `src/triggers/telegram-command-parser.ts` (modify) | `dec:sa:<standing_id>:revoke` in `parseImprovementCallback` |
| `src/gateway/improvement-commands.ts` (modify) | `standingTap` (Revoke) |
| `src/gateway/gateway.ts` (modify) | `APPROVAL_REFUSAL_TEXT.STANDING_HOOK_FAILED` (Task 3); `/schedule` "常驻批准" section with Revoke buttons (Task 8) |
| `src/decisions/digest.ts` (modify) | `standingLines` section over the persisted digest cutoff |
| `tests/run/run-store-standing.test.ts` (create), `tests/run/run-store-approvals.test.ts` (modify: migration count), `tests/run/omp-store.test.ts` (modify: consume result), `tests/policy/capability-policy-standing.test.ts` (create), `tests/capabilities/capability-runner-standing.test.ts` (create), `tests/decisions/tool-policy.test.ts` (modify), `tests/omp/bridge-handler.test.ts` (modify), `tests/omp/bridge-handler-standing.test.ts` (create), `tests/omp/cleanroom-run.test.ts` (modify), `tests/decisions/standing-approval.test.ts` (create), `tests/notifications/notification-dispatcher.test.ts` (modify), `tests/telegram/telegram-daemon-standing.test.ts` (create), `tests/run/schedule-tick.test.ts` (modify), `tests/triggers/decision-review-callback.test.ts` (modify), `tests/gateway/improvement-commands-standing.test.ts` (create), `tests/gateway/gateway-telegram.test.ts` (modify), `tests/decisions/digest.test.ts` (modify) | |
| `scripts/check-standing-rollback.mjs` (create), `scripts/live-gate-standing-approval.mjs` (create), `scripts/old-dist-provenance.mjs` (modify) | rollback check; live gate; provenance names the compiled file the slice changes |

---

### Task 1: Storage — migration, row types, reads, `endStandingApproval`, ledger event types

**Files:**
- Modify: `src/run/run-ledger.ts` (`LedgerEventType` union ends at line 104 `"improvement_job"`; `requiredPayloadFields` ends at line 353)
- Modify: `src/run/run-store.ts` (types after `LadderMoveRow` line 1035; DDL constant after `DECISION_LADDER_DDL` ~1135; migration method after `applyJevVersionCheckMigration` ~8135 and a call appended to `migrate()` at line 8124; methods after `listLadderMovesCreatedSince` line 5569)
- Test: `tests/run/run-store-standing.test.ts` (create); `tests/run/run-store-approvals.test.ts` (modify: the migration count at :585–592)

**Interfaces (Produces):**
```ts
// run-ledger.ts — LedgerEventType gains:
| "standing_streak" | "standing_sealing" | "standing_sealed" | "standing_granted" | "standing_used" | "standing_ended"
// requiredPayloadFields gains (code-owned ids and enums only, never bodies):
standing_streak: ["standing_id", "run_id", "approval_id", "streak"],
standing_sealing: ["standing_id", "run_id", "tool_call_id", "approval_id"],
standing_sealed: ["standing_id", "run_id", "tool_call_id"],
standing_granted: ["standing_id", "move_id"],
standing_used: ["standing_id", "move_id", "run_id", "tool_call_id", "action_fingerprint"],
standing_ended: ["standing_id", "reason"]

// run-store.ts
export type StandingState = "streak" | "candidate" | "sealing" | "sealed" | "standing" | "ended";
export type StandingEndReason = "sealed_trial_failed" | "denied" | "revoked" | "expired" | "schedule_ended" | "stale" | "mismatch" | "tampered_use";
export interface StandingKey { schedule_id: string; chat_id: string; action_fingerprint: string }
export interface StandingApprovalRow extends StandingKey {
  standing_id: string; capability: string; label: string; state: StandingState; credited_runs_json: string; approval_ids_json: string;
  sealing_approval_id: string | null; sealed_run_id: string | null; sealed_tool_call_id: string | null; sealing_started_at: string | null;
  move_id: string | null; grant_notification_id: string | null; denied_until: string | null; expires_at: string | null; last_used_run_id: string | null;
  created_at: string; updated_at: string; ended_at: string | null; ended_reason: string | null;
}
getStandingApproval(standing_id: string): StandingApprovalRow | undefined
standingFor(key: StandingKey): StandingApprovalRow | undefined                       // the one live (state <> 'ended') row of a key
listStandingApprovals(f?: { state?: StandingState; chat_id?: string; schedule_id?: string }): StandingApprovalRow[]
standingDenied(chat_id: string, action_fingerprint: string, now: string): boolean    // denied_until > now over ANY row, ended included
finalReportState(run_id: string): string | undefined                                  // outbox state of `${run_id}:final_report`
endStandingApproval(i: { standing_id: string; reason: StandingEndReason; now: string; denied_until?: string }): boolean  // joins the caller's tx
appendStandingLedgerEvent(event_type: LedgerEventType, payload: Record<string, unknown>, run_id?: string): void
insertStandingApprovalForTest(r: Partial<StandingApprovalRow> & StandingKey & { state: StandingState }): StandingApprovalRow  // @internal
private endStandingTx(i): boolean                                                     // plain statements, for callers inside a raw BEGIN
```

- [ ] **Step 1: Write the failing tests** — create `tests/run/run-store-standing.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLedgerEvent } from "../../src/run/run-ledger.js";
import { RunStore } from "../../src/run/run-store.js";

// Stage 4A spec §5: one live row per (schedule, chat, fingerprint) — the partial unique index is what makes two concurrent
// consumes of one key agree on one row; ended rows stay because the 30-day deny block is read over them.
const NOW = "2026-10-28T10:00:00.000Z";
const KEY = { schedule_id: "sch_1", chat_id: "555", action_fingerprint: "fp_alishan_post" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("standing_approvals migration", () => {
  it("is additive and idempotent: a second open records no second version row and keeps the seeded row", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-sa-")); dirs.push(dir);
    const path = join(dir, "houge.sqlite");
    const first = RunStore.open(path);
    const row = first.insertStandingApprovalForTest({ ...KEY, state: "streak", created_at: NOW });
    first.close();
    const second = RunStore.open(path);
    try {
      expect(second.getStandingApproval(row.standing_id)).toMatchObject({ ...KEY, state: "streak", credited_runs_json: "[]" });
      const db = (second as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): unknown } } }).db;
      expect(db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?`).get("2026-10-28-standing-approval")).toEqual({ n: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM standing_uses`).get()).toEqual({ n: 0 });
    } finally { second.close(); }
  });
  it("one live row per key: a second live row throws, an ended row and a live row coexist, a state outside the set is refused", () => {
    const s = RunStore.openInMemory();
    s.insertStandingApprovalForTest({ ...KEY, state: "ended", ended_reason: "denied", ended_at: NOW });
    const live = s.insertStandingApprovalForTest({ ...KEY, state: "candidate" });
    expect(() => s.insertStandingApprovalForTest({ ...KEY, state: "streak" })).toThrow(/UNIQUE/);
    expect(s.standingFor(KEY)?.standing_id).toBe(live.standing_id);
    expect(() => s.insertStandingApprovalForTest({ ...KEY, chat_id: "556", state: "bogus" as "streak" })).toThrow(/CHECK/);
    expect(s.listStandingApprovals({ chat_id: "555" })).toHaveLength(2);
    expect(s.listStandingApprovals({ state: "candidate", schedule_id: "sch_1" }).map((r) => r.standing_id)).toEqual([live.standing_id]);
  });
});

describe("endStandingApproval", () => {
  it("ends a live row once, ends its move with it, keeps the row, writes standing_ended; the block survives the end", () => {
    const s = RunStore.openInMemory();
    const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "sa_x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    const row = s.insertStandingApprovalForTest({ ...KEY, state: "standing", move_id, expires_at: "2027-01-01T00:00:00.000Z" });
    const until = "2026-11-27T10:00:00.000Z";
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason: "denied", now: NOW, denied_until: until })).toBe(true);
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason: "revoked", now: NOW })).toBe(false); // one-shot: the second tap/sweep changes nothing
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "denied", ended_at: NOW, denied_until: until });
    expect(s.getLadderMove(move_id)?.state).toBe("ended");
    expect(s.standingFor(KEY)).toBeUndefined();
    expect(s.standingDenied(KEY.chat_id, KEY.action_fingerprint, NOW)).toBe(true);
    expect(s.standingDenied(KEY.chat_id, KEY.action_fingerprint, "2026-11-28T00:00:00.000Z")).toBe(false); // the block has an end
    expect(s.standingDenied("556", KEY.action_fingerprint, NOW)).toBe(false); // another chat's bytes are not blocked
    expect(s.getLedgerEvents().filter((e) => e.event_type === "standing_ended").map((e) => e.payload)).toEqual([{ standing_id: row.standing_id, reason: "denied" }]);
  });
  it("finalReportState reads the run's terminal notice by its shared key, undefined when none was queued", () => {
    const s = RunStore.openInMemory();
    expect(s.finalReportState("run_none")).toBeUndefined();
    s.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "final_report", idempotency_key: "run_a:final_report", run_id: "run_a", correlation_id: "run_a", payload: { text: "I hit an error" } });
    expect(s.finalReportState("run_a")).toBe("queued");
  });
});

describe("standing_* ledger events", () => {
  it("every type requires its code-owned keys, so a payload that forgot the move or run id never lands", () => {
    const ev = (event_type: "standing_used" | "standing_granted" | "standing_streak" | "standing_sealing" | "standing_sealed" | "standing_ended", payload: Record<string, unknown>) =>
      validateLedgerEvent({ event_id: "e", correlation_id: "c", event_type, occurred_at: NOW, actor: "core", sequence: 1, payload });
    expect(ev("standing_used", { standing_id: "sa_1", run_id: "r", tool_call_id: "t", action_fingerprint: "f" })).toEqual({ ok: false, error: "standing_used missing required payload field: move_id" });
    expect(ev("standing_granted", { standing_id: "sa_1" })).toEqual({ ok: false, error: "standing_granted missing required payload field: move_id" });
    expect(ev("standing_streak", { standing_id: "sa_1", run_id: "r", approval_id: "a" })).toEqual({ ok: false, error: "standing_streak missing required payload field: streak" });
    expect(ev("standing_sealing", { standing_id: "sa_1", run_id: "r", tool_call_id: "t", approval_id: "a" })).toEqual({ ok: true });
    expect(ev("standing_sealed", { standing_id: "sa_1", run_id: "r", tool_call_id: "t" })).toEqual({ ok: true });
    expect(ev("standing_ended", { standing_id: "sa_1" })).toEqual({ ok: false, error: "standing_ended missing required payload field: reason" });
  });
});
```

In `tests/run/run-store-approvals.test.ts` the two `schema_migrations` counts at lines 587 and 592 become `.toBe(39)`, and the comment at line 585 starts `// 39 = …` and ends `… + jev-version-check + standing-approval.` (one more additive migration; a count that silently stayed 38 would mean the migration never registered).

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/run/run-store-standing.test.ts tests/run/run-store-approvals.test.ts` → FAIL (`insertStandingApprovalForTest is not a function`; the count is 38; the ledger types are not in the union — typecheck errors on the test's literal types are expected until Step 3).

- [ ] **Step 3: Implement.** `src/run/run-ledger.ts`: append the six members to `LedgerEventType` after `| "improvement_job"` and the six entries to `requiredPayloadFields` after `improvement_job: [...]` with the comment `// Stage 4A standing approvals (ADR 0030 §8.3): ids, reasons and counts only; the command bytes never enter the ledger.`

`src/run/run-store.ts` — after `LadderMoveRow` (line 1035):
```ts
/** Stage 4A (ADR 0030 §8.3): one row per (schedule, chat, fingerprint) streak. `ended` rows stay: audit, and the 30-day deny block is read over them. */
export type StandingState = "streak" | "candidate" | "sealing" | "sealed" | "standing" | "ended";
export type StandingEndReason = "sealed_trial_failed" | "denied" | "revoked" | "expired" | "schedule_ended" | "stale" | "mismatch" | "tampered_use";
export interface StandingKey { schedule_id: string; chat_id: string; action_fingerprint: string }
export interface StandingApprovalRow extends StandingKey {
  standing_id: string; capability: string; label: string; state: StandingState; credited_runs_json: string; approval_ids_json: string;
  sealing_approval_id: string | null; sealed_run_id: string | null; sealed_tool_call_id: string | null; sealing_started_at: string | null;
  move_id: string | null; grant_notification_id: string | null; denied_until: string | null; expires_at: string | null; last_used_run_id: string | null;
  created_at: string; updated_at: string; ended_at: string | null; ended_reason: string | null;
}
```
After `DECISION_LADDER_DDL` (the spec's SQL verbatim):
```ts
const STANDING_APPROVAL_DDL = `
  CREATE TABLE IF NOT EXISTS standing_approvals (
    standing_id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL, chat_id TEXT NOT NULL, action_fingerprint TEXT NOT NULL,
    capability TEXT NOT NULL, label TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('streak','candidate','sealing','sealed','standing','ended')),
    credited_runs_json TEXT NOT NULL DEFAULT '[]',
    approval_ids_json TEXT NOT NULL DEFAULT '[]',
    sealing_approval_id TEXT, sealed_run_id TEXT, sealed_tool_call_id TEXT, sealing_started_at TEXT,
    move_id TEXT, grant_notification_id TEXT,
    denied_until TEXT, expires_at TEXT, last_used_run_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT, ended_reason TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS standing_key_live ON standing_approvals(schedule_id, chat_id, action_fingerprint) WHERE state <> 'ended';
  CREATE INDEX IF NOT EXISTS standing_deny_idx ON standing_approvals(chat_id, action_fingerprint, denied_until);
  CREATE TABLE IF NOT EXISTS standing_uses (standing_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, used_at TEXT NOT NULL, PRIMARY KEY (standing_id, run_id));`;
```
In `migrate()` append `this.applyStandingApprovalMigration();` after `this.applyJevVersionCheckMigration();`, and add (next to `applyJevVersionCheckMigration`):
```ts
  /** Stage 4A: additive tables only (IF NOT EXISTS); the previous build never reads them and keeps asking (spec §5 rollback). */
  private applyStandingApprovalMigration(): void {
    const version = "2026-10-28-standing-approval";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(STANDING_APPROVAL_DDL);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }
```
Methods after `listLadderMovesCreatedSince` (line 5569):
```ts
  // --- Standing approvals (Stage 4A, ADR 0030 §8.3) ------------------------------------------
  getStandingApproval(standing_id: string): StandingApprovalRow | undefined {
    return this.db.prepare(`SELECT * FROM standing_approvals WHERE standing_id = ?`).get<StandingApprovalRow>(standing_id);
  }
  /** The key's one live row (the partial unique index allows at most one). */
  standingFor(key: StandingKey): StandingApprovalRow | undefined {
    return this.db.prepare(`SELECT * FROM standing_approvals WHERE schedule_id = ? AND chat_id = ? AND action_fingerprint = ? AND state <> 'ended'`)
      .get<StandingApprovalRow>(key.schedule_id, key.chat_id, key.action_fingerprint);
  }
  listStandingApprovals(f: { state?: StandingState; chat_id?: string; schedule_id?: string } = {}): StandingApprovalRow[] {
    const where: string[] = []; const args: string[] = [];
    for (const [col, v] of [["state", f.state], ["chat_id", f.chat_id], ["schedule_id", f.schedule_id]] as const) if (v !== undefined) { where.push(`${col} = ?`); args.push(v); }
    return this.db.prepare(`SELECT * FROM standing_approvals${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, standing_id ASC`).all<StandingApprovalRow>(...args);
  }
  /** §6: a denial anywhere on (chat, fingerprint) blocks a new streak until denied_until; ended rows carry it, so they are read too. */
  standingDenied(chat_id: string, action_fingerprint: string, now: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM standing_approvals WHERE chat_id = ? AND action_fingerprint = ? AND denied_until > ? LIMIT 1`)
      .get<{ hit: number }>(chat_id, action_fingerprint, now) !== undefined;
  }
  /** The run's terminal notice — success and failure share this key (§2), so the state alone never proves success. */
  finalReportState(run_id: string): string | undefined {
    return this.db.prepare(`SELECT state FROM notification_outbox WHERE idempotency_key = ? ORDER BY created_at ASC LIMIT 1`).get<{ state: string }>(`${run_id}:final_report`)?.state;
  }
  /** End one live row once (CAS on state <> 'ended'); its move ends with it; the ledger names the reason. Joins the caller's transaction. */
  endStandingApproval(i: { standing_id: string; reason: StandingEndReason; now: string; denied_until?: string }): boolean {
    return this.joinTransaction(() => this.endStandingTx(i));
  }
  /** Plain statements: the deny hook runs inside processApprovalTrigger's raw BEGIN, where joinTransaction would nest a BEGIN and throw. */
  private endStandingTx(i: { standing_id: string; reason: StandingEndReason; now: string; denied_until?: string }): boolean {
    const row = this.getStandingApproval(i.standing_id);
    if (!row || row.state === "ended") return false;
    const r = this.db.prepare(`UPDATE standing_approvals SET state = 'ended', ended_reason = ?, ended_at = ?, updated_at = ?, denied_until = COALESCE(?, denied_until) WHERE standing_id = ? AND state <> 'ended'`)
      .run(i.reason, i.now, i.now, i.denied_until ?? null, i.standing_id);
    if (r.changes !== 1) return false;
    if (row.move_id) this.endLadderMove(row.move_id, i.now);
    this.appendStandingLedgerEvent("standing_ended", { standing_id: i.standing_id, reason: i.reason });
    return true;
  }
  /** Run-bound when a run owns the transition (the run's ledger shows it); run-less for a sweep or a tap. */
  appendStandingLedgerEvent(event_type: LedgerEventType, payload: Record<string, unknown>, run_id?: string): void {
    if (run_id !== undefined) return this.appendRunLedgerEvent(run_id, event_type, "core", payload);
    this.appendLedgerEvent(createLedgerEvent({ correlation_id: `standing:${String(payload.standing_id)}`, event_type, actor: "core", sequence: this.nextLedgerSequence(), payload }));
  }
  /** @internal Tests seed rows in any state; production rows are born only in the consume and deny hooks. */
  insertStandingApprovalForTest(r: Partial<StandingApprovalRow> & StandingKey & { state: StandingState }): StandingApprovalRow {
    const now = r.created_at ?? new Date().toISOString(); const standing_id = r.standing_id ?? `sa_${randomUUID()}`;
    this.db.prepare(`INSERT INTO standing_approvals (standing_id, schedule_id, chat_id, action_fingerprint, capability, label, state, credited_runs_json, approval_ids_json,
        sealing_approval_id, sealed_run_id, sealed_tool_call_id, sealing_started_at, move_id, grant_notification_id, denied_until, expires_at, last_used_run_id, created_at, updated_at, ended_at, ended_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(standing_id, r.schedule_id, r.chat_id, r.action_fingerprint, r.capability ?? "shell_external", r.label ?? "HTTP write", r.state, r.credited_runs_json ?? "[]", r.approval_ids_json ?? "[]",
        r.sealing_approval_id ?? null, r.sealed_run_id ?? null, r.sealed_tool_call_id ?? null, r.sealing_started_at ?? null, r.move_id ?? null, r.grant_notification_id ?? null,
        r.denied_until ?? null, r.expires_at ?? null, r.last_used_run_id ?? null, now, r.updated_at ?? now, r.ended_at ?? null, r.ended_reason ?? null);
    return this.getStandingApproval(standing_id)!;
  }
```
`createLedgerEvent` and `randomUUID` are already imported in run-store.ts (lines 29 and 1).

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/run/run-store-standing.test.ts tests/run/run-store-approvals.test.ts tests/run/run-store-ladder-2a.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/run/run-ledger.ts src/run/run-store.ts tests/run/run-store-standing.test.ts tests/run/run-store-approvals.test.ts
git commit -m "feat(store): standing_approvals + standing_uses migration, row reads, endStandingApproval, standing_* ledger events"
```

---

### Task 2: Runner and policy — `actionFingerprint` before policy, `standing` / `standing_trial`, `TOOL_POLICY` v3, sink interface

**Files:**
- Modify: `src/policy/capability-policy.ts`, `src/decisions/entries/tool-policy.ts`, `src/capabilities/capability-runner.ts`
- Test: `tests/policy/capability-policy-standing.test.ts` (create), `tests/capabilities/capability-runner-standing.test.ts` (create), `tests/decisions/tool-policy.test.ts` (modify)

**Code says otherwise (resolved here):** the spec pins "denies → trust ask → gated". `decideCapability` today checks gated before `trust_ask` and `tests/policy/capability-policy-trust.test.ts:22` pins that a gated call with a trust ask keeps the gated reason ("the code ask's full pause wins"). A literal reorder would break that test and change `waitPolicy`'s card. The pin the spec wants — a trust ask beats standing — is implemented as: the gated branch echoes `standing` **only when `trust_ask !== true`**; the runner consults the sink only on an echoed `standing`. Same effect, existing reasons untouched; tested directly.

**Interfaces (Produces):**
```ts
// capability-policy.ts
export interface CapabilityDecisionInput { /* existing */ standing?: { standing_id: string } }
export interface CapabilityDecision { decision: PolicyDecision; reason: string; standing?: { standing_id: string } }   // echoed only on a gated ask with no trust ask
export const STANDING_REASON = "Standing approval authorised this call";
export const STANDING_MISMATCH_REASON = "Standing approval did not match";
// tool-policy.ts: version 3; REASON_MAP[STANDING_REASON] = "standing", REASON_MAP[STANDING_MISMATCH_REASON] = "standing_mismatch"; reasonCodes gains both
// capability-runner.ts
export function actionFingerprint(capability: string, metadata: Pick<ToolMetadata, "side_effect_level" | "risk_level">, input: Record<string, unknown>): string
export interface StandingUseInput { standing_id: string; action_fingerprint: string; run_id: string; tool_call_id: string }
export type StandingUseResult = { ok: true; move_id: string } | { ok: false; code: string };
export interface ApprovalRequestSink {
  requestApproval(input: ApprovalRequestInput): { approval_id: string };
  consumeApprovedApproval(input: { run_id; approval_id; requester; capability; adapter_input_hash; action_fingerprint; tool_call_id; operation_id; consumed_at; standing_trial?: { standing_id: string } }):
    { ok: true; approval_id: string; state: "consumed"; sealing?: boolean } | { ok: false; error: { code: string; message: string } };   // `sealing`: audit/test-only — the store owns the transition, no production reader
  standingUse?(input: StandingUseInput): StandingUseResult;      // absent → the runner asks (fail closed); called only with a clean-room ctx (the adapter selects the room from ctx.executor alone)
}
export interface CapabilityExecutionInput { /* existing */ standing?: { standing_id: string }; standing_trial?: { standing_id: string } }
```

- [ ] **Step 1: Failing tests.** Create `tests/policy/capability-policy-standing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideCapability, type CapabilityDecisionInput } from "../../src/policy/capability-policy.js";

// Stage 4A §7: standing may satisfy a GATE only. It never lifts a deny, never touches an allow, and a trust ask beats it:
// the row says Paco approved these bytes on a clean turn, not on one that read text aimed at the assistant.
const gated: CapabilityDecisionInput = { capability: "shell_external", category: "tool", side_effect_level: "external_write", risk_level: "medium",
  allowed_actions: ["shell_external", "lesson_write"], forbidden_actions: ["paid_action"], approval_gates: ["external_write", "destructive", "paid"] };
const SA = { standing_id: "sa_1" };

describe("decideCapability with standing", () => {
  it("a gated ask echoes the standing row for the runner to authorise — the decision itself stays requires_approval", () => {
    expect(decideCapability({ ...gated, standing: SA })).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects", standing: SA });
  });
  it("a trust ask suppresses standing (hostile scheduled call asks as today)", () => {
    expect(decideCapability({ ...gated, standing: SA, trust_ask: true })).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects" });
  });
  it("standing never lifts a deny and never changes an allow", () => {
    expect(decideCapability({ ...gated, capability: "paid_action", allowed_actions: ["paid_action"], standing: SA })).toEqual({ decision: "deny", reason: "Capability forbidden by task contract" });
    expect(decideCapability({ ...gated, capability: "not_allowed", standing: SA }).decision).toBe("deny");
    expect(decideCapability({ ...gated, capability: "lesson_write", side_effect_level: "none", standing: SA })).toEqual({ decision: "allow", reason: "Capability allowed by task contract" });
  });
  it("without standing the answer is byte-identical to today (no standing key at all)", () => {
    expect(decideCapability(gated)).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects" });
  });
});
```

Create `tests/capabilities/capability-runner-standing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { actionFingerprint, CapabilityRunner, type ApprovalRequestSink, type StandingUseInput } from "../../src/capabilities/capability-runner.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { stableHash } from "../../src/domain/canonical.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { ToolRegistry, type SsrfContext } from "../../src/tools/tool-registry.js";

// Stage 4A §7: the standing row is a selector; only the sink's store CAS turns the gate into an allow. A forged selector, a
// sink without the CAS, a lost CAS, a trust ask or a context without the clean room all leave the call asking. The fingerprint the runner computes before policy
// is the one the store keyed three approvals on, so it must not move.
const contract = { allowed_actions: ["shell_external"], forbidden_actions: [], approval_gates: ["external_write"], budget: { time_minutes: 10, max_tool_calls: 10, max_agent_delegations: 0 } } as unknown as CompiledTaskContract;
const META = { side_effect_level: "external_write", risk_level: "medium" } as const;
const INPUT = { command: "curl -s -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post" };
/** The context the bridge passes on a standing use: the shell adapter selects the room from `executor` alone. */
const ROOM: SsrfContext = { run_id: "run_5", tool_call_id: "tc_5", executor: "cleanroom" };
function rig(use?: (i: StandingUseInput) => ReturnType<NonNullable<ApprovalRequestSink["standingUse"]>>) {
  const registry = new ToolRegistry(); let ran = 0;
  registry.register({ name: "shell_external", category: "tool", ...META, timeout_ms: 1_000, output_limit_bytes: 1_000, execute: async () => { ran++; return { ok: true, output: { exit_code: 0 } }; } });
  const requested: string[] = []; const used: StandingUseInput[] = []; const consumed: Array<Record<string, unknown>> = [];
  const decisions: Array<{ verdict: string; reason: string | null }> = [];
  const recorder: DecisionRecorder = { record: (entry, r) => { if (entry.id === "tool.policy") decisions.push({ verdict: r.verdict, reason: r.reason }); return null; } };
  const sink: ApprovalRequestSink = {
    requestApproval: (i) => { requested.push(i.action_fingerprint); return { approval_id: "appr_1" }; },
    consumeApprovedApproval: (i) => { consumed.push(i as unknown as Record<string, unknown>); return { ok: true, approval_id: i.approval_id, state: "consumed", sealing: true }; },
    ...(use ? { standingUse: (i) => { used.push(i); return use(i); } } : {})
  };
  const exec = (extra: Record<string, unknown> = {}, ctx: SsrfContext | null = ROOM) => new CapabilityRunner(registry, sink).execute({ run_id: "run_5", tool_call_id: "tc_5", contract, capability: "shell_external", input: INPUT, budget: new BudgetLedger(contract.budget), recorder, ...extra }, ctx ?? undefined);
  return { exec, requested, used, consumed, decisions, ran: () => ran };
}

describe("actionFingerprint", () => {
  it("equals the value the runner hands the approval sink and the pre-Stage-4A formula (a changed hash would orphan every stored streak)", async () => {
    const r = rig();
    await r.exec();
    const fp = actionFingerprint("shell_external", META, INPUT);
    expect(r.requested).toEqual([fp]);
    expect(fp).toBe(stableHash({ capability: "shell_external", side_effect_level: "external_write", risk_level: "medium", affected_resources: [], adapter_input_hash: stableHash(INPUT) }));
    expect(actionFingerprint("shell_external", META, { command: `${INPUT.command} ` })).not.toBe(fp); // one byte changed asks again
    expect(actionFingerprint("shell_external", META, { command: INPUT.command, extra: 1 })).not.toBe(fp);
  });
});

describe("CapabilityRunner standing", () => {
  it("a won CAS: allowed with reason standing, no card, the adapter runs once, the CAS saw the same fingerprint the card would have", async () => {
    const r = rig(() => ({ ok: true, move_id: "lm_1" }));
    expect((await r.exec({ standing: { standing_id: "sa_1" } })).status).toBe("succeeded");
    expect(r.requested).toEqual([]); expect(r.ran()).toBe(1);
    expect(r.used).toEqual([{ standing_id: "sa_1", action_fingerprint: actionFingerprint("shell_external", META, INPUT), run_id: "run_5", tool_call_id: "tc_5" }]);
    expect(r.decisions).toEqual([{ verdict: "allowed", reason: "standing" }]);
  });
  it("a lost CAS asks with reason standing_mismatch; a sink without standingUse asks the same way (fail closed)", async () => {
    const lost = rig(() => ({ ok: false, code: "already_used" }));
    expect(await lost.exec({ standing: { standing_id: "sa_1" } })).toEqual({ status: "requires_approval", approval_id: "appr_1" });
    expect(lost.decisions).toEqual([{ verdict: "requires_approval", reason: "standing_mismatch" }]); expect(lost.ran()).toBe(0);
    const bare = rig();
    expect(await bare.exec({ standing: { standing_id: "sa_forged" } })).toEqual({ status: "requires_approval", approval_id: "appr_1" });
    expect(bare.decisions).toEqual([{ verdict: "requires_approval", reason: "standing_mismatch" }]);
  });
  it("a context without the clean room never spends the grant: the CAS is not consulted, the call asks with standing_mismatch, the adapter does not run", async () => {
    // the shell adapter selects the room from ctx.executor alone, so a direct caller with a valid sink and an ordinary ctx must not get an allow
    const r = rig(() => ({ ok: true, move_id: "lm_1" }));
    expect(await r.exec({ standing: { standing_id: "sa_1" } }, null)).toEqual({ status: "requires_approval", approval_id: "appr_1" });
    expect(r.used).toEqual([]); expect(r.ran()).toBe(0);
    expect(r.decisions).toEqual([{ verdict: "requires_approval", reason: "standing_mismatch" }]);
    const plain = rig(() => ({ ok: true, move_id: "lm_1" }));
    expect((await plain.exec({ standing: { standing_id: "sa_1" } }, { run_id: "run_5", tool_call_id: "tc_5" })).status).toBe("requires_approval");
    expect(plain.used).toEqual([]);
  });
  it("a trust ask beats standing: the CAS is never consulted and the card goes out", async () => {
    const r = rig(() => ({ ok: true, move_id: "lm_1" }));
    expect((await r.exec({ standing: { standing_id: "sa_1" }, trust_ask: true })).status).toBe("requires_approval");
    expect(r.used).toEqual([]); expect(r.decisions).toEqual([{ verdict: "requires_approval", reason: "gated_side_effect" }]);
  });
  it("standing never lifts a deny", async () => {
    const r = rig(() => ({ ok: true, move_id: "lm_1" }));
    const denied = await r.exec({ standing: { standing_id: "sa_1" }, contract: { ...contract, forbidden_actions: ["shell_external"] } });
    expect(denied.status).toBe("denied"); expect(r.used).toEqual([]);
  });
  it("standing_trial rides the consume (the store moves candidate → sealing behind that CAS), and is absent when not set", async () => {
    const r = rig();
    await r.exec({ approved_approval_id: "appr_1", budget_reserved: true, standing_trial: { standing_id: "sa_c" } });
    expect(r.consumed[0]).toMatchObject({ approval_id: "appr_1", standing_trial: { standing_id: "sa_c" } });
    await r.exec({ approved_approval_id: "appr_1", budget_reserved: true });
    expect(r.consumed[1]).not.toHaveProperty("standing_trial");
  });
  it("on the approved resume the standing selector is ignored (the approval is the authority) and the adapter runs", async () => {
    const r = rig(() => ({ ok: false, code: "not_standing" }));
    expect((await r.exec({ standing: { standing_id: "sa_1" }, approved_approval_id: "appr_1", budget_reserved: true })).status).toBe("succeeded");
    expect(r.used).toEqual([]);
  });
});
```

Append to `tests/decisions/tool-policy.test.ts` inside the describe:
```ts
  it("v3 names the standing codes: a standing allow and a lost CAS are legible on the decision row (an unknown reason is recorded as null)", () => {
    expect(TOOL_POLICY.version).toBe(3);
    const ok = decideSync(TOOL_POLICY, { decision: "allow", reason: "Standing approval authorised this call" }, { run_id: null, recorder: { record: () => null } });
    expect([ok.verdict, ok.reason]).toEqual(["allowed", "standing"]);
    const lost = decideSync(TOOL_POLICY, { decision: "requires_approval", reason: "Standing approval did not match" }, { run_id: null, recorder: { record: () => null } });
    expect([lost.verdict, lost.reason]).toEqual(["requires_approval", "standing_mismatch"]);
    expect(TOOL_POLICY.reasonCodes).toEqual(expect.arrayContaining(["standing", "standing_mismatch"]));
  });
```

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/policy/capability-policy-standing.test.ts tests/capabilities/capability-runner-standing.test.ts tests/decisions/tool-policy.test.ts` → FAIL (`actionFingerprint` not exported; `standing` echo missing; version 2).

- [ ] **Step 3: Implement.** `src/policy/capability-policy.ts`:
```ts
export interface CapabilityDecisionInput {
  /* existing fields … trust_ask?: boolean; */
  /** Stage 4A: the bridge's standing selector. It can satisfy a GATE only, and only when trust does not ask; the runner must still win the store CAS. */
  standing?: { standing_id: string };
}
export const TRUST_ASK_REASON = "Turn trust asks for a tap";
export const STANDING_REASON = "Standing approval authorised this call";
export const STANDING_MISMATCH_REASON = "Standing approval did not match";
export interface CapabilityDecision { decision: PolicyDecision; reason: string; /** echoed from the input on a gated ask with no trust ask: the runner's cue to try the CAS */ standing?: { standing_id: string } }
```
and the gated branch:
```ts
  if (input.approval_gates.includes(input.side_effect_level)) {
    // a trust ask beats standing: Paco approved these bytes on clean turns, not on one that read text aimed at the assistant
    const standing = input.standing !== undefined && input.trust_ask !== true ? { standing: input.standing } : {};
    return { decision: "requires_approval", reason: "Capability has gated side effects", ...standing };
  }
```
`src/decisions/entries/tool-policy.ts`: import `STANDING_MISMATCH_REASON, STANDING_REASON` from `../../policy/capability-policy.js`; `REASON_MAP` gains `[STANDING_REASON]: "standing", [STANDING_MISMATCH_REASON]: "standing_mismatch"`; `version: 3`; `reasonCodes` gains `"standing", "standing_mismatch"` (before `"allowed"`).

`src/capabilities/capability-runner.ts`: imports gain `type CapabilityDecision, STANDING_MISMATCH_REASON, STANDING_REASON` from `../policy/capability-policy.js`. Replace the sink interface and add the types from Interfaces (doc comment on `standingUse?`: `/** The store CAS behind a standing use (Stage 4A §7). A sink that cannot authorise one omits it; the runner then asks. */`). `CapabilityExecutionInput` gains:
```ts
  /** Stage 4A: the bridge's selector for a `standing` row of this run's schedule — authorised only by the sink's CAS. Outside `input`, so the fingerprint is unchanged. */
  standing?: { standing_id: string };
  /** Stage 4A: the fourth-run trial selector; rides the consume so the store can move candidate → sealing behind the same CAS. */
  standing_trial?: { standing_id: string };
```
In `execute`, move the three fingerprint lines (138–149) to just after the budget check (`if (!reservation.ok) return …`) and replace the inline hash with `const action_fingerprint = actionFingerprint(input.capability, metadata, input.input);`. Replace the `decideCapability` + `decideSync` block (106–121) with:
```ts
    const policy = decideCapability({
      capability: input.capability, category: metadata.category, side_effect_level: metadata.side_effect_level, risk_level: metadata.risk_level,
      allowed_actions: input.contract.allowed_actions, forbidden_actions: input.contract.forbidden_actions, approval_gates: input.contract.approval_gates,
      ...(input.trust_ask === true ? { trust_ask: true } : {}), ...(input.standing ? { standing: input.standing } : {})
    });
    // the approved resume's authority is the approval row, never the selector
    const decision = policy.standing && !input.approved_approval_id ? this.authoriseStanding(policy.standing.standing_id, input, action_fingerprint, ctx) : { decision: policy.decision, reason: policy.reason };
    decideSync(TOOL_POLICY, { decision: decision.decision, reason: decision.reason }, { run_id: input.run_id ?? null, tool_call_id: input.tool_call_id ?? null, recorder });
```
The consume call gains `...(input.standing_trial ? { standing_trial: input.standing_trial } : {})`. Add the method and the export:
```ts
  /**
   * The atomic authorisation at the execution boundary (§7): only a won store CAS turns the gate into an allow; a missing sink, a
   * missing CAS or a lost one asks. The CAS is consulted only when this call will run in the clean room — the adapter
   * selects the room from ctx.executor alone, so a grant is never spent on an ordinary shell.
   */
  private authoriseStanding(standing_id: string, input: CapabilityExecutionInput, action_fingerprint: string, ctx: SsrfContext | undefined): CapabilityDecision {
    if (ctx?.executor !== "cleanroom") return { decision: "requires_approval", reason: STANDING_MISMATCH_REASON };
    const use = this.approvals?.standingUse?.({ standing_id, action_fingerprint, run_id: input.run_id ?? "", tool_call_id: input.tool_call_id ?? `tool_${randomUUID()}` });
    return use?.ok ? { decision: "allow", reason: STANDING_REASON } : { decision: "requires_approval", reason: STANDING_MISMATCH_REASON };
  }
```
```ts
/** The action identity three approvals and a standing row are keyed on: canonical JSON of the adapter input, so key order never matters and one byte does. */
export function actionFingerprint(capability: string, metadata: Pick<ToolMetadata, "side_effect_level" | "risk_level">, input: Record<string, unknown>): string {
  return stableHash({ capability, side_effect_level: metadata.side_effect_level, risk_level: metadata.risk_level, affected_resources: [...affectedResources(input)].sort(), adapter_input_hash: stableHash(input) });
}
```
`src/omp/tool-approval-sink.ts` and `src/core/core-worker.ts:636–656` need **no edit** in this task: both optional fields are optional on the interface; the core-worker sink's return type is assignable (`sealing?` optional). Confirm with typecheck. `sealing?` carries the doc comment `/** Audit/test-only (Ruling 5): the store owns candidate → sealing; no production caller reads this. */`. `ctx` is the `SsrfContext` `execute` already resolves from its second/third argument (`capability-runner.ts:78–85`); `SsrfContext` is already imported there.

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/policy tests/capabilities/capability-runner*.test.ts tests/decisions/tool-policy.test.ts tests/decisions/record.test.ts tests/omp/bridge-handler*.test.ts` → PASS (the existing `capability-policy-trust.test.ts:22` still passes: the gated+trust answer has no `standing` key).

- [ ] **Step 5: Commit**
```bash
git add src/policy/capability-policy.ts src/decisions/entries/tool-policy.ts src/capabilities/capability-runner.ts tests/policy/capability-policy-standing.test.ts tests/capabilities/capability-runner-standing.test.ts tests/decisions/tool-policy.test.ts
git commit -m "feat(runner): actionFingerprint before policy; standing selector authorised only by the sink CAS; tool.policy v3 reason codes"
```

---

### Task 3: Store — consume hook (credit, candidate → sealing), deny hook, tap chat binding; omp sink forwards the trial

**Files:**
- Modify: `src/run/run-store.ts` (`consumeToolApproval` 6825–6852, `resolveToolApprovalWithinTransaction` 7841–7862, `processApprovalTrigger` 6703–6766, `resolveToolApprovalForTest` 6884–6898, `ApprovalErrorCode` 267–280, `approvalFailure` messages 10220)
- Modify: `src/omp/tool-approval-sink.ts` (`consumeApprovedApproval` 68–72)
- Modify: `src/gateway/gateway.ts` (`APPROVAL_REFUSAL_TEXT` 125–130: the `STANDING_HOOK_FAILED` line, Ruling 1)
- Test: `tests/run/run-store-standing.test.ts` (extend); `tests/run/omp-store.test.ts` (modify: line 85's consume result)

**Interfaces (Produces):**
```ts
export const STANDING_STREAK = 3;
export const STANDING_DENY_BLOCK_MS = 30 * 24 * 60 * 60 * 1000;
export const STANDING_STALE_MS = 30 * 24 * 60 * 60 * 1000;   // here, not in decisions/: the consume hook's stale check needs it and run-store never imports decisions/
/** A standing hook's SQL error inside an approval resolution: the resolution rolls back whole, an incident opens after the rollback, a refusal is returned (never a throw out of intake). */
export class StandingHookError extends Error { constructor(readonly detail: string) { super(`standing hook failed: ${detail}`); } }
consumeToolApproval(input: { approval_id; run_id; worker_id; capability; action_fingerprint; requester; now; standing_trial?: { standing_id: string } }): { ok: true; sealing: boolean } | { ok: false; code: string }   // `sealing`: audit/test-only, no production reader
type ApprovalErrorCode gains "APPROVAL_CHAT_MISMATCH"   // message "Approval must be answered from the run's own chat"
                      and "STANDING_HOOK_FAILED"     // message "A standing-approval check failed; the approval is still pending"
private creditAfterConsume(a: ToolApprovalRow, now: string, trial?: { standing_id: string }): boolean   // own transaction after the CAS: a credit fault never blocks the approved command
private openStandingIncident(kind: string, subject: string, detail: Record<string, unknown>): void     // one open incident per subject; never throws
private standingHookRefusal(approval_id: string, error: StandingHookError): ApprovalFailure
// gateway.ts APPROVAL_REFUSAL_TEXT gains STANDING_HOOK_FAILED
private standingCredit(a: ToolApprovalRow, now: string, trial?: { standing_id: string }): boolean
private standingKeyOf(run_id: string, a: Pick<ToolApprovalRow, "capability" | "action_fingerprint" | "summary">): StandingKey | null
private insertStreak(key: StandingKey, a: ToolApprovalRow, now: string): void
private startSealing(live: StandingApprovalRow, a: ToolApprovalRow, now: string): boolean
private standingDeny(a: ToolApprovalRow, now: string): void
private approvalChatBound(run_id: string, event: TypedTaskEvent): boolean
// tool-approval-sink.ts consumeApprovedApproval returns { ok: true, approval_id, state: "consumed", sealing: r.sealing }
```
Consumes: Task 1's `standingFor`, `standingDenied`, `endStandingTx`, `appendStandingLedgerEvent`, `StandingKey`, `StandingApprovalRow`; Task 2's `standing_trial` on the sink input.

- [ ] **Step 1: Failing tests** — append to `tests/run/run-store-standing.test.ts` (add imports `buildTypedTaskEvent, type Identity` from `../../src/domain/types.js`, `Gateway` from `../../src/gateway/gateway.js`, `STANDING_STALE_MS, STANDING_STREAK` from the store, `drainOutbox` from `../helpers/omp-worker.js`):

```ts
const PACO: Identity = { kind: "user", id: "paco" };
const FP = KEY.action_fingerprint; const WORKER = "planner:555:w";
// real-clock paths (resolveToolApprovalForTest, the lease) compare against Date.now(): fixtures are relative, never a literal year
const FUTURE = new Date(Date.now() + 90 * 86_400_000).toISOString();
const LEASE_S = 86_400 * 400; // the consume CAS checks lease_expires_at > the fixed NOW and > NOW + 30 d
const dropStanding = (s: RunStore) => (s as unknown as { db: { exec(sql: string): void } }).db.exec("DROP INDEX standing_deny_idx; DROP TABLE standing_approvals");
let n = 0;
/** A scheduled turn born through the real gateway, claimed so the consume CAS sees a live lease. */
function scheduledRun(s: RunStore, schedule_id = "sch_1", chat_id = "555"): string {
  const r = new Gateway(s).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post it", requested_by: { kind: "schedule", id: schedule_id },
    notify: { kind: "telegram", chat_id }, idempotency_key: `schedule:${schedule_id}:${++n}`, source_reference: `scheduled_tasks.${schedule_id}` }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  s.claimRun(r.run_id, WORKER, LEASE_S);
  return r.run_id;
}
function userRun(s: RunStore, chat_id = "555"): string {
  const r = new Gateway(s).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "post it", requested_by: PACO, notify: { kind: "telegram", chat_id },
    idempotency_key: `telegram:${++n}`, source_reference: `telegram:update:${n}:message:1` }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  s.claimRun(r.run_id, WORKER, LEASE_S);
  return r.run_id;
}
type ApprovalOverrides = Partial<Parameters<RunStore["createToolApproval"]>[0]>;
function pending(s: RunStore, run_id: string, o: ApprovalOverrides = {}): { approval_id: string; tool_call_id: string } {
  const tool_call_id = `tc_${++n}`;
  const row = s.createToolApproval({ run_id, worker_id: WORKER, tool_call_id, capability: "shell_external", input_hash: "ih", action_fingerprint: FP, requester: PACO, summary: "HTTP write",
    side_effect_level: "external_write", expires_at: FUTURE, ...o });
  return { approval_id: row.approval_id, tool_call_id };
}
function approved(s: RunStore, run_id: string, o: ApprovalOverrides = {}) { const p = pending(s, run_id, o); s.resolveToolApprovalForTest(p.approval_id, "approved"); return p; }
const consume = (s: RunStore, run_id: string, approval_id: string, x: { standing_trial?: { standing_id: string }; now?: string; capability?: string; action_fingerprint?: string } = {}) =>
  s.consumeToolApproval({ approval_id, run_id, worker_id: WORKER, capability: x.capability ?? "shell_external", action_fingerprint: x.action_fingerprint ?? FP, requester: PACO, now: x.now ?? NOW,
    ...(x.standing_trial ? { standing_trial: x.standing_trial } : {}) });
const streakEvents = (s: RunStore) => s.getLedgerEvents().filter((e) => e.event_type === "standing_streak").map((e) => e.payload.streak);

describe("consume hook (§6, §7): credits by distinct scheduled run", () => {
  it("three distinct runs: streak 1, 2, then candidate; a second consumed approval in the same run adds nothing; the approval ids are kept in order", () => {
    const s = RunStore.openInMemory();
    const ids: string[] = [];
    for (let i = 0; i < STANDING_STREAK; i++) {
      const run = scheduledRun(s); const a = approved(s, run); ids.push(a.approval_id);
      expect(consume(s, run, a.approval_id)).toEqual({ ok: true, sealing: false });
      if (i === 0) { const twice = approved(s, run, { action_fingerprint: FP }); expect(consume(s, run, twice.approval_id)).toEqual({ ok: true, sealing: false }); }
      expect(s.standingFor(KEY)).toMatchObject({ state: i + 1 < STANDING_STREAK ? "streak" : "candidate", capability: "shell_external", label: "HTTP write" });
      expect(JSON.parse(s.standingFor(KEY)!.credited_runs_json)).toHaveLength(i + 1);
    }
    expect(JSON.parse(s.standingFor(KEY)!.approval_ids_json)).toEqual(ids);
    expect(streakEvents(s)).toEqual([1, 2, 3]);
  });
  it("neutral consumes create no row: an expired approval, a user turn, shell_destructive, an unseen shell script, a different chat's bytes stay their own key", () => {
    const s = RunStore.openInMemory();
    const r1 = scheduledRun(s); const late = approved(s, r1);
    expect(consume(s, r1, late.approval_id, { now: new Date(Date.now() + 400 * 86_400_000).toISOString() })).toEqual({ ok: false, code: "expired" });
    const u = userRun(s); const ua = approved(s, u); expect(consume(s, u, ua.approval_id)).toEqual({ ok: true, sealing: false });
    const r2 = scheduledRun(s); const d = approved(s, r2, { capability: "shell_destructive", side_effect_level: "destructive" });
    expect(consume(s, r2, d.approval_id, { capability: "shell_destructive" })).toEqual({ ok: true, sealing: false });
    const r3 = scheduledRun(s); const un = approved(s, r3, { summary: "HTTP write, unseen shell script" });
    expect(consume(s, r3, un.approval_id)).toEqual({ ok: true, sealing: false });
    expect(s.listStandingApprovals()).toEqual([]);
    const r4 = scheduledRun(s, "sch_1", "556"); const other = approved(s, r4); consume(s, r4, other.approval_id);
    expect(s.listStandingApprovals().map((r) => r.chat_id)).toEqual(["556"]);
    expect(s.standingFor(KEY)).toBeUndefined();
  });
  it("a different fingerprint on the same schedule is a different key and does not touch this one", () => {
    const s = RunStore.openInMemory();
    const r = scheduledRun(s); const a = approved(s, r); consume(s, r, a.approval_id);
    const r2 = scheduledRun(s); const b = approved(s, r2, { action_fingerprint: "fp_other" }); consume(s, r2, b.approval_id, { action_fingerprint: "fp_other" });
    expect(JSON.parse(s.standingFor(KEY)!.credited_runs_json)).toEqual([r]);
    expect(s.standingFor({ ...KEY, action_fingerprint: "fp_other" })?.state).toBe("streak");
  });
  it("a streak idle 30 days is ended stale inside the consume, before any sweep, and the approval starts a fresh streak", () => {
    // after downtime no sweep has run: a consume must not refresh a dead streak into a candidate
    const s = RunStore.openInMemory();
    const r1 = scheduledRun(s); const a1 = approved(s, r1); consume(s, r1, a1.approval_id);
    const old = s.standingFor(KEY)!;
    const r2 = scheduledRun(s); const a2 = approved(s, r2);
    expect(consume(s, r2, a2.approval_id, { now: new Date(Date.parse(NOW) + STANDING_STALE_MS).toISOString() })).toEqual({ ok: true, sealing: false });
    expect(s.getStandingApproval(old.standing_id)).toMatchObject({ state: "ended", ended_reason: "stale" });
    const fresh = s.standingFor(KEY)!;
    expect(fresh.standing_id).not.toBe(old.standing_id);
    expect(JSON.parse(fresh.credited_runs_json)).toEqual([r2]);
  });
  it("a credit fault never blocks the approved command: the consume still wins, standing_credit_failed opens, nothing is credited", () => {
    const s = RunStore.openInMemory();
    const r = scheduledRun(s); const a = approved(s, r);
    dropStanding(s);
    expect(consume(s, r, a.approval_id)).toEqual({ ok: true, sealing: false });
    expect(s.getToolApproval(a.approval_id)?.state).toBe("consumed");
    expect(s.findOpenIncident(s.incidentFingerprint("standing_credit_failed", `approval:${a.approval_id}`))).toBeDefined();
    expect(s.getLedgerEvents(r).filter((e) => e.event_type === "standing_streak")).toEqual([]);
  });
});

describe("consume hook: candidate → sealing rides the fourth CAS", () => {
  function candidate(s: RunStore) { return s.insertStandingApprovalForTest({ ...KEY, state: "candidate", credited_runs_json: JSON.stringify(["r1", "r2", "r3"]), approval_ids_json: JSON.stringify(["a1", "a2", "a3"]) }); }
  it("with the bridge's trial selector the row becomes sealing, named by the approval row's tool_call_id, and the consume reports it", () => {
    const s = RunStore.openInMemory(); const c = candidate(s);
    const run = scheduledRun(s); const a = approved(s, run);
    expect(consume(s, run, a.approval_id, { standing_trial: { standing_id: c.standing_id } })).toEqual({ ok: true, sealing: true });
    expect(s.getStandingApproval(c.standing_id)).toMatchObject({ state: "sealing", sealing_approval_id: a.approval_id, sealed_run_id: run, sealed_tool_call_id: a.tool_call_id, sealing_started_at: NOW,
      approval_ids_json: JSON.stringify(["a1", "a2", "a3", a.approval_id]) });
    expect(s.getLedgerEvents(run).filter((e) => e.event_type === "standing_sealing").map((e) => e.payload)).toEqual([{ standing_id: c.standing_id, run_id: run, tool_call_id: a.tool_call_id, approval_id: a.approval_id }]);
  });
  it("without the selector (the bridge saw no clean room) or with a stale standing_id the candidate stays a candidate", () => {
    const s = RunStore.openInMemory(); const c = candidate(s);
    const run = scheduledRun(s); const a = approved(s, run);
    expect(consume(s, run, a.approval_id)).toEqual({ ok: true, sealing: false });
    const run2 = scheduledRun(s); const b = approved(s, run2);
    expect(consume(s, run2, b.approval_id, { standing_trial: { standing_id: "sa_stale" } })).toEqual({ ok: true, sealing: false });
    expect(s.getStandingApproval(c.standing_id)?.state).toBe("candidate");
  });
  it("a failed consume (lease lost) leaves the row candidate: sealing exists only behind a won CAS", () => {
    const s = RunStore.openInMemory(); const c = candidate(s);
    const run = scheduledRun(s); const a = approved(s, run);
    s.finishRun({ run_id: run, expected_worker_id: WORKER, next: "completed", report_ref: "r", duration_ms: 1, tool_calls: 0 }); // the lease is gone
    expect(consume(s, run, a.approval_id, { standing_trial: { standing_id: c.standing_id } })).toEqual({ ok: false, code: "lease_lost" });
    expect(s.getStandingApproval(c.standing_id)?.state).toBe("candidate");
  });
  it("sealing, standing: a consume is a no-op on the row", () => {
    const s = RunStore.openInMemory();
    for (const state of ["sealing", "standing"] as const) {
      const row = s.insertStandingApprovalForTest({ ...KEY, schedule_id: `sch_${state}`, state });
      const run = scheduledRun(s, `sch_${state}`); const a = approved(s, run);
      expect(consume(s, run, a.approval_id, { standing_trial: { standing_id: row.standing_id } })).toEqual({ ok: true, sealing: false });
      expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state, updated_at: row.updated_at });
    }
  });
});

describe("deny hook (§7): a denial anywhere on (chat, fingerprint)", () => {
  it("from a USER turn ends the schedule's standing row and its move with a 30-day block; a scheduled consume under the block creates no row; after it, a new streak", () => {
    const s = RunStore.openInMemory();
    const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    const row = s.insertStandingApprovalForTest({ ...KEY, state: "standing", move_id, expires_at: "2027-01-01T00:00:00.000Z" });
    const u = userRun(s); const p = pending(s, u);
    expect(s.resolveToolApprovalForTest(p.approval_id, "denied")).toMatchObject({ ok: true });
    const ended = s.getStandingApproval(row.standing_id)!;
    expect(ended).toMatchObject({ state: "ended", ended_reason: "denied" });
    expect(Date.parse(ended.denied_until!) - Date.parse(ended.ended_at!)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(s.getLadderMove(move_id)?.state).toBe("ended");
    const r = scheduledRun(s); const a = approved(s, r); consume(s, r, a.approval_id, { now: ended.ended_at! });
    expect(s.standingFor(KEY)).toBeUndefined();
    const r2 = scheduledRun(s); const b = approved(s, r2); consume(s, r2, b.approval_id, { now: new Date(Date.parse(ended.denied_until!) + 1_000).toISOString() });
    expect(s.standingFor(KEY)?.state).toBe("streak");
  });
  it("with no row: a scheduled run's denial inserts the ended row carrying the block; a user turn's denial inserts nothing", () => {
    const s = RunStore.openInMemory();
    const u = userRun(s); const pu = pending(s, u); s.resolveToolApprovalForTest(pu.approval_id, "denied");
    expect(s.listStandingApprovals()).toEqual([]);
    const r = scheduledRun(s); const pr = pending(s, r); s.resolveToolApprovalForTest(pr.approval_id, "denied");
    expect(s.listStandingApprovals()).toEqual([expect.objectContaining({ ...KEY, state: "ended", ended_reason: "denied", denied_until: expect.any(String) })]);
    expect(s.standingDenied("555", FP, NOW)).toBe(true);
  });
  it("a SQL error in the hook never throws out of intake: the resolution rolls back whole (still pending), standing_hook_failed opens, Paco is told to Revoke from /schedule", () => {
    // a throw here would leave the Telegram offset unadvanced: the same update redelivered forever, the kill switch behind it
    const s = RunStore.openInMemory();
    const r = scheduledRun(s); const p = pending(s, r);
    dropStanding(s);
    const deny = (k: number) => buildTypedTaskEvent({ source: "telegram", type: "deny", approval_id: p.approval_id, requested_by: PACO, notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: `telegram:deny:${p.approval_id}:${k}`, source_reference: `telegram:update:${k}:message:1` });
    expect(s.processApprovalTrigger({ event: deny(9), decision: "denied", resolved_at: NOW })).toMatchObject({ ok: false, error: { code: "STANDING_HOOK_FAILED" } });
    expect(s.getToolApproval(p.approval_id)?.state).toBe("pending");
    expect(s.findOpenIncident(s.incidentFingerprint("standing_hook_failed", `approval:${p.approval_id}`))).toBeDefined();
    expect(s.resolveToolApprovalForTest(p.approval_id, "denied")).toMatchObject({ ok: false, error: { code: "STANDING_HOOK_FAILED" } });
    // through the gateway: a refusal, not a throw, and its reply reaches Paco through the outbox (rich renderer)
    expect(new Gateway(s).intake(deny(10))).toMatchObject({ ok: false, error: { code: "STANDING_HOOK_FAILED" } });
    expect([...drainOutbox(s).values()].map((x) => String(x.text)).some((t) => t.includes("/schedule") && t.includes("Revoke"))).toBe(true);
    expect(s.getToolApproval(p.approval_id)?.state).toBe("pending");
  });
});

describe("tap chat binding (§7): a scheduled run's approval answers only from its notify chat", () => {
  const tap = (approval_id: string, notify: { kind: "telegram"; chat_id: string } | { kind: "local" }, type: "approve" | "deny" = "approve") => buildTypedTaskEvent({ source: "telegram", type, approval_id, requested_by: PACO, notify,
    idempotency_key: `telegram:${type}:${approval_id}:${JSON.stringify(notify)}`, source_reference: "telegram:update:1:message:1" });
  it("another chat or a local target resolves nothing and leaves the row pending; the run's chat resolves it", () => {
    const s = RunStore.openInMemory();
    const r = scheduledRun(s); const p = pending(s, r);
    expect(s.processApprovalTrigger({ event: tap(p.approval_id, { kind: "telegram", chat_id: "999" }), decision: "approved", resolved_at: NOW })).toMatchObject({ ok: false, error: { code: "APPROVAL_CHAT_MISMATCH" } });
    expect(s.processApprovalTrigger({ event: tap(p.approval_id, { kind: "local" }), decision: "approved", resolved_at: NOW })).toMatchObject({ ok: false, error: { code: "APPROVAL_CHAT_MISMATCH" } });
    expect(s.getToolApproval(p.approval_id)?.state).toBe("pending");
    expect(s.processApprovalTrigger({ event: tap(p.approval_id, { kind: "telegram", chat_id: "555" }), decision: "approved", resolved_at: NOW })).toMatchObject({ ok: true, run_id: r });
  });
  it("a user turn's approval keeps today's rule (identity only): a local target still resolves it", () => {
    const s = RunStore.openInMemory();
    const u = userRun(s); const p = pending(s, u);
    expect(s.processApprovalTrigger({ event: tap(p.approval_id, { kind: "local" }), decision: "approved", resolved_at: NOW })).toMatchObject({ ok: true });
  });
});
```

In `tests/run/omp-store.test.ts` line 85 becomes `expect(consume()).toEqual({ ok: true, sealing: false }); // a user turn earns no standing credit` (the consume now reports the trial transition; `toEqual` would otherwise fail on the new key).

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/run/run-store-standing.test.ts tests/run/omp-store.test.ts` → FAIL (no rows created; `STANDING_STALE_MS` missing; the hook throws instead of refusing; chat mismatch resolves; the consume returns `{ ok: true }`).

- [ ] **Step 3: Implement** in `src/run/run-store.ts`. Imports: add `import { UNSEEN_SCRIPT_LABEL } from "../omp/command-matcher.js";` (a leaf module with no imports — no cycle). Constants beside `AUTO_MOVE`:
```ts
/** Spec §6: distinct consumed scheduled runs that make a key a candidate; and the block a denial anywhere on the bytes sets. */
export const STANDING_STREAK = 3;
export const STANDING_DENY_BLOCK_MS = 30 * 24 * 60 * 60 * 1000;
/** A streak or candidate with no new credit this long is stale (spec §Decision 4): the consume hook (before it credits, since after downtime no sweep has run) and the sweep read it. */
export const STANDING_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export class StandingHookError extends Error { constructor(readonly detail: string) { super(`standing hook failed: ${detail}`); } }
```
`ApprovalErrorCode` gains `| "APPROVAL_CHAT_MISMATCH" | "STANDING_HOOK_FAILED"`; `approvalFailure`'s `messages` gains `APPROVAL_CHAT_MISMATCH: "Approval must be answered from the run's own chat"` and `STANDING_HOOK_FAILED: "A standing-approval check failed; the approval is still pending"`. `gateway.ts`'s `APPROVAL_REFUSAL_TEXT` gets **no** `APPROVAL_CHAT_MISMATCH` entry (a cross-chat tap stays silent like an idempotency conflict — no probe signal) and gains, per Ruling 1:
```ts
  // Stage 4A: a deny whose standing hook failed rolled back whole, so the command's standing approval (if any) was not ended — say so and point at Revoke
  STANDING_HOOK_FAILED: "not recorded — a standing-approval check failed, so it is still pending and a standing approval on this command may still be live. Tap again, or open /schedule and tap Revoke."
```
(`replyToApprovalRefusal` appends "Use /approvals to list live ones." and enqueues through the outbox — the rich renderer, keyed on the update so a redelivery replies once.)

`consumeToolApproval` becomes (Ruling 2: the CAS commits on its own, the credit follows in its own transaction):
```ts
  /**
   * The approved → consumed CAS (one guarded UPDATE, valid only while the same owner holds the lease) commits on its own; the
   * standing credit it earns runs after it in its own transaction (§7), so a credit fault never blocks the approved command. `sealing` is audit/test-only: no production reader.
   */
  consumeToolApproval(input: { approval_id: string; run_id: string; worker_id: string; capability: string; action_fingerprint: string; requester: Identity; now: string;
    standing_trial?: { standing_id: string } }): { ok: true; sealing: boolean } | { ok: false; code: string } {
    const row = this.getToolApproval(input.approval_id);
    if (!row || row.run_id !== input.run_id) return { ok: false, code: "unknown_approval" };
    if (row.state !== "approved") return { ok: false, code: "not_approved" };
    if (row.expires_at <= input.now) return { ok: false, code: "expired" };
    if (row.capability !== input.capability || row.action_fingerprint !== input.action_fingerprint) return { ok: false, code: "action_mismatch" };
    if (row.worker_id !== input.worker_id) return { ok: false, code: "owner_mismatch" };
    if (!sameIdentity(row.requester, input.requester)) return { ok: false, code: "requester_mismatch" };
    const updated = this.db.prepare(`
      UPDATE tool_approvals SET state = 'consumed', resolved_at = COALESCE(resolved_at, ?)
      WHERE approval_id = ? AND state = 'approved'
        AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND worker_id = ? AND state = 'running' AND lease_expires_at > ?)
    `).run(input.now, input.approval_id, input.run_id, input.worker_id, input.now);
    if (updated.changes !== 1) return { ok: false, code: "lease_lost" };
    return { ok: true, sealing: this.creditAfterConsume(row, input.now, input.standing_trial) };
  }
```
Private helpers (after it):
```ts
  /**
   * The credit's own transaction, after the consume committed — so a sealing row only ever follows a consumed fourth
   * approval. A fault rolls back the credit alone, opens standing_credit_failed and never blocks the approved command. A crash
   * between the two loses one credit (the next scheduled run credits). Callers (the two sinks) never hold a transaction here.
   */
  private creditAfterConsume(a: ToolApprovalRow, now: string, trial?: { standing_id: string }): boolean {
    try { return this.inTransaction(() => this.standingCredit(a, now, trial)); }
    catch (e) { this.openStandingIncident("standing_credit_failed", `approval:${a.approval_id}`, { error: e instanceof Error ? e.message : String(e) }); return false; }
  }
  /** One open incident per subject (a repeat touches it); never throws — it runs on paths that must not fail (the deny refusal, the credit fault). */
  private openStandingIncident(kind: string, subject: string, detail: Record<string, unknown>): void {
    try {
      const open = this.findOpenIncident(this.incidentFingerprint(kind, subject));
      if (open) this.touchIncident(open.incident_id, new Date().toISOString()); else this.openIncident({ kind, subject, detail });
    } catch (e) { console.error(`[standing] ${kind} not recorded: ${e instanceof Error ? e.message : String(e)}`); }
  }
  /** §6: one credit per distinct scheduled run; candidate at STANDING_STREAK; the fourth consume with the bridge's trial selector moves candidate → sealing. A no-op on sealing/sealed/standing. */
  private standingCredit(a: ToolApprovalRow, now: string, trial?: { standing_id: string }): boolean {
    const key = this.standingKeyOf(a.run_id, a);
    if (!key || this.standingDenied(key.chat_id, key.action_fingerprint, now)) return false;
    let live = this.standingFor(key);
    // a streak dead for 30 days is ended here, before it is credited (after downtime no sweep has run); this approval starts afresh
    if (live && (live.state === "streak" || live.state === "candidate") && live.updated_at <= new Date(Date.parse(now) - STANDING_STALE_MS).toISOString()) {
      this.endStandingTx({ standing_id: live.standing_id, reason: "stale", now }); live = undefined;
    }
    if (!live) { this.insertStreak(key, a, now); return false; }
    if (live.state !== "streak" && live.state !== "candidate") return false;
    const runs = JSON.parse(live.credited_runs_json) as string[];
    if (runs.includes(a.run_id)) return false; // a second approval in the same run adds nothing (Paco approved one run, not one call)
    if (live.state === "candidate") return trial?.standing_id === live.standing_id && this.startSealing(live, a, now);
    const credited = [...runs, a.run_id]; const ids = [...(JSON.parse(live.approval_ids_json) as string[]), a.approval_id];
    this.db.prepare(`UPDATE standing_approvals SET state = ?, credited_runs_json = ?, approval_ids_json = ?, updated_at = ? WHERE standing_id = ? AND state = 'streak'`)
      .run(credited.length >= STANDING_STREAK ? "candidate" : "streak", JSON.stringify(credited), JSON.stringify(ids), now, live.standing_id);
    this.appendStandingLedgerEvent("standing_streak", { standing_id: live.standing_id, run_id: a.run_id, approval_id: a.approval_id, streak: credited.length }, a.run_id);
    return false;
  }
  /** The key (§4), only for an eligible action on a scheduled run: shell_external, a label the matcher could read, a Telegram notify chat (the same source the bridge uses). */
  private standingKeyOf(run_id: string, a: Pick<ToolApprovalRow, "capability" | "action_fingerprint" | "summary">): StandingKey | null {
    const run = this.getRunForWorker(run_id);
    if (!run || run.source !== "schedule" || run.requested_by.kind !== "schedule" || run.notify.kind !== "telegram") return null;
    if (a.capability !== "shell_external" || a.summary.split(", ").includes(UNSEEN_SCRIPT_LABEL)) return null;
    return { schedule_id: run.requested_by.id, chat_id: run.notify.chat_id, action_fingerprint: a.action_fingerprint };
  }
  private insertStreak(key: StandingKey, a: ToolApprovalRow, now: string): void {
    const standing_id = `sa_${randomUUID()}`;
    this.db.prepare(`INSERT INTO standing_approvals (standing_id, schedule_id, chat_id, action_fingerprint, capability, label, state, credited_runs_json, approval_ids_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'streak', ?, ?, ?, ?)`).run(standing_id, key.schedule_id, key.chat_id, key.action_fingerprint, a.capability, a.summary, JSON.stringify([a.run_id]), JSON.stringify([a.approval_id]), now, now);
    this.appendStandingLedgerEvent("standing_streak", { standing_id, run_id: a.run_id, approval_id: a.approval_id, streak: 1 }, a.run_id);
  }
  /** candidate → sealing behind the fourth consume's CAS; the sealed call is the approval row's tool_call_id (unique per run, set by the omp sink). */
  private startSealing(live: StandingApprovalRow, a: ToolApprovalRow, now: string): boolean {
    if (this.getToolApproval(a.approval_id)?.state !== "consumed") return false; // only behind a committed consume: sealing never precedes the fourth approval's CAS
    const ids = [...(JSON.parse(live.approval_ids_json) as string[]), a.approval_id];
    const r = this.db.prepare(`UPDATE standing_approvals SET state = 'sealing', sealing_approval_id = ?, sealed_run_id = ?, sealed_tool_call_id = ?, sealing_started_at = ?, approval_ids_json = ?, updated_at = ?
      WHERE standing_id = ? AND state = 'candidate'`).run(a.approval_id, a.run_id, a.tool_call_id, now, JSON.stringify(ids), now, live.standing_id);
    if (r.changes !== 1) return false;
    this.appendStandingLedgerEvent("standing_sealing", { standing_id: live.standing_id, run_id: a.run_id, tool_call_id: a.tool_call_id, approval_id: a.approval_id }, a.run_id);
    return true;
  }
  /** §7 deny hook, plain statements in the caller's transaction: every live row of (chat, fingerprint) ends with the 30-day block; a scheduled run with no row gets an ended row carrying it. */
  private standingDeny(a: ToolApprovalRow, now: string): void {
    try {
      const run = this.getRunForWorker(a.run_id);
      if (!run || run.notify.kind !== "telegram") return;
      const until = new Date(Date.parse(now) + STANDING_DENY_BLOCK_MS).toISOString();
      const live = this.db.prepare(`SELECT standing_id FROM standing_approvals WHERE chat_id = ? AND action_fingerprint = ? AND state <> 'ended'`).all<{ standing_id: string }>(run.notify.chat_id, a.action_fingerprint);
      for (const { standing_id } of live) this.endStandingTx({ standing_id, reason: "denied", now, denied_until: until });
      if (live.length > 0) return;
      // only an eligible action on a scheduled run (the consume hook's own key rule) gets a row carrying the block alone; a denied fs_write never could stream
      const key = this.standingKeyOf(a.run_id, a);
      if (!key) return;
      const standing_id = `sa_${randomUUID()}`;
      this.db.prepare(`INSERT INTO standing_approvals (standing_id, schedule_id, chat_id, action_fingerprint, capability, label, state, denied_until, created_at, updated_at, ended_at, ended_reason)
        VALUES (?, ?, ?, ?, ?, ?, 'ended', ?, ?, ?, ?, 'denied')`).run(standing_id, key.schedule_id, key.chat_id, key.action_fingerprint, a.capability, a.summary, until, now, now, now);
      this.appendStandingLedgerEvent("standing_ended", { standing_id, reason: "denied" }, a.run_id);
    } catch (e) { throw new StandingHookError(e instanceof Error ? e.message : String(e)); }
  }
  /** §7: a scheduled run's approval is answered only from the run's own notify chat (the tap carries its chat as event.notify); a local or foreign target resolves nothing. */
  private approvalChatBound(run_id: string, event: TypedTaskEvent): boolean {
    const run = this.getRunForWorker(run_id);
    if (!run || run.source !== "schedule") return true;
    return run.notify.kind === "telegram" && event.notify.kind === "telegram" && event.notify.chat_id === run.notify.chat_id;
  }
```
`resolveToolApprovalWithinTransaction`: after `if (updated.changes !== 1) return approvalFailure("APPROVAL_NOT_PENDING");` insert `if (input.decision === "denied") this.standingDeny(row, input.resolved_at);`.

`processApprovalTrigger`: replace lines 6733–6735 with
```ts
      const tool = this.getToolApproval(resolveInput.approval_id);
      const result = tool && !this.approvalChatBound(tool.run_id, input.event) ? approvalFailure("APPROVAL_CHAT_MISMATCH")
        : tool ? this.resolveToolApprovalWithinTransaction(resolveInput) : this.resolveApprovalWithinTransaction(resolveInput);
```
and its `catch` becomes (Ruling 1 — never rethrow a hook failure out of intake):
```ts
    } catch (error) {
      if (activeTransaction) this.db.exec("ROLLBACK");
      if (error instanceof StandingHookError) return this.standingHookRefusal(input.event.approval_id ?? "", error);
      throw error;
    }
```
`resolveToolApprovalForTest`'s catch gets the same shape (`this.db.exec("ROLLBACK"); if (error instanceof StandingHookError) return this.standingHookRefusal(approval_id, error); throw error;`). The helper:
```ts
  /**
   * The deny hook never throws out of intake — a throw would leave the Telegram offset unadvanced and block every later
   * update, the kill switch included. The resolution already rolled back whole (the approval is still pending, any standing row
   * still live); the incident opens after the rollback, outside any transaction, and the refusal tells Paco through the gateway.
   */
  private standingHookRefusal(approval_id: string, error: StandingHookError): ApprovalFailure {
    this.openStandingIncident("standing_hook_failed", `approval:${approval_id}`, { hook: "deny", error: error.detail });
    return approvalFailure("STANDING_HOOK_FAILED");
  }
```
Nothing reaches `processed_triggers` on this path (the rollback took the dedupe row too), so a retap or a redelivery runs the hook again — intended.

`src/omp/tool-approval-sink.ts`:
```ts
    consumeApprovedApproval: (input) => {
      const r = deps.store.consumeToolApproval({ approval_id: input.approval_id, run_id: input.run_id, worker_id: deps.worker_id, capability: input.capability,
        action_fingerprint: input.action_fingerprint, requester: who(input.requester), now: input.consumed_at, ...(input.standing_trial ? { standing_trial: input.standing_trial } : {}) });
      return r.ok ? { ok: true, approval_id: input.approval_id, state: "consumed", sealing: r.sealing } : { ok: false, error: { code: r.code, message: r.code } };
    }
```

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/run tests/omp/bridge-handler*.test.ts tests/gateway && npm test` → PASS, 0 skipped. (`tests/run/run-store-approvals.test.ts` approves CLI runs with `notify: local` — those are not scheduled, so the binding leaves them alone.)

- [ ] **Step 5: Commit**
```bash
git add src/run/run-store.ts src/omp/tool-approval-sink.ts src/gateway/gateway.ts tests/run/run-store-standing.test.ts tests/run/omp-store.test.ts
git commit -m "feat(store): consume hook credits distinct scheduled runs and seals the fourth behind its CAS; deny hook with 30-day block; scheduled taps bound to the run's chat"
```

---

### Task 4: Store `standingUse` CAS and the omp sink's `standingUse`

**Files:**
- Modify: `src/run/run-store.ts` (after `startSealing`), `src/omp/tool-approval-sink.ts`
- Test: `tests/run/run-store-standing.test.ts` (extend). The sink's `standingUse` is a two-line mapping over this store method; Task 6's bridge tests drive it end to end through the real sink.

**Interfaces (Produces):**
```ts
export type StandingUseRefusal = "not_standing" | "fingerprint_mismatch" | "expired" | "move_inactive" | "schedule_not_enabled" | "schedule_mismatch" | "chat_mismatch" | "already_used" | "lost";
standingUse(i: { standing_id: string; action_fingerprint: string; run_id: string; tool_call_id: string; now: string }): { ok: true; move_id: string } | { ok: false; code: StandingUseRefusal }
private standingCallerRefusal(row: StandingApprovalRow, run_id: string): StandingUseRefusal | null   // decided before a fingerprint mismatch may end the row: a foreign run cannot revoke this key
private standingRowRefusal(row: StandingApprovalRow, now: string): StandingUseRefusal | null
// tool-approval-sink.ts: standingUse: (input) => store.standingUse({ ...input, now }) mapped to StandingUseResult
```
Consumes: Task 2's `StandingUseInput` / `StandingUseResult`; Task 1's rows and `endStandingTx`.

- [ ] **Step 1: Failing tests** — append to `tests/run/run-store-standing.test.ts`:

```ts
describe("standingUse CAS (§7): every eligibility fact re-read under one transaction, one use per run", () => {
  function standing(s: RunStore, o: Partial<StandingApprovalRow> = {}) {
    // the returned row, not listScheduledTasks()[0]: two schedules made at the same instant sort by random id
    const schedule_id = s.addScheduledTask({ chat_id: "555", goal: "post it", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z", now: NOW }).schedule_id;
    const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    const row = s.insertStandingApprovalForTest({ ...KEY, state: "standing", move_id, expires_at: FUTURE, ...o, schedule_id });
    return { row, schedule_id, move_id };
  }
  const use = (s: RunStore, standing_id: string, run_id: string, fp = FP, now = NOW) => s.standingUse({ standing_id, action_fingerprint: fp, run_id, tool_call_id: `tc_${++n}`, now });
  it("a use wins once per run: the second call in the same run is already_used; two runs of one schedule each get exactly one; the ledger names the move", () => {
    const s = RunStore.openInMemory(); const { row, schedule_id, move_id } = standing(s);
    const r1 = scheduledRun(s, schedule_id); const r2 = scheduledRun(s, schedule_id);
    expect(use(s, row.standing_id, r1)).toEqual({ ok: true, move_id });
    expect(use(s, row.standing_id, r1)).toEqual({ ok: false, code: "already_used" });
    expect(use(s, row.standing_id, r2)).toEqual({ ok: true, move_id });
    expect(s.getStandingApproval(row.standing_id)?.last_used_run_id).toBe(r2);
    expect(s.getLedgerEvents(r1).filter((e) => e.event_type === "standing_used").map((e) => e.payload)).toEqual([{ standing_id: row.standing_id, move_id, run_id: r1, tool_call_id: expect.any(String), action_fingerprint: FP }]);
  });
  it("refusal matrix: revoked row, expired, ended move, disabled schedule, wrong schedule, wrong chat, a user turn", () => {
    const s = RunStore.openInMemory(); const { row, schedule_id, move_id } = standing(s);
    const r = scheduledRun(s, schedule_id);
    expect(use(s, row.standing_id, r, FP, new Date(Date.now() + 400 * 86_400_000).toISOString())).toEqual({ ok: false, code: "expired" });
    expect(use(s, row.standing_id, scheduledRun(s, "sch_other"))).toEqual({ ok: false, code: "schedule_mismatch" });
    expect(use(s, row.standing_id, scheduledRun(s, schedule_id, "556"))).toEqual({ ok: false, code: "chat_mismatch" });
    expect(use(s, row.standing_id, userRun(s))).toEqual({ ok: false, code: "schedule_mismatch" });
    s.endLadderMove(move_id, NOW);
    expect(use(s, row.standing_id, r)).toEqual({ ok: false, code: "move_inactive" });
    const two = standing(s); // a second standing on a second schedule
    const r3 = scheduledRun(s, two.schedule_id);
    // raw SQL, not cancelScheduledTask (Task 8 makes cancel end the row too): the row stays standing, so only the schedule check refuses
    (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare(`UPDATE scheduled_tasks SET state = 'disabled' WHERE schedule_id = ?`).run(two.schedule_id);
    expect(use(s, two.row.standing_id, r3)).toEqual({ ok: false, code: "schedule_not_enabled" });
    expect(s.getStandingApproval(two.row.standing_id)?.state).toBe("standing");
    s.endStandingApproval({ standing_id: row.standing_id, reason: "revoked", now: NOW });
    expect(use(s, row.standing_id, r)).toEqual({ ok: false, code: "not_standing" });
    expect(use(s, "sa_missing", r)).toEqual({ ok: false, code: "not_standing" });
  });
  it("a fingerprint mismatch ends the row and its move (the bytes changed under a standing id — never silently allowed)", () => {
    const s = RunStore.openInMemory(); const { row, schedule_id, move_id } = standing(s);
    expect(use(s, row.standing_id, scheduledRun(s, schedule_id), "fp_changed")).toEqual({ ok: false, code: "fingerprint_mismatch" });
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "mismatch" });
    expect(s.getLadderMove(move_id)?.state).toBe("ended");
  });
  it("a foreign caller with changed bytes is refused on its binding and cannot end this key's grant", () => {
    // the caller's schedule and chat are checked before a mismatch may end the row: another schedule's run must not revoke it
    const s = RunStore.openInMemory(); const { row, schedule_id, move_id } = standing(s);
    expect(use(s, row.standing_id, scheduledRun(s, "sch_other"), "fp_changed")).toEqual({ ok: false, code: "schedule_mismatch" });
    expect(use(s, row.standing_id, scheduledRun(s, schedule_id, "556"), "fp_changed")).toEqual({ ok: false, code: "chat_mismatch" });
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("standing");
    expect(s.getLadderMove(move_id)?.state).toBe("active");
  });
});
```
(Add `type StandingApprovalRow` to the store import in the test file.)

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/run/run-store-standing.test.ts -t standingUse` → FAIL (`standingUse is not a function`).

- [ ] **Step 3: Implement** in `src/run/run-store.ts` (after `startSealing`):
```ts
export type StandingUseRefusal = "not_standing" | "fingerprint_mismatch" | "expired" | "move_inactive" | "schedule_not_enabled" | "schedule_mismatch" | "chat_mismatch" | "already_used" | "lost";
```
(place the type with the other standing types near line 1035) and the methods:
```ts
  /** §7: the atomic authorisation of one standing use. Every fact is re-read under one IMMEDIATE transaction; standing_uses' primary key is the per-run cap, so two concurrent runs of one schedule each get one. */
  standingUse(i: { standing_id: string; action_fingerprint: string; run_id: string; tool_call_id: string; now: string }): { ok: true; move_id: string } | { ok: false; code: StandingUseRefusal } {
    return this.inTransaction(() => {
      const row = this.getStandingApproval(i.standing_id);
      if (!row || row.state !== "standing" || !row.move_id) return { ok: false, code: "not_standing" };
      const foreign = this.standingCallerRefusal(row, i.run_id); // the caller's binding first, so a foreign run cannot end this row
      if (foreign) return { ok: false, code: foreign };
      if (row.action_fingerprint !== i.action_fingerprint) { this.endStandingTx({ standing_id: row.standing_id, reason: "mismatch", now: i.now }); return { ok: false, code: "fingerprint_mismatch" }; }
      const refused = this.standingRowRefusal(row, i.now);
      if (refused) return { ok: false, code: refused };
      try { this.db.prepare(`INSERT INTO standing_uses (standing_id, run_id, tool_call_id, used_at) VALUES (?, ?, ?, ?)`).run(row.standing_id, i.run_id, i.tool_call_id, i.now); }
      catch (e) { if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) return { ok: false, code: "already_used" }; throw e; }
      const r = this.db.prepare(`UPDATE standing_approvals SET last_used_run_id = ?, updated_at = ? WHERE standing_id = ? AND state = 'standing'`).run(i.run_id, i.now, row.standing_id);
      if (r.changes !== 1) return { ok: false, code: "lost" };
      this.appendStandingLedgerEvent("standing_used", { standing_id: row.standing_id, move_id: row.move_id, run_id: i.run_id, tool_call_id: i.tool_call_id, action_fingerprint: i.action_fingerprint }, i.run_id);
      return { ok: true, move_id: row.move_id };
    });
  }
  /** The run asking must be a run of the key's schedule, notifying the key's chat (the same columns the consume hook keyed on). */
  private standingCallerRefusal(row: StandingApprovalRow, run_id: string): StandingUseRefusal | null {
    const run = this.getRunForWorker(run_id);
    if (!run || run.requested_by.kind !== "schedule" || run.requested_by.id !== row.schedule_id) return "schedule_mismatch";
    if (run.notify.kind !== "telegram" || run.notify.chat_id !== row.chat_id) return "chat_mismatch";
    return null;
  }
  private standingRowRefusal(row: StandingApprovalRow, now: string): StandingUseRefusal | null {
    if (row.expires_at === null || row.expires_at <= now) return "expired";
    if (this.getLadderMove(row.move_id ?? "")?.state !== "active") return "move_inactive";
    if (this.getScheduledTask(row.schedule_id)?.state !== "enabled") return "schedule_not_enabled";
    return null;
  }
```
A refusal returned (not thrown) from the `inTransaction` callback commits an empty transaction — correct; the mismatch end is meant to commit. `src/omp/tool-approval-sink.ts` adds to the returned object:
```ts
    standingUse: (input) => {
      const r = deps.store.standingUse({ ...input, now: new Date().toISOString() });
      return r.ok ? { ok: true, move_id: r.move_id } : { ok: false, code: r.code };
    }
```

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/run/run-store-standing.test.ts tests/omp` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/run/run-store.ts src/omp/tool-approval-sink.ts tests/run/run-store-standing.test.ts
git commit -m "feat(store): standingUse CAS with the standing_uses per-run cap; omp sink authorises through it"
```

---

### Task 5: Seal facts at the source — `cleanroomFacts` / `tool_finished` gain `exit_code`, `truncated`, `check_failed`, `room`, `reason`

**Files:**
- Modify: `src/omp/bridge-handler.ts` (`CleanroomFacts` 232, `cleanroomFacts` 238–246)
- Test: `tests/omp/bridge-handler.test.ts` (230–280)

**Code says otherwise (resolved):** the existing test at `tests/omp/bridge-handler.test.ts:236` asserts `toEqual({ ran, torn_down, tampered, escaped })` with the comment "no room name, no body". The approved spec (§7, Rulings) adds `room` (a code-owned random basename from `mkdtempSync`, not a body) so `settleSealing` can be audited against the directory; the assertion is updated, the "no body" half is kept and strengthened (the MARKER and `check_error` text never reach the ledger).

**Interfaces (Produces):**
```ts
export type CleanroomFacts = { ran: boolean; torn_down: boolean; tampered: boolean; escaped: boolean; exit_code: number | null; truncated: boolean | null; check_failed: boolean; room?: string; reason?: string };
/** The adapter's bounded failure words (shell-adapter ShellFailure ∪ cleanroom-run CleanroomFailure); anything else is dropped, never copied. */
export const CLEANROOM_REASONS: ReadonlySet<string>;
```
Consumes: Slice 1's adapter output (`shell-adapter.ts:114–117`: `cleanroom.{room, ran, torn_down, tampered, escaped, check_error}`, top-level `exit_code`/`truncated` on success, `reason` on failure).

**`truncated` is three-valued:** the success arm always supplies a boolean today; an absent or non-boolean value (the failure arm, a malformed output, a regression) is `null` = unknown, and settlement refuses to seal on it (only `truncated === false` proves the output was whole).

- [ ] **Step 1: Failing tests** — in `tests/omp/bridge-handler.test.ts` replace lines 235–236 with (the top-level `executor` assertion stays: settlement keys on it):
```ts
    expect(fin).toMatchObject({ executor: "cleanroom", cleanroom: { ran: true, torn_down: true, tampered: false, escaped: false } });
    expect(fin?.cleanroom).toEqual({ ran: true, torn_down: true, tampered: false, escaped: false, exit_code: 0, truncated: false, check_failed: false, room: "room-x" }); // code-owned facts; no body
```
After the failed-arm test (ends line ~268) add:
```ts
  it("seal facts a settlement needs are bounded values: check_error becomes check_failed (its text stays out), reason only from the closed set, exit_code only an integer, truncated unknown unless a boolean, room only a mkdtemp name", async () => {
    const odd: Exec = async () => ({ ok: false, error: `bash wrapper_unknown ${MARKER}`, output: { ran: true, reason: "wrapper_unknown", executor: "cleanroom",
      cleanroom: { room: "../escape", ran: true, torn_down: true, tampered: false, escaped: false, check_error: `lsof: boom ${MARKER}` } } });
    const { handle, events, store, run_id } = setup({ shell: odd });
    await handle(call("bash", { command: "ls" }, "cr7"));
    expect(events("tool_finished").find((e) => e.tool_call_id === "cr7")?.cleanroom).toEqual({ ran: true, torn_down: true, tampered: false, escaped: false, exit_code: null, truncated: null, check_failed: true, reason: "wrapper_unknown" });
    expect(JSON.stringify(store.getLedgerEvents(run_id))).not.toContain(MARKER);
    const loose: Exec = async () => ({ ok: false, error: "bash x", output: { ran: false, reason: `made up ${MARKER}`, executor: "cleanroom", cleanroom: { ran: false, torn_down: true, tampered: false, escaped: false } } });
    const l = setup({ shell: loose });
    await l.handle(call("bash", { command: "ls" }, "cr8"));
    const f = l.events("tool_finished").find((e) => e.tool_call_id === "cr8")?.cleanroom as Record<string, unknown>;
    expect(f).not.toHaveProperty("reason"); expect(f).not.toHaveProperty("room"); expect(f.exit_code).toBeNull();
    const frac: Exec = async () => ({ ok: true, output: { exit_code: 1.5, output: "", truncated: "yes", executor: "cleanroom", cleanroom: { room: "room-abc123", ran: true, torn_down: true, tampered: false, escaped: false } } });
    const fr = setup({ shell: frac });
    await fr.handle(call("bash", { command: "ls" }, "cr9"));
    expect(fr.events("tool_finished").find((e) => e.tool_call_id === "cr9")?.cleanroom).toMatchObject({ exit_code: null, truncated: null, room: "room-abc123" }); // "yes" is not proof the output was whole
  });
```
Also update the failed-arm expectation at ~266–267 to `toMatchObject({ status: "failed", executor: "cleanroom", cleanroom: { ran: true, torn_down: false, tampered: true, escaped: true, exit_code: null, truncated: null, check_failed: false, reason: "timeout" } })` (the failure arm carries no `truncated`: unknown, not false).

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/omp/bridge-handler.test.ts -t "seal facts|failed sealed|aborted"` → FAIL.

- [ ] **Step 3: Implement** in `src/omp/bridge-handler.ts`:
```ts
/** A sealed run's code-owned facts (Stage 4A reads them from the ledger): the four Slice 1 booleans plus what the seal needs; never output bytes. */
export type CleanroomFacts = { ran: boolean; torn_down: boolean; tampered: boolean; escaped: boolean; exit_code: number | null; truncated: boolean | null; check_failed: boolean; room?: string; reason?: string };
/** The adapter's bounded failure words; a reason outside the set is dropped, never copied into the ledger. */
export const CLEANROOM_REASONS: ReadonlySet<string> = new Set(["timeout", "output_cap", "aborted", "limits_failed", "cleanup_failed", "wrapper_unknown", "spawn",
  "cleanroom_unavailable", "cleanroom_setup", "cleanroom_invalid", "cleanroom_tampered"]);
const ROOM_NAME = /^room-[A-Za-z0-9]+$/; // mkdtempSync's shape; a path or anything else is not a room name

function cleanroomFacts(entry: RegistryEntry, r: CapabilityResult): CleanroomFacts | undefined {
  if (!SHELL_ENTRIES.has(entry)) return undefined;
  const out = r.status === "succeeded" || r.status === "failed" || r.status === "cancelled" || r.status === "timed_out" ? r.output : undefined;
  if (out?.executor !== "cleanroom" || typeof out.cleanroom !== "object" || out.cleanroom === null) return undefined;
  const c = out.cleanroom as Record<string, unknown>;
  if (typeof c.ran !== "boolean" || typeof c.torn_down !== "boolean" || typeof c.tampered !== "boolean" || typeof c.escaped !== "boolean") return undefined;
  // truncated: only a boolean is a fact; absent or malformed is unknown (null), and a seal requires false
  // reason: the cleanroom/shell failure word is persisted as cleanroom.reason; tool_finished.reason (top level) is the bridge's own finish reason (e.g. cancelled) — keep them apart
  return { ran: c.ran, torn_down: c.torn_down, tampered: c.tampered, escaped: c.escaped, exit_code: Number.isInteger(out.exit_code) ? (out.exit_code as number) : null,
    truncated: typeof out.truncated === "boolean" ? out.truncated : null, check_failed: typeof c.check_error === "string" && c.check_error.length > 0,
    ...(typeof c.room === "string" && ROOM_NAME.test(c.room) ? { room: c.room } : {}), ...(typeof out.reason === "string" && CLEANROOM_REASONS.has(out.reason) ? { reason: out.reason } : {}) };
}
```
(`cleanroomFacts` stays under 50 lines; keep the existing doc comment above it.)

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/omp && npm test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/omp/bridge-handler.ts tests/omp/bridge-handler.test.ts
git commit -m "feat(omp): tool_finished seal facts gain exit_code, truncated, check_failed, room and the bounded reason"
```

---

### Task 6: Bridge selection — `standingFor` lookup, eligibility, selectors on the first/resume contexts, fourth-card line

**Files:**
- Modify: `src/omp/cleanroom-run.ts` (`available` 52–55 → exported `cleanroomAvailable`), `src/omp/bridge-handler.ts` (`approvalSink` 374–380, `executeWithApproval` 383–402)
- Test: `tests/omp/cleanroom-run.test.ts` (extend), `tests/omp/bridge-handler-standing.test.ts` (create)

**Interfaces (Produces):**
```ts
// cleanroom-run.ts
export function cleanroomAvailable(cfg: Pick<OmpConfig, "sandbox">): boolean   // false when !cfg.sandbox or /usr/bin/sandbox-exec is not executable; runCleanroomShell step 1 calls it
// bridge-handler.ts
export const STANDING_TRIAL_LINE = "You've approved this exact command on three runs. Approving this one runs it in a sealed folder; if it completes and its report reaches you, I stop asking for it on this schedule.";
type StandingSelect = { standing: { standing_id: string } } | { standing_trial: { standing_id: string } } | null;
function standingSelect(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, entry: RegistryEntry, command: string | undefined, ask: TrustAsk): StandingSelect
function approvalSink(deps, turn, req, command, preDetail, ask, policy, note?: string): ApprovalRequestSink   // `note` rides `reason` ("Why:") only when trust does not ask
```
Consumes: Task 2's `actionFingerprint`, `CapabilityExecutionInput.standing/standing_trial`; Task 1's `standingFor`; `UNSEEN_SCRIPT_LABEL`, `classifyCommand` (already imported), `SsrfContext.executor`.

**Eligibility (§4) as code:** `turn.requester.kind === "schedule"` (the key's `schedule_id` is `turn.requester.id`); `turn.chat_id` is the run's notify chat (`core-worker.ts:2249` derives it from `run.notify.chat_id` — the same column the store reads); `entry === "shell_external"`; a classified label without `unseen shell script`; `turn.trust !== undefined` and `!ask.ask` (`askFor` already folds level, `settleAsk` and masked reads into `ask`); posture was checked in `handleCall` before this point; `cleanroomAvailable(deps.cfg)`. Per-run cap, row state, expiry, move and schedule are the store CAS's (Task 4) — the bridge only reads `state`.

- [ ] **Step 1: Failing tests.** Append to `tests/omp/cleanroom-run.test.ts` (top-level):
```ts
describe("cleanroomAvailable", () => {
  it("is false with the sandbox off and otherwise exactly the executability of /usr/bin/sandbox-exec (a room without the sandbox would be an ordinary shell with a fake name)", () => {
    expect(cleanroomAvailable({ sandbox: false })).toBe(false);
    let exec = true; try { accessSync("/usr/bin/sandbox-exec", constants.X_OK); } catch { exec = false; }
    expect(cleanroomAvailable({ sandbox: true })).toBe(exec);
  });
});
```
(import `cleanroomAvailable` from `../../src/omp/cleanroom-run.js` and `accessSync, constants` from `node:fs`.)

Create `tests/omp/bridge-handler-standing.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { actionFingerprint } from "../../src/capabilities/capability-runner.js";
import { TurnTrust } from "../../src/decisions/trust.js";
import { buildTypedTaskEvent, type CompiledTaskContract, type Identity, type SideEffectLevel } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { createBridgeHandler, STANDING_TRIAL_LINE, type ActiveTurn, type BridgeHandlerDeps } from "../../src/omp/bridge-handler.js";
import type { BridgeRequest } from "../../src/omp/bridge-protocol.js";
import { classifyCommand, UNSEEN_SCRIPT_LABEL } from "../../src/omp/command-matcher.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { toolApprovalWaiters } from "../../src/omp/tool-approval-sink.js";
import { loadToolDeclarations, TOOL_DECLS_DIR, type ToolDeclaration } from "../../src/omp/tool-decls.js";
import { RunStore, type StandingApprovalRow } from "../../src/run/run-store.js";
import { ToolRegistry, type SsrfContext, type ToolMetadata } from "../../src/tools/tool-registry.js";
import { passThroughJudge } from "../helpers/omp-worker.js";

// Hermetic: availability is the sandbox flag alone here (the real predicate also probes /usr/bin/sandbox-exec; tested in cleanroom-run.test.ts).
vi.mock("../../src/omp/cleanroom-run.js", async (orig) => ({ ...(await orig<typeof import("../../src/omp/cleanroom-run.js")>()), cleanroomAvailable: (cfg: { sandbox: boolean }) => cfg.sandbox }));

// Stage 4A §7 bridge: a selector, never an authority. The fifth run of a standing key runs sealed with no card; the fourth (candidate)
// asks with the trial line and runs its approved resume sealed; an unscheduled turn, a hostile turn or a missing sandbox get today's path.
const PINNED_ENV = ["HOUGE_DUAL_LLM_ENABLED", "HOUGE_SCHEDULER_ENABLED", "HOUGE_HTTPFETCH_ENABLED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of PINNED_ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of PINNED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const ENVELOPE = ["web_search", "http_fetch", "shell", "shell_external", "shell_destructive", "fs_read", "fs_write", "write_report"];
const DECLS: ToolDeclaration[] = (() => { const r = loadToolDeclarations(TOOL_DECLS_DIR); if (!r.ok) throw new Error(r.error); return r.decls; })();
const PACO: Identity = { kind: "user", id: "paco" };
const CMD = "curl -s -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post";
const EXT_META = { side_effect_level: "external_write", risk_level: "medium" } as const;
const FUTURE = new Date(Date.now() + 90 * 86_400_000).toISOString(); // the sink's standingUse compares against the real clock
type Exec = NonNullable<ToolMetadata["execute"]>;
const meta = (name: string, side_effect_level: SideEffectLevel, execute: Exec): ToolMetadata => ({ name, category: "tool", side_effect_level, risk_level: side_effect_level === "external_write" ? "medium" : "low", timeout_ms: 5_000, output_limit_bytes: 64_000, execute });
let seq = 0;
interface Opts { scheduled?: boolean; sandbox?: boolean; hostile?: boolean }

function setup(o: Opts = {}) {
  const store = RunStore.openInMemory();
  // the schedule exists first: the use CAS checks the run's requester against an ENABLED schedule row
  const schedule_id = store.addScheduledTask({ chat_id: "555", goal: "post", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" }).schedule_id;
  const scheduled = o.scheduled !== false;
  const r = new Gateway(store).intake(buildTypedTaskEvent(scheduled
    ? { source: "schedule", type: "turn", program: "turn", goal: "post", requested_by: { kind: "schedule", id: schedule_id }, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `schedule:${schedule_id}:${++seq}`, source_reference: `scheduled_tasks.${schedule_id}` }
    : { source: "telegram", type: "turn", program: "turn", goal: "post", requested_by: PACO, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `telegram:${++seq}`, source_reference: `telegram:update:${seq}:message:1` }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  const run_id = r.run_id; const claim = store.claimRun(run_id, "planner:555:a", 120); if (!claim) throw new Error("claim failed");
  const contract: CompiledTaskContract = { ...claim.contract, allowed_actions: ENVELOPE, forbidden_actions: ["coding_agent_cli", "paid_action"], approval_gates: ["external_write", "destructive", "paid"], budget: { ...claim.contract.budget, max_tool_calls: 40 } };
  const seen: Array<SsrfContext | undefined> = [];
  const sealedOut = (ctx?: SsrfContext) => ctx?.executor === "cleanroom" ? { executor: "cleanroom", cleanroom: { room: "room-t", ran: true, torn_down: true, tampered: false, escaped: false } } : {};
  const shell: Exec = async (_i, _s, ctx) => { seen.push(ctx); return { ok: true, output: { exit_code: 0, output: "200", truncated: false, ...sealedOut(ctx) } }; };
  const registry = new ToolRegistry();
  registry.register(meta("shell", "local_write", shell)); registry.register(meta("shell_external", "external_write", shell)); registry.register(meta("shell_destructive", "destructive", shell));
  const awaiting: boolean[] = []; const dir = mkdtempSync(join(tmpdir(), "hbs-"));
  const trust = new TurnTrust({ store, run_id, chat_id: "555", born: scheduled ? "schedule" : "telegram", env: {} });
  if (o.hostile) trust.raise("injection_withheld", null);
  const turn: ActiveTurn = { run_id, worker_id: "planner:555:a", chat_id: "555", requester: scheduled ? { kind: "schedule", id: schedule_id } : PACO, contract, approver: PACO,
    budget: new BudgetLedger(contract.budget), registry, signal: new AbortController().signal, cwd: dir, step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: async (tool) => ({ digest: "d", contains_instructions: false, source_meta: { tool, bytes: 1 } }), setAwaitingApproval: (on) => { awaiting.push(on); }, postureOk: () => null, judge: passThroughJudge, trust };
  const deps: BridgeHandlerDeps = { store, cfg: { ...resolveOmpConfig({}), sandbox: o.sandbox !== false }, ctx: { home: join(dir, "home"), repo: join(dir, "repo"), data: join(dir, "data") }, decls: DECLS, env: {}, turnEnvelopeActions: ENVELOPE, activeTurn: () => turn };
  const handle = createBridgeHandler(deps);
  const events = (type: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === type).map((e) => e.payload);
  const decisions = () => store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "tool.policy").map((d) => [d.tool_call_id, d.verdict, d.reason_code]);
  const fp = actionFingerprint("shell_external", EXT_META, { command: CMD });
  const key = { schedule_id, chat_id: "555", action_fingerprint: fp };
  return { store, run_id, turn, handle, seen, awaiting, events, decisions, fp, key, schedule_id };
}
const call = (command: string, toolCallId = `tc${++seq}`): BridgeRequest => ({ id: `r${++seq}`, kind: "call", tool: "bash", input: { command }, toolCallId });
type CallResult = { content: string; isError: boolean };
async function pendingApproval(store: RunStore, awaiting: boolean[]): Promise<string> {
  await vi.waitFor(() => { expect(awaiting).toContain(true); });
  const id = store.listPendingApprovalIds()[0]; if (!id) throw new Error("no pending approval"); return id;
}
function decide(store: RunStore, id: string, decision: "approved" | "denied"): void { store.resolveToolApprovalForTest(id, decision); toolApprovalWaiters.resolve(id, decision); }
function standingRow(s: ReturnType<typeof setup>, o: Partial<StandingApprovalRow> = {}) {
  const move_id = s.store.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
  return s.store.insertStandingApprovalForTest({ ...s.key, state: "standing", move_id, expires_at: FUTURE, ...o });
}

describe("bridge standing selection", () => {
  it("the fifth run: no approval_requested, decision reason standing, executor cleanroom on the first context, one standing_used; a sixth call in the same run asks (standing_mismatch)", async () => {
    const s = setup();
    const row = standingRow(s);
    const r = (await s.handle(call(CMD, "c5"))) as CallResult;
    expect(r.isError).toBe(false);
    expect(s.events("approval_requested")).toEqual([]);
    expect(s.seen[0]).toMatchObject({ run_id: s.run_id, tool_call_id: "c5", executor: "cleanroom" });
    expect(s.decisions()).toEqual([["c5", "allowed", "standing"]]);
    expect(s.events("standing_used")).toEqual([expect.objectContaining({ standing_id: row.standing_id, run_id: s.run_id, tool_call_id: "c5", action_fingerprint: s.fp })]);
    expect(s.events("tool_finished")[0]).toMatchObject({ executor: "cleanroom" });
    const sixth = s.handle(call(CMD, "c6")) as Promise<CallResult>;
    decide(s.store, await pendingApproval(s.store, s.awaiting), "approved");
    expect((await sixth).isError).toBe(false);
    expect(s.decisions().find((d) => d[0] === "c6")).toEqual(["c6", "requires_approval", "standing_mismatch"]);
    expect(s.events("standing_used")).toHaveLength(1);
  });
  it("the fourth run (candidate): the first call asks with the trial line and no executor; the approved resume runs sealed and the row is sealing on this call", async () => {
    const s = setup();
    const c = s.store.insertStandingApprovalForTest({ ...s.key, state: "candidate", credited_runs_json: JSON.stringify(["r1", "r2", "r3"]) });
    const p = s.handle(call(CMD, "c4")) as Promise<CallResult>;
    const id = await pendingApproval(s.store, s.awaiting);
    const card = s.store.claimNextNotification("t", 30);
    expect(String(card?.payload.text)).toContain(`Why: ${STANDING_TRIAL_LINE}`);
    decide(s.store, id, "approved");
    expect((await p).isError).toBe(false);
    expect(s.seen).toHaveLength(1); expect(s.seen[0]).toMatchObject({ executor: "cleanroom" });
    expect(s.store.getStandingApproval(c.standing_id)).toMatchObject({ state: "sealing", sealed_run_id: s.run_id, sealed_tool_call_id: "c4", sealing_approval_id: id });
    expect(s.events("approval_requested")[0]).toMatchObject({ action_fingerprint: s.fp }); // the sealed fourth call's fingerprint is the streak's
  });
  it("a candidate row ended during the wait: the call still runs sealed (the card promised a sealed folder) but earns no sealing row", async () => {
    const s = setup();
    const c = s.store.insertStandingApprovalForTest({ ...s.key, state: "candidate" });
    const p = s.handle(call(CMD, "c4b")) as Promise<CallResult>;
    const id = await pendingApproval(s.store, s.awaiting);
    s.store.endStandingApproval({ standing_id: c.standing_id, reason: "denied", now: new Date().toISOString() });
    decide(s.store, id, "approved");
    expect((await p).isError).toBe(false);
    expect(s.events("tool_finished")[0]).toMatchObject({ executor: "cleanroom" });
    expect(s.events("standing_sealing")).toEqual([]);
    expect(s.store.getStandingApproval(c.standing_id)?.state).toBe("ended");
  });
  it("no selector: an unscheduled turn on the same bytes, a hostile scheduled turn, the sandbox off — each asks as today with no executor", async () => {
    for (const o of [{ scheduled: false }, { hostile: true }, { sandbox: false }] as Opts[]) {
      const s = setup(o);
      // the unscheduled turn's requester is { kind: "user", id: "paco" }: a row keyed on schedule "paco" is what a lookup without the
      // requester-kind guard would find, so the guard (not the key) is what this case pins
      standingRow(s, o.scheduled === false ? { schedule_id: "paco" } : {});
      const p = s.handle(call(CMD)) as Promise<CallResult>;
      decide(s.store, await pendingApproval(s.store, s.awaiting), "approved");
      await p;
      expect(s.events("approval_requested")).toHaveLength(1);
      expect(s.seen[0]).not.toHaveProperty("executor");
      expect(s.events("standing_used")).toEqual([]);
      expect(s.store.claimNextNotification("t", 30)?.payload.text).not.toContain(STANDING_TRIAL_LINE);
    }
  });
  it("a command the matcher cannot read (an unseen shell script) never selects, even with a standing row on its exact bytes", async () => {
    const UNSEEN = "curl -s -X POST -d a=1 https://httpbin.org/post | sh";
    expect(classifyCommand(UNSEEN)).toEqual({ kind: "external_write", label: `HTTP write, ${UNSEEN_SCRIPT_LABEL}` }); // it reaches shell_external
    const s = setup();
    standingRow(s, { action_fingerprint: actionFingerprint("shell_external", EXT_META, { command: UNSEEN }) });
    const p = s.handle(call(UNSEEN)) as Promise<CallResult>;
    decide(s.store, await pendingApproval(s.store, s.awaiting), "approved");
    await p;
    expect(s.events("approval_requested")).toHaveLength(1);
    expect(s.seen[0]).not.toHaveProperty("executor");
    expect(s.events("standing_used")).toEqual([]);
  });
  it("a plain or destructive command never selects, whatever rows exist", async () => {
    const s = setup();
    s.store.insertStandingApprovalForTest({ ...s.key, action_fingerprint: actionFingerprint("shell", { side_effect_level: "local_write", risk_level: "low" }, { command: "ls" }), state: "standing" });
    expect(((await s.handle(call("ls"))) as CallResult).isError).toBe(false);
    expect(s.seen[0]).not.toHaveProperty("executor"); expect(s.decisions()[0]?.[2]).toBe("allowed");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/omp/cleanroom-run.test.ts tests/omp/bridge-handler-standing.test.ts` → FAIL (`cleanroomAvailable`/`STANDING_TRIAL_LINE` not exported; the fifth run asks).

- [ ] **Step 3: Implement.** `src/omp/cleanroom-run.ts`: rename `available` → `export function cleanroomAvailable` (keep the doc comment; update the one call site in `runCleanroomShell`). `src/omp/bridge-handler.ts`: imports gain `actionFingerprint` (from the runner import line), `cleanroomAvailable` from `./cleanroom-run.js`, `UNSEEN_SCRIPT_LABEL` from `./command-matcher.js`. Add:
```ts
/** The fourth-run card's "Why:" line (spec §8); only when the clean room is available at that moment, else the plain card. */
export const STANDING_TRIAL_LINE = "You've approved this exact command on three runs. Approving this one runs it in a sealed folder; if it completes and its report reaches you, I stop asking for it on this schedule.";
type StandingSelect = { standing: { standing_id: string } } | { standing_trial: { standing_id: string } } | null;

/**
 * Stage 4A §4/§7, a selector only: the store CAS (runner) and the consume CAS (store) decide. Scheduled shell_external with a
 * readable label, trust not asking, the room available; the key's chat is turn.chat_id — the run's notify chat, the column the store reads.
 */
function standingSelect(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, entry: RegistryEntry, command: string | undefined, ask: TrustAsk): StandingSelect {
  if (turn.requester.kind !== "schedule" || entry !== "shell_external" || command === undefined || turn.trust === undefined || ask.ask) return null;
  const c = classifyCommand(command);
  if (c.kind === "plain" || c.label.split(", ").includes(UNSEEN_SCRIPT_LABEL)) return null;
  const meta = turn.registry.get(entry);
  if (!meta || !cleanroomAvailable(deps.cfg)) return null;
  const row = deps.store.standingFor({ schedule_id: turn.requester.id, chat_id: turn.chat_id, action_fingerprint: actionFingerprint(entry, meta, req.input) });
  if (row?.state === "standing") return { standing: { standing_id: row.standing_id } };
  return row?.state === "candidate" ? { standing_trial: { standing_id: row.standing_id } } : null;
}
```
`approvalSink` gains a last parameter `note?: string` and builds `...(ask.ask ? { reason: ask.reason } : note !== undefined ? { reason: note } : {})` in place of `...(ask.ask ? { reason: ask.reason } : {})`. `executeWithApproval` becomes:
```ts
async function executeWithApproval(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, entry: RegistryEntry, preDetail: string | undefined, ask: TrustAsk): Promise<Executed> {
  const command = req.tool === "bash" && typeof req.input.command === "string" ? req.input.command : undefined;
  const policy = waitPolicy(deps, turn, entry, ask);
  if (policy.pause.pause === "bounded" && policy.timeoutMs < Math.min(TRUST_WAIT_MIN_MS, policy.pause.ttlMs)) return { refusal: { reason: "trust_ask_no_time", text: TRUST_ASK_NO_TIME_TEXT } };
  const select = standingSelect(deps, turn, req, entry, command, ask);
  const runner = new CapabilityRunner(turn.registry, approvalSink(deps, turn, req, command, preDetail, ask, policy, select && "standing_trial" in select ? STANDING_TRIAL_LINE : undefined));
  const base: CapabilityExecutionInput = { run_id: turn.run_id, requester: turn.requester, contract: turn.contract, capability: entry,
    input: req.input, budget: turn.budget, signal: turn.signal, tool_call_id: req.toolCallId, action_summary: summaryFor(deps, turn, req.toolCallId, req.tool, command),
    recorder: storeRecorder(deps.store, { env: deps.env }), ...(ask.ask ? { trust_ask: true } : {}), ...(select ?? {}) };
  // the room is selected on the standing use at once and on any selector's approved resume (the stricter execution, even when the CAS lost meanwhile); a trial's first call asks unsealed
  const ctx = (room: boolean): SsrfContext => ({ run_id: turn.run_id, tool_call_id: req.toolCallId, ...(base.recorder ? { recorder: base.recorder } : {}), ...(room ? { executor: "cleanroom" as const } : {}) });
  const first = await runner.execute(base, turn.signal, ctx(select !== null && "standing" in select));
  if (first.status !== "requires_approval") return { result: first };
  if (policy.trustTap) countTrustAsk(deps.store, deps.env, new Date().toISOString()); // added taps only (spec §7.2)
  const outcome = await awaitApproval(turn, first.approval_id, policy);
  if (outcome === "approved") return { result: await runner.execute({ ...base, approved_approval_id: first.approval_id, budget_reserved: true }, turn.signal, ctx(select !== null)) };
  if (outcome === "denied") return { refusal: { reason: "denied_by_paco", text: APPROVAL_DENIED_TEXT } };
  deps.store.expireToolApproval(first.approval_id, new Date().toISOString());
  if (outcome === "expired") recordApprovalExpired(deps.store, { run_id: turn.run_id, approval_id: first.approval_id }); // an aborted wait is not Paco's silence
  const trustExpired = outcome === "expired" && policy.pause.pause === "bounded";
  return { refusal: { reason: `approval_${outcome}`, text: trustExpired ? TRUST_ASK_EXPIRED_TEXT : APPROVAL_EXPIRED_TEXT } };
}
```
(import `type SsrfContext` from `../tools/tool-registry.js` beside `ToolRegistry`.) The existing test "the bridge never sets executor on the runtime context" (bridge-handler.test.ts:217) keeps passing: its turn's requester is a user.

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/omp && npm test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/omp/cleanroom-run.ts src/omp/bridge-handler.ts tests/omp/cleanroom-run.test.ts tests/omp/bridge-handler-standing.test.ts
git commit -m "feat(omp): bridge selects standing / standing_trial for a scheduled shell_external call; room on the use and the approved resume; trial line on the fourth card"
```

---

### Task 7: Settlement — `sealVerdict`, `settleSealing` (immediate auto grant, Decision 1-A), the dispatcher hook, the per-cycle sweep

**Files:**
- Create: `src/decisions/standing-approval.ts`
- Modify: `src/run/run-store.ts` (after `standingRowRefusal`, Task 4: `markStandingGranted`, `resetStandingToCandidate`, `setStandingGrantNotification`, `listStandingUses`)
- Modify: `src/decisions/urgent.ts` (`enqueueUrgentCard` 11–16 returns the notification id)
- Modify: `src/notifications/notification-dispatcher.ts` (`NotificationDispatcherOptions` 14–17, `dispatchOnce` 46–49)
- Modify: `src/telegram/telegram-daemon.ts` (dispatcher construction 249–252 → the new export `createOutboxDispatcher`)
- Modify: `src/run/schedule-tick.ts` (`maybeFireScheduledTasks` 66–69)
- Test: `tests/decisions/standing-approval.test.ts` (create), `tests/notifications/notification-dispatcher.test.ts` (extend), `tests/telegram/telegram-daemon-standing.test.ts` (create), `tests/run/schedule-tick.test.ts` (extend)

**Code says otherwise (resolved here):**
- Spec §7 says the dispatcher "invokes settleSealing after markDelivered returns". `NotificationDispatcher` holds only a `NotificationOutbox` (`notification-dispatcher.ts:31`), no store and no incident sink. The plan adds an `onDelivered` option the dispatcher calls **after** `markDelivered` committed (inside its own try/catch, so a throw never reaches the `markFailed` arm at `:50–58` and never reclassifies the delivered row); the daemon builds its one sender through the new export `createOutboxDispatcher(store, adapters)`, whose hook is `settleDeliveredReport` (it settles the run's sealed trial and its standing uses in their own transactions and opens `standing_settle_failed` on a throw). The daemon must build its sender **only** through it: a structural test pins that `telegram-daemon.ts` holds no other `new NotificationDispatcher(` (a bare dispatcher would deliver without settling, and every other test would stay green). `src/cli.ts:135` and `src/telegram/telegram-poll-runner.ts:232` construct dispatchers without the hook: a report they deliver is settled by the sweep on the next daemon cycle (well inside the 24 h TTL).
- Spec §7 asks for a "per-minute sweep … before the scheduler-flag early return in `schedule-tick.ts`, or its own hook". The daemon has no per-minute timer: `runSignalPathTick` runs once per poll cycle (`telegram-daemon.ts:339`, ~30 s long-poll plus the cycle's ticks), and `maybeFireScheduledTasks` is its last model tick (`:673`). **Chosen: `schedule-tick.ts`, as the first statement of `maybeFireScheduledTasks`, before `resolveSchedulerEnabled` (`:69`).** Why: (1) the rows are keyed on schedules and this is the schedules' tick; (2) before the flag, so a scheduler switched off (the live case: the Alishan schedule is disabled and the flag is off) still settles, expires and ends rows; (3) before this cycle's fires, so a fire in the same cycle already sees a sealing row settled or a dead row ended; (4) its own try/catch, so a sweep error never blocks a fire. Cost, stated: a cycle with slow model ticks delays the sweep by those minutes; every bound it enforces is ≥ 24 h, and the prompt path is the dispatcher hook.
- Spec §6 has a `sealed` state between `sealing` and `standing`. Under Decision 1-A nothing waits in it: `markStandingGranted` moves `sealing → standing` in one CAS and the `standing_sealed` ledger event marks the sealed point (the DDL keeps `'sealed'` in the CHECK for audit compatibility; no code writes it).
- Ruling 6 (the grant re-reads its evidence) runs **only on a `seal` verdict**: a trial that failed its facts ends `sealed_trial_failed` from `sealVerdict` and never reaches the evidence read, so the live gate's `noSeal` cases (seeded candidates with fabricated credited ids) end for the reason they test, not for missing evidence. The re-read lives in `standing-approval.ts` (`grantEvidence`), inside `grantStanding`'s `inTransaction` and before `markStandingGranted`, using plain store getters — the seal conjunction stays in one module. The row is re-read inside that transaction (not the row `settleSealing` listed): a reset and a newer fourth approval in between make it another trial, which is `lost` — never granted or ended on the older trial's evidence (an interleaved test pins it).
- Ruling 3 (post-grant tamper) is `settleStandingUses` here, beside `settleSealing`: `settleDeliveredReport` calls it for the delivered run, and `runStandingSweep` calls it for every `standing_uses` run of each `standing` row. Ending wins over notifying: the row ends in its own transaction, then the urgent card is queued; a card conflict opens `standing_card_failed` and never revives the grant. `settleDeliveredReport` runs the two settlements under separate catches (`standing_settle_failed` on `run:<id>` and `uses:<id>`), so a failed trial settle never skips the standing-use check.
- The ladder move needs "the sealed call's decision id" (§7 Grant). The recorder dedups one `tool.policy` row per `(run, tool_call_id, verdict)` (`run-store.ts:4938`); the sealed call has its `requires_approval` row from the first execute. The plan takes the **latest** `tool.policy` row for `(sealed_run_id, sealed_tool_call_id)`; none recorded (recorder failure) = facts missing = `ended(sealed_trial_failed)`, never a grant with a hole in its evidence.

**Interfaces (Produces):**
```ts
// run-store.ts
markStandingGranted(i: { standing_id: string; evidence: string[]; expires_at: string; now: string; facts: Record<string, unknown> }): string | null   // move_id; null when the row is no longer sealing; called only inside grantStanding's evidence-checking transaction
listStandingUses(standing_id: string): Array<{ run_id: string; tool_call_id: string; used_at: string }>
resetStandingToCandidate(i: { standing_id: string; now: string; reason: string }): boolean
setStandingGrantNotification(standing_id: string, notification_id: string, now: string): void
// urgent.ts
export function enqueueUrgentCard(store: RunStore, c: UrgentCard): string | null     // the outbox row id (queued or duplicate); null on an idempotency conflict
// standing-approval.ts
export const SA_PREFIX = "dec:sa:";
export const STANDING_EXPIRY_MS: number;      // 30 d
// STANDING_STALE_MS is run-store's (Task 3); Task 8's endStale imports it from there
export const SEALING_TTL_MS: number;          // 24 h
export const PRE_SPAWN_REASONS: ReadonlySet<string>;   // cleanroom_unavailable, cleanroom_setup, cleanroom_invalid, cleanroom_tampered, aborted, spawn
export type SealVerdict = "seal" | "reset" | "end" | "wait";
export interface SealInput { fin: Record<string, unknown> | undefined; run_state: string | undefined; outbox: string | undefined; decision_id: string | undefined; started_at: string; now: string }
export function sealVerdict(i: SealInput): SealVerdict
export interface SettleOutcome { standing_id: string; verdict: SealVerdict }                 // a seal whose evidence re-read fails reports "end"; a trial that changed before the grant's transaction reports "wait"
export function settleSealing(store: RunStore, run_id: string, now?: string): SettleOutcome[]   // throws when a grant card conflicts (no grant without its Revoke card); callers catch
export function settleStandingUses(store: RunStore, run_id: string, now?: string): number      // grants ended tampered_use (a broken seal on a standing use)
export function tamperedUseText(label: string): string
export function settleDeliveredReport(store: RunStore, record: Pick<NotificationRecord, "intent_type" | "idempotency_key" | "run_id">, env?: NodeJS.ProcessEnv, now?: string): void   // settles the trial and the run's standing uses
export interface StandingSweepResult { settled: number; ended: number }
export function runStandingSweep(store: RunStore, now: string): StandingSweepResult      // Task 7: sealing rows + tampered uses; Task 8 adds expiry / schedule end / stale
export function grantCardText(i: { label: string; schedule: string; expires_local: string }): string
export function revokeButton(standing_id: string, text?: string): NotificationButton
// notification-dispatcher.ts
export interface NotificationDispatcherOptions { lease_ttl_seconds?: number; max_attempts?: number; onDelivered?: (record: NotificationRecord) => void }
// telegram-daemon.ts
export function createOutboxDispatcher(store: RunStore, adapters: NotificationAdapters): NotificationDispatcher
// schedule-tick.ts: maybeFireScheduledTasks runs runStandingSweep first (own catch → standing_sweep_failed incident)
```
Consumes: Task 1 `listStandingApprovals`, `getStandingApproval`, `finalReportState`, `endStandingApproval`, `appendStandingLedgerEvent`, `StandingApprovalRow`; Task 3 `STANDING_STREAK`, `consumeToolApproval` with `standing_trial` (the fixture earns its rows through it), Task 4 `standingUse` (the tamper fixture), the `sealing` row fields (`sealing_approval_id`, `sealed_run_id`, `sealed_tool_call_id`, `sealing_started_at`, `approval_ids_json` = three credited ids + the sealing one); Task 5 `CleanroomFacts` (the `tool_finished.cleanroom` payload: `ran, torn_down, tampered, escaped, exit_code, truncated (boolean | null), check_failed, room?, reason?`) and `CLEANROOM_REASONS`; existing `findRunState` (`run-store.ts:1672`), `getToolApproval`, `getRunForWorker` (`:7563`), `type ToolApprovalRow` (`:182`), `listDecisionsForRun` (`:4950`), `insertLadderMove` (`:5034`), `openAlertedIncident` (`incident-alert.ts:28`), `scheduleDisplayName` (`schedule-spec.ts:219`).

- [ ] **Step 1: Failing tests.** Create `tests/decisions/standing-approval.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent, type Identity } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { CLEANROOM_REASONS } from "../../src/omp/bridge-handler.js";
import { PRE_SPAWN_REASONS, revokeButton, runStandingSweep, SA_PREFIX, SEALING_TTL_MS, sealVerdict, settleDeliveredReport, settleSealing, settleStandingUses, type SealInput } from "../../src/decisions/standing-approval.js";
import { RunStore } from "../../src/run/run-store.js";

// Stage 4A §7 (Decision 1-A): a sealing row grants only when every code-owned fact of the ONE sealed call is true, the run
// completed AND its terminal notice was delivered inside the 24 h TTL; delivery alone proves receipt, not success (§2: failed
// runs deliver too). Nothing ran (a pre-spawn reason with ran:false) puts the key back to candidate; anything else ends it.
// The grant re-reads its evidence (the approvals, the runs, the facts) in its own transaction, so the fixture earns its row
// through the real consume hook — a row that merely says "sealing" must never grant.
const NOW = "2026-10-28T10:00:00.000Z";
const LATER = "2026-10-29T10:00:01.000Z"; // 24 h + 1 s after NOW
const FUTURE = new Date(Date.now() + 90 * 86_400_000).toISOString(); // compared against the real clock by resolveToolApprovalForTest
const PACO: Identity = { kind: "user", id: "paco" };
const WORKER = "planner:555:w"; const FP = "fp_post";
const FACTS = { ran: true, torn_down: true, tampered: false, escaped: false, exit_code: 0, truncated: false, check_failed: false, room: "room-abc123" };
const FIN = { tool_call_id: "tc4", status: "succeeded", executor: "cleanroom", cleanroom: FACTS };
const OK: SealInput = { fin: FIN, run_state: "completed", outbox: "delivered", decision_id: "dec_1", started_at: NOW, now: NOW };
const withFacts = (over: Record<string, unknown>): SealInput => ({ ...OK, fin: { ...FIN, cleanroom: { ...FACTS, ...over } } });
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

describe("sealVerdict (the seal conjunction, §7)", () => {
  it("all ten facts true → seal; each tool fact flipped alone → end (a test that passes with one conjunct removed fails here)", () => {
    expect(sealVerdict(OK)).toBe("seal");
    for (const over of [{ exit_code: 1 }, { exit_code: null }, { truncated: true }, { truncated: null }, { ran: false }, { torn_down: false }, { tampered: true }, { escaped: true }, { check_failed: true }]) {
      expect([over, sealVerdict(withFacts(over))]).toEqual([over, "end"]);
    }
    expect(sealVerdict({ ...OK, fin: { ...FIN, status: "failed" } })).toBe("end");
    expect(sealVerdict({ ...OK, fin: { ...FIN, executor: undefined } })).toBe("end"); // ran unsealed: never a seal
    expect(sealVerdict({ ...OK, fin: { ...FIN, cleanroom: { ...FACTS, torn_down: "yes" } } })).toBe("end"); // malformed facts are missing facts
    expect(sealVerdict({ ...OK, fin: { ...FIN, cleanroom: { ...FACTS, truncated: "no" } } })).toBe("end"); // truncation unknown is not "whole"
  });
  it("run state: completed seals; failed / cancelled / expired / missing end; still running waits, then ends at the 24 h TTL", () => {
    for (const run_state of ["failed", "cancelled", "expired", undefined]) expect(sealVerdict({ ...OK, run_state })).toBe("end");
    for (const run_state of ["running", "waiting_for_approval", "reporting", "queued"]) {
      expect(sealVerdict({ ...OK, run_state, fin: undefined })).toBe("wait");
      expect(sealVerdict({ ...OK, run_state, fin: undefined, now: LATER })).toBe("end");
    }
  });
  it("outbox: delivered seals; failed_terminal ends; queued / sending / retry_wait / none wait until the TTL", () => {
    expect(sealVerdict({ ...OK, outbox: "failed_terminal" })).toBe("end");
    for (const outbox of ["queued", "sending", "retry_wait", undefined]) {
      expect(sealVerdict({ ...OK, outbox })).toBe("wait");
      expect(sealVerdict({ ...OK, outbox, now: LATER })).toBe("end");
    }
  });
  it("the 24 h TTL is checked before delivery: delivered a second before the deadline seals; at it or after it, the trial ends", () => {
    expect(sealVerdict({ ...OK, now: at(SEALING_TTL_MS - 1_000) })).toBe("seal");
    expect(sealVerdict({ ...OK, now: at(SEALING_TTL_MS) })).toBe("end");
    expect(sealVerdict({ ...OK, now: LATER })).toBe("end");
  });
  it("a completed run whose sealed call left no facts, or no decision row, ends (never re-run, never granted with a hole in its evidence)", () => {
    expect(sealVerdict({ ...OK, fin: undefined })).toBe("end");
    expect(sealVerdict({ ...OK, decision_id: undefined })).toBe("end");
  });
  it("pre-spawn with ran:false resets to candidate whatever the run's fate or the clock; the same reason with ran:true ends", () => {
    for (const reason of PRE_SPAWN_REASONS) {
      const pre = { ...OK, fin: { ...FIN, status: "failed", cleanroom: { ...FACTS, ran: false, exit_code: null, truncated: null, reason } } };
      expect(sealVerdict({ ...pre, run_state: "failed", outbox: "delivered", now: LATER })).toBe("reset");
      expect(sealVerdict({ ...pre, fin: { ...pre.fin, cleanroom: { ...pre.fin.cleanroom, ran: true } } })).toBe("end");
    }
    expect(sealVerdict({ ...OK, fin: { ...FIN, status: "failed", cleanroom: { ...FACTS, ran: false, exit_code: null, reason: "timeout" } } })).toBe("end"); // a post-spawn word
  });
  it("every pre-spawn word is one the bridge persists (else settleSealing could never tell a void trial from a failed one)", () => {
    for (const r of PRE_SPAWN_REASONS) expect(CLEANROOM_REASONS.has(r)).toBe(true);
  });
});

let k = 0;
function scheduledRun(s: RunStore, schedule_id: string): string {
  const r = new Gateway(s).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post", requested_by: { kind: "schedule", id: schedule_id },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `schedule:${schedule_id}:${++k}`, source_reference: `scheduled_tasks.${schedule_id}` }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  s.claimRun(r.run_id, WORKER, 86_400 * 400); // the consume CAS checks the lease against the fixed NOW
  return r.run_id;
}
/** One approval Paco tapped and the runner consumed, through the real hooks (the consume credits the streak or seals the trial). */
function consumed(s: RunStore, run_id: string, tool_call_id: string, standing_trial?: { standing_id: string }): string {
  const a = s.createToolApproval({ run_id, worker_id: WORKER, tool_call_id, capability: "shell_external", input_hash: "ih", action_fingerprint: FP, requester: PACO, summary: "HTTP write",
    side_effect_level: "external_write", expires_at: FUTURE });
  s.resolveToolApprovalForTest(a.approval_id, "approved");
  const c = s.consumeToolApproval({ approval_id: a.approval_id, run_id, worker_id: WORKER, capability: "shell_external", action_fingerprint: FP, requester: PACO, now: NOW, ...(standing_trial ? { standing_trial } : {}) });
  if (!c.ok) throw new Error(c.code);
  return a.approval_id;
}
/** Three credited runs, then the fourth run's consume with the trial selector (row sealing on call tc4), then that run's facts, decision, end and notice as the case needs. */
function sealed(s: RunStore, o: { facts?: Record<string, unknown> | null; run?: "completed" | "failed" | "running"; outbox?: "delivered" | "queued" | "failed_terminal" | null; decision?: boolean } = {}) {
  const schedule_id = s.addScheduledTask({ chat_id: "555", goal: "Alishan check-in", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z", now: NOW }).schedule_id;
  const credited = ["tc1", "tc2", "tc3"].map((tc) => consumed(s, scheduledRun(s, schedule_id), tc));
  const cand = s.standingFor({ schedule_id, chat_id: "555", action_fingerprint: FP });
  if (cand?.state !== "candidate") throw new Error(`fixture: ${cand?.state ?? "no row"}`);
  const run_id = scheduledRun(s, schedule_id);
  const a4 = consumed(s, run_id, "tc4", { standing_id: cand.standing_id });
  const row = s.getStandingApproval(cand.standing_id)!;
  if (row.state !== "sealing") throw new Error(`fixture: ${row.state}`);
  if (o.facts !== null) s.appendRunLedgerEvent(run_id, "tool_finished", "capability_runner", { tool_call_id: "tc4", status: "succeeded", output_hash: "h", duration_ms: 1, bytes_out: 3, tool: "bash",
    executor: "cleanroom", cleanroom: { ...FACTS, ...(o.facts ?? {}) } });
  const decision_id = o.decision === false ? undefined : s.insertDecision({ entry_id: "tool.policy", entry_version: 3, run_id, tool_call_id: "tc4", stage: "pre_tool", rung: "rule", verdict: "requires_approval",
    p: null, reason_code: "gated_side_effect", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0 });
  if ((o.run ?? "completed") === "completed") s.finishRun({ run_id, expected_worker_id: WORKER, next: "completed", report_ref: "r.md", duration_ms: 1, tool_calls: 1 });
  if (o.run === "failed") s.finishRun({ run_id, expected_worker_id: WORKER, next: "failed", error_type: "planner_exit", error_ref: "x" });
  if (o.outbox !== null) {
    if (o.run === "failed") s.enqueueFailureNotification(run_id, "I hit an error on that one: x"); else s.enqueueFinalReportNotification(run_id, { text: "200", report_path: "r.md" });
    // the oldest queued row is an approval card, not this run's notice: claim until the run's own final_report comes up
    let n = s.claimNextNotification("t", 30)!;
    while (n.idempotency_key !== `${run_id}:final_report`) n = s.claimNextNotification("t", 30)!;
    if ((o.outbox ?? "delivered") === "delivered") s.markNotificationDelivered(n.notification_id, "tg:1");
    if (o.outbox === "failed_terminal") s.markNotificationFailed(n.notification_id, "boom", false, NOW, 1);
    if (o.outbox === "queued") s.markNotificationFailed(n.notification_id, "boom", true, NOW, 5); // retry_wait: not delivered yet
  }
  return { row, run_id, schedule_id, decision_id, credited, a4, runs: JSON.parse(row.credited_runs_json) as string[] };
}
const events = (s: RunStore, type: string) => s.getLedgerEvents().filter((e) => e.event_type === type).map((e) => e.payload);
const raw = (s: RunStore) => (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
const moves = (s: RunStore) => s.listLadderMovesCreatedSince("2000-01-01T00:00:00.000Z");

describe("settleSealing (Decision 1-A: the grant is immediate)", () => {
  it("a sealed run grants at once: row standing for 30 d, an auto move on tool.policy with the evidence in §4.3 order, both ledger facts, an urgent card with Revoke", () => {
    const s = RunStore.openInMemory(); const { row, run_id, decision_id, credited, a4 } = sealed(s);
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "seal" }]);
    const after = s.getStandingApproval(row.standing_id)!;
    expect(after).toMatchObject({ state: "standing", expires_at: "2026-11-27T10:00:00.000Z" });
    expect(s.getLadderMove(after.move_id!)).toMatchObject({ entry_id: "tool.policy", scope: row.standing_id, from_rung: "paco", to_rung: "rule", granted_by: "auto", granted_via: "approval.standing", state: "active", revocable: 1 });
    expect(JSON.parse(s.getLadderMove(after.move_id!)!.evidence_json)).toEqual([...credited, a4, decision_id, run_id, "tc4"]); // decision/approval ids first, execution ids after
    expect(events(s, "standing_sealed")).toEqual([expect.objectContaining({ standing_id: row.standing_id, run_id, tool_call_id: "tc4", exit_code: 0, torn_down: true, room: "room-abc123" })]);
    expect(events(s, "standing_granted")).toEqual([{ standing_id: row.standing_id, move_id: after.move_id }]);
    const card = s.getNotification(after.grant_notification_id!)!;
    expect(card).toMatchObject({ idempotency_key: `urgent:standing_grant:${row.standing_id}`, target: { kind: "telegram", chat_id: "555" } });
    expect(String(card.payload.text)).toMatch(/one byte changed asks again/i);
    expect(card.payload.buttons).toEqual([revokeButton(row.standing_id)]);
    expect(Buffer.byteLength(revokeButton(row.standing_id).data)).toBeLessThanOrEqual(64);
  });
  it("is idempotent: a second settle (the sweep after the dispatcher) finds no sealing row and changes nothing", () => {
    const s = RunStore.openInMemory(); const { run_id } = sealed(s);
    settleSealing(s, run_id, NOW);
    expect(settleSealing(s, run_id, NOW)).toEqual([]);
    expect(moves(s)).toHaveLength(1);
    expect(events(s, "standing_granted")).toHaveLength(1);
  });
  it("the grant re-reads its evidence: each gap ends the row sealed_trial_failed, names itself in standing_evidence_failed, and never grants", () => {
    // one case per guard, each asserting the gap it names: a case that still ends with that guard removed would name another gap
    type F = ReturnType<typeof sealed>;
    const sql = (s: RunStore, q: string, ...a: unknown[]) => { raw(s).prepare(q).run(...a); };
    const cases: Array<[string, (s: RunStore, f: F) => void, (f: F) => string]> = [
      ["a credited approval no longer consumed", (s, f) => sql(s, `UPDATE tool_approvals SET state = 'expired' WHERE approval_id = ?`, f.credited[0]), (f) => `approval:${f.credited[0]}`],
      ["two credits naming one run", (s, f) => sql(s, `UPDATE tool_approvals SET run_id = ? WHERE approval_id = ?`, f.runs[0], f.credited[1]), (f) => `approval:${f.credited[1]}`],
      ["fabricated credited ids", (s, f) => sql(s, `UPDATE standing_approvals SET approval_ids_json = ? WHERE standing_id = ?`, JSON.stringify(["a1", "a2", "a3", f.a4]), f.row.standing_id), () => "approval:a1"],
      ["a credited approval keyed to a foreign schedule", (s, f) => sql(s, `UPDATE runs SET requested_by_json = '{"kind":"schedule","id":"sch_foreign"}' WHERE run_id = ?`, f.runs[0]), (f) => `approval:${f.credited[0]}`],
      ["duplicate credited runs", (s, f) => sql(s, `UPDATE standing_approvals SET credited_runs_json = ? WHERE standing_id = ?`, JSON.stringify([f.runs[0], f.runs[0], f.runs[2]]), f.row.standing_id), () => "credited_runs"],
      ["the sealed run inside the credited list", (s, f) => sql(s, `UPDATE standing_approvals SET credited_runs_json = ? WHERE standing_id = ?`, JSON.stringify([f.runs[0], f.runs[1], f.run_id]), f.row.standing_id), () => "credited_runs"],
      ["the fourth approval on another run", (s, f) => sql(s, `UPDATE tool_approvals SET run_id = ? WHERE approval_id = ?`, f.runs[0], f.a4), () => "sealing_approval"],
      ["the fourth approval on another tool call", (s, f) => sql(s, `UPDATE tool_approvals SET tool_call_id = 'tc_other' WHERE approval_id = ?`, f.a4), () => "sealing_approval"],
      ["the fourth approval not consumed", (s, f) => sql(s, `UPDATE tool_approvals SET state = 'approved' WHERE approval_id = ?`, f.a4), () => "sealing_approval"],
      ["the row lost its sealing approval id", (s, f) => sql(s, `UPDATE standing_approvals SET sealing_approval_id = NULL WHERE standing_id = ?`, f.row.standing_id), () => "sealing_fields"]
    ];
    for (const [name, mutate, missing] of cases) {
      const s = RunStore.openInMemory(); const f = sealed(s); mutate(s, f);
      expect([name, settleSealing(s, f.run_id, NOW)]).toEqual([name, [{ standing_id: f.row.standing_id, verdict: "end" }]]);
      expect([name, s.getStandingApproval(f.row.standing_id)?.ended_reason, s.getStandingApproval(f.row.standing_id)?.move_id]).toEqual([name, "sealed_trial_failed", null]);
      const inc = s.findOpenIncident(s.incidentFingerprint("standing_evidence_failed", `standing:${f.row.standing_id}`));
      expect([name, inc ? (JSON.parse(inc.detail_json) as { missing?: string }).missing : "no incident"]).toEqual([name, missing(f)]);
      expect([name, moves(s).length, events(s, "standing_granted").length]).toEqual([name, 0, 0]);
    }
  });
  it("a trial that changed between the settle's read and the grant is lost: the older trial's evidence neither grants nor ends the newer one", () => {
    // interleaved: between settleSealing's read and grantStanding's transaction the trial is reset and a newer fourth approval seals it again
    const s = RunStore.openInMemory(); const f = sealed(s);
    const racy = Object.create(s) as RunStore; let newer = "";
    racy.inTransaction = <T,>(fn: () => T): T => {
      if (newer === "") {
        s.resetStandingToCandidate({ standing_id: f.row.standing_id, now: NOW, reason: "race" });
        newer = scheduledRun(s, f.schedule_id); consumed(s, newer, "tc4b", { standing_id: f.row.standing_id });
      }
      return RunStore.prototype.inTransaction.call(racy, fn) as T;
    };
    expect(settleSealing(racy, f.run_id, NOW)).toEqual([{ standing_id: f.row.standing_id, verdict: "wait" }]);
    expect(s.getStandingApproval(f.row.standing_id)).toMatchObject({ state: "sealing", sealed_run_id: newer, sealed_tool_call_id: "tc4b", move_id: null });
    expect(moves(s)).toEqual([]);
    expect(s.findOpenIncident(s.incidentFingerprint("standing_evidence_failed", `standing:${f.row.standing_id}`))).toBeUndefined();
    expect(settleSealing(s, newer, NOW)).toEqual([{ standing_id: f.row.standing_id, verdict: "wait" }]); // the newer trial has no facts of its own yet
  });
  it("a grant whose Revoke card cannot be queued does not commit: the row stays sealing with no move, no event, no card id", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s);
    s.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: `urgent:standing_grant:${row.standing_id}`, correlation_id: "x", payload: { text: "another payload" } });
    expect(() => settleSealing(s, run_id, NOW)).toThrow(/grant card/);
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "sealing", move_id: null, grant_notification_id: null });
    expect(moves(s)).toEqual([]); expect(events(s, "standing_granted")).toEqual([]); expect(events(s, "standing_sealed")).toEqual([]);
  });
  it("a report settled at the 24 h deadline ends the trial, never grants", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s);
    expect(settleSealing(s, run_id, at(SEALING_TTL_MS))).toEqual([{ standing_id: row.standing_id, verdict: "end" }]);
    expect(moves(s)).toEqual([]);
  });
  it("a failed run whose failure notice was delivered ends the row (the shared final_report key is not a success signal)", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s, { run: "failed" });
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "end" }]);
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "sealed_trial_failed", move_id: null });
    expect(moves(s)).toEqual([]);
  });
  it("a void trial (cleanroom_unavailable, ran:false) goes back to candidate with the three credited approvals; the spent fourth is dropped", () => {
    const s = RunStore.openInMemory(); const { row, run_id, credited } = sealed(s, { facts: { ran: false, exit_code: null, truncated: null, reason: "cleanroom_unavailable" } });
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "reset" }]);
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "candidate", approval_ids_json: JSON.stringify(credited), sealing_approval_id: null, sealed_run_id: null, sealed_tool_call_id: null, sealing_started_at: null });
    expect(events(s, "standing_streak").at(-1)).toMatchObject({ standing_id: row.standing_id, streak: 3, reset: "cleanroom_unavailable" });
  });
  it("a report still in retry waits; past the TTL the sweep ends it; a missing decision row ends it", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s, { outbox: "queued" });
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "wait" }]);
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("sealing");
    expect(runStandingSweep(s, LATER)).toMatchObject({ settled: 1 });
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "sealed_trial_failed" });
    const s2 = RunStore.openInMemory(); const nd = sealed(s2, { decision: false });
    expect(settleSealing(s2, nd.run_id, NOW)).toEqual([{ standing_id: nd.row.standing_id, verdict: "end" }]);
  });
  it("tool_finished of ANOTHER call in the run is not the sealed call's facts", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s, { facts: null });
    s.appendRunLedgerEvent(run_id, "tool_finished", "capability_runner", { ...FIN, tool_call_id: "tc_other", output_hash: "h", duration_ms: 1, bytes_out: 1 });
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "end" }]);
  });
});

/** A granted row on an enabled schedule, one real use through the store CAS, then that call's facts (null: still in flight). */
function used(s: RunStore, facts: Record<string, unknown> | null) {
  const schedule_id = s.addScheduledTask({ chat_id: "555", goal: "post", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z", now: NOW }).schedule_id;
  const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
  const row = s.insertStandingApprovalForTest({ schedule_id, chat_id: "555", action_fingerprint: FP, state: "standing", move_id, expires_at: FUTURE });
  const run_id = scheduledRun(s, schedule_id);
  const u = s.standingUse({ standing_id: row.standing_id, action_fingerprint: FP, run_id, tool_call_id: "tc5", now: NOW });
  if (!u.ok) throw new Error(u.code);
  if (facts !== null) s.appendRunLedgerEvent(run_id, "tool_finished", "capability_runner", { tool_call_id: "tc5", status: "succeeded", output_hash: "h", duration_ms: 1, bytes_out: 3, tool: "bash",
    executor: "cleanroom", cleanroom: { ...FACTS, ...facts } });
  return { row, run_id, move_id };
}

describe("settleStandingUses (a broken seal on a standing use ends the grant)", () => {
  it("tampered, escaped, a failed check, or a room left behind each end the grant tampered_use with its move, and Paco gets an urgent card", () => {
    for (const over of [{ tampered: true }, { escaped: true }, { check_failed: true }, { torn_down: false }]) {
      const s = RunStore.openInMemory(); const { row, run_id, move_id } = used(s, over);
      expect([over, settleStandingUses(s, run_id, NOW)]).toEqual([over, 1]);
      expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "tampered_use" });
      expect(s.getLadderMove(move_id)?.state).toBe("ended");
      expect(s.claimNextNotification("t", 30)).toMatchObject({ idempotency_key: `urgent:standing_tampered:${row.standing_id}`, target: { kind: "telegram", chat_id: "555" } });
    }
  });
  it("a clean use, or one still in flight (no tool_finished yet), leaves the grant standing; a second settle of a broken one changes nothing", () => {
    const s = RunStore.openInMemory(); const clean = used(s, {});
    expect(settleStandingUses(s, clean.run_id, NOW)).toBe(0);
    expect(s.getStandingApproval(clean.row.standing_id)?.state).toBe("standing");
    const s2 = RunStore.openInMemory(); const flight = used(s2, null);
    expect(settleStandingUses(s2, flight.run_id, NOW)).toBe(0);
    const s3 = RunStore.openInMemory(); const bad = used(s3, { tampered: true });
    settleStandingUses(s3, bad.run_id, NOW);
    expect(settleStandingUses(s3, bad.run_id, NOW)).toBe(0);
    expect(events(s3, "standing_ended")).toHaveLength(1);
  });
  it("the sweep re-reads every standing row's uses, so a broken use ends its grant even when no delivery hook ran", () => {
    const s = RunStore.openInMemory(); const { row } = used(s, { escaped: true });
    expect(runStandingSweep(s, NOW)).toMatchObject({ ended: 1 });
    expect(s.getStandingApproval(row.standing_id)?.ended_reason).toBe("tampered_use");
  });
});

describe("settleDeliveredReport (the dispatcher's hook)", () => {
  it("settles only a run's own final_report; another intent or a foreign key never settles", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s);
    settleDeliveredReport(s, { intent_type: "progress", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW);
    settleDeliveredReport(s, { intent_type: "final_report", idempotency_key: "urgent:x", run_id }, {}, NOW);
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("sealing");
    settleDeliveredReport(s, { intent_type: "final_report", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW); // NOW: inside the trial's 24 h
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("standing");
  });
  it("a settlement error (a broken store, or a grant card conflict) opens standing_settle_failed and never throws into the dispatcher", () => {
    const s = RunStore.openInMemory(); const { run_id } = sealed(s);
    const broken = Object.create(s) as RunStore;
    (broken as { listStandingApprovals: unknown }).listStandingApprovals = () => { throw new Error("disk I/O error"); };
    expect(() => settleDeliveredReport(broken, { intent_type: "final_report", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW)).not.toThrow();
    expect(s.findOpenIncident(s.incidentFingerprint("standing_settle_failed", `run:${run_id}`))).toBeDefined();
    const c = RunStore.openInMemory(); const f = sealed(c);
    c.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: `urgent:standing_grant:${f.row.standing_id}`, correlation_id: "x", payload: { text: "another payload" } });
    expect(() => settleDeliveredReport(c, { intent_type: "final_report", idempotency_key: `${f.run_id}:final_report`, run_id: f.run_id }, {}, NOW)).not.toThrow();
    expect(c.findOpenIncident(c.incidentFingerprint("standing_settle_failed", `run:${f.run_id}`))).toBeDefined();
    expect(c.getStandingApproval(f.row.standing_id)?.state).toBe("sealing");
  });
  it("the delivery hook, not only the sweep, ends a tampered standing use when the run's report is delivered", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = used(s, { tampered: true });
    settleDeliveredReport(s, { intent_type: "final_report", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW);
    expect(s.getStandingApproval(row.standing_id)?.ended_reason).toBe("tampered_use");
  });
  it("a failed trial settle never skips the standing-use check: each failure is its own incident", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = used(s, { escaped: true });
    const broken = Object.create(s) as RunStore;
    (broken as { listStandingApprovals: unknown }).listStandingApprovals = () => { throw new Error("disk I/O error"); }; // settleSealing fails; settleStandingUses never lists
    settleDeliveredReport(broken, { intent_type: "final_report", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW);
    expect(s.getStandingApproval(row.standing_id)?.ended_reason).toBe("tampered_use");
    expect(s.findOpenIncident(s.incidentFingerprint("standing_settle_failed", `run:${run_id}`))).toBeDefined();
  });
});

describe("revokeButton", () => {
  it("carries dec:sa:<standing_id>:revoke", () => {
    expect(revokeButton("sa_0f8fad5b-d9cb-469f-a165-70867728950e")).toEqual({ text: "🛑 Revoke", data: `${SA_PREFIX}sa_0f8fad5b-d9cb-469f-a165-70867728950e:revoke` });
  });
});
```

Append to `tests/notifications/notification-dispatcher.test.ts` inside `describe("NotificationDispatcher", …)`:
```ts
  it("onDelivered runs after the delivered row committed; a throwing hook never turns the delivered message into a failure", async () => {
    // Stage 4A §7: settlement rides delivery, but a settlement error must not make Houge resend (or mark failed) what Paco already has
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const record = outbox.enqueue({ target: { kind: "telegram", chat_id: "222" }, intent_type: "final_report", idempotency_key: "run_9:final_report", run_id: "run_9", correlation_id: "run_9", payload: { text: "200" } });
      const seen: string[] = [];
      const dispatcher = new NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "local:1" }) }, telegram: { send: async () => ({ provider_message_id: "telegram:7" }) } },
        { onDelivered: (r) => { seen.push(`${r.idempotency_key}=${String(outbox.get(r.notification_id)?.state)}`); throw new Error("settle failed"); } });
      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "delivered", notification_id: record.notification_id });
      expect(seen).toEqual(["run_9:final_report=delivered"]);
      expect(outbox.get(record.notification_id)?.state).toBe("delivered");
      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "idle" }); // nothing requeued
    } finally {
      store.close();
    }
  });
```

Create `tests/telegram/telegram-daemon-standing.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createOutboxDispatcher } from "../../src/telegram/telegram-daemon.js";

// Stage 4A §7: the daemon's one sender settles a sealed run the moment its report is delivered (the sweep is only the net).
describe("createOutboxDispatcher", () => {
  it("routes a delivered final_report of a sealing run to settlement", async () => {
    const s = RunStore.openInMemory();
    const row = s.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id: "555", action_fingerprint: "fp", state: "sealing", sealed_run_id: "run_gone", sealed_tool_call_id: "tc", sealing_started_at: new Date().toISOString() });
    s.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "final_report", idempotency_key: "run_gone:final_report", run_id: "run_gone", correlation_id: "run_gone", payload: { text: "x" } });
    const d = createOutboxDispatcher(s, { local: { send: async () => ({ provider_message_id: "l" }) }, telegram: { send: async () => ({ provider_message_id: "t" }) } });
    await d.dispatchOnce("x");
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "sealed_trial_failed" }); // no such run: never a seal
  });
  it("is the daemon's only sender: telegram-daemon.ts builds its dispatcher through it (a bare NotificationDispatcher would deliver without settling)", () => {
    const src = readFileSync(new URL("../../src/telegram/telegram-daemon.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const dispatcher = createOutboxDispatcher\(options\.store,/);
    expect(src.match(/new NotificationDispatcher\(/g) ?? []).toHaveLength(1); // the one inside createOutboxDispatcher
  });
});
```

Append to `tests/run/schedule-tick.test.ts` (add `import { buildTypedTaskEvent } from "../../src/domain/types.js";` and `import { SEALING_TTL_MS } from "../../src/decisions/standing-approval.js";`):
```ts
describe("the standing sweep rides the schedule tick (Stage 4A §7)", () => {
  function sealingPastTtl() {
    const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post", requested_by: { kind: "schedule", id: "sch_x" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "schedule:sch_x:1", source_reference: "scheduled_tasks.sch_x" }));
    if (!r.ok) throw new Error("intake");
    return store.insertStandingApprovalForTest({ schedule_id: "sch_x", chat_id: "555", action_fingerprint: "fp", state: "sealing", sealed_run_id: r.run_id, sealed_tool_call_id: "tc",
      sealing_started_at: new Date(Date.parse(NOW) - SEALING_TTL_MS - 1).toISOString() });
  }
  it("runs before the scheduler flag: with the scheduler off a sealing row past its 24 h TTL still ends", async () => {
    const row = sealingPastTtl();
    await maybeFireScheduledTasks({ store, gateway: new Gateway(store), worker: fakeWorker([]), now: NOW, env: {} });
    expect(store.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "sealed_trial_failed" });
  });
  it("a sweep that throws opens standing_sweep_failed and the due schedule still fires", async () => {
    addWeekly();
    const broken = Object.create(store) as RunStore;
    (broken as { listStandingApprovals: unknown }).listStandingApprovals = () => { throw new Error("disk I/O error"); };
    const executed: Array<{ run_id: string; worker_id: string }> = [];
    const result = await maybeFireScheduledTasks({ store: broken, gateway: new Gateway(store), worker: fakeWorker(executed), now: NOW, env: ARMED });
    expect(result.fired).toBe(1);
    expect(store.findOpenIncident(store.incidentFingerprint("standing_sweep_failed", "daemon"))).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/decisions/standing-approval.test.ts tests/notifications/notification-dispatcher.test.ts tests/telegram/telegram-daemon-standing.test.ts tests/run/schedule-tick.test.ts` → FAIL (module `standing-approval.js` missing; `onDelivered` ignored; `createOutboxDispatcher` not exported; the sweep never runs).

- [ ] **Step 3: Implement.**

`src/decisions/urgent.ts`:
```ts
/** The outbox row id (a redelivered key returns the first row's): Stage 4A stores the grant card's id on the standing row. Null on a payload conflict — the grant treats that as fatal: no grant without its Revoke card. */
export function enqueueUrgentCard(store: RunStore, c: UrgentCard): string | null {
  const r = store.enqueueNotification({
    target: { kind: "telegram", chat_id: c.chat_id }, intent_type: "progress", idempotency_key: `urgent:${c.key}`, correlation_id: c.key,
    payload: { text: c.text, ...(c.buttons && c.buttons.length > 0 ? { buttons: c.buttons } : {}) }
  });
  return r.status === "conflict" ? null : r.record.notification_id;
}
```
(The four existing callers ignore the value; typecheck confirms.)

`src/run/run-store.ts`, after `standingRowRefusal`:
```ts
  /**
   * Decision 1-A: sealing → standing behind one CAS; the auto move (§4.3: approval.standing on tool.policy only), the seal facts and
   * the grant land together. Null when the row is no longer sealing. Called only by `grantStanding`, inside the transaction that
   * re-read the evidence: this method checks the row's state, not the evidence.
   */
  markStandingGranted(i: { standing_id: string; evidence: string[]; expires_at: string; now: string; facts: Record<string, unknown> }): string | null {
    return this.joinTransaction(() => {
      const row = this.getStandingApproval(i.standing_id);
      if (!row || row.state !== "sealing" || !row.sealed_run_id || !row.sealed_tool_call_id) return null;
      const r = this.db.prepare(`UPDATE standing_approvals SET state = 'standing', expires_at = ?, updated_at = ? WHERE standing_id = ? AND state = 'sealing'`).run(i.expires_at, i.now, i.standing_id);
      if (r.changes !== 1) return null;
      const move_id = this.insertLadderMove({ entry_id: "tool.policy", scope: i.standing_id, from_rung: "paco", to_rung: "rule", evidence: i.evidence, granted_by: "auto",
        granted_via: "approval.standing", paco_callback_id: null, revocable: true, created_at: i.now });
      this.db.prepare(`UPDATE standing_approvals SET move_id = ? WHERE standing_id = ?`).run(move_id, i.standing_id);
      this.appendStandingLedgerEvent("standing_sealed", { standing_id: i.standing_id, run_id: row.sealed_run_id, tool_call_id: row.sealed_tool_call_id, ...i.facts }, row.sealed_run_id);
      this.appendStandingLedgerEvent("standing_granted", { standing_id: i.standing_id, move_id });
      return move_id;
    });
  }
  /** §6 pre-spawn: nothing ran, so the trial is void — back to candidate on the three credited approvals; the spent fourth is dropped and the next run asks again. */
  resetStandingToCandidate(i: { standing_id: string; now: string; reason: string }): boolean {
    return this.joinTransaction(() => {
      const row = this.getStandingApproval(i.standing_id);
      if (!row || row.state !== "sealing") return false;
      const ids = (JSON.parse(row.approval_ids_json) as string[]).slice(0, STANDING_STREAK);
      const r = this.db.prepare(`UPDATE standing_approvals SET state = 'candidate', approval_ids_json = ?, sealing_approval_id = NULL, sealed_run_id = NULL, sealed_tool_call_id = NULL,
        sealing_started_at = NULL, updated_at = ? WHERE standing_id = ? AND state = 'sealing'`).run(JSON.stringify(ids), i.now, i.standing_id);
      if (r.changes !== 1) return false;
      this.appendStandingLedgerEvent("standing_streak", { standing_id: i.standing_id, run_id: row.sealed_run_id ?? "", approval_id: row.sealing_approval_id ?? "", streak: ids.length, reset: i.reason },
        row.sealed_run_id ?? undefined);
      return true;
    });
  }
  setStandingGrantNotification(standing_id: string, notification_id: string, now: string): void {
    this.db.prepare(`UPDATE standing_approvals SET grant_notification_id = ?, updated_at = ? WHERE standing_id = ?`).run(notification_id, now, standing_id);
  }
  /** The per-run uses of one grant (at most one per fire): the sweep re-reads their facts so a broken seal ends the grant. */
  listStandingUses(standing_id: string): Array<{ run_id: string; tool_call_id: string; used_at: string }> {
    return this.db.prepare(`SELECT run_id, tool_call_id, used_at FROM standing_uses WHERE standing_id = ? ORDER BY used_at ASC, run_id ASC`).all<{ run_id: string; tool_call_id: string; used_at: string }>(standing_id);
  }
```

Create `src/decisions/standing-approval.ts`:
```ts
import { errorCode } from "../domain/error-code.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { CleanroomFacts } from "../omp/bridge-handler.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import { STANDING_STREAK, type NotificationRecord, type RunStore, type StandingApprovalRow, type ToolApprovalRow } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone, scheduleDisplayName } from "../run/schedule-spec.js";
import { enqueueUrgentCard } from "./urgent.js";

/**
 * Stage 4A (ADR 0030 §8.3, Decision 1-A): settlement of a sealed trial and the life of a standing row after it. Code reads
 * code-owned facts only — the sealed call's `tool_finished`, the run's state, its terminal notice, the consumed approvals — and
 * owns every transition; no model output is an input. The grant is immediate and automatic; Paco holds Revoke.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const SA_PREFIX = "dec:sa:";
export const STANDING_EXPIRY_MS = 30 * DAY_MS;
export const SEALING_TTL_MS = DAY_MS;
/** Slice 1's words for "the command never started"; with ran:false the trial is void, not failed (spec §6). */
export const PRE_SPAWN_REASONS: ReadonlySet<string> = new Set(["cleanroom_unavailable", "cleanroom_setup", "cleanroom_invalid", "cleanroom_tampered", "aborted", "spawn"]);
const UNSEALED_END: ReadonlySet<string> = new Set(["failed", "cancelled", "expired"]);

export type SealVerdict = "seal" | "reset" | "end" | "wait";
export interface SealInput { fin: Record<string, unknown> | undefined; run_state: string | undefined; outbox: string | undefined; decision_id: string | undefined; started_at: string; now: string }

/** The sealed call's facts, or null when any is missing or malformed (a missing fact is never read as true; truncated may be null = unknown). */
function factsOf(fin: Record<string, unknown> | undefined): CleanroomFacts | null {
  const c = fin?.cleanroom;
  if (typeof c !== "object" || c === null) return null;
  const f = c as Record<string, unknown>;
  if ((["ran", "torn_down", "tampered", "escaped", "check_failed"] as const).some((key) => typeof f[key] !== "boolean")) return null;
  if (f.truncated !== null && typeof f.truncated !== "boolean") return null;
  if (f.exit_code !== null && !Number.isInteger(f.exit_code)) return null;
  return f as unknown as CleanroomFacts;
}

/** §7's conjunction over the one sealed call: it ran sealed, exited 0 provably whole, left nothing behind and every check ran. */
function sealedCall(fin: Record<string, unknown>, f: CleanroomFacts | null): boolean {
  return fin.status === "succeeded" && fin.executor === "cleanroom" && f !== null && f.exit_code === 0 && f.truncated === false
    && f.ran && f.torn_down && !f.tampered && !f.escaped && !f.check_failed;
}

/** Pre-spawn first (whatever the run's fate), then the 24 h TTL (before delivery: a late report never stands a command up), then the call, the run, the notice. */
export function sealVerdict(i: SealInput): SealVerdict {
  const f = factsOf(i.fin);
  if (f && !f.ran && f.reason !== undefined && PRE_SPAWN_REASONS.has(f.reason)) return "reset";
  if (Date.parse(i.now) - Date.parse(i.started_at) >= SEALING_TTL_MS) return "end"; // a late delivery never stands a command up
  if (i.fin && !sealedCall(i.fin, f)) return "end";
  if (i.run_state === undefined || UNSEALED_END.has(i.run_state)) return "end";
  if (i.run_state !== "completed") return "wait";
  if (!i.fin || i.decision_id === undefined || i.outbox === "failed_terminal") return "end"; // finished without its facts: never re-run
  return i.outbox === "delivered" ? "seal" : "wait";
}

export interface SettleOutcome { standing_id: string; verdict: SealVerdict }

/** Idempotent and total over the run's sealing rows: each transition is a store CAS on state = 'sealing', so a second call finds none. Throws on a grant card conflict (no grant without its Revoke card); both callers catch. */
export function settleSealing(store: RunStore, run_id: string, now: string = new Date().toISOString()): SettleOutcome[] {
  return store.listStandingApprovals({ state: "sealing" }).filter((r) => r.sealed_run_id === run_id).map((row) => ({ standing_id: row.standing_id, verdict: settleRow(store, row, now) }));
}

/** The reads a verdict needs; the settle and the grant's in-transaction re-read share them. */
function sealInputs(store: RunStore, row: StandingApprovalRow, now: string): SealInput {
  const run_id = row.sealed_run_id ?? "";
  const fin = store.getLedgerEvents(run_id).find((e) => e.event_type === "tool_finished" && e.payload.tool_call_id === row.sealed_tool_call_id)?.payload;
  const decision_id = store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "tool.policy" && d.tool_call_id === row.sealed_tool_call_id).at(-1)?.decision_id;
  return { fin, run_state: store.findRunState(run_id), outbox: store.finalReportState(run_id), decision_id, started_at: row.sealing_started_at ?? row.updated_at, now };
}

function settleRow(store: RunStore, row: StandingApprovalRow, now: string): SealVerdict {
  const input = sealInputs(store, row, now);
  const verdict = sealVerdict(input);
  if (verdict === "seal") return grantOrEnd(store, row, now);
  if (verdict === "reset") store.resetStandingToCandidate({ standing_id: row.standing_id, now, reason: factsOf(input.fin)?.reason ?? "pre_spawn" });
  if (verdict === "end") store.endStandingApproval({ standing_id: row.standing_id, reason: "sealed_trial_failed", now });
  return verdict;
}

/**
 * Runs only on a seal verdict, so a trial that failed its facts has already ended for that reason. A gap in the evidence ends the
 * trial and names the gap; a row that became another trial meanwhile is "lost" — nothing settled here, the newer trial waits.
 */
function grantOrEnd(store: RunStore, observed: StandingApprovalRow, now: string): SealVerdict {
  const g = grantStanding(store, observed, now);
  if (g.status === "lost") return "wait";
  if (g.status === "granted") return "seal";
  openAlertedIncident(store, { kind: "standing_evidence_failed", subject: `standing:${observed.standing_id}`, detail: { missing: g.missing }, now });
  return "end";
}

type GrantOutcome = { status: "granted" | "lost" } | { status: "evidence_missing"; missing: string };
/** The same trial: a reset and a newer fourth approval between the settle's read and the grant make the row another trial. */
const sameTrial = (a: StandingApprovalRow, b: StandingApprovalRow): boolean =>
  a.sealing_approval_id === b.sealing_approval_id && a.sealed_run_id === b.sealed_run_id && a.sealed_tool_call_id === b.sealed_tool_call_id;

/**
 * The evidence re-read, the grant and its card in one transaction. The row is re-read HERE and every evidence, card and
 * transition field comes from that read: an older trial's evidence must neither grant nor end a newer trial. A card that cannot
 * be queued rolls the grant back (no grant without its Revoke card); a gap ends this trial inside the same transaction.
 */
function grantStanding(store: RunStore, observed: StandingApprovalRow, now: string): GrantOutcome {
  const expires_at = new Date(Date.parse(now) + STANDING_EXPIRY_MS).toISOString();
  return store.inTransaction((): GrantOutcome => {
    const row = store.getStandingApproval(observed.standing_id);
    if (!row || row.state !== "sealing" || !sameTrial(row, observed)) return { status: "lost" };
    const proof = grantEvidence(store, row, now);
    if ("missing" in proof) { store.endStandingApproval({ standing_id: row.standing_id, reason: "sealed_trial_failed", now }); return { status: "evidence_missing", missing: proof.missing }; }
    const move_id = store.markStandingGranted({ standing_id: row.standing_id, evidence: proof.evidence, expires_at, now, facts: { ...proof.facts } });
    if (move_id === null) return { status: "lost" };
    const text = grantCardText({ label: row.label, schedule: scheduleDisplayName(store.getScheduledTask(row.schedule_id)?.goal ?? ""),
      expires_local: formatInstantInZone(expires_at, resolveDisplayZone(process.env)).slice(0, 10) });
    const notification_id = enqueueUrgentCard(store, { chat_id: row.chat_id, key: `standing_grant:${row.standing_id}`, text, buttons: [revokeButton(row.standing_id)] });
    if (notification_id === null) throw new Error(`standing grant card conflict: ${row.standing_id}`); // no grant without its Revoke card
    store.setStandingGrantNotification(row.standing_id, notification_id, now);
    return { status: "granted" };
  });
}

/** The whole evidence, re-read inside the grant's transaction (a row that merely says "sealing" never grants), in §4.3 order (approval/decision ids, then execution ids). */
function grantEvidence(store: RunStore, row: StandingApprovalRow, now: string): { evidence: string[]; facts: CleanroomFacts } | { missing: string } {
  const { sealed_run_id: run_id, sealed_tool_call_id: tc, sealing_approval_id: fourth } = row;
  if (!run_id || !tc || !fourth) return { missing: "sealing_fields" };
  const credited = creditedApprovals(store, row, run_id);
  if (typeof credited === "string") return { missing: credited };
  const a4 = store.getToolApproval(fourth);
  if (!a4 || a4.state !== "consumed" || a4.run_id !== run_id || a4.tool_call_id !== tc || !keyedApproval(store, a4, row)) return { missing: "sealing_approval" };
  const input = sealInputs(store, row, now); const facts = factsOf(input.fin);
  if (sealVerdict(input) !== "seal" || facts === null || input.decision_id === undefined) return { missing: "seal_facts" };
  return { evidence: [...credited, fourth, input.decision_id, run_id, tc], facts };
}

/** Three consumed approvals of this key, one per distinct scheduled run in credited_runs_json order, none on the sealed run. */
function creditedApprovals(store: RunStore, row: StandingApprovalRow, sealed_run_id: string): string[] | string {
  const ids = (JSON.parse(row.approval_ids_json) as string[]).slice(0, STANDING_STREAK);
  const runs = JSON.parse(row.credited_runs_json) as string[];
  if (ids.length !== STANDING_STREAK || runs.length !== STANDING_STREAK || new Set(runs).size !== STANDING_STREAK || runs.includes(sealed_run_id)) return "credited_runs";
  for (const [n, id] of ids.entries()) {
    const a = store.getToolApproval(id);
    if (!a || a.state !== "consumed" || a.run_id !== runs[n] || !keyedApproval(store, a, row)) return `approval:${id}`;
  }
  return ids;
}

/** The approval's action is the key's, and its run is a run of the key's schedule notifying the key's chat (the consume hook's key rule). */
function keyedApproval(store: RunStore, a: ToolApprovalRow, row: StandingApprovalRow): boolean {
  const run = store.getRunForWorker(a.run_id);
  return a.capability === row.capability && a.action_fingerprint === row.action_fingerprint && run?.source === "schedule" && run.requested_by.kind === "schedule"
    && run.requested_by.id === row.schedule_id && run.notify.kind === "telegram" && run.notify.chat_id === row.chat_id;
}

/** Spec §8: the conditions the grant stands on, in Paco's words; "no background processes" is stated as a condition, not a guarantee. */
export function grantCardText(i: { label: string; schedule: string; expires_local: string }): string {
  return [`🪜 **Standing approval** — I'll stop asking for **${i.label}** on "${i.schedule}".`,
    "You approved this exact command on three runs; the fourth ran sealed, exited 0, and its report reached you.",
    "From the next run, on this schedule only, it runs without a card:",
    "• in an empty folder with a fresh home, TCP egress only",
    "• with no background processes left behind (a condition, not a guarantee)",
    "• one run per fire; one byte changed asks again",
    `• until ${i.expires_local} (30 days)`,
    "Revoke stops it from the next run."].join("\n");
}

export function tamperedUseText(label: string): string {
  return `🛑 **Standing approval ended** — a standing run of **${label}** reported a broken seal (tampered, escaped, a failed check or a room left behind). From the next run it asks for a tap again.`;
}

export function revokeButton(standing_id: string, text = "🛑 Revoke"): NotificationButton {
  const data = `${SA_PREFIX}${standing_id}:revoke`;
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("standing callback_data exceeds 64 bytes");
  return { text, data };
}

/**
 * A standing use whose own facts show a broken seal ends its grant (tampered_use; the move ends with it) and tells
 * Paco. A use with no tool_finished yet is in flight and waits; one without clean-room facts has nothing to judge. Ending wins
 * over notifying: a card conflict is an incident, never a revived grant. Idempotent: an ended row is skipped.
 */
export function settleStandingUses(store: RunStore, run_id: string, now: string = new Date().toISOString()): number {
  const events = store.getLedgerEvents(run_id); let ended = 0;
  for (const u of events.filter((e) => e.event_type === "standing_used")) {
    const fin = events.find((e) => e.event_type === "tool_finished" && e.payload.tool_call_id === u.payload.tool_call_id)?.payload;
    const row = store.getStandingApproval(String(u.payload.standing_id));
    if (!fin || !brokeSeal(fin) || row?.state !== "standing") continue;
    if (!store.endStandingApproval({ standing_id: row.standing_id, reason: "tampered_use", now })) continue;
    ended++;
    if (enqueueUrgentCard(store, { chat_id: row.chat_id, key: `standing_tampered:${row.standing_id}`, text: tamperedUseText(row.label) }) === null) {
      openAlertedIncident(store, { kind: "standing_card_failed", subject: `standing:${row.standing_id}`, detail: { card: "tampered_use" }, now });
    }
  }
  return ended;
}

/** A sealed use's facts that break the seal; a non-boolean fact counts as broken (fail closed). */
function brokeSeal(fin: Record<string, unknown>): boolean {
  const c = fin.cleanroom;
  if (typeof c !== "object" || c === null) return false;
  const f = c as Record<string, unknown>;
  return f.tampered !== false || f.escaped !== false || f.check_failed !== false || (f.ran === true && f.torn_down !== true);
}

/** The dispatcher's onDelivered: a run's own terminal notice settles its sealed trial and its standing uses. Never throws: an error is an incident, never a reclassified delivery. */
export function settleDeliveredReport(store: RunStore, record: Pick<NotificationRecord, "intent_type" | "idempotency_key" | "run_id">, env: NodeJS.ProcessEnv = process.env,
  now: string = new Date().toISOString()): void {
  if (record.intent_type !== "final_report" || record.run_id === null || record.idempotency_key !== `${record.run_id}:final_report`) return;
  // two settlements, two catches: a failed trial settle (a grant card conflict, say) must not skip the standing-use check, nor the reverse
  const run_id = record.run_id;
  try { settleSealing(store, run_id, now); } catch (e) { settleFailed(store, `run:${run_id}`, e, env); }
  try { settleStandingUses(store, run_id, now); } catch (e) { settleFailed(store, `uses:${run_id}`, e, env); }
}

function settleFailed(store: RunStore, subject: string, e: unknown, env: NodeJS.ProcessEnv): void {
  try { openAlertedIncident(store, { kind: "standing_settle_failed", subject, detail: { error: errorCode(e) }, env }); }
  catch (inner) { console.error(`[standing] settle incident not recorded: ${errorCode(inner)}`); }
}

export interface StandingSweepResult { settled: number; ended: number }

/** The net under the dispatcher hook: every sealing row is re-settled (the TTL ends a trial nothing else settles) and every grant's uses re-read. Task 8 adds expiry, schedule end and stale. */
export function runStandingSweep(store: RunStore, now: string): StandingSweepResult {
  let settled = 0;
  for (const run_id of new Set(store.listStandingApprovals({ state: "sealing" }).map((r) => r.sealed_run_id ?? ""))) settled += settleQuietly(store, run_id, now);
  return { settled, ended: endTamperedUses(store, now) };
}

/** One poisoned trial (a grant card conflict) must not stop the rest of the sweep — a tamper end or an expiry behind it: its error is that run's incident. */
function settleQuietly(store: RunStore, run_id: string, now: string): number {
  try { return settleSealing(store, run_id, now).filter((o) => o.verdict !== "wait").length; }
  catch (e) { openAlertedIncident(store, { kind: "standing_settle_failed", subject: `run:${run_id}`, detail: { error: errorCode(e) }, now }); return 0; }
}

/** The net under the delivery hook: each standing row's uses (at most one per fire over 30 days) are re-read every cycle, so a missed delivery hook still ends a broken grant. */
function endTamperedUses(store: RunStore, now: string): number {
  const runs = new Set(store.listStandingApprovals({ state: "standing" }).flatMap((r) => store.listStandingUses(r.standing_id).map((u) => u.run_id)));
  let n = 0;
  for (const run_id of runs) n += settleStandingUses(store, run_id, now);
  return n;
}
```

`src/notifications/notification-dispatcher.ts`: `NotificationDispatcherOptions` gains
```ts
  /** Called after markDelivered committed (Stage 4A settles a sealed run here). A throw is logged and never reclassifies the delivered message. */
  onDelivered?: (record: NotificationRecord) => void;
```
the constructor stores `this.onDelivered = options.onDelivered;` (field `private readonly onDelivered: ((record: NotificationRecord) => void) | undefined;`), `dispatchOnce`'s try becomes
```ts
      const sent = await adapter.send(toDispatchRecord(claimed));
      this.outbox.markDelivered(claimed.notification_id, sent.provider_message_id);
      this.afterDelivered(claimed);
      return { status: "delivered", notification_id: claimed.notification_id };
```
and the class gains
```ts
  /** Its own catch: the row is already delivered, so nothing here may reach the markFailed arm below. */
  private afterDelivered(record: NotificationRecord): void {
    if (!this.onDelivered) return;
    try { this.onDelivered(record); }
    catch (error) { console.error(`[notification-dispatcher] onDelivered failed for ${record.notification_id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
```

`src/telegram/telegram-daemon.ts`: import `settleDeliveredReport` from `../decisions/standing-approval.js` and `type NotificationAdapters` beside `NotificationDispatcher`; add
```ts
/** The daemon's one sender: a delivered terminal notice settles that run's sealed trial and standing uses at once (Stage 4A §7); the schedule tick's sweep is the net. */
export function createOutboxDispatcher(store: RunStore, adapters: NotificationAdapters): NotificationDispatcher {
  return new NotificationDispatcher(new NotificationOutbox(store), adapters, { onDelivered: (record) => settleDeliveredReport(store, record) });
}
```
and line 249 becomes `const dispatcher = createOutboxDispatcher(options.store, {` with the same two adapters (the file keeps exactly one `new NotificationDispatcher(`, inside this function; a test pins it).

`src/run/schedule-tick.ts`: imports `runStandingSweep` from `../decisions/standing-approval.js`, `openAlertedIncident` from `./incident-alert.js`, `errorCode` from `../domain/error-code.js`; `maybeFireScheduledTasks` becomes
```ts
  const env = input.env ?? process.env;
  const result: ScheduleTickResult = { fired: 0, skipped_duplicates: 0, failures: 0 };
  sweepStanding(input.store, input.now, env); // before the flag: a scheduler that is off still settles, expires and ends standing rows
  if (!resolveSchedulerEnabled(env)) return result;
```
plus
```ts
/** Stage 4A's per-cycle sweep. Its own catch: a sweep error is an incident and never blocks a due fire. */
function sweepStanding(store: RunStore, now: string, env: NodeJS.ProcessEnv): void {
  try { runStandingSweep(store, now); }
  catch (error) {
    console.error(`[schedule-tick] standing sweep failed: ${errorCode(error)}`);
    try { openAlertedIncident(store, { kind: "standing_sweep_failed", subject: "daemon", detail: { error: errorCode(error) }, env, now }); } catch { /* the store itself may be the failure */ }
  }
}
```
(`RunStore` is already a type import in schedule-tick.ts.)

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/decisions/standing-approval.test.ts tests/notifications tests/telegram/telegram-daemon-standing.test.ts tests/telegram/telegram-daemon.test.ts tests/run/schedule-tick.test.ts tests/decisions/record.test.ts && npm test` → PASS, 0 skipped.

- [ ] **Step 5: Commit**
```bash
git add src/decisions/standing-approval.ts src/run/run-store.ts src/decisions/urgent.ts src/notifications/notification-dispatcher.ts src/telegram/telegram-daemon.ts src/run/schedule-tick.ts \
  tests/decisions/standing-approval.test.ts tests/notifications/notification-dispatcher.test.ts tests/telegram/telegram-daemon-standing.test.ts tests/run/schedule-tick.test.ts
git commit -m "feat(decisions): settleSealing grants on the full seal conjunction (Decision 1-A), settled on delivery and swept per cycle"
```

---

### Task 8: Revoke (`dec:sa:<standing_id>:revoke`), `/schedule` "常驻批准", expiry / schedule end / stale in the sweep, `cancelScheduledTask` ends rows

**Files:**
- Modify: `src/triggers/telegram-command-parser.ts` (`DEC_MOVE` 347, `ImprovementTap` 349–352, `parseImprovementCallback` 355–362)
- Modify: `src/gateway/improvement-commands.ts` (`Tap` 29, dispatch 37, new `standingTap` after `moveTap` 193–199)
- Modify: `src/gateway/gateway.ts` (`handleScheduleAdmin` 576–613)
- Modify: `src/decisions/standing-approval.ts` (`runStandingSweep`; new `standingScheduleSection`, `standingRevokedText`)
- Modify: `src/run/run-store.ts` (`cancelScheduledTask` 5821–5827)
- Test: `tests/triggers/decision-review-callback.test.ts` (extend), `tests/gateway/improvement-commands-standing.test.ts` (create), `tests/gateway/gateway-telegram.test.ts` (extend), `tests/decisions/standing-approval.test.ts` (extend), `tests/run/run-store-standing.test.ts` (extend)

**Code says otherwise (resolved here):**
- Spec §7 Taps: "one-shot (tap history)". `improvement_taps.subject_kind` is `CHECK (subject_kind IN ('proposal', 'job', 'move'))` (`run-store.ts:1286`); a new kind would need a table rebuild in an additive-only migration. A standing tap records `subject_kind: 'move'`, `subject_id: <standing_id>` (the `sa_` prefix tells it from an `lm_` id); `handleImprovementTap`'s mapping at `improvement-commands.ts:43` already sends every non-`pr`/`sk` kind to `"move"`. One-shot is enforced twice: `oncePerTrigger` replays a redelivered callback id, and `endStandingApproval`'s CAS (Task 1) makes a second tap on the same row `TAP_HANDLED_TEXT`.
- The trigger adapter (`telegram-trigger-adapter.ts:277–278`, `buildImprovementTapEvent` 371–383) and the gateway dispatch (`gateway.ts:202`) already carry every `ImprovementTap` kind; only the parser and the handler change. Improvement taps are already rate-limit exempt (`gateway.ts:137`).
- Revoke acts only on a `standing` row: the button exists only on the grant card and `/schedule`, both of which name a `standing` row; a streak/candidate/sealing row has no handle to revoke (a deny does that, §6).

**Interfaces (Produces):**
```ts
// telegram-command-parser.ts
export type ImprovementTap = … | { kind: "sa"; id: string; action: "revoke" };     // `dec:sa:sa_<uuid>:revoke`, 53 bytes
// improvement-commands.ts
function standingTap(store: RunStore, tap: Tap, chat_id: string, now: string): string
// standing-approval.ts
export function standingRevokedText(label: string): string
export function standingScheduleSection(store: RunStore, chat_id: string, env?: NodeJS.ProcessEnv): { text: string; button_rows: NotificationButton[][] }
export function runStandingSweep(store: RunStore, now: string): StandingSweepResult      // + expired / schedule_ended / stale
// run-store.ts
cancelScheduledTask(schedule_id: string, now?: string): boolean    // also ends every live standing row of the schedule (reason schedule_ended), same transaction
```
Consumes: Task 1 `endStandingApproval` (row + move in one transaction), `listStandingApprovals`, `getStandingApproval`, `StandingEndReason`; Task 3 `STANDING_STALE_MS` (run-store); Task 7 `revokeButton`, `SA_PREFIX`, `runStandingSweep`, `settleQuietly`, `endTamperedUses`; existing `oncePerTrigger` / `replyTo` (`memory-commands.ts`), `scheduleDisplayName`, `formatInstantInZone`, `resolveDisplayZone`.

- [ ] **Step 1: Failing tests.**

Append to `tests/triggers/decision-review-callback.test.ts` inside `describe("parseImprovementCallback", …)`:
```ts
  it("dec:sa:<sa_uuid>:revoke is the standing family; any other action, id shape or a move id under it is null", () => {
    expect(parseImprovementCallback(`dec:sa:sa_${u}:revoke`)).toEqual({ kind: "sa", id: `sa_${u}`, action: "revoke" });
    expect(Buffer.byteLength(`dec:sa:sa_${u}:revoke`)).toBeLessThanOrEqual(64);
    for (const bad of [`dec:sa:sa_${u}:ok`, `dec:sa:sa_${u}:no`, `dec:sa:lm_${u}:revoke`, `dec:sa:sa_${u}:revoke:x`, `dec:sa:sa_${u.toUpperCase()}:revoke`, "dec:sa::revoke"]) expect(parseImprovementCallback(bad)).toBeNull();
  });
```
and to `describe("the review tap through the adapter", …)`:
```ts
  it("an allowlisted Revoke tap becomes an improvement_tap event carrying the standing id", () => {
    const sa = "sa_0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(tap(111, `dec:sa:${sa}:revoke`)).toMatchObject({ ok: true, event: { type: "improvement_tap", notify: { kind: "telegram", chat_id: "222" }, metadata: { kind: "sa", id: sa, action: "revoke", telegram_callback_id: "cbq_9" } } });
    expect(tap(999, `dec:sa:${sa}:revoke`)).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });
```
(`u` is the uuid constant the existing describe declares at `decision-review-callback.test.ts:35`.)

Create `tests/gateway/improvement-commands-standing.test.ts`:
```ts
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
```

Append to `tests/gateway/gateway-telegram.test.ts` (top-level; add `import { revokeButton } from "../../src/decisions/standing-approval.js";`):
```ts
describe("/schedule 常驻批准 (Stage 4A §7)", () => {
  const list = (s: RunStore, chat_id: string, key: string) => {
    new Gateway(s).intake(buildTypedTaskEvent({ source: "telegram", type: "schedule_admin", program: "list", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id }, idempotency_key: key, source_reference: `telegram:update:${key}:message:1` }));
    return s.claimNextNotification("test", 30)!.payload;
  };
  it("lists this chat's standing rows with one Revoke button each; another chat's grant is neither shown nor offered", () => {
    const s = RunStore.openInMemory();
    try {
      const sch = s.addScheduledTask({ chat_id: "222", goal: "Alishan check-in post", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" });
      const mine = s.insertStandingApprovalForTest({ schedule_id: sch.schedule_id, chat_id: "222", action_fingerprint: "fp", state: "standing", expires_at: "2026-11-27T10:00:00.000Z" });
      s.insertStandingApprovalForTest({ schedule_id: "sch_other", chat_id: "999", action_fingerprint: "fp", state: "standing", expires_at: "2026-11-27T10:00:00.000Z" });
      s.insertStandingApprovalForTest({ schedule_id: sch.schedule_id, chat_id: "222", action_fingerprint: "fp2", state: "candidate" }); // not a grant: not listed
      const p = list(s, "222", "telegram:sa-list");
      expect(String(p.text)).toContain("常驻批准");
      expect(String(p.text)).toMatch(/#1 HTTP write · Alishan check-in post · 到期 2026-11-2[78]/);
      expect(String(p.text).match(/^#\d+ HTTP write/gm)).toHaveLength(1);
      expect(p.button_rows).toEqual([[revokeButton(mine.standing_id, "🛑 Revoke #1")]]);
    } finally { s.close(); }
  });
  it("with no standing row the reply carries no section and no keyboard (byte-identical to before)", () => {
    const s = RunStore.openInMemory();
    try {
      const p = list(s, "222", "telegram:sa-none");
      expect(String(p.text)).not.toContain("常驻批准");
      expect(p).not.toHaveProperty("button_rows");
    } finally { s.close(); }
  });
});
```

Append to `tests/decisions/standing-approval.test.ts` (add `import { parseImprovementCallback } from "../../src/triggers/telegram-command-parser.js";` to its imports — the parser lands in this task, so Task 7 could not assert the round trip):
```ts
describe("the standing callback round trip", () => {
  it("revokeButton data parses back to the standing family", () => {
    expect(parseImprovementCallback(revokeButton("sa_0f8fad5b-d9cb-469f-a165-70867728950e").data)).toEqual({ kind: "sa", id: "sa_0f8fad5b-d9cb-469f-a165-70867728950e", action: "revoke" });
  });
});

describe("runStandingSweep: expiry, schedule end, stale (§7)", () => {
  function standingOn(s: RunStore, o: { expires_at?: string; schedule_state?: "enabled" | "disabled" | "failed" } = {}) {
    const schedule_id = s.addScheduledTask({ chat_id: "555", goal: "post", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z", now: NOW }).schedule_id;
    if (o.schedule_state === "disabled") s.cancelScheduledTask(schedule_id, NOW);
    if (o.schedule_state === "failed") s.recordScheduleFailure(schedule_id, NOW, 1);
    const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    // inserted after the cancel, so only the sweep can end it (cancel's own end is tested in run-store-standing)
    return s.insertStandingApprovalForTest({ schedule_id, chat_id: "555", action_fingerprint: `fp_${++k}`, state: "standing", move_id, expires_at: o.expires_at ?? "2026-11-27T10:00:00.000Z" });
  }
  it("a grant past expires_at ends expired with its move; a disabled schedule ends it schedule_ended; a failed schedule keeps it (the use CAS refuses it; an update re-enables)", () => {
    const s = RunStore.openInMemory();
    const old = standingOn(s, { expires_at: NOW }); const off = standingOn(s, { schedule_state: "disabled" }); const parked = standingOn(s, { schedule_state: "failed" }); const live = standingOn(s);
    expect(runStandingSweep(s, NOW)).toEqual({ settled: 0, ended: 2 });
    expect(s.getStandingApproval(old.standing_id)).toMatchObject({ state: "ended", ended_reason: "expired" });
    expect(s.getLadderMove(old.move_id!)?.state).toBe("ended");
    expect(s.getStandingApproval(off.standing_id)).toMatchObject({ state: "ended", ended_reason: "schedule_ended" });
    expect(s.getStandingApproval(parked.standing_id)?.state).toBe("standing");
    expect(s.getStandingApproval(live.standing_id)?.state).toBe("standing");
  });
  it("a streak or candidate idle 30 days ends stale; one idle 29 days stays; a sealing row is the settler's, never stale", () => {
    const s = RunStore.openInMemory();
    const day = 24 * 60 * 60 * 1000; const ago = (d: number) => new Date(Date.parse(NOW) - d * day).toISOString();
    const st = s.insertStandingApprovalForTest({ schedule_id: "sch_s", chat_id: "555", action_fingerprint: "a", state: "streak", created_at: ago(30) });
    const cand = s.insertStandingApprovalForTest({ schedule_id: "sch_c", chat_id: "555", action_fingerprint: "b", state: "candidate", created_at: ago(29) });
    expect(runStandingSweep(s, NOW).ended).toBe(1);
    expect(s.getStandingApproval(st.standing_id)).toMatchObject({ state: "ended", ended_reason: "stale" });
    expect(s.getStandingApproval(cand.standing_id)?.state).toBe("candidate");
  });
});
```

Append to `tests/run/run-store-standing.test.ts`:
```ts
describe("cancelScheduledTask ends the schedule's standing rows at once (§7)", () => {
  it("every live row of the cancelled schedule ends schedule_ended with its move; another schedule's row stands; a second cancel changes nothing", () => {
    const s = RunStore.openInMemory();
    const a = s.addScheduledTask({ chat_id: "555", goal: "a", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" }).schedule_id;
    const b = s.addScheduledTask({ chat_id: "555", goal: "b", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" }).schedule_id;
    const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    const grant = s.insertStandingApprovalForTest({ ...KEY, schedule_id: a, state: "standing", move_id, expires_at: "2027-01-01T00:00:00.000Z" });
    const streak = s.insertStandingApprovalForTest({ ...KEY, schedule_id: a, action_fingerprint: "fp2", state: "streak" });
    const other = s.insertStandingApprovalForTest({ ...KEY, schedule_id: b, state: "standing", expires_at: "2027-01-01T00:00:00.000Z" });
    expect(s.cancelScheduledTask(a, NOW)).toBe(true);
    for (const r of [grant, streak]) expect(s.getStandingApproval(r.standing_id)).toMatchObject({ state: "ended", ended_reason: "schedule_ended" });
    expect(s.getLadderMove(move_id)?.state).toBe("ended");
    expect(s.getStandingApproval(other.standing_id)?.state).toBe("standing");
    expect(s.cancelScheduledTask(a, NOW)).toBe(false);
    expect(s.getLedgerEvents().filter((e) => e.event_type === "standing_ended")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/triggers/decision-review-callback.test.ts tests/gateway/improvement-commands-standing.test.ts tests/gateway/gateway-telegram.test.ts tests/decisions/standing-approval.test.ts tests/run/run-store-standing.test.ts` → FAIL (`dec:sa:` parses to null; no section; sweep ends nothing; cancel leaves rows).

- [ ] **Step 3: Implement.**

`src/triggers/telegram-command-parser.ts`:
```ts
const DEC_STANDING = new RegExp(`^dec:sa:(sa_${LC_UUID}):(revoke)$`);
export type ImprovementTap =
  | { kind: "pr"; id: string; action: "acc" | "dis" | "rev" }
  | { kind: "sk"; id: string; action: "accept" | "dismiss" | "replace" | "keep" }
  | { kind: "lm"; id: string; action: "revoke" }
  | { kind: "sa"; id: string; action: "revoke" };
```
and the tail of `parseImprovementCallback` (doc comment: "the four improvement tap families" — `dec:sa:` is Stage 4A's Revoke, ≤ 53 bytes):
```ts
  const lm = DEC_MOVE.exec(data);
  if (lm) return { kind: "lm", id: lm[1]!, action: "revoke" };
  const sa = DEC_STANDING.exec(data);
  return sa ? { kind: "sa", id: sa[1]!, action: "revoke" } : null;
```

`src/gateway/improvement-commands.ts`: `interface Tap { kind: "pr" | "sk" | "lm" | "sa"; … }`; line 37 becomes
```ts
      text = tap.kind === "pr" ? proposalTap(store, skills, tap, chatOf(event), now) : tap.kind === "sk" ? jobTap(store, skills, tap, chatOf(event), now)
        : tap.kind === "sa" ? standingTap(store, tap, chatOf(event), now) : moveTap(store, tap, chatOf(event), now);
```
(line 43's mapping already records `sa` as `"move"`; add the comment `// improvement_taps.subject_kind is CHECK-bound to three kinds: a standing tap is a move tap whose id starts sa_`). Import `standingRevokedText` from `../decisions/standing-approval.js`. After `moveTap`:
```ts
/** Stage 4A §7: Revoke works for the grant's whole 30 days (never TAP_STALE_DAYS), only from the row's chat; the row and its move end in one transaction (endStandingApproval). */
function standingTap(store: RunStore, tap: Tap, chat_id: string, now: string): string {
  const row = store.getStandingApproval(tap.id);
  if (!row || row.chat_id !== chat_id || row.state !== "standing") return TAP_HANDLED_TEXT;
  return store.endStandingApproval({ standing_id: row.standing_id, reason: "revoked", now }) ? standingRevokedText(row.label) : TAP_HANDLED_TEXT;
}
```
Update the file's header comment: "… within TAP_STALE_DAYS (a standing Revoke: within the grant's own 30 days) …".

`src/decisions/standing-approval.ts` adds (imports gain `STANDING_STALE_MS, type StandingEndReason` from `../run/run-store.js`):
```ts
export function standingRevokedText(label: string): string {
  return `🛑 Revoked. ${label} on this schedule asks for a tap again from the next run.`;
}

/** `/schedule`'s "常驻批准" (spec §7): this chat's grants, `#N label · schedule · 到期 date`, one Revoke per row; empty when there are none. */
export function standingScheduleSection(store: RunStore, chat_id: string, env: NodeJS.ProcessEnv = process.env): { text: string; button_rows: NotificationButton[][] } {
  const rows = store.listStandingApprovals({ state: "standing", chat_id });
  if (rows.length === 0) return { text: "", button_rows: [] };
  const tz = resolveDisplayZone(env);
  const lines = rows.map((r, k) => `#${k + 1} ${r.label} · ${scheduleDisplayName(store.getScheduledTask(r.schedule_id)?.goal ?? "")} · 到期 ${r.expires_at ? formatInstantInZone(r.expires_at, tz).slice(0, 10) : "?"}`);
  return { text: `\n\n**常驻批准**\n${lines.join("\n")}`, button_rows: rows.map((r, k) => [revokeButton(r.standing_id, `🛑 Revoke #${k + 1}`)]) };
}
```
and `runStandingSweep` becomes:
```ts
export function runStandingSweep(store: RunStore, now: string): StandingSweepResult {
  let settled = 0;
  for (const run_id of new Set(store.listStandingApprovals({ state: "sealing" }).map((r) => r.sealed_run_id ?? ""))) settled += settleQuietly(store, run_id, now);
  return { settled, ended: endTamperedUses(store, now) + endLapsed(store, now) + endStale(store, now) };
}

/** A grant past expires_at, or whose schedule can never fire again (disabled or gone). A 'failed' schedule keeps it: the use CAS already refuses it and an update re-enables. */
function endLapsed(store: RunStore, now: string): number {
  let n = 0;
  for (const r of store.listStandingApprovals({ state: "standing" })) {
    const schedule = store.getScheduledTask(r.schedule_id);
    const reason: StandingEndReason | null = r.expires_at === null || r.expires_at <= now ? "expired" : !schedule || schedule.state === "disabled" ? "schedule_ended" : null;
    if (reason && store.endStandingApproval({ standing_id: r.standing_id, reason, now })) n++;
  }
  return n;
}

/** A streak or candidate with no new credit for 30 days (spec §Decision 4). A sealing row is settled, never staled. */
function endStale(store: RunStore, now: string): number {
  const cutoff = new Date(Date.parse(now) - STANDING_STALE_MS).toISOString();
  let n = 0;
  for (const state of ["streak", "candidate"] as const) {
    for (const r of store.listStandingApprovals({ state })) if (r.updated_at <= cutoff && store.endStandingApproval({ standing_id: r.standing_id, reason: "stale", now })) n++;
  }
  return n;
}
```

`src/gateway/gateway.ts` `handleScheduleAdmin`: import `standingScheduleSection` from `../decisions/standing-approval.js` and `type NotificationButton` from `../notifications/notification-types.js` (if not already imported); the branch and the enqueue become
```ts
    let text: string;
    let button_rows: NotificationButton[][] = [];
    if (action === "cancel") {
      …unchanged…
    } else {
      // Stage 4A: this chat's standing grants, each with its Revoke (buttons render on any intent)
      const standing = standingScheduleSection(this.runStore, chat_id, process.env);
      text = formatScheduleListText(this.runStore.listScheduledTasks(chat_id)) + formatSystemScheduleSection(process.env, now) + standing.text;
      button_rows = standing.button_rows;
    }
    …
      payload: { text, ...(button_rows.length > 0 ? { button_rows } : {}) }
```

`src/run/run-store.ts` `cancelScheduledTask`:
```ts
  cancelScheduledTask(schedule_id: string, now: string = new Date().toISOString()): boolean {
    return this.joinTransaction(() => {
      const result = this.db.prepare(`
        UPDATE scheduled_tasks SET state = 'disabled', updated_at = ?
        WHERE schedule_id = ? AND state IN ('enabled', 'failed')
      `).run(now, schedule_id);
      if (result.changes !== 1) return false;
      // Stage 4A §7: a schedule that can never fire again holds no standing authority, and no streak toward one
      for (const r of this.listStandingApprovals({ schedule_id })) if (r.state !== "ended") this.endStandingTx({ standing_id: r.standing_id, reason: "schedule_ended", now });
      return true;
    });
  }
```
(Add to its doc comment: "Ends the schedule's live standing rows in the same transaction.") Callers (`gateway.ts:629/634`, `schedule-tick.ts:175`, `core-worker.ts:3773`) are outside any raw `BEGIN`, so `joinTransaction` is safe there.

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/triggers tests/gateway tests/decisions/standing-approval.test.ts tests/run/run-store-standing.test.ts tests/run/schedule-tick.test.ts && npm test` → PASS, 0 skipped. (Task 4's refusal matrix disables its schedule by raw SQL, so the cancel-ends-rows change here leaves its exact `schedule_not_enabled` assertion intact.)

- [ ] **Step 5: Commit**
```bash
git add src/triggers/telegram-command-parser.ts src/gateway/improvement-commands.ts src/gateway/gateway.ts src/decisions/standing-approval.ts src/run/run-store.ts \
  tests/triggers/decision-review-callback.test.ts tests/gateway/improvement-commands-standing.test.ts tests/gateway/gateway-telegram.test.ts tests/decisions/standing-approval.test.ts tests/run/run-store-standing.test.ts
git commit -m "feat(decisions): standing Revoke tap, /schedule 常驻批准 with Revoke buttons, expiry/schedule-end/stale sweep, cancel ends rows"
```

---

### Task 9: Digest lines — one per `sealed_trial_failed` and `ended(denied | expired | stale | mismatch)` since the last digest

**Files:**
- Modify: `src/decisions/digest.ts` (new `standingLines` after `improvementsToday` 253–270; `buildDecisionDigest` 337–350)
- Modify: `src/run/run-store.ts` (`lastSentDecisionDigestAt` after `getDecisionDigest` ~5054)
- Test: `tests/decisions/digest.test.ts` (extend)

**Code says otherwise (resolved here):** "since the last digest" — the digest's own window is `DIGEST_WINDOW_MS` (24 h) before `now` (`digest.ts:23`, `:339` for Improvements today), but the tick runs once per local date at a **variable** time (`runDecisionDigestTick`, `digest.ts:354`: at or after `HOUGE_DECISION_DIGEST_AT`, possibly late after downtime), so a fixed 24 h window drops an end after a late tick and can repeat one after an early one. The standing lines therefore read a **persisted cutoff**: the `created_at` of the newest `decision_digests` row with `sent = 1` (`lastSentDecisionDigestAt`). That row is written with `created_at = i.now` in the same transaction as the enqueue (`digest.ts` `runDecisionDigestTick`), so the cutoff advances atomically with the message; a digest that was not sent does not advance it. Lines are `since < ended_at ≤ now` (the upper bound closes the gap between building the digest outside the transaction and recording it: a later end belongs to the next digest, whose `since` is this `now`). With no sent digest yet, the 24 h window is the fallback. Improvements today keeps its own window (not this task's concern). `revoked`, `schedule_ended` and `tampered_use` get no line (the first two are Paco's own acts; `tampered_use` already reached him as an urgent card, Ruling 3; spec §8 lists none of them). A section of its own ("**Standing approvals**"), counted in the empty-day check, because nothing else tells Paco a sealed trial failed or a grant lapsed.

**Interfaces (Produces):**
```ts
export const STANDING_DIGEST_TEXT: Readonly<Record<"sealed_trial_failed" | "denied" | "expired" | "stale" | "mismatch", string>>;
export function standingLines(store: RunStore, since: string, until: string, chatId?: string): string[]
// run-store.ts
lastSentDecisionDigestAt(): string | undefined     // MAX(created_at) over decision_digests WHERE sent = 1
```
Consumes: Task 1 `listStandingApprovals({ state: "ended", chat_id })`, `StandingApprovalRow.ended_reason / ended_at / label / schedule_id`; Task 3 deny rows (`ended_reason: "denied"`); Task 4 `mismatch`; Task 7 `sealed_trial_failed`; Task 8 `expired`, `stale`.

- [ ] **Step 1: Failing test** — append to `tests/decisions/digest.test.ts` (import `standingLines, STANDING_DIGEST_TEXT` beside `buildDecisionDigest`):
```ts
describe("Standing approvals in the digest (Stage 4A §8)", () => {
  const ended = (s: RunStore, reason: string, ended_at: string, chat_id = "555", fp = `fp_${reason}_${ended_at}_${chat_id}`) =>
    s.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id, action_fingerprint: fp, state: "ended", ended_reason: reason, ended_at, created_at: "2026-10-01T00:00:00.000Z" });
  it("one line per sealed_trial_failed / denied / expired / stale / mismatch inside the window; revoked, schedule_ended (Paco's own acts), tampered_use (already an urgent card), older and later ends get none", () => {
    const s = RunStore.openInMemory();
    s.addScheduledTask({ chat_id: "555", goal: "x", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" });
    for (const r of ["sealed_trial_failed", "denied", "expired", "stale", "mismatch", "revoked", "schedule_ended", "tampered_use"]) ended(s, r, "2026-10-21T09:00:00.000Z");
    ended(s, "denied", "2026-10-19T09:00:00.000Z"); // before the window
    ended(s, "expired", "2026-10-21T11:00:01.000Z"); // after this digest's now: the next digest's
    ended(s, "stale", "2026-10-21T09:00:00.000Z", "-999"); // another chat
    const lines = standingLines(s, "2026-10-20T11:00:00.000Z", NOW, "555");
    expect(lines).toHaveLength(5);
    for (const r of ["sealed_trial_failed", "denied", "expired", "stale", "mismatch"] as const) expect(lines.some((l) => l.endsWith(STANDING_DIGEST_TEXT[r]))).toBe(true);
    expect(lines.every((l) => l.startsWith("· HTTP write"))).toBe(true);
  });
  it("the section alone keeps the digest from being skipped (a failed sealed trial must reach Paco)", () => {
    const s = RunStore.openInMemory();
    ended(s, "sealed_trial_failed", "2026-10-21T09:00:00.000Z");
    const d = buildDecisionDigest(s, NOW, ENV, "555");
    expect(d?.text).toContain("**Standing approvals**");
    expect(d?.text).toContain(STANDING_DIGEST_TEXT.sealed_trial_failed);
    expect(buildDecisionDigest(RunStore.openInMemory(), NOW, ENV, "555")).toBeNull();
  });
  it("the window is the last sent digest's persisted cutoff: a tick delayed past 24 h (or a daemon that was down) still shows the end, and the next digest never repeats it", () => {
    const s = RunStore.openInMemory();
    s.recordDecisionDigest({ local_date: "2026-10-19", sent: true, offered: [], created_at: "2026-10-19T10:00:00.000Z" }); // 49 h before NOW
    ended(s, "expired", "2026-10-19T12:00:00.000Z"); // 47 h before NOW: a fixed 24 h window would drop it
    ended(s, "stale", "2026-10-19T09:00:00.000Z"); // before that cutoff: the 2026-10-19 digest already carried it
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: true });
    const text = String(drainOutbox(s).get("decision_digest:2026-10-21")?.text);
    expect(text).toContain(STANDING_DIGEST_TEXT.expired);
    expect(text).not.toContain(STANDING_DIGEST_TEXT.stale);
    expect(s.lastSentDecisionDigestAt()).toBe(NOW); // advanced in the transaction that queued the message
    const next = new Date(Date.parse(NOW) + 24 * 60 * 60 * 1000).toISOString();
    expect(buildDecisionDigest(s, next, ENV, "555")?.text ?? "").not.toContain(STANDING_DIGEST_TEXT.expired);
  });
  it("a digest that was not sent (a conflict or an empty day) does not advance the cutoff", () => {
    const s = RunStore.openInMemory();
    s.recordDecisionDigest({ local_date: "2026-10-19", sent: true, offered: [], created_at: "2026-10-19T10:00:00.000Z" });
    s.recordDecisionDigest({ local_date: "2026-10-20", sent: false, offered: [], created_at: "2026-10-20T10:00:00.000Z" });
    expect(s.lastSentDecisionDigestAt()).toBe("2026-10-19T10:00:00.000Z");
    expect(RunStore.openInMemory().lastSentDecisionDigestAt()).toBeUndefined();
  });
});
```
(`NOW` = `2026-10-21T11:00:00.000Z`, `ENV` = Sydney: the file's existing constants. An empty store's digest is null: the existing "skips an empty day entirely" test, `digest.test.ts:42`.)

- [ ] **Step 2: Run to verify failure** — `set -o pipefail; npx vitest run tests/decisions/digest.test.ts -t "Standing approvals"` → FAIL (`standingLines` not exported; `lastSentDecisionDigestAt` is not a function).

- [ ] **Step 3: Implement.** `src/run/run-store.ts`, after `getDecisionDigest`:
```ts
  /** The persisted digest cutoff (Stage 4A §8): the newest digest that went out. Its created_at commits with its enqueue, so it advances atomically with the message. */
  lastSentDecisionDigestAt(): string | undefined {
    return this.db.prepare(`SELECT MAX(created_at) AS at FROM decision_digests WHERE sent = 1`).get<{ at: string | null }>()?.at ?? undefined;
  }
```
`src/decisions/digest.ts` (import `scheduleDisplayName` beside `formatInstantInZone`):
```ts
/** Stage 4A §8: an end Paco did not cause by his own tap; Revoke and a cancelled schedule are his acts, and a tampered use already sent an urgent card — none gets a line. */
export const STANDING_DIGEST_TEXT = {
  sealed_trial_failed: "the sealed run did not seal; it keeps asking",
  denied: "denied; no standing approval for these bytes for 30 days",
  expired: "the 30 days ran out; it asks again",
  stale: "no approval in 30 days; the streak was dropped",
  mismatch: "the command changed under the grant; it asks again"
} as const;

/** One line per standing row ended in (since, until] for one of those reasons, in the chat's own rows only (the taps it implies are chat-bound). */
export function standingLines(store: RunStore, since: string, until: string, chatId?: string): string[] {
  const rows = store.listStandingApprovals({ state: "ended", ...(chatId !== undefined ? { chat_id: chatId } : {}) });
  return rows.filter((r) => r.ended_at !== null && r.ended_at > since && r.ended_at <= until && r.ended_reason !== null && Object.hasOwn(STANDING_DIGEST_TEXT, r.ended_reason))
    .map((r) => `· ${r.label} · ${scheduleDisplayName(store.getScheduledTask(r.schedule_id)?.goal ?? "") || r.schedule_id} — ${STANDING_DIGEST_TEXT[r.ended_reason as keyof typeof STANDING_DIGEST_TEXT]}`);
}
```
`buildDecisionDigest`:
```ts
  const windowStart = new Date(Date.parse(now) - DIGEST_WINDOW_MS).toISOString();
  const today = improvementsToday(store, windowStart, chatId);
  // the persisted cutoff, not the window: the tick runs once per local date at a variable time, so a fixed 24 h would drop or repeat an end
  const standing = standingLines(store, store.lastSentDecisionDigestAt() ?? windowStart, now, chatId);
  …
  if (today.lines.length + standing.length + waiting.lines.length + unsure.lines.length + watch.length === 0) return null;
  …
  if (today.lines.length > 0) sections.push(["**Improvements today**", ...today.lines].join("\n"));
  if (standing.length > 0) sections.push(["**Standing approvals**", ...standing].join("\n"));
```
Update the file's header comment: the section list gains "Standing approvals (Stage 4A: trials that did not seal, grants that lapsed or were denied)".

- [ ] **Step 4: Run** — `set -o pipefail; npm run typecheck && npx vitest run tests/decisions/digest*.test.ts` → PASS (the existing "three sections and nothing else" test has no ended standing rows, so its headers are unchanged).

- [ ] **Step 5: Commit**
```bash
git add src/decisions/digest.ts src/run/run-store.ts tests/decisions/digest.test.ts
git commit -m "feat(decisions): digest lines for failed sealed trials and lapsed or denied standing approvals, over the persisted digest cutoff"
```

---

### Task 10: `scripts/check-standing-rollback.mjs` — the previous build on a DB holding standing rows, events, uses and a `standing` decision reason

**Files:**
- Create: `scripts/check-standing-rollback.mjs`
- Modify: `scripts/old-dist-provenance.mjs` (`verifyOldDist` 12–20: an optional fifth parameter naming the file that must differ)

**Code says otherwise (resolved here):** `verifyOldDist` proves `--old-dist` is a previous build by requiring `core/core-worker.js` to differ (`old-dist-provenance.mjs:18–19`). Stage 4A does not edit `src/core/core-worker.ts` (Task 2: no edit needed), so the compiled file is byte-identical and the check would refuse a genuine previous build. The helper gains `file = "core/core-worker.js"` (default unchanged for the four existing callers); this script passes `"omp/bridge-handler.js"`, which Tasks 5–6 change. It additionally refuses an `--old-dist` that contains `decisions/standing-approval.js`.

**What it proves (spec §5 rollback, in full like `check-ladder-2b-hooks-rollback.mjs`):** on a VACUUM copy of the live DB the **new** build migrates and seeds, in one transaction, a granted standing row (move active, `expires_at` +30 d), all six `standing_*` events on a completed scheduled run, a `tool.policy` decision with `reason_code: "standing"`, then one real `standingUse` (a `standing_uses` row). The **previous** build then: opens the copy (its migrations run); renders `/status decisions` and the digest; runs its invariant detection against an unseeded baseline; answers `/schedule` for the chat; runs a scheduled turn's bridge call on **the granted bytes on the granted schedule** — it must emit `approval_requested` (asks again), the approval is resolved through its own `Gateway` (an approval resolve), the stub adapter runs once, and **no** `standing_uses` row / `standing_used` event / `last_used_run_id` change appears (never uses the grant); fires a schedule tick on the seeded due schedule; with `--session-dir`, resumes a kept transcript on the real omp and answers one turn. The new build reopens the copy last and its sweep runs clean. Exit 0 PASS · 1 FAIL · 2 setup error · 3 INCONCLUSIVE.

- [ ] **Step 1: `scripts/old-dist-provenance.mjs`** — the signature becomes `export function verifyOldDist(oldDist, newDist, base = DEFAULT_OLD_BASE, file = "core/core-worker.js")`; lines 18–19 read `join(oldDist, file)` / `join(newDist, file)` and the message names `${file}`. Header comment gains: "`file` names the compiled module the slice changed (a slice that leaves core-worker.ts untouched passes another)." Run `set -o pipefail; node --check scripts/old-dist-provenance.mjs && node --check scripts/check-ladder-2b-hooks-rollback.mjs` → no output.

- [ ] **Step 2: Create `scripts/check-standing-rollback.mjs`:**
```js
#!/usr/bin/env node
// Rollback check — decision ladder Stage 4A, standing approval (spec 2026-10-28 §5; plan Task 10).
//
//   From the feature worktree, after `npm run build` there:
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-standing-rollback.mjs \
//     --old-dist <a worktree at the merge base>/dist [--old-base <sha>] [--db <path>] \
//     [--session-dir <kept gate run>/case-<tag>-<n>/data/omp/sessions/chat--4200] [--keep]
//
// The migration is additive (standing_approvals, standing_uses); a rollback is revert + rebuild, and the previous build must
// never read the tables and keep asking. A VACUUM copy of the live DB is migrated by the new build, which seeds a granted
// standing row on a seeded schedule, the six standing_* events on a completed scheduled run, a tool.policy decision with
// reason "standing", and one real standing use. The previous build then opens the copy and renders /status decisions, the
// digest and /schedule, runs its invariant detection, makes a scheduled bridge call on the granted bytes (it must ask; the
// approval is resolved through its own gateway; no standing use appears), fires a schedule tick, and — with --session-dir —
// resumes a kept transcript on the real omp. The new build reopens the copy last. Exit 0 PASS · 1 FAIL · 2 setup error ·
// 3 INCONCLUSIVE (no --session-dir, omp unavailable, or no digest due). The temp root is deleted unless --keep. Never opens
// the live DB for writing; never messages any chat (Telegram tokens deleted; nothing here constructs a Telegram client).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { verifyOldDist } from "./old-dist-provenance.mjs";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const CHAT = "-4200";
const OPERATOR = { kind: "user", id: "rollback" };
const CMD = "curl -s -m 10 -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post";
const failures = []; const inconclusive = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const cannotRun = (name, why) => { console.log(`INCONCLUSIVE ${name} — ${why}`); inconclusive.push(`${name}: ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = { root: null, keep: false };
const cleanup = () => { if (temp.root && !temp.keep) rmSync(temp.root, { recursive: true, force: true }); else if (temp.root) console.log(`temp dir kept (holds a live-DB copy): ${temp.root}`); temp.root = null; };
const load = async (dist, ps) => Object.assign({}, ...(await Promise.all(ps.map((p) => import(join(dist, p))))));
const msg = (e) => (e instanceof Error ? e.message : String(e));
const PASS_JUDGE = async (i) => ({ text: i.text, verdict: "pass", withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 0, unanswered: 0, skipped: false, blocked: null, decisionId: null, masked: 0 });

function parseArgs(argv) {
  const a = { oldDist: null, oldBase: null, db: null, sessionDir: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist") a.oldDist = resolve(argv[++i]); else if (argv[i] === "--old-base") a.oldBase = argv[++i];
    else if (argv[i] === "--db") a.db = resolve(argv[++i]); else if (argv[i] === "--session-dir") a.sessionDir = resolve(argv[++i]);
    else if (argv[i] === "--keep") a.keep = true; else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!NEW_DIST.includes("/.worktrees/")) throw new Error(`run from the feature worktree (this dist is ${NEW_DIST})`);
  if (!a.oldDist || !existsSync(join(a.oldDist, "omp/bridge-handler.js"))) throw new Error("--old-dist <previous build's dist> is required");
  a.oldBase ??= execFileSync("git", ["merge-base", "main", "HEAD"], { encoding: "utf8" }).trim();
  if (!a.oldBase) throw new Error("--old-base must be a non-empty commit");
  const prov = verifyOldDist(a.oldDist, NEW_DIST, a.oldBase, "omp/bridge-handler.js");
  if (existsSync(join(a.oldDist, "decisions/standing-approval.js"))) throw new Error("--old-dist contains the Stage 4A code: it is not the previous build");
  if (a.sessionDir && !existsSync(a.sessionDir)) throw new Error(`--session-dir ${a.sessionDir} does not exist`);
  console.log(`old build: worktree HEAD ${prov.head.slice(0, 12)} (base ${a.oldBase.slice(0, 12)}), bridge-handler.js ${prov.oldHash} (new ${prov.newHash})`);
  return a;
}

/** The live DB is in use by the daemon: a VACUUM INTO that meets its write lock is retried (5 × 1 s) before it is a setup error. */
function copyDb(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(msg(e))) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000); }
    finally { src.close(); }
  }
}

function isolate(root) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  Object.assign(process.env, { HOUGE_TELEGRAM_CHAT_ID: CHAT, HOUGE_LESSON_SESSION_RESET: "0", HOUGE_JEV_TRIAGE_ENABLED: "off",
    HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_DAEMON_TMP_DIR: join(root, "daemon-tmp"),
    HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"), HOUGE_DISARM_PATH: join(root, "houge.disarm") });
}

function intake(m, store, dataDir, event) {
  const r = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir }).intake(m.buildTypedTaskEvent(event));
  if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
  return r.run_id;
}
const scheduledTurn = (schedule_id, key) => ({ source: "schedule", type: "turn", program: "turn", goal: "rollback 4A check-in", requested_by: { kind: "schedule", id: schedule_id },
  notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `schedule:${schedule_id}:rb4a:${key}`, source_reference: `scheduled_tasks.${schedule_id}` });
const userTurn = (goal, key) => ({ source: "telegram", type: "turn", program: "turn", goal, requested_by: OPERATOR, notify: { kind: "telegram", chat_id: CHAT },
  idempotency_key: `rollback4a:${key}`, source_reference: `rollback4a:${key}` });

/** Step 1, the new build: migrate, then a granted row, six events, a standing decision, and one real use; then the copy's other schedules are quieted. */
function seedNew(m, path, root) {
  const seed = seedRows(m, path, root);
  quietOtherSchedules(path, seed.schedule_id);
  return seed;
}

/**
 * The old tick takes at most three due schedules (schedule-tick.ts), and the live copy holds older ones that could fill every slot:
 * on the COPY only, every other enabled schedule is disabled, so the seeded one is the due one the tick must fire.
 */
function quietOtherSchedules(path, schedule_id) {
  const db = new DatabaseSync(path);
  try { const r = db.prepare(`UPDATE scheduled_tasks SET state = 'disabled' WHERE state = 'enabled' AND schedule_id <> ?`).run(schedule_id); console.log(`  copy: ${r.changes} other schedule(s) disabled for the tick probe`); }
  finally { db.close(); }
}

function seedRows(m, path, root) {
  const s = m.RunStore.open(path);
  try {
    const now = new Date().toISOString();
    const schedule_id = s.addScheduledTask({ chat_id: CHAT, goal: "rollback 4A: Alishan check-in", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney",
      next_run_at: new Date(Date.now() - 60_000).toISOString(), now }).schedule_id; // due: the old build's tick must fire it
    const run = intake(m, s, root, scheduledTurn(schedule_id, `seed:${Date.now()}`));
    s.claimRun(run, "rollback-4a", 60);
    const action_fingerprint = m.actionFingerprint("shell_external", m.OMP_SHELL_META.shell_external, { command: CMD });
    const seed = s.inTransaction(() => {
      const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "rb4a", from_rung: "paco", to_rung: "rule", evidence: ["rb-a1", "rb-a2", "rb-a3", "rb-a4", "rb-dec", run, "rb-tc4"],
        granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true, created_at: now });
      const row = s.insertStandingApprovalForTest({ schedule_id, chat_id: CHAT, action_fingerprint, state: "standing", move_id, credited_runs_json: '["rb-r1","rb-r2","rb-r3"]',
        approval_ids_json: '["rb-a1","rb-a2","rb-a3","rb-a4"]', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), created_at: now });
      const id = row.standing_id;
      for (const [type, payload] of [["standing_streak", { run_id: run, approval_id: "rb-a1", streak: 1 }], ["standing_sealing", { run_id: run, tool_call_id: "rb-tc4", approval_id: "rb-a4" }],
        ["standing_sealed", { run_id: run, tool_call_id: "rb-tc4", exit_code: 0 }], ["standing_granted", { move_id }], ["standing_ended", { reason: "stale" }]]) s.appendStandingLedgerEvent(type, { standing_id: id, ...payload }, run);
      const decision = s.insertDecision({ entry_id: "tool.policy", entry_version: 3, run_id: run, tool_call_id: "rb-tc5", stage: "pre_tool", rung: "rule", verdict: "allowed", p: null,
        reason_code: "standing", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0 });
      return { standing_id: id, move_id, decision };
    });
    const used = s.standingUse({ standing_id: seed.standing_id, action_fingerprint, run_id: run, tool_call_id: "rb-tc5", now }); // the sixth event type, through the real CAS
    if (!used.ok) throw new Error(`seed standing use refused: ${used.code}`);
    if (!s.finishRun({ run_id: run, expected_worker_id: "rollback-4a", next: "completed", report_ref: "runs/rollback-check-4a.md", duration_ms: 1, tool_calls: 1 })) throw new Error("the seed run did not complete");
    return { run, schedule_id, action_fingerprint, ...seed };
  } finally { s.close(); }
}

/** Read-only view of what the previous build must leave alone. */
function snapshot(path, seed) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const row = one(`SELECT state, move_id, last_used_run_id, updated_at, expires_at FROM standing_approvals WHERE standing_id = ?`, seed.standing_id);
    return { row: JSON.stringify(row), uses: one(`SELECT COUNT(*) AS n FROM standing_uses`).n, move: one(`SELECT state FROM ladder_moves WHERE move_id = ?`, seed.move_id)?.state,
      events: db.prepare(`SELECT event_type, COUNT(*) AS n FROM ledger_events WHERE event_type LIKE 'standing_%' GROUP BY event_type ORDER BY event_type`).all().map((r) => `${r.event_type}:${r.n}`).join(","),
      reason: one(`SELECT reason_code FROM decisions WHERE decision_id = ?`, seed.decision)?.reason_code };
  } finally { db.close(); }
}

const violationKinds = (old, store) => [...new Set(old.detectViolations(store, new Date().toISOString()).map((v) => v.kind))].sort();
function baselineKinds(old, path) { const s = old.RunStore.open(path); try { return violationKinds(old, s); } finally { s.close(); } }

/** Step 2, the previous build: migrations, /status decisions, the digest, invariants, /schedule. */
function oldReads(old, path, seed, baseline, root) {
  const s = old.RunStore.open(path);
  try {
    check("the previous build opens the copy (its migrations ran)", true);
    let list = "";
    try { list = old.decisionListText(s, process.env); check("the previous build's /status decisions renders over a standing decision", true); } catch (e) { check("the previous build's /status decisions renders over a standing decision", false, msg(e)); }
    check("/status decisions shows the seeded tool.policy row", list.includes("tool.policy"), list.split("\n").filter((l) => l.includes("tool.policy")).length + " line(s)");
    try {
      const d = old.buildDecisionDigest(s, new Date().toISOString(), process.env);
      if (!d) cannotRun("the previous build's digest renders over standing rows", "no digest was due on the copy"); else check("the previous build's digest renders over standing rows", d.text.length > 0, `${d.text.length} chars`);
    } catch (e) { check("the previous build's digest renders over standing rows", false, msg(e)); }
    try {
      const kinds = violationKinds(old, s); const added = kinds.filter((k) => !baseline.includes(k));
      check("the previous build's invariant detection raises no violation kind the seeded rows caused", added.length === 0, `now [${kinds.join(", ") || "none"}] · baseline [${baseline.join(", ") || "none"}] · added [${added.join(", ") || "none"}]`);
    } catch (e) { check("the previous build's invariant detection raises no violation kind the seeded rows caused", false, msg(e)); }
    try {
      const key = `rollback4a:schedule:${Date.now()}`;
      new old.Gateway(s, undefined, undefined, undefined, undefined, { dataDir: root }).intake(old.buildTypedTaskEvent({ source: "telegram", type: "schedule_admin", program: "list", requested_by: OPERATOR,
        notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: key, source_reference: `telegram:update:${key}:message:1` }));
      const db = new DatabaseSync(path, { readOnly: true });
      let text = ""; try { text = String(JSON.parse(db.prepare(`SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?`).get(`${key}:schedule`)?.payload_json ?? "{}").text ?? ""); } finally { db.close(); }
      check("the previous build's /schedule lists the granted schedule (and knows no standing section)", text.includes("rollback 4A: Alishan check-in") && !text.includes("常驻批准"), `${text.split("\n").length} line(s)`);
    } catch (e) { check("the previous build's /schedule lists the granted schedule (and knows no standing section)", false, msg(e)); }
  } finally { s.close(); }
}

/** A scheduled ActiveTurn for the previous build's bridge; the shell is a stub (the question is the gate, not the command). */
function oldTurn(old, s, run, schedule_id, root, ran) {
  const claim = s.claimRun(run, "rollback-4a-old", 120); if (!claim) throw new Error("claim failed");
  const registry = new old.ToolRegistry();
  for (const [name, meta] of Object.entries(old.OMP_SHELL_META)) registry.register({ name, category: "tool", ...meta, timeout_ms: 30_000, execute: async () => { ran.n++; return { ok: true, output: { exit_code: 0, output: "200", truncated: false } }; } });
  const cwd = join(root, "ws"); mkdirSync(cwd, { recursive: true });
  return { run_id: run, worker_id: "rollback-4a-old", chat_id: CHAT, requester: { kind: "schedule", id: schedule_id }, approver: OPERATOR, contract: claim.contract,
    budget: new old.BudgetLedger(claim.contract.budget), registry, signal: new AbortController().signal, cwd, step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: async (tool) => ({ digest: "d", contains_instructions: false, source_meta: { tool, bytes: 1 } }), setAwaitingApproval: () => undefined, postureOk: () => null,
    judge: PASS_JUDGE, trust: new old.TurnTrust({ store: s, run_id: run, chat_id: CHAT, born: "schedule", env: {} }) };
}

/** Step 3: the granted bytes on the granted schedule — the previous build asks, its gateway resolves the approval, and the grant is never used. */
async function oldAsks(old, path, seed, root) {
  const before = snapshot(path, seed);
  const s = old.RunStore.open(path);
  try {
    const run = intake(old, s, root, scheduledTurn(seed.schedule_id, `ask:${Date.now()}`));
    const ran = { n: 0 }; const turn = oldTurn(old, s, run, seed.schedule_id, root, ran);
    const decls = old.loadToolDeclarations(old.TOOL_DECLS_DIR); if (!decls.ok) throw new Error(decls.error);
    const handle = old.createBridgeHandler({ store: s, cfg: { ...old.resolveOmpConfig(process.env), sandbox: true }, ctx: { home: join(root, "home"), repo: join(root, "repo"), data: root },
      decls: decls.decls, env: process.env, turnEnvelopeActions: [...old.TURN_ACTIONS], activeTurn: () => turn });
    const pending = handle({ id: "rb4a-1", kind: "call", tool: "bash", input: { command: CMD }, toolCallId: "rb4a-call" });
    let asked; for (let i = 0; i < 200 && !asked; i++) { asked = s.getLedgerEvents(run).find((e) => e.event_type === "approval_requested"); if (!asked) await sleep(50); }
    check("the previous build asks again for the granted bytes on the granted schedule", asked !== undefined && asked.payload.action_fingerprint === seed.action_fingerprint, asked ? "approval_requested" : "no card in 10 s");
    if (!asked) return;
    const key = `rollback4a:approve:${asked.payload.approval_id}`;
    const r = new old.Gateway(s, undefined, undefined, undefined, undefined, { dataDir: root }).intake(old.buildTypedTaskEvent({ source: "telegram", type: "approve", approval_id: asked.payload.approval_id,
      requested_by: OPERATOR, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: key, source_reference: `telegram:update:${key}:callback:1` }));
    check("an approval resolve on the previous build (its gateway, its waiter)", r.ok === true && r.status === "approval_resolved", JSON.stringify(r));
    const out = await Promise.race([pending, sleep(15_000).then(() => ({ timeout: true }))]);
    check("the approved call ran once on the previous build", out.timeout !== true && out.isError === false && ran.n === 1, `ran ${ran.n} · ${JSON.stringify(out).slice(0, 120)}`);
    const reasons = s.listDecisionsForRun(run).filter((d) => d.entry_id === "tool.policy").map((d) => d.reason_code);
    const after = snapshot(path, seed);
    check("the previous build never used the grant (no standing use, row and move untouched, no standing reason)",
      after.uses === before.uses && after.row === before.row && after.move === "active" && !reasons.includes("standing") && !s.getLedgerEvents(run).some((e) => e.event_type === "standing_used"),
      `uses ${before.uses} → ${after.uses} · reasons [${reasons.join(",")}]`);
  } finally { s.close(); }
}

/** Step 4: the previous build's schedule tick fires the seeded due schedule (stub worker: nothing runs). */
async function oldTick(old, path, seed, root) {
  const s = old.RunStore.open(path);
  try {
    const submitted = [];
    const worker = { executeRun: async () => ({}), submitTurn: (run_id) => { submitted.push(run_id); return true; } };
    const r = await old.maybeFireScheduledTasks({ store: s, gateway: new old.Gateway(s, undefined, undefined, undefined, undefined, { dataDir: root }), worker, now: new Date().toISOString(),
      env: { ...process.env, HOUGE_SCHEDULER_ENABLED: "1" } });
    const mine = submitted.filter((id) => s.getRunForWorker(id)?.requested_by?.id === seed.schedule_id);
    check("the previous build's schedule tick fires the granted schedule", mine.length === 1, `fired ${r.fired} · this schedule ${mine.length} · failures ${r.failures}`);
  } finally { s.close(); }
}

const jsonls = (dir) => readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
function newestOf(dir) { return jsonls(dir).map((f) => ({ f, size: statSync(join(dir, f)).size, mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]; }
async function waitEnd(store, run, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const st = store.getRunState(run); if (st === "completed" || st === "failed") return st; await sleep(500); }
  return "timeout";
}

/** Step 5, as the 2b check does: the previous build's supervisor resumes a kept transcript in place on the copy that holds the standing rows. */
async function oldResume(old, path, args) {
  if (!args.sessionDir) return cannotRun("the previous build resumes a transcript on a copy holding standing rows", `no --session-dir (pass a kept gate run's …/data/omp/sessions/chat-${CHAT} directory)`);
  try { execFileSync("omp", ["--version"], { stdio: "pipe" }); } catch { return cannotRun("the previous build resumes a transcript on a copy holding standing rows", "omp is unavailable"); }
  const dir = args.sessionDir; const data = resolve(dir, "..", "..", "..");
  if (!/^\/(private\/)?tmp\/hg-[^/]+\//.test(realpathSync(dir)) || dir !== join(data, "omp", "sessions", `chat-${CHAT}`)) {
    throw new Error(`--session-dir must be a kept gate run's <root>/<case>/data/omp/sessions/chat-${CHAT} (it is used in place): ${dir}`);
  }
  const before = jsonls(dir); const newest = newestOf(dir);
  if (!newest) return cannotRun("the previous build resumes a transcript on a copy holding standing rows", "the session dir holds no transcript");
  console.log(`  transcript ${newest.f}: ${newest.size} bytes (${readFileSync(join(dir, newest.f), "utf8").split("\n").length} lines)`);
  const s = old.RunStore.open(path);
  const worker = new old.CoreWorker(s, dirname(args.oldDist), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { dataDir: data, distDir: args.oldDist });
  try {
    const run = intake(old, s, data, userTurn("ok", `resume:${Date.now()}`));
    worker.submitTurn(run);
    const state = await waitEnd(s, run, 300_000);
    const db = new DatabaseSync(path, { readOnly: true });
    let n = 0; try { n = db.prepare(`SELECT COUNT(*) AS n FROM chat_turns WHERE run_id = ? AND role = 'assistant'`).get(run).n; } finally { db.close(); }
    check("the previous build answers a turn on the resumed transcript (run completed, one assistant chat turn)", state === "completed" && n === 1, `${state}, ${n} assistant turn(s)`);
    const after = newestOf(dir);
    check("no new session file: the previous build resumed the transcript", JSON.stringify(jsonls(dir)) === JSON.stringify(before), `${before.length} → ${jsonls(dir).length} file(s)`);
    check("the resumed transcript grew by the appended turn", after?.f === newest.f && after.size > newest.size, `${newest.f} ${newest.size} → ${after?.f} ${after?.size} bytes`);
  } finally { await worker.shutdownPlanners?.(); s.close(); }
}

/** Step 6, the new build again: the seeded grant is still standing, its sweep runs clean, the rollback left the rows readable. */
function newReopens(neu, path, seed) {
  const s = neu.RunStore.open(path);
  try {
    const sweep = neu.runStandingSweep(s, new Date().toISOString());
    check("the new build reopens the copy: the grant stands and its sweep runs", s.getStandingApproval(seed.standing_id)?.state === "standing", JSON.stringify(sweep));
  } finally { s.close(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const neu = await load(NEW_DIST, ["run/run-store.js", "config/load-env.js", "gateway/gateway.js", "domain/types.js", "capabilities/capability-runner.js", "core/omp-turn-wiring.js", "decisions/standing-approval.js"]);
  neu.loadHougeEnv();
  const live = resolve(args.db ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  temp.root = mkdtempSync("/tmp/hg-4a-rb-"); temp.keep = args.keep;
  isolate(temp.root); mkdirSync(join(temp.root, "daemon-tmp"), { recursive: true });
  const path = join(temp.root, "copy.sqlite"); const basePath = join(temp.root, "baseline.sqlite");
  copyDb(live, path); copyDb(live, basePath);
  const seed = seedNew(neu, path, temp.root);
  const s1 = snapshot(path, seed);
  check("the new build seeded the rows (a standing row with an active move, six standing_* event types, one standing use, a standing decision reason)",
    JSON.parse(s1.row).state === "standing" && s1.move === "active" && s1.uses >= 1 && s1.reason === "standing" && s1.events.split(",").length === 6, `${s1.events} · uses ${s1.uses}`);
  const old = await load(args.oldDist, ["run/run-store.js", "core/core-worker.js", "gateway/gateway.js", "domain/types.js", "decisions/status-view.js", "decisions/digest.js", "run/invariant-sweep.js",
    "run/schedule-tick.js", "omp/bridge-handler.js", "omp/omp-config.js", "omp/tool-decls.js", "core/omp-turn-wiring.js", "contracts/task-contract.js", "decisions/trust.js", "budget/budget-ledger.js", "tools/tool-registry.js"]);
  let baseline = [];
  try { baseline = baselineKinds(old, basePath); } catch (e) { check("the previous build's invariant detection runs on the unseeded baseline copy", false, msg(e)); }
  try { oldReads(old, path, seed, baseline, temp.root); } catch (e) { check("the previous build boots on the copy", false, msg(e)); }
  try { await oldAsks(old, path, seed, temp.root); } catch (e) { check("the previous build asks again and never uses the grant", false, msg(e)); }
  try { await oldTick(old, path, seed, temp.root); } catch (e) { check("the previous build's schedule tick fires the granted schedule", false, msg(e)); }
  try { await oldResume(old, path, args); } catch (e) { check("the previous build resumes a transcript on a copy holding standing rows", false, msg(e)); }
  const s2 = snapshot(path, seed);
  check("the previous build left the seeded standing rows, uses and events in place", s2.row === s1.row && s2.uses === s1.uses && s2.events === s1.events && s2.move === s1.move, `${s1.events} → ${s2.events}`);
  try { newReopens(neu, path, seed); } catch (e) { check("the new build reopens the copy: the grant stands and its sweep runs", false, msg(e)); }
  const status = failures.length > 0 ? "FAIL" : inconclusive.length > 0 ? "INCONCLUSIVE" : "PASS";
  console.log(status === "FAIL" ? `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}` : `\nROLLBACK CHECK: ${status}${inconclusive.length ? `\n  - ${inconclusive.join("\n  - ")}` : ""}`);
  return status === "PASS" ? 0 : status === "FAIL" ? 1 : 3;
}

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { cleanup(); process.exit(code); });
main().then((c) => { cleanup(); process.exit(c); }, (e) => { console.error(`rollback check setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); cleanup(); process.exit(2); });
```
Notes for the implementer: `standingUse` (Task 4) is its own `inTransaction`, so it runs after the seed transaction, never inside it; the six-event-type count in the seed check reads `standing_used` from that use. The previous build's bridge sets the approval's requester to `turn.approver` (`bridge-handler.ts:379`), which is why the approve event's `requested_by` is `OPERATOR`. The old build's chat binding does not exist (Task 3 is new), so the approve from `CHAT` is accepted on identity alone, as today.

- [ ] **Step 3: Syntax and a dry run.** `set -o pipefail; node --check scripts/check-standing-rollback.mjs` → no output. Then (orchestrator, after Task 11's build): in the worktree `npm run build`; make the previous build with `git worktree add .worktrees/stage4a-base $(git merge-base main HEAD) && (cd .worktrees/stage4a-base && npm ci && npm run build)`; run `set -o pipefail; HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-standing-rollback.mjs --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/stage4a-base/dist 2>&1 | tee /tmp/hg-4a-rollback.log` → expect `ROLLBACK CHECK: INCONCLUSIVE` with the one line "no --session-dir" (exit 3), every other line PASS. Then once more with `--session-dir <a kept live-gate-ladder-2b-hooks run>/case-<n>-1/data/omp/sessions/chat--4200` (run `node scripts/live-gate-ladder-2b-hooks.mjs --keep --only 1` from the base worktree if none is kept) → `ROLLBACK CHECK: PASS`, exit 0. Both outputs go in the slice report.

- [ ] **Step 4: Commit**
```bash
git add scripts/check-standing-rollback.mjs scripts/old-dist-provenance.mjs
git commit -m "test(rollback): the previous build asks again on a DB holding standing grants, uses and events"
```

---

### Task 11: `scripts/live-gate-standing-approval.mjs` — every §10 line on a VACUUM copy, the real bridge, wrapper and clean room

**Files:**
- Create: `scripts/live-gate-standing-approval.mjs`

**Shape (why this and not a planner turn):** spec §10 asks for "the real bridge, wrapper and clean room" and the taps through `resolveToolApprovalForTest` + the waiter (`live-gate-ladder-2b-hooks.mjs:207–228`). The gate drives `createBridgeHandler` from `dist/` with an `ActiveTurn` built the way `planner-supervisor.ts:502–513` builds one (scheduled requester, operator approver, a real `TurnTrust`), on a registry whose three shell entries are the real `shellToolExecute` (`shell-adapter.ts:87`) with the real `OMP_SHELL_META` (`omp-turn-wiring.ts:35`) — the same execute the worker registers (`core-worker.ts:2480–2489`), plus the test seams `cleanroomDeps` (`shell-adapter.ts:83`: `rm`, `lsof`, `afterSidecar`, `afterSpawn`) that the worker cannot inject. No planner model is called: the command bytes are the input under test, and a planner that rewrote them would make every line INCONCLUSIVE. Delivery: claim → adapter → `markDelivered` through the daemon's own `createOutboxDispatcher(store, adapters)` (Task 7) with a stub adapter that records and never sends. **Stated residual:** the gate drives each run's terminal path by hand (`finishRun` + `enqueueFinalReportNotification` / `enqueueFailureNotification`, the store methods the planner calls); the planner's own enqueue of `<run_id>:final_report` after `completed` and after a failure is pinned by `tests/core/core-worker-omp-turn.test.ts` (lines 62, 82, 92, 104 read that key), not by this gate. The slice report repeats this sentence. Revoke: a real callback update through `normalizeTelegramUpdate` → `Gateway.intake` (parser, adapter, gateway, handler).

**Isolation:** the base is one VACUUM copy of the live DB; every case gets its own VACUUM copy of the base and its own data dir under `/tmp/hg-4a-*` (outside the daemon temp root, which the shell profile denies). `HOUGE_DAEMON_TMP_DIR` is a gate root `<real cache>/gate-sa-*` set before any runtime import, so every room and home lands there, never under the real `<cache>/cleanroom/`; the last line proves the real `cleanroom/` names are unchanged and both roots are gone. The gate removes **only its own** roots: its gate root carries `owner.json` (`{ pid, keep }`); at start, another `gate-sa-*` root is removed only when its owner file names a dead pid and `keep` is false — a live gate's room and a `--keep` artifact are never touched, a root without an owner file is reported and left. Telegram tokens are deleted from `process.env` and no Telegram client is constructed; the gate chat is `-4300`, a chat id that is not Paco's. A third-party write: the sealed runs POST `a=1` to `https://httpbin.org/post` (Slice 1's gate does the same) — stated so it is not read as Tier B. INCONCLUSIVE when the unsandboxed control POST to httpbin is not `200` (exit 2, `ok:false`; rerun once). An unknown `--only` name, or a bare `--only` with no value, is a setup error before anything runs (exit 2, `ok:false`); a run with `--only` that passes is **PARTIAL** (exit 3, `ok:false`) — only a run of every case is a shipping PASS. Exit 0 PASS (every case ran and passed) · 1 FAIL · 2 INCONCLUSIVE · 3 PARTIAL; the last stdout line is the JSON summary, as `live-gate-cleanroom-runtime.mjs:298`.

**Lines (spec §10, in order):** 1 three approvals on three runs → candidate · 2 the fourth asks with the trial line and, approved, runs sealed (facts on `tool_finished`, room under `cleanroom/`, nothing left) · 3 completed + delivered → standing, auto move, grant card with Revoke · **4 the fifth run: zero `approval_requested`, reason `standing`, `cleanroom.sb` selected (the PASS line that fails on silent degradation)** · 5 a sixth call in the same run asks · 6 one byte changed asks · 7 Revoke → the next run asks (a foreign-chat tap changes nothing) · 8 deny from a user turn → ended + `denied_until`, no new streak · 9 sandbox off → asks · 10 non-zero exit → no seal · 11 teardown failure (`rm` seam) → no seal · 12 `check_error` (`lsof` seam) → no seal · 13 failed run with a delivered failure notice → no seal (every no-seal line also asserts the run's `final_report` was delivered, so "no seal" is never "no delivery") · 14 planted `.curlrc` mid-run (`afterSpawn`) → tampered → no seal · 15 nothing left.

- [ ] **Step 1: Create `scripts/live-gate-standing-approval.mjs`:**
```js
#!/usr/bin/env node
// Live gate — decision ladder Stage 4A, standing approval (spec 2026-10-28 §10; plan Task 11).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-standing-approval.mjs [--db <path>] [--keep] [--only main,deny,…]
// The real bridge (createBridgeHandler), the real shell adapter, wrapper, sandbox-exec and clean room, on VACUUM copies of the
// live DB (one per case) under /tmp/hg-4a-*; rooms under a gate root <real cache>/gate-sa-* (HOUGE_DAEMON_TMP_DIR, set before
// any runtime import). Taps through resolveToolApprovalForTest + the waiter; delivery through a real dispatcher with the
// daemon's onDelivered and a stub adapter; Revoke through normalizeTelegramUpdate → Gateway.intake. Telegram tokens deleted; the
// gate chat (-4300) is not Paco's; no planner model is called. Third-party write: POST a=1 to httpbin.org (as Slice 1's gate).
// PASS = every line PASS, including line 4 (the fifth run asks nothing, reason standing, cleanroom.sb selected), which fails on
// silent degradation to an ordinary approval. Unsandboxed control POST not 200 → INCONCLUSIVE (exit 2, rerun once).
// Exit 0 PASS (every case) · 1 FAIL · 2 INCONCLUSIVE · 3 PARTIAL (--only: what ran passed; never a shipping PASS). Never opens the
// live DB for writing. Removes only its own roots; another gate's root is touched only when its owner pid is dead and not --keep.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const keep = argv.includes("--keep");
// a bare --only (no value, or another flag next) is an empty filter — a setup error below (exit 2), never "no filter" and a full PASS
const onlyArg = argv.includes("--only") ? (arg("--only") ?? "") : null;
const only = onlyArg === null ? null : new Set(onlyArg.startsWith("--") ? [] : onlyArg.split(",").map((x) => x.trim()).filter(Boolean));
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
let fails = 0; let inconclusive = false; const notes = []; const ran = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); if (!ok) { fails++; process.exitCode = 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHAT = "-4300"; const OTHER_CHAT = "-4301";
const OPERATOR = { kind: "user", id: "gate" };
const CMD = "curl -s -m 10 -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post"; // the Alishan shape
const CMD_BYTE = CMD.replace("a=1", "a=2");
const CMD_500 = "curl -s -f -m 10 -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/status/500"; // curl -f: exit 22
const ALLOWLIST = { users: [{ telegram_user_id: 111, identity_id: "gate" }],
  chats: [{ telegram_chat_id: Number(CHAT), label: "gate", allowed_identity_ids: ["gate"] }, { telegram_chat_id: Number(OTHER_CHAT), label: "other", allowed_identity_ids: ["gate"] }] };
const PASS_JUDGE = async (i) => ({ text: i.text, verdict: "pass", withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 0, unanswered: 0, skipped: false, blocked: null, decisionId: null, masked: 0 });

// .env first (it may name HOUGE_DAEMON_TMP_DIR), then the real root and its cleanroom/ names, then the override, then the runtime
const { loadHougeEnv } = await import(join(DIST, "config/load-env.js"));
loadHougeEnv();
const live = resolve(arg("--db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
const envRoot = process.env.HOUGE_DAEMON_TMP_DIR?.trim();
const realRoot = envRoot && isAbsolute(envRoot) ? envRoot : join(homedir(), "Library", "Caches", "houge-daemon");
const realCr = join(realRoot, "cleanroom");
const names = (d) => (existsSync(d) ? readdirSync(d).sort().join(",") : "<absent>");
const realCrBefore = names(realCr);
mkdirSync(realRoot, { recursive: true, mode: 0o700 });
/** Another gate's root is never touched while its owner lives or when it was kept; a dead, unkept owner's root is removed. */
function sweepDeadGateRoots(root) {
  for (const d of readdirSync(root).filter((n) => n.startsWith("gate-sa-"))) {
    const dir = join(root, d); let owner = null;
    try { owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")); } catch { console.log(`gate root without an owner file left in place: ${dir}`); continue; }
    if (owner.keep === true || !Number.isInteger(owner.pid)) continue;
    let alive = true; try { process.kill(owner.pid, 0); } catch (e) { alive = e?.code === "EPERM"; }
    if (!alive) { rmSync(dir, { recursive: true, force: true }); console.log(`removed a dead gate's root: ${dir} (pid ${owner.pid})`); }
  }
}
sweepDeadGateRoots(realRoot);
const gateRoot = mkdtempSync(join(realRoot, "gate-sa-"));
writeFileSync(join(gateRoot, "owner.json"), JSON.stringify({ pid: process.pid, keep }));
const dataRoot = mkdtempSync("/tmp/hg-4a-");
for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: gateRoot, HOUGE_TELEGRAM_CHAT_ID: CHAT, HOUGE_TOMBSTONE_PATH: join(dataRoot, "houge.kill"),
  HOUGE_PARK_MARKER_PATH: join(dataRoot, "houge.parked"), HOUGE_DISARM_PATH: join(dataRoot, "houge.disarm"), HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_TRIAGE_ENABLED: "off" });
const cleanup = () => { if (keep) { console.log(`kept (holds live-DB copies): ${dataRoot} ${gateRoot}`); return; } rmSync(dataRoot, { recursive: true, force: true }); rmSync(gateRoot, { recursive: true, force: true }); };
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

const m = Object.assign({}, ...(await Promise.all(["run/run-store.js", "gateway/gateway.js", "domain/types.js", "omp/bridge-handler.js", "omp/tool-approval-sink.js", "omp/tool-decls.js",
  "omp/omp-config.js", "omp/shell-adapter.js", "omp/seatbelt.js", "omp/workspace.js", "omp/cleanroom.js", "core/omp-turn-wiring.js", "contracts/task-contract.js", "decisions/trust.js",
  "budget/budget-ledger.js", "tools/tool-registry.js", "capabilities/capability-runner.js", "notifications/notification-dispatcher.js", "notifications/notification-outbox.js",
  "telegram/telegram-daemon.js", "triggers/telegram-trigger-adapter.js"].map((p) => import(join(DIST, p))))));
for (const k of ["STANDING_TRIAL_LINE", "actionFingerprint", "createOutboxDispatcher", "shellToolExecute", "OMP_SHELL_META"]) if (m[k] === undefined) throw new Error(`${k} missing from dist: rebuild`);
const CFG = m.resolveOmpConfig(process.env);
const DECLS = (() => { const r = m.loadToolDeclarations(m.TOOL_DECLS_DIR); if (!r.ok) throw new Error(r.error); return r.decls; })();
const fpOf = (command) => m.actionFingerprint("shell_external", m.OMP_SHELL_META.shell_external, { command });
const roomsLeft = () => (existsSync(m.cleanroomRoot()) ? readdirSync(m.cleanroomRoot()).filter((n) => /^(room|home)-/.test(n)) : []);
const statOf = (p) => (existsSync(p) ? `${statSync(p).size}:${statSync(p).mtimeMs}` : "absent");

/** The daemon is writing the live DB: a VACUUM INTO that meets its lock is retried (5 × 1 s); only ever into the gate's data root. */
function copyDb(from, to) {
  if (!resolve(to).startsWith(`${dataRoot}/`)) throw new Error(`refusing to write outside the gate's data root: ${to}`);
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000); }
    finally { src.close(); }
  }
}

// ---- one case environment: a copy, a data dir, a schedule, the real shell with seams, the bridge, an approver, a dispatcher ----
function openEnv(name, o = {}) {
  const dir = join(dataRoot, name); mkdirSync(dir, { recursive: true });
  const path = join(dir, "houge.sqlite"); copyDb(join(dataRoot, "base.sqlite"), path);
  const data = join(dir, "data"); const ws = m.chatWorkspace(data, CHAT); mkdirSync(ws, { recursive: true, mode: 0o700 });
  const ctx = { home: homedir(), repo: REPO, data }; m.writeSeatbeltProfiles(ctx); // the unsealed runs' profile, as the worker writes it
  const store = m.RunStore.open(path);
  const schedule_id = store.addScheduledTask({ chat_id: CHAT, goal: "Alishan check-in (gate)", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2099-01-01T00:00:00.000Z" }).schedule_id;
  const e = { name, path, store, data, ws, schedule_id, runs: [], approvals: [], cards: [], sidecars: [], turn: null, fp: fpOf(o.command ?? CMD), decide: o.decide ?? (() => "approved") };
  const cleanroomDeps = { afterSidecar: (dirs) => { e.sidecars.push(existsSync(join(dirs.home, "cleanroom.sb"))); }, ...(o.cleanroomDeps ?? {}) }; // observes only
  const cfg = { ...CFG, sandbox: o.sandbox ?? CFG.sandbox };
  const shell = m.shellToolExecute({ cfg, ctx, distDir: DIST, cwd: ws, onIncident: (kind, detail) => { store.openIncident({ kind, subject: `chat:${CHAT}`, detail }); }, cleanroomDeps });
  e.registry = new m.ToolRegistry();
  for (const [n, meta] of Object.entries(m.OMP_SHELL_META)) e.registry.register({ name: n, category: "tool", ...meta, timeout_ms: cfg.shellTimeoutMs + 30_000, execute: shell });
  e.handle = m.createBridgeHandler({ store, cfg, ctx, decls: DECLS, env: process.env, turnEnvelopeActions: [...m.TURN_ACTIONS], activeTurn: () => e.turn });
  const stub = { send: async (n) => { e.cards.push(n); return { provider_message_id: `gate:${n.notification_id}` }; } }; // records, never sends
  e.dispatcher = m.createOutboxDispatcher(store, { local: stub, telegram: stub }); // the daemon's own sender, onDelivered included
  e.stopApprover = approver(e);
  return e;
}
async function closeEnv(e) { await e.stopApprover(); e.store.close(); }

/** Approval cards: each new one is answered by the env's rule; the "Why:" line and the fingerprint are kept (2b gate seam). */
function approver(e) {
  const seen = new Set(); let stop = false;
  const card = (id) => { // read-only, as the 2b gate reads it: the card row lands with the request
    const db = new DatabaseSync(e.path, { readOnly: true });
    try { const row = db.prepare(`SELECT payload_json FROM notification_outbox WHERE approval_id = ?`).get(id); return row ? String(JSON.parse(row.payload_json).text ?? "") : null; } finally { db.close(); }
  };
  const loop = (async () => {
    while (!stop) {
      for (const run of [...e.runs]) for (const ev of e.store.getLedgerEvents(run).filter((x) => x.event_type === "approval_requested")) {
        const id = ev.payload.approval_id; if (seen.has(id)) continue;
        const text = card(id); if (text === null) continue;
        seen.add(id);
        const why = /^Why: (.*)$/m.exec(text)?.[1] ?? null; const fp = ev.payload.action_fingerprint; const decision = e.decide({ fp, why, run });
        e.approvals.push({ run, id, why, fp, decision });
        e.store.resolveToolApprovalForTest(id, decision); m.toolApprovalWaiters.resolve(id, decision);
      }
      await sleep(50);
    }
  })();
  return async () => { stop = true; await loop; };
}

/** A run through the real gateway, claimed, with the ActiveTurn the supervisor would build (scheduled: the operator approves). */
let seq = 0;
function startRun(e, kind = "schedule") {
  const n = `${Date.now()}-${++seq}`;
  const event = kind === "schedule"
    ? { source: "schedule", type: "turn", program: "turn", goal: "Alishan check-in (gate)", requested_by: { kind: "schedule", id: e.schedule_id }, notify: { kind: "telegram", chat_id: CHAT },
        idempotency_key: `schedule:${e.schedule_id}:gate4a:${n}`, source_reference: `scheduled_tasks.${e.schedule_id}` }
    : { source: "telegram", type: "turn", program: "turn", goal: "post it", requested_by: OPERATOR, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `gate4a:telegram:${n}`, source_reference: `gate4a:${n}` };
  const r = new m.Gateway(e.store, undefined, undefined, undefined, undefined, { dataDir: e.data }).intake(m.buildTypedTaskEvent(event));
  if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
  const worker_id = `planner:${CHAT}:gate`; const claim = e.store.claimRun(r.run_id, worker_id, 600); if (!claim) throw new Error("claim failed");
  e.turn = { run_id: r.run_id, worker_id, chat_id: CHAT, requester: event.requested_by, ...(kind === "schedule" ? { approver: OPERATOR } : {}), contract: claim.contract,
    budget: new m.BudgetLedger(claim.contract.budget), registry: e.registry, signal: new AbortController().signal, cwd: e.ws, step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: async (tool) => ({ digest: "d", contains_instructions: false, source_meta: { tool, bytes: 1 } }), setAwaitingApproval: () => undefined, postureOk: () => null, judge: PASS_JUDGE,
    trust: new m.TurnTrust({ store: e.store, run_id: r.run_id, chat_id: CHAT, born: kind === "schedule" ? "schedule" : "telegram", env: {} }) };
  e.runs.push(r.run_id);
  return r.run_id;
}
const call = (e, command, tc) => e.handle({ id: `r-${tc}`, kind: "call", tool: "bash", input: { command }, toolCallId: tc });
const queuedRows = (e) => { const db = new DatabaseSync(e.path, { readOnly: true }); try { return db.prepare(`SELECT COUNT(*) AS n FROM notification_outbox WHERE state = 'queued'`).get().n; } finally { db.close(); } };
/** Dispatch until this run's own final_report is delivered, at most one pass per queued row (the copy may carry older rows); never a silent miss. */
async function deliver(e, run) {
  for (let i = 0, bound = queuedRows(e); i < bound && e.store.finalReportState(run) !== "delivered"; i++) if ((await e.dispatcher.dispatchOnce("gate")).status === "idle") break;
  if (e.store.finalReportState(run) !== "delivered") throw new Error(`${run}:final_report not delivered (${e.store.finalReportState(run) ?? "none"})`);
}
/** A row queued by a delivery's own settlement (the grant card): dispatch until it is delivered, at most one pass per queued row; the caller's check asserts the state. */
async function deliverNotification(e, notification_id) {
  for (let i = 0, bound = queuedRows(e); i < bound && e.store.getNotification(notification_id)?.state !== "delivered"; i++) if ((await e.dispatcher.dispatchOnce("gate")).status === "idle") break;
}
/** Terminal state and its one notice (success and failure share the key, §2), then delivery through the daemon's dispatcher options. */
async function finish(e, run, ok = true) {
  if (ok) { e.store.finishRun({ run_id: run, expected_worker_id: e.turn.worker_id, next: "completed", report_ref: `runs/gate4a-${run}.md`, duration_ms: 1, tool_calls: 1 }); e.store.enqueueFinalReportNotification(run, { text: "200", report_path: `runs/gate4a-${run}.md` }); }
  else { e.store.finishRun({ run_id: run, expected_worker_id: e.turn.worker_id, next: "failed", error_type: "planner_exit", error_ref: "gate" }); e.store.enqueueFailureNotification(run, "I hit an error on that one: gate"); }
  await deliver(e, run);
}
const evs = (e, run, type) => e.store.getLedgerEvents(run).filter((x) => x.event_type === type);
const fin = (e, run, tc) => evs(e, run, "tool_finished").find((x) => x.payload.tool_call_id === tc)?.payload;
const reasons = (e, run, tc) => e.store.listDecisionsForRun(run).filter((d) => d.entry_id === "tool.policy" && d.tool_call_id === tc).map((d) => d.reason_code);
const facts = (f) => (f?.cleanroom ? JSON.stringify(f.cleanroom) : "no facts");
const keyOf = (e, fp = e.fp) => ({ schedule_id: e.schedule_id, chat_id: CHAT, action_fingerprint: fp });
function seedRow(e, state, fp = e.fp) {
  const move_id = state === "standing" ? e.store.insertLadderMove({ entry_id: "tool.policy", scope: "gate", from_rung: "paco", to_rung: "rule", evidence: ["g1", "g2", "g3"], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true }) : null;
  return e.store.insertStandingApprovalForTest({ ...keyOf(e, fp), state, credited_runs_json: '["g-r1","g-r2","g-r3"]', approval_ids_json: '["g-a1","g-a2","g-a3"]',
    ...(move_id ? { move_id, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() } : {}) });
}
let cbn = 0;
function tapRevoke(e, chat, data) {
  const r = m.normalizeTelegramUpdate({ update_id: 900_000 + ++cbn, callback_query: { id: `gate-cb-${cbn}`, from: { id: 111 }, message: { message_id: cbn, chat: { id: Number(chat) } }, data } }, ALLOWLIST);
  if (!r.ok) return r;
  return new m.Gateway(e.store, undefined, undefined, undefined, undefined, { dataDir: e.data }).intake(r.event);
}

// ---- cases ----
async function caseMain(e) {
  for (let i = 1; i <= 3; i++) { const run = startRun(e); await call(e, CMD, `s${i}`); await finish(e, run); }
  const c = e.store.standingFor(keyOf(e));
  check("1 three approvals consumed on three distinct scheduled runs → candidate", c?.state === "candidate" && JSON.parse(c.credited_runs_json).length === 3 && e.approvals.length === 3 && e.approvals.every((a) => a.fp === e.fp && a.decision === "approved"),
    `${c?.state ?? "no row"} · approvals ${e.approvals.length} · streak events ${e.runs.flatMap((r) => evs(e, r, "standing_streak").map((x) => x.payload.streak)).join(",")}`);
  if (!c) return;
  const run4 = startRun(e); const s0 = e.sidecars.length; await call(e, CMD, "s4"); const f4 = fin(e, run4, "s4"); const a4 = e.approvals.at(-1); const r4 = e.store.getStandingApproval(c.standing_id);
  check("2 the fourth run asks with the trial line; approved, it runs sealed (exit 0, ran, torn down, a room- name) and leaves no room behind; the row is sealing on that call",
    a4?.run === run4 && a4.why === m.STANDING_TRIAL_LINE && a4.fp === e.fp && f4?.executor === "cleanroom" && f4.cleanroom.ran === true && f4.cleanroom.torn_down === true && f4.cleanroom.exit_code === 0
      && /^room-/.test(f4.cleanroom.room ?? "") && e.sidecars.length === s0 + 1 && r4?.state === "sealing" && r4.sealed_tool_call_id === "s4" && roomsLeft().length === 0,
    `why ${JSON.stringify(a4?.why)} · ${facts(f4)} · row ${r4?.state} · rooms left ${roomsLeft().length}`);
  await finish(e, run4);
  // the report's delivery settles the trial and only then queues the grant card: deliver that card too before line 3 asserts it
  const queuedCard = e.store.getStandingApproval(c.standing_id)?.grant_notification_id;
  if (queuedCard) await deliverNotification(e, queuedCard);
  const g = e.store.getStandingApproval(c.standing_id); const move = g?.move_id ? e.store.getLadderMove(g.move_id) : undefined; const card = g?.grant_notification_id ? e.store.getNotification(g.grant_notification_id) : undefined;
  const ev = move ? JSON.parse(move.evidence_json) : [];
  check("3 completed run + delivered report → standing at once (Decision 1-A): auto move on tool.policy via approval.standing, evidence approvals → decision → run → call, the grant card delivered with Revoke",
    g?.state === "standing" && move?.granted_by === "auto" && move.granted_via === "approval.standing" && move.state === "active" && ev.length === 7 && String(ev[4]).startsWith("dec_") && ev[5] === run4 && ev[6] === "s4"
      && card?.state === "delivered" && card.payload.buttons?.[0]?.data === `dec:sa:${c.standing_id}:revoke`, `${g?.state} · move ${move?.granted_by}/${move?.granted_via} · evidence ${ev.length} · card ${card?.state}`);
  if (g?.state !== "standing") return;
  const jar = statOf(join(e.ws, "cj.txt"));
  const run5 = startRun(e); const s5 = e.sidecars.length; const out5 = await call(e, CMD, "s5"); const f5 = fin(e, run5, "s5");
  check("4 the fifth run: zero approval_requested, tool.policy reason standing, cleanroom.sb selected (a sidecar in a fresh home, executor cleanroom, ran, exit 0), one standing use, the workspace jar untouched",
    evs(e, run5, "approval_requested").length === 0 && reasons(e, run5, "s5").includes("standing") && e.sidecars.length === s5 + 1 && e.sidecars.at(-1) === true && f5?.executor === "cleanroom"
      && f5.cleanroom.ran === true && f5.cleanroom.exit_code === 0 && out5.isError === false && evs(e, run5, "standing_used").length === 1 && statOf(join(e.ws, "cj.txt")) === jar,
    `asks ${evs(e, run5, "approval_requested").length} · reasons [${reasons(e, run5, "s5").join(",")}] · ${facts(f5)} · jar ${jar === statOf(join(e.ws, "cj.txt")) ? "untouched" : "CHANGED"}`);
  await call(e, CMD, "s5b"); const f5b = fin(e, run5, "s5b");
  check("5 a second call of the same bytes in the same run asks (one use per run, reason standing_mismatch); approved, it still runs sealed",
    evs(e, run5, "approval_requested").length === 1 && reasons(e, run5, "s5b").includes("standing_mismatch") && f5b?.executor === "cleanroom" && evs(e, run5, "standing_used").length === 1,
    `asks ${evs(e, run5, "approval_requested").length} · reasons [${reasons(e, run5, "s5b").join(",")}] · executor ${f5b?.executor}`);
  await finish(e, run5);
  e.decide = ({ fp }) => (fp === e.fp ? "approved" : "denied");
  const run6 = startRun(e); await call(e, CMD_BYTE, "s6"); const asked6 = evs(e, run6, "approval_requested");
  check("6 one byte changed asks (another fingerprint; denied, the grant on the original bytes stands)", asked6.length === 1 && asked6[0].payload.action_fingerprint === fpOf(CMD_BYTE) && fpOf(CMD_BYTE) !== e.fp
    && evs(e, run6, "standing_used").length === 0 && e.store.getStandingApproval(c.standing_id)?.state === "standing", `asks ${asked6.length} · row ${e.store.getStandingApproval(c.standing_id)?.state}`);
  await finish(e, run6);
  const data = card.payload.buttons[0].data;
  const foreign = tapRevoke(e, OTHER_CHAT, data); const stillStanding = e.store.getStandingApproval(c.standing_id)?.state === "standing";
  const mine = tapRevoke(e, CHAT, data); const ended = e.store.getStandingApproval(c.standing_id);
  const run7 = startRun(e); await call(e, CMD, "s7");
  check("7 Revoke from the row's chat ends the row and its move in one tap (a tap from another chat changes nothing); the next run asks again",
    foreign.ok === true && stillStanding && mine.ok === true && ended?.state === "ended" && ended.ended_reason === "revoked" && e.store.getLadderMove(g.move_id)?.state === "ended"
      && evs(e, run7, "approval_requested").length === 1 && evs(e, run7, "standing_used").length === 0, `foreign kept ${stillStanding} · ${ended?.state}/${ended?.ended_reason} · next run asks ${evs(e, run7, "approval_requested").length}`);
  await finish(e, run7);
}

async function caseDeny(e) {
  const row = seedRow(e, "standing");
  e.decide = ({ run }) => (e.store.getRunForWorker(run)?.source === "telegram" ? "denied" : "approved");
  const u = startRun(e, "user"); await call(e, CMD, "u1"); await finish(e, u);
  const after = e.store.getStandingApproval(row.standing_id);
  const blockDays = after?.denied_until ? (Date.parse(after.denied_until) - Date.parse(after.ended_at)) / 86_400_000 : 0;
  const r = startRun(e); await call(e, CMD, "u2"); await finish(e, r);
  check("8 a deny from a user turn on the same bytes ends the schedule's grant and its move with a 30-day block; the next scheduled approval starts no streak",
    after?.state === "ended" && after.ended_reason === "denied" && Math.round(blockDays) === 30 && e.store.getLadderMove(row.move_id)?.state === "ended" && e.store.standingFor(keyOf(e)) === undefined
      && e.store.standingDenied(CHAT, e.fp, new Date().toISOString()), `${after?.state}/${after?.ended_reason} · block ${blockDays.toFixed(2)} d · live row ${e.store.standingFor(keyOf(e))?.state ?? "none"}`);
}

async function caseSandboxOff(e) {
  seedRow(e, "standing"); e.decide = () => "denied"; // never run the command without the sandbox
  const r = startRun(e); await call(e, CMD, "o1"); await finish(e, r);
  check("9 sandbox off → asks (no clean room, so no standing selector and no use)", evs(e, r, "approval_requested").length === 1 && evs(e, r, "standing_used").length === 0 && !reasons(e, r, "o1").includes("standing"),
    `asks ${evs(e, r, "approval_requested").length} · reasons [${reasons(e, r, "o1").join(",")}]`);
}

/** A seeded candidate; the fourth call is approved and runs sealed with the case's seam; the trial must end, never grant. */
async function noSeal(e, tag, title, o) {
  const c = seedRow(e, "candidate", fpOf(o.command ?? CMD));
  const run = startRun(e); await call(e, o.command ?? CMD, "t4"); const f = fin(e, run, "t4"); const mid = e.store.getStandingApproval(c.standing_id)?.state;
  await finish(e, run, o.ok !== false);
  const after = e.store.getStandingApproval(c.standing_id);
  // the run's notice (success or failure) was delivered, so the row ended on the seal facts, never for want of a delivery
  check(`${tag} ${title} → no seal`, mid === "sealing" && f?.executor === "cleanroom" && o.why(f) && e.store.finalReportState(run) === "delivered" && after?.state === "ended"
    && after.ended_reason === "sealed_trial_failed" && after.move_id === null && !e.cards.some((n) => n.idempotency_key.startsWith("urgent:standing_grant:")),
    `row ${mid} → ${after?.state}/${after?.ended_reason} · ${facts(f)} · notice ${e.store.finalReportState(run)}`);
}

const CASES = [
  ["main", "lines 1–7", {}, caseMain],
  ["deny", "line 8", {}, caseDeny],
  ["sandbox", "line 9", { sandbox: false }, caseSandboxOff],
  ["exit", "line 10", { command: CMD_500 }, (e) => noSeal(e, "10", "a non-zero exit through the real bridge", { command: CMD_500, why: (f) => f.cleanroom.exit_code !== 0 && f.cleanroom.ran === true })],
  ["teardown", "line 11", { cleanroomDeps: { rm: (p) => { if (!/\/room-[^/]+$/.test(p)) rmSync(p, { recursive: true, force: true }); } } },
    (e) => noSeal(e, "11", "a teardown failure (rm seam leaves the room)", { why: (f) => f.cleanroom.torn_down === false })],
  ["check", "line 12", { cleanroomDeps: { lsof: () => { throw new Error("lsof seam: gate"); } } }, (e) => noSeal(e, "12", "a check_error (lsof seam throws)", { why: (f) => f.cleanroom.check_failed === true })],
  ["failed", "line 13", {}, (e) => noSeal(e, "13", "a failed run whose failure notice was delivered", { ok: false, why: (f) => f.cleanroom.exit_code === 0 && f.cleanroom.torn_down === true && !f.cleanroom.tampered })],
  ["tamper", "line 14", { cleanroomDeps: { afterSpawn: (dirs) => writeFileSync(join(dirs.home, ".curlrc"), "# gate plant\n") } }, (e) => noSeal(e, "14", "a .curlrc planted in the home mid-run", { why: (f) => f.cleanroom.tampered === true })]
];

async function main() {
  const control = spawnSync("/usr/bin/curl", ["-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-d", "a=1", "https://httpbin.org/post"], { encoding: "utf8" });
  if (control.status === null || control.error) return check("network: unsandboxed control curl runs", false, `curl unavailable: ${control.error?.message ?? control.signal}`);
  if (control.status !== 0 || control.stdout !== "200") {
    inconclusive = true; notes.push(`INCONCLUSIVE network: unsandboxed POST to httpbin.org exit ${control.status} http ${control.stdout} (offline?) — rerun once; ship only with the diagnosis in the report`);
    return console.log(notes.at(-1));
  }
  copyDb(live, join(dataRoot, "base.sqlite"));
  for (const [id, title, opts, fn] of CASES) {
    if (only && !only.has(id)) continue;
    const e = openEnv(`case-${id}`, opts);
    try { await fn(e); ran.push(id); } catch (err) { check(`${id} (${title}) ran to the end`, false, String(err?.stack ?? err)); }
    finally { await closeEnv(e); }
  }
}

/** Line 15, after cleanup: both roots gone, the real cleanroom/ exactly as before. */
function nothingLeft() {
  const after = names(realCr);
  check("15 nothing left", !existsSync(gateRoot) && !existsSync(dataRoot) && after === realCrBefore, `gate root exists ${existsSync(gateRoot)} · data root exists ${existsSync(dataRoot)} · real cleanroom/ before [${realCrBefore}] after [${after}]`);
}

// a setup error, before anything runs: an unknown --only name would otherwise skip every case
const known = new Set(CASES.map(([id]) => id));
const unknownOnly = only ? [...only].filter((id) => !known.has(id)) : [];
if (unknownOnly.length > 0 || (only && only.size === 0)) {
  console.log(`setup error: --only names no known case (${unknownOnly.join(",") || "empty"}); known: ${[...known].join(",")}`);
  cleanup(); console.log(JSON.stringify({ ok: false, setup_error: "unknown --only" })); process.exit(2);
}
try { await main(); } catch (e) { check("gate ran to the end", false, String(e?.stack ?? e)); }
finally { cleanup(); }
if (!keep) nothingLeft();
// a shipping PASS needs every case to have run: --only, or a case that threw before ran.push, is never ok
const partial = ran.length < CASES.length;
if (inconclusive && fails === 0) process.exitCode = 2;
else if (partial && fails === 0) { process.exitCode = 3; console.log(`PARTIAL ran [${ran.join(",")}] of [${CASES.map(([id]) => id).join(",")}] — not a shipping PASS`); }
console.log(JSON.stringify({ ok: fails === 0 && !inconclusive && !partial, fails, inconclusive, partial, cases: ran, notes }));
```
Implementer notes: `openEnv` keys the env's own fingerprint on `o.command` (`exit` case: the 500 command). The approver reads the card row read-only, as the 2b gate does (no store method is added for a gate). If a dist module named above exports nothing the gate uses, the `for (const k …)` guard names what is missing. `caseMain` runs first so line 2's "no room left" sees an empty root (line 11's seam leaves a room in the gate root by design; cleanup removes it).

- [ ] **Step 2: Syntax.** `set -o pipefail; node --check scripts/live-gate-standing-approval.mjs` → no output.

- [ ] **Step 3: Live run (orchestrator, Tier A: Paco's chat is never messaged; the third-party POST is stated above).** In the worktree: `set -o pipefail; npm run build && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-standing-approval.mjs 2>&1 | tee /tmp/hg-4a-gate.log` (no `--only`: only a run of every case ships) → every line 1–15 `PASS`, last line `{"ok":true,"fails":0,"inconclusive":false,"partial":false,…}`, exit 0. An INCONCLUSIVE (exit 2) is rerun once; a second INCONCLUSIVE goes in the report with the diagnosis. Paste the full output into the slice report. The gate never writes the live DB, so a live daemon is no obstacle; say in the report whether it was live.

- [ ] **Step 4: Commit**
```bash
git add scripts/live-gate-standing-approval.mjs
git commit -m "test(gate): Stage 4A live gate — streak, sealed fourth, auto grant, silent-degradation line, revoke, deny, and every no-seal path"
```

---

### Task 12: Docs sync (orchestrator) — ADR 0030 amendment, index row, configuration, ROADMAP, todo, sessions, lessons

Done by the orchestrator after Task 11's gate PASS and the whole-branch reviews; no code. `docs/decisions/` is protected: the amendment is drafted under the approved spec and marked **awaiting Paco's signature** (standing pre-ruling, `tasks/todo.md`). Placement rules: `CONTRIBUTING.md`. Every item below names its file, its anchor and the text it must carry; "verify" means grep after writing.

- [ ] **1. `docs/decisions/0030-decision-ladder.md`** — append after the last amendment (the 2026-10-28 clean-room one, line 575 today) a section `## Amendment (2026-10-28): Stage 4A, standing approval for a scheduled command (drafted under the approved spec — awaiting Paco's signature)`. Opening line: "This file is protected (ADR 0011); this amendment is drafted for Paco's hand. Spec: `docs/superpowers/specs/2026-10-28-ladder-stage4a-standing-approval-design.md` (Rev 4, approved 2026-10-28, Decision 1-A)." Bullets, each a decision (compromises go to `tasks/todo.md`, not here):
  - **§8.3's grant criterion, restated (Tier C, Paco's Decision 1-A):** "its report reaches Paco" alone never grants — failed runs deliver on the same `final_report` key. A key (schedule, chat, fingerprint) stands up only when the fourth approved call ran sealed and **every** code-owned fact is true: `status succeeded ∧ exit_code 0 ∧ ¬truncated ∧ ran ∧ torn_down ∧ ¬tampered ∧ ¬escaped ∧ ¬check_failed ∧ run completed ∧ final_report delivered`. The grant is then immediate and automatic (`granted_by: auto`, `granted_via: approval.standing`, §4.3 unchanged), with an urgent card and Revoke. Residual, stated: a sealed run with exit 0 and a plausible but wrong report stands until Paco revokes.
  - **Storage moves off `ladder_moves` alone:** `standing_approvals` (one live row per key, ended rows kept for audit and the deny block) and `standing_uses` (the per-run cap), additive migration `2026-10-28-standing-approval`; the ladder move is the grant's record, the row is its state.
  - **Executor-setting path:** the bridge is a selector only; the runner turns a gated ask into an allow only after the store's `standingUse` CAS wins at the execution boundary; the fourth call's `candidate → sealing` runs in its own transaction right after the approval's consume committed: sealing records intent for sealed execution after a committed consume, and a sealing row with no call facts ends at its 24 h TTL. No model path opens, advances or grants anything.
  - **Eligibility:** scheduled `shell_external` with a readable label, the run's notify chat, trust not asking (a trust ask beats standing), posture live, the clean room available, one use per run; byte-identical bytes only (the canonical fingerprint).
  - **Ends:** Revoke (any time in the 30 days, the row's chat only), 30-day expiry, schedule cancelled/disabled, a fingerprint mismatch from the key's own schedule and chat, a denial on (chat, fingerprint) from **any** run (30-day block), a streak idle 30 days (ended even inside the consume, before a credit), a sealed trial that did not seal or whose report arrived after its 24 h, a standing use whose own facts show a broken seal (`tampered_use`); a pre-spawn failure with `ran:false` voids the trial back to candidate.
  - **The grant re-reads its evidence** in its own transaction (three distinct consumed approvals of the key, the consumed fourth on the sealed call, the facts, the completed run, the delivered report) and never commits without its Revoke card.
  - **Tap binding:** a scheduled run's approval is answered only from its own notify chat.
  - **B14 / `approval.bind`:** the standing case lives in `tool.policy`'s rule (v3 reason codes `standing`, `standing_mismatch`) and the sink CAS; `approval.bind` stays a locked id with no module.
  - **Open window (from the spec §9):** until SP3 moves the self-write test gate to its own macOS user, a concurrent test gate can write into `<cache>/cleanroom/` as Paco; the post-run tamper check catches a plant that persists.
  - **Rollback:** revert + rebuild; the previous build never reads the tables and asks again (`scripts/check-standing-rollback.mjs`). Note for a roll-forward after a rollback: a denial made while the previous build ran does not end a row (that build has no deny hook) — revoke such a row by hand from `/schedule`.
  Verify: `grep -n "Stage 4A, standing approval" docs/decisions/0030-decision-ladder.md` → one line.
- [ ] **2. `docs/decisions/README.md`** — the 0030 row (line 44): append to its status cell `; amended 2026-10-28 (Stage 4A: standing approval for a scheduled command — automatic grant after a sealed fourth run whose ten facts are true and whose report was delivered, Decision 1-A; standing_approvals/standing_uses; one use per run by store CAS; Revoke, 30-day expiry, deny block; drafted, awaiting signature) — see [2026-10-28-ladder-stage4a-standing-approval-design.md](../superpowers/specs/2026-10-28-ladder-stage4a-standing-approval-design.md)`. Verify: `grep -c "stage4a-standing-approval-design" docs/decisions/README.md` → 1.
- [ ] **3. `docs/reference/configuration.md`** — (a) the "Clean room" section (line 1205): header becomes `## Clean room (sealed runs, ADR 0030 §8.3 — runtime landed 2026-10-28; selected by Stage 4A standing approval)`, and the opening sentence's "Stage 4A's standing match will be the first setter; until then no production call selects it" becomes "Stage 4A selects it for a scheduled command's fourth approved run and for every standing use (see Standing approval)". The **Audit** bullet's facts list gains `exit_code, truncated, check_failed, room, reason`. (b) New section after it: `## Standing approval (Stage 4A, ADR 0030 §8.3)` — **no environment variable** (state it: durations are code constants, `src/decisions/standing-approval.ts` and `STANDING_STREAK` in `run-store.ts`); bullets: the rule (3 distinct consumed scheduled runs → candidate; the fourth runs sealed; grant on the ten facts; one use per run; 30-day expiry; deny block 30 days; stale 30 days; sealing TTL 24 h); what Paco sees (the fourth card's "Why:" line verbatim = `STANDING_TRIAL_LINE`; the grant card; `/schedule` → "常驻批准" with `#N label · schedule · 到期 date` and one Revoke each; digest "Standing approvals" lines for `sealed_trial_failed`, `denied`, `expired`, `stale`, `mismatch`); the callback `dec:sa:<standing_id>:revoke`; ledger events `standing_streak|sealing|sealed|granted|used|ended` (ids, reasons, counts, seal facts — never command bytes); incident kinds `standing_hook_failed` (deny hook SQL error: the resolution rolls back whole, the tap is refused with `STANDING_HOOK_FAILED` and Paco is told the standing approval may still be live — Revoke from `/schedule` or tap again), `standing_credit_failed` (a credit fault after a consume: the command ran, uncredited), `standing_evidence_failed` (a seal whose evidence re-read found a gap: the trial ended), `standing_card_failed` (a tamper end whose urgent card could not be queued), `standing_settle_failed`, `standing_sweep_failed`; end reasons incl. `tampered_use` (a standing use's own facts showed a broken seal: the grant ends, an urgent card, no digest line); tables `standing_approvals`, `standing_uses`; gate `node scripts/live-gate-standing-approval.mjs` (15 lines; offline → INCONCLUSIVE exit 2; `--only` → PARTIAL exit 3, never a shipping PASS) and rollback `node scripts/check-standing-rollback.mjs --old-dist …`. Link it from the README's configuration pointer only if the README lists sections (it links the file; no duplication). Verify: `grep -n "^## Standing approval" docs/reference/configuration.md` → one line; `grep -n "HOUGE_STANDING" -r src docs` → nothing (no env var was added).
- [ ] **4. `docs/ROADMAP.md`** — after the "Delta 2026-10-28: the clean room is built and runs" paragraph (line 212), a new paragraph `**Delta 2026-10-28: Stage 4A standing approval shipped** (Stage 4 item #5; spec Rev 4, Decision 1-A).` stating: what stands (one scheduled command per key after three approved runs and a sealed fourth with every fact true and its report delivered), the first live candidate (the Alishan `HTTP write` on `sch_2af53119-…` — its schedule is disabled since 2026-10-26, so nothing stands up until Paco re-creates or re-enables a schedule; the 14 historical approvals do not credit, the hook counts from deploy), what is out (endpoint allowlists, cross-schedule, unscheduled turns), and **Next:** the following Stage 4 item per ROADMAP order (standing pre-ruling: chaining). Replace the old paragraph's last sentence "Next: Stage 4A standing approval …" with "Next: see the Stage 4A delta below."
- [ ] **5. `tasks/todo.md`** — the CURRENT SYSTEM STATE block: new top paragraph `**Stage 4A standing approval: SHIPPED to main 2026-10-28 (branch feat/stage4a-standing, <n> commits). Kickstart OWED (dist rebuilt; new tables migrate on boot); run in flight from this build: <yes/no>.**` with spec/plan paths, what exists (by file: `standing-approval.ts`, the store hooks, the runner CAS, the bridge selector, the dispatcher hook, the sweep in `schedule-tick.ts`, Revoke, `/schedule` section, digest lines), the evidence on the final head (typecheck/build, suite file/test counts with 0 skipped, the gate's 15 lines from a run of every case, the rollback check INCONCLUSIVE (exit 3, the single `no --session-dir` line, every other line PASS) without `--session-dir` and PASS (exit 0) with it, the gate's stated residual that the terminal path was driven by hand), reviews (plan reviews; per-task reviewer models ≠ implementer; whole-branch Opus/other + codex), and open items: the ADR amendment awaiting signature; the self-write test gate window (SP3, unchanged); the roll-forward note (a deny made under a rolled-back build does not end a row); the deferred minors the reviews logged. Mark the Stage 4A spec checkbox `[x]`. Move the clean-room Slice 1 paragraph below it (history).
- [ ] **6. `sessions.md`** — append `## 2026-10-28 — Decision ladder Stage 4A, standing approval (ADR 0030 §8.3): SHIPPED` (one arc paragraph like the Slice 1 entry: the spec's measured facts that changed the design — delivery proves receipt, not success; the fingerprint is computed after policy today and moved before it; `consumeToolApproval` had no transaction; Paco's Decision 1-A; how it was built (implementer/reviewer models per task); what the reviews found; the gate's silent-degradation line; evidence; open for Paco; taps this slice).
- [ ] **7. `tasks/lessons.md`** — add under the most fitting heading (or a new `## Standing approvals / sealed credit`) at least the rule this slice taught; candidates to write only if they happened: "A delivered notice proves receipt, not success: success and failure share `<run_id>:final_report` (§2). Any rule that reads 'its report reached Paco' must also read the run's state and the call's own facts." and "A provenance check keyed on one compiled file (`core-worker.js`) refuses a genuine previous build when the slice never touches that file: name the file the slice changes." Each lesson: date, what happened, the rule.
- [ ] **8. Verify and commit** — `set -o pipefail; git diff --stat -- docs tasks sessions.md` shows only these seven files; `grep -rn "awaiting Paco's signature" docs/decisions/0030-decision-ladder.md | tail -1` names the Stage 4A amendment. Commit per concern, staged by name:
```bash
git add docs/decisions/0030-decision-ladder.md docs/decisions/README.md
git commit -m "docs(adr): ADR 0030 amendment — Stage 4A standing approval (drafted, awaiting Paco's signature)"
git add docs/reference/configuration.md docs/ROADMAP.md
git commit -m "docs: standing approval reference section and ROADMAP delta"
git add tasks/todo.md sessions.md tasks/lessons.md
git commit -m "docs(todo): Stage 4A shipped — state block, session arc, lessons"
```

---

## Self-review

### Spec coverage (§4–§10 → tasks)

| Spec section | Requirement | Task(s) |
|---|---|---|
| §4 Key | `(schedule_id, chat_id, action_fingerprint)`; chat from `runs.notify_json` in store and bridge | 1 (row/index), 3 (`standingKeyOf`), 6 (`standingSelect` uses `turn.chat_id`, same column) |
| §4 Fingerprint | exported `actionFingerprint`, equal to the runner's, computed before policy | 2 |
| §4 Eligible action | `shell_external`, label without `unseen shell script`, never destructive / memory write | 3 (store key), 6 (bridge) |
| §4 Eligible call | scheduled, notify chat, trust no ask, posture, `cleanroomAvailable`, one use per run, row standing/unexpired/move active/schedule enabled | 2 (trust beats standing), 4 (CAS re-reads every fact; `standing_uses` cap), 6 (selector), 11 lines 4/5/9 |
| §5 Storage | DDL verbatim, partial unique index, deny index, `standing_uses`; ended rows kept | 1 |
| §5 Ledger events | six types, ids/reasons only | 1 (types), 3 (streak/sealing/ended), 4 (used), 7 (sealed/granted), 8 (ended) |
| §5 Rollback | additive + idempotent; `check-standing-rollback.mjs` in full | 1 (migration idempotency test), 10 |
| §6 streak / candidate | distinct-run credit, same-run second approval adds nothing, expired neutral, different key independent | 3 |
| §6 candidate → sealing | only behind the fourth consume CAS with the trial selector; lost CAS still runs sealed, no credit | 3, 6 |
| §6 sealing → sealed → standing | full conjunction; Decision 1-A immediate grant (`sealed` not persisted: one CAS + `standing_sealed` event) | 7 |
| §6 sealing → candidate | `ran:false` ∧ PRE_SPAWN reason, checked first | 5 (reason persisted), 7 (`sealVerdict`, `resetStandingToCandidate`) |
| §6 sealing → ended | any fact false (`truncated` unknown is not whole), facts missing, run not completed, outbox `failed_terminal`, 24 h TTL checked before delivery (Ruling 7), an evidence gap at the grant (Ruling 6) | 5 (`truncated: boolean \| null`), 7 |
| §6 standing → ended | Revoke, expiry, schedule cancelled/disabled, deny from any run, mismatch (from the key's own caller, Ruling 10), a broken seal on a standing use (`tampered_use`, Ruling 3) | 1 (`endStandingApproval`), 3 (deny), 4 (mismatch after the caller binding), 7 (`settleStandingUses`, dispatcher hook + sweep), 8 (Revoke, sweep, cancel) |
| §6 no-row deny | ended row with `denied_until` on a scheduled run (eligible action only) | 3 (fixed here to use `standingKeyOf`) |
| §6 stale | streak/candidate idle 30 d; ended inside the consume before a credit (Ruling 8) | 3 (`standingCredit`, `STANDING_STALE_MS`), 8 (sweep) |
| §7 Consume hook | the CAS commits on its own, the credit in its own transaction after it; a credit fault is an incident and never blocks the command (Ruling 2); trial plumbing; approval row's `tool_call_id`; `{ ok, sealing }` audit/test-only (Ruling 5) | 2 (sink input), 3 |
| §7 Deny hook | plain statements in the approval transaction; SQL error rolls back whole; incident after rollback; a `STANDING_HOOK_FAILED` refusal with a `/schedule` Revoke line, never a throw out of intake (Ruling 1) | 3 (store + `gateway.ts` refusal text) |
| §7 Tap chat binding | scheduled run's approval answered only from its notify chat | 3 |
| §7 Bridge | standing → selector + `executor: cleanroom` on the first call; candidate → trial selector, resume sealed, card line | 6 |
| §7 Runner | fingerprint before policy; standing only satisfies a gate; CAS via sink only with a clean-room ctx (Ruling 4); fail closed without `standingUse`; forged selector asks; v3 reasons | 2 |
| §7 Use CAS | every fact re-read in one transaction; the caller's schedule/chat binding before a fingerprint mismatch may end the row (Ruling 10); `standing_uses` per-run cap | 4 |
| §7 Seal facts at the source | `exit_code`, `truncated` (null when not a boolean), `check_failed`, `room`, `reason` | 5 |
| §7 `settleSealing` | idempotent, total, own transaction; dispatcher after `markDelivered` (`createOutboxDispatcher`, structurally pinned as the daemon's only sender); per-cycle sweep, one poisoned trial never stops the rest; the delivery hook catches the trial settle and the standing-use check separately | 7 |
| §7 Grant (1-A) | the row and its whole evidence re-read in the grant's transaction, only on a seal verdict; a trial changed meanwhile is `lost`, never granted or ended on the older evidence (Ruling 6; one test per evidence guard + an interleaved race test); `insertLadderMove` auto with evidence order; row → standing; `expires_at`; event; card with Revoke, rolled back with the grant when the card cannot be queued (Ruling 9); `grant_notification_id` | 7 |
| Ruling 3 (post-grant tamper) | a standing use's `tampered` / `escaped` / `check_failed` / `ran ∧ ¬torn_down` → `ended(tampered_use)`, move ended, urgent card | 7 (`settleStandingUses`, `listStandingUses`) |
| §7 Taps | `dec:sa:<id>:revoke`, no `TAP_STALE_DAYS`, chat check, one-shot, one transaction, rich renderer reply | 8 |
| §7 `/schedule` | "常驻批准" section with Revoke buttons | 8 |
| §7 Expiry / schedule end / stale | sweep + `cancelScheduledTask` | 8 |
| §7 Sealed outcomes to the planner | pre-spawn failure returns `ok:false`, never re-run | unchanged Slice 1 behaviour; 7 (never re-run: settle only reads facts), 11 lines 10–14 |
| §7 Kill switch | unchanged (`postureOk()` first) | 6 (selection runs after `handleCall`'s posture check) |
| §8 Fourth card line | `STANDING_TRIAL_LINE` via the sink's `reason`, only when the room is available | 6 |
| §8 Grant card | conditions + Revoke | 7 (`grantCardText`) |
| §8 Digest | one line per `sealed_trial_failed`, `ended(denied|expired|stale|mismatch)` over the persisted cutoff (the last sent digest's `created_at`), each end once | 9 |
| §9 Safety | no model path; fingerprint equality asserted; standing never converts a trust ask / masked read / destructive / hostile / killed / no room / other chat-schedule / second call | 2, 3, 4, 6, 11 |
| §9 Open window | self-write test gate until SP3 | 12 (ADR + todo) |
| §10 Unit | every transition, `actionFingerprint` ≡ runner, policy order, CAS matrix, settle truth table, forged selector, revoke parser + handler, `/schedule`, migration idempotency, `cleanroomAvailable` | 1, 2, 3, 4, 6, 7, 8 |
| §10 Bridge | fourth carries the selector on the resume, fifth on the first call, unscheduled never, hostile asks, sandbox off asks | 6 |
| §10 Live gate | every line incl. the silent-degradation PASS line; every no-seal line asserts delivery; unknown `--only` refused, `--only` is PARTIAL; only its own roots cleaned | 11 |

### Placeholder scan

`grep -nE "TBD|TODO|FIXME|\?\?\?|<fill|lorem|xxx" docs/superpowers/plans/2026-10-28-stage4a-standing-approval.md` → only the literal `<n>` commit count and `<yes/no>` in Task 12's todo-block template (filled at ship time from `git rev-list --count` and the daemon's state) and the CLI placeholders `<path>`, `<sha>`, `<kept gate run>` in usage lines; no unwritten step, no "similar to Task N" without code.

### Cross-task consistency (Produces of Tasks 1–6 consumed by Tasks 7–11)

| Produced by | Name / type | Consumed in | As used there |
|---|---|---|---|
| 1 | `StandingApprovalRow` (fields `state`, `sealed_run_id`, `sealed_tool_call_id`, `sealing_approval_id`, `sealing_started_at`, `approval_ids_json`, `move_id`, `grant_notification_id`, `expires_at`, `updated_at`, `ended_at`, `ended_reason`, `label`, `schedule_id`, `chat_id`) | 7, 8, 9, 10, 11 | `settleRow(row)`, `grantStanding(row)`, `endLapsed`/`endStale`, `standingLines`, `snapshot()` SQL columns |
| 1 | `StandingState`, `StandingEndReason` (`sealed_trial_failed`, `revoked`, `expired`, `schedule_ended`, `stale`, `mismatch`, `denied`, `tampered_use`) | 3, 7, 8, 9 | `listStandingApprovals({ state: "sealing" })`; `reason: "sealed_trial_failed" / "revoked" / "expired" / "schedule_ended" / "stale"`; `STANDING_DIGEST_TEXT` keys |
| 1 | `listStandingApprovals(f?: { state?; chat_id?; schedule_id? }): StandingApprovalRow[]` | 7, 8, 9 | sweep, `/schedule` section (`{ state: "standing", chat_id }`), cancel (`{ schedule_id }`), digest (`{ state: "ended", chat_id }`) |
| 1 | `getStandingApproval(standing_id): StandingApprovalRow \| undefined` | 7, 8, 10, 11 | tests, `standingTap`, gate lines |
| 1 | `standingFor(key: StandingKey)` | 11 | `keyOf(e)` → `{ schedule_id, chat_id, action_fingerprint }` |
| 1 | `standingDenied(chat_id, action_fingerprint, now): boolean` | 11 | line 8 |
| 1 | `finalReportState(run_id): string \| undefined` | 7, 11 | `sealVerdict({ outbox })`; gate detail |
| 1 | `endStandingApproval({ standing_id, reason, now, denied_until? }): boolean` (joins tx; ends the move) | 7, 8 | `settleRow` end arm; `standingTap`; sweep |
| 1 | private `endStandingTx(i)` | 8 | `cancelScheduledTask` (inside its own `joinTransaction`) |
| 1 | `appendStandingLedgerEvent(event_type, payload, run_id?)` | 7, 10 | `markStandingGranted`, `resetStandingToCandidate`; rollback seed |
| 1 | `insertStandingApprovalForTest(r)` (@internal) | 7, 8, 9, 10, 11 | test fixtures; rollback seed; gate `seedRow` |
| 1 | ledger types `standing_sealed` (req. `standing_id, run_id, tool_call_id`), `standing_granted` (req. `standing_id, move_id`), `standing_streak` (req. `…, streak`) | 7 | `markStandingGranted` payloads; reset payload carries `streak: 3` + `reset` |
| 2 | `actionFingerprint(capability, metadata, input): string` | 10, 11 | `actionFingerprint("shell_external", OMP_SHELL_META.shell_external, { command })` |
| 2 | `TOOL_POLICY` v3 reason codes `standing`, `standing_mismatch` | 10, 11 | rollback seed decision `reason_code: "standing"`; gate lines 4/5 `reasons(...)` |
| 2 | `ApprovalRequestSink.standingUse?` / `StandingUseInput` | 11 (through the real sink) | line 4 `standing_used` |
| 3 | `STANDING_STREAK = 3` | 7 | `slice(0, STANDING_STREAK)` for evidence and reset |
| 3 | `STANDING_STALE_MS` (run-store) | 3, 8 | `standingCredit`'s stale check; `endStale` imports it from run-store |
| 3 | refusal code `STANDING_HOOK_FAILED` + `APPROVAL_REFUSAL_TEXT` line | 12 | configuration.md incident list |
| 3 | sealing row contract: `approval_ids_json` = 3 credited ids + the sealing id; `sealed_tool_call_id` = the approval row's `tool_call_id` (= bridge `req.toolCallId`) | 7, 11 | evidence `[...ids.slice(0,3), sealing_approval_id, decision_id, sealed_run_id, sealed_tool_call_id]`; `tool_finished.tool_call_id === sealed_tool_call_id` |
| 3 | `StandingHookError`, incident `standing_hook_failed` | 12 | configuration.md incident list |
| 3 | `consumeToolApproval(...): { ok: true; sealing: boolean } \| { ok: false; code }` | 11 | through the real sink (line 2 `sealing` row) |
| 4 | `standingUse({ standing_id, action_fingerprint, run_id, tool_call_id, now })` (own `inTransaction`) | 7, 10 | the tamper fixture's real use; rollback seed, called **outside** the seed transaction |
| 4 | refusal code `mismatch` end (`ended_reason: "mismatch"`) | 9 | digest line |
| 5 | `CleanroomFacts = { ran; torn_down; tampered; escaped; exit_code: number \| null; truncated: boolean \| null; check_failed; room?; reason? }` | 7 | `factsOf()` accepts `truncated: null`; `sealedCall()` requires `truncated === false` and reads every field |
| 5 | `CLEANROOM_REASONS` | 7 | test: `PRE_SPAWN_REASONS ⊂ CLEANROOM_REASONS` |
| 5 | `tool_finished` payload `{ tool_call_id, status, executor: "cleanroom", cleanroom: CleanroomFacts }` | 7, 11 | `settleRow` lookup; gate `fin()` |
| 6 | `cleanroomAvailable(cfg)` | 11 | exercised through the bridge (line 9, `sandbox: false`) |
| 6 | `STANDING_TRIAL_LINE` | 11 | line 2 compares the card's `Why:` line |
| 6 | room on the standing use's first call and on any selector's approved resume | 11 | lines 2, 4, 5 (`executor: "cleanroom"`) |

Names introduced in Tasks 7–9 and consumed later: `SA_PREFIX`, `revokeButton(standing_id, text?)` (8 `/schedule` and the round-trip test, 7 card, 11 line 3 `dec:sa:<id>:revoke`), `runStandingSweep(store, now)` + `settleQuietly` + `endTamperedUses` (7 → 8 extends with `endLapsed` / `endStale`, 10 `newReopens`), `settleDeliveredReport(store, record, env?, now?)` + `createOutboxDispatcher(store, adapters)` (7 → daemon, 11 dispatcher), `settleStandingUses` / `listStandingUses` / `tamperedUseText` (7 only), `standingRevokedText` (8 test), `markStandingGranted` / `resetStandingToCandidate` / `setStandingGrantNotification` (7 only), `lastSentDecisionDigestAt` (9 only). File-structure table rows match: `markStandingGranted`, `resetStandingToCandidate`, `listStandingUses`, `lastSentDecisionDigestAt` (run-store), `onDelivered` (dispatcher), `createOutboxDispatcher` (daemon), `runStandingSweep` before the flag (schedule-tick), the `STANDING_HOOK_FAILED` line (gateway).
