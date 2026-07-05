# Lessons — orchestration mistakes and the rules that prevent them

Rules Claude writes for itself after corrections. Review at session start.

## Monitors / background watches

- **Compute watch windows from the real clock, never eyeball a timestamp.** (2026-07-04, Paco:
  "looks like your monitor didn't pick it up automatically?") A ledger watch was armed with a
  hardcoded `occurred_at > 04:00` boundary while the actual clock was ~03:30 — the awaited
  `self_write_published` (03:31) fell inside the excluded gap and the monitor waited forever on an
  event that had already happened. Rule: derive boundaries with `date -u` at arm time, AND make the
  watch's first iteration able to see an event that fired *before* arming (query from a boundary in
  the past, or explicitly check current state at arm time). A monitor that can't detect
  "already done" reports silence, and silence looks like "still waiting".
- **The user often completes interactive circuits faster than the watch cycle.** Twice on
  2026-07-04 Paco finished send→merge→reload before the orchestrator noticed. Verify current state
  FIRST (git log, ledger tail) before telling the user what to do next.

## Interactive /goal gates — don't read hook re-fires as "user gone"

- **Repeated Stop-hook fires ≠ user idle/away.** (2026-07-05, Paco: "why do you want me to clear the
  goal while am still testing even am idle?") A /goal's live Telegram gate blocked the Stop hook; the
  hook re-fired several times while Paco was actively running G1/G2 on his phone — I misread the
  silence *in the Claude session* as "user away" and repeatedly nudged `/goal clear`. He was mid-test
  the whole time. Rule: when a live/interactive gate is pending AND the daemon processes messages,
  CHECK the ledger / chat_turns for in-flight user activity (new run_created, new chat_turns) BEFORE
  concluding the user is idle or recommending they abandon the gate. The evidence is one query away —
  the daemon writes every user turn. Ties to [[goal-interactive-gate-no-idle-loop]] and
  [[monitor-windows-from-real-clock]] (verify current state before instructing/nudging the user).
- **Watch the right channel.** The user completing an interactive gate does so on THEIR surface
  (Telegram), not by typing to me. Poll the ledger and REPORT findings per turn (what passed, honestly
  labelled) rather than pinging "send it whenever" — that's the support the gate actually needs.

## Hermeticity (recorded in memory, repeated here)

- Non-hermetic tests (asserting env-var defaults without deleting the var) silently red-fail
  Houge's self-write test-gate and block ALL self-writes. Every new env var gets pinned in
  default-asserting suites (the PINNED_ENV pattern).

## Test design for a self-evolving agent

- **Never pin a code-owned user-facing string as a test literal** — existing tests are immutable
  to self-writes, so a pinned literal makes that string permanently un-self-writable (2026-07-03:
  Houge's header rename was structurally impossible until the literal moved behind an exported
  constant). Assert via exported constants.
