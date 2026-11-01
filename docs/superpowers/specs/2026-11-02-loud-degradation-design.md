# Loud degradation — newest model per tier, reminders that repeat, trust carry with an exit (Rev 1.2)

**Status:** DRAFT Rev 1.2, awaiting Paco's tap (Decisions D1–D4).
- **Rev 1.2:** after codex's scoped re-review of Rev 1.1 (15 of 18 prior findings closed; 2 new blockers and 3
  warnings applied, §Rev 1.2 changes).
- **Rev 1.1:** after the senior review (claude-fable-5-1: 3 blockers, 12 warnings, 6 suggestions, 7 facts corrected)
  and the codex design pass (6 blockers, 2 warnings). Every finding was verified first-hand and applied or ruled on
  (§Rev 1.1 changes).
- The orchestrator is claude-opus-5-5, so neither review is same-model.

**Date:** 2026-11-02
**Amends:**
- **ADR 0028**, the 2026-10-07 model-roles amendment: code-owned *version* lists become code-owned *tiers*, and a new
  head is adopted only after a probe.
- **ADR 0030**, the 2026-10-13 stage 2a amendment: "trust is sticky per planner transcript … until the planner starts
  a fresh transcript" gains a command that starts one. A turn whose only hostile cause is a withheld passage carries
  `untrusted` (D2), and the standing-credit rule follows from that. `hostile_schedule_turn` becomes an event, and a
  carried one does not page (D3).

ADR 0027 is not amended, because a judge seat still never falls back inside a panel run (§4.1).
ROADMAP: this slice runs before remainder R5 (Paco, 2026-11-02).

**Depends on:**
- `2026-10-06-jev-decision-tree-design.md` §4–§4.2: roles, catalog, change notice, `/models`.
- `2026-10-12-decision-ladder-design.md` §7.1–§7.2: the injection judge and turn trust.
- `src/run/incident-alert.ts`: alerted incidents, which page once while open.

## 1. Goal

Three things degraded quietly in the last three weeks:

1. **A judge seat has been empty for three weeks.**
   - `google-antigravity/gemini-3.1-pro` left omp's catalog, so judge seat 2 has resolved to nothing since
     2026-10-13.
   - Every weekly idea shortlist since W42 ran with `judges_failed: ["gemini"]`; W41 was the last three-judge panel.
   - The incident paged once and has said nothing since.
2. **The conversation has carried a raised trust level with no exit for 19 days.**
   - It has carried `untrusted` since a `wall_read` on 2026-10-14 (run `cb399537`).
   - On 2026-10-30 a search passage scored 0.54 and was withheld, and the carry rose to `hostile`.
   - Since then every shell command Paco's turns run has asked for a tap. Two asks expired unanswered on 11-01, and the
     day's tap budget is spent (count 5 of 3).
3. **The same event paged on two later mornings.**
   - The 10-31 and 11-01 schedule turns carried `hostile` and each opened a new `hostile_schedule_turn`.
   - The incident's subject is the `run_id`, so the one-page throttle never matched and nothing closed them.

Paco's rule (2026-11-02): **always use the latest model under my subscriptions.** This slice makes that the code's
rule, makes an actionable incident repeat until it is fixed, and gives a carried trust level an exit.

## 2. Scope

**In:**
- **Part A:** tiers instead of version strings, a probe before adoption, and a tap card for an empty tier.
- **Part B:** a daily reminder of open actionable incidents; `hostile_schedule_turn` becomes an event.
- **Part C:** cause tracking in `TurnTrust`, the D2 carry rule, `/fresh`, a `/status` line, and D3.
- The idea panel records each judge's model id, so a model switch is visible in its rows.

**Out:**
- The injection judge and its bar (0.5), the hostile read-only allowlist, trust-card TTLs, and the tap budget's size
  and its date rollover. That rollover already resolves a past date at the first trust ask of a later date
  (`trust-ask.ts:54`).
- `clampEffort`, step-up, the retry rule, `ALLOWED_PROVIDERS`, the Codex exclusion for chat seats, and the three
  judges on three providers.
- The panel's single-model seats (`registry.ts:166 judgeSeat`, `idea-panel-seats.ts`).
- R5–R7.

## 3. Live facts (`main@e757ad1`; live DB read-only; omp catalog read 2026-11-02, by the author and the senior reviewer)

