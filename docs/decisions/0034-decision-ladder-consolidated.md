# ADR 0034: Decision ladder (consolidated) — every decision on one list, a ladder of deciders, improved from outcomes

- **Status:** accepted 2026-11-05 (signed by Paco, rulings A1–A5 included); consolidates and supersedes
  [ADR 0030](0030-decision-ladder.md) with no change of meaning; amended 2026-11-07 (improvement proposals
  auto-apply, the digest goes — signed by Paco 2026-11-08)
- **Date:** 2026-11-04
- **Deciders:** Paco
- **Supersedes:** [0030](0030-decision-ladder.md) (17 amendment sections) and
  [ADR 0031](0031-chat-carries-what-needs-paco.md)'s amendment to it. Carries 0030's amendments to 0029 (now
  [0033](0033-jev-system-one-consolidated.md)), 0028 (now [0032](0032-omp-runtime-consolidated.md)),
  [0014](0014-dual-llm-privilege-separation.md) and [0011](0011-self-evolution-architecture.md) (rule 12).
- **Spec:** [2026-10-12-decision-ladder-design.md](../superpowers/specs/2026-10-12-decision-ladder-design.md) (Rev 8);
  Paco's rulings R1–R13 are its §2. Later slices' specs are in History.

## Context

Houge takes about 85 decisions between a Telegram message and the delivered reply. They were hand-written branches with
their own logging and implicit failure directions; Jev decided one, at the front door, and "System One shortcut, else
the planner" became the architecture. Paco called that tree stiff and declined judges on top of it as a patch
(2026-10-12). The middle of the turn was blind: injection screening only on the four read tools and only as a note,
"done" never verified, output trimmed by size not relevance, no measure of whether an improvement worked. This ADR
consolidates ADR 0030, its 17 amendments (2026-10-13 to 2026-11-03) and ADR 0031's amendment to it. Identifiers:
**Paco's rulings R1–R13** (2026-10-12); **slices R1–R7** (the Stage 3 remainder); **2b-R7/R8/R15** (2b-i spec rulings).

## Decision

We hold every decision that changes a turn's path, and whose answer an outcome could show wrong, as one entry in a
code-owned registry under `src/decisions/`. Everything else stays plain code (mechanics).

### 1. Entries and the ladder

- 1.1 **Entry.** A stable id; a version bumped on any wording, rung or bar change; a stage; the input its judges read
  (`paco`, `tool` or `mixed`; `mixed` is treated as `tool`); a closed verdict set that always includes an escape value;
  a `fail` verdict used when no rung answers; a default verdict; the outcome signals that can show it wrong; and per
  verdict what it causes (`none`, `reply`, `tighten`, `proposal`, `effect`), whether that is reversible and how it is
  announced.
- 1.2 **Ladder.** Code rule, then Jev, then a model, then Paco. A rule answer ends the walk. A rule that wants a judge
  abstains: "eligible for judging" is an abstention, never a pass. A thrown rule, a timeout or an outage is an
  abstention, so `fail` decides, never an accident. A rule that throws writes a `fail`-rung row (for some entries
  carrying the default verdict, the only trace); that row is what the rule recorded, not what the code did: read `rung`
  first.
- 1.3 **Monotone rule.** On a monotone entry a Jev or model verdict applies only when at least as cautious as the
  verdict so far, which starts at the abstaining rule's floor. A Jev or model rung never opens a gate and never allows
  or denies an action (ADR 0033), with the one exception in rule 2.4.
- 1.4 **Locked entries.** Gates whose logic must never be judged: sender, budget fuse, bare-ack consent, kill posture,
  approval binding, path floor, SSRF, self-write guard, the reader wall, attachment path, secret redaction, turn trust.
  No rung added and no ladder move, refused by a registry test and at run time by the ladder-move store.
