# Decision ladder — every Houge decision on one list, judged inside the loop, improved from outcomes

- **Date:** 2026-10-12 · **Rev 1** · **Status:** draft, awaiting spec review (senior against the live system + codex)
- **Decider:** Paco. Design approved section by section in chat on 2026-10-12.
- **Proposes:** ADR 0030 "Decision ladder" (§10). Amends ADR 0029 (front door becomes an entry; the Jev rule restated),
  0028 (D5 tap-free local writes and D12 shell outside the wall become conditional), 0014 (an injection judge before
  the reader), 0011 (`src/decisions/` joins the protected surface).
- **Inputs:**
  - research [2026-10-12-in-loop-decisions](../research/2026-10-12-in-loop-decisions/00-synthesis.md): mu's 38
    decision points read at `qybaihe/mu@faed8c3`; Houge's 85 in-loop decisions with file:line at `main@1585105`;
  - an omp 18.7.0 source read on 2026-10-12 (§3.3; archived at
    [`12-omp-judgment-probe.md`](../research/2026-10-12-in-loop-decisions/12-omp-judgment-probe.md));
  - a `VACUUM INTO` copy of the live DB taken 2026-10-12 (§5.2, §8.3).
- **Builds after:** Jev decision tree stage B (`1585105`, merged and pushed 2026-10-12).

## 1. Why

Houge makes about 85 decisions between a Telegram message and the delivered reply (research `11-`). They are
85 hand-written branches with 85 logging styles and 85 implicit failure directions. Jev decides one of them, at the
front door, and "S1 shortcut, else S2 planner" became the architecture. Paco called that tree stiff, and rejected
adding judges on top of it as a patch (2026-10-12): "not only a band-aid on top of the 'if not S1, then S2' model".

The research found the middle of the turn is full of code rules but blind in five places. Each was checked by hand in
code:

- **G1.** Tool output is screened for injection only on four read tools, and that flag only adds a note.
- **G2.** "Done" is never verified.
- **G3.** There is no loop detection beyond the 40-call cap and the clocks.
- **G4.** Output is trimmed by size, not relevance.
- **G5.** Notify-now-or-later is never decided.

Learning paths are each wired to one trigger, and nothing measures whether an improvement worked.

This spec changes the shape:

1. **One decision model.** Every decision is a registry entry with a ladder of deciders: code rule → Jev → model →
   Paco. It is measured by outcomes.
2. **Judges inside the loop at checkpoints Houge already owns.** Houge's omp extension forwards `tool_result` and
   `session_stop` to Houge over the bridge. The Jev key stays in the main process, and every verdict is ledgered and
   calibrated.
3. **Improvement as a decision.** Every correction, review tap or failure goes through one entry that routes it to
   whatever it points at: a fact, a lesson, a skill, a ladder move, a schedule, a tool gap. Each improvement is then
   measured by whether its signal recurs.

The S1/S2 split survives as one entry, `turn.handler`, whose ladder is
ack rule → Jev tree → Tiny cascade → planner.

## 2. Paco's rulings (2026-10-12)

| # | Ruling | Where |
|---|---|---|
| R1 | The first slice proves the new shape (decision record plus ladder), not only safety or correctness | §1 |
| R2 | **Full migration** (approach B): every decision moves onto the list, for a clean end state | §6 |
| R3 | First new entries: injection on tool results, done/stopped-halfway, turn-wide trust level, plus a self-evolution decision. The loop rule was not picked; it goes to the backlog (§11). | §7 |
| R4 | A self-evolution "yes" may **start skill authoring on its own** | §7.4 |
| R5 | "Every correction or review from me, or anything the daily review picks up, should help Houge improve on something", not only skills and tools. Folded in as `improve.route`. | §7.4 |
| R6 | **All new judges armed at ship.** A daily summary surfaces anything wrong or unsure for Paco to decide. | §8 |
| R7 | Review: a daily digest plus urgent cards | §8.1–8.2 |
| R8 | "After 3 straight approvals" of the daily Alishan search, Houge stops asking. This becomes standing approvals, in stage 4. | §8.3 |
| R9 | SP4 items and parked ideas are written down, not lost | §11 |
| R10 | ADRs are reviewed continually: "don't take ADR as bible" (the ADR 0015 lesson) | §10.3 |

## 3. Facts that bind the design

### 3.1 Houge today (research `11-`, `main@1585105`)

- **Five stages.** Before the model (A1–A28), at the bridge before a tool (B1–B25), after a tool (C1–C8),
  supervision (D1–D12), turn end (E1–E12).
