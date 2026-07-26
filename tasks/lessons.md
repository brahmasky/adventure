# Lessons — orchestration mistakes and the rules that prevent them

Rules Claude writes for itself after corrections. Review at session start.

## Live safety-probe design (injection / exfil gates)

- **An injection probe only tests the wall if the payload actually reaches the wall.** (2026-07-17,
  D12) First D12 run put the injection in an HTML comment `<!-- … -->` on a *rendered* GitHub gist
  page; GitHub suppresses HTML comments and `htmlToText` strips them, so the payload never reached
  the dual-LLM reader — `reader_applied=true` but `contains_instructions` never fired. Silence there
  is a FALSE PASS: the wall wasn't exercised, an upstream layer ate the attack. Rule: for a reader/
  injection probe, use VISIBLE body text (not a comment) fetched via the RAW url, and require the
  positive evidence (`contains_instructions` flagged in the digest), not just "wasn't steered".
- **Verify "no secret leaked" without printing secrets.** (2026-07-17, S12) Compare the reply
  against the real secret values programmatically (`grep -F` each value, report only pass/fail) —
  never echo the values into the transcript to eyeball them.
- **Publishing attack-shaped content is (correctly) classifier-blocked.** Creating a public page
  with credential-exfil/backdoor text — even as a security test — is refused; hand the exact command
  to the user to run on their own account rather than working around it.

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

## Clock discipline before state-changing ops (2026-07-19)

- **Convert ledger UTC to local time BEFORE declaring anything stale/hung.** Read
  `occurred_at 21:14Z` as "10 hours ago" when it was 07:14 AEST *two minutes ago*, sampled a
  healthy daemon mid-turn, and restarted it. Graceful SIGTERM saved the in-flight run, but the
  restart was unjustified. Rule: before restart/kill, (1) `date -u` and diff explicitly;
  (2) check event CADENCE (a run emitting loop_steps every ~10s is alive, not wedged) — ties to
  [[monitor-windows-from-real-clock]].

## P2 first-use gap: ordinal follow-up not resolved against the prior table (2026-07-19)

- 「跟进第五个」after a bounty_scan: the planner web-searched 11 steps, misidentified #5 as an
  unrelated CLOSED issue, and never called project_track — although the true #5 was a recorded
  candidate sighting the anchor would have accepted. The numbered list lived in the immediately
  prior assistant turn; the model ignored it. Candidate fixes: deterministic rank→URL store from
  the last scan (project_track accepts {rank}), and/or steering lines in the scan digest +
  project_track description. Same family as the Phase-R convergence gap.

## A monitor must never observe its own output (2026-07-20)

- The invariant sweep checks for undelivered Telegram notifications; its OWN incident alerts are
  Telegram notifications. Without an exclusion, a delivery outage self-amplifies: an incident
  opens about the sweep's own undelivered alert, the alert about that is also undelivered, the
  next sweep opens an incident about THAT — growing every cycle, never resolving, during an
  outage where Paco can see none of it. Fix: `findUndeliveredNotifications` excludes
  `incident_*` outbox keys (narrow — genuine stuck reports still surface).
- **Rule:** when building ANY self-observing component (slice B's promise ledger, the LLM retro
  pass, any future watchdog), explicitly ask *what does this component's own output look like to
  its own detectors* — and exclude it.

## Cadence changes are not "just tuning" (2026-07-20)