- 1.5 **Protected surface.** `src/decisions/` is in `PROTECTED_DIRS` (if the registry decides the gates, editing it can
  open a gate). In `PROTECTED_FILES`: `src/run/store-options.ts` (the only builder of a store with a decision recorder;
  `{ redact }` without a recorder does not compile), `src/triggers/telegram-auth.ts` (the allowlist predicate behind
  `intake.sender`; the evidence it reads stays in the self-writable adapter, pinned by a test), `src/skills/promote.ts`
  (nothing reaches the active skills tree without Paco's tap), `src/gateway/improvement-commands.ts` (taps chat-bound
  and state-fenced). A gate entry's glue lives under `src/decisions/entries/`; a non-gate entry's may live outside (as
  `turn.handler`'s `src/core/turn-handler-ladder.ts` and `src/jev/tree-policy.ts`).
- 1.6 **No off switch, no shadow by design (R13).** No env var, no switchable check; a new entry ships armed and stays
  armed. The only env switch over the front door's arming is the STOP flag
  `HOUGE_JEV_ENABLED` (ADR 0018), which arms and disarms the front door — Jev's other entries do not read it; the gate-only
  calibration file and a legacy `houge.jev-disarmed` marker hold it off (ADR 0033 G6), and `/status` names the cause. `HOUGE_JEV_LANES_OFF` and `HOUGE_JEV_TRIAGE_ENABLED` are retired (2026-11-05); the runner has no
  shadow or off mode. (Ruling A5, signed by
  Paco 2026-11-05: the `/disarm` STOP flags of ADR 0018, `HOUGE_JEV_ENABLED` and
  `HOUGE_IMPROVE_ENABLED`, are the operator's brake on a whole capability (`/disarm` forces them off and `/status`
  then shows `disarmed`; the improvement tick's flag also shows as `tick off` in the `/status` Improvement (7 d) line), and are outside this
  rule; a flag that lets an entry run unarmed or in shadow while its capability runs is not.) A fundamentally wrong
  build is reverted, `dist/` rebuilt, the daemon kickstarted. Migrations are additive (new tables, nullable link
  columns), so the previous build runs on the migrated DB; every stage plan proves it on a migrated DB copy.

### 2. What a Jev or model verdict may cause (R12)

- 2.1 ADR 0029's accepted risk stands: Jev is steerable by injected text, so its labels stay advisory or monotone and
  steering degrades quality, never safety. Over **tool-derived input** (web, mail, calendar, shell output, files, tool
  results) a verdict may only tighten — withhold a passage, add a tap, send the planner back once — and any lasting
  change it suggests (lesson, fact, skill, wiki page) is a proposal for Paco's tap.
- 2.2 Over **Paco's own message** a verdict may cause an effect directly if reversible and announced: a `turn.handler`
  lane reply (Dig deeper); the memory shortcut's instant lesson save (permanent; Undo on its card). Every automatic
  lesson save, whatever the route, is announced: on the memory card with Undo, or — for a lesson or fact `improve.route`
  applies from a correcting turn Paco typed (rule 10.5) — on a `/changes` line with its undo command (`/forget <id>`,
  `/forget_memory <id>`).
- 2.3 **Context does not change the source.** An entry about Paco's message stays `paco` when its state also carries
  recent turns, Houge's replies included, as long as the effect only stores Paco's own words, reversibly and announced.
  An effect that would store or act on text from the context is `mixed`.
- 2.4 **The one named exception to "no Jev in any deny path, ever":** the code-owned redirect of a built-in
  `edit`/`write` to `bash` (which asks Paco) in a turn the injection judge marked hostile, **or in a continuation after
  a Jev-rung `turn.settle` send-back** (2b-R7, `settleAsk`: for the rest of the turn the ask half of every gate
  evaluates as if hostile, reason `this reply was sent back for one more pass`; the recorded level is unchanged; the
  taps count toward the 3-a-day budget). Every other Jev verdict stays out of deny paths. Under ADR 0029 decision 2
  (word for word): withholding a passage is a data transform, not an action deny; the send-back is one bounded
  continuation in which every side effect asks after a Jev-rung send-back and the normal gates apply after a code-rung
  one; the redirect is the ask form of a gate that cannot wait.
- 2.5 **Effect contract.** A registry test (`entryProblems`) fails any entry whose Jev or model rung can cause an
  unannounced or irreversible effect, or anything but tightening or a proposal from tool input. A rule-only entry may
  carry an `effect` verdict over `tool` or `mixed` input (`steer` and `retry` are irreversible `effect`s over tool
  input; `include` and `inject` are `effect`s over `mixed` input; `rewrite`, `fetch`, `fallback`, `held` are `effect`s,
  `rewrite` over `mixed` input); a Jev or model rung joins only after a compliant effect contract — changing the input
  to `paco` alone is not enough. One allowance (spec 2026-11-07 §4): over `mixed` input a judged verdict may be a
  reversible, announced `effect` when the entry names a code-owned provenance predicate (`pacoWordsOnly`; today
  `improve.route`'s `autoApplies`) that holds by construction — the state the stored text comes from is Paco's own
  message plus code-built fields. The provisional-bar rule (6.1) extends to that gated case. Every other mixed-input
  effect still fails `entryProblems`.

### 3. Recording: decide, then record

- 3.1 **Ledger.** Recording never changes a decision. A `decisions` row is written when the verdict differs from the
  default, a rung beyond the first rule answered, Paco was
  involved, or the entry always records (`alwaysRecord`). (Rows written before 2026-11-05 may carry `armed_mode = 'shadow'`.) Rows hold ids, closed enums and numbers: no state column,
  never text. `decision_outcomes` holds closed-enum outcome signals, validated at insert. Domain detail stays in the
  entry's table (`jev_verdicts.decision_id`, `jev_decisions.ladder_decision_id`).
- 3.2 **A turn's row is written with that turn's own records, so a lost turn writes no row.** Rows are written only
  while the turn is live; the signal is `turn.endSignalled` (true in the tick `done()` resolves `turn.ended`, re-armed
  when a retried leg replaces the end signal), not the lagging `finished` (`planner.crash_guard` still reads `finished`:
  a follow-up). The consulting turn is passed in, never read from `this.turn`. Supervisor rows follow the incoming run's
  successful claim. A lane writes its rows at its end, only while the turn's abort signal is unset. Memory-save rows are
  held and flushed by `CoreWorker.runMemoryWrite` on a live turn; `memory.kind`'s row stays inside the save transaction.
  Intake rows carry `run_id` null (no run exists yet, as `tool.manifest`). Each in-turn row is a synchronous insert
  inside the turn deadline (ruled residual).
- 3.3 **Move, don't improve** (4B ruling R1, every migration). A migrated check's call site records the code's answer
  where it already decides and branches on the raw answer, never the recorded verdict; results, rows, events, prompt
  bytes and their order stay identical to the merge base, proven by a behavioural differential before the call site
  moves.
- 3.4 **Faults and visibility.** A failed decision write opens `decision_record_failed` (one per entry; routed per ADR
  0031); the result stands; a recorder that throws past itself is logged; nothing reaches a denied sender's chat.
  `/status` shows a count line per entry id once rows exist (`secret.redact`'s says "final, failure and evolution
  reports only"). `review_ok` may name any id in `ENTRY_IDS` (the digest that wrote it is retired).

### 4. The entries

As the ADR text states them; "—" means it does not say. Reasons are `verdict/reason`; "refusals" means only refusals
write.

| Id | Stage · input | Locked | Rows written, and when | From |
|---|---|---|---|---|
| `turn.handler` | — · `paco` | no | `alwaysRecord`. Ladder: ack rule → Jev tree → Tiny cascade, `fail` = the planner; detail in `jev_verdicts` | 0030 |
| `turn.gear` | — | no | when: — (rule 3.1 as written). A separate entry on the same Jev call | 0030 |
| `tool.injection` | — · `tool` | no | `alwaysRecord`. Verdicts: pass < frame < withhold (rule 7.1) | 2a |
| `tool.shell_netread` | — · `tool` | no | when: — (rule 3.1 as written). It decides only the trust level (rule 7.3) | 2a |
| `turn.trust` | — | yes | when: — (rule 3.1 as written). Locked code (rule 8) | 2a |
| `memory.kind` | `pre_model` · `paco` | no | `alwaysRecord` (its row stays inside the save transaction, rule 3.2). Verdicts: `other` (escape and `fail`), `fix`, `rule`, `fact`, `both` (rule 6.5) | 10-17 |
| `turn.settle` | — · `mixed` | no | code rung always recorded (`alwaysRecord`); outcomes `settle_sent_back`, `settle_unverified`, `settle_discarded` | 2b-i |
| `improve.route` | `after_turn` · `mixed` | no | `alwaysRecord`: one decision row per group, one outcome row per inbox row (rule 10.2) | 2b-ii |
| `tool.policy` | — | no | `alwaysRecord`. The standing case lives in its rule: v3 reasons `standing`, `standing_mismatch` (rule 11); it also keeps `denied_on_revalidation` | decision 7, 4A |
| `approval.bind` | — | yes | `alwaysRecord`, every omp-sink consume of an approved row (`CapabilityRunner.bindApproval`): `bound`; `unbound` with the sink's seven refusal codes or `no_sink`. Not: a first call that asks, `denied_on_revalidation` (stays `tool.policy`), a standing use (stays `tool.policy` v3 + the sink CAS), the resolve side, the run-level eval-fixture sink; a throwing sink propagates and writes no row | 4B |
| `secret.redact` | — | yes | `masked`, one per masking attempt in the final-report, failure-notice and evolution-report wrappers (reasons `final_report`/`failure_report`/`evolution_report`), only while the secrets firewall is armed; duplicate, conflicting, failed enqueues count (a row is an attempt); never text; `clean` default, no row. Not counted: ledger payloads, approval cards, the judge redactor, core-worker cards, Jev egress | 4B |
| `memory.lesson_admit` | — · `mixed` | no | refusals: `scheduled_run`, `already_saved`, `code_owned` (pre seam, in today's order); one per refused side `lesson_backstop`, `fact_backstop`, `fact_no_evidence`; `lesson_write` and the lane save-first only (Gate A lesson saves and accepted improvement proposals are not admits); a live-turn backstop row survives a later `racedBy` | 4C |
| `schedule.admit` | — | no | `alwaysRecord`, per `schedule_task` create/update/cancel reaching admit: `admit`/`exists` with the verb; `refuse`/`no_chat` (verb `none`, before dispatch, `list` included), `not_found`, `cap`. Validation errors and a Telegram `list` write none; operator and loop schedule paths (`/schedule`, improvement undo, the tick's auto-cancel) are not this entry | 4C |
| `memory.correct_preflight` | — | no | refusals at the bridge preflight and the gated write (not told apart): `not_operator_turn`, `tainted_turn`, `too_many`, `not_offered` | 4C |
| `intake.rate_limit` | `intake` | no | refusals, consulted only after a denial: `command_window`, `active_runs`, `pending_approvals`; `fail: "limit"` | R1 |
| `intake.rating_reply` | `intake` · `paco` | no | `alwaysRecord`, per fresh decision of an open in-window ask, after the existing writes: `consume`/`bare_digit`, `forward`/`digit_comment`, `lapse`/`not_rating`; none on replay, conflict, expired/inactive/missing ask, scheduled source | R1 |
| `intake.budget_fuse` | `intake` | yes (0003) | refusals: first breached kind in `GLOBAL_BUDGET_KINDS` order (`runs`, `tool_calls`, `gated_attempts`); in the memory-lane Dig deeper it commits with that transaction | R1 |
| `intake.sender` | `intake` | yes | refusals, once in the long-poll denial branch after the skip row and offset advance, no sender id, chat id or text: `channel_post`, `forwarded`, `anonymous`, `no_chat`, `user_not_allowlisted`, `chat_not_allowlisted`, `identity_not_for_chat` | R2 |
| `turn.contract` | `pre_model` | no | `refuse`/`goal_missing`, `unknown_program`, `unsupported_type` (`run_id` null); `restrict`/`schedule_born` for a queued run lacking `schedule_task`, first statement after the queue. A plain compile, a fuse refusal, a duplicate, a conflict or a failed attach records nothing | R2 |
| `intake.bare_ack` | — · `paco` | yes (0029 §5.1) | only `nudge`/`ack_while_card_waits`, while an approval card waits on a live Telegram turn; `fail: "nudge"` | R3 |
| `intake.steer_or_queue` | — · `tool` | no | `steer`/`live_turn`; `wait`/`turn_not_live`, `queued_behind`, `turn_schedule_born`, `message_scheduled`, `needs_ingest`, `not_running` (first match); `queue` default | R3 |
| `planner.crash_guard` | `supervision` · `tool` | no | `halt`/`limit_reached` (3 crash exits in 10 min latch), `halt`/`latched` (until `/rearm` or the next sweep that runs); `spawn` default | R4 |
| `turn.retry` | `supervision` · `tool` | no | `alwaysRecord`, per `retryNextLeg` consult: `retry`/`quota`, `auth`, `transport`, `timeout`, `model_missing`, `other_once`; `final`/`other_unrouted`, `other_retried`, `other_after_tool`, `model_refusal`, `aborted`, `spawn` | R4 |
| `context.recall` | `pre_model` · `mixed` | no | `alwaysRecord` per prompt build that attempted retrieval: `include`/`embedded`, `fts_only`; `none`/`embed_failed`, `dropped_after_gate`, `below_gate`, `unscored`; never pages | R5 |
| `context.catch_up` | `pre_model` · `mixed` | no | `alwaysRecord` when consulted (Telegram build with a lane row since the last answer, or a failed read): `inject`/`all`, `entry_capped`, `trimmed`; `none`/`all_trimmed`, `read_failed` | R5 |
| `context.lessons` | `pre_model` · `tool` | no | once per spawn in `preparePaths`: `capped`/`char_cap`, `none`/`render_failed`; `full` default | R5 |
| `turn.clarify_cap` | `pre_model` · `tool` | no | `cap`/`cap_reached`, one consult per prompt build | R5 |
| `lookup.rewrite` | `pre_model` · `mixed` | no | `alwaysRecord` per lookup reaching the query step: `rewrite`/`rewritten`; `bare`/`no_recent_line`, `long_message`, `no_time`, `late`, `failed`, `same`, `invalid`; the query selected, not whether it ran | R6 |
| `lookup.thin` | `pre_model` · `tool` | no | `alwaysRecord` per successful first read: `fetch`/`thin`; `none`/`answered`, `no_url` | R6 |
| `turn.model` | `pre_model` · `tool` | no | non-default only, once per completed pin walk: `fallback`/`stepped_up`, `refused`, `next_leg`; `held`/`pin_failed` (first leg: the turn answers on the model the child holds); `none`/`pin_failed` (retry leg) or `no_leg`; `head` default | R6 |
| `attach.path` | — | yes | slice R7, not yet built | R7 |

- 4.1 **Shared predicates and limits.** Code and rule share one predicate where named: `mayRetryOf`, `clarifyCapOf`,
  `rewriteFilterOf`/`queryCheckOf`/`thinOf` (`core/lanes/lookup-predicates.ts`), `isBareAck` (nothing is approved by an
  ack), `CRASH_LIMIT`/`CRASH_WINDOW_MS` exported from the entry, one clock read for input and guard.
  `intake.rate_limit`'s exemption (`kill` and the three decision-tap prefixes) is code in front of the entry, so no later rung can
  delay `kill`. A crash-guard consult reached after its turn finished writes no row, even when it is the consult that
  latches; the guard still latches and opens its incident (routed per ADR 0031), and the next turn records `latched`.
  `turn.retry` is not consulted on an abort end, an async-work-only end or a settle continuation's error.
  `lookup.rewrite` stays rule-only (the Tiny call stays in the lane). `turn.model`'s `head` is the first *eligible*
  candidate; only this walk's refusals count; never at `candidates()`, the spawn or another seat. An unknown-program
  `/run` (`TASK_CONTRACT_INVALID`) is a handled denial (the poll loop advances); a Telegram-source refusal gets one
  code-built reply (the program word echoed, ≤ 200 characters); scheduled refusals stay silent. A crash between
  `createOrGet` and `turn.contract`'s row loses the row (the stored contract stays the truth). `memory.rule_save` and
  `notify.page` get no entry. Stage 3's pre-tool entries are not in this table: the ADR text names them only in passing
  (rule 1.4's locked gates; `tool.manifest`'s `run_id`-null rows, slice R1; `tool.wall`/`reader.family`, slice R6;
  `tool.policy`, decision 7 and Stage 4A, which is in the table).

### 5. Ladder moves

- 5.1 A move changes who decides, recorded in `ladder_moves`. Houge may move on its own, from code rungs only: standing
  approvals (after three consecutive approvals of one action and one proven sealed run; rule 11); skill authoring after
  a recurrence (into the inert pending area, active only on Paco's tap); lessons through the existing save path for a
  stated rule, with Undo. Only the standing-approval code may insert an automatic row, only for `tool.policy`, enforced
  in the store. Every other loosening (trusting a source, retiring a judge, lowering a bar) is a proposal for Paco's
  tap; adding a rung to a rule-only entry is a ladder move with Paco's tap. Callbacks pass the sender allowlist and are
  one-shot.

### 6. Bars and calibration

- 6.1 **Bars.** A Jev rung arms on calibrated rows (ADR 0033) or on a **provisional bar** from an external measurement,
  kept in the entry's registry code, allowed only on a monotone or fail-open entry or on a `paco`-input entry whose
  every effect is reversible and announced (`none` or `proposal` qualifies); a judge that can only propose
  (`noDirectEffect`) may carry one on a fail-open entry. The registry test fails any other. A calibrated row may replace
  it when Paco commits one.
- 6.2 **Golden sets.** Provisional bars are covered by golden sets that run as daily ticks (`tool.injection`,
  `memory.kind`, `turn.settle`) and in the Jev version check (those three and `improve.route`), never in the invariant
  sweep (the sweep is synchronous and switchable; R13 forbids a switchable check). A daily tick's drift opens
  `decision_golden_drift:<entry>`; the version check reports drift in its outcome message. Neither disarms.
- 6.3 **Model moves.** A model or wording change no longer opens `decision_bar_stale`; the Jev version check (ADR 0033
  F3–F4) judges it. `decision_bar_stale` is retired (the tick still resolves incidents older builds opened). The front
  door's calibrated tree rows keep their disarm on a model move.
- 6.4 **Noise band.** A reviewed per-question band, keyed like a calibration row: a value within the band of a bar asks
  Jev exactly once more; the front door decides on the mean, a judge over tool input on the more cautious call. A failed
  or overrunning second call keeps the first answer and still opens its outage incident. Bands are Paco's commits from a
  measurement script, never automatic; the row records the re-ask and the first p; raw Jev rows keep the first call.
  None is committed yet.
- 6.5 **Provisional bars in force.** `tool.injection` (held-out measurement against a 1 % false-positive bar);
  `memory.kind` p ≥ 0.85 (golden items per verdict in zh and en except `fix`, which Jev does not clear: a fix request
  falls to the distill and `memory_correct`); `turn.settle` 0.6/0.8/0.7/0.7 (rule 9.2); `improve.route` 0.67
  (`IMPROVE_BAR_P`, Paco 2026-10-22). `memory.kind`'s ladder: a Jev rung (`memory_kind`, own request, only when a save
  is about to run), then the distill (which writes the text); `rule`/`fact`/`both` save first with an Undo card per
  item, `fix`/`other` go to the planner. It runs on the memory lane, on any lane's `sets_rule` save-first (a Jev
  `other`/`fix` there abstains, never suppressing the save), and inside the planner's `lesson_write` tool (where the Jev
  rung is not asked: the distill decides; ADR 0033 J3).
- 6.6 **Taps are evidence.** Dig deeper, Undo and 认真想 write `decision_outcomes`; the digest's ✅/❌ are gone (spec
  2026-11-07 §9: no `review_ok`/`review_bad` labels, so `review_bad` → ladder proposals stop arising, and a button on an
  old digest answers 'This review has closed.'). No tap produces a category label now (only the retired ✅ on a
  front-door lane route did, and older rows still count); Dig deeper, Undo and 认真想 are evidence that puts the turn on
  the next sitting's list; conflicting taps give no label. No row is committed and no bar moves automatically. `lesson_undone` carries the lane the save came from.

### 7. Judged tool input and egress

- 7.1 **`tool.injection`** runs at the bridge on shell output (success and failure), on the four wall tools' results
  before the reader (it withholds passages, never decides whether the wall applies), on gmail's code-built side channel,
  and on built-in `read`. A passage that may not leave is never passed: withheld with a note from outside, framed and
  shown redacted from a local read. Floor and content check read raw text locally; the planner reads raw text outside
  withheld or framed passages. A judge that throws falls back to the local floor, content and path checks, never to raw
  text.
- 7.2 **Egress (R11).** Approved for every new class after redaction: web, mail and calendar, shell output, files, the
  final reply. The judge redactor (`src/decisions/egress.ts`) masks known secret values, credential shapes, named
  secrets, URL userinfo, query values and fragments, the turn's extracted codes and links, on the whole text before
  splitting (masks atomic). Credential stores are read-denied to the planner and never sent; PEM blocks, service-account
  JSON, cookie jars and dense named secrets stay on the code floor. **I1** the planner gets no text as judged that Jev
  did not see (every mask is mirrored, except hex-only and digit-only runs). **I2** secret keys match by whole segment
  (`api_key`, not `keywords`). **I3** no length cap on a named value (one too long to delimit blocks its passage).
  **I4** link tokens are masked whatever their case. Masks never split text for later rules; long runs are masked only
  when opaque; a key may follow any non-word boundary (≤ 8 leading `.`/`-`), one-line `<key>value</key>`, an all-caps
  `…PASSWORD|PASSWD|TOKEN|SECRET|KEY` suffix (pure-alpha value left alone in egress); broker values are found by its own
  redactor on the whole text; a 12–24 lowercase-word line with no stopword is a seed phrase. Mail-extract links keep
  scheme, host and route words, mask token-like segments, query values and fragment, and decode escapes run by run; a
  short link (≤ 512 characters, ≤ 8 query values) in the code-extracted field reaches the planner exact while the judge
  sees it decoded and masked. The extension floor mirrors egress `secretKey`. Settle egress masks the turn's extracted
  codes and links. Improvement text is Paco's own words through `redactForImprove` (adds standalone 6–8 digit runs and
  codes after a code word); tool text leaves there only as a clean turn's reply for the distill.
- 7.3 **`tool.shell_netread` is best effort; the allowlist is the real gate.** It decides only the trust level
  (segments, wrappers, `shell -c`, `eval`, `find -exec`, `/dev/tcp`, quote/backslash stripping, any expanded program
  word counts as network). A miss frames an exotic disguised fetch's output, not withholds it, and the turn stays below
  hostile until a judged passage says otherwise.
- 7.4 **Credential stores by name** are read-denied in the bridge and both Seatbelt profiles: `id_<algorithm>` key
  files, dot-prefixed or `auth_info*` session folders under ~/Projects, narrowed `*token*.json`, `*.pem`, `*.key`,
  `.env.*` (tokenizers, CA bundles, Keynote files and `.env` templates stay usable). A private key file name is a
  credential; a server certificate is not.
- 7.5 **Built-in `read` is judged.** The extension sends `judge_read` and applies the rewrite inside a 5 s timer; past
  it a fail-closed local floor withholds the whole text. The 32 KiB cap applies in every branch. A judgement after the
  turn finalised is `armed_mode: late` and mutates nothing; a read unjudged at the bounded drain raises hostile
  (outside) or untrusted (local). Every gated read is reconciled: a `report` with no `judge_read` and an unreconciled
  read at flush raise `judge_timeout` (an image-only read ends the turn `untrusted`).
- 7.6 **Masked files (2b-R8).** A local read with a mirrored mask carries `⟦Houge masked N value(s) in this file; an
  edit or write to it will ask Paco⟧`; its resolved, case-folded path is remembered: built-in `edit`/`write` on it takes
  the bash redirect, a bash command naming it asks (`this file was read with values masked`), both trust taps. Hex-only
  and digit-only masks add no path. Any write, edit or bash command carrying the mask token asks the same. Which omp
  line prefixes the mask and the line-anchored checks accept, in Houge and the extension, is ADR 0032 rule 6.2. A `www.`
  path is a URL read for the gate.

### 8. Turn trust (`turn.trust`, locked code)

- 8.1 **Levels.** clean → untrusted (a wall read, a network shell read, a lost judgement, a framed local passage) →
  hostile (a withheld passage, an outside passage withheld unjudged, or one whose judgement was lost, which reaches the
  planner in a "not checked" frame). Jev down, timed out or partial counts as lost. Inside a turn the level only rises.
- 8.2 **Taps.** Trust only adds taps: untrusted asks before `lesson_write`, `schedule_task`, `self_write_propose` and
  `skill_author`; hostile also asks for every shell command off a strict read-only list and every write, and redirects
  the built-in writers (rule 2.4). The list admits exact flag sets per program, globs only after `--`; device paths ask;
  `wc` is not on it and any word containing `libxo` asks. A trust card pauses the turn's timers for its TTL
  (`HOUGE_TRUST_ASK_TTL_MS`), at most once per turn; under 5 s left is refused. Trust asks count toward the 3-a-day
  added-tap budget, whose excess opens `trust_tap_budget` (routed per ADR 0031) and never blocks.
- 8.3 **Carry.** `TurnTrust` keeps every cause it was asked to raise; a transcript carries at turn end the highest carry
  level of that set, and a turn starts at what its transcript carries. A cause carries its `CAUSE_LEVEL` except
  `injection_withheld`, which carries `untrusted`; `carried_hostile`, `judge_lost_outside`, `unjudged_outside` carry
  `hostile`. `endTrust`'s `keepOld` compares carry levels. Standing credit is refused only while the stored level is
  `hostile`.
- 8.4 **`/fresh` is the exit.** Paco-only control command; a persisted `fresh_requested_at` marker on
  `planner_session_state`. The next planner start honours it whatever the lesson fingerprint says, resets and sets
  `servedFresh`; `commitReset` clears it and stores `clean` (with `transcript_trust_at`) only for a reset made for that
  request, in one transaction. An idle child stops at once; a turn in flight is not cancelled; the reply says the next
  message starts fresh. A failed manual reset never pretends (the lesson path's 3-strike degrade applies to lesson
  resets only): the turn runs on the old transcript and carry, the marker stays, `planner_session_reset_failed` opens,
  every reply from that child is prefixed "Could not start a fresh conversation; this reply continues the old one.", and
  it retries at the next spawn. `/status` shows "Conversation carries <level> since <time> · /fresh clears it" when the
  stored level is not `clean` ("since" omitted with no time).
- 8.5 **`hostile_schedule_turn`** is an event, resolved right after it is raised. A schedule turn that carried `hostile`
  in opens nothing (the turn that read the text opened it); one that itself raises `hostile` opens the incident (routed
  per ADR 0031).

### 9. `turn.settle`

- 9.1 **Settle point.** A turn settles on an aborted end, a terminal `agent_end`, or an end waiting on background work
  alone (the child is stopped; `planner_async_wait` opens); a plain non-terminal end never settles. omp's retries are
  capped at two, each wait at 60 s. omp's own `fetch` is off. omp's todo tool is on (reminders off, `eager: default`),
  ungated, ledgered counts-only as `tool_finished builtin:todo`; a reminder reaching Houge opens the incident
  `todo_reminder_seen` (routed per ADR 0031) and is never rendered.
- 9.2 **Rungs.** The rule first; its guards return `settle` and stop the ladder: hostile, already sent back, a denied
  call, a queued steer (`steering.length + followUp.length`, validated string arrays), under 60 s of deadline, aborting,
  an errored pass 0 (`pass_errored`), an empty reply. Then the claims check (scheduled, saved, attached, sent:
  code-owned zh/en verbs, first person and past, against the run's ledger; passive and bare forms narrowed against false
  positives: earlier-time markers in English and Chinese (not 已经; bare `before` only as `before this|that|now|the
  last|previous turn`), question sentences, `nothing` as negation only as a claim verb's object, 附上 needs a past marker
  unless sentence-initial, bare pronoun passives of sent/recorded only as a whole sentence) and the todo check (a list
  changed this turn and left open); `builtin:todo` rows are bookkeeping, outside the denied-call guard and the Jev
  summary. Else the Jev rung asks four frozen questions (claims done, acted but unverified, ends on a promise, asks
  permission already asked) in its own request (point `settle`, 1.5 s, no re-ask) at 0.6/0.8/0.7/0.7; the recorded bar
  is 0.6; the questions hash covers the criteria, so a criteria edit marks the bars stale.
- 9.3 **Send-back.** One continuation through `session_stop`; the reply is its text, with a code fallback joining both
  passes under `— restated: —`; the pass boundary is its `agent_start`. A failed pass 1 (timeout, frame idle, child
  exit, omp's abort) records `settle_discarded continuation_failed` and delivers pass 0; `/kill` is not rescued
  (`settle_discarded signal`), even after the continuation. A child exit before the continuation stays
  `extension_timeout`.
- 9.4 **Final audit.** The delivered text (after attachment parsing) is audited at the terminal `agent_end` (code
  checks, Jev re-asked after delivery); a persisting reason writes `settle_unverified` and one urgent card per turn; a
  failed or rescued continuation queues the card with the original reason, no re-ask. Rows are never rewritten.
- 9.5 **Health.** Three `budget`, `todo_unavailable` or `pass_errored` rows in an hour open
  `decision_health:turn.settle`. A Jev outage reaches Paco once through the Jev incident (`turn.settle` is in
  `JEV_PAGED_ELSEWHERE`).

### 10. `improve.route`: improvement as a decision

- 10.1 Corrections and failures go through one entry that routes each to what it points at (fact, lesson,
  skill, ladder move, schedule, wiki page, tool gap) and is measured by whether its signal recurs. A pattern is needed
  before behaviour changes, except an explicit stated rule. The 2b-ii spec's rulings R1–R11 and plan rulings 1–16 stand.
- 10.2 **Inbox and tick.** Producers write `improve_signals` (memory-lane fix, Dig deeper, escalation and low rating
  corrections; the rating; approval denials and expiries; planner failures beside every `run_failed`);
  `decision_outcomes` are mirrored behind a `(created_at, rowid)` cursor. The tick runs once per local date at the
  `HOUGE_IMPROVE_AT` (default 21:00; no `off`, R13: `HOUGE_IMPROVE_ENABLED=false` is the switch); groups by (signal, scope); one transaction per group
  (decision, an outcome per inbox row, the proposal or job, `consumed_at`). A failing group counts `record_failed` and
  stays unconsumed. 120 s per cycle, resumed next cycle; the daemon loop waits meanwhile; at most 40 groups per date;
  counts accumulate over the date.
- 10.3 **Rungs.** `after_turn`, `mixed`, fail-open on `nothing`, every signal an outcome. Rules: stale (30 days); a
  stated rule is `memory.kind`'s; recurrence → the skill job (lookup categories → knowledge, recorded only while the
  wiki is disarmed); expiry pattern → a schedule proposal, no text; `review_bad` → `ladder` on an unlocked entry
  (`retire_judge` at ≥ 3 in 14 days, else `lower_bar`), `nothing`/`locked_entry` on a locked one. `ladder` applies only
  to `review_bad`, so Jev never chooses it. Jev: one choice question `improve_target` (escape first, applicable targets,
  masking after the answer); Tiny: one word among the top two.
- 10.4 **The only automatic effect:** a `_pending` skill draft after ≥ 3 turns of one category at cosine ≥
  `HOUGE_RECURRENCE_COSINE_GATE` (0.6) in 14 days, once per root turn. The job is an evolution-lane row, never a run: at
  most one starts per tick (none on a busy lane), 3 queue a day, a queued job expires at 3 days; each ending is one
  fenced transition with its card and the wall clock; a restart fails running jobs; an offer untapped 14 days ends
  `expired` (`offer_expired`) and its draft retires; a failed Gate A ends `failed` (`gate_a_unavailable`), never
  `suggested`; a promote that throws returns the job to `pending_review` / `collision` with its `offered_at`
  (`promote_retry:N`; three throws: `promote_failed`, with a card). A `_pending` file retires only when its stamped job
  is `dismissed`, `expired` or `failed`. A draft whose frontmatter repeats a key, or whose scope or name starts with
  `_`, ends `failed` / `author_failed`; a slow writer cut by `IMPROVE_SEAT_DEADLINE_MS` can also end a job
  `author_failed`. Paco promotes by tap (refuse / replace with lineage / keep both). `/disarm` holds queued jobs and
  defers job-starting groups. A cluster is already authored if a 90-day job in its category has an origin turn within
  the gate of a cluster turn, or shares a turn within 30 days; a `failed` job never suppresses.
- 10.5 **Proposals** (lesson, fact, schedule, tool gap, ladder, skill): one open per (target, scope), expiring at 14
  days; one dismissed or expired within 14 days blocks the same pair (`already_proposed`), checked before the draft and
  again at the commit (an `already_known` dismissal never blocks its pair); for schedule, tool gap, ladder and skill an
  **accepted or reverted** one within 14 days blocks it too. **A lesson or fact blocks only its repeats** (addendum
  Rev 2.3.1, Paco 2026-11-08): after the draft its text is embedded with the tick's embedder and compared
  (`repeatCheck`, `improve/repeat.ts`) with the stored draft text of every lesson or fact proposal on the pair accepted
  or reverted on it (reverted within 14 days; accepted within 14 days for a fact, within `LESSON_REWRITE_DAYS` (30) for
  a lesson). A near-copy (cosine ≥ `LESSON_REPEAT_COSINE`, 0.6, its value set by the threshold probe on 2026-11-08) of
  a reverted one, or of an accepted fact, records `already_proposed`; a different one goes on (applied, or a card, by
  provenance), and a near-copy of an accepted lesson is the 'lesson did not hold' rewrite — a card, never applied. The
  embedder down defers the group as an outage (latched; the 30-day stale rule bounds it); a candidate set that changed
  before the commit defers it (`deferred`). The check's embeds count against the tick's 120 s budget: a group that
  would overrun stops unconsumed and resumes next cycle. **A lesson or fact applies on its own** (spec 2026-11-07 §3)
  only through `autoApplies` (`improve-route.ts`, pinned by `tests/adr/0034-paco-words-only.test.ts`): every row of the
  group a correction Paco typed on the memory lane (`improve_signals.origin = memlane_fix`, stamped only for a Telegram
  correcting run and re-checked at the apply boundary; a new run of his, never the corrected run), verdict lesson or
  fact, not a 'lesson did not hold' rewrite (the repeat check's verdict, passed to `autoApplies` — a recent accepted
  lesson on the scope alone is no rewrite); its draft is distilled with an empty prior (`prior: ""`: Houge's reply
  never reaches the seat), passes the memory lane's backstops, and is saved inside the group's commit
  through `saveMemoryPlan` under the corrected run, `accepted` with the ids, with one `/changes` row
  (`improve_applied:<proposal_id>`, topic `improve_log`) naming `/forget <id>` or `/forget_memory <id>`; no chat → it
  stays open. A capped lesson, a save with no change id, and every other proposal (Dig-deeper, escalation and rating
  corrections, rewrites, schedule, tool gap, ladder, skill) is **one card** at the tick (`knowledge` stays recorded
  only, R5: no card) (topic `improve_card`, key `improve_proposal:<proposal_id>`, Accept / Dismiss, `offered_at` set);
  a null draft for anything but a capped lesson dismisses the proposal with reason `already_known` (no card, no
  `/changes` line). Accept writes through the memory lane's writers and the reply carries Undo / Revert / Revoke.
  `/forget <id>` and `/forget_memory <id>` on a row a proposal saved undo that save's **whole change** (what it pruned
  at the cap comes back; a refused undo falls back to the flip or retire and says so; the fact reply carries no Undo
  button), and `/forget <scope>` undoes each such lesson newest first, then prunes the scope empty — each moving its
  proposal `accepted → reverted` in the same transaction; `/forget_memory <id>` on a row saved in another chat takes
  today's path; Undo is no `turn.handler` label. Schedule Accept applies only while the row equals `before`; Revert
  restores; both recompute `next_run_at`. A skill Accept whose job exists dismisses. A ladder Accept records a
  `ladder_moves` row and changes nothing; a tool gap replies the `self_write_propose` text. Residual (accepted): with no
  prior and Paco's line as both numbered evidence lines a fact can over-generalise his words; it is his words' reading,
  never another source's, and one `/forget_memory` away.
