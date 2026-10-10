# Jev decision tree, stage B — the `answer` and `lookup` lanes

**Rev 5, 2026-10-10.** Parent: `2026-10-06-jev-decision-tree-design.md` (Rev 9), whose §3 table defines the two lanes and
whose §10 names this stage. Everything the parent fixes (questions, bars, roles, the planner lane, ledger shape, safety
nets) stays as built in stage A; this spec adds only what the two lanes and the three stage A leftovers need. ADR 0029
governs; ADR 0014 (the reader wall) and ADR 0028 (omp) bind. §15 is the review log.

## 0. Scope

- The **answer lane** and the **lookup lane**: code owns the steps, one one-shot on the Fast role composes, no planner
  session, no tools in the model's hands.
- **The catch-up block** (§7): a planner turn that follows lane turns is told what it missed. Without it a lane reply never
  reaches the planner's thread (its thread is the omp session; a lane answers outside it), so a follow-up such as
  "那后天呢？" after a lookup would reach the planner blind. The memory lane has this gap today; at ~25% of turns on lanes
  it would be constant.
- Stage A leftovers owed to stage B (`tasks/todo.md` 2026-10-09): the two-request guard, a dedicated record of a lane's
  fall-through (§12), the original cause kind on a refused-pin step-up.
- Rulings that change earlier ones (§1): the "🔍 Dig deeper" button, taps never disarm, the status lane gets the button.
- A per-lane off switch (§6), because `/disarm` turns off all of Jev and every other flagged capability.
- Out of scope: the `schedule` and `wiki` lanes (stage C), `mail_calendar` (SP2), a typing indicator while a lane runs,
  the research-lane question, the bare-ack rule as a lane (§13), Jev judges inside the planner loop (mu's `tool.injection`,
  `tool.admission`, `turn.continue`, `turn.completion`, `turn.drift`: the next spec).
- The build touches protected files (`turn-context.ts`, `planner-supervisor.ts`, `run-store.ts`, `run-ledger.ts`): a
  Paco-hand build and merge, as every stage so far.

## 1. Rulings (Paco, 2026-10-10)

1. **Ship armed.** `CALIBRATED_ROWS` gains `category:answer` and `category:lookup` for zh and en on the Jev model the
   stage A rows name, approved "Paco 2026-10-10", in the same build. Offered alternative (ship dark, arm after a
   lane-simulation report) declined. Evidence shown before the choice: §10. Not shown then, shown now: under §2's rules
   **26 of the 78 lane takes ran the planner on Default under stage A** (gear above light) and move to Fast under stage B;
   and **about 5 of the 38 lookup takes** are questions a web search cannot answer (two ask for the Mac's public IP, three
   refer to Houge's own earlier report), which the lane will answer badly and Dig deeper will recover (§5, §10).
2. **Lookup evidence = the search result set, and the top page only when it is thin** (option 2 of three). Rev 1 sent raw
   snippets to the composing model; ADR 0014 says only the quarantined reader ingests raw `web_search` output, so the
   result set goes through the reader wall first (§5), and "thin" is the reader's own verdict. The lookup lane therefore
   has one more model step than the design walk-through said: search → reader → compose, plus fetch → reader on a thin
   result.
3. **"🔍 Dig deeper"** replaces "Ask Houge anyway" everywhere (Paco: "I am always talking to Houge").
4. **A tap is a correction signal, not a lane fault.** It says Jev sorted *this* message wrongly, or Paco wants more; a
   broken lane is `lane_fallthrough_rate`'s job. No lane is ever switched off by taps, the memory lane included (its wrong
   save has Undo). Three taps on one lane in seven days page Paco (`triage_overrides`, per lane, §6); he raises a bar or
   switches the lane off (§6). Paco: "at the high level you are categorising: shortcuts, and the planner".

## 2. Policy (`src/jev/tree-policy.ts`, pure)

- `Lane` widens to `"answer" | "lookup" | "memory" | "status" | "planner"`. `Armed` gains `answer` and `lookup`.
  `TREE_THRESHOLD_VERSION` is bumped (`2026-10-10.1`): rows before and after the ship stay distinguishable.
- **Arming keys**, like `TREE_STATUS_ARM_ID`: `TREE_ANSWER_ARM_ID = "category:answer"`, `TREE_LOOKUP_ARM_ID =
  "category:lookup"`, each at the `category` question's criteria hash, so a `category` row alone never arms a lane and a
  hash or model change disarms both with the rest. `treeArmingRows` includes them. `Armed.answer` / `.lookup` are also
  false when the lane is listed in `HOUGE_JEV_LANES_OFF` (§6), passed in by the caller.
- **A lane fires when all hold:** the lane is armed, **`armed.rule`** is true (stage A's F6 rule: a lane never acts while
  a stated rule could go unseen; live, all six questions are armed, so this costs nothing today) and `armed.gear` is true
  (the limits need the scores); `category`'s top is that lane's category at p ≥ `bars.choice` (0.6; no confidence or gap
  floor: a wrong pick costs a weaker reply with a button under it, not a swallowed turn, so the parent §2.4's stricter
  floors stay with `memory` and `status`); `bareAck` is false; `thinkHarder` is false; and the **lane limits** hold on the
  expected score levels (floats 0–3, compared with `EPS`):
  - answer: `actions` ≤ 0.5 (*none*) and `breadth` ≤ 1.5 (*one known thing* or *one topic*);
  - lookup: `breadth` ≤ 1.5 and `actions` ≤ 1.5 (*none* or *one or two reads*).
- **Otherwise the planner, as the parent built it,** with the reason naming why: lane unarmed (off, or `rule`/`gear`
  unarmed) → `plannerRoute(top, gear, save, "routed")` on the gear's role with the Fast floor (today's path, verbatim;
  gear unarmed gives `DEFAULT_GEAR` as today); over a limit → `plannerRoute(top, gear, save, "lane_limits")`, the first
  writer of the reason the parent reserved; `bareAck` → `plannerRoute(top, gear, save, "bare_ack_guard")` as `statusBranch`
  and `memoryBranch` do (this is "好" after a proposal: consent, which a lane must not answer); `thinkHarder` → the planner
  on Thinking as today.
