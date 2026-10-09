# Jev decision tree, stage B — the `answer` and `lookup` lanes

**Rev 2, 2026-10-10.** Parent: `2026-10-06-jev-decision-tree-design.md` (Rev 9), whose §3 table defines the two lanes and
whose §10 names this stage. Everything the parent fixes (questions, bars, roles, the planner lane, ledger shape, safety
nets) stays as built in stage A; this spec adds only what the two lanes and the three stage A leftovers need. ADR 0029
governs; ADR 0014 (the reader wall) and ADR 0028 (omp) bind. §15 is the review log.

## 0. Scope

- The **answer lane** and the **lookup lane**: code owns the steps, one one-shot on the Fast role composes, no planner
  session, no tools in the model's hands.
- **The catch-up block** (§7): a planner turn that follows lane turns is told what it missed. Without it a lane reply never
  reaches the planner's thread (its thread is the omp session; a lane answers outside it), so a follow-up such as
  "那后天呢？" after a lookup would reach the planner blind. The memory lane has this gap today; at ~30% of turns on lanes
  it would be constant.
- Stage A leftovers owed to stage B (`tasks/todo.md` 2026-10-09): the two-request guard, a dedicated `lane_failed` route
  reason, the original cause kind on a refused-pin step-up.
- Rulings that change earlier ones (§1): the "🔍 Dig deeper" button, taps never disarm, the status lane gets the button.
- A per-lane off switch (§6), because `/disarm` turns off all of Jev and every other flagged capability.
- Out of scope: the `schedule` and `wiki` lanes (stage C), `mail_calendar` (SP2), a typing indicator while a lane runs,
  the research-lane question, the bare-ack rule as a lane (Rev 1 had it; dropped, §13), Jev judges inside the planner loop
  (mu's `tool.injection`, `tool.admission`, `turn.continue`, `turn.completion`, `turn.drift`: the next spec).

## 1. Rulings (Paco, 2026-10-10)

1. **Ship armed.** `CALIBRATED_ROWS` gains `category:answer` and `category:lookup` for zh and en on the Jev model the
   stage A rows name, approved "Paco 2026-10-10", in the same build. Offered alternative (ship dark, arm after a
   lane-simulation report) declined. Evidence shown before the choice: §10. Not shown then, shown now (Rev 2): 34 of the
   86 lane takes ran the planner on **Default** under stage A (gear above light) and move to **Fast** under stage B; Rev 2
   bounds `breadth` on the answer lane (§2), which keeps 8 of them on the planner.
2. **Lookup evidence = the search result set, and the top page only when it is thin** (option 2 of three). Rev 1 sent raw
   snippets to the composing model; ADR 0014 says only the quarantined reader ingests raw `web_search` output, so Rev 2
   runs the result set through the reader wall first (§5). The lookup lane therefore has one more model step than the
   design walk-through said: search → reader → compose, plus fetch → reader on a thin result.
3. **"🔍 Dig deeper"** replaces "Ask Houge anyway" everywhere (Paco: "I am always talking to Houge").
4. **A tap is a correction signal, not a lane fault.** It says Jev sorted *this* message wrongly, or Paco wants more; a
   broken lane is `lane_fallthrough_rate`'s job. No lane is ever switched off by taps, the memory lane included (its wrong
   save has Undo). Three taps on one lane in seven days page Paco (`triage_overrides`, per lane, §6); he raises a bar or
   switches the lane off (§6). Paco: "at the high level you are categorising: shortcuts, and the planner".

## 2. Policy (`src/jev/tree-policy.ts`, pure)

- `Lane` widens to `"answer" | "lookup" | "memory" | "status" | "planner"`. `Armed` gains `answer` and `lookup`.
- **Arming keys**, like `TREE_STATUS_ARM_ID`: `TREE_ANSWER_ARM_ID = "category:answer"`, `TREE_LOOKUP_ARM_ID =
  "category:lookup"`, each at the `category` question's criteria hash, so a `category` row alone never arms a lane and a
  hash or model change disarms both with the rest. `treeArmingRows` includes them. `Armed.answer` / `.lookup` are also
  false when the lane is in `HOUGE_JEV_LANES_OFF` (§6), passed in by the caller.