- 10.6 **Outages defer, never consume.** A Jev outage (rung timeout; `no_key`, `fused`, `auth`, `rate_limited`,
  `overloaded`, `timeout`, `transport`, `error`) or a failed seat call writes no row and counts `deferred_outage`; the
  first outage latches the segment: later groups run the rule rung only (Jev answers `latched`, Tiny abstains), a group
  the rule cannot decide or that needs the distill is deferred, and the segment still ends `done`. On a day the embedder
  is down a waiting recurrence row stays unconsumed; with no Jev key every undecided group waits until stale, and the `/status`
  Improvement line says so; the 30-day stale rule bounds deferral. Seat calls run under `IMPROVE_SEAT_DEADLINE_MS` (60 s); the embedder
  takes ≤ `EMBED_PER_TICK_MAX` (50) turns per call and stops at its first failure; a capped segment ends `stopped`. A
  Jev parse, `state_too_large`, a throwing rule or the disarm posture records as usual. **Not built:** the wiki handler,
  model-route proposals, `lesson_unfollowed`, `trust_source` moves.

### 11. Standing approvals and the clean room (spec §8.3)

- 11.1 **Clean room.** `runCleanroomShell` makes a fresh room and home under `<cache>/cleanroom/`, validates them (inode
  lineage, no symlink, empty) before the spawn and after the run, runs through the wrapper's clean-room branch
  (`sandbox-exec` → `env -i` with six names → `nice` → `bash -c`), kills orphans whose cwd is the room, and removes both
  in `finally`; the result is typed (`ran`, `torn_down`, `tampered`, `escaped`/`escape_source`, one reason per exit).
  The profile denies all IPv6 egress and UDP, every Unix socket but the resolver's, listening, and all Mach lookups: TCP
  egress only, no planted file, config or Houge-managed local service reachable. Only named binaries exec (not `perl`,
  `python3`, `ruby`, `script`, `screen`); the room write rule excludes the room path; the clock is the host's. CLI
  children get `<cache>/children` as TMPDIR. Job-control orphans are bounded and detected, not prevented (reading A),
  stated on the card. `executor: "cleanroom"` is a selector outside the fingerprint, refused without run and tool-call
  ids. Seal facts ride the adapter and runner result arms and `tool_finished` (shell only, four booleans).