- **One code rule outside the policy** (core-worker, before dispatch, because it reads the text): a `lookup` route whose
  message contains a URL (`https?://`) goes to the planner with reason `lane_limits` (the lane cannot fetch a named page
  safely from a one-line query; the planner's `http_fetch` path can). One such turn in the replay.
- **Role and effort** on a lane route: `role: "fast"`, `effort` from `reasoning` as `gearOf` computes it (a `reasoning`
  of *non-obvious analysis* raises the Fast model's effort, never the role).
- **`sets_rule` = yes with a lane category:** `save` is set as today; core-worker saves first (§4), then runs the lane.
  Not durable or capped → the lane still runs; the card carries the note line.
- **The cascade never enters a lane.** `cascadePlan` keeps removing only `memory` and `status`; `applyCascade` routes a
  picked `answer` or `lookup` to the planner on its role, reason `cascade`, exactly as stage A does.
- **The bare-ack rule (`ACK_ROUTE`) is unchanged**: a "谢谢" after a plain answer still runs the planner on Fast (§13).
- **Two-request guard** (`memoryBranch`): a confident memory lane route (`clearsLane` at 0.85, zone yes) whose `actions`
  expected level is ≥ 1.5 becomes `plannerRoute("memory", gear, save, "two_request")`: the rule is saved and the planner
  answers the rest with the `[memory]` note, instead of the lane's card alone. New `RouteReason` `two_request`. The guard
  reads `actions` only when `armed.gear`. Evidence: of the 7 replayed turns the memory lane took confidently, none had
  `actions` ≥ 1.5 (0 false positives) and 3 had `actions` in [0.78, 1.34] (a 0.5 threshold would have cost 3 of 7 pure
  rules); Paco's three "both" labels were not confident `memory`, so the existing confidence and gap floors already send
  them save-then-planner. The gate's `ruleLookup` case (§11) shows whether Jev's `actions` score sees the second request;
  if not, the escalation is a seventh `noul` question ("Besides the rule, does `latest_message` ask Houge to do or answer
  something?") with its own rows and replay: parked (§14).
- **Acted or fallback** (`decisionFor`, `ACTED`): `lane_limits` and `two_request` are routes the tree chose and the
  planner ran on the gear's role → `act`; `bare_ack_guard` stays out of `ACTED` (a Default-role guard route is a fallback
  in stage A, and the status and memory rows keep their meaning). **No `lane_failed` reason** (Revs 1–3 had one): a lane's
  fall-through is recorded on the verdict as lane = the lane, `reason` = the route's reason, `route_outcome = fallback`,
  `handler_outcome = fallthrough:<why>` (§4), which is the dedicated record stage A owed (§12); the planner receives
  `fallbackRoute`'s Default route, as today. The status and memory lanes stop re-labelling their fall-through route
  `jev_skipped` and use the same shape.

## 3. Where the lanes live

New directory `src/core/lanes/`, hermetic (no store, no process env; everything through deps):

- `lane-compose.ts`: `renderLanePrompt(i: LanePromptInput): string` (§4), `renderSourcesBlock(urls, digests)` (§5),
  `needsRewrite(message, quoted, previousTelegramLineAgeMs): boolean` and `validateQuery(raw, message): string` (§5 step 2),
  `catchUpLine(lane, …): string` (§7).
- `lane-card.ts`: `laneCard({text, run_id, note?}): {text, buttons}` — the reply with markdown links flattened to plain
  URLs and `[[attach:…]]` markers stripped (a lane reply is text only), the optional `[memory]` note line, and the
  **🔍 Dig deeper** button (`callback_data` `lane:ask:<run_id>`, under Telegram's 64-byte cap). `memoryLaneCard` keeps Undo
  and takes its second button from here. The parser accepts `lane:ask:` and the legacy `memlane:ask:` (cards already in
  chats keep working); the event stays `memlane_ask`, so `admitMemLaneAsk` and `memLaneAskTurnEvent` are unchanged.
- `answer-lane.ts`: `runAnswerLane(i: LaneInput, d: AnswerLaneDeps): Promise<LaneResult>`.
- `lookup-lane.ts`: `runLookupLane(i: LaneInput, d: LookupLaneDeps): Promise<LaneResult>`; search, fetch, reader and the
  budget are local to this file.
- Types (`lane-types.ts`): `LaneInput { run_id, chat_id, userText, recentTurns, turnChars, quoted: QuotedTurn | null,
  effort, verdict_id, note: string | null, signal, deadlineAt }`; `AnswerLaneDeps { compose, systemPrompt, retrieve, now }`;
  `LookupLaneDeps extends AnswerLaneDeps { search, fetch, read, rewrite, previousTelegramTurns, maxResults, ledger: {
  searchPerformed, fetchPerformed } }` where `read` is the strict reader (§5 step 4), `rewrite` the Tiny one-shot (§5 step 2)
  and `previousTelegramTurns` the last two Paco lines and the last Houge line from Telegram runs in this chat with their
  ages (a store query joining `chat_turns` to `runs.source = 'telegram'`: schedule-fired rows never count as "Paco's
  previous line"); `compose: (req: { prompt, chain, deadlineMs, signal,
  routed_by }) => Promise<LlmResult>` (an adapter over `oneShotAdapter` with `opts.chain` = the Fast candidates at `effort`,
  role `lane`, and `routed_by` threaded through a new `OneShotAdapterOptions.routed_by` onto **every** leg's attempt row;
  `seatChain` gets an explicit `lane` case that throws when no chain is supplied, so a missed option can never fall to the
  Tiny chain; the lane reads `LlmResult.answer` and the attempt's model); `LaneResult = {kind: "reply", text, model,
  sources?} | {kind: "fallthrough", why: LaneWhy}` with `LaneWhy` the closed list of §8. A lane function **never throws**:
  any unexpected exception inside it is caught and returned as `{kind: "fallthrough", why: "lane_threw"}` (so it never
  reaches `triageTurn`'s catch, which would write a fresh verdict under lane `planner` and hide the failure from
  `lane_fallthrough_rate`).

`core-worker.ts` owns the store work around a lane (save, verdict, chat turns, ledger events) and gains one dispatch arm
per lane in `routeAnswered`; `saveThenRoute` is refactored to return `{save_outcome, note, settled: boolean}` so the lane
arms reuse it. Functions stay under 50 lines.

## 4. The answer lane

**Verdict order (three review rounds).** The verdict row must be truthful about what ran, the compose attempt must
reference it, and the finaliser's rules stay (a lost turn writes nothing; one finalise per turn):

- `insertJevVerdict(i, verdict_id?)` accepts a caller-minted id (`jv_<uuid>`); core-worker mints it before the lane and
  passes it as `LaneInput.verdict_id` for `routed_by`.
- **Nothing committed before the lane (no rule, or a rule attempted and refused / not durable / capped): settle once,
  after the lane**, as the status lane does today. `settleFor` gains an explicit outcome argument,
  `settleFor(route, save, handler, outcome?)`: the lane's result sets `outcome` (`act` on a reply, `fallback` on a
  fall-through), `handler_outcome` (`lane_reply` or `fallthrough:<why>`) and `model`; the verdict's `reason` stays the
  route's reason (`routed`); `verdictInsert` takes `route_outcome` from that outcome (today it derives it from
  `ACTED.has(reason)`, which must not be the source on a lane settle), and the `triage` event's `decision` and the decision
  rows (`jev_decisions`) take the same outcome. One write, no patch. `save_outcome` carries the attempted save's result (`not_durable` / `capped` / `none`).
- **A rule committed: settle inside the save transaction** with `handler_outcome = pending` (as `saveThenRoute` does today,
  so the save and its verdict stay atomic), then the lane runs and **patches** `handler_outcome`, `model` and, on a
  fall-through, `route_outcome = fallback` (`JevVerdictPatch.route_outcome` widens to `"pin_failed" | "fallback"`). On
  this path the `triage` event and the decision rows record the save-time decision (the save did act); the verdict row is
  the per-turn truth, as the parent §6 defines it.
- `TurnRoute` is unchanged (role, effort, verdict id). The status lane keeps its settle-after order and drops its
  `jev_skipped` re-labelling (`tests/core/core-worker-triage.test.ts` ~413–428 updates that one expectation to `routed` +
  `fallback`). The planner's end (`ompRouteEnd`) may later set `model` on a fall-through row to the planner's leg; the
  lane's own model is on its `lane` attempt rows.

Steps: (0, core-worker) save a rule if `route.save`; mint the id (and settle, when a save committed); (1) render the
prompt; (2) one `compose` call on the Fast chain, role `lane`, `deadlineMs` = min(45 s, remaining) with the turn's
`signal`; (3) non-empty text → `laneCard`; settle or patch as above; empty → fall through.

**Prompt** (`renderLanePrompt`): one lane preface line first ("Quick reply: no tool, file or action is available this
turn; answer in the message's language; say plainly when the question needs a search or an action"), then the planner's
own system prompt (`buildSystemPrompt(turnContextDeps, chatId).text`: the `omp` surface with `safeLessonSection`, so the
lane and the planner read the **same lessons**; `HOUGE_ASK_SYSTEM_PROMPT` does not apply to lanes; the lane does not call
`recordAttribution`, so lesson `last_used` moves only on planner turns: accepted, small), then the `[context]` block exactly
as `buildTurnPrompt` renders the retrieved facts and wiki pages (`retrieve(chatId, message)`), then the thread: each of
`recentTurns` as `Paco: …` / `Houge: …` clipped by `feedTurnText(…, turnChars)`, the quoted turn ahead of it as `replying to
(Houge|Paco): …` (the same `quotedLine` the planner gets), then `Paco: <message>`, then the `[memory]` note line when a
rule was saved this turn. The one-shot sends system and user text as one prompt, as every one-shot does.

**Records:** the compose `llm_attempt` rows have `role = lane` (new `LlmCallRole`, as stage A added `cascade`; the planner
stays `compose`, so "zero planner requests" is readable) and `routed_by = verdict_id`; the verdict's `model` is taken from
the compose call's result, never from a role-`lane` ledger lookup (the lookup lane's rewrite writes role-`lane` rows too); `finishLane` records the user and
assistant chat turns as for the memory lane; `triage.route_lane = answer`.

## 5. The lookup lane

A **75 s** lane budget (`deadlineAt`) with a **15 s compose reserve**: a step may start only while `remaining − 15 s` is
positive, else `lane_timeout`; the parent's chat behaviour (follow-ups queue behind a running triage) makes a long lane a
visible cost, so no step waits for a provider's full timeout:

1. (core-worker) save a rule if any; mint the id (settle when a save committed). A message containing a URL never reaches
   the lane (§2's code rule).
2. **Query.** Jev sorted the message with the thread in view, so a confident `lookup` can be a follow-up that means
   nothing as a search ("再查一次", "melbourne呢？", "具体时间？": 12 of the 38 replayed takes). Whether a short message is a
   follow-up is a judgment call, so it goes to a model, behind a cheap code pre-filter (AGENTS.md: code owns the gates, the
   model composes between them):
   - **Pre-filter** (`needsRewrite`): the message is ≤ 40 chars or quotes a turn, **and** Paco's previous Telegram line in
     this chat is ≤ 30 minutes old. Replay: fires on 15 of 38 takes, covering 7 of the 12 follow-ups (the 5 missed: 2 are
     "again" requests 54–287 minutes after the previous line, 3 refer to Houge's own earlier report or digest, which no
     rewrite can recover) and 8 standalone messages (which the rewrite should leave alone).
   - **Rewrite** (`rewrite`): one one-shot on the **Tiny** role (role `lane`, chain = Tiny candidates, bounded at
     min(12 s, remaining − 15 s): live K3 answers small prompts in a median ~7 s, 53 of 70 within 10 s, and the bound covers
     the whole chain, so a cut leg never reaches the Gemini candidate), given the last two Paco lines, the last Houge line
     and the quoted turn if any (each clipped to 200 chars) and the message, asked for **one standalone web-search query** on a single line, or the token `SAME` when the message already is
     one. `validateQuery` accepts a single line ≤ 120 chars with no URL and no newline; anything else, `SAME`, a timeout or a
     failed leg → the bare message. The memory lane's distill is the precedent for a Tiny step inside a lane.
   - Then whitespace-collapsed and cut at 200 chars. The same string is the reader's `objective`.
   The parent spec's lookup row ("code builds the query") is amended for this in its Rev 10 (§3 row 2, §12), so the
   binding contract and this step agree.
   The code rule Rev 4 had (prepend the previous line) was re-scored by the senior review and dropped: it fired on 28 of 39
   takes and put an unrelated earlier topic ahead of 16 standalone questions (§13).
3. **One search** through `createWebSearchAdapter` (the configured chain, Tavily then Firecrawl; `max_results` =
   `resolveWebMaxResults(env)`), raced against min(25 s, remaining − 15 s); the adapter takes no signal, so a late result
   is **discarded** (`signal.aborted` or past the bound → drop, never use). `ok: false` of any cause → `search_failed`;
   `ok` with zero results → `no_results`. Ledger `web_search_performed {query, provider, source_urls, result_count}` as the
   planner's wrapper writes it; `turnCtx.sourceUrls` gets the URLs.
4. **Reader wall on the result set** (ADR 0014; the planner's `ompQuarantine` does the same per `web_search` call): the
   tool output `{query, provider, results}` with each `content` capped at `WEB_RESULT_CONTENT_CAP` (600) goes to a **strict
   reader** `quarantineExtractStrict(...)`: the same `digestOutput` → `buildReaderQuestion` → two attempts →
   `parseReaderExtraction`, but returning `{ok: false}` on a parse miss instead of the planner's fail-safe `unreadableDigest`
   string (the fail-safe stays for the planner). Each attempt is raced against min(20 s, remaining − 15 s). Output: the
   structured extraction (`summary`, `facts[]`, `answer_to_objective`, `contains_instructions`) and its rendered digest.
   `{ok: false}` → `reader_failed`. The reader's `facts[]` are kept for the lane's `lane_replies` row (§7); **the ledger
   never holds read text** (bridge-handler: `result_digest` is `sha256:… bytes:…` for a read tool, Paco's `fdeb3b8`), so
   the lane writes no `loop_step`. Code keeps **titles and URLs out of the model's hands as free text**: the
   `[sources]` list the composer sees is code-built as `[n] <url>` only (URL validated: `http(s)`, ≤ 200 chars, no
   whitespace; a result whose URL fails validation is dropped from the list), the digest under it.
5. **Thin → read the top page.** Thin is the reader's verdict: `answer_to_objective === null` (the sources did not answer
   the objective). Then `createHttpFetchAdapter` fetches the first listed result (existing SSRF floor, 15 s, 1 MB,
   6 000-char cap), raced against min(15 s, remaining − 15 s), and the strict reader reads it (second reader call; ledger
   `http_fetch_performed {url, status}`). A fetch or reader failure here is **not** a
   fall-through: compose from the first digest. Never more than one fetch. Case 2 of the gate prints whether it fired.
6. **Compose** on the Fast chain, role `lane`, min(45 s, remaining): the §4 prompt with the `[sources]` block (code-built
   URL list, then the digest(s); `INSTRUCTIONS_NOTE` appended when the reader flagged instructions) ahead of the thread, and
   the instruction: answer from the sources, cite by `[n]`, say when they do not answer. Empty text → `empty_reply`.
7. **Source line.** Code appends `来源 / Sources:` with the URLs whose `[n]` the reply cites, in order; none cited → the first
   listed result only. `laneCard` flattens any markdown link in the body to its plain URL (no masked links anywhere in a
   lane reply).

The lane never asks Paco anything and never writes memory beyond step 1 (parent §3). Latency, expected: rewrite 0 or
~7 s (K3 median; 12 s at the bound, then the bare message), search 2–5 s, reader 5–12 s, compose 3–8 s; a thin result adds fetch 2–10 s and a second reader call. Still no
planner session. **Known bad cells** (ruling 1): a question a search cannot answer (the Mac's public IP; a detail from
Houge's own earlier report or digest) gets a one-search reply that says the sources do not answer; Dig deeper is the path.
About 5 of the 38 replayed takes.

## 6. The card, the correction, the off switch

- Every lane card (answer, lookup, memory, status) ends with **🔍 Dig deeper** → `lane:ask:<run_id>`. The tap re-admits the
  original text as a new turn that skips triage (`triageOverrideFor`), as today, and records `paco_correction =
  ask_anyway` on the lane's verdict (the column value is unchanged; only the label moved).
- `triage_override` gains `lane: Lane | null` (required field, null allowed: a tap on a run with no verdict row — a card
  from before Jev, Jev off at the time — writes `null`, never throws, so Paco's tap always re-admits the turn). The writer
  reads it from the verdict row. `recordTriageOverride` counts the last 7 days **per lane**
  (`countRecentTriageOverrides(lane, since)`, `json_extract(payload_json, '$.lane') = ?` under the `(event_type,
  occurred_at)` index; the live DB has zero `triage_override` events, so there is no legacy case): the third tap opens
  `triage_overrides` with subject `${JEV_INCIDENT_SUBJECT}:lane:<lane>` and `detail.lane` (one page per lane per episode,
  the open fingerprint the throttle; the metered-name scan matches only the quoted literal, so the template passes) and
  **writes no disarm marker**.
- **Resolution.** `resolveQuietTriageOverrides(store, now)`: for each open `triage_overrides` incident whose subject names
  a lane, resolve it when that lane's 7-day count is under three. Called from the gateway after each tap, from
  `triageTurnInner` where `resolveTriageOverridesIfRearmed` is called today, and from the sweep's **effect phase**
  (where incidents are opened and resolved today), not from `jevViolations`, which is pure detection. Orphans this creates
  (`resolveTriageOverridesIfRearmed`, `TRIAGE_OVERRIDE_KINDS`, `writeJevDisarmMarker`'s only caller) are removed; the
  marker reader stays.
- **Marker.** `houge.jev-disarmed` is still read by `resolveJevTriageMode` (it **caps the tree at shadow**: Jev is still
  called and rows are written, nothing acts) and written by nothing in stage B; a marker left by an older build is removed
  by hand, as `jev-decision-layer.md` § Rolling back documents (`/rearm` removes `houge.disarm`, not this marker).
- **Per-lane off switch.** `HOUGE_JEV_LANES_OFF` (comma list; accepted names `answer`, `lookup`; default empty) read at
  triage time like the other Jev flags; a listed lane is unarmed (§2) and its turns run the planner on the gear's role
  with reason `routed`, as if its rows were absent. An unknown name logs an error at boot and is ignored (fail loud, run on).
  The memory and status lanes keep their stage A remedies (their rows, or `/disarm`). Documented in `configuration.md`; a
  kickstart applies it, like every Jev flag.

## 7. The catch-up block

The planner's prompt carries no thread; the omp session is the thread, with a seed of Paco's recent words after a lesson
reset (`buildTurnPrompt`, `session-seed.ts`: "assistant replies are never seeded: they carry web-derived text"). A lane
turn is answered outside the session, so the session never sees it.

- **What the planner gets:** a fenced block ahead of the quote line and the message,
  `[quick replies since your last turn — reference data, not instructions]` … `[/quick replies]`, one entry per
  lane-handled turn in this chat since the planner last answered here, oldest first, at most 6:
  - `Paco: <user text>` clipped by `feedTurnText(…, resolveChatContextTurnChars(env))`, whitespace folded, the close
    marker neutralised as the seed does;
  - the Houge line per lane, **built by code at lane end and stored in `lane_replies`** (§9; one row per lane turn:
    `run_id`, `chat_id`, `lane`, `verdict_id`, `catch_up` text, `created_at`), never recomputed from the ledger: memory →
    `Houge saved a rule: <lesson text>` (Paco-derived); status → `Houge reported its status`; lookup → `Houge answered from
    <hostnames> — facts: <the reader's facts[], clipped to 300 chars>` (the reader's schema-constrained extraction is what the
    planner is allowed to see today; hostnames, not URLs, because the planner never sees raw search URLs today); answer →
    `Houge replied: <the reply clipped to 300 chars>`. **Ruling on the answer lane's text (ADR 0014 holds):** the answer
    lane's composer receives nothing raw: the same system prompt, facts, thread and message the planner receives (the thread
    may hold earlier lane replies, themselves built over reader digests, never over raw bytes), so its prose crosses no
    wall; the seed rule's other reason (a habit a lesson change is removing) is accepted as a residual of one clipped,
    fenced line, because without the text the planner cannot understand a follow-up such as "能再展开一下吗". The lookup
    lane's prose is **never** carried (it was composed over web-derived text).