**Catalog vs lists.** 3 of the 10 distinct selectors in `model-roles.ts` are no longer in the catalog:

| Selector | Where it is listed | Effect today |
|---|---|---|
| `google-antigravity/gemini-3.1-pro` | judge seat 2 (`ROLE_LISTS`, `STATIC_ROLE_LISTS`) | `role_unresolved judges:2` open since 2026-10-13 02:01Z. `chains()` falls back to the static selector (`role-resolver.ts:95–101`), which omp rejects: probed, exit 1, stderr `Model "google-antigravity/gemini-3.1-pro" not found` |
| `google-antigravity/claude-opus-4-6` | the 3rd leg of Default, Thinking, Reviewer | dropped by resolution, one backup fewer |
| `openai-codex/gpt-5.5` | `STATIC_ROLE_LISTS`: judge seat 1, and the Reader's 3rd leg | In static mode (the rollback, the CLI, scripts), **judge seats 1 and 2 fail**; the Reader keeps two legs |

**Catalog ids per allowed provider** (newest first; previews and dated snapshots omitted):
- **`anthropic`:**
  - opus `5-5, 5, 4-8, 4-7, 4-6, 4-5, 4-1, 4-0`;
  - sonnet `5-5, 5, 4-6, 4-5, 4-0`;
  - haiku `5-5, 4-5`;
  - `claude-fable-5`, `-5-1` and `claude-mythos-5`, `-5-1` (tier unknown, D1).
- **`google-antigravity`:**
  - `gemini-3.8-flash`, `gemini-2.5-flash`;
  - flash-lite `3.5, 3.1, 2.5`;
  - **`gemini-4-argon`**: priced 2/10 against flash's 0.75/3.75, with a step to 4/20 from 2026-12-01. It is the pro
    tier under a codename; probed: `OK`, exit 0;
  - `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b`.