- 11.2 **Grant.** A key (schedule, chat, fingerprint) stands up only when the fourth approved call ran sealed and every
  fact holds: `status succeeded ∧ exit_code 0 ∧ ¬truncated ∧ ran ∧ torn_down ∧ ¬tampered ∧ ¬escaped ∧ ¬check_failed ∧
  run completed ∧ final_report delivered`; "its report reaches Paco" alone never grants. The grant is then automatic
  (`granted_by: auto`, `granted_via: approval.standing`), re-reads its evidence in its own transaction (three distinct
  consumed approvals of the key, the consumed fourth on the sealed call, the facts, the completed run, the delivered
  report), and never commits without its urgent card with Revoke. State: `standing_approvals` (one live row per key;
  ended rows kept for audit and the deny block), `standing_uses` (the per-run cap); the ladder move is the record. The
  runner allows only after the store's `standingUse` CAS wins at execution; `candidate → sealing` runs in its own
  transaction after the consume; a sealing row with no call facts ends at 24 h. No model path opens, advances or grants.
- 11.3 **Eligible:** scheduled `shell_external`, readable label, the run's notify chat, trust not asking, posture live,
  the clean room available (at trial selection and every use), one use per run, byte-identical bytes. No credit while
  hostile. **Ends:** Revoke (30 days, its chat only); expiry at 30 days; schedule cancelled or disabled; a fingerprint
  mismatch from its own schedule and chat; a denial on (chat, fingerprint) from any run (30-day block); a streak idle 30
  days; a trial unsealed or reported after 24 h; `tampered_use`; `unverified_use` (no readable facts: grant and move
  end, urgent card `standing_unverified:<id>`, no `/changes` row; "ran unknown" is never trusted). `ran:false` before spawn
  voids the trial. A scheduled run's approval is answered only from its notify chat (`APPROVAL_CHAT_MISMATCH` sends no
  reply; it and `STANDING_HOOK_FAILED` are handled denials). Five reasons write one `/changes` row
  (`sealed_trial_failed`, `denied`, `expired`, `stale`, `mismatch`; key `standing_end:<standing_id>`, topic
  `standing_log`) when the grant ends (`endStandingTx`, and the deny hook); `revoked`, `schedule_ended` and `tampered_use`
  write none; `standing_settle_failed` is keyed per row.

