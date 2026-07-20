# Introspection Slice A — the invariant sweep (Houge's first self-sensing organ)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Houge a deterministic, zero-LLM sense organ that reads his own flight recorder every cycle, opens a durable *incident* when a behavioral invariant is violated, tells Paco once, and resolves the incident when the condition clears.

**Architecture:** A new periodic tick (`src/run/invariant-sweep.ts`) riding the existing signal path in `telegram-daemon.ts`, alongside the scheduler/backup/distill ticks. All SQL lives in `RunStore` (repo convention); the sweep module composes detection results into an incident lifecycle (open → recur → resolve), appends ledger events, and enqueues at most one Telegram alert per incident transition. Pure code — no LLM, no capability, no run creation, so the sweep can never act, only observe and report.

**Tech Stack:** TypeScript ESM, node:sqlite via `RunStore`, Vitest. Feature flag `HOUGE_INVARIANT_SWEEP_ENABLED` (new, default OFF).

**Why this exists (2026-07-20):** Houge's four-level memory spine (lessons, skills, wiki, episodic facts) stores *content* — what was said, learned, known. Nothing reads `ledger_events` / `runs` / `scheduled_tasks` / `notification_outbox`: a complete timestamped record of what Houge actually *did*, currently write-only. Every behavioral bug this week (duplicate schedule, unpersisted promise, ordinal misfire) was found by a human running SQL that Houge could have run himself. ADR 0012 says the eval loop lives or dies on an *executable verifier* and notes conversation has none — but **behavior does**: DB state is mechanically checkable. This is that verifier.