- **`openai-codex`:** `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, and
  `gpt-5.6-{sol,terra,luna}`.
- **`kimi-code`:** `k3.1-pro`, `k3.1-pro-highspeed`, `k3`, `k3-256k`, `kimi-for-coding`, `kimi-k2.5`, `kimi-k2`, …

The catalog has no release-date field, so "newest" comes from the version in the id. **The catalog is not the
subscription:** an unreachable model surfaces as `model_missing` at spawn.

**Repeated failure.** Exact version strings have broken Houge four times:
1. A retired planner string (SP1, `tasks/lessons.md:254`).
2. A pinned omp and voice model (`a49da40`).
3. A pinned Jev version (`c026e5c`).
4. This judge seat, five days after `b2dd3bd`.

**Trust.**
- `TurnTrust` keeps one monotone level. `raise()` returns early, with no row, when a cause does not raise the level
  (`trust.ts:39`).
- `bridge-handler.ts:539–542` can raise `injection_withheld` and then `unjudged_outside` or `judge_lost_outside` from
  the same result. Only the first leaves a trace.
- `endTrust` stores `trust.level()` into `planner_session_state.transcript_trust` (`planner-supervisor.ts:819–827`).
  `setTranscriptTrust` writes no timestamp (`run-store.ts:3137`).
- A turn skips the carry only when its child made the session reset (`resetGen`, in memory, `:338`, `:800`).
- That reset runs only on the **start** path, only when the lesson fingerprint differs (`:1147–1186`). It is committed
  at the first successful prompt (`commitReset`, `:789–793`).
- An idle child stays live between turns until `idleExitMs` (`:482–484`).
- On run `03c97105` (10-30): 5 `tool.injection` rows `pass` (p 0.03–0.07) and 1 `withhold` (p 0.54). No framed
  passage. The withheld passage was replaced by the code-owned `WITHHELD_TEXT` (`src/decisions/entries/tool-injection.ts:28`).
- **Standing credit:** none is earned while the transcript is `hostile` (`run-store.ts:6996`, ADR 0030 "Credit").

**Incidents.**
- `openAlertedIncident` pages once on the open transition and never again while the incident is open
  (`incident-alert.ts:28–37`). Nothing reminds Paco.
- Open today:
  - `role_unresolved judges:2`;
  - 3 × `hostile_schedule_turn`: `03c97105`, the turn that read the text, plus two carried;
  - `trust_tap_budget 2026-11-02`, today's date, live.
- The model-roles tick returns IDLE in static mode (`model-roles-tick.ts:26`). On a catalog outage it returns before
  any incident work (`:41`).

**Panel records.** `idea_panel_tick` and `radar_shortlists` name seats (`kimi`, `codex`, `gemini`), never model ids.

**Probe seams.**
- **The one-shot seat**, `src/llm/providers/omp.ts:30`: `--profile <p> -p --mode json --no-session --no-tools`, with
  the child env from `buildChildEnv` and TMPDIR from `childTmpRoot`. It classifies `model_missing`, `quota`, `auth`
  and the rest, and walks a chain on `model_missing` (`:165`).
- **The RPC contract probe** (`omp-contract-probe.ts`).

## 4. Part A — newest model per tier

### 4.1 Tiers

A **tier** is `{ id, provider, pattern }`. `pattern` is an anchored regex over the catalog `id`, with one capture
group per version segment. Code-owned, in `model-roles.ts`:

| Tier | Provider | Pattern | Head today |
|---|---|---|---|
| `opus@anthropic` | `anthropic` | `^claude-opus-(\d{1,2})(?:-(\d{1,2}))?$` | `claude-opus-5-5` |
| `opus@antigravity` | `google-antigravity` | same | `claude-opus-5-5` |
| `sonnet@anthropic` | `anthropic` | `^claude-sonnet-(\d{1,2})(?:-(\d{1,2}))?$` | `claude-sonnet-5-5` |
| `sonnet@antigravity` | `google-antigravity` | same | `claude-sonnet-5-5` |
| `gemini-flash` | `google-antigravity` | `^gemini-(\d{1,2})(?:\.(\d{1,2}))?-flash$` | `gemini-3.8-flash` |
| `gemini-pro` | `google-antigravity` | `^gemini-(\d{1,2})(?:\.(\d{1,2}))?-pro$` | **none** (§4.4) |
| `codex-sol` | `openai-codex` | `^gpt-(\d{1,2})(?:\.(\d{1,2}))?-sol$` | `gpt-6.1-sol` |
| `kimi` | `kimi-code` | D1 decides: `^k(\d{1,2})(?:\.(\d{1,2}))?$` (today's family) or `^k(\d{1,2})(?:\.(\d{1,2}))?(?:-pro)?$` | `k3` or `k3.1-pro` |

**Rules:**
- `\d{1,2}` keeps dated snapshots out (`claude-opus-4-20250514` does not match), and the anchors keep out `-lite`,
  `-highspeed`, `-256k` and `preview`.
- Versions compare segment by segment as integers, with a missing segment read as 0: `5` < `5-5`, `6` < `6.1` <
  `6.10`.
- Equal versions (`claude-opus-5` against a hypothetical `claude-opus-5-0`): the shorter id wins.
- A tier's family is the one today's list already runs (sol, not terra, luna or astra). A different family is Paco's
  call, either at D1 or through `/models`.

**Role legs.** Each role list becomes a list of `{ tier, effort }` legs in today's order, and each leg resolves to its
tier's **adopted head**, then its **previous adopted head** (§4.2). Duplicates drop as today, and the effort clamp
applies as today.
- Fast: `sonnet@anthropic:low`, `sonnet@antigravity:low`, `gemini-flash:low`.
- Default: `opus@anthropic:medium`, `opus@antigravity:medium`, `kimi:low`.
- Thinking: `opus@anthropic:high`, `opus@antigravity:high`, `kimi:high`.
- Reader: `gemini-flash:low`, `kimi:low`, `codex-sol:low`.
- Vision: `gemini-flash:low`.
- Tiny: `kimi:low`, `gemini-flash:low`.
- Chair: `opus@anthropic:low`.
- Reviewer: `kimi:high`, `opus@antigravity:medium`.
- Judges: seat 0 `kimi`, seat 1 `codex-sol`, seat 2 `gemini-pro`.
  - **A judge seat resolves to its tier's adopted head only, never a chain.** The panel's single-model seats and
    ADR 0027's seat binding stay as they are.
  - The fallback happens **between** panel runs, in the daily tick. When an adopted head leaves the catalog, the
    tick moves the tier to its previous adopted head, which was already probed. A retired judge model costs at most
    one day, not three weeks.

The seat count comes from the new role table, so `chains()`, `resolveAll()` and the panel cannot disagree (S1).
`/models` overrides work as today: the matched model goes ahead of the role's legs.

### 4.2 Check before adopting

**Seam.** The probe runs through the existing one-shot seat (`src/llm/providers/omp.ts`, unchanged): a one-leg chain,
`--no-session --no-tools`, the same child env, TMPDIR and timeout as a ticks seat, and the prompt `Reply with exactly
OK.` No new child path.
- **Call:** `oneShotAdapter(store, cfg, { chain: [selector], correlation_id, role: "probe" })` directly, not
  through `tickSeat`, which drops the failure class. A failure is classified with the existing
  `classifyOmpError` (`omp-frames.ts:68`, unchanged) over the adapter's error.
- **Pass:** the adapter returns `ok` with a non-empty reply. An exact `OK` match is not required, matching the
  contract probe.
- **Fail:** `model_missing`. The tier stays where it is. The selector is recorded as `rejected_selector` and
  `rejected_at` on the tier's `model_tiers` row, and is not probed again for 7 days.
- **Inconclusive:** `quota`, `auth`, `transport`, `timeout` or any other error. The tier stays where it is, and the
  probe runs again at the next tick.

**State.** A new table, `model_tiers`, holds `{tier, adopted, previous, adopted_at, rejected_selector, rejected_at}`. Probe outcomes are ledgered as
`model_probe` events, with `{selector, result}` and no output text.

**Tick order.** It replaces today's single await.
1. Read the catalog.
2. For each tier, compute its catalog head.
3. Probes run outside any transaction, one at a time, 60 s each, for:
   - every tier whose catalog head is not its adopted head;
   - every tier with no previous head, where the probe tries the catalog's next-newest below the adopted head.
4. Then, in one transaction:
   - write the probe events;
   - update `model_tiers`;
   - re-resolve every role;
   - record `model_roles_resolved`;
   - send the change notice: one line per moved role, plus "X failed its check; staying on Y" per failed probe, and
     "tier head X is available; your override Y is in place (`/models reset <key>`)" when an override shadows a newer
     head;
   - sync `role_unresolved`.

`RoleResolver` reads `model_tiers` from the store at each resolution, as it reads overrides today, so no restart is
needed. A stop signal aborts a running probe (its child is killed) and commits nothing.

**Bootstrap (W4).** The migration seeds `model_tiers` with today's known-good selectors: the `ROLE_LISTS` entries that
match each tier and ran yesterday. Seeded:
- `opus@*`: `claude-opus-5-5`;
- `sonnet@*`: `claude-sonnet-5-5`;
- `gemini-flash`: `gemini-3.8-flash`;
- `codex-sol`: `gpt-6.1-sol`;
- `kimi`: `k3`;
- `gemini-pro`: no adopted head.

With D1 widening Kimi, the first tick probes `k3.1-pro`. Boot resolution therefore never sees an empty table. The
first tick only probes heads that moved and fills the missing previous heads.

**Catalog outage.** It changes nothing: the adopted heads keep running, as under Decision 4 of ADR 0028's 2026-10-07
amendment.

### 4.3 Static rollback (D4)

`HOUGE_MODEL_ROLES=static` stays catalog-free: no reads, no probes.
- **At this ship,** `STATIC_ROLE_LISTS` is re-pinned to the seeded heads, and `gpt-5.5` is replaced by `gpt-6.1-sol`.
- **Judge seat 2 in static is empty.** Pinning `gemini-4-argon` there would adopt a codename without a tap. It is
  filled by a code re-pin after Paco's tap.
- **The stale check runs in resolved mode only.** After its catalog read, the tick checks each static selector. A
  missing one opens `static_list_stale` (subject = the selector), and the next check that finds it listed resolves it.
  This tells Paco the rollback is stale before he needs it. In static mode the tick does not run, by design.
- **A unit test** pins that every static selector matches its role's tier patterns.

### 4.4 An empty tier asks Paco

`gemini-pro` is empty today: Google lists its pro model as `gemini-4-argon`, which no pattern reads. For each empty
tier the tick sends one tap card a day:

> "Judges:2 has no model: Google's pro tier is empty. Use `gemini-4-argon`?"
> `[Use gemini-4-argon] [Not now]`

- **Proposals:** up to three of the same provider's catalog ids that match no tier, are not previews, and do not end
  in `-lite`. They are ordered by current output price, highest first, using the `timeBased.effectiveRates` entry in
  force when one exists.
- **A tap probes first** (§4.2), off the tap's path. Only a pass writes the `/models` override row: the same row
  `/models set judges 2 gemini-4-argon` writes, in the same transaction as the probe event. A failed or inconclusive
  probe answers on the card and writes nothing (codex B3, senior W5).
- **Silence** leaves `role_unresolved` open, and §5 reminds Paco.
- **Code never adopts a codename without a tap.**

## 5. Part B — reminders that repeat

- **The set.** `incident-alert.ts` gains `REMIND_KINDS`, a code-owned map from kind to action line:
  - `role_unresolved`: "tap the card, or `/models set <key> <pattern>`";
  - `static_list_stale`: "re-pin `STATIC_ROLE_LISTS`";
  - `model_catalog_unavailable`: "check `omp --profile houge models`";
  - `planner_session_reset_failed`: "send `/fresh`, or check the omp session dir".
- **Left out:**
  - `undelivered_notification` and any delivery-health kind: a reminder about undelivered alerts would multiply
    during an outage;
  - `trust_tap_budget`: it is per day and rolls over itself;
  - `omp_contract_drift` and `planner_no_leg`: each re-detects or pages on its own path.
- **Path (B3).** A once-a-day step in the daemon's tick loop, independent of the model-roles tick and of
  `HOUGE_MODEL_ROLES`. It runs in static mode and through a catalog outage.
- **It runs before the model ticks,** ahead of the await at `telegram-daemon.ts:515–538`. A slow or stopped model tick
  therefore cannot delay that day's reminder.
- **Message.** One message lists every open incident in the set that is older than 24 h, each with its age and action
  line. Its idempotency key is `incident_remind:<Sydney date>`, so it is sent at most once a day. The text is
  code-owned: kinds, subjects (role keys or selectors), ages; no tool bytes and no message text.
- **`hostile_schedule_turn` becomes an event** (`event: true`, resolved right after its page, like
  `turn_outside_planner`). At the first boot of this build, the open rows of that kind are resolved once by code.

## 6. Part C — trust carry with an exit

### 6.1 Cause tracking (B1)

- `TurnTrust` keeps the set of causes it was **asked** to raise, including those that did not raise the level.
- The level the transcript carries at turn end is the highest **carry level** over that set. A cause's carry level is
  its `CAUSE_LEVEL`, with one exception under D2-A: `injection_withheld` carries `untrusted`. So `carried_hostile`,
  `judge_lost_outside` and `unjudged_outside` all still carry `hostile`.
- Inside the turn nothing changes: the turn is `hostile` from the withhold to its end.
- `endTrust`'s `keepOld` rule for an uncommitted fresh transcript (`:826`) stays and compares carry levels.
- **Today's transcript is carried `hostile`,** so D2 alone never lowers it. `/fresh` is its exit.
- **Standing credit** follows the stored level, so after a withhold-only turn credit accrues again. Stated in the
  ADR 0030 amendment (W7).

### 6.2 `/fresh` (B2)

`/fresh` is a new Telegram command, Paco only, as every command is.
- **Persisted marker.** It writes `fresh_requested_at` (the request's instant) on the chat's `planner_session_state`,
  so a restart or a child exit cannot lose it.
- **Honoured at every start.** The reset decision on the start path honours the marker regardless of the lesson
  fingerprint: it calls `newSession()` and sets `resetGen`, as the lesson path does.
  - The supervisor also remembers which request this reset serves: `servedFresh` is set to the marker's value, in
    memory, bound to the child generation.
- **Its own commit condition.** `commitReset` clears `fresh_requested_at`, and stores `clean` with
  `transcript_trust_at`, only when the reset was made on that child **for that request**. In one transaction it checks
  `servedFresh` equals the stored `fresh_requested_at`.
  - A `/fresh` sent during a turn whose child had already reset for a lesson change is therefore not consumed by that
    commit; it stays pending for the next start.
  - The lesson fingerprint is promoted as today.
- **A failed manual reset never pretends.** Unlike the lesson path, a `/fresh` reset failure never degrades silently
  into "fresh".
  - The turn runs on the resumed old transcript, **with its carry**, so the trust level is not lowered.
  - The marker stays.
  - `planner_session_reset_failed` opens; it is in the reminder set.
  - The turn's reply is prefixed with a fixed line: "Could not start a fresh conversation; this reply continues the
    old one."
  - The lesson path's 3-strike degrade still applies to lesson resets only.
- **Idle live child.** If no turn is in flight, the supervisor stops the idle child now, so the next turn spawns and
  resets.
- **Turn in flight.** The flag waits: nothing is cancelled mid-turn, and the stop happens when the turn ends.
- **Reply:** "The next message starts a fresh conversation; the planner will not see earlier turns." The reset happens
  at the next start, so the reply does not claim it already has.
- **Until the commit,** `/status` still shows the carry. That is correct: the old transcript is still the one a
  respawn would resume.

### 6.3 `/status` line (W9)

A new column, `transcript_trust_at`, is written by `setTranscriptTrust`. `/status` shows one line when the stored level
is not `clean`:

> "Conversation carries <level> since <time> · /fresh clears it"

Existing rows have no time; the migration leaves it null and the line then omits "since <time>".

### 6.4 D3 — a carried-hostile schedule turn

Recommended (A): no page. The turn that read the text paged, now as an event (§5). Ledger rows are unchanged. A
schedule turn that itself raises `hostile` still pages.

## 7. What does not change

- Turn routing, step-up, retry and the effort clamp.
- The judge and its bar, the read-only allowlist, card TTLs and the tap budget.
- In-turn trust: the level only rises.
- `/models set` and `reset` semantics, and the one-shot seat's argv and classification.
- The panel's single-model seats and its quorum rules.
- The three judges on three providers, and the Codex exclusion for chat seats.

## 8. Tests

- **Tiers** against `tests/fixtures/omp-catalog-2026-11-02.json`, a trimmed copy of today's catalog with every
  allowed-provider entry:
  - each tier's head as in §4.1;
  - non-members per tier: `claude-opus-4-20250514`, `claude-opus-4-5-20251101`, `gemini-3.5-flash-lite`,
    `k3.1-pro-highspeed`, `k3-256k`, `kimi-k2-turbo-preview`, `gpt-6.1-terra`;
  - version order `5` < `5-5`, `6` < `6.1` < `6.10`, `3.8` > `2.5`, and the tie-break.
- **Probe:** pass adopts; `model_missing` keeps the tier and is not re-probed; inconclusive keeps it and retries; a
  catalog outage changes nothing; a stop mid-probe commits nothing. Effects are asserted as exact rows.
- **Retirement (the regression this slice exists for):** remove an adopted judge head from the fixture. The next tick
  moves the seat to the previous head. A seat with no previous head opens `role_unresolved` and its card.
- **Bootstrap:** a fresh migration seeds the heads listed in §4.2, and boot resolution matches today's lists, minus
  the three gone selectors.
- **Card:** one a day per empty tier; proposals ordered by price; a tap on a failing model writes no override; a tap
  on a passing model writes the override in the probe's transaction.
- **Static:** each selector matches its tier; a missing one opens `static_list_stale`, and its return resolves it.
- **Reminder:**
  - at most once a day;
  - only kinds in the set, only incidents older than 24 h;
  - runs with `HOUGE_MODEL_ROLES=static` and during a catalog outage;
  - never lists `undelivered_notification`.
- **Trust:**
  - withhold-only → `untrusted` stored;
  - the `:539/:540` double raise (withhold, then `unjudged_outside`) → `hostile`;
  - withhold, then `judge_lost_outside` → `hostile`;
  - a carried-hostile turn that withholds → `hostile`;
  - an uncommitted fresh transcript keeps the old level.
- **`/fresh`, four cases:**
  - idle child: the child stops and the next turn is fresh;
  - turn in flight: the turn is not cancelled and the next turn is fresh;
  - a daemon restart between `/fresh` and the next turn: still fresh;
  - a failed reset: the flag is kept and the incident opens.
  - Also: a `/fresh` during a turn whose child made a lesson reset stays pending past that turn's commit.
  - A failed manual reset: the turn is served on the old transcript with its carry, the fixed prefix is sent, and the
    marker stays.
  - In every case the marker clears only at a commit that serves it.
- **Incidents:** `hostile_schedule_turn` resolves after its page; the boot resolve runs once; a carried-hostile
  schedule turn pages nothing (D3-A).
- **Panel:** the panel tick payload carries each seat's model id.

## 9. Live gates (`.worktrees/` only, VACUUM copy of the live DB, stub `HOUGE_TELEGRAM_CHAT_ID`, tombstone pinned)

- **Part A, `scripts/live-gate-model-tiers.mjs`, using the real catalog and real probes through the one-shot seat.**
  - The seed resolves every role and seat to a head except `judges:2`, whose tier is seeded empty. PASS fails on any
    other key without a head, which is the silent case.
  - `judges:2` with an empty tier has no static fallback (§4.3 leaves static seat 2 empty), so the seat fails alone,
    as a missing judge does today.
  - A planted `google-antigravity/gemini-3.1-pro` adoption fails as `model_missing` and changes nothing.
  - `gemini-pro` produces exactly one card whose first proposal is `gemini-4-argon`. A simulated tap probes it and
    writes the override, and the resolution of `judges:2` then has a head.
- **Part B and Part C, `scripts/live-gate-loud-degradation.mjs`.**
  - The boot resolve closes the three copied `hostile_schedule_turn` rows.
  - One reminder lists `role_unresolved judges:2`, if it is open on the copy.
  - The copied `hostile` carries into a turn; after `/fresh` the next turn carries nothing.
  - A planted withhold-only turn stores `untrusted`.
  - The `/fresh` step drives a **real omp RPC session** in throwaway dirs, as the contract probe does: prompt, then
    `/fresh`, then a restart, then the next start. It asserts the resumed transcript is a new one. A fake session
    cannot show this (codex B2).
- **After the merge,** Paco's own `/fresh` on the running daemon is checked in the ledger: the next turn has no
  `carried_*` `turn_trust` row.

## 10. Rollback

Revert plus rebuild. The old build ignores `model_tiers`, the new columns and the `model_probe` events.
`scripts/check-loud-degradation-rollback.mjs` runs the stamped merge-base build on a copy the new build wrote, and
asserts that:
- the schema is stable;
- `/models` and `/status` render;
- the old `changedRoles` reads the new `model_roles_resolved` payload (`key` and `head` kept);
- a carried level still carries.

## 11. Protected files touched (Tier A under the approved spec; checked against `self-write-guard.ts:67–135`)

- **Protected:**
  - `src/omp/`: `model-roles.ts`, `role-resolver.ts`, `model-roles-tick.ts`, and `planner-supervisor.ts` for
    `/fresh` and the reset decision;
  - `src/decisions/`: `trust.ts` and `entries/turn-trust.ts` for carry levels;
  - `src/run/run-store.ts`: `model_tiers`, the new columns, the boot resolve;
  - `src/run/run-ledger.ts`: the `model_probe` event type and its payload allow-list.
- **Unchanged and still protected:** `src/llm/providers/omp.ts` and `src/llm/registry.ts`. The probe uses the
  one-shot seat as it is, and the judge seats stay single-model.
- **Not protected:** `src/run/incident-alert.ts`, `src/triggers/telegram-command-parser.ts`, the gateway command
  handler, `src/status/houge-status.ts`, `src/telegram/telegram-daemon.ts` (the reminder step), and
  `src/capabilities/idea-panel.ts` (model ids in its payload).

## 12. Risks

- **A newer model behaves differently overnight.** Judge scores stop being comparable week to week. Mitigation: the
  change notice names every switch, and from this slice the panel's rows carry each seat's model id.
- **Probes spend subscription quota:** one short prompt per moved or missing-previous tier per day.
- **A provider's new naming scheme** leaves its tier empty or stale. The card and the reminder make that loud, which is
  the point of this slice.
- **D2-A is a judgement about context.** Tracking causes means it applies only when the withhold is the turn's only
  hostile cause. If the judge's 0.5 bar misses an injection in a sibling passage, that text was already let through as
  clean today; D2-A only shortens how long a caught one gates later turns.

## Decisions needed (Paco, at the spec tap)

- **D1: which families count as "latest".**
  - **A (recommended):** Opus stays the top Anthropic tier for Default, Thinking and Chair; Fable and Mythos stay out
    until you name them. Kimi widens to `-pro` (`k3.1-pro` > `k3`, subscription-priced 0/0), excluding `-highspeed`.
    Codex stays on `sol`.
  - **B:** as A, but with Kimi kept on `k3`.
  - **C:** you name Fable and/or Mythos and where they rank against Opus.
- **D2: carry after a withhold-only hostile turn.**
  - **A (recommended):** the transcript carries `untrusted` (§6.1).
  - **B:** keep carrying `hostile`; `/fresh` is the only exit.
- **D3: a carried-hostile schedule turn.**
  - **A (recommended):** no page.
  - **B:** one page per chat while the carry lasts (subject = chat id), closed by a committed fresh transcript.
- **D4: the static rollback.**
  - **A (recommended):** re-pin at ship and check daily in resolved mode (§4.3).
  - **B:** retire `HOUGE_MODEL_ROLES=static`; rollback is then revert plus rebuild only, as ADR 0030 R13 already says
    for the ladder.

## Rev 1.1 changes (each finding verified first-hand)

**Senior blockers:**

| # | Finding | Applied |
|---|---|---|
| B1 | D2-A could not tell a withhold-only turn from others; `raise()` drops non-rising causes (codex B1 too) | §6.1: cause set, carry levels; `carried_hostile` named; double-raise tests |
| B2 | `/fresh` via the lesson path would not reset with an idle child, after a restart, or mid-turn (codex B2 too) | §6.2: persisted flag, honoured regardless of fingerprint, idle child stopped, in-flight waits, honest reply; real-omp gate step |
| B3 | Reminders and the static check rode a tick that is idle in static mode and returns early on an outage (codex W1 too) | §5: own daily path; §4.3: check in resolved mode only, resolves on return |

**Senior warnings and suggestions:**

| # | Finding | Applied or ruled |
|---|---|---|
| W1 | In-tier judge fallback touches `judgeSeat` (protected), `idea-panel-seats.ts` and ADR 0027 seat binding (codex B4 too) | **Ruled:** no in-panel fallback; the fallback moves to the daily tick (§4.1). Simpler, keeps binding, and leaves the protected registry unchanged. Cost if wrong: up to one day without a seat after a retirement |
| W2 | §11 incomplete | §11 rewritten; `run-ledger.ts` added; registry and providers named as unchanged |
| W3 | The probe seam was wrong (codex B6 too) | §4.2: the one-shot seat, unchanged; pass = ok and non-empty; fail and inconclusive classes |
| W4 | Bootstrap window (codex B5 too) | §4.2: seeded heads, backups filled by probe |
| W5 | Override written before the probe (codex B3 too) | §4.4: probe first, write on pass in the same transaction; shadowing override named in the notice |
| W6 | Kimi pattern excludes `k3.1-pro`; Codex family unexplained | D1; family rule in §4.1; tie-break |
| W7 | Standing credit | §6.1, Amends |
| W8 | Boot resolve of `trust_tap_budget` | Dropped from scope: it already rolls over (`trust-ask.ts:54`); the live row is today's |
| W9 | No time for `/status` | §6.3: `transcript_trust_at` |
| W10 | Static `judges:2` undefined | §4.3: empty until a tap and a re-pin |
| W11 | The shortlist does not name models | §2, §8: the panel payload carries model ids |
| W12 | Tick order | §4.2 tick order |
| S1–S6 | | S1, S2, S4, S6 applied; S3 applied (reminder set reasoned); S5 noted, the card TTL already bounds it |

**Facts corrected:**
- **§3:** tap-budget rollover; static breakage is judges 1 and 2 only; the `untrusted` carry since 10-14; two carried
  pages, not three; no timestamp on the trust row; the probe seam; the panel names seats.
- **§1 wording:** follows these corrections.

## Rev 1.2 changes (codex scoped re-review; each finding verified against the cited lines)

| # | Finding | Applied |
|---|---|---|
| N1 | A failed `/fresh` reset would follow the lesson degrade path and serve the old session as if fresh (`planner-supervisor.ts:1195`) | §6.2: the failure is never silent. The old transcript runs with its carry, a fixed prefix is sent, the marker stays, the incident opens |
| N2 | `commitReset` is keyed by child generation only, so a lesson reset already in flight would consume a later `/fresh` | §6.2: `fresh_requested_at` plus `servedFresh`; the commit clears only the request it served |
| N3 | `tickSeat` drops the failure class | §4.2: `oneShotAdapter` is called directly with a one-leg chain; `classifyOmpError` over its error |
| N4 | `model_missing` suppression had no state | §4.2: `rejected_selector` and `rejected_at`, re-probed after 7 days |
| N5 | A reminder after the model-tick await could be delayed | §5: runs before it |
| B5/W4 open | The gate's every-role check contradicts the empty `gemini-pro` | §9: every key except `judges:2`; the empty seat fails alone |