### 12. Effects on other ADRs

- 12.1 **0029 → [0033](0033-jev-system-one-consolidated.md):** front door = `turn.handler` with `turn.gear`; rule 2.4;
  R12; trust asks count in the 3-a-day budget; decision 4's egress approval is R11 (rule 7.2); decision 5: new entries
  never shadow, golden drift does not disarm, provisional bars are the exception under R6; the front door's calibrated
  rows keep their disarm on a model move; the memory lane takes rules and facts, not only `sets_rule` = yes.
- 12.2 **0028 → [0032](0032-omp-runtime-consolidated.md):** D5's tap-free local writes depend on `turn.trust`; D12's
  network shell output gets `tool.injection`.
- 12.3 **0014:** `tool.injection` runs before the reader and never decides whether the wall applies.
- 12.4 **0011:** `src/decisions/` joins `PROTECTED_DIRS`.

### 13. Review and decision-health kinds

- 13.1 **No digest** (spec 2026-11-07; Paco 2026-10-14 and 2026-11-07). `/status` holds the counts, the `turn.settle`
  health line, per-entry Jev-skip counts (24 h), the 30-day proposal counts and the 'Improvement (7 d)' line (tick off,
  unattached, silent families, deferrals, ticks failed, record failed, embeddings unavailable N d, wiki disarmed,
  inapplicable tops, lessons not holding); `/changes` lists applied improvements and ended standing grants. Urgent cards
  and proposal cards go out at once.