**Scope discipline (ADR 0012's own "thin vertical slice" doctrine):**
- **Slice A (this plan):** deterministic invariants, incident store, push alerts on transition. Zero LLM, zero new Telegram commands.
- **Slice B (deferred, only if A earns it):** the judgment half — promise-vs-action diffing, plan-vs-execution divergence, refusal clustering, daily LLM retro digest, an `/incidents` list view, and the incident→`self_diagnose`→regression-tested-self-write bridge.

**Background reading for the engineer:**
- `docs/decisions/0012-self-evolution-spine-closed-loop.md` — the loop this serves (`sense → remember → change → evaluate → keep/rollback → consolidate`); this plan builds the missing **sense** stage.
- `src/run/schedule-tick.ts` — the closest structural sibling: a periodic tick that takes `now` + optional `env`, is flag-gated internally, and never throws into the daemon loop. Mirror its shape.
- `src/run/db-backup.ts` — the other periodic tick with a state-latch table.
- `tests/run/schedule-tick.test.ts` — the harness to mirror: module-level `NOW`, an `ARMED` env literal passed as `env:`, a real `RunStore`, no timer mocking (the clock is a `now` string parameter).

**Repo conventions that are load-bearing (do not deviate):**
- All SQL lives in `run-store.ts`; other modules call store methods.
- Rows are never deleted; a terminal state (`resolved`) is history.
- Error/digest strings are exported constants — tests assert via the export, never a pinned literal.
- Ledger payloads carry counts and ids only, never user text or venue content.
- Feature-flag resolvers take `env` explicitly (testability) and default OFF.
- Run vitest as `npx vitest run <file>` from the repo root.

---

## Design decisions locked before coding

**1. The invariant catalog.** Six assertions, each motivated by a real or latent failure:

| # | Invariant | Violation | `kind` | Motivation |
|---|---|---|---|---|
| 1 | No two enabled schedules share (chat_id, spec_json, tz, goal) | `GROUP BY … HAVING COUNT(*) > 1` | `duplicate_schedule` | 2026-07-19 duplicate AI周报 |
| 2 | An ACTIVE run holds a live lease | active-state row with `lease_expires_at < now` | `stuck_run` | 2026-07-19 "ready for worker" stall |
| 3 | Queued notifications get delivered | outbox row not `delivered`, `created_at` older than grace | `undelivered_notification` | the last mile to Paco |
| 4 | Enabled schedules fire near their cursor | `state='enabled' AND next_run_at < now - grace` | `overdue_schedule` | daemon-down misfire window |
| 5 | No schedule is parked as failed | `state='failed'` | `failed_schedule` | a dead schedule is silent today |
| 6 | The heartbeat has no unexplained gap | `last_success_at < now - grace` | `heartbeat_gap` | 2026-07-19 "fetch failed" |

**2. Run-state partition for invariant #2** (verified against `RunState`, `src/domain/types.ts:51`):
- **Terminal** (never an incident): `completed`, `failed`, `cancelled`, `expired`.
- **Parked by design** (never an incident, however old): `waiting_for_approval` — a run waiting on Paco's `/approve` is the system working correctly. Alerting here would make the sweep noisiest exactly when Paco is slowest, training him to ignore it.
- **Active** (the only states examined): `created`, `contracted`, `queued`, `running`, `reconciliation_required`, `reporting`.

**3. Incidents are stateful, not events.** The sweep runs every cycle and a violating condition persists, so naive alerting would repeat forever. Fingerprint = `kind:subject` (the stable id of the thing at fault — a `schedule_id`, `run_id`, `notification_id`, or the literal `daemon` for singletons). First detection opens a row and notifies; later detections only bump `last_seen_at`/`seen_count` silently; a clean sweep resolves the row. A resolved fingerprint that violates again opens a **new** row, so recurrence is countable (Slice B's pattern layer needs this).

**4. Notification policy.** One Telegram line on OPEN. On resolve, notify only if the incident was open ≥ `INCIDENT_RESOLVE_NOTIFY_MIN_MS` (1 h) — short blips resolve silently. Ledger events on both transitions regardless: the ledger is the durable audit trail, the outbox is the human channel.

**4a. Alert storm cap (senior review BLOCKER).** A single systemic failure produces *many* violations at once — if the outbox dispatcher breaks, every queued notification trips invariant #3, so a naive implementation would enqueue hundreds of Telegram messages about the fact that Telegram delivery is broken. The sweep therefore **opens every incident** (the durable record must stay complete) but **alerts at most `INCIDENT_ALERTS_PER_SWEEP_MAX` (3)** per sweep, followed by one summary line naming the suppressed count. Incident rows are cheap; Paco's attention is not.

**4b. Flap damping (senior review BLOCKER).** A condition oscillating around a threshold (a schedule hovering at the overdue grace, a heartbeat at the edge) would open → resolve → reopen each sweep, and every reopen is a fresh fingerprint-free row that would alert again. So on open, if a same-fingerprint incident was **resolved within `INCIDENT_REOPEN_QUIET_MS` (30 min)**, the row is still created (recurrence stays countable — Slice B's pattern layer needs the count) but its alert is **suppressed**. Ledger events are unaffected: the audit trail records everything, the human channel is damped.

**5. Cadence.** The signal path ticks roughly every 30 s; running six queries that often is wasteful. The sweep self-throttles to `INVARIANT_SWEEP_INTERVAL_MS` (5 min) via an `invariant_sweep_state` latch row, mirroring the wiki/lesson decay latches.

**6. DISARM posture — explicit decision: the flag is NOT added to `DISARM_FLAGS`.** `src/config/disarm-posture.ts` lists flags covering *autonomous action* (self-write, codex, skills, scheduler, extwork, bounty); passive memory (episodic) is deliberately excluded. The sweep takes no action — it observes and reports. Disarming Houge should not blind him; a disarmed agent is exactly when Paco most wants to know something is wrong. Record this rationale in the ADR.

**7. Baseline.** All six invariants return zero violations against the live DB as of 2026-07-20, so the sweep ships silent and the first alert Paco ever receives is a real one.

---

## File Structure

| File | Change |
|---|---|
| `src/run/run-store.ts` | `applyIncidentsMigration()` + 6 detection queries + 5 incident lifecycle methods |
| `src/run/invariant-sweep.ts` | **new** — constants, detection composition, lifecycle, ledger, notifications |
| `src/run/run-ledger.ts` | 2 new `LedgerEventType` members + their `requiredPayloadFields` entries |
| `src/telegram/telegram-daemon.ts` | one tick call inside `runSignalPathTick` |
| `docs/decisions/0024-introspection-invariant-sweep.md` | **new** ADR |
| `tests/run/incidents-store.test.ts` | **new** — migration, lifecycle, detection queries |
| `tests/run/invariant-sweep.test.ts` | **new** — tick behavior, throttle, transitions, notifications |

Dependency order: Task 1 (store) → Task 2 (detection) → Task 3 (ledger types) → Task 4 (sweep module) → Task 5 (daemon wiring) → Task 6 (ADR + sweep + reload).

---

### Task 1: `incidents` table + lifecycle store methods

**Files:**
- Modify: `src/run/run-store.ts`
- Test: `tests/run/incidents-store.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/run/incidents-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

let store: RunStore;
beforeEach(() => {
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
});

const NOW = "2026-07-20T00:00:00.000Z";

describe("incidents store (introspection slice A)", () => {
  it("openIncident inserts an open row with seen_count 1 and both timestamps", () => {
    const row = store.openIncident({
      kind: "duplicate_schedule",
      subject: "sch_abc",
      detail: { count: 2 },
      now: NOW
    });
    expect(row.incident_id).toMatch(/^inc_/);
    expect(row.fingerprint).toBe("duplicate_schedule:sch_abc");
    expect(row.state).toBe("open");
    expect(row.seen_count).toBe(1);
    expect(row.first_seen_at).toBe(NOW);
    expect(row.last_seen_at).toBe(NOW);
    expect(row.resolved_at).toBeNull();
    expect(JSON.parse(row.detail_json)).toEqual({ count: 2 });
  });

  it("findOpenIncident locates by fingerprint; touchIncident bumps last_seen_at and the counter only", () => {
    const opened = store.openIncident({
      kind: "stuck_run",
      subject: "run_1",
      detail: { state: "running" },
      now: NOW
    });
    const found = store.findOpenIncident("stuck_run:run_1");
    expect(found?.incident_id).toBe(opened.incident_id);

    store.touchIncident(opened.incident_id, "2026-07-20T00:05:00.000Z");
    const after = store.getIncident(opened.incident_id)!;
    expect(after.seen_count).toBe(2);
    expect(after.last_seen_at).toBe("2026-07-20T00:05:00.000Z");
    expect(after.first_seen_at).toBe(NOW); // unchanged
    expect(after.state).toBe("open");
  });

  it("resolveIncident stamps resolved_at and hides the row from findOpenIncident (never deletes)", () => {
    const opened = store.openIncident({
      kind: "heartbeat_gap",
      subject: "daemon",
      detail: { gap_minutes: 42 },
      now: NOW
    });
    expect(store.resolveIncident(opened.incident_id, "2026-07-20T01:00:00.000Z")).toBe(true);
    expect(store.findOpenIncident("heartbeat_gap:daemon")).toBeUndefined();
    const row = store.getIncident(opened.incident_id)!;
    expect(row.state).toBe("resolved");
    expect(row.resolved_at).toBe("2026-07-20T01:00:00.000Z");
    // Resolving twice is a no-op, never a throw.
    expect(store.resolveIncident(opened.incident_id, "2026-07-20T02:00:00.000Z")).toBe(false);
  });

  it("a resolved fingerprint that violates again opens a NEW row — recurrence stays countable", () => {
    const first = store.openIncident({ kind: "failed_schedule", subject: "sch_x", detail: {}, now: NOW });
    store.resolveIncident(first.incident_id, "2026-07-20T01:00:00.000Z");
    const second = store.openIncident({
      kind: "failed_schedule",
      subject: "sch_x",
      detail: {},
      now: "2026-07-20T02:00:00.000Z"
    });
    expect(second.incident_id).not.toBe(first.incident_id);
    expect(store.listOpenIncidents().map((r) => r.incident_id)).toEqual([second.incident_id]);
  });

  it("listOpenIncidents returns only open rows, oldest first", () => {
    const a = store.openIncident({ kind: "stuck_run", subject: "run_a", detail: {}, now: NOW });
    const b = store.openIncident({
      kind: "stuck_run",
      subject: "run_b",
      detail: {},
      now: "2026-07-20T00:01:00.000Z"
    });
    store.resolveIncident(a.incident_id, "2026-07-20T00:02:00.000Z");
    expect(store.listOpenIncidents().map((r) => r.incident_id)).toEqual([b.incident_id]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/run/incidents-store.test.ts`
Expected: FAIL — `store.openIncident is not a function`

- [ ] **Step 3: Add the row type and migration**

In `src/run/run-store.ts`, add the exported row type next to `ScheduledTaskRow` (~line 374):

```ts
/** An open/resolved behavioral incident (introspection slice A). Rows are NEVER deleted. */
export interface IncidentRow {
  incident_id: string;
  /** Invariant family — the `kind` half of the fingerprint. */
  kind: string;
  /** Stable id of the offending thing (schedule_id / run_id / notification_id / "daemon"). */
  subject: string;
  /** `${kind}:${subject}` — deterministic, so the same violation always dedupes. */
  fingerprint: string;
  state: "open" | "resolved";
  /** Counts and ids ONLY — never user text (same redaction rule as ledger payloads). */
  detail_json: string;
  seen_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}
```

Add the migration method (copy the `applyProjectsMigration` shape exactly), placed immediately after it:

```ts
private applyIncidentsMigration(): void {
  const version = "2026-07-20-incidents";
  let activeTransaction = false;
  this.db.exec("BEGIN IMMEDIATE");
  activeTransaction = true;
  try {
    const applied = this.db.prepare(`
      SELECT version FROM schema_migrations WHERE version = ?
    `).get<{ version: string }>(version);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS incidents_state_fingerprint_idx
        ON incidents(state, fingerprint);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invariant_sweep_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_swept_at TEXT NOT NULL
      );
    `);

    if (!applied) {
      this.db.prepare(`
        INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
      `).run(version, new Date().toISOString());
    }
    this.db.exec("COMMIT");
    activeTransaction = false;
  } catch (error) {
    if (activeTransaction) this.db.exec("ROLLBACK");
    throw error;
  }
}
```

Then call it at the end of `migrate()`, immediately after the existing `this.applyProjectsMigration();` line:

```ts
    this.applyIncidentsMigration();