- **A lane fires when all hold:** the lane is armed and `armed.gear` is true (the limits need the scores); `category`'s
  top is that lane's category at p ≥ `bars.choice` (0.6; no confidence or gap floor: a wrong pick costs a weaker reply
  with a button under it, not a swallowed turn, so the parent §2.4's stricter floors stay with `memory` and `status`);
  `bareAck` is false; `thinkHarder` is false; and the **lane limits** hold on the expected score levels (floats 0–3,
  compared with the existing `EPS`):
  - answer: `actions` ≤ 0.5 (*none*) and `breadth` ≤ 1.5 (*one known thing* or *one topic*);
  - lookup: `breadth` ≤ 1.5 and `actions` ≤ 1.5 (*none* or *one or two reads*).
- **Otherwise the planner, as the parent built it,** with the reason naming why: lane unarmed (or off) → `plannerRoute(top,
  gear, save, "routed")` on the gear's role with the Fast floor (today's path, verbatim); `armed.gear` false → the same with
  `DEFAULT_GEAR` (today); over a limit → `plannerRoute(top, gear, save, "lane_limits")`, the first writer of the reason
  the parent reserved; `bareAck` → `plannerRoute(top, gear, save, "bare_ack_guard")` as `statusBranch` and `memoryBranch` do
  (this is "好" after a proposal: consent, which a lane must not answer); `thinkHarder` → the planner on Thinking as today
  (`plannerRoute` already lifts it).