- 13.2 **Kinds (ADR 0031).** `decision_record_failed`, `decision_golden_drift` and `decision_fallback` (slice R5: a rule
  that throws writes a `fail`-rung row, and three in an hour open `decision_fallback`) route to the log (topic
  `decision_internal`), counted in `/status`, listed by `/changes`. `decision_health` is a card kind: its urgent card is
  the page. `decision_fallback_streak` pages: a tick entry (stage `after_turn`, `alwaysRecord`, with a judge rung; today
  `improve.route`) whose last three runs, however far apart, ended only in counted fallbacks opens it once; the next answer
  from a counting rung resolves it (one or two groups a day seldom make three in an hour; per-turn entries keep the hourly
  log). `improve_tick_degraded` pages (subject `improve`): judged on each date's `improve_ticks` row at its end —
  `failed` or a previous date still `running` opens at once, the third bad date (nothing decided while
  `deferred_outage`, `record_failed` or `embed_unavailable` was above 0) with no healthy date between them opens once,
  `stopped` is neutral (neither counted nor a reset), a `done` date that decided something (or had no group) with the
  embedder up resolves.
- 13.3 **Daily reminder.** A tick-loop step, independent of `HOUGE_MODEL_ROLES` and catalog outages, before the model
  ticks: one message a day (`incident_remind:<Sydney date>`) listing open `REMIND_KINDS` incidents older than 24 h, with
  ages and a code-owned action line — `role_unresolved`, `planner_session_reset_failed`, `omp_contract_drift` (at 7
  days). Left out: undelivered and delivery-health kinds, `trust_tap_budget`, `planner_no_leg`. Kinds, subjects and ages
  only.

