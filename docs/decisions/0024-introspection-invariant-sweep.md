# ADR 0024: Introspection — the invariant sweep as Houge's first self-sensing organ

- **Status:** accepted
- **Date:** 2026-07-20
- **Deciders:** Paco
- **Relates to:** implements the missing **sense** stage of [ADR 0012](0012-self-evolution-spine-closed-loop.md)

## Context

[ADR 0012](0012-self-evolution-spine-closed-loop.md) framed self-evolution as a closed loop —
`sense → remember → change → EVALUATE → keep/rollback → consolidate` — and shipped four memory
types (lessons, skills, wiki, episodic facts). All four store **content**: what was said,
learned, known. None reads the **behavioral** record — `ledger_events`, `runs`,
`scheduled_tasks`, `notification_outbox`. That record is complete and timestamped, and it was
write-only. Houge could not answer *"what did I do yesterday, and was it right?"*

Three behavioral failures in the week of 2026-07-14 were each found by Paco running SQL by hand:

1. A scheduled run misread its own replayed goal and created a **duplicate schedule** — a state
   anomaly invisible in conversation content.
2. A promise made in chat ("以后加上悉尼AI工作机会") that was **never persisted** anywhere — a
   divergence between what Houge said and what Houge did.
3. A 「跟进第五个」follow-up that **executed against the wrong item** — a divergence between the
   plan Houge stated and the action he took.

ADR 0012 argued the eval loop lives or dies on an **executable verifier**, and observed that
conversation has none — which is why its first cut leaned on explicit human ratings. The insight
this ADR adds: **behavior does have one.** DB state is mechanically checkable. "No two identical
enabled schedules", "an active run holds a live lease", "queued notifications get delivered" are
SQL assertions, not LLM judgments. The behavioral domain is therefore the *cheapest* place to
close the loop autonomously — and it was the one place nothing had been built.

## Decision

Ship a deterministic, zero-LLM **invariant sweep** as a periodic tick on the existing signal
path, backed by a durable incident store.

- **Six invariants**, each motivated by a real or latent failure: duplicate enabled schedules,
  stuck runs, undelivered notifications, overdue schedules, failed schedules, heartbeat gaps.
- **Incidents are stateful, not events.** Fingerprint `kind:subject`; first detection opens a
  row and alerts, later detections bump a counter silently, a clean sweep resolves the row.
  Rows are never deleted, and a recurrence after resolution opens a **new** row so recurrence
  stays countable — the substrate a future pattern layer needs.
- **One alert per transition**, never per cycle. Resolve alerts only for incidents open ≥ 1 h.
- **Two damping rules**, both added by the spec review, both about protecting Paco's attention
  rather than the database:
  - *Storm cap* — one systemic failure trips many invariants at once (a broken outbox
    dispatcher makes **every** queued notification violate the delivery invariant). The sweep
    records all incidents but alerts at most 3 per sweep plus one summary line. A monitor that
    spams during an outage gets muted, and a muted monitor is worse than none.
  - *Flap damping* — a condition oscillating at its threshold reopens legitimately, but a
    reopen within 30 min of the previous resolve is recorded silently.
  In both cases the ledger and incident rows stay complete; only the human channel is throttled.
- **`waiting_for_approval` runs are never incidents.** A run parked on Paco's `/approve` is the
  system working correctly; alerting would make the sweep noisiest exactly when Paco is slowest
  to respond, training him to ignore it.
- **Least privilege by construction.** Pure SQL reads plus incident bookkeeping: no LLM, no
  capability, no run creation. The sweep cannot act on what it finds — the worst case of a bug
  here is a wrong row and a wrong Telegram line, never a wrong **action**. That is what makes it
  safe to run unattended every cycle. It composes with the ADR 0017-amendment provenance strip:
  introspection is read-only by construction at both layers.
- **Flag `HOUGE_INVARIANT_SWEEP_ENABLED`, default OFF**, and deliberately **NOT** added to
  `DISARM_FLAGS`. That list covers flags granting *autonomous action* (self-write, codex,
  skills, scheduler, extwork, bounty); passive memory is already excluded. Disarming Houge must
  not blind him — a disarmed agent is precisely when Paco most wants to know something is wrong.
- **Cadence: twice a day by default** (`HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES`, default 720).
  The first cut used 5 minutes; Paco pushed back on 2026-07-20 and the slower cadence was
  adopted. The key fact behind the decision: **sweep frequency is decoupled from alert
  frequency** — alerts fire on incident *transitions*, so a persistent violation costs exactly
  one message at any cadence and a clean database is silent at any cadence. What the interval
  actually buys is detection latency. Twice a day fits the retro-style invariants; the override
  exists because `stuck_run` (Houge silently not doing something Paco asked) is the one class
  where hours of latency has a real cost.
- **The sweep never observes its own output.** `findUndeliveredNotifications` excludes
  `incident_*` outbox keys. Without that exclusion a Telegram delivery outage is
  self-amplifying: the sweep opens an incident about its own undelivered alert, the alert about
  that is also undelivered, and the next sweep opens an incident about THAT — a pile that grows
  every cycle and never resolves. The exclusion is narrow (own alerts only): a genuinely stuck
  run report still surfaces. This flaw was invisible at 5-minute cadence and only appeared once
  the interval exceeded the undelivered-notification grace window — the cadence change paid for
  itself immediately.
- **Latch before detection.** The throttle is claimed *before* the queries run, so a detection
  crash degrades to "sweeps less often", never to a hot loop.

### Amendment 2026-09-06 — `heartbeat_gap` is park-aware

The heartbeat-gap invariant conflated two silences: a crash and a deliberate `/kill` park (ADR
0018). Both stop the heartbeat; only one is an incident. Since the tombstone is gone by the
time the daemon is back, the sweep now consults the park marker the parked process leaves
behind (`houge.parked`): with the marker present the gap is logged (`[invariant-sweep] heartbeat
gap of N min spans a deliberate park`) and no incident opens; without it, behaviour is
unchanged. The marker suppresses ONLY the heartbeat gap — every other detector still runs.
See ADR 0018's amendment of the same date; commit b11f8ed.

## Consequences

- Houge gains the **sense** stage: he can detect a class of his own failures without Paco.
- The incident store is the substrate the judgment half needs. **Slice B** (deferred) writes
  into the same table: promise-vs-action diffing, plan-vs-execution divergence, refusal
  clustering, a daily LLM retro digest, an `/incidents` list view, and the
  incident → `self_diagnose` → regression-tested self-write bridge.
- Cost: six indexed SQL queries per 5 minutes. No LLM spend.
- **Known limitation:** the sweep only sees what the flight recorder records. A failure that
  leaves no DB trace — a wrong answer, a misread instruction — is invisible to Slice A by
  construction. Failure #2 and #3 above are in that class. Slice A closes the loop for #1 and
  makes the store exist; Slice B is what closes it for the rest. Slice A is a floor, not a
  ceiling.
- **Fingerprint caveat:** the duplicate-group subject is `MIN(schedule_id)` over the group —
  deterministic for a fixed group, but it shifts if membership changes, so flap damping does not
  span such a change. Per-row invariants use the row id and are stable.

## Success criterion

The north-star metric for the sense track: **the first incident Houge reports before Paco
notices it.** Until that happens, this is unproven infrastructure, not a closed loop.
