# Jev decision tree, stage B — the `answer` and `lookup` lanes

**Rev 1, 2026-10-10.** Parent: `2026-10-06-jev-decision-tree-design.md` (Rev 9), whose §3 table defines the two lanes and
whose §10 names this stage. Everything the parent fixes (questions, bars, roles, the planner lane, ledger shape, safety
nets) stays as built in stage A; this spec adds only what the two lanes and the three stage A leftovers need. ADR 0029
governs; ADR 0028 for omp.

## 0. Scope

- The **answer lane** and the **lookup lane**: code owns the steps, one one-shot on the Fast role composes, no planner
  session, no tools in the model's hands.
- Stage A leftovers owed to stage B (`tasks/todo.md` 2026-10-09): the two-request guard, a dedicated `lane_failed` route
  reason, the original cause kind on a refused-pin step-up.
- Two changes to earlier rulings, approved by Paco 2026-10-10: the correction button reads **"🔍 Dig deeper"** on every
  lane card (it was "Ask Houge anyway"; Paco: "I am always talking to Houge"), and **a tap never disarms anything**: the
  3-in-7-days auto-disable (lane 1, 2026-10-06) becomes a per-lane page. The status lane gets the button too (parent §3:
  every lane reply carries it).
- Out of scope: the `schedule` and `wiki` lanes (stage C), `mail_calendar` (SP2), a typing indicator while a lane runs,
  the research-lane question.

## 1. Rulings (Paco, 2026-10-10)

1. **Ship armed.** `CALIBRATED_ROWS` gains `category:answer` and `category:lookup` for zh and en on the Jev model the
   stage A rows name, approved "Paco 2026-10-10", in the same build. Offered alternative (ship dark, arm after a
   lane-simulation report) declined. Evidence shown before the choice: §9.
2. **Lookup evidence = snippets, and the top page only when the snippets are thin** (option 2 of three; §5).
3. **"🔍 Dig deeper"** replaces "Ask Houge anyway" everywhere.
4. **A tap is a correction signal, not a lane fault.** It says Jev sorted *this* message wrongly, or Paco wants more;
   a broken lane is `lane_fallthrough_rate`'s job. So no lane is ever switched off by taps, the memory lane included
   (its wrong save has Undo). Three taps on one lane in seven days page Paco (`triage_overrides`, per lane); he adjusts
   the bar or `/disarm`s by hand. Paco: "at the high level you are categorising: shortcuts, and the planner".

## 2. Policy (`src/jev/tree-policy.ts`, pure)

- `Lane` widens to `"answer" | "lookup" | "memory" | "status" | "planner"`. `Armed` gains `answer` and `lookup`.
- **Arming keys**, like `TREE_STATUS_ARM_ID`: `TREE_ANSWER_ARM_ID = "category:answer"`, `TREE_LOOKUP_ARM_ID =
  "category:lookup"`, each at the `category` question's criteria hash, so a `category` row alone never arms a lane and a
  hash or model change disarms both with the rest. `treeArmingRows` includes them (the alias-move page reads them).
- **A lane fires when all hold:** the lane is armed; `category`'s top is that lane's category at p ≥ the choice bar
  (`TREE_BAR_DEFAULTS.choice`, 0.6; no confidence or gap floor: a wrong pick here costs a weaker reply, not a swallowed
  turn, and the parent §2.4 reserves the stricter floors for `memory` and `status`); `bareAck` is false (a bare ack
  takes `ACK_ROUTE`, below); `thinkHarder` is false; and the **lane limits** hold on the expected score levels (0–3):
  - answer: `actions` ≤ 0.5 (reads as *none*);
  - lookup: `breadth` ≤ 1.5 (*one known thing* or *one topic*) and `actions` ≤ 1.5 (*none* or *one or two reads*).
  Gear must be armed for the limits to be read; an unarmed gear means no lane (the planner on the role floor, reason
  `uncalibrated`, as today). Over a limit → `plannerRoute(category, gear, save, "lane_limits")`: the first writer of the
  reason the parent reserved.