## Consequences

- Easier: a judgment call is an entry plus a rung; one record, failure direction and outcome trail per decision; one
  record, no daily review (`/status` and `/changes`). Harder: characterisation tests and a differential before any call site moves; every rung or bar change
  is Paco's merge; with no off switch each stage's live gate carries more weight.
- Accepted: an unrecognisable secret in output the planner read can reach TypeSafe (R11), including a seed phrase with
  capitals, digits or punctuation, a one-time token of ≤ 14 pronounceable lowercase letters, an opaque segment in a
  short code-extracted link; the planner can send what it reads to its own provider; judged output loses base64 blobs
  and opaque tokens; omp's retry cap is asserted only by a unit test and a source read (the gate records it
  INCONCLUSIVE); the self-write test gate (`src/run/test-gate.ts`) is unsandboxed until SP3 — Stage 4A must not seal a
  run during a self-write, and a concurrent gate can write into `<cache>/cleanroom/` (a persisting plant is caught); a
  sealed exit-0 run with a wrong report stands until revoked; a denial during a rolled-back build ends no standing row
  (revoke in `/schedule`).
- Accepted (`turn.settle`): the un-awaited final audit loses its rows on a daemon stop; a decision past 4 s + 250 ms
  writes no outcome (`settle_discarded signal` if it finds the turn done); the 0.8 `unverified` bar is fragile; health
  can re-page on a flap; a Jev-skip day shows two Health lines in `/status`; claim-verb misses ("I've set a reminder…",
  已经发给她了) are Jev's; bare `Saved` fires only on very short sentences; a `/kill` in `abortTurn`'s grace after a pass-1
  timeout is `continuation_failed`.
- Accepted (masks, reads): flag-embedded paths, globs, quote splicing, `$PWD`, variables, interpreters and `mysql -p…`
  evade the masked ask; nine or more `.`/`-` before a key is unmasked; `MONKEY=` is masked; an unmarked write to a file
  masked in an earlier turn is not asked; a late `report` meets a cleared map; 2b-R15 (a read under the daemon temp
  dir is outside text) is reachable only as defence in depth, since the gate already denies planner reads there; a malformed
  `get_state` turns the steer guard off (`todo_unavailable`); a blocked read still sends a refused `judge_read`; slice
  R6's `tool.wall`/`reader.family` pair writes mid-lane, its second read unguarded.

## Alternatives considered

- **Judges on the existing tree:** a patch (Paco). **Judge approval:** approval stays Paco's or a standing rule.
- **"Jev never causes an effect"** (spec Rev 2–7): replaced by R12; it stretched "never gates an action" and
  contradicted the armed memory shortcut. **`HOUGE_DECISIONS_OFF` and shadow-before-arm:** dropped by R13.
- **omp's built-in judges:** not ledgerable, calibratable or reviewable (ADR 0015's key-location reason no longer
  holds).
- **Migrating every branch:** mechanics stay code. **A tally table:** a second accounting path.
- **A ladder-owned Tiny call for `lookup.rewrite`:** `decide()`'s timeout has no abort or `within`/`LATE`, and a Tiny
  outage would count toward `decision_fallback`; a later slice.
- **Entries for `notify.page`** (not a path decision; outside any turn; would let a failed row page itself) **and
  `memory.rule_save`** (absorbed by `memory.lesson_admit`, `memory.kind`,
  `jev_verdicts.sets_rule`/`rule_scope`/`save_outcome`).

## Assumptions

- The extension can rewrite a `read` result before the model sees it and send a turn back once; omp bounds hooks at 30 s
  and fails open, and Houge's 5 s timers stay ahead. omp marks continuations `isTerminal` false; Houge's spawn has no
  background tools; omp honours `retry.maxRetries` / `retry.maxDelayMs`.
- Jev answers within 1.5 s at the front door; in-loop volume (about 25–50 calls a day) fits TypeSafe's limits at ten
  times that; Jev's run-to-run spread is bounded by the measured band.
- The ledger stays small (about 10–15 rows a turn, about 5 turns a day); the front-door migration changes no persisted
  row; each stage's migrations are additive (checked by each stage plan).

## Revisit when

- omp emits judge verdict events, adds background tools to Houge's spawn, or `omp config get` shows the overlay.
- TypeSafe ships adversarial hardening, a retention commitment, or deterministic answers (the band goes).
- `decisions` passes 1 million rows; a golden set drifts twice in 30 days; fact Undo taps exceed one in five fact saves
  over 30 days; real replies sent back exceed 10 % over 14 days; 14 days of `improve.route` rows are in for its bar and
  gate (outcomes only: no review labels).
- A locked entry needs a judgment code cannot make; a stage needs a non-additive migration (R13 needs Paco again); any
  assumption fails its check.

## History