```

- [ ] **Step 4: Add the lifecycle methods**

Append after the migration method:

```ts
/** Fingerprint an invariant violation — deterministic, so repeat detections dedupe. */
incidentFingerprint(kind: string, subject: string): string {
  return `${kind}:${subject}`;
}

openIncident(input: {
  kind: string;
  subject: string;
  detail: Record<string, unknown>;
  now?: string | undefined;
}): IncidentRow {
  const incident_id = `inc_${randomUUID()}`;
  const now = input.now ?? new Date().toISOString();
  this.db.prepare(`
    INSERT INTO incidents (
      incident_id, kind, subject, fingerprint, state, detail_json,
      seen_count, first_seen_at, last_seen_at, resolved_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'open', ?, 1, ?, ?, NULL, ?, ?)
  `).run(
    incident_id,
    input.kind,
    input.subject,
    this.incidentFingerprint(input.kind, input.subject),
    JSON.stringify(input.detail),
    now,
    now,
    now,
    now
  );
  return this.getIncident(incident_id)!;
}

getIncident(incident_id: string): IncidentRow | undefined {
  return this.db.prepare(`
    SELECT * FROM incidents WHERE incident_id = ?
  `).get<IncidentRow>(incident_id);
}

/** The open row for a fingerprint, if any (resolved rows never match — recurrence reopens). */
findOpenIncident(fingerprint: string): IncidentRow | undefined {
  return this.db.prepare(`
    SELECT * FROM incidents WHERE fingerprint = ? AND state = 'open'
    ORDER BY first_seen_at ASC LIMIT 1
  `).get<IncidentRow>(fingerprint);
}

/** A repeat detection: bump recency + counter ONLY — never re-notifies, never moves first_seen_at. */
touchIncident(incident_id: string, now: string): void {
  this.db.prepare(`
    UPDATE incidents SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ?
    WHERE incident_id = ? AND state = 'open'
  `).run(now, now, incident_id);
}

/** Close an incident. False when absent or already resolved (idempotent, never a throw). */
resolveIncident(incident_id: string, now: string): boolean {
  const result = this.db.prepare(`
    UPDATE incidents SET state = 'resolved', resolved_at = ?, updated_at = ?
    WHERE incident_id = ? AND state = 'open'
  `).run(now, now, incident_id);
  return result.changes === 1;
}

/** Every currently-open incident, oldest first (the sweep's resolve pass + SQL inspection). */
listOpenIncidents(): IncidentRow[] {
  return this.db.prepare(`
    SELECT * FROM incidents WHERE state = 'open' ORDER BY first_seen_at ASC, incident_id ASC
  `).all<IncidentRow>();
}

/**
 * The most recent RESOLVED incident for a fingerprint closed at/after `since` — the flap
 * detector. A condition oscillating around its threshold reopens legitimately (recurrence
 * must stay countable) but must not re-alert every cycle.
 */