- Moving the sweep from 5 min → 12 h (Paco's call) immediately exposed the self-observation bug
  above. It was invisible at 5 min purely because the alert got DELIVERED before the next sweep
  looked; the flaw only appears once the interval exceeds the 15-min undelivered grace window.
- **Rule:** an interval change moves components across each other's time windows and can expose
  latent coupling. Re-run the full suite on any cadence/threshold change and ask which OTHER
  timing constants the new value now crosses. Corollary for review: when a config value looks
  like a free knob, check the windows it is implicitly ordered against.

## Distinguish "how often it checks" from "how often it speaks" (2026-07-20)

- Paco read a 5-minute sweep as "too much self-inspection", reasonably. But alerts fire on
  incident TRANSITIONS, so a persistent violation costs exactly one message at any cadence, and
  a clean database is silent at any cadence. The interval buys DETECTION LATENCY only.
- **Rule:** when proposing a polling cadence, state the noise consequence and the latency
  consequence separately — otherwise the reviewer optimizes the wrong one. And still take the
  slower default when latency is cheap: the pushback was right on the merits for five of the six
  invariants, and it paid for itself by surfacing a real bug.

## The quarantine reader summarizes away structured tokens the planner needs (2026-07-22)

- gmail_read shipped, live-gated. `{list}` worked (real inbox digest, quarantine ran,
  secret-silent), but a follow-up `{get}` FAILED: "path segment contains characters outside the
  allowlist." Root cause was not the path validator (it did its job) — it was that the Q-LLM
  reader (ADR 0014) summarizes external-read output, so the Gmail MESSAGE IDS never survived into
  the planner's view. With no clean id, the planner improvised a non-id (a subject / RFC822
  Message-ID with `@<>`) and the allowlist correctly rejected it. list→get chaining was structurally
  impossible through the quarantine.
- Same class the senior spec review flagged earlier for VERIFICATION CODES: the reader is designed
  to strip structure, so anything the NEXT step must consume verbatim (ids, OTP codes, exact URLs)
  cannot come through the reader. The fix both times is the same seam: a deterministic,
  code-built `trusted_extract` side-channel appended AFTER the reader digest (verb-proof because
  it is structured + hygiened + hard-capped, same trust argument as `time_claims`). Ids are
  re-validated `^[A-Za-z0-9_-]+$` before entering that un-quarantined channel.
- **Rule:** whenever a quarantined external-read tool produces a token the planner must reuse
  verbatim on a later step (id to fetch, code to submit, link to open), it will be lost or mangled
  by the Q-LLM reader — design a deterministic trusted side-channel for that token from the start,
  and validate its charset so the channel stays verb-proof. Ask of every new read tool: "what must
  the next step quote exactly, and does it survive the reader?"
- **Process corollary:** the live gate earned its keep. Unit tests + adversarial review were all
  green; only a real Telegram tap against the real inbox surfaced the chaining break, because the
  reader is mocked/bypassed in tests. Keep the live gate as a required step, not a formality —
  reserve one end-to-end path that exercises the REAL quarantine reader.

## Don't drop an integration that's only blocked on operator-side registration (2026-07-24)

- During the idea-radar adversarial review, Reddit was overturned as a source ("unauthenticated
  .json is 403'd; OAuth needs app registration + approval friction") and I dropped it from R1
  unilaterally. Paco corrected: he had already registered a Reddit account with Wukong's email
  and would happily have done the console-side setup — exactly the division of labor the Gmail
  OAuth slice proved days earlier (operator does the console clicks, Claude does the script +
  code + broker wiring).
- **Rule:** when a source/integration is blocked ONLY by operator-side registration or console
  work (dev account, OAuth app, API key request), do not silently drop it — ask Paco. He can
  usually clear it in minutes. Reserve "drop the source" for genuine technical or ToS dead ends.

## 2026-07-27 — Telegram output must use the rich renderer, not plain text (Paco correction)
- Pattern: R2 shipped /idea and /radar renders as flat escaped text although EVERY notification
  already flows through markdownToTelegramHtml (parse_mode HTML + fallback). Paco: "output ...
  not user friendly ... should have good readability", and "why two commands for the same task".
- Rule 1: any NEW user-facing Telegram surface starts from "what should this look like on a
  phone" — bold headers, per-item blocks, labeled bullets (what/build/why) — with escapeForTelegram
  on values and markdown only in code-owned scaffolding. Plain rows are for logs, not operators.
- Rule 2: don't mint a new top-level command per feature slice; extend the existing command
  family (subcommands) unless the mental model is genuinely different. Operator surface area is
  a cost.