| Date | What changed | Spec | Signed by Paco on |
|---|---|---|---|
| 2026-10-12 | ADR 0030: registry, ladder, R12, ledger, locks, moves, bars, R13, review, R11; amends 0029/0028/0014/0011 | [ladder](../superpowers/specs/2026-10-12-decision-ladder-design.md) | 2026-10-12 |
| 2026-10-13 | 2a: injection judge, netread, trust, settle point, credential stores, noise band, tap evidence, I1–I4 | [ladder](../superpowers/specs/2026-10-12-decision-ladder-design.md) (Rev notes) | 2026-10-14 |
| 2026-10-17 | `memory.kind`; provisional bars widened to `paco`-input reversible, announced entries | [memory-write](../superpowers/specs/2026-10-15-memory-write-thread-anchor-design.md) | date not recorded (asked 2026-10-17) |
| 2026-10-20 | 2b-i: `turn.settle`, exception extended (2b-R7), judged `read`, masked files; final-review fixes | [2b-i](../superpowers/specs/2026-10-19-ladder-2b-hooks-settle-design.md) | 2026-10-22 |
| 2026-10-22 | 2b-ii: `improve.route`; digest cut to three sections, then Unsure and ✅/❌ returned; bar 0.6 → 0.67 | [2b-ii](../superpowers/specs/2026-10-21-ladder-2b-ii-improve-route-design.md) | 2026-10-22 |
| 2026-10-23 | `decision_bar_stale` retired; the version check judges model moves (decision 9 edited) | [version check](../superpowers/specs/2026-10-22-jev-version-check-design.md) | date not recorded |
| 2026-10-28 | Clean room; P8 closed by measurement · Stage 4A standing approval (Decision 1-A) | [cleanroom](../superpowers/specs/2026-10-28-ladder-cleanroom-runtime-slice1-design.md), [4A](../superpowers/specs/2026-10-28-ladder-stage4a-standing-approval-design.md) | 2026-10-30 |
| 2026-10-29 | 4B: `approval.bind` (replaces 4A's "no module"), `secret.redact`, `store-options.ts` | [4B](../superpowers/specs/2026-10-29-ladder-stage4b-bind-redact-design.md) | 2026-10-30 |
| 2026-10-30 | 4C: `memory.lesson_admit`, `schedule.admit`, `memory.correct_preflight` | [4C](../superpowers/specs/2026-10-30-ladder-stage4c-admit-design.md) | 2026-10-30 |
| 2026-10-30 | R1: intake rate limit (exemption in front), rating reply, budget fuse; `memory.rule_save`, `notify.page` dropped | [R1](../superpowers/specs/2026-10-30-ladder-remainder-r1-gateway-intake-design.md) | 2026-11-01 |
| 2026-11-01 | R2: `intake.sender`, `turn.contract` (1-B), `telegram-auth.ts` protected · R3: bare ack, steer/queue at the claim | [R2](../superpowers/specs/2026-11-01-ladder-remainder-r2-sender-contract-design.md), [R3](../superpowers/specs/2026-11-01-ladder-remainder-r3-ack-steer-design.md) | 2026-11-01 |
| 2026-11-01 | R4: `planner.crash_guard`, `turn.retry`; consulting turn threaded in | [R4](../superpowers/specs/2026-11-01-ladder-remainder-r4-crash-retry-design.md) | 2026-11-04 |
| 2026-11-02 | Carry with an exit: cause set, `injection_withheld` carries `untrusted`, `/fresh`, reminder (replaces sticky-until-fresh) | [loud degradation](../superpowers/specs/2026-11-02-loud-degradation-design.md) | 2026-11-04 |
| 2026-11-02 | R5: `context.*`, `turn.clarify_cap`; rows only while live | [R5](../superpowers/specs/2026-11-02-ladder-remainder-r5-context-clarify-design.md) | 2026-11-04 |
| 2026-11-03 | R6: `lookup.*`, `turn.model`; lane rows at the lane's end | [R6](../superpowers/specs/2026-11-03-ladder-remainder-r6-lookup-model-design.md) | 2026-11-04 |
| 2026-11-03 | ADR 0031: decision-health kinds to the log, `decision_health` a card, reminder kinds | [chat](../superpowers/specs/2026-11-03-chat-is-for-paco-design.md) | 2026-11-04 |
| 2026-11-04 | This consolidation, no change of meaning | — | 2026-11-05 |
| 2026-11-05 | Ruling A5: the ADR 0018 `/disarm` STOP flags are outside 1.6; found by the R13 conformance test (`tests/adr/`) | — | 2026-11-05 |
| 2026-11-05 | No off switch, no shadow: front-door shadow, HOUGE_JEV_LANES_OFF and HOUGE_JEV_TRIAGE_ENABLED removed; HOUGE_JEV_ENABLED is the front door's STOP flag | [no off switch](../superpowers/specs/2026-11-05-jev-no-off-switch-no-shadow-design.md) | 2026-11-06 |
| 2026-11-06 | Drift rewording, no change of meaning: golden sets are daily ticks and version-check sets, and where each reports drift (6.2); the five unmarked `alwaysRecord` entries marked in rule 4, pinned by `tests/adr/` | — | 2026-11-06 |
| 2026-11-06 | 6.3: the promise that the digest flags an entry until Paco commits a calibrated row is retired (nothing built it; Paco's decision 2026-11-06) | — | 2026-11-06 |
| 2026-11-07 | Improvement proposals auto-apply, the digest goes: 2.2, 2.5 (gated allowance), 6.6 (no digest taps), 10.2 (HOUGE_IMPROVE_AT), 10.5 (autoApplies, origin, no prior, cards, reverted blocks), 11.3 and 13.1 (/changes rows, no digest), 13.2 (improve_tick_degraded) | [auto-apply](../superpowers/specs/2026-11-07-improve-auto-apply-design.md) | 2026-11-08 |
| 2026-11-07 | 13.2: `decision_fallback_streak` pages three failed runs in a row of a tick entry (`improve.route` failed every day unseen); `improve.route`'s Tiny bound 8 s → 30 s | — | 2026-11-07 |
| 2026-11-08 | 10.5: the 14-day block covers repeats, not the category — a lesson or fact draft is skipped only as a near-copy (`LESSON_REPEAT_COSINE`) of one reverted (or an accepted fact) on the pair, and is the 'lesson did not hold' card only as a near-copy of a lesson accepted within 30 days; `/forget` and `/forget_memory` undo an improvement's whole change (Q1-B, Q2-A; controller ruling R1') | [auto-apply addendum Rev 2.3.1](../superpowers/specs/2026-11-07-improve-auto-apply-design.md) | awaiting Paco's signature |

## Reference map

"ADR 0030 §N" in code and docs cites the decision-ladder spec's sections (the ADR had none).

| Old locator | New |
|---|---|
| decision 1 · spec §4.1 · decision 2 · spec §4.2 · decision 3 ("§6 decision 3") | 1.1 · 1.1 · 1.2 · 1.2, 6.1 · 1.3 |
| decision 4, R12 · named exception, "as extended by 2b-R7" | 2.1–2.3, 2.5 · 2.4 |
| decision 5 · "§5" (lost turn writes no row) · 4C's "ruling 14" (lost-turn rule) | 3.1 · 3.2 · 3.2 |
| decision 6 · spec §6.1 (locked L; inventory) · §6.2 move, don't improve (4B/4C "R1") · §6.3 | 1.4 · 1.4, 4 · 3.3 · 1.5 |
| decision 7 · spec §4.3 · decision 8, stage 2b-ii · decision 9 ("as amended 2026-10-17") | 5 · 5 · 10 · 6.1–6.3 |
| decision 10, R13 · decision 11 · decision 12, R11, spec §7.0 · spec §4.4 · consequences (glue) | 1.6 · 13.1 · 7.2 · 4, 12 · 1.5 |
| Amendments to prior ADRs (0029, 0028, 0014, 0011) | 12.1–12.4 |
| 2026-10-13 stage 2a | 6.2, 6.4, 6.6, 7.1–7.4, 8.1–8.2, 9.1 |
| 2026-10-17 `memory.kind` | 6.1, 6.5, 12 |
| 2026-10-20 stage 2b-i, 2b-R7, 2b-R8, 2b-R15, ruling 14 (`JEV_PAGED_ELSEWHERE`) | 2.4, 7.5, 7.6, 9, Consequences |
| 2026-10-28 clean room, spec §8.3, P8 · Stage 4A, §8.3 Decision 1-A, B20 | 11.1 · 11.2–11.3 |
| spec §4 (decision model) · §5.1 runner · §5.2 ledger · §5.3 `turn.handler` detail table · §5.4 no off switch | 1.1–1.2, 5 · 1.2, 3.1 · 3.1 · 3.1 and the `turn.handler` row of the entry table (Jev's side: ADR 0033 H4) · 1.6 |
| spec §7.1 injection · §7.2 trust · §7.3 settle · §7.4 improve.route · Stage 4B spec §5 | 7.1 · 8 · 9 · 10 · 4 (`approval.bind`, `secret.redact`), 3.3 |
| "fuzzed 2026-10-13: 50 000 random tokens" (R11 residual) | Consequences (accepted residuals) |
| spec §10.1 (the ADR draft; "the one exception ADR 0030 names (§10.1)") · §10 (memory-write spec's ADR section) | 2.4 · 6.1 |
| 4B spec "`:630`" (0030's superseded "`approval.bind` … no module" line) · 2b-ii spec "line 365" | 4 (`approval.bind`), History 2026-10-29 · History 2026-10-22 |
| loud-degradation spec "(W7)" (the ADR 0030 amendment task) | 8.3–8.5, 13.3 |
| 2026-10-29 4B (B14, E8) · 2026-10-30 4C (B9, B23) | 4, 1.5, 3.3, 3.4 · 4, 3.2 |
| slices R1 (A2, A4, A5) · R2 (A1, A7) · R3 (A9, A10) · R4 (D2, D9) · R5 (A23, A25–A27) · R6 (A21, A22) | 4, 4.1, 3.2, 2.5 |
| 2026-11-02 carry with an exit (D2-A, D3-A) · 2026-11-03 chat is for Paco | 8.3–8.5, 13.3 · 13.2, 13.3 |