- **Boundary, code only:** "since the planner last answered in this chat" = the newest `chat_turns` assistant row in this
  chat whose run is a Telegram turn (`runs.source = 'telegram'`), whose intent is not `evolution_report`, and whose run has
  no `lane_reply` verdict (join `chat_turns.run_id = jev_verdicts.run_id`; both carry `run_id`, no FK needed). So an
  evolution report or a schedule-fired reply never moves the boundary (the approval nudge is an assistant row of a
  Telegram run and does move it: harmless, since no lane can run while a planner turn is live).
  `RunStore.laneTurnsSince(chat_id, since)` returns the `lane_replies` rows after it joined to their user text. The seed is **ignored for the boundary**; when a seed is pending in the same prompt, the block omits the `Paco:`
  lines of runs the seed already shows (dedupe by `run_id`; the seed query returns `run_id`) and keeps the Houge lines.
- **Where and caps:** computed inside `buildTurnPrompt` next to `sessionSeed`, Telegram source only (a schedule fire gets
  none); whole block ≤ 2 000 chars (oldest entries dropped first); empty when nothing was missed (most planner turns, no
  cost). `recordAttribution` writes `catch_up_run_ids` into `loop_started.applied_artifacts`, so the gate and the ledger can
  see which runs were caught up; a unit test asserts the dispatched prompt text too.