- **Jev decides only `turn.handler`** (A12–A18). Its rows go to `jev_decisions` (raw per-call answers) and
  `jev_verdicts` (routing plus outcome).
- **The only model judgment on the loop itself** is the quarantined reader and its `contains_instructions` flag
  (`core/quarantine.ts:97`, a note only).
- **Unread state:**
  - the budget zone is computed and never read (`budget/budget-ledger.ts:26`);
  - `stop_condition` and `eval_hooks` are contract data with no consumer (`contracts/task-contract.ts`);
  - budget exhaustion denies each call but does not end the turn (`budget-ledger.ts:20-23`).
- **A message arriving while an approval card waits is steered into the turn.** It never resolves the card
  (`omp/planner-supervisor.ts:288-293`).

### 3.2 mu (research `10-`)

- mu has 38 points in five groups. Its README says: "Rules are the floor: a dangerous-looking command is caught by
  rules first, and the judge only vouches that you asked for it."
- **Six rules:**
  1. rules first;
  2. three zones plus an escape answer;
  3. fail open, except safety gates fail closed to asking the user;
  4. append rather than rewrite;
  5. errors are cheap and reversible;
  6. everything is ledgered.
- **Measured numbers:**
  - injection wording: 70/79 planted attacks caught, 0/1,520 clean passages withheld;
  - completion and continue are split questions (combined 0.79 vs split 0.29);
  - output admission dropped 0 of 2,412 live blocks while spending about 54% of judge input.
- **Its retrospective:** local positive effect, no proof of net benefit; link verdict → action → outcome per point.
- **Correction:** mu never says "no fast path bypass". An earlier chat claim was wrong (research `00-`).

### 3.3 omp 18.7.0 (source read 2026-10-12; extension hooks verified first-hand)

- **omp has four TypeSafe judge points:**
  - unexpected-stop (yes/no on the last assistant text, 0.5, up to 3 retries, 4 s);
  - auto-thinking;
  - judged rules;
  - the `find` tool.
- **None fires in Houge's spawn today.** `features.unexpectedStopDetection` defaults to `mechanical`, and Houge passes
  a fixed `--thinking`.
- **Their verdicts are invisible:**
  - no RPC or extension event carries the question or the probability;
  - session JSONL `model_usage` rows hold tokens and cost only.
  - That is why this spec does not use them (§9.2). The Jev key's location is not the reason (R10).
- **Extension hooks Houge can use:**
  - `session_stop` (`extensibility/shared-events.ts:109-120`) fires when a main-agent turn is about to settle.
    - Its handler may return `{continue: true, additionalContext}` or `{decision: "block", reason}`; that is one
      continuation.
    - The event carries `stop_hook_active` and `last_assistant_message`.
  - `tool_result` handlers may rewrite a result before the model sees it.
  - `tool_call` may block or rewrite (Houge already uses it for the built-in gate).
- **The `todo` tool keeps phased tasks** (pending / in_progress / completed / abandoned / blocked).
  - Visible through RPC `get_state.todoPhases` and through hooks.
  - Houge's spawn `--tools read,edit,write` (`omp/planner-session.ts:19`) leaves it out.
- **RPC behaviour of the hooks was inferred from shared session code, not run.** §12 makes it a probe before code.

## 4. The decision model

### 4.1 Entry

Each decision is one entry in `src/decisions/registry.ts`:

```ts
type Rung =
  | { kind: "rule"; decide: (s: State) => RuleAnswer }          // answers or abstains
  | { kind: "jev"; question: JevQuestion; bars: BarRef }         // calibrated; abstains below bar
  | { kind: "model"; role: "tiny" | "fast"; prompt: PromptRef; timeoutMs: number }
  | { kind: "paco"; surface: "card" | "approval" | "review" };   // asynchronous

interface Entry<State, Verdict> {
  id: string;                      // stable, e.g. "tool.shell_class"
  version: number;                 // bumped on any wording, rung or bar change
  stage: "intake" | "pre_model" | "pre_tool" | "post_tool" | "supervision" | "settle" | "after_turn";
  question: string;                // what is decided, in words
  verdicts: readonly Verdict[];    // closed set, always including an escape value
  ladder: readonly Rung[];         // first confident answer wins
  fail: Verdict;                   // what happens when no rung answers (timeout, outage, throw)
  monotone?: { order: readonly Verdict[] }; // later rungs may only move toward the cautious end
  locked?: true;                   // no rung added, no ladder move, no off switch
  defaultVerdict: Verdict;         // the routine answer (tallied, §5.2)
  alwaysRecord?: true;             // full row every time
  outcomes: readonly OutcomeSignal[];
  armed: Partial<Record<Rung["kind"], "on" | "shadow" | "off">>;
}
```