- **Role and effort** on a lane route: `role: "fast"`, `effort` from `reasoning` as `gearOf` computes it (a `reasoning`
  of *non-obvious analysis* raises the Fast model's effort, never the role).
- **`sets_rule` = yes with a lane category:** `save` is set as today; core-worker saves first (§4 step 0), then runs the
  lane. Not durable or capped → the lane still runs; the card carries the note line.
- **The cascade never enters a lane.** `cascadePlan` keeps removing only `memory` and `status`; `applyCascade` routes a
  picked `answer` or `lookup` to the planner on its role, reason `cascade`, exactly as stage A does.
- **The bare-ack rule (`ACK_ROUTE`) is unchanged**: a "谢谢" after a plain answer still runs the planner on Fast. Rev 1 made
  it a lane; it settles before any Jev call so there is no reported model to arm against, and the replay report replays
  the constant (§13).
- **Two-request guard** (`memoryBranch`): a confident memory lane route (`clearsLane` at 0.85, zone yes) whose `actions`
  expected level is ≥ 1.5 becomes `plannerRoute("memory", gear, save, "two_request")`: the rule is saved and the planner
  answers the rest with the `[memory]` note, instead of the lane's card alone. New `RouteReason` `two_request`. The guard
  reads `actions` only when `armed.gear` (an unarmed score is `DEFAULT_GEAR`, never a guard). Evidence: of the 7 replayed
  turns the memory lane took confidently, none had `actions` ≥ 1.5 (0 false positives) and 3 had `actions` in [0.78, 1.34]
  (a 0.5 threshold would have cost 3 of 7 pure rules); Paco's three "both" labels were not confident `memory`, so the
  existing confidence and gap floors already send them save-then-planner. The gate's `ruleLookup` case (§11) shows whether
  Jev's `actions` score sees the second request; if not, the escalation is a seventh `noul` question ("Besides the rule,
  does `latest_message` ask Houge to do or answer something?") with its own rows and replay: parked (§14).
- **`lane_failed`** joins `RouteReason`: the reason on the `Route` a lane hands the planner when it falls through (today's
  handlers reuse `jev_skipped`). The status and memory lanes move to it too. **Acted or fallback** (`decisionFor`):
  `lane_limits`, `two_request` and `bare_ack_guard` are routes the tree chose and the planner ran → `act`; `lane_failed`
  → `fallback`.

## 3. Where the lanes live

New directory `src/core/lanes/`, hermetic (no store, no process env; everything through deps):

- `lane-compose.ts`: `renderLanePrompt(i: LanePromptInput): string` (§4) and `renderSourcesBlock(digest, sources)` (§5).
- `lane-card.ts`: `laneCard({text, run_id, note?}): {text, buttons}` — the reply, the optional `[memory]` note line, and the
  **🔍 Dig deeper** button (`callback_data` `lane:ask:<run_id>`, under Telegram's 64-byte cap). `memoryLaneCard` keeps Undo
  and takes its second button from here. The parser accepts `lane:ask:` and the legacy `memlane:ask:` (cards already in
  chats keep working); the event stays `memlane_ask`, so `admitMemLaneAsk` and `memLaneAskTurnEvent` are unchanged.
- `answer-lane.ts`: `runAnswerLane(i: LaneInput, d: AnswerLaneDeps): Promise<LaneResult>`.
- `lookup-lane.ts`: `runLookupLane(i: LaneInput, d: LookupLaneDeps): Promise<LaneResult>`; search, fetch, reader and the
  budget are local to this file (codex: keep the abstraction to what the two share).
- Types (`lane-types.ts`): `LaneInput { run_id, chat_id, userText, recentTurns, turnChars, quoted: QuotedTurn | null,
  effort, verdict_id, note: string | null, signal, deadlineAt }`; `AnswerLaneDeps { compose, systemPrompt, retrieve, now }`;
  `LookupLaneDeps extends AnswerLaneDeps { search, fetch, quarantine, maxResults, ledger: { searchPerformed, fetchPerformed } }`;
  `compose: (req: { prompt, chain, deadlineMs, signal, routed_by }) => Promise<LlmResult>` (an adapter over
  `oneShotAdapter` with `opts.chain` = the Fast candidates at `effort`, role `lane`, `routed_by` threaded through a new
  `OneShotAdapterOptions.routed_by`; the lane reads `LlmResult.answer` and the attempt's model);
  `LaneResult = {kind: "reply", text, model} | {kind: "fallthrough", why: LaneWhy}` with `LaneWhy` the closed list of §8.

`core-worker.ts` owns the store work around a lane (save, verdict, chat turns, ledger events) and gains one dispatch arm
per lane in `routeAnswered`; `saveThenRoute` is refactored to return `{save_outcome, note}` so the lane arms reuse it.
Functions stay under 50 lines.

## 4. The answer lane

**Verdict order, every lane path (codex + senior blocker):** `settleTriage` runs **before** the lane with
`handler_outcome = pending` (inside the save transaction when a rule saves, as `saveThenRoute` does today; alone
otherwise), so `verdict_id` exists for `routed_by`; the lane's end **patches** `handler_outcome` to `lane_reply` or
`fallthrough:<why>` and `model` (`updateJevVerdict`; `closePendingJevVerdict` then has nothing to move, so a later planner
end cannot overwrite a fall-through). The verdict's `reason` stays the route's reason; the planner's `TurnRoute` carries
`lane_failed`. The `triage` event is written once, at settle; the cause of a fall-through lives in `handler_outcome` (no
second event: the status lane moves to this order too, dropping its settle-at-end).

Steps: (0, core-worker) save a rule if `route.save`, settle the verdict; (1) render the prompt; (2) one `compose` call on
the Fast chain, role `lane`, `deadlineMs` = min(45 s, remaining) with the turn's `signal`; (3) non-empty text →
`laneCard`, patch `lane_reply`; empty → fall through.

**Prompt** (`renderLanePrompt`): the planner's own system prompt (`buildSystemPrompt(turnContextDeps, chatId).system`:
the `omp` surface with `safeLessonSection`, so the lane and the planner read the **same lessons**; `HOUGE_ASK_SYSTEM_PROMPT`
does not apply to lanes), then the `[context]` block exactly as `buildTurnPrompt` renders the retrieved facts and wiki
pages (`retrieve(chatId, message)`), then the thread: each of `recentTurns` as `Paco: …` / `Houge: …` under `turnChars`,
the quoted turn ahead of it as `replying to (Houge|Paco): …` (the same `quotedLine` the planner gets), then
`Paco: <message>`, then one instruction line: answer in the message's language; no tool, file or action is available this
turn; say plainly when the question needs a search or an action. A lane reply is **text only**: `[[attach:…]]` markers
are stripped by `laneCard` before delivery (the planner's `parseAttachments` must never see lane text as a file request).
The one-shot sends system and user text as one prompt, as every one-shot does.

**Records:** the compose `llm_attempt` has `role = lane` (new `LlmCallRole`, as stage A added `cascade`; the planner stays
`compose`, so "zero planner requests" is readable) and `routed_by = verdict_id`; `finishLane` records the user and
assistant chat turns as for the memory lane; `triage.route_lane = answer`.

## 5. The lookup lane

A **75 s** lane budget (`deadlineAt`), each step bounded by what is left; the parent's chat behaviour (follow-ups queue
behind a running triage) makes a long lane a visible cost, so no step waits for a provider's full timeout:

1. (core-worker) save a rule if any; settle the verdict.
2. **Query = the message text** (quoted turn excluded), whitespace-collapsed, cut at 200 chars. No model builds it.
3. **One search** through `createWebSearchAdapter` (the configured chain, Tavily then Firecrawl; `max_results` =
   `resolveWebMaxResults(env)`), raced against min(25 s, remaining); the adapter takes no signal, so a late result is
   **discarded** (`signal.aborted` or past the deadline → drop, never use). Zero results or chain unavailable → fall
   through. Ledger `web_search_performed {query, provider, source_urls, result_count}` as the planner's wrapper writes it;
   `turnCtx.sourceUrls` gets the URLs.
4. **Reader wall on the result set** (ADR 0014; the planner's `ompQuarantine` does the same per `web_search` call): each
   result's `content` capped at `WEB_RESULT_CONTENT_CAP` (600), the set passed to `quarantineExtract` on the Reader role with
   `objective` = the message (plannerFamily null: the first reader candidate runs, as a D10 analogue). Output: `digest`,
   `contains_instructions`. Code keeps the **URLs and titles out of the model's hands**: the `[sources]` list is built by
   code from the search result (`[n] title — url`), the digest sits under it. The reader's two attempts are bounded by the
   remaining budget; an `unreadableDigest` (both attempts failed) → fall through `reader_failed`.
5. **Thin → read the top page.** If the digest's text is under **400 chars**, `createHttpFetchAdapter` fetches the first
   result (existing SSRF floor, 15 s, 1 MB, 6 000-char cap), raced against the remaining budget, and `quarantineExtract`
   reads it (second reader call; ledger `http_fetch_performed {url, status}` and the external-read digest as `ompQuarantine`
   records). A fetch or reader failure here is **not** a fall-through: compose from the first digest. Never more than one
   fetch. The 400 is a constant with a test on both sides; the gate records whether it fired (§11 case 2).
6. **Compose** on the Fast chain, role `lane`, min(45 s, remaining): the §4 prompt with the `[sources]` block (code-built
   list, then the digest(s); `INSTRUCTIONS_NOTE` appended when the reader flagged instructions) ahead of the thread, and
   the instruction: answer from the sources, cite by `[n]`, say when they do not answer. Empty text → fall through.
7. **Source line.** Code appends `来源 / Sources:` with the URLs whose `[n]` the reply cites, in order; none cited → the first
   result only. Rendered as plain URLs (no masked links) through the rich renderer.

The lane never asks Paco anything and never writes memory beyond step 1 (parent §3). Latency, expected: search 2–5 s,
reader 5–12 s, compose 3–8 s; a thin result adds fetch 2–10 s and a second reader call. Still no planner session.

## 6. The card, the correction, the off switch

- Every lane card (answer, lookup, memory, status) ends with **🔍 Dig deeper** → `lane:ask:<run_id>`. The tap re-admits the
  original text as a new turn that skips triage (`triageOverrideFor`), as today, and records `paco_correction =
  ask_anyway` on the lane's verdict (the column value is unchanged; only the label moved).
- `triage_override` gains `lane` (required; the writer reads it from the verdict row; events from before stage B have no
  `lane` and count as `memory`, the only lane that had the button). `recordTriageOverride` counts the last 7 days **per
  lane** (`countRecentTriageOverrides(lane, since)`, `json_extract(payload_json, '$.lane')`, the legacy rows included for
  `memory`): the third tap opens `triage_overrides` with subject `${JEV_INCIDENT_SUBJECT}:lane:<lane>` and `detail.lane`
  (one page per lane per episode, the open fingerprint the throttle) and **writes no disarm marker**.
- **Resolution.** `resolveTriageOverridesIfRearmed` (run on every triage turn, `core-worker.ts:2730`) is replaced by
  `resolveQuietTriageOverrides(store, now)`: for each open `triage_overrides` incident whose subject names a lane, resolve
  it when that lane's 7-day count is under three; a legacy incident on the bare subject resolves once (the marker it
  tracked is no longer written). Called on every triage turn and from the sweep (`jevViolations`), so a page closes when
  the week is quiet even if no turn arrives.
- **Marker.** `houge.jev-disarmed` is still read by `resolveJevTriageMode` (it disarms all of Jev) and still written by
  nothing in stage B; a marker left by an older build is removed by hand, as `jev-decision-layer.md` § Rolling back
  documents. (`/rearm` removes `houge.disarm`, not this marker; Rev 1 said otherwise.)
- **Per-lane off switch.** `HOUGE_JEV_LANES_OFF` (comma list of lane names, default empty) read at triage time; a listed
  lane is unarmed (§2) and its turns run the planner on the role floor with reason `routed`, as if its rows were absent.
  Documented in `configuration.md`; `/models`-style runtime toggling is not built (a kickstart applies it, like every
  Jev flag). This is the remedy ruling 4 names: cheaper than `/disarm`, which switches off all of Jev and every other
  flagged capability.

## 7. The catch-up block

The planner's prompt carries no thread; the omp session is the thread, with a seed after a restart (`turn-context.ts`
`buildTurnPrompt`). A lane turn is answered outside the session, so the session never sees it.

- **What:** before the quote line and the message, `buildTurnPrompt` gets `catchUp: string | undefined`: the user and
  Houge lines of every lane-handled turn in this chat **since the planner last answered in this chat** (or since the
  session's seed, whichever is later), as `Paco: …` / `Houge (quick reply): …`, newest last, at most 6 turns and under
  `turnChars`, headed `[since your last turn]`. Empty when nothing was missed (most planner turns; no cost).
- **How, code only:** `RunStore.laneTurnsSince(chat_id, since)` joins `chat_turns` to `jev_verdicts` on `run_id` where
  `handler_outcome = 'lane_reply'`; "the planner last answered" is the newest `chat_turns` assistant row in this chat
  whose run has no `lane_reply` verdict. The memory lane's card text counts as its Houge line (so a saved rule is also
  caught up, closing today's gap for it).
- **Where:** `startTurn` → `buildTurnPrompt(…, {catchUp})`; the lane paths never build it. One test per edge: no lane
  turns, one, more than six, a session seed newer than the lane turns, a memory lane card.

## 8. Failure modes

One `LaneWhy` list, shared spelling `fallthrough:<why>` on the verdict:

| Where | `why` | Result |
|---|---|---|
| Fast role resolves empty | `no_fast_leg` | planner on Default, `lane_failed` |
| compose: every leg fails / deadline / empty text | `compose_failed` / `compose_timeout` / `empty_reply` | planner on **Default** (the Fast list just failed), `lane_failed` |
| compose returned text, card render throws | `render_failed` (today's status spelling) | planner on Default, `lane_failed`; the text is discarded |
| lookup: chain unavailable / zero results | `search_unavailable` / `no_results` | planner on Default, `lane_failed` |
| lookup: search past its bound | `search_timeout` | same; a late result is dropped |
| lookup: reader wall failed on the result set | `reader_failed` | same |
| lookup: fetch or second reader fails | — | compose from the first digest; not a fall-through |
| lane budget exhausted at any step | `lane_timeout` | same as `compose_timeout` |
| turn aborted (`/kill`, shutdown) | `aborted` | abort the compose (signal); no card; the verdict is patched `fallthrough:aborted`; **no planner** (today's abort path) |
| rule save not durable / capped / nothing to save | existing `not_durable` / `capped` / `none` stay the memory lane's spellings | a lane still replies; `save_outcome` records it |
| run failed after a lane reply | `run_failed` (existing) | unchanged |

`countLaneTurns` (the `lane_fallthrough_rate` feed) **excludes `fallthrough:aborted`**: a kill is not a lane failure
(the reviewer's two-kills-in-three-lookups page). `/kill` cannot cancel an outstanding reader or search HTTP call; the lane
ignores their results after the signal fires (guard on every `await`), and no card, verdict patch other than `aborted`,
or planner hand-off follows the abort. The warming planner child: unchanged from stage A (`finishLane` supersedes a start
that does not settle within `ABORT_GRACE_MS`); during a lane the child idles, and a fall-through reuses it warm.

## 9. Records

- **Migration `2026-10-10-jev-verdicts-lanes`**: `jev_verdicts.lane` CHECK admits `answer` and `lookup`. SQLite cannot
  alter a CHECK: in one transaction, `ALTER TABLE jev_verdicts RENAME TO jev_verdicts_old`; `CREATE TABLE jev_verdicts`
  with the full stage A column list (every column, `fast_used_tool`, `paco_correction`, both timestamps, the widened
  CHECK); `INSERT INTO jev_verdicts (<all columns>) SELECT <all columns> FROM jev_verdicts_old`; assert equal row counts;
  `DROP TABLE jev_verdicts_old`; then recreate `jev_verdicts_run_idx` and `jev_verdicts_created_idx`; record in
  `schema_migrations`. It runs at `RunStore.open`, so the gate's VACUUM copy migrates too. (`rebuildProcessedTriggers`
  is the shape, not the copy template: it filters rows on purpose.)
- `run-ledger.ts`: `triage_override` required fields gain `lane`; `llm_attempt.role` admits `lane`; no new event types.
- `JevVerdictRow.lane` and `TurnRoute` types widen; `LlmCallRole` gains `lane`; `OneShotAdapterOptions.routed_by`.
- `houge_status` and `/models` unchanged. The replay report (§10) and `triage-report.ts` constants widen with `Armed`.

## 10. Arming evidence (replay rows on disk, no new Jev call)

`.houge/jev-tree/replay.jsonl` (301 answered turns, 2026-10-09) scored with §2's Rev 1 rules (verified by the senior
review): the lanes would take **86 turns (answer 47, lookup 39)**; 11 more exceed their limits and stay on the planner.
Against Paco's 111 labels: lookup 7/7 right; answer 8/12 (misses: `self_change` ×2 — questions about Houge's own behaviour
— `status` ×1, `lookup` ×1). Against the tool proxy the large cell is **24 proxy-`research` turns the lookup lane would take**
with one search (the known "research read as lookup" weakness); Paco's labels rated 0 of 7 lookup picks wrong, so the proxy
overstates it. **Role change:** 34 of the 86 (answer 22, lookup 12) ran the planner on Default under stage A and move to
Fast; 19 of those at medium effort; Rev 2's `breadth` ≤ 1.5 on the answer lane returns 8 of them to the planner. The
parent's "58% of past turns" was the proxy share of the two categories, not the lanes' take at the bar.

**Report extension** (`triage-report.ts`, same build): `ALL_ARMED`, `NONE_ARMED` and `ARMING_COMBOS` widen to the new
`Armed` fields (combos `+answer`, `+lookup`, `+both`), `routeLines` shows `answer/fast` and `lookup/fast`, and `costlyCells`
gains "a lane took a turn whose truth is another category" per lane, plus the Default→Fast count above. No replay re-run:
the `category` hash is unchanged.

## 11. Tests and live gate

- **Policy table**: both lanes at the bar; each limit edge (0.5 / 1.5 with EPS, `breadth` on answer); lane unarmed, lane
  off, gear unarmed → the stage A planner route with reason `routed`; `thinkHarder` → Thinking; `bareAck` →
  `bare_ack_guard`; a cascade pick of `answer` never a lane; `sets_rule` yes + lane keeps `save`; the two-request guard at
  1.49 (lane) and 1.5 (planner, `two_request`) and inert with gear unarmed; `decisionFor` on the new reasons.
- **Each lane hermetic** (`tests/core/lanes/*.test.ts`, stubbed compose, search, fetch, quarantine, clock): reply; each
  `why` in §8; the 400-char fetch trigger on both sides; one fetch at most; fetch failure still composes; the code-built
  `[sources]` list and the reader digest under it; `INSTRUCTIONS_NOTE` on a flagged read; the source line from `[n]`
  citations and the none-cited default; the `[memory]` note; prompt contents (system prompt identity with the planner's,
  thread order, quoted line, context block, instruction); `[[attach:]]` stripped; a late search result after abort is
  dropped; deadline arithmetic (a 20 s search leaves compose 45 s; a 60 s search leaves it 15 s); the card's button and
  `callback_data` length.
- **Core-worker**: verdict settled before the lane with `pending`, patched after; a fall-through verdict is not moved by
  the planner's end; `laneTurnsSince` and the catch-up block edges (§7); `countLaneTurns` excludes `aborted`.
- **Store**: the migration on a DB holding stage A rows (rows kept, counts equal, indexes present, a second run a no-op),
  on a fresh DB, and the widened CHECK; `triage_override.lane`; `countRecentTriageOverrides` with legacy rows.
- **Gateway**: `lane:ask:` and legacy `memlane:ask:` both parse; three overrides on `answer` in 7 days open
  `triage_overrides` with the lane subject and no marker; two on `answer` plus one on `lookup` open nothing; the quiet
  resolver closes the incident when the count drops; the memory lane's lane-1 auto-disable test is rewritten to this.
- **Supervisor**: a refused-pin walk that exhausts the chain ledgers `routed_escalation.kind` as the error that started
  the walk, not `model_missing` (§12); `ompRouteEnd` then labels that verdict `escalation` (stated, see §12).
- **Live gate** `scripts/live-gate-jev-tree.mjs`, new cases on the DB copy with the real Jev and real omp. `writeCalibration`
  adds the two rows; "planner requests" = `llm_attempt` with role `compose` (the Jev call is role `triage`, the lane's is
  `lane`):
  1. a chat turn ("你觉得 NAS 放在客厅还是书房更好？") → `lane = answer`, `lane_reply`, zero `compose` attempts, exactly one
     `lane` attempt on a Fast candidate with `routed_by` = the verdict id, the card has the button;
  2. `probes[0]` ("明天悉尼天气怎么样？") → `lane = lookup`, one `web_search_performed`, one or two `reader` attempts, a
     source line in the text, at most one `http_fetch_performed`; the case prints whether the thin-result fetch fired;
  3. `MSG.research` → planner on Thinking (over the lookup limits or a research category; both PASS), the lanes idle;
  4. `MSG.ruleLookup` → `save_outcome = saved` and either `two_request` + a planner reply, or the lookup lane's card after
     the save; the case records which; a lane card that answers only the rule is a FAIL;
  5. a Dig deeper tap on case 1's card, driven as a `memlane_ask` event straight into `Gateway.intake` → a second run with
     skip `override`, planner on Default, `paco_correction = ask_anyway` on the first verdict, `triage_override.lane =
     answer`;
  6. a planner turn right after case 2 ("那后天呢？") → its first `compose` attempt's prompt (from the planner's recorded
     prompt or the `llm_attempt` request_key path the gate already reads) contains the `[since your last turn]` block with
     case 2's lines.
  `caseAck` is unchanged (the ack stays on the planner). Cases judge by the recorded verdict; INCONCLUSIVE when Jev takes
  another path, FAIL under `--real-calibration` for cases 1 and 2.
- **PASS criterion:** cases 1, 2, 5 acted with zero `compose` attempts on the lane turns; every `fallthrough:*` in the gate
  carries a `why` from §8's table; at most 1 silent Jev skip in ≥ 8 real calls; `pin_failed` = 0; case 6's block present.

## 12. Stage A leftovers

- **`lane_failed`**: §2 and §4 (the route the planner receives; the verdict keeps its route reason and the cause).
- **Refused-pin step-up cause**: `pinWalk` passes `why = "model_missing"` for every candidate after the first, so when the
  walk exhausts the chain `stepUp` ledgers `routed_escalation.kind = model_missing` even when the walk began with `quota`
  or `timeout`. Fix: `currentCandidate` receives the walk's original `kind` for the step-up record; per-leg `model_missing`
  attempt rows are unchanged. Consequence, accepted: `ompRouteEnd` copies `routed_escalation` into `paco_correction =
  escalation` unless the kind is `model_missing`, so a quota-started walk that hits refusals now labels the verdict
  `escalation`, which is the truthful label.
- **Two-request guard**: §2.

## 13. Dropped from Rev 1

- **The bare-ack rule as a lane.** It settles before Jev is called, so there is no reported model to arm against, and the
  replay report replays `ACK_ROUTE` as a constant. A bare "谢谢" keeps running the planner on Fast; parked for a later
  stage with a code-only arming rule.
- **Snippets straight to compose** (ADR 0014; ruling 2).
- **A disarm marker per lane** (ruling 4 made it moot).
- **A `lane_fallthrough` ledger event** (the verdict's `handler_outcome` is the record; no new event types).

## 14. Parked

- A seventh `noul` question for the two-request case (§2), if the gate shows `actions` blind to it.
- A typing indicator during a lane (3–30 s of silence; the memory lane has it today).
- A research lane (stage C, from the lane rows); Jev judges inside the planner loop (mu's checkpoint list), the next spec.
- Per-lane bars above 0.6 if the first weeks' `ask_anyway` rate says so (a bars change, no code).
- Runtime lane toggling (`/lanes`), if the env switch proves too slow in practice.

## 15. Review log

- **Rev 1 (2026-10-10):** written after Paco's rulings §1 and the design walk-through (nine sections, approved with the
  button rename). Paco's read of the first draft's per-lane auto-disable ("it could mean a judgement issue, not that the
  shortcut should be off") became ruling 4 before the first review.
- **Rev 2 (2026-10-10):** two reviews of Rev 1 against the live tree. Codex (6 blockers, 4 warnings, 1 suggestion):
  save-then-`lane_failed` needs one verdict order → §4; no cancellation contract → §5 bounds and §8 late-result rule; raw
  snippets cross the reader wall (ADR 0014) → §5 step 4; per-lane `triage_overrides` has no resolver → §6; the replay
  report's arming sets are fixed to stage A → §10; `ACK_ROUTE` cannot become a lane by a field change → §13. Senior review
  (4 blockers, 16 warnings, 12 suggestions; every §10 number re-verified; `--no-tools`, the fetch limits, the pinWalk bug
  and the migration-at-open confirmed): the ack lane has no model to arm against → §13; verdict order → §4; lane replies
  never reach the planner → §7 (new); the page cannot stay open and the marker text was wrong → §6. Warnings taken:
  "as today" corrected (§2), acted/fallback named (§2), `bare_ack_guard` named (§2), one `why` table with existing
  spellings (§8), the lane cannot own the save (§3/§4), role `lane` (§4), the Default→Fast count and `breadth` on answer
  (§1, §2, §10), the same lessons as the planner (§4), ADR 0014 position (§5), `aborted` excluded from the rate (§8), the
  budget arithmetic and chat-queueing cost (§5), a measurable thin threshold (§5), masked links (§5 step 7),
  `[[attach:]]` (§4), `routed_by` seam (§3), the per-lane off switch (§6), gate assertions and rows (§11), the escalation
  label (§12). Suggestions taken: case 5 via `memlane_ask` intake, migration details, D10 analogue, guard inert when gear is
  unarmed. Not taken: a fresh "untrusted data" label on snippets (moot behind the reader), link previews (renderer-wide,
  not this spec).