## 8. Failure modes

One `LaneWhy` list, shared spelling `fallthrough:<why>` on the verdict:

| Where | `why` | Result |
|---|---|---|
| Fast role resolves empty | `no_fast_leg` | planner on Default (`fallbackRoute`), verdict `fallback` |
| compose: every leg fails / deadline / empty text | `compose_failed` / `compose_timeout` / `empty_reply` | planner on **Default** (the Fast list just failed), `fallback` |
| compose returned text, card render throws | `render_failed` (today's status spelling) | planner on Default; the text is discarded |
| any unexpected exception inside a lane | `lane_threw` | planner on Default; the error logged with the run id |
| lookup: search `ok: false` / zero results / past its bound | `search_failed` / `no_results` / `search_timeout` | planner on Default; a late result is dropped |
| lookup: strict reader failed on the result set | `reader_failed` | same |
| lookup: fetch or second reader fails | — | compose from the first digest; not a fall-through |
| a step would start inside the 15 s reserve | `lane_timeout` | same as `compose_timeout` |
| turn aborted (`/kill`, shutdown) | `aborted` | the lane returns within its bounds (compose aborted by the signal; late search/reader results dropped); no card, no planner. **No save committed:** the finaliser's `laneLost` guard means **no verdict is written**, exactly as a killed status or memory turn today; the run's own failure record (`runs`, `planner_failed`) is the record. **A save committed:** the pre-settled row is patched `fallthrough:aborted`, unconditionally and after the lane returns; if the supervisor's terminal close wrote `planner_failed` first, the patch overwrites it (the close is guarded on `pending`, so it can never undo the patch) |
| rule save not durable / capped / nothing to save | existing `not_durable` / `capped` / `none` stay the memory lane's spellings | a lane still replies; `save_outcome` records it |
| run failed after a lane reply | `run_failed` (existing) | unchanged |

`countLaneTurns` (the `lane_fallthrough_rate` feed) **drops `fallthrough:aborted` rows from both counts** (turns and
fall-throughs): a kill is not a lane failure. `/kill` cannot cancel an outstanding reader or search HTTP call; the lane
ignores their results after the signal fires (guard on every `await`), and nothing but the `aborted` write follows the
abort. The warming planner child: unchanged from stage A (`finishLane` supersedes a start that does not settle within
`ABORT_GRACE_MS`); during a lane the child idles, and a fall-through reuses it warm.

## 9. Records

- **Migration `2026-10-10-jev-verdicts-lanes`**: `jev_verdicts.lane` CHECK admits `answer` and `lookup`. SQLite cannot
  alter a CHECK: in one transaction, `ALTER TABLE jev_verdicts RENAME TO jev_verdicts_old`; `CREATE TABLE jev_verdicts`
  with the full stage A column list (the 23 live columns, the widened CHECK; no triggers or views exist on the table);
  `INSERT INTO jev_verdicts (<all 23>) SELECT <all 23> FROM jev_verdicts_old`; assert equal row counts; `DROP TABLE
  jev_verdicts_old`; then recreate `jev_verdicts_run_idx` and `jev_verdicts_created_idx`; record in `schema_migrations`. It
  runs at `RunStore.open`, so the gate's VACUUM copy migrates too.
- **Migration `2026-10-10-lane-replies`**: `CREATE TABLE IF NOT EXISTS lane_replies (run_id TEXT PRIMARY KEY, chat_id
  TEXT NOT NULL, lane TEXT NOT NULL, verdict_id TEXT, catch_up TEXT NOT NULL, created_at TEXT NOT NULL)` with an index on
  `(chat_id, created_at)`; written once per lane reply (memory and status included, so their gap closes too); read by §7.
  No ledger text: the catch-up text is a store row, like `chat_turns`.
- `run-ledger.ts`: `triage_override` required fields gain `lane` (null allowed); `llm_attempt.role` admits `lane`;
  `loop_started.applied_artifacts` gains `catch_up_run_ids`; the lane writes `web_search_performed` /
  `http_fetch_performed` only; **no new event types, no read text in the ledger**.
- `JevVerdictRow.lane` widens; `JevVerdictPatch.route_outcome` admits `fallback`; `insertJevVerdict` takes an optional id;
  `settleFor` takes an outcome; `LlmCallRole` gains `lane`; `OneShotAdapterOptions.routed_by`; `TREE_THRESHOLD_VERSION`
  bumped.
- `houge_status` and `/models` unchanged. The replay report (§10) and `triage-report.ts` constants widen with `Armed`.

## 10. Arming evidence (replay rows on disk, no new Jev call)

`.houge/jev-tree/replay.jsonl` (301 answered turns, 2026-10-09) scored with **§2's rules** (the senior re-review re-ran
them): the lanes would take **78 turns (answer 39, lookup 39)**; 19 more exceed their limits (answer 18, lookup 1) and stay
on the planner. Against Paco's 111 labels: lookup 7/7 right; answer 6/9 (misses: `self_change` ×2 — questions about
Houge's own behaviour — and `lookup` ×1). Against the tool proxy the large cell is **24 proxy-`research` turns the lookup
lane would take** with one search (the known "research read as lookup" weakness); Paco's labels rated 0 of 7 lookup picks
wrong, so the proxy overstates it. **Role change:** 26 of the 78 (answer 14, lookup 12) ran the planner on Default under
stage A and move to Fast. **Lookup text review** (the 39 takes joined to their messages, 38 after the URL message goes
to the planner): 12 are follow-ups; the §5 pre-filter reaches 7 of them for the Tiny rewrite; about 5 cannot be answered by
a search (ruling 1). The parent's "58% of past
turns" was the proxy share of the two categories, not the lanes' take at the bar. The two-request guard's figures are in
§2.