**Rules:**

- **Code goes first.** A confident rule answer ends the walk, and no model is asked.
- **Monotone.** For a monotone entry, a later rung's verdict is applied only if it is at least as cautious as the
  verdict so far.
- **Jev never opens a gate.** On a monotone entry, a Jev or model rung can tighten only. On any non-monotone entry
  that gates an action, Jev may not be a rung. The registry test enforces both.
- **Shadow rungs.** A `shadow` rung is asked and recorded, but its answer is not applied.
- **Locked entries** refuse ladder changes in code (registry test) and at run time (`ladder_moves` refuses them).
- **Escape value.** Every Jev question includes one (`unclear` / `other`), per mu rule 2.

### 4.2 Rungs

| Rung | Decides when | Time bound | On abstain or failure |
|---|---|---|---|
| rule | its function returns an answer | synchronous | next rung |
| jev | p clears the entry's bar for (question, criteria hash, model, lang), as in ADR 0029 | per entry, default 1.5 s | next rung. Outages open the existing Jev incident. |
| model | a validated closed answer | per entry | next rung |
| paco | Paco taps | the surface's own expiry | `fail` |

### 4.3 Ladder moves

- **What a move is.** A move changes who decides. It is a `ladder_moves` record:
  - entry id and scope (for example, one action fingerprint);
  - from rung and to rung;
  - evidence (decision ids);
  - granted by (`paco` | `auto`);
  - revocable flag, state, created and ended times.
- **Moves Houge may make on its own (authorised by this spec):**
  - standing approvals (§8.3);
  - skill authoring after a pattern (§7.4);
  - lessons through the existing save path, with Undo.
- **Every move that loosens caution is a proposal for Paco's tap:**
  - trusting a source;
  - retiring a judge;
  - lowering a bar.

### 4.4 The front door as an entry

`turn.handler` (verdicts `answer | lookup | memory | status | planner`) runs this ladder:

1. the ack rule (`jev/tree-policy.ts:35-39`);
2. the Jev tree (A14–A17);
3. the Tiny cascade (A18).

The planner is its `fail` value. `turn.gear` (role and effort, A16) is a separate entry with the same Jev call. The
stage A and B behaviour is unchanged; §9.1 proves parity.

## 5. Runtime and ledger

### 5.1 Runner

`src/decisions/decide.ts`:

- **`decideSync(entry, state)`** for all-rule ladders. Hot paths such as the bridge path gate and the shell
  classifier stay synchronous.
- **`decide(entry, state, ctx)`** for ladders with a Jev, model or paco rung.

Both functions:

- walk the ladder, apply the monotone rule, and record the result (§5.2);
- return `{ verdict, rung, p?, reason, decisionId }`;
- turn a thrown rule, a timeout or an outage into an abstention, so `fail` decides, never an accident.

The runner is under 50 lines per function, and does no I/O beyond the ledger write and the rung calls.

### 5.2 Ledger

These tables replace `jev_verdicts`:

- **`decisions`**: one row per decision that matters. A full row is written when:
  - the verdict differs from `defaultVerdict`; or
  - a rung beyond the first rule answered or was asked in shadow; or
  - Paco was involved; or
  - the entry is `alwaysRecord`.

  Columns:
  - `decision_id`, `entry_id`, `entry_version`;
  - `run_id`, `tool_call_id?`;
  - `stage`, `rung`, `verdict_json`, `p?`;
  - `fallback_reason?`, `armed_mode`, `latency_ms`;
  - `jev_decision_id?` (FK to `jev_decisions`, kept as the raw per-call record that calibration needs);
  - `state_hash` (sha256 of the state; **never the state text**, per the lessons.md rule "the ledger never holds read
    text");
  - `created_at`.
- **`decision_tally`**: routine decisions, one row per run. Holds `counts_json` by entry and verdict.
- **`decision_outcomes`**: `outcome_id`, `decision_id`, `signal`, `value`, `source`, `created_at`.
- **`ladder_moves`** (§4.3).

**Volume (DB copy, 30 days to 2026-10-12):**

- 159 turns, 5.3 a day;
- 369 tool calls, 4.7 per tool-using turn, at most 22.
- Full detail would be about 100 rows per turn. With the two grades it is about 10–15.

**Retention:** full rows and outcomes are kept. Tally rows older than 90 days fold into daily counts.

**Migration:** the 10 `jev_verdicts` rows move into `decisions` and `decision_outcomes`, and the table is dropped. The
`houge jev replay`, `triage-report` and calibration commands read the new tables.

### 5.3 Off switch

`HOUGE_DECISIONS_OFF=<entry id,…>` sets the named entries' non-rule rungs to `shadow`. It is read at boot and on
`/rearm`.

- `HOUGE_JEV_LANES_OFF` stays, as an alias for `turn.handler` lane verdicts.
- Locked entries ignore the switch, and boot logs a warning that names them.
- Documented in `configuration.md`.

## 6. Migration (full; ruling R2)

### 6.1 What becomes an entry

**Test:** a condition changes the turn's path, and an outcome could show the answer was wrong. Everything else is
mechanics and stays plain code.

**Entries** (inventory row → entry id; L = locked):

| Stage | Entries |
|---|---|
| intake | A1 `intake.sender` L · A2 `intake.rate_limit` · A4 `intake.rating_reply` · A5 `intake.budget_fuse` · A9 `intake.steer_or_queue` · A10 `intake.bare_ack` |
| pre_model | A7 `turn.contract` · A12–A15, A17 `turn.handler` · A16 `turn.gear` · A18 is a rung of `turn.handler` · A19 `memory.rule_save` · A21 `lookup.rewrite`, `lookup.thin` · A22 `turn.model` · A23 `context.lessons` · A25 `context.recall` · A26 `context.catch_up` · A27 `turn.clarify_cap` |
| pre_tool | B2+B7 `tool.manifest` · B6 `posture.kill` L · B9 `memory.correct_preflight` · B10+B19 `tool.policy` · B11 `tool.shell_class` · B12–B13 paco rung of `tool.policy` · B14 `approval.bind` L · B15 `tool.budget` · B16+B17 `tool.path` L · B22 `fetch.ssrf` L · B23 `memory.lesson_admit`, `schedule.admit` · B25 `selfwrite.guard` L |
| post_tool | C1+C4 `tool.wall` L (which tools cross the reader) · C3 `reader.family` · new `tool.injection` (§7.1) |
| supervision | D2 `planner.crash_guard` · D9 `turn.retry` |
| settle | new `turn.settle` (§7.3) · E2+E11 `attach.path` L · E8 redactor `secret.redact` L · E12 `notify.page` |
| after_turn | new `improve.route` (§7.4) · new `turn.trust` lives across stages (§7.2) |

**Mechanics** (stay code): A3 command dispatch · A6 idempotency · A8 dispatch refusals · A11 media ingest · A20 and
A21 lane bodies (handlers, not decisions) · A23 restart-on-fingerprint · A24 session reset · A27 seed, restart note,
quote resolution · A28 pin · B1, B3–B5, B8 validation · B18 Seatbelt (an OS floor, outside the runner) · B20 tool
timeout · B21 replay memo · B24 text hygiene · C2 (superseded by `tool.injection`) · C5–C8 · D1, D3–D8, D10–D12 ·
E1, E3–E7, E9–E10.

The plan's first task re-walks the inventory at its base commit and fixes this table. A row moved between columns
carries its reason in the plan.

### 6.2 Move, don't improve

For every migrated entry:

1. **Pin.** Characterisation tests from a table of inputs and today's outputs.
   - Coverage is extended where thin. `tool.shell_class` gets a command corpus covering every pattern in
     `omp/command-matcher.ts` and every known miss in ADR 0028's residuals.
   - `tool.path` gets a path corpus covering every `gate-path.ts` form.
2. **Wrap.** The existing function, unchanged, becomes rung 1.
3. **Route.** The call site goes through `decide`/`decideSync`.
4. **Differential.** In tests, old function and entry run over the same corpus; results must match exactly. The pinned
   tests stay green.
5. **Only then** can an improvement ship, as a new entry version with its own review.

### 6.3 The registry is protected surface

If the registry decides the gates, editing it can open a gate. `src/decisions/` joins `PROTECTED_DIRS` in
`capabilities/self-write-guard.ts`, in stage 1: Paco's hand only. The guard's existing test gains a case: a self-write
diff touching `src/decisions/` is hard-denied.

## 7. New entries (stage 2; all armed at ship, R6)

The starting bars come from measured sources (mu's injection wording, omp's stop threshold), not Houge calibration. The
review surface (§8) is the net. Each entry ships with its bar recorded in the registry, and its first 14 days are
reported in the digest.

### 7.1 `tool.injection`: does a tool result carry instructions aimed at the AI?

- **Where.**
  - **Shell:** Houge runs `bash` through the bridge, so it judges the output there, before returning it.
  - **The four wall tools:** judged on raw bytes, before the quarantined reader.
  - **Built-in `read`:** Houge's extension hooks `tool_result` and asks over the bridge (probe P1).
- **Rung 1 (code): judge or pass?**
  - **Judge:**
    - wall tools;
    - shell output whose command `tool.shell_class` labelled network-touching (`shell_external`, or a fetch pattern);
    - a built-in read of a file under the chat workspace, `/private/tmp` or `~/Downloads`.
  - **Pass:** everything else (tallied).
  - The rule also withholds passages matching a fixed list of injection phrases (the floor).
- **Rung 2 (Jev).**
  - One `noul` per passage of about 900 characters, batched 16 per request, up to 96 passages.
  - Wording ported from mu (MIT, attributed in the source file).
  - p > 0.5 withholds the passage, replaced with `[withheld: text aimed at the assistant]`.
- **Monotone** (`pass < withhold`). **Fail:** the code floor's answer, which is never worse than today. **Always record.**
- **Outcomes:** review taps; Paco marking a withheld source trusted (a proposal; §8.3).
- **Effect on `turn.trust`:** any withhold raises the turn to hostile.

### 7.2 `turn.trust`: turn-wide trust level (code, locked)

- **Levels:**
  - `clean`;
  - `untrusted`: a wall tool, network shell output, or an outside-content file read entered the turn;
  - `hostile`: `tool.injection` withheld something.
- The level only rises within a turn, and is held on the active turn object.
- **Effects** feed `tool.policy` as an extra input:
  - **untrusted:** a tap is required for
    - `memory_correct_write`;
    - `lesson_write`;
    - `schedule_task`;
    - `self_write_propose`;
    - `skill_author`.
    - This generalises today's `tainted_turn` rule (B9).
  - **hostile:** additionally, every side effect needs a tap, including plain shell and `fs_write` (today tap-free,
    D5).
- **Standing approvals (§8.3) still apply at any level.** They match a byte-identical fingerprint, so a steered planner
  cannot produce a different effect under one.
- The approval card states why it asks: "this turn read text aimed at the assistant".

### 7.3 `turn.settle`: done, or stopped halfway?

- **Where.** Houge's extension handles `session_stop`, asks Houge over the bridge, and returns
  `{continue: true, additionalContext}` or nothing (probe P2).
- **Rung 1 (code):**
  - **Claims check.** The reply claims an action, by a fixed zh/en verb list mapped to tools:
    - scheduled / 已安排 → `schedule_task`;
    - saved / 已保存 / 记住了 → `lesson_write`;
    - attached / 附上 → an `[[attach:]]` line;
    - sent / 已发送 → an external write.
    - If no matching successful call happened this turn, send back with "You said you scheduled it, but no
      `schedule_task` succeeded this turn."
  - **Todo check.** `todo` phases with pending or in_progress items → send back (probe P3; it simply never fires if the
    planner does not use `todo`).
  - **Contract.** The contract's `stop_condition` is quoted in the note: its first consumer.
- **Rung 2 (Jev), four split `noul` questions:**
  - claims done?
  - acted or edited but verified nothing?
  - ends on a promise ("next I'll…")?
  - asks permission for work Paco already asked for?
  - Bar 0.5 (omp's unexpected-stop threshold).
- **Effect:**
  - at most one send-back per turn (`stop_hook_active`);
  - the note always says "a step that needs Paco's approval is asked for, not done";
  - never sent back on a turn whose last tool call was denied or expired.
- **Fail:** open (settles as today). **Always record.**
- **Outcomes:**
  - Paco's next message sorted as a correction or complaint by `turn.handler`;
  - a rating;
  - review taps;
  - a second unverified settle (urgent card, §8.2).

### 7.4 `improve.route`: what does this signal point at? (rulings R4, R5)

**Where:** after the turn, in the background. It never delays a reply.

**Signals in** (each a `decision_outcomes` row or a code-detected event):

- Paco's corrections, as sorted by `turn.handler`;
- Dig deeper taps;
- review ❌ and unsure taps;
- approval denials and expiries;
- ratings;
- `turn.settle` send-backs;
- planner failures and incidents;
- recurrence: the same kind of request (same category, and request cosine ≥ the relevance gate, A25) three times in
  14 days;
- abandonment: Paco re-asks within 10 minutes of a reply;
- a lesson recalled 8 times and never followed (mu's `memory.applied`, read from attribution).

**Rungs:**

1. **Code.** Exact mappings:
   - an approval streak → `ladder` (§8.3);
   - expiries at the same scheduled hour twice → `schedule`;
   - recurrence → candidate `skill`.
2. **Jev.** Choice over the targets below, with `nothing` as the escape. The state is the signal plus the turn's
   category and tool summary, never raw text.
3. **Tiny model.** Below the bar, a one-word choice among the top two, as the `turn.handler` cascade does.

**Targets and handlers:**

| Target | Effect | Handler |
|---|---|---|
| fact | proposal card | `memory_correct` path, as today |
| lesson | applied, announced with Undo | `lesson-write` save path, with its backstop and caps |
| skill | **authoring starts on its own** (R4) after the recurrence pattern; urgent card | `skill_author` via the evolution lane; Gate A (`skill-router.ts`) re-checks inside |
| ladder | standing approval: auto (§8.3); anything that loosens: proposal | `ladder_moves` |
| schedule | proposal card (move the time, or a standing approval) | `schedule_task` edit after a tap |
| tool gap | digest line; self-write only on Paco's tap | `self_write_propose` |
| nothing | recorded | — |

**Measuring each improvement.** Each improvement is itself a decision row whose outcome is checked:

- **A lesson** from correction X is flagged when a correction routed to the same lesson scope recurs within 30 days.
  The digest proposes a rewrite or retirement.
- **A skill:** usage and re-verification (`skill-reverify.ts`).
- **A standing approval:** revocations.

**Safety rules:**

1. A pattern is needed before behaviour changes. A single signal is recorded only. The exception is an explicit stated
   rule, which saves first as it does today.
2. Effect follows target risk, as in the table. Locked entries and protected files are never targets.
3. **Gaming watch.** The digest tracks the ask rate (assistant turns with `intent=clarify`), abandonment and correction
   counts over 7 days, side by side. The clarify cap (A27) stays.
4. **Rate limit:** at most 3 automatic improvements a day. The rest wait for the next day's digest.

## 8. Review surface and ladder moves

### 8.1 Daily digest

- **When:** one Telegram message a day at `HOUGE_DECISION_DIGEST_AT` (local time, default `21:00`). It goes through the
  rich renderer, and is skipped when empty.
- **Content, in order:**
  1. **Unsure verdicts:** up to 8, p within 0.15 of the bar.
     - Each shows the entry, a code-built one-line description (no tool text), and ✅ / ❌ buttons.
     - Callback `dec:rv:<decision_id>:<ok|bad>`.
  2. **Improvements made today,** each with its evidence and an Undo or Revoke button.
  3. **Proposals waiting:** bars, schedule times, model routes, tool gaps, trusted sources. Accept / Dismiss.
  4. **Counts:** per entry, acted, by rung.
  5. **Gaming watch** (§7.4 rule 3).
- **Taps:**
  - a tap writes a `decision_outcomes` label and feeds `improve.route`;
  - silence writes nothing;
  - a callback for an unknown or stale id answers "already handled" and writes nothing.

### 8.2 Urgent cards

Sent through the outbox straight away:

- skill authoring started, and finished or failed;
- a standing approval granted;
- `turn.trust` reaching hostile in a live turn (the approval card carries the reason);
- a `turn.settle` send-back that still settled unverified;
- an entry falling back to `fail` three times in an hour. This is incident `decision_fallback:<entry>`, which pages
  once per open incident (E12) and resolves on the next answered call.

### 8.3 Standing approvals (stage 4; ruling R8)

**Measured** (DB copy, 2026-10-12):

- The daily Alishan search's approvals share one fingerprint (`a0362e7ddf…`) across schedule and Telegram runs:
  5 consumed, 2 expired at the 11:00 schedule hour.
- On 2026-10-09 and 2026-10-10 Paco re-ran it by hand ("手動查一次", "查").
- Approval totals: `shell_external` 19 consumed / 2 denied / 5 expired; `shell_destructive` 2 consumed;
  `memory_correct_write` 6 consumed.

**Entry:** `approval.standing` is a rule rung placed before the paco rung of `tool.policy`'s approval path.

**Grant:**

- 3 consecutive `consumed` approvals of one `action_fingerprint`:
  - `expired` neither counts nor resets the streak;
  - `denied` resets the streak and blocks a grant for 30 days.
- Never for `destructive` or `paid` side effects, or `memory_correct_write`.
- On grant:
  - a `ladder_moves` row (`granted_by: auto`);
  - an urgent card: "From now on I'll run *<action label>* without asking", with a Revoke button
    (`dec:sa:<move_id>:revoke`).

**Use:**

- A matching fingerprint consumes no card.
- It writes a decision row (`rung: rule`, `reason: standing:<move_id>`).
- Re-validation (B14) still runs.
- The kill switch overrides everything.

**End:** revoke, a deny of the same fingerprint, 30 days unused, or `/standing revoke <n>`. `/standing` lists the
active ones.

## 9. Things decided against (with reasons, so they are not rediscovered)

1. **Judge approval** (mu `tool.approval`). Approval stays Paco's or a Paco-authorised standing rule. A judge must not
   open a gate (§4.1).
2. **omp's built-in judges.**
   - Their verdicts are not observable (§3.3), so they cannot be ledgered, calibrated or reviewed.
   - It is not about the key: the child already holds subscription logins (`~/.omp` readable, ADR 0028 D11), worth more
     than a Jev key.
   - Revisit if omp emits verdict events.
3. **Prompt hints** (mu `input.preflight` hint). The stage A spec, Appendix B, rejected them, and the reason still holds:
   the planner has the full message, and a wrong hint steers it.
4. **Judge-driven rewind** (mu `turn.rewind`). Houge cannot undo tool side effects.
5. **Relevance trimming of tool output** (mu `tool.admission`). mu's own numbers show no drops in live use. Revisit if
   long outputs show up in the ledger.
6. **Migrating all 85 points.** Mechanics stay code (§6.1). Clean means every decision, not every branch.

## 10. ADR 0030 and ADR hygiene

### 10.1 ADR 0030 "Decision ladder" (Paco's hand; `docs/decisions/` is protected)

The registry, ladder, ledger, runner and locked entries; the monotone rule restated as "a Jev or model rung can only
tighten a monotone decision and never opens a gate"; ladder moves and what Houge may move on its own; improvement as a
decision.

It amends:

- **0029:** the front door becomes `turn.handler`; "never gates an action" restated.
- **0028:** D5 tap-free local writes become conditional on `turn.trust`; D12 network shell output gets
  `tool.injection`.
- **0014:** an injection judge before the reader.
- **0011:** `src/decisions/` is protected.

**AGENTS.md:** the Invariants sentence on Jev needs Paco's edit to match.

### 10.2 What ADR 0015 still decides here

The Jev key stays in the main process, and the child asks over the bridge. This is chosen on its merits: one ledger and
one calibration surface. It is not because ADR 0015 forbids it (R10, §9.2).

### 10.3 ADRs are reviewed continually (ruling R10)

- **Template.** `docs/decisions/` gains two fields, starting with ADR 0030:
  - **Assumptions:** the facts each decision rests on, each one checkable;
  - **Revisit when:** concrete triggers, such as a new component, a measured number moving, or a vendor change.
- **Citing rule** (CONTRIBUTING.md and `tasks/lessons.md`). A spec or plan that rules an option out because of an ADR
  must state the ADR's reason and why it still holds on today's system. Otherwise it reopens the question. Spec
  reviewers check every cited ADR constraint this way.
- **Backfill.** Assumptions and revisit triggers for ADRs 0001–0029 are a tracked backlog task (§11), not part of this
  build.

## 11. Nothing lost (ruling R9)

When this spec lands, `tasks/todo.md` and `docs/ROADMAP.md` gain these entries, each pointing to its source section:

- **SP4:**
  - automatic recalibration of decision bars from outcomes;
  - model-route changes from evidence;
  - goal record and verifier;
  - outcome memory past §7.4;
  - `goal.met` / `board.read` (mu).
- **Plain-code backlog** (research `00-` "Plain-code gaps"):
  - the loop rule: same call × 3, and a "wrap up now" note when the budget turns red (not picked, R3);
  - a typed stop word denying a waiting approval card;
  - refusing a re-request of an action Paco denied this turn;
  - a cap on the supervisor queue.
- **mu parked points** (stage A spec Appendix A, plus research `00-`): `notify.routing` (lane 4), `tool.admission`,
  `turn.drift`, `task.frame`, `input.interjection`, `tool.constraint`.
- **ADR backfill** (§10.3).

## 12. Probes before code (the spec review runs these against the live system)

| # | Question | Pass |
|---|---|---|
| P1 | Does omp's `tool_result` fire for built-in `read` in RPC mode, wait for an async handler, and apply a rewrite? | a probe extension rewrites a read result and the model's next frame shows the rewritten text |
| P2 | Does `session_stop` fire in RPC mode? Do `continue` and `additionalContext` send the model back once? Does `stop_hook_active` stop a second pass? | a probe turn continues exactly once |
| P3 | Is `todo` state readable mid-turn via `get_state`? Does the planner use `todo` under Houge's system prompt? | `todoPhases` read on a probe turn; usage rate on 5 real-shaped prompts recorded |
| P4 | Hook time limits: how long do omp and Houge's bridge wait for a hook before giving up? | a measured limit of ≥ 3 s, or a design change |
| P5 | Jev volume and quota: about 20–40 extra calls a day (about 6 external reads, about 5 settles, plus `improve.route`) | within TypeSafe limits at 10× |
| P6 | `jev_verdicts` → `decisions` parity: replay over all past turns gives identical `turn.handler` verdicts | 0 mismatches |

## 13. Build stages

Four stages. Each gets its own plan, per-task reviews, final reviews, a live gate, a docs sync and Paco's merge where
protected files are touched.

| Stage | Contents | Protected files | Live gate PASS |
|---|---|---|---|
| 1 Engine + door | registry, runner, four tables, migration of `jev_verdicts`, `turn.handler` + `turn.gear` migrated, digest skeleton, `src/decisions/` protected, off switch | self-write-guard, run-store, core-worker | P6 parity: 0 mismatches over all past turns; digest renders on the DB copy; `jev_verdicts` rows migrated 1:1 |
| 2 New entries | `tool.injection`, `turn.trust`, `turn.settle`, `improve.route`, extension hooks, `todo` enabled (record-only), urgent cards | bridge-handler, planner-supervisor, policy (trust input), planner-session | planted instructions (fetched page, network shell output, downloaded file) withheld, and real clean outputs pass; that turn reaches hostile and a plain shell call asks; a "scheduled" claim with no call is sent back once; past corrections from the DB copy route to the expected targets; 3 similar synthetic turns start authoring on the copy |
| 3 Unprotected families | intake, context, supervision and settle entries migrated | some (core-worker, supervisor) | differential: each entry's corpus identical old vs new; full suite and existing gates green |
| 4 Protected families + standing | `tool.policy`, `tool.shell_class`, `tool.path`, `approval.bind`, `selfwrite.guard`, `fetch.ssrf`, `posture.kill`, `secret.redact`; `approval.standing` | policy, bridge, self-write-guard, gate-path, command-matcher | differential: command corpus, path corpus and policy matrix identical; 3 approvals on the copy → grant → the 4th runs without a card → a deny revokes; a destructive action is never granted |

**Gate rule.** A gate fails on silent degradation. A Jev call that was skipped makes a case INCONCLUSIVE, never PASS.

## 14. Risks

| Risk | Mitigation |
|---|---|
| A migrated safety gate changes behaviour | move-don't-improve; corpus differential tests; protected stages last; Paco's merge |
| Hooks behave differently in RPC mode | probes P1–P4 before code; shell and the wall tools judged inside Houge, needing no hook |
| Armed judges misfire with uncalibrated bars | monotone judges only tighten; settle sends back at most once and fails open; digest plus urgent cards; `HOUGE_DECISIONS_OFF` |
| Self-improvement drifts (gaming, noise) | pattern before action; rate limit; gaming watch; every improvement measured and revocable |
| Ledger growth | two grades plus tally folding (§5.2) |
| Scope (four stages) | each stage leaves Houge working on its own; stage 2 delivers value before the long migration |

## Appendix A. Turn flow after stage 4

```
message → intake.* → turn.handler ──lane──→ handler → reply
                         │
                         └─planner→ turn.gear, turn.model, context.* → omp turn
                                       │  each tool call: tool.manifest → tool.policy (+turn.trust, approval.standing,
                                       │                  paco rung) → tool.shell_class / tool.path → runs
                                       │  each result:    tool.injection → tool.wall → back to the model
                                       └─ settle:         turn.settle (send back once?) → attach.path → secret.redact → reply
after the turn: improve.route over the turn's signals → lesson / fact / skill / ladder / schedule / tool gap
daily: digest (unsure, improvements, proposals, counts, gaming watch) → Paco's taps → decision_outcomes
```