findRecentlyResolvedIncident(fingerprint: string, since: string): IncidentRow | undefined {
  return this.db.prepare(`
    SELECT * FROM incidents
    WHERE fingerprint = ? AND state = 'resolved' AND resolved_at >= ?
    ORDER BY resolved_at DESC LIMIT 1
  `).get<IncidentRow>(fingerprint, since);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/run/incidents-store.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/run/run-store.ts tests/run/incidents-store.test.ts
git commit -m "feat(introspection): incidents table + open/touch/resolve lifecycle"
```

---

### Task 2: The six detection queries

**Files:**
- Modify: `src/run/run-store.ts`
- Test: `tests/run/incidents-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/run/incidents-store.test.ts`:

```ts
describe("invariant detection queries", () => {
  function addSchedule(overrides: Record<string, unknown> = {}) {
    return store.addScheduledTask({
      chat_id: "555",
      goal: "AI周报",
      spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
      tz: "Australia/Sydney",
      next_run_at: "2099-01-01T00:00:00.000Z",
      now: NOW,
      ...overrides
    } as Parameters<RunStore["addScheduledTask"]>[0]);
  }

  it("findDuplicateEnabledSchedules groups identical enabled rows and ignores disabled ones", () => {
    const a = addSchedule();
    const b = addSchedule();
    expect(store.findDuplicateEnabledSchedules()).toEqual([
      { subject: a.schedule_id, chat_id: "555", duplicate_count: 2, schedule_ids: [a.schedule_id, b.schedule_id] }
    ]);
    // Disabling one clears the violation — history rows never count.
    store.cancelScheduledTask(b.schedule_id, NOW);
    expect(store.findDuplicateEnabledSchedules()).toEqual([]);
    // A different goal is not a duplicate.
    addSchedule({ goal: "different" });
    expect(store.findDuplicateEnabledSchedules()).toEqual([]);
  });

  it("findOverdueSchedules respects the grace window and ignores disabled/failed rows", () => {
    const overdue = addSchedule({ next_run_at: "2026-07-19T00:00:00.000Z" });
    addSchedule({ goal: "future", next_run_at: "2099-01-01T00:00:00.000Z" });
    const found = store.findOverdueSchedules(NOW, 15 * 60 * 1000);
    expect(found.map((r) => r.subject)).toEqual([overdue.schedule_id]);
    store.cancelScheduledTask(overdue.schedule_id, NOW);
    expect(store.findOverdueSchedules(NOW, 15 * 60 * 1000)).toEqual([]);
  });

  it("findFailedSchedules surfaces rows parked as failed", () => {
    const row = addSchedule();
    store.recordScheduleFailure(row.schedule_id, NOW, 1); // maxConsecutive 1 → flips to failed
    expect(store.findFailedSchedules().map((r) => r.subject)).toEqual([row.schedule_id]);
  });

  it("findHeartbeatGap fires only past the grace window", () => {
    store.recordPollHeartbeat({ now: "2026-07-19T23:00:00.000Z", ok: true });
    expect(store.findHeartbeatGap(NOW, 10 * 60 * 1000)?.subject).toBe("daemon");
    store.recordPollHeartbeat({ now: "2026-07-19T23:59:00.000Z", ok: true });
    expect(store.findHeartbeatGap(NOW, 10 * 60 * 1000)).toBeUndefined();
  });
});
```

NOTE: `findStuckRuns` and `findUndeliveredNotifications` need a real run / a real queued notification; assert those in the sweep test (Task 4) where the harness already builds runs through the Gateway, rather than hand-inserting rows here.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/run/incidents-store.test.ts`
Expected: FAIL — `store.findDuplicateEnabledSchedules is not a function`

- [ ] **Step 3: Implement the queries**

Add to `src/run/run-store.ts` after `listOpenIncidents`. Note every method returns a `subject` field so the sweep can fingerprint uniformly:

```ts
/**
 * Invariant detection (introspection slice A). Each query returns rows carrying a
 * `subject` (the fingerprint's stable half) plus counts/ids for the incident detail —
 * never user text. All six are pure reads: the sweep can never mutate through them.
 */
findDuplicateEnabledSchedules(): Array<{
  subject: string;
  chat_id: string;
  duplicate_count: number;
  schedule_ids: string[];
}> {
  const rows = this.db.prepare(`
    SELECT MIN(schedule_id) AS subject, chat_id, COUNT(*) AS duplicate_count,
           GROUP_CONCAT(schedule_id) AS ids
    FROM scheduled_tasks
    WHERE state = 'enabled'
    GROUP BY chat_id, spec_json, tz, goal
    HAVING COUNT(*) > 1
    ORDER BY subject ASC
  `).all<{ subject: string; chat_id: string; duplicate_count: number; ids: string }>();
  return rows.map((r) => ({
    subject: r.subject,
    chat_id: r.chat_id,
    duplicate_count: r.duplicate_count,
    schedule_ids: r.ids.split(",").sort()
  }));
}

/**
 * Runs stuck mid-flight: an ACTIVE state whose lease has expired. `waiting_for_approval`
 * is EXCLUDED by design — a run parked on Paco's /approve is the system working, and
 * alerting on it would make the sweep noisiest exactly when Paco is slowest to answer.
 */
findStuckRuns(now: string): Array<{ subject: string; state: string; lease_expires_at: string | null }> {
  return this.db.prepare(`
    SELECT run_id AS subject, state, lease_expires_at
    FROM runs
    WHERE state IN ('created', 'contracted', 'queued', 'running', 'reconciliation_required', 'reporting')
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
    ORDER BY updated_at ASC
  `).all<{ subject: string; state: string; lease_expires_at: string | null }>(now);
}

findUndeliveredNotifications(now: string, graceMs: number): Array<{
  subject: string;
  intent_type: string;
  attempt_count: number;
}> {
  const cutoff = new Date(Date.parse(now) - graceMs).toISOString();
  return this.db.prepare(`
    SELECT notification_id AS subject, intent_type, attempt_count
    FROM notification_outbox
    WHERE state != 'delivered' AND created_at < ?
    ORDER BY created_at ASC
  `).all<{ subject: string; intent_type: string; attempt_count: number }>(cutoff);
}

findOverdueSchedules(now: string, graceMs: number): Array<{
  subject: string;
  next_run_at: string;
  overdue_minutes: number;
}> {
  const cutoff = new Date(Date.parse(now) - graceMs).toISOString();
  const rows = this.db.prepare(`
    SELECT schedule_id AS subject, next_run_at
    FROM scheduled_tasks
    WHERE state = 'enabled' AND next_run_at < ?
    ORDER BY next_run_at ASC
  `).all<{ subject: string; next_run_at: string }>(cutoff);
  return rows.map((r) => ({
    ...r,
    overdue_minutes: Math.floor((Date.parse(now) - Date.parse(r.next_run_at)) / 60000)
  }));
}

findFailedSchedules(): Array<{ subject: string; consecutive_failures: number }> {
  return this.db.prepare(`
    SELECT schedule_id AS subject, consecutive_failures
    FROM scheduled_tasks
    WHERE state = 'failed'
    ORDER BY updated_at ASC
  `).all<{ subject: string; consecutive_failures: number }>();
}

/**
 * A heartbeat older than the grace window means the daemon was DOWN and has just come
 * back (the sweep only runs inside a live daemon) — a retroactive gap report, which is
 * exactly the thing Paco cannot otherwise see.
 */
findHeartbeatGap(now: string, graceMs: number): { subject: string; gap_minutes: number } | undefined {
  const row = this.db.prepare(`
    SELECT last_success_at FROM daemon_heartbeat WHERE id = 1
  `).get<{ last_success_at: string | null }>();
  if (!row?.last_success_at) return undefined;
  const gapMs = Date.parse(now) - Date.parse(row.last_success_at);
  if (gapMs < graceMs) return undefined;
  return { subject: "daemon", gap_minutes: Math.floor(gapMs / 60000) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/run/incidents-store.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/run/run-store.ts tests/run/incidents-store.test.ts
git commit -m "feat(introspection): six invariant detection queries over the flight recorder"
```

---

### Task 3: Ledger event types

**Files:**
- Modify: `src/run/run-ledger.ts`

- [ ] **Step 1: Add the union members**

In the `LedgerEventType` union (line ~11), append after `"project_state_changed"`:

```ts
  | "incident_opened"
  | "incident_resolved"
```

- [ ] **Step 2: Add the payload-field entries**

`requiredPayloadFields` is declared `as const satisfies Record<LedgerEventType, readonly string[]>` — a TOTAL record, so a new union member without an entry is a compile error. Add both, next to the other run-less system events:

```ts
  incident_opened: ["incident_id", "kind", "subject"],
  incident_resolved: ["incident_id", "kind", "subject", "open_minutes"],
```

- [ ] **Step 3: Verify the build type-checks**

Run: `npm run build`
Expected: clean (no TS errors)

- [ ] **Step 4: Commit**

```bash
git add src/run/run-ledger.ts
git commit -m "feat(introspection): incident_opened / incident_resolved ledger event types"
```

---

### Task 4: The sweep module

**Files:**
- Create: `src/run/invariant-sweep.ts`
- Test: `tests/run/invariant-sweep.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/run/invariant-sweep.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import {
  INCIDENT_ALERTS_PER_SWEEP_MAX,
  INVARIANT_SWEEP_INTERVAL_MS,
  runInvariantSweep,
  buildIncidentOpenedText
} from "../../src/run/invariant-sweep.js";

let store: RunStore;
beforeEach(() => {
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
});

const NOW = "2026-07-20T00:00:00.000Z";
const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1" };

function addDuplicatePair() {
  const base = {
    chat_id: "555",
    goal: "AI周报",
    spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
    tz: "Australia/Sydney",
    next_run_at: "2099-01-01T00:00:00.000Z",
    now: NOW
  };
  return [store.addScheduledTask(base), store.addScheduledTask(base)];
}

describe("runInvariantSweep (introspection slice A)", () => {
  it("disarmed by default: no queries, no incidents, no state row", () => {
    addDuplicatePair();
    const result = runInvariantSweep({ store, now: NOW, env: {} });
    expect(result).toEqual({
      swept: false,
      opened: 0,
      resolved: 0,
      recurring: 0,
      alerts_suppressed: 0
    });
    expect(store.listOpenIncidents()).toEqual([]);
  });

  it("armed: opens ONE incident per violation and enqueues exactly one notification", () => {
    const [a] = addDuplicatePair();
    const result = runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    expect(result.swept).toBe(true);
    expect(result.opened).toBe(1);
    const open = store.listOpenIncidents();
    expect(open.length).toBe(1);
    expect(open[0]!.kind).toBe("duplicate_schedule");
    expect(open[0]!.subject).toBe(a!.schedule_id);
    // Ledger records the transition.
    const events = store.getLedgerEvents().filter((e) => e.event_type === "incident_opened");
    expect(events.length).toBe(1);
    expect(events[0]!.actor).toBe("system");
    // Exactly one Telegram line, carrying the code-rendered text (outbox read via the
    // same private-db accessor tests/budget/metered-ceiling.test.ts:284 uses).
    const db = (store as unknown as {
      db: { prepare(sql: string): { get<T>(...v: unknown[]): T | undefined } };
    }).db;
    const note = db
      .prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?")
      .get<{ payload_json: string }>(`incident_opened:${open[0]!.incident_id}`);
    expect(note).toBeDefined();
    expect((JSON.parse(note!.payload_json) as { text: string }).text).toBe(
      buildIncidentOpenedText(open[0]!.kind, open[0]!.subject, JSON.parse(open[0]!.detail_json))
    );
  });

  it("throttles: a second sweep inside the interval is a no-op", () => {
    addDuplicatePair();
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    const soon = new Date(Date.parse(NOW) + INVARIANT_SWEEP_INTERVAL_MS - 1000).toISOString();
    expect(runInvariantSweep({ store, now: soon, env: ARMED, chat_id: "555" })).toMatchObject({ swept: false });
  });

  it("recurrence is silent: a later sweep bumps seen_count without a second incident or event", () => {
    addDuplicatePair();
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    const later = new Date(Date.parse(NOW) + INVARIANT_SWEEP_INTERVAL_MS + 1000).toISOString();
    const second = runInvariantSweep({ store, now: later, env: ARMED, chat_id: "555" });
    expect(second).toMatchObject({ swept: true, opened: 0, recurring: 1 });
    const open = store.listOpenIncidents();
    expect(open.length).toBe(1);
    expect(open[0]!.seen_count).toBe(2);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "incident_opened").length).toBe(1);
  });

  it("resolves when the condition clears, and records the resolve event", () => {
    const [, b] = addDuplicatePair();
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    store.cancelScheduledTask(b!.schedule_id, NOW); // the human fixed it
    const later = new Date(Date.parse(NOW) + INVARIANT_SWEEP_INTERVAL_MS + 1000).toISOString();
    const second = runInvariantSweep({ store, now: later, env: ARMED, chat_id: "555" });
    expect(second).toMatchObject({ swept: true, resolved: 1 });
    expect(store.listOpenIncidents()).toEqual([]);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "incident_resolved").length).toBe(1);
  });

  it("a clean database opens nothing (the sweep ships silent)", () => {
    const result = runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    expect(result).toMatchObject({ swept: true, opened: 0, resolved: 0 });
    expect(store.listOpenIncidents()).toEqual([]);
  });

  it("storm cap: many simultaneous violations open every incident but alert at most the cap + a summary", () => {
    // Six failed schedules = six independent violations in one sweep.
    for (let i = 0; i < 6; i += 1) {
      const row = store.addScheduledTask({
        chat_id: "555",
        goal: `g${i}`,
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z",
        now: NOW
      });
      store.recordScheduleFailure(row.schedule_id, NOW, 1); // → state 'failed'
    }
    const result = runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    // Every incident is recorded — the durable record is never truncated…
    expect(result.opened).toBe(6);
    expect(store.listOpenIncidents().length).toBe(6);
    // …but only the cap is alerted, and the remainder is counted.
    expect(result.alerts_suppressed).toBe(6 - INCIDENT_ALERTS_PER_SWEEP_MAX);
    const db = (store as unknown as {
      db: { prepare(sql: string): { all<T>(...v: unknown[]): T[]; get<T>(...v: unknown[]): T | undefined } };
    }).db;
    const alerts = db
      .prepare("SELECT idempotency_key FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'")
      .all<{ idempotency_key: string }>();
    expect(alerts.length).toBe(INCIDENT_ALERTS_PER_SWEEP_MAX);
    // …plus exactly one summary line so a storm is never silent.
    const summary = db
      .prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?")
      .get<{ payload_json: string }>(`incident_sweep_summary:${NOW}`);
    expect(summary).toBeDefined();
  });

  it("flap damping: a reopen inside the quiet window records the incident but sends no alert", () => {
    const [, b] = addDuplicatePair();
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    // Fix it → next sweep resolves.
    store.cancelScheduledTask(b!.schedule_id, NOW);
    const t1 = new Date(Date.parse(NOW) + INVARIANT_SWEEP_INTERVAL_MS + 1000).toISOString();
    runInvariantSweep({ store, now: t1, env: ARMED, chat_id: "555" });
    expect(store.listOpenIncidents()).toEqual([]);

    // It breaks again immediately (inside the quiet window) → row reopens, alert suppressed.
    store.addScheduledTask({
      chat_id: "555",
      goal: "AI周报",
      spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
      tz: "Australia/Sydney",
      next_run_at: "2099-01-01T00:00:00.000Z",
      now: t1
    });
    const t2 = new Date(Date.parse(t1) + INVARIANT_SWEEP_INTERVAL_MS + 1000).toISOString();
    const third = runInvariantSweep({ store, now: t2, env: ARMED, chat_id: "555" });
    expect(third.opened).toBe(1);
    expect(third.alerts_suppressed).toBe(1);
    expect(store.listOpenIncidents().length).toBe(1);
    const db = (store as unknown as {
      db: { prepare(sql: string): { all<T>(...v: unknown[]): T[] } };
    }).db;
    // Still only the FIRST open's alert exists — the reopen added none.
    expect(
      db.prepare("SELECT idempotency_key FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'")
        .all<{ idempotency_key: string }>().length
    ).toBe(1);
  });

  it("buildIncidentOpenedText names the kind and subject (code-rendered, never model text)", () => {
    const text = buildIncidentOpenedText("duplicate_schedule", "sch_abc", { duplicate_count: 2 });
    expect(text).toContain("duplicate_schedule");
    expect(text).toContain("sch_abc");
  });
});
```

NOTE ON THE NOTIFICATION ASSERTION: this repo has no `listNotificationsForTest` helper. Before writing this file, open `tests/run/daemon-heartbeat.test.ts` and `tests/budget/metered-ceiling.test.ts` and copy whichever accessor those tests use to read the outbox (the metered-ceiling test asserts a single enqueue on transition — the exact pattern needed here). Replace the `listNotificationsForTest?.()` line with that accessor and assert `length === 1` plus that the payload text equals `buildIncidentOpenedText(...)`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/run/invariant-sweep.test.ts`
Expected: FAIL — cannot resolve `../../src/run/invariant-sweep.js`

- [ ] **Step 3: Implement the sweep**

Create `src/run/invariant-sweep.ts`:

```ts
import { createLedgerEvent } from "./run-ledger.js";
import type { RunStore } from "./run-store.js";

/**
 * The invariant sweep (introspection slice A, ADR 0024): Houge's deterministic self-sensing
 * organ. Every cycle it reads its OWN flight recorder — schedules, runs, the outbox, the
 * heartbeat — and turns violations into durable incidents with an open/resolve lifecycle.
 *
 * Deliberately the least-privileged component in the system: pure SQL reads plus incident
 * bookkeeping. No LLM, no capability, no run creation. It cannot act on what it finds — the
 * worst case of a bug here is a wrong row and a wrong Telegram line, never a wrong ACTION.
 * That is what makes it safe to run unattended on every poll cycle.
 */

/** Minimum gap between sweeps — the poll loop ticks ~every 30s; six queries that often is waste. */
export const INVARIANT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** A run whose lease expired this long ago is stuck, not slow. */
export const STUCK_RUN_GRACE_MS = 10 * 60 * 1000;
/** An undelivered notification older than this is a delivery failure, not a queue delay. */
export const UNDELIVERED_NOTIFICATION_GRACE_MS = 15 * 60 * 1000;
/** A schedule this far past its cursor did not fire when it should have. */
export const OVERDUE_SCHEDULE_GRACE_MS = 15 * 60 * 1000;
/** A heartbeat older than this means the daemon was down and has just returned. */
export const HEARTBEAT_GAP_GRACE_MS = 10 * 60 * 1000;
/** Resolve notifications only for incidents that were open at least this long. */
export const INCIDENT_RESOLVE_NOTIFY_MIN_MS = 60 * 60 * 1000;
/**
 * Storm cap: one systemic failure trips many invariants at once (a broken outbox dispatcher
 * makes EVERY queued notification violate #3). Open every incident, but alert at most this
 * many per sweep plus one summary line. Incident rows are cheap; Paco's attention is not.
 */
export const INCIDENT_ALERTS_PER_SWEEP_MAX = 3;
/**
 * Flap damping: a condition oscillating around its threshold would open→resolve→reopen every
 * sweep. A reopen within this window of the previous resolve still creates the row (recurrence
 * must stay countable) but suppresses its alert.
 */
export const INCIDENT_REOPEN_QUIET_MS = 30 * 60 * 1000;

export type IncidentKind =
  | "duplicate_schedule"
  | "stuck_run"
  | "undelivered_notification"
  | "overdue_schedule"
  | "failed_schedule"
  | "heartbeat_gap";

export interface InvariantViolation {
  kind: IncidentKind;
  subject: string;
  detail: Record<string, unknown>;
}

export interface InvariantSweepResult {
  swept: boolean;
  opened: number;
  resolved: number;
  recurring: number;
  /** Incidents recorded but not alerted (storm cap or flap damping). */
  alerts_suppressed: number;
}

export function resolveInvariantSweepEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_INVARIANT_SWEEP_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function buildIncidentOpenedText(
  kind: string,
  subject: string,
  detail: Record<string, unknown>
): string {
  return `⚠️ Incident opened — ${kind} · ${subject}\n${JSON.stringify(detail)}`;
}

export function buildIncidentResolvedText(kind: string, subject: string, open_minutes: number): string {
  return `✓ Incident resolved — ${kind} · ${subject} (was open ${open_minutes} min)`;
}

export function buildSweepSummaryText(opened: number, suppressed: number): string {
  return `⚠️ Invariant sweep opened ${opened} incidents; ${suppressed} alert(s) suppressed (storm cap / flap damping). Inspect: SELECT * FROM incidents WHERE state='open'`;
}

/** Pure detection: compose the store's six invariant queries into a flat violation list. */
export function detectViolations(store: RunStore, now: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  for (const row of store.findDuplicateEnabledSchedules()) {
    violations.push({
      kind: "duplicate_schedule",
      subject: row.subject,
      detail: { duplicate_count: row.duplicate_count, schedule_ids: row.schedule_ids }
    });
  }
  for (const row of store.findStuckRuns(new Date(Date.parse(now) - STUCK_RUN_GRACE_MS).toISOString())) {
    violations.push({ kind: "stuck_run", subject: row.subject, detail: { state: row.state } });
  }
  for (const row of store.findUndeliveredNotifications(now, UNDELIVERED_NOTIFICATION_GRACE_MS)) {
    violations.push({
      kind: "undelivered_notification",
      subject: row.subject,
      detail: { intent_type: row.intent_type, attempt_count: row.attempt_count }
    });
  }
  for (const row of store.findOverdueSchedules(now, OVERDUE_SCHEDULE_GRACE_MS)) {
    violations.push({
      kind: "overdue_schedule",
      subject: row.subject,
      detail: { overdue_minutes: row.overdue_minutes }
    });
  }
  for (const row of store.findFailedSchedules()) {
    violations.push({
      kind: "failed_schedule",
      subject: row.subject,
      detail: { consecutive_failures: row.consecutive_failures }
    });
  }
  const gap = store.findHeartbeatGap(now, HEARTBEAT_GAP_GRACE_MS);
  if (gap) {
    violations.push({ kind: "heartbeat_gap", subject: gap.subject, detail: { gap_minutes: gap.gap_minutes } });
  }
  return violations;
}

export interface InvariantSweepInput {
  store: RunStore;
  now: string;
  env?: NodeJS.ProcessEnv | undefined;
  /** Telegram chat for alerts; omit and the sweep still records incidents silently. */
  chat_id?: string | undefined;
}

/**
 * One sweep: detect → open new / touch recurring → resolve cleared. Notifies ONLY on the
 * open transition (and on resolve for incidents that were open ≥ 1h), so a persistent
 * violation costs exactly one message no matter how many cycles it survives.
 */
export function runInvariantSweep(input: InvariantSweepInput): InvariantSweepResult {
  const env = input.env ?? process.env;
  const result: InvariantSweepResult = {
    swept: false,
    opened: 0,
    resolved: 0,
    recurring: 0,
    alerts_suppressed: 0
  };
  if (!resolveInvariantSweepEnabled(env)) return result;
  // The latch is claimed BEFORE detection on purpose: if detection throws, the daemon's
  // try/catch swallows it and the next sweep waits a full interval — a crash degrades to
  // "sweeps less often", never to "sweeps every 30s in a hot loop".
  if (!input.store.claimInvariantSweep(input.now, INVARIANT_SWEEP_INTERVAL_MS)) return result;
  result.swept = true;

  const violations = detectViolations(input.store, input.now);
  const seen = new Set<string>();
  let alertsSent = 0;

  for (const violation of violations) {
    const fingerprint = input.store.incidentFingerprint(violation.kind, violation.subject);
    seen.add(fingerprint);
    const existing = input.store.findOpenIncident(fingerprint);
    if (existing) {
      input.store.touchIncident(existing.incident_id, input.now);
      result.recurring += 1;
      continue;
    }
    // Flap damping: a reopen inside the quiet window records the row but stays silent.
    const flapping =
      input.store.findRecentlyResolvedIncident(
        fingerprint,
        new Date(Date.parse(input.now) - INCIDENT_REOPEN_QUIET_MS).toISOString()
      ) !== undefined;

    const opened = input.store.openIncident({
      kind: violation.kind,
      subject: violation.subject,
      detail: violation.detail,
      now: input.now
    });
    result.opened += 1;

    if (!input.chat_id || flapping) {
      if (flapping) result.alerts_suppressed += 1;
      continue;
    }
    // Storm cap: alert on the first N, then count the rest for one summary line.
    if (alertsSent >= INCIDENT_ALERTS_PER_SWEEP_MAX) {
      result.alerts_suppressed += 1;
      continue;
    }
    input.store.enqueueNotification({
      target: { kind: "telegram", chat_id: input.chat_id },
      intent_type: "progress",
      idempotency_key: `incident_opened:${opened.incident_id}`,
      correlation_id: opened.incident_id,
      payload: { text: buildIncidentOpenedText(violation.kind, violation.subject, violation.detail) }
    });
    alertsSent += 1;
  }

  // One summary line for everything the caps swallowed — silence about a storm would be worse
  // than the storm. Keyed on the sweep instant, so it is idempotent on replay.
  if (input.chat_id && result.alerts_suppressed > 0) {
    input.store.enqueueNotification({
      target: { kind: "telegram", chat_id: input.chat_id },
      intent_type: "progress",
      idempotency_key: `incident_sweep_summary:${input.now}`,
      correlation_id: `invariant-sweep:${input.now}`,
      payload: { text: buildSweepSummaryText(result.opened, result.alerts_suppressed) }
    });
  }

  for (const open of input.store.listOpenIncidents()) {
    if (seen.has(open.fingerprint)) continue;
    // resolveIncident appends the incident_resolved ledger event itself (store-side, so
    // redaction applies) — see Task 4b.
    if (!input.store.resolveIncident(open.incident_id, input.now)) continue;
    const open_minutes = Math.floor((Date.parse(input.now) - Date.parse(open.first_seen_at)) / 60000);
    if (input.chat_id && open_minutes * 60000 >= INCIDENT_RESOLVE_NOTIFY_MIN_MS) {
      input.store.enqueueNotification({
        target: { kind: "telegram", chat_id: input.chat_id },
        intent_type: "progress",
        idempotency_key: `incident_resolved:${open.incident_id}`,
        correlation_id: open.incident_id,
        payload: { text: buildIncidentResolvedText(open.kind, open.subject, open_minutes) }
      });
    }
    result.resolved += 1;
  }

  return result;
}
```

- [ ] **Step 4: Add the throttle latch to the store**

Only one helper is needed — the ledger appends live INSIDE `openIncident`/`resolveIncident` (Task 1 revision below), matching how `runWikiDecayTick` appends its own event from inside the store. Add to `src/run/run-store.ts` after the detection queries:

```ts
/**
 * Throttle latch for the invariant sweep: true at most once per `intervalMs`. Persisted
 * (not in-memory) so a daemon restart cannot turn a 5-minute cadence into a per-restart
 * storm. Same shape as the wiki/lesson decay latches.
 */
claimInvariantSweep(now: string, intervalMs: number): boolean {
  const row = this.db.prepare(`
    SELECT last_swept_at FROM invariant_sweep_state WHERE id = 1
  `).get<{ last_swept_at: string }>();
  if (row && Date.parse(now) - Date.parse(row.last_swept_at) < intervalMs) return false;
  this.db.prepare(`
    INSERT INTO invariant_sweep_state (id, last_swept_at) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_swept_at = excluded.last_swept_at
  `).run(now);
  return true;
}
```

- [ ] **Step 4b: Move the ledger appends into the store methods (revises Task 1)**

`this.appendLedgerEvent` (run-store.ts:687) is the store's own append — it also applies redaction, which is why system events are written from inside the store, never from a caller. Extend the Task 1 methods:

In `openIncident`, immediately before `return this.getIncident(incident_id)!;`:

```ts
  this.appendLedgerEvent(
    createLedgerEvent({
      correlation_id: incident_id,
      event_type: "incident_opened",
      actor: "system",
      sequence: this.nextLedgerSequence(),
      payload: { incident_id, kind: input.kind, subject: input.subject }
    })
  );
```

In `resolveIncident`, replace the body's final `return result.changes === 1;` with:

```ts
  if (result.changes !== 1) return false;
  const row = this.getIncident(incident_id)!;
  this.appendLedgerEvent(
    createLedgerEvent({
      correlation_id: incident_id,
      event_type: "incident_resolved",
      actor: "system",
      sequence: this.nextLedgerSequence(),
      payload: {
        incident_id,
        kind: row.kind,
        subject: row.subject,
        open_minutes: Math.floor((Date.parse(now) - Date.parse(row.first_seen_at)) / 60000)
      }
    })
  );
  return true;
```

`createLedgerEvent` is already imported in run-store.ts (line 27 imports `appendLedgerEvent`; add `createLedgerEvent` to that same import if not already present — the wiki decay tick at line ~2612 uses it, so it is).

Consequently the sweep module does NOT append ledger events itself: delete the two `appendSystemLedgerEvent(...)` blocks from the Step 3 code and the `createLedgerEvent` import at the top of `invariant-sweep.ts`. The sweep keeps only detection, lifecycle calls, and notifications.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/run/invariant-sweep.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add src/run/invariant-sweep.ts src/run/run-store.ts tests/run/invariant-sweep.test.ts
git commit -m "feat(introspection): invariant sweep — detect, open/recur/resolve, alert once per transition"
```

---

### Task 5: Wire the sweep into the daemon signal path

**Scope note (decided during plan self-review):** a `/incidents` list command was cut from Slice A. It would need a new `TelegramCommand` member, a new event type through `telegram-trigger-adapter.ts`, a gateway control-command handler, and its own idempotency plumbing — four files of surface, when the push-on-open alert already delivers Slice A's entire thesis ("tell Paco when something breaks"). The list view lands in Slice B alongside the retro digest, which is where reading *history* actually matters. Until then, `sqlite3 houge.sqlite "SELECT * FROM incidents WHERE state='open'"` is the inspection path.

**Files:**
- Modify: `src/telegram/telegram-daemon.ts` (inside `runSignalPathTick`, ~line 274-340)

- [ ] **Step 1: Add the tick call**

In `runSignalPathTick`, immediately AFTER the `maybeFireScheduledTasks(...)` call (~line 332) and before `checkMeteredCeiling`:

```ts
  // Introspection slice A (ADR 0024): the deterministic self-sensing sweep. Runs LAST among
  // the state-changing ticks so it observes this cycle's work, and is self-throttled to 5 min.
  runInvariantSweep({
    store: options.store,
    now,
    ...(chat ? { chat_id: chat } : {})
  });
```

Use whatever local variable already holds the chat id in that function (the session-rating call above it uses one — reuse that exact name; if it is scoped inside an `if (chat)` block, place this call there too). Add the import at the top of the file:

```ts
import { runInvariantSweep } from "../run/invariant-sweep.js";
```

The whole tick body is already wrapped in a try/catch that logs and never rethrows, so a sweep bug cannot stop the daemon — no extra guard needed.

- [ ] **Step 2: Verify the daemon still builds and the signal-path tests pass**

Run: `npm run build && npx vitest run tests/run/signal-path.test.ts tests/run/invariant-sweep.test.ts`
Expected: build clean; both suites PASS. (`signal-path.test.ts` covers the tick block being modified — if it constructs a daemon options object, the sweep call must not require any new option.)

- [ ] **Step 3: Commit**

```bash
git add src/telegram/telegram-daemon.ts
git commit -m "feat(introspection): invariant sweep rides the daemon signal path"
```

---

### Task 6: ADR 0024 + full sweep + arm

**Files:**
- Create: `docs/decisions/0024-introspection-invariant-sweep.md`

- [ ] **Step 1: Write the ADR**

Create `docs/decisions/0024-introspection-invariant-sweep.md`:

```markdown
# ADR 0024: Introspection — the invariant sweep as Houge's first self-sensing organ

- **Status:** accepted
- **Date:** 2026-07-20
- **Deciders:** Paco
- **Relates to:** implements the missing **sense** stage of [ADR 0012](0012-self-evolution-spine-closed-loop.md)

## Context

ADR 0012 built the self-evolution spine as `sense → remember → change → evaluate → keep/rollback
→ consolidate`, and shipped four memory types (lessons, skills, wiki, episodic facts). All four
store **content** — what was said, learned, known. None reads the **behavioral** record:
`ledger_events`, `runs`, `scheduled_tasks`, `notification_outbox`. That record is complete and
timestamped, and it was write-only: Houge could not answer "what did I do yesterday, and was it
right?"

Three behavioral bugs in the week of 2026-07-14 were each found by Paco running SQL by hand:
a duplicate schedule row, a promise acknowledged in chat but never persisted, and an ordinal
follow-up that executed against the wrong item. None was discoverable from conversation content.

ADR 0012 argued the eval loop lives or dies on an **executable verifier**, and that conversation
has none. The insight this ADR adds: **behavior does.** DB state is mechanically checkable —
"no two identical enabled schedules", "an active run holds a live lease" are SQL assertions, not
LLM judgments. The behavioral domain is therefore the cheapest place to close the loop
autonomously, and it was the one place nothing had been built.

## Decision

Ship a deterministic, zero-LLM **invariant sweep** as a periodic tick on the existing signal
path, with a durable incident store.

- **Six invariants** (duplicate schedules, stuck runs, undelivered notifications, overdue
  schedules, failed schedules, heartbeat gaps), each motivated by a real or latent failure.
- **Incidents are stateful, not events:** fingerprint `kind:subject`; first detection opens and
  notifies, later detections bump a counter silently, a clean sweep resolves. Rows are never
  deleted; a recurrence after resolution opens a new row so recurrence stays countable.
- **One alert per transition**, never per cycle. Resolve alerts only for incidents open ≥ 1h.
- **Two damping rules, both from the spec review, both about protecting Paco's attention rather
  than the database.** (a) *Storm cap:* one systemic failure trips many invariants at once — a
  broken outbox dispatcher makes every queued notification violate the delivery invariant — so
  the sweep records all incidents but alerts at most 3 per sweep plus one summary line. A monitor
  that spams during an outage gets muted, and a muted monitor is worse than none. (b) *Flap
  damping:* a condition oscillating at its threshold reopens legitimately, but a reopen within
  30 minutes of the previous resolve is recorded silently. In both cases the ledger and the
  incident rows stay complete; only the human channel is throttled.
- **Least privilege by construction:** pure SQL reads plus incident bookkeeping. No LLM, no
  capability, no run creation. The sweep cannot act on what it finds — the worst case of a bug
  is a wrong row and a wrong Telegram line, never a wrong action. This is what makes it safe to
  run unattended every cycle.
- **`waiting_for_approval` runs are never incidents.** A run parked on Paco's `/approve` is the
  system working correctly; alerting would make the sweep noisiest exactly when Paco is slowest,
  training him to ignore it.
- **Flag `HOUGE_INVARIANT_SWEEP_ENABLED`, default OFF**, and deliberately **NOT** in
  `DISARM_FLAGS`: that list covers flags granting *autonomous action* (self-write, codex, skills,
  scheduler, extwork, bounty); passive memory is already excluded. Disarming Houge must not
  blind him — a disarmed agent is when Paco most wants to know something is wrong.

## Consequences

- Houge gains the sense stage: he can now detect a class of his own failures without Paco.
- The incident store is the substrate the judgment half needs — Slice B (promise-vs-action
  diffing, plan-vs-execution divergence, refusal clustering, the incident → `self_diagnose` →
  regression-tested self-write bridge) writes into the same table.
- Cost: six indexed SQL queries per 5 minutes. No LLM spend.
- **Deferred deliberately:** the LLM retro digest, the promise ledger, an `/incidents` list
  command, and automatic incident→fix escalation. Per ADR 0012's own thin-slice doctrine, the
  deterministic verifier ships first and must earn the judgment layer by proving the incident
  shape is right. Until the list view exists, incidents are inspected with SQL.
- **Known limitation:** the sweep only sees what the flight recorder records. A failure that
  leaves no DB trace — a wrong answer, a misread instruction — is invisible to Slice A by
  construction. That class is exactly what Slice B's judgment pass targets, and it is the
  reason Slice A is a floor, not a ceiling.
```

- [ ] **Step 2: Build + full suite**

Run: `npm run build && npx vitest run`
Expected: build clean; full suite green (baseline 1684 tests; expect ~1705 with the additions — the count grows, never shrinks). If a pre-existing test fails, STOP and report rather than editing it, unless the failure is an intentional behavior change this plan caused — in which case document the reason in the commit, as the scheduler-v2 Probe 1 rewrite did.

- [ ] **Step 3: Commit and push**

```bash
git add docs/decisions/0024-introspection-invariant-sweep.md
git commit -m "docs(adr-0024): introspection — the invariant sweep as Houge's sense stage"
git push origin main
```

- [ ] **Step 4: Arm and reload (deploy)**

Add `HOUGE_INVARIANT_SWEEP_ENABLED=true` to `.env` on the mini, then:

```bash
launchctl kickstart -k gui/501/com.houge.daemon
```

- [ ] **Step 5: Verify live**

1. Heartbeat advances within 2 minutes: `sqlite3 houge.sqlite "SELECT last_success_at FROM daemon_heartbeat"`.
2. The sweep latch stamps within ~5 minutes: `sqlite3 houge.sqlite "SELECT * FROM invariant_sweep_state"`.
3. No incidents opened on a clean DB: `sqlite3 houge.sqlite "SELECT COUNT(*) FROM incidents"` returns 0 (the live DB is clean as of 2026-07-20 — a non-zero count on day one means a real finding, so read the rows before assuming a bug).
4. Deliberate live gate: create a duplicate schedule by hand
   (`INSERT INTO scheduled_tasks …` copying an enabled row), wait one sweep interval, confirm the
   Telegram alert arrives exactly once and `/incidents` lists it; then disable the copy and
   confirm the incident resolves.

---

## Post-ship success criterion

The north-star metric for the sense track: **the first incident Houge reports before Paco
notices it.** Until that happens, the sweep is unproven infrastructure — not a closed loop.