**Report extension** (`triage-report.ts`, same build): `ALL_ARMED`, `NONE_ARMED` and `ARMING_COMBOS` widen to the new
`Armed` fields (combos `+answer`, `+lookup`, `+both`), `routeLines` shows `answer/fast` and `lookup/fast`, and `costlyCells`
gains "a lane took a turn whose truth is another category" per lane, plus the Default→Fast count above. No replay re-run:
the `category` hash is unchanged.

## 11. Tests and live gate

- **Policy table**: both lanes at the bar; each limit edge (0.5 / 1.5 with EPS, `breadth` on answer); lane unarmed, lane
  off, `rule` unarmed, gear unarmed → the stage A planner route with reason `routed`; `thinkHarder` → Thinking; `bareAck` →
  `bare_ack_guard` (fallback); a cascade pick of `answer` never a lane; `sets_rule` yes + lane keeps `save`; the two-request
  guard at 1.49 (lane) and 1.5 (planner, `two_request`) and inert with gear unarmed; `decisionFor` on the new reasons;
  `treeArmingRows` with the two keys; the threshold version stamp.
- **Each lane hermetic** (`tests/core/lanes/*.test.ts`, stubbed compose, search, fetch, strict reader, clock): reply; each
  `why` in §8 including `lane_threw` from a throwing dep; `needsRewrite` on each clause (≤ 40, quoted, > 30 min old, no previous
  Telegram line) and `validateQuery` (SAME, two lines, a URL, > 120 chars, a clean query), the rewrite's timeout and failed
  leg falling back to the bare message, the 200-char cut; the thin trigger on `answer_to_objective` null vs set; one fetch
  at most; fetch failure still composes; the code-built `[sources]` URL list (an invalid URL dropped) and the digest under
  it; the `lane_replies` row's text per lane kind; `INSTRUCTIONS_NOTE` on a flagged read; the source
  line from `[n]` citations and the none-cited default; markdown links flattened in the body; the `[memory]` note; prompt
  contents (preface first, system prompt identity with the planner's, thread order, quoted line, context block);
  `[[attach:]]` stripped; a late search result after abort is dropped; the budget (a 20 s search leaves compose 45 s; a
  step that would start inside the 15 s reserve is `lane_timeout`; each reader attempt bounded); the card's button and
  `callback_data` length.
- **Core-worker**: no-save and refused-save paths settle once after the lane with `fallback` on a fall-through and the
  attempted `save_outcome`; the committed-save path settles pending in the save transaction and patches, `route_outcome`
  flipped to `fallback` on a fall-through; a killed no-save lane turn writes no verdict; a killed committed-save turn ends
  `fallthrough:aborted` whichever write lands first; the URL rule sends a `lookup` route to the planner with `lane_limits`;
  `laneTurnsSince`; `countLaneTurns` drops `aborted` from both counts; the status lane's fall-through row reads `routed` +
  `fallback`.
- **Turn context**: the catch-up block edges (§7): none, one, more than six, over 2 000 chars, a pending seed (Paco lines
  deduped, Houge lines kept), one entry per lane kind (memory, status, lookup with hostnames and facts, answer with clipped
  text), an evolution report or schedule reply does not move the boundary, a schedule-fired turn gets none; the dispatched
  prompt text contains the block; `catch_up_run_ids` in `loop_started`.
- **Store**: the verdicts migration on a DB holding stage A rows (rows kept, counts equal, indexes present, a second run
  a no-op), on a fresh DB, and the widened CHECK; the `lane_replies` table and `laneTurnsSince`; `triage_override.lane`
  incl. null; `countRecentTriageOverrides`; `insertJevVerdict` with a supplied id.
- **Gateway**: `lane:ask:` and legacy `memlane:ask:` both parse; a tap on a run with no verdict writes `lane: null` and
  re-admits; three overrides on `answer` in 7 days open `triage_overrides` with the lane subject and no marker; two on
  `answer` plus one on `lookup` open nothing; the quiet resolver closes the incident when the count drops; the memory
  lane's lane-1 auto-disable test is rewritten to this.
- **Registry**: `seatChain("lane")` throws without a chain; `routed_by` on every leg's attempt.
- **Supervisor**: a refused-pin walk that exhausts the chain ledgers `routed_escalation.kind` as the error that started
  the walk, not `model_missing` (§12); `ompRouteEnd` then labels that verdict `escalation` (stated, §12).
- **Live gate** `scripts/live-gate-jev-tree.mjs`, on the DB copy with the real Jev and real omp. `writeCalibration` and
  `checkCommittedArming` gain the two rows; "planner requests" = `llm_attempt` with role `compose` (the Jev call is role
  `triage`, the lane's is `lane`). The existing probes keep calling `triageTurn`; a lookup-shaped probe now runs the real
  lookup lane there (intended: counted in the gate's budget, must not throw) and the probe check accepts a `lane_reply`
  outcome. New cases, all as full `turn()`s in `g.chat`:
  1. a chat turn ("你觉得 NAS 放在客厅还是书房更好？") → `lane = answer`, `lane_reply`, `route_outcome = act`, zero `compose`
     attempts, ≥ 1 ok `lane` attempt and every `lane` attempt on a Fast candidate with `routed_by` = the verdict id, the card
     has the button;
  2. "明天悉尼天气怎么样？" → `lane = lookup`, one `web_search_performed`, every `reader` attempt on the Reader list, a
     `lane_replies` row with hostnames and facts, a source line in the text, at most one `http_fetch_performed`; the case
     prints whether the thin-result fetch fired and whether the rewrite ran (it will: `g.chat` holds this run's earlier
     turns within 30 minutes) and what query it produced;
  3. `MSG.research` → the planner; PASS as `research` on Thinking (existing case) or as an over-limit `lookup` with reason
     `lane_limits` on the gear's role; the lanes idle;
  4. `MSG.ruleLookup` → `save_outcome = saved` and either `two_request` + a planner reply, or the lookup lane's card after
     the save; the case records which; a lane card that answers only the rule is a FAIL;
  5. a Dig deeper tap on case 1's card, driven as a `memlane_ask` event straight into `Gateway.intake` → a second run with
     skip `override`, planner on Default, `paco_correction = ask_anyway` on the first verdict, `triage_override.lane =
     answer`;
  6. a planner turn right after case 2 in the same chat ("那后天呢？认真想": `think harder` forces the planner, so the case is
     never INCONCLUSIVE) → its `loop_started.applied_artifacts.catch_up_run_ids` contains case 2's run id.
  `caseAck` is unchanged (the ack stays on the planner). Cases judge by the recorded verdict; INCONCLUSIVE when Jev takes
  another path, FAIL under `--real-calibration` for cases 1 and 2. **`scripts/live-gate-omp.mjs` case 2** sends a weather
  message through the daemon and asserts a bridge `tool_finished` and short `result_digest`s; once the lanes are armed that
  message takes the lookup lane, so the case appends `认真想` (`think harder` forces the planner) and keeps its assertions.
  `think harder` also marks the previous verdict in that chat `paco_correction = think_harder`, so the omp gate must run on
  its DB copy only (as it does today) and never on the live DB.
- **PASS criterion:** cases 1, 2, 5 acted with zero `compose` attempts on the lane turns; every `fallthrough:*` in the gate
  carries a `why` from §8's table; at most 1 silent Jev skip in ≥ 8 real calls; `pin_failed` = 0; case 6's run id present.

## 12. Stage A leftovers

- **A dedicated fall-through record** (the "`lane_failed` reason" of the stage A notes): the verdict row's `lane` + `reason`
  + `route_outcome = fallback` + `handler_outcome = fallthrough:<why>` (§2, §4). The `jev_skipped` re-labelling goes.
- **Refused-pin step-up cause**: `pinWalk` passes `why = "model_missing"` for every candidate after the first, so when the
  walk exhausts the chain `stepUp` ledgers `routed_escalation.kind = model_missing` even when the walk began with `quota`
  or `timeout`. Fix: `currentCandidate` receives the walk's original `kind` for the step-up record; per-leg `model_missing`
  attempt rows are unchanged. Consequence, accepted: `ompRouteEnd` copies `routed_escalation` into `paco_correction =
  escalation` unless the kind is `model_missing`, so a quota-started walk that hits refusals now labels the verdict
  `escalation`, which is the truthful label.
- **Two-request guard**: §2.

## 13. Dropped on review

- **The bare-ack rule as a lane** (Rev 1). It settles before Jev is called, so there is no reported model to arm against,
  and the replay report replays `ACK_ROUTE` as a constant. A bare "谢谢" keeps running the planner on Fast; parked.
- **Snippets straight to compose** (Rev 1; ADR 0014, ruling 2), and **titles in the `[sources]` list** (Rev 2).
- **A disarm marker per lane** (Rev 1; ruling 4 made it moot).
- **A `lane_fallthrough` ledger event** (Rev 1) and **a `lane_failed` route reason** (Revs 1–3): the verdict row's four
  columns are the record; the reason would have been persisted nowhere.
- **The 400-char thin threshold** (Rev 2): it counted the digest's fixed frame and varied by language.
- **Settle-before-lane on the no-save path** (Rev 2): it recorded every fall-through as `act`.
- **The lookup lane's prose in the catch-up block** (Rev 2): web-derived model text in the planner's prompt.
- **A `fallthrough:aborted` verdict on the no-save path** (Rev 3): the finaliser's lost-turn guard forbids it, and today's
  lanes behave the same.
- **The code-built follow-up prefix** (Rev 4): re-scored on the 39 takes, it fired on 28 and put an unrelated topic ahead of
  16 standalone questions; a 30-minute, Telegram-only pre-filter still prefixed 8 standalone questions. Replaced by the
  pre-filter plus a Tiny rewrite (§5).
- **Reader text in `loop_step.result_digest`** (Rev 4): the ledger never holds read text (`fdeb3b8`); `lane_replies` holds
  the code-built line instead.

## 14. Parked

- A seventh `noul` question for the two-request case (§2), if the gate shows `actions` blind to it.
- A typing indicator during a lane (3–30 s of silence; the memory lane has it today).
- A research lane (stage C, from the lane rows); Jev judges inside the planner loop (mu's checkpoint list), the next spec.
- Per-lane bars above 0.6 if the first weeks' `ask_anyway` rate says so (a bars change, no code).
- Runtime lane toggling (`/lanes`), if the env switch proves too slow in practice.
- Lane turns touching the lessons they render (`recordAttribution` from a lane).
- Widening the rewrite pre-filter (older follow-ups, longer messages) if Dig deeper taps on lookup show misses.

## 15. Review log

- **Rev 1 (2026-10-10):** written after Paco's rulings §1 and the design walk-through (nine sections, approved with the
  button rename). Paco's read of the first draft's per-lane auto-disable ("it could mean a judgement issue, not that the
  shortcut should be off") became ruling 4 before the first review.
- **Rev 2 (2026-10-10):** two reviews of Rev 1 against the live tree. Codex (6 blockers, 4 warnings, 1 suggestion):
  save-then-`lane_failed` needs one verdict order → §4; no cancellation contract → §5 bounds and §8 late-result rule; raw
  snippets cross the reader wall (ADR 0014) → §5 step 4; per-lane `triage_overrides` has no resolver → §6; the replay
  report's arming sets are fixed to stage A → §10; `ACK_ROUTE` cannot become a lane by a field change → §13. Senior review
  (4 blockers, 16 warnings, 12 suggestions; every §10 number re-verified): the ack lane has no model to arm against → §13;
  verdict order → §4; lane replies never reach the planner → §7 (new); the page cannot stay open and the marker text was
  wrong → §6; plus the warnings listed in the Rev 2 entry of the previous revision (role `lane`, the Default→Fast count,
  the same lessons as the planner, `aborted` excluded from the rate, the budget, masked links, `[[attach:]]`, the off
  switch, gate rows).
- **Rev 3 (2026-10-10):** re-reviews of Rev 2. Codex (4 blockers) and the senior re-review (3 blockers, 15 warnings)
  agreed on the first: settle-before-lane recorded every fall-through as `act` → pre-minted id, settle-after on the no-save
  path, a `fallback` patch on the save path. Codex: abort settlement vs the supervisor's `planner_failed`; raw titles reach
  the composer → URL-only list; the catch-up's seed cutoff could drop a lane's answer → boundary rule. Senior: the catch-up
  carried web-derived prose into the planner → code-built lines; gate case 6 read an unrecorded prompt → `catch_up_run_ids`.
  Warnings taken: §10 re-run (78 takes, 26 Default→Fast, answer 6/9); `armed.rule`; `bare_ack_guard` out of `ACTED`;
  `TREE_THRESHOLD_VERSION`; seed dedupe by run; catch-up placement in `buildTurnPrompt`; `search_failed`; the strict
  reader; the 15 s reserve; thin = `answer_to_objective === null`; links flattened; `lane: null` on a tap; the resolver in
  the effect phase; `seatChain("lane")`; off-switch names; "caps at shadow"; gate cases; `.text`; the preface line; legacy
  branches dropped; orphans and protected files named.
- **Rev 4 (2026-10-10):** third round on Rev 3. Codex (5 blockers) and the senior review (2 blockers, 9 warnings).
  Taken: the no-save settle takes an explicit outcome and keeps the route reason (§4); a killed no-save turn writes no
  verdict, as today (§8), and `lane_failed` is dropped as a reason because nothing would persist it (§2, §13); a refused or
  not-durable save settles after the lane with its `save_outcome` (§4); the lookup lane persists the reader digest through
  the existing `loop_step` (§5), which the catch-up reads (§7); the answer lane's clipped reply is carried with an explicit
  ADR 0014 argument (§7); **the lookup query prepends Paco's previous line on a short or recent follow-up** (§5), after the
  senior review joined the 39 replayed lookup takes to their text and found 12 that mean nothing alone; a message with a
  URL goes to the planner (§2); hostnames, not URLs, in the catch-up; a status line; the boundary ignores evolution reports,
  schedule replies and nudges; a lane never throws (`lane_threw`); the probe check accepts a lane reply; case 6 forces the
  planner with `think harder`; `ompRouteEnd`'s later `model` write stated (§4). Not taken: a Tiny query rewrite (parked, §14).
- **Rev 5 (2026-10-10):** fourth round on Rev 4, blockers only. Codex: the reader text in `loop_step.result_digest`
  conflicts with "the ledger never holds read text" → the `lane_replies` table (§7, §9). Senior review: the Rev 4 follow-up
  prefix did more harm than good (28 of 39 fired, 16 unrelated prefixes; a 30-minute Telegram-only pre-filter re-scored by
  the author still prefixed 8 standalone questions, catching 7 of 12 follow-ups) → pre-filter plus a Tiny rewrite with code
  validation (§5 step 2); the same `loop_step` finding, plus `live-gate-omp.mjs` case 2 breaking once the lanes are armed →
  §11. Closure notes taken: `verdictInsert` takes the outcome (§4); the nudge does move the boundary (§7); the answer-lane
  "every input trusted" sentence corrected (§7); the `previousTelegramTurns` source excludes schedule rows (§3).
  Codex round 5: the Tiny rewrite contradicted the parent's "code builds the query" → parent spec Rev 10 amends the row.
  Senior round 5: no blockers; its notes taken as text fixes: rewrite bound 12 s and K3 latency figures, the quoted
  turn passed to the rewrite, verdict `model` from the compose result, gate case 2's rewrite expectation, the omp gate's
  `think_harder` side effect confined to its DB copy, the misses wording.
