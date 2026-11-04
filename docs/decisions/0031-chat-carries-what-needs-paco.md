# ADR 0031: Chat carries what needs Paco; the change log carries the rest

- **Status:** accepted 2026-11-04, signed off by Paco (scope and decisions 1-A, 2-A, 3-A, 4-A approved by Paco 2026-11-03; spec approved 2026-11-03)
- **Date:** 2026-11-03
- **Deciders:** Paco
- **Amends:** [0024](0024-introspection-invariant-sweep.md) (sweep alerts), [0028](0028-omp-runtime.md) (model tiers, omp
  drift kinds), [0029](0029-jev-system-one.md) (`triage_overrides`), [0030](0030-decision-ladder.md) (decision-health kinds)
- **Spec:** [2026-11-03-chat-is-for-paco-design.md](../superpowers/specs/2026-11-03-chat-is-for-paco-design.md) (Rev 1.3)

## Context

Paco, 2026-11-03, on three `🔁 X now resolves to kimi-code/k3.1-pro` lines and an empty-tier card in his chat: *"treat the
telegram channel as end-user focus. What's happening in the background can be folded into /status or other system
command. But the audit trail / change log should always be there."* Every background notice (model re-resolution, internal
self-check incidents, routine Jev notices) was pushed to chat beside his replies, in operator words. The audit trail existed
in ledger rows but nothing read it back in plain words.

## Decision

1. **The rule.** A proactive message goes to chat only if Paco must act, or his answers, schedules or messages are
   affected now, or a locked rule says it reaches him. Everything else is recorded, not pushed.
2. **One router.** Every notification names a `topic` from a closed set; `TOPIC_ROUTE` (`src/notifications/topics.ts`)
   maps each topic to `chat` or `log`. A `log` notification becomes a `change_log` row instead of an outbox row. Leaving
   chat is what writes the log: nothing is dropped. A log write never depends on a chat being configured; flap damping
   applies to chat only.
3. **Incidents by kind.** `INCIDENT_ROUTE` (`src/run/incident-route.ts`) says, per kind, `page`, `card` (the caller's own
   card is the page) or `log`, with a plain-words line and, for pages, what to do. Both openers (`openAlertedIncident`, the
   sweep) and `RunStore.resolveIncident` read it. Subjects are masked (`a chat`, `a run`, `an approval`).
4. **An unknown kind pages.** A kind missing from the table pages with generic text and one stderr line: noisy, never
   silent. Kinds reaching an opener are typed against the table, so a new kind without a route is a compile error.
5. **The audit trail.** `change_log` is the record of what left chat. `/changes` lists the last 30 days in plain words
   (at most 20 rows, within Telegram's limit); `/status` counts paged and internal open incidents and changes this week.
6. **Locked rules unchanged.** Every Jev outage class still pages (AGENTS.md; ADR 0019; ADR 0029). Security controls
   failing open (`wall_collapsed`) and a failing lane (`lane_fallthrough_rate`) still page.

## Consequences

- Chat carries replies, run reports, approvals, memory cards, rating asks, the digest, idea panel, standing and
  improvement cards, self-write notices, budget fuses, a failing skill re-check (it asks for `/skills retire`) and real
  outages. Model switches, internal self-checks and routine Jev notices are read with `/changes`.
- Two messages for one event become one where an incident and its card both fired (`hostile_schedule_turn`).
- What else changed in code: a duplicate log write returns `duplicate_log` (no outbox record exists), not `duplicate`;
  an urgent card with no chat now throws instead of queueing an undeliverable row (`standing_grant` keeps "no grant
  without its card"; `trust_hostile` falls to `trust_card_failed`, which pages); `/models set` marks its override
  `via: "set"` so it is never read as a card tap; `/changes` collapses consecutive identical entries (`×N`).
- Residuals Paco accepts: background is visible only when he looks; a catalog outage and a stale static list left the daily
  reminder; an omp contract drift that degrades answers without failing spawns shows in `/status` and, after 7 days, in the
  reminder; rating asks stay in chat.
- Rollback: revert + rebuild. The previous build ignores `change_log` and sends background notices to chat again; after a
  tick that retired the card-tap override, its narrower gemini-pro pattern reopens `role_unresolved` for judges:2 and the
  card returns (a re-tap restores it).

## Alternatives considered

- **Silence at each call site and render the log from existing ledger rows** (1-B): less code, but a filter scattered over
  ~20 sites and some notices leave no row to rebuild from. Rejected.
- **Leave incidents alone this slice** (2-B): kept the noisiest operator texts in chat. Rejected.
- **Keep the empty-tier card, Gemini-only** (3-B): still asks Paco a question with one sensible answer. Rejected.
- **`/status changes` only** (4-B): `/changes` is the named command; `/status changes` is the same view (plan P1).