- **Role and effort** on a lane route: `role: "fast"`, `effort` from `reasoning` as `gearOf` computes it (so a `reasoning`
  of *non-obvious analysis* lifts the Fast model's effort, never the role: the lane limits already bound the turn).
- **`sets_rule` = yes with a lane category:** `save` is set as today; the handler saves first, then runs the lane
  (parent §3). Not durable or capped → the lane still runs; the card carries the `[memory]` note line.
- **The cascade never enters a lane** (parent §2.4's rule extended: a model guess never routes into a no-planner lane).
  `cascadePlan` keeps removing only `memory` and `status` from the pair, but `applyCascade` routes a picked `answer` or
  `lookup` to the planner on its role, reason `cascade`, as stage A does. A cascade is a below-bar turn by definition.
- **`ACK_ROUTE`** becomes a lane route when the answer lane is armed: `{category: "answer", lane: "answer", role: "fast",
  effort: "low", reason: "ack_rule"}`; unarmed, it stays the planner on Fast as built. The settle path for `ack_rule`
  (`triageSkip` with a route) learns to run the answer lane.
- **Two-request guard** (`memoryBranch`): a confident memory lane route (`clearsLane` at 0.85, zone yes) whose
  `actions` expected level is ≥ 1.5 becomes `plannerRoute("memory", gear, save, "two_request")`: the rule is saved by
  `saveThenRoute` and the planner answers the rest with the `[memory]` note, instead of the lane's card alone. New
  `RouteReason` `two_request`. Evidence: of the 7 replayed turns the memory lane took confidently, none had `actions` ≥ 1.5
  (0 false positives) and 3 had `actions` in [0.78, 1.34] (so a 0.5 threshold would have cost 3 of 7 pure rules); Paco's
  three "both" labels were not confident `memory` in the replay, so the existing confidence and gap floors already
  route them save-then-planner. The gate's `ruleLookup` case (§10) shows whether Jev's `actions` score sees the second
  request; if it does not, the escalation is a seventh `noul` question ("Besides the rule, does `latest_message` ask
  Houge to do or answer something?"), which needs its own rows and replay: parked, not built here.
- **`lane_failed`** joins `RouteReason`. A lane that falls through writes `fallthrough:<why>` on the verdict and routes
  the planner with reason `lane_failed` (today's handlers reuse `jev_skipped`, which hides the cause in the `triage`
  event). The status and memory lanes move to it too.

## 3. Where the lanes live

New directory `src/core/lanes/`:

- `lane-compose.ts`: `renderLanePrompt(i): string` — the shared one-shot prompt (§4); `laneComposeChain(roles,
  effort): ModelString[]` — the Fast role's candidates at the route's effort (`RoleResolver.candidates("fast",
  {effort})`); an empty Fast list is a fall-through (`lane_failed:no_fast_leg`), never a step-up (a step-up is the
  planner's path).
- `lane-card.ts`: `laneCard({text, run_id, note?}): {text, buttons}` — the reply plus the **🔍 Dig deeper** button
  (`callback_data` `lane:ask:<run_id>`); `memoryLaneCard` keeps Undo and switches its second button to this helper. The
  parser accepts both `lane:ask:` and the legacy `memlane:ask:` (cards already in chats keep working); the event stays
  `memlane_ask` so the gateway path (`admitMemLaneAsk`, `memLaneAskTurnEvent`, `recordTriageOverride`) is unchanged
  except for §6.
- `answer-lane.ts`: `runAnswerLane(i: LaneInput, d: LaneDeps): Promise<LaneResult>`.
- `lookup-lane.ts`: `runLookupLane(i: LaneInput, d: LaneDeps): Promise<LaneResult>`.
- `LaneInput { run_id, chat_id, userText, state: OmpTurnState (recentTurns, quote), route: Route, verdict_id, lang,
  signal, deadlineAt }`; `LaneDeps { compose: (prompt, chain, deadlineMs) => Promise<LlmResult>, retrieve, systemPrompt,
  search?, fetch?, quarantine?, ledger, now }`; `LaneResult = {kind: "reply", text, model, sources?} | {kind: "fallthrough",
  why: string}` where `why` is one of a closed list per lane (§8).

`core-worker.ts` gains one dispatch arm per lane in `routeAnswered` (after `statusLane`, before `saveThenRoute`'s
inform path) and the `LaneDeps` wiring; the lane files hold the steps. Functions stay under 50 lines; the lane modules
are hermetic (no store, no process env: everything arrives through `LaneDeps`).

## 4. The answer lane

Steps: (1) if `route.save`, `runLessonWrite` first, as `saveThenRoute` does (`inTx` settles the verdict with
`save_outcome`); (2) render the prompt; (3) one `oneShotAdapter` call on the Fast chain, role `compose`, with
`deadlineMs` = 45 s and the turn's `signal`; (4) a non-empty text → `laneCard`, verdict `handler_outcome = lane_reply`,
`model` = the leg that answered; else fall through.

**Prompt** (`renderLanePrompt`): the `ask` discipline's system prompt (`composeSystemPrompt(memoryRoot, "ask",
{lessonsReader, skillsReader, coreReader, now})`, the `runAnswer` precedent), then the `[context]` block exactly as
`buildTurnPrompt` renders the retrieved facts and wiki pages (`retrieve(chatId, message)`), then the thread: each of
`recentTurns` as `Paco: …` / `Houge: …` under the planner's `turnChars` cap, the quoted turn (if any) ahead of it as
`replying to (Houge|Paco): …`, then `Paco: <message>`, then one instruction line: answer in the message's language, no
tool use is possible, say plainly when the question needs a search or an action (the card's button is the way out).
The `[memory]` note line when a rule was saved this turn. The one-shot sends system and user text as one prompt
(`spawnOneShot` has no system field), as every one-shot does today.

**Records:** the compose `llm_attempt` carries `routed_by = verdict_id` (the parent §9 join holds for lane turns);
`finishLane` records the user and assistant chat turns as for the memory lane; the `triage` event's `route_lane` is
`answer`.

## 5. The lookup lane

Steps, in order, each bounded by the lane's 90 s `deadlineAt`:

1. Save a rule first, as §4.
2. **Query = the message text** (quoted turn excluded), whitespace-collapsed, cut at 200 chars. No model builds the
   query (parent §3: "code builds the query").
3. **One search** through `createWebSearchAdapter` (the configured chain, Tavily then Firecrawl; `max_results` =
   `resolveWebMaxResults(env)`, 5). Zero results, or the chain unavailable → fall through (`no_results` /
   `search_unavailable`). Ledger `web_search_performed {query, provider, source_urls, result_count}` as the planner's
   wrapper writes it; `turnCtx.sourceUrls` gets the URLs (radar and wiki consumers unchanged).
4. **Thin snippets → read the top page.** If the results' `content` fields total < 600 chars, `createHttpFetchAdapter`
   fetches the first result's URL (existing SSRF floor, 15 s, 1 MB, 6 000-char cap) and `quarantineExtract` runs it
   through the reader wall on the Reader role (D10 skip rule: the planner family is null for a lane, so the first reader
   candidate runs); ledger `http_fetch_performed {url, status}` and the external-read digest as `ompQuarantine` records
   them. A fetch or reader failure is **not** a fall-through: the lane composes from the snippets and the card carries
   no digest. Never more than one fetch.
5. **Compose** on the Fast chain, role `compose`, 45 s: the §4 prompt with a `[sources]` block before the thread —
   `[1] <title> — <url>\n<snippet or digest>` per result — and the instruction: answer from the sources, cite by `[n]`,
   say when they do not answer the question. Empty text → fall through (`compose_failed` / `compose_timeout`).
6. **Source line.** Code appends `来源 / Sources:` with the URLs whose `[n]` the reply cites, in order; none cited → the
   first result only. URLs render as plain links through the rich renderer.

The lane never asks Paco anything and never writes memory beyond step 1 (parent §3).

## 6. The card and the correction

- Every lane card (answer, lookup, memory, status) ends with **🔍 Dig deeper** → `lane:ask:<run_id>`. The tap re-admits
  the original text as a new turn that skips triage (`triageOverrideFor`), as today, and records `paco_correction =
  ask_anyway` on the verdict (the column value is unchanged; only the label moved).
- `triage_override` gains `lane` (required field; the writer reads it from the verdict row). `recordTriageOverride`
  counts the last 7 days **per lane** (`countRecentLedgerEvents` filtered on `lane`): the third tap on one lane opens
  `triage_overrides` with `detail.lane` (one page; sticky until the lane's 7-day count drops under three, checked on the
  next tap or by the sweep) and **writes no disarm marker**. `writeJevDisarmMarker(…, "triage_overrides")` loses its
  writer; `resolveTriageOverridesIfRearmed` and `/rearm` keep clearing a marker an older build wrote. Nothing routes
  differently after a tap; Paco changes a bar or `/disarm`s by hand.
- The memory card's Undo is unchanged.

## 7. Records

- **Migration `2026-10-10-jev-verdicts-lanes`**: `jev_verdicts.lane` CHECK admits `answer` and `lookup`. SQLite cannot
  alter a CHECK: rebuild as `rebuildProcessedTriggers` does (`RENAME TO …_old`, create, `INSERT … SELECT`, drop, recreate
  the two indexes), inside one transaction, recorded in `schema_migrations`. The store's `JevVerdictRow.lane` type widens.
- `handler_outcome` values unchanged (`lane_reply`, `fallthrough:<why>`). `route_outcome = act` on a lane route.
- `run-ledger.ts`: `triage_override` required fields gain `lane`; `triage.route_lane` admits the two names (it is a
  string already). No new event types.
- The sweep's `lane_fallthrough_rate` is per lane and needs no edit; `jev_skip_rate` unchanged.
- `houge_status` and `/models` unchanged.

## 8. Failure modes

| Where | What | Result |
|---|---|---|
| Fast role resolves empty | no candidate | fall through `lane_failed:no_fast_leg`; planner on Default |
| compose: every leg fails / 45 s deadline / empty text | `compose_failed` / `compose_timeout` / `empty_reply` | fall through; planner on Default (not Fast: the Fast list just failed) |
| compose returns text, card throws | render error | `inform` to the planner with the text discarded, as the memory lane does |
| lookup: search chain unavailable or zero results | | fall through `search_unavailable` / `no_results` |
| lookup: fetch or reader fails | | compose from snippets; `external_read` digest absent; no fall-through |
| lane 90 s deadline | | abort the in-flight step (signal), fall through `lane_timeout` |
| turn aborted (`/kill`, shutdown) | signal | abort, no card, verdict `fallthrough:aborted`; no planner either (today's abort path) |
| rule save not durable / capped | | lane still replies; `save_outcome` records it; the note line says so |
| planner takes over after a fall-through | | the planner runs cold (its child was warming in parallel, as for every triage) on **Default**, reason `lane_failed`; one verdict row, `handler_outcome` = `fallthrough:<why>` then the planner's end does **not** overwrite it (`closePendingJevVerdict` moves `pending` only, as today) |
| Dig deeper on a lane reply | tap | new turn, triage skipped, planner on Default; `paco_correction = ask_anyway` on the lane's verdict |

Every fall-through is one `triage`-adjacent ledger note with `why`; nothing silent.

## 9. Arming evidence (replay rows on disk, no new Jev call)

`.houge/jev-tree/replay.jsonl` (301 answered turns, 2026-10-09) scored with §2's rules: the lanes would take **86 turns
(answer 47, lookup 39)**, 11 more exceed their limits (answer 10, lookup 1) and stay on the planner. Against Paco's 111
labels: lookup 7/7 right; answer 8/12 (misses: `self_change` ×2 — questions about Houge's own behaviour — `status` ×1,
`lookup` ×1). Against the tool proxy the large cell is **24 proxy-`research` turns the lookup lane would take** with one
search (the known "research read as lookup" weakness, parent 2026-10-09 amendment); Paco's labels rated 0 of 7 lookup
picks wrong, so the proxy overstates it (lessons.md: a proxy label is not truth). The parent's "58% of past turns" was
the proxy share of the two categories, not the lanes' take at the bar.

**Report extension** (`triage-report.ts`, same build): `routeLines` already prints lane/role tallies as if armed and
will show `answer/fast` and `lookup/fast` once the policy knows them; `costlyCells` gains "a lane took a turn whose truth
is another category" per lane. No replay re-run is needed: the `category` hash is unchanged.

## 10. Tests and live gate

- **Policy table**: both lanes at the bar, each limit edge (0.5 / 1.5 with EPS), unarmed lane → planner on Fast with
  `uncalibrated`, unarmed gear → no lane, `thinkHarder` → Thinking planner, bare ack → `ACK_ROUTE` as a lane when armed and
  as the planner when not, a cascade pick of `answer` never a lane, `sets_rule` yes + lane keeps `save`, the two-request
  guard at 1.49 (lane) and 1.5 (planner, `two_request`).
- **Each lane hermetic** (`tests/core/lanes/*.test.ts`, stubbed compose, search, fetch, quarantine): reply, each
  fall-through `why` in §8, the 600-char fetch trigger on both sides, one fetch at most, fetch failure still composes,
  source line from `[n]` citations and the none-cited default, the `[memory]` note, prompt contents (thread order, quoted
  line, context block, instruction), deadline abort, the card's button and its `callback_data`.
- **Store**: the migration on a DB holding stage A rows (rows kept, indexes present, a second run is a no-op), the
  widened CHECK, `triage_override.lane`.
- **Gateway**: `lane:ask:` and legacy `memlane:ask:` both parse; three overrides on `answer` in 7 days open
  `triage_overrides {lane: answer}` and write no disarm marker; two on `answer` plus one on `lookup` open nothing; the
  memory lane follows the same rule (its lane-1 auto-disable test is rewritten, not deleted).
- **Supervisor**: a refused-pin walk that exhausts the chain ledgers `routed_escalation.kind` as the error that started
  the walk, not `model_missing` (§11).
- **Live gate** `scripts/live-gate-jev-tree.mjs`, new cases on the DB copy with the real Jev and real omp:
  1. a chat turn ("你觉得 NAS 放在客厅还是书房更好？") → `lane = answer`, `lane_reply`, zero `llm_attempt` rows of role
     other than `compose`, exactly one `compose` attempt on a Fast candidate with `routed_by` set, the card has the button;
  2. `probes[0]` ("明天悉尼天气怎么样？") → `lane = lookup`, one `web_search_performed`, a source line in the text, at most
     one `http_fetch_performed`;
  3. `MSG.research` → planner on Thinking (over the lookup limits or a research category; both PASS), the lanes idle;
  4. `MSG.ruleLookup` → `save_outcome = saved` and either `two_request` + planner reply, or the lookup lane's card after
     the save; the case records which, and a lane card that answers only the rule is a FAIL;
  5. a Dig deeper tap on case 1's card → a second run with skip `override`, planner on Default, `paco_correction =
     ask_anyway` on the first verdict, and `triage_override.lane = answer`.
  Existing cases keep passing (memory and status cards now show the new label). Cases judge by the recorded verdict;
  INCONCLUSIVE when Jev takes another path, FAIL under `--real-calibration` for cases 1 and 2.
- **PASS criterion:** cases 1, 2, 5 acted with zero planner requests on the lane turns; every `fallthrough:*` in the gate
  has a `why` from §8's list; at most 1 silent Jev skip in ≥ 8 real calls; `pin_failed` = 0.

## 11. Stage A leftovers

- **`lane_failed`**: §2. The `triage` event of a fall-through now says `verdict: lane_failed`; the verdict row keeps the
  cause in `handler_outcome`.
- **Refused-pin step-up cause**: `pinWalk` passes `why = "model_missing"` for every candidate after the first, so when
  the walk exhausts the chain, `stepUp` ledgers `routed_escalation.kind = model_missing` even when the walk began with
  `quota` or `timeout`. Fix: `currentCandidate` receives the walk's original `kind` for the step-up record; the per-leg
  `model_missing` attempt rows are unchanged.
- **Two-request guard**: §2.

## 12. Docs on ship

ADR 0029 amendment (stage B: lanes armed on Paco's word, Dig deeper, taps page and never disarm, the guard and its
evidence);
`docs/reference/jev-decision-layer.md` (decision flow with the two lanes, the button, the per-lane page, reading a
lane row); `configuration.md` (no new variables; the `HOUGE_WEB_*` paragraph notes the lookup lane as a caller; the
`triage_overrides` incident is per lane and no longer disarms); CONTEXT.md (*Dig deeper*); README one line; `tasks/todo.md` state block; `tasks/lessons.md`;
`sessions.md`.

## 13. Parked

- A seventh `noul` question for the two-request case (§2), if the gate shows `actions` blind to it.
- A typing indicator during a lane (3–25 s of silence; the memory lane already has it).
- A research lane (stage C, from the lane rows).
- `category:*` per-lane bars above 0.6 if the first weeks' `ask_anyway` rate says so (a bars change, no code).

## 14. Review log

- Rev 1 (2026-10-10): written after Paco's rulings §1 and the design walk-through (nine sections, approved with the
  button rename). Paco's read of the first draft's per-lane auto-disable ("it could mean a judgement issue, not that the
  shortcut should be off") became ruling 4 before the first review.
