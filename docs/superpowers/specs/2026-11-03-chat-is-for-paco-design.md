# Chat is for Paco — design

**Rev 1.2 · 2026-11-03 · Decisions 1-A, 2-A, 3-A, 4-A (Paco, 2026-11-03)**
**New:** ADR 0031. **Amends:** ADR 0024 (sweep), ADR 0028 (model tiers, omp drift kinds), ADR 0029 (`triage_overrides`),
ADR 0030 (decision-health kinds).
**Rests on:** an inventory of every enqueue site and incident kind (`main` @ `76d972a4`, live DB read-only, 2026-11-03).
**Reviews:** senior (Fable 5.1, 4 B / 14 W / 9 S) and design pass (Sonnet 5.5 in codex's seat — codex quota exhausted
until 2026-11-04 18:39; 2 B / 10 W / 5 S). Every blocker is closed below; the change list is §12.

## 1. Why

Paco, 2026-11-03, on three `🔁 X now resolves to kimi-code/k3.1-pro` lines and an empty-tier card: *"treat the telegram
channel as end-user focus. What's happening in the background can be folded into /status or other system command. But the
audit trail / change log should always be there."* On the card: *"if there is only one pro model from Gemini, what's the
purpose for me to select?"*

The audit trail mostly exists (ledger events, `model_tiers`, `incidents`, decision rows) but nothing turns it into plain
words, and background notices are pushed to chat.

**Last 30 days (live DB):** 128 run reports, 84 approval rows, 29 rating asks, 14 command replies, 9 incident alerts,
8 digests, 4 model-roles notices, 4 idea panels, 2 daily reminders, 1 each of urgent card, tier card, memory card, Jev card.

## 2. Decisions (Paco, 2026-11-03)

- **1-A — one router at the outbox.** Every notification names a `topic` from a closed set; a code table maps each topic to
  `chat` or `log`; a `log` notification becomes a `change_log` row instead of an outbox row.
- **2-A — incidents by kind.** One table says, per kind, `page`, `card` (the caller's own card is the page) or `log`. Page =
  Paco must act, or his answers, schedules or messages are affected now, or a locked rule says it reaches him. Log =
  Houge-internal with a working fallback. A kind whose ADR text says "pages" and moves to log is a reading of that ADR, listed
  in §5.4 for Paco's signature.
- **3-A — renamed Gemini models join the pro tier**, tested and adopted like any tier move; the card stays for a tier whose
  family has no model, offering only that family's ids.
- **4-A — `/changes` plus one `/status` line.**

## 3. Scope

**In:** the router and `change_log`; a topic on every enqueue; the incident route table, plain-words incident text, subject
masking; the model-roles notices; the gemini-pro pattern; family-only card proposals; retiring a card-tap override the tier
now covers; `/changes`; the `/status` line; `/help`; ADR 0031 + amendments; the gates this changes on purpose; docs.

**Out (unchanged, all `chat`):** command replies, run reports, approvals (prompt, resolved, expired), memory cards, rating
asks, the decision digest, idea panel, standing-approval cards, improvement-job cards, self-write notices, budget fuses.
Row-only incident kinds (planner_* row kinds, cleanroom/shell kinds, `outbox_flush_failed`, `planner_kill_failed`) stay
row-only. The `/status` redesign (ROADMAP) is not absorbed. `self-write-action-handler.ts:327` sends tap answers directly;
they are replies and stay.

**Protected surface:** the build edits `src/omp`, `src/decisions`, `docs/decisions` and run-store/ledger code under this
spec's approval (AGENTS.md Tier A). A guard hit there is expected, not a regression.

## 4. The router

### 4.1 Topics

`src/notifications/topics.ts` (new):

```ts
export const TOPIC_ROUTE = {
  reply: "chat", run_report: "chat", approval: "chat", memory_card: "chat", rating_ask: "chat", digest: "chat",
  urgent: "chat", idea_panel: "chat", self_write: "chat", budget_fuse: "chat", improve_job: "chat", jev_card: "chat",
  model_card: "chat", incident_page: "chat", incident_reminder: "chat", incident_summary: "chat",
  model_change: "log", incident_log: "log", jev_notice: "log", skill_reverify: "log", decision_internal: "log"
} as const satisfies Record<string, "chat" | "log">;
export type NotificationTopic = keyof typeof TOPIC_ROUTE;
export type ChatTopic = { [K in NotificationTopic]: (typeof TOPIC_ROUTE)[K] extends "chat" ? K : never }[NotificationTopic];
export type LogTopic = Exclude<NotificationTopic, ChatTopic>;
```

The intent becomes a discriminated union (senior W "log with buttons", "target required"):

```ts
export type NotificationIntent = ChatIntent | LogIntent;
interface ChatIntent { topic: ChatTopic; target: NotifyTarget; intent_type: NotificationIntentType; idempotency_key: string;
  run_id?: string; approval_id?: string; correlation_id: string; payload: NotificationPayload }
interface LogIntent { topic: LogTopic; idempotency_key: string; correlation_id: string; text: string; now?: string }
```

A log intent has no target, no buttons and no attachments — a type error, not a runtime throw inside a transaction.
The 11 uses of `NotificationIntent["target" | "payload" | "intent_type"]` in `run-store.ts` become `ChatIntent[…]`.
`NotificationOutbox.enqueue` takes `ChatIntent` only.

| topic | sites |
|---|---|
| reply | every `gateway.ts` command reply, `replyTo` callers, no-ghost acks (`telegram-daemon.ts:254`, `telegram-poll-runner.ts:181`), `cli.ts:302` outbox-smoke, `eval-runner.ts:197` |
| run_report | `enqueueFinalReportNotification`, `enqueueFailureNotification`, `enqueueEvolutionReportNotification` |
| approval | approval prompt (run-level and mid-turn), resolved, expired |
| memory_card | `announceSave` (`memcard:`), `memory-correct.ts` (`memory:`), `enqueueMemoryChangeCard` |
| rating_ask | `session-rating.ts` |
| digest | `decisions/digest.ts` |
| urgent | `enqueueUrgentCard` callers `standing_grant`, `standing_tampered`, `standing_unverified`, `trust_hostile`, `decision_health`, `settle_unverified` |
| decision_internal | `enqueueUrgentCard` caller `decision_fallback` (`record.ts:119`) |
| idea_panel | `idea-panel.ts` |
| self_write | `self-write-action-handler.ts:345` notify, boot `selfwrite:reloaded` |
| budget_fuse | `metered-ceiling.ts`, gateway `global-budget-fuse` |
| improve_job | `skill-job.ts` `enqueueJobCard`, `promote.ts` collision |
| jev_card | `jev-version-job.ts:547` Accept card; the stalled notice (`:175`, it names `houge jev accept`) |
| jev_notice | the other `jev-version-job.ts` notices (deferred, trusted, passed) |
| skill_reverify | `skill-reverify.ts` |
| model_change | the roles tick's notices (§6.2) |
| model_card | `enqueueTierCard` |
| incident_page / incident_log | opened and resolved notices, by kind (§5) |
| incident_summary | the sweep's storm summary (chat: after §5.1 it is only about pages Paco did not get — ADR 0024's reason) |
| incident_reminder | the daily reminder |

`enqueueUrgentCard(store, card, topic: "urgent" | "decision_internal")` returns `string | null`: the outbox id for `urgent`,
the change id for `decision_internal`. `standing_grant` keeps `urgent`, so its "null is fatal" check is unchanged.

### 4.2 Routing at the store

`enqueueNotification(intent)` branches on `TOPIC_ROUTE[intent.topic]` and nothing else:

- `chat` → today's path, unchanged.
- `log` → `RunStore.logChange(intent)` (own method; `enqueueNotification` is already 75 lines): insert into `change_log`
  with `created_at = intent.now ?? new Date().toISOString()`. Same key + same text → `{ status: "duplicate" }`; same key +
  different text → `{ status: "conflict" }` (stderr, as the outbox). Success → `{ status: "logged", change_id }`.
- The result union gains `{ status: "logged"; change_id: string }`. Callers: digest, reminder and urgent use chat topics
  (their `"queued"` checks hold); the typechecker lists every other inspection for the plan.

**A log write never depends on a chat.** Every log-bound site today checks its chat before enqueueing (sweep
`invariant-sweep.ts:421,446,462`; `openAlertedIncident` `incident-alert.ts:37`; Jev notify `jev-version-job.ts:371`;
skill-reverify `:197`; `runRolesTick` `telegram-daemon.ts:745`). The build moves the route decision above each chat check:
a log topic writes with or without a chat; the chat check and flap damping apply to `chat` topics only. Log rows are written
on every open, flapping or not.

### 4.3 `change_log`

```sql
CREATE TABLE IF NOT EXISTS change_log (
  change_id TEXT PRIMARY KEY,           -- chg_<uuid>
  topic TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, -- global, not per chat (no log topic is per chat)
  correlation_id TEXT NOT NULL,
  text TEXT NOT NULL,                   -- code-owned, ids masked (§8)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_log_created ON change_log(created_at);
```

Created in `migrate()` with the other DDL; no backfill; no prune (a few rows a day).

## 5. Incidents

### 5.1 One table

`src/run/incident-route.ts` (new): `INCIDENT_ROUTE` keyed by kind, value `{ route: "page" | "card" | "log"; says: string;
act?: string }`. Its keys define `type RoutedIncidentKind`.

- **Typed, not scanned.** `AlertedIncidentInput.kind` becomes `RoutedIncidentKind`. `SWEEP_INCIDENT_KINDS`,
  `SUPERVISOR_ALERT_KINDS`, the `JevIncidentKind` values, `OMP_CONTRACT_DRIFT`, `OMP_READ_FORMAT_DRIFT`, the anchor kinds
  and `page()`'s kind parameter are typed as members (`satisfies readonly RoutedIncidentKind[]`). A new kind that reaches an
  opener without a route is a compile error. A runtime guard remains: a kind not in the table (a string from an old row)
  pages with the generic text and logs once to stderr.
- **`openAlertedIncident` and the sweep** both call `incidentNotice(kind, subject, now)`, which returns the topic and the
  text: `page` → `incident_page`; `log` → `incident_log`; `card` → nothing (the caller sends its card).
- **`card` kinds:** `jev_model_drifted`, `jev_model_insufficient`, `jev_model_check_stalled`, `decision_health`. Their
  callers stop passing `env: {}`; the table, not the call site, suppresses the generic text. Each card is sent to
  `d.chatId ?? HOUGE_TELEGRAM_CHAT_ID` — today's env-chat fallback is kept, so a daemon whose first allowlisted chat is
  unset still pages. The storm cap counts them as pages.
- **Storm cap** counts `incident_page` and `card` alerts only. `incident_summary` stays chat.
- **Resolve logging at one place.** `RunStore.resolveIncident` writes an `incident_log` row when the kind routes `log` —
  so `syncStaticStale`, `clearFallback`, `resolveQuietTriageOverrides` and `resolveOpenIncidents` are all covered.
  `resolveIncident(id, now, opts?: { silent?: boolean })`: the `event: true` path in `openAlertedIncident` passes
  `silent: true` (the open already wrote its row; one row per event). Page kinds keep today's resolved notice (sweep kinds
  open ≥ 60 min, chat); the sweep's own resolved enqueue runs for page kinds only, so a log kind is never written twice.
- **Reminder.** `REMIND_KINDS` keeps `role_unresolved` and `planner_session_reset_failed` (24 h) and gains
  `omp_contract_drift` at 7 days ("still open after a week: Houge's omp contract check fails; ask Claude to look").
  `static_list_stale` and `model_catalog_unavailable` leave it (log kinds; residual in §11).

### 5.2 Text

Page:

> ⚠️ {says}
> What to do: {act}            ← only when the row has one
> `{kind}` · {masked subject}

Log: `{says} (\`{kind}\` · {masked subject})`. Resolved: `✅ Fixed: {says} — open {N} min`; log rows use the same words.
No JSON detail is printed (today's `buildIncidentOpenedText` dumps it).

**Masking** (`maskSubject`, applied to page and log text alike): `chat:<id>` and a bare chat id → `a chat`; `run:<id>` and
`run_<uuid>` → `a run`; `appr_…` → `an approval`. Code-owned ids stay (`standing:<id>`, `lesson:<id>`, role keys,
selectors, schedule subjects).

### 5.3 The table

**Page:**

| kind | says | act |
|---|---|---|
| stuck_run | A request got stuck and may not be answered. | resend it if it matters |
| undelivered_notification | Some of my messages failed to reach you. | — |
| duplicate_schedule | Two schedules do the same thing; you may get double messages. | `/schedule` to remove one |
| overdue_schedule | A schedule didn't run on time. | — |
| failed_schedule | A schedule keeps failing. | `/schedule` |
| llm_leg_failing | One of my models keeps failing; answers use a fallback. | — |
| disk_free_low | The Mac mini is low on disk space. | free some space |
| wall_collapsed | Web pages are being read without my usual safety split between models. | — |
| lane_fallthrough_rate | A quick-answer lane keeps failing; those messages go the slow way. | — |
| lesson_dropped | A saved lesson no longer fits and isn't being applied. | `/lessons` |
| lesson_render_failed | My saved lessons failed to load; answers run without them. | — |
| embeddings_unavailable | Memory search is down; answers recall less. | — |
| omp_unavailable | My planner can't start; I can't answer messages. | — |
| omp_config_invalid | My planner config is invalid; I can't answer messages. | — |
| planner_crash_loop | My planner keeps crashing. | — |
| planner_start_failed | My planner failed to start. | — |
| wrapper_mismatch | My planner wrapper changed; every answer fails until a restart. | restart the daemon |
| sandbox_unavailable | My sandbox is unavailable; planner turns are refused. | — |
| planner_session_reset_failed | I'm resuming an old conversation with outdated lessons. | send `/fresh` |
| planner_submit_failed | One request failed to reach my planner. | resend it |
| turn_outside_planner | A turn tried to run outside the planner and was refused. | — |
| daemon_tmp_in_git_repo | Voice messages are off: my temp folder is inside a git repo. | — |
| role_unresolved | A model seat has no model. | tap the card, or `/models set <seat> <model>` |
| jev_auth, jev_rate_limited, jev_overloaded, jev_question_invalid, jev_no_key | Jev is unavailable; decisions fall back to a model. | — |
| jev_skip_rate | Jev keeps skipping decisions. | — |
| trust_card_failed, standing_card_failed | A card you should have seen failed to send. | — |

**Card:** `jev_model_drifted`, `jev_model_insufficient`, `jev_model_check_stalled`, `decision_health`.

**Log** (each gets a `says` line in the plan): `heartbeat_gap`, `core_overflow`, `trust_tap_budget`,
`decision_record_failed`, `decision_fallback`, `decision_golden_drift`, `omp_read_format_drift`, `omp_contract_drift`,
`jev_anchor_missing`, `jev_anchor_mixed_models`, `jev_anchor_insufficient`, `standing_sweep_failed`,
`standing_settle_failed`, `standing_evidence_failed`, `todo_reminder_seen`, `static_list_stale`,
`model_catalog_unavailable`, `triage_overrides`, `hostile_schedule_turn` (its `trust_hostile` urgent card pages).

**Messages per event** after the slice: `hostile_schedule_turn` sent two today (incident + card) and sends one;
`trust_card_failed` still pages alone (its card failed). `decision_fallback` and `decision_health` already sent one (the card, via `env: {}`): `decision_fallback`'s
card moves to log (two log rows per episode: the incident and the card text — accepted); `decision_health`'s card stays
the page. (Rev 1.0's "two become one" for these two was wrong.)

### 5.4 ADR readings for Paco's signature

- **Locked, unchanged:** every Jev outage class reaches Paco (AGENTS.md; ADR 0019:123; ADR 0029:126, 227). All page, and
  `jev_skip_rate` with them.
- **Kept as page** where a reviewer found the reading too strong: `wall_collapsed` (ADR 0014:182-184 — a security control
  failing open), `lane_fallthrough_rate` (ADR 0029:226 "a lane that fails pages"). No amendment needed.
- **ADR 0030 reading:** `decision_record_failed` (0030:671, 685 "and its alert"), `decision_golden_drift` (0030:78, 300, 471
  "drift pages"), `decision_fallback` → log. Self-checks of the ladder's own bookkeeping; the decision still runs on its
  fallback; `/status` counts them.
- **ADR 0028 reading:** `omp_contract_drift` (0028:361 "drift pages") → log, reminded at 7 days; `omp_read_format_drift`
  (0028:265 "pages once per omp version") → log, reads fall back to the last known format. Counter-reading recorded: the
  contract probe is the only detector of drift that does not fail a spawn; a drift that degrades answers without failing
  spawns is seen in `/status` (and after 7 days in the reminder) — the residual Paco signs.
- **ADR 0029 reading:** `triage_overrides` (0029:164, 266 "taps page") → log. The taps are Paco's own corrections; the lane
  is throttled either way, and a lane that truly fails pages through `lane_fallthrough_rate`.
- **ADR 0024 reading:** `heartbeat_gap` → log (Paco saw the silence; the gap is recorded); the storm cap counts paged alerts
  and the summary stays in chat.

## 6. Models

### 6.1 The gemini-pro tier reads renames

```ts
const GEMINI_NOT_PRO = "flash|flashlite|lite|preview|image|audio|tts|live|embedding|nano|vision";
{ id: "gemini-pro", provider: "google-antigravity",
  pattern: new RegExp(`^gemini-(\\d{1,2})(?:\\.(\\d{1,2}))?-(?!(?:${GEMINI_NOT_PRO})$)[a-z]+$`), label: "pro" }
```

Today's Google catalog: `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`,
`gemini-3.8-flash`, `gemini-4-argon`, `gpt-oss-120b`, two `tab_*_preview`. The pattern matches `gemini-4-argon` only;
`gemini-N-pro` still matches; two capture groups, so `tierVersion` is unchanged. A new modality word is a one-line change to
`GEMINI_NOT_PRO`.

The live `gemini-pro` row is all null. The next tick (24 h after the last resolution, i.e. on or after 2026-11-04 02:06Z)
plans a `head` probe of `gemini-4-argon` and adopts it on a pass (spec 2026-11-02 §4.2). Only `judges:2` has a
gemini-pro leg. This replaces spec 2026-11-02 §4.4's "code never adopts a codename without a tap" for Gemini (ADR 0028
amendment).

### 6.2 Notices

- `Written.moved` gains `from` (`p.before.adopted`, available in `writeTiers`), and `followRetirement` moves appear in it as
  today.
- **One line per tier move:** `🔁 {provider label} {tier label}: {from} → {to} (used by {roles})`, e.g.
  `🔁 Kimi K: k3 → k3.1-pro (used by Tiny, Judges 0, Reviewer)`. "Used by" = the keys in `changedRoles` whose new head's
  provider/id (`selectorOf(tier, to)` without effort) equals the move's head — not `keysOfTier`, which includes keys whose
  head did not move. A changed key no move explains keeps its own `changeLine`.
- `PROVIDER_LABEL` moves from `gateway/model-tier-commands.ts` to `omp/model-tiers.ts` (the gateway already imports the
  tick; the reverse import would be a cycle).
- Change, failed and shadow lines → topic `model_change` (log), written whether or not a chat is set.
- `role_unresolved` still pages; the tier card (`model_card`, chat) still follows it.

### 6.3 Card proposals stay in the family

`proposalsFor` keeps ids in no tier whose prefix is the tier's family (`claude-` for opus/sonnet, `gemini-` for gemini,
`gpt-` for codex, `k` + digit for kimi). The no-proposal sentence becomes "…offers no other {family} model…". With §6.1 a
Gemini card offers nothing today; `gpt-oss-120b` is never offered for a Gemini seat.

### 6.4 Retiring a card-tap override

Paco's 13:36 tap wrote the override `judges:2 → gemini-4-argon`. Kept, it would pin seat 2 past any newer Gemini.

- **Marker from now on.** The tap's override row carries `via: "tap"` (`recordModelRoleOverride` gains an optional field;
  `run-ledger.ts:348`'s allow-list adds it). `/models set` never writes it. Resolution keeps `latestModelRoleOverrides`
  / `parseOverridePayload` as they are; retirement reads through a new `RunStore.latestOverrideRows()` returning, per key,
  `{ key, pattern, via, sequence }` of the latest run-less override row plus the run-less row just before it.
- **Card-written** means: the *latest* override row for key K has pattern P and either `via: "tap"`, or (rows before this
  slice) the ledger row immediately before it in run-less sequence order (`run_id IS NULL ORDER BY sequence`) is a
  `model_probe {purpose: "tap", result: "pass", selector: "{provider}/{P}", tier: T}` with K a sole key of T. Live: seq 3307
  probe, seq 3308 override. A later `/models set` of the same pattern is a new latest row without either, so it is kept.
- **Retired when** P is a member of T and T's adopted head is P or newer (`compareVersions`): the tier covers the seat.
- **Order in `settle()`:** `writeTiers` → `retireCardOverrides` → `resolveAll()` → notices. Retiring before `resolveAll`
  means the resolution row records `source: "list"` and no shadow line is sent for the retired override.
- Retirement writes the reset row (`pattern: ""`, actor `houge:tier`) and one `model_change` row:
  `Judges 2 now follows Google's pro tier ({head}); your card choice is no longer needed.`

## 7. Reading the log

- **`/changes`:** a `TelegramCommand` variant, `TaskEventType` member, `buildTypedTaskEvent` case, gateway branch (topic
  `reply`), help text. It renders `change_log` rows of the last 30 days, newest first, `DD Mon HH:MM · {text}` in the display
  zone. Each text is cut at 300 chars on a word boundary, a trailing unmatched backtick stripped. Rows are added until the
  reply would pass 3,900 chars (Telegram's limit is 4,096; `CHAT_TEXT_MAX` is the codebase's bound), then
  `… {N} older` closes it. At most 20 rows. Empty: `No background changes in the last 30 days.`
- **`/status`:** the existing self-check line (`gateway.ts:1342`, one count over every open incident) becomes
  `Self-check: swept {t} ago · {P} paged · {M} internal open · {C} changes this week · /changes`, counts by route; a week is
  the rolling 7 × 24 h before now. Built in a `changesLine(now)` helper beside `carryLine`.

## 8. Privacy and safety

- `change_log.text` is code-owned: tier labels, catalog ids, role keys, incident kinds and masked subjects. No message text
  reaches a log builder.
- `/changes` renders no chat id, run id or approval id: masking (§5.2) is applied when the text is built. The test feeds the
  four id-bearing log kinds (`todo_reminder_seen`, `core_overflow`, `hostile_schedule_turn`, `standing_settle_failed`) and
  asserts none of `run_[0-9a-f-]{36}`, `-?\d{6,}`, `appr_`, `notif_`, `chg_` appears.
- No new egress, no new secret, `dependencies` stays `{}`.

## 9. ADRs

- **New ADR 0031 — Chat carries what needs Paco.** The rule (§2), the router, `change_log` as the audit trail, the default
  for an unknown kind (page), the topic and incident tables as the single source.
- **ADR 0024:** storm cap counts pages; summary stays chat; `heartbeat_gap` to log.
- **ADR 0028:** §6.1, §6.3, §6.4; `omp_contract_drift` and `omp_read_format_drift` to log with the 7-day reminder.
- **ADR 0029:** `triage_overrides` to log.
- **ADR 0030:** `decision_record_failed`, `decision_golden_drift`, `decision_fallback` to log; `decision_health` a card kind.
- All await Paco's signature. The 2026-11-02 loud-degradation amendment (unsigned) is touched by the reminder change; they
  sign together.

## 10. Verification

- **Unit:** `TOPIC_ROUTE` total and the `ChatTopic`/`LogTopic` split; log intent has no target (type test); duplicate and
  conflict on `change_log`; `openAlertedIncident` of a log kind with no chat → one `change_log` row; card kinds send exactly
  the caller's card; storm cap counts pages and cards; resolve logging through every `resolveIncident` caller, none for
  `event: true`; reminder set and the 7-day `omp_contract_drift` line; masking on the four kinds; tier pattern on today's
  catalog plus one negative per `GEMINI_NOT_PRO` word (`gemini-4-image`, `-tts`, `-live`, `-embedding`, `-nano`,
  `-flashlite`, …); collapsed notice incl. a retirement move;
  family proposals; override retirement (tap-marked retired; legacy adjacency retired; tap → reset → `/models set` same
  pattern kept; head older than P kept); `settle()` order (one tick: retired, zero shadow lines, `source: "list"`);
  `/changes` 20 × 300 chars ≤ 3,900, empty case, cut; `/status` line.
- **Gates changed on purpose** (each amended in the build, named so a red run is not read as a regression):
  `live-gate-ladder-remainder-r1/r2/r4.mjs` (`decision_record_failed` alert now a `change_log` row),
  `live-gate-loud-degradation.mjs` (reminder kinds), `live-gate-model-tiers.mjs` (card path uses a planted empty family
  tier; argon is no longer a proposal). Tests that build `NotificationIntent` literals use one fixture helper.
- **Live gate** `scripts/live-gate-chat-is-for-paco.mjs` on a `VACUUM INTO` copy, Telegram stubbed, no omp spawn by the
  tick itself: the roles
  tick runs on a `roles` stub fed the live catalog's ids (captured once by the gate's preflight with the real
  `omp models --json`, a read Houge already makes daily), a stub probe, `HOUGE_MODEL_ROLES=resolved`, and
  `now = latest resolution + 25 h`. PASS only if all hold:
  1. `omp_unavailable` opened → one outbox row, zero `change_log` rows;
  2. `decision_record_failed` opened with no chat configured → one `change_log` row, zero outbox rows;
  3. the tick → `gemini-pro` adopts `gemini-4-argon`; the copy's `judges:2` override retired by the legacy adjacency rule;
     zero outbox rows from the tick; ≥ 1 `model_change` row; zero shadow lines;
  4. a planted Kimi move → exactly one `model_change` row naming three roles;
  5. stub probe `model_missing` on a planted empty family → override untouched, a card with no proposals;
  6. `/changes` renders the rows with none of the §8 id shapes; ≤ 3,900 chars;
  7. a `/status` reply → one outbox row, zero `change_log` rows (a wrong default on the reply path fails here);
  8. a kind absent from the table (an old row's string) → pages.
  Line 1 fails if a page goes silent; lines 2–4 fail if background reaches chat.
- **No differential:** behaviour changes by design; the suite and every earlier gate (as amended above) stay green.
- **Rollback** (`scripts/check-chat-is-for-paco-rollback.mjs`): the pre-slice build boots on a post-slice DB, ignores
  `change_log` and sends background notices to chat again (no data loss). **Residual:** after a tick that retired the card
  override, the old build's `gemini-pro` pattern has no member, so `judges:2` reopens `role_unresolved` and the card returns;
  a re-tap or `/models set` restores it. The check asserts exactly that, not a crash.

## 11. Residuals

- Background is visible only when Paco looks (`/changes`, `/status`); the page and card lists are the guard.
- An unknown kind pages until classified — noisy, never silent.
- A multi-day omp catalog outage and a stale static list are visible only in `/status` (they left the reminder); roles keep
  resolving on the last good catalog.
- `omp_contract_drift` that degrades answers without failing spawns: `/status` until the 7-day reminder.
- Rating asks (29 / 30 days) stay in chat; Paco may demote them later.

## 12. Review changes (Rev 1.0 → 1.2)

| finding | source | change |
|---|---|---|
| `/changes` exceeds Telegram's limit | senior B1 | §7 total cap 3,900, `… N older` |
| three "pages" kinds missing from the readings | senior B2, design W4 | §5.4: `lane_fallthrough_rate` kept page; `triage_overrides`, `omp_read_format_drift` read; ADR 0029 added |
| ids in log subjects | senior B3, design W6 | §5.2 masking, §8 test on the four kinds |
| override retirement unsound | senior B4, design B1 | §6.4 `via: "tap"` + run-less adjacency; latest row only; order in `settle()`; head-or-newer |
| log rows gated on chat; "two become one" wrong | design B2, senior W | §4.2 route above chat checks; §5.3 corrected |
| `logged` breaks urgent/outbox wrappers | design W1, senior W | §4.1 union types, `enqueueUrgentCard` signature |
| gates assert old behaviour | design W2 | §10 gates changed on purpose |
| resolve logging partial | design W3, senior W | §5.1 at `resolveIncident`, skip `event: true` |
| static scan blind | design W5, senior W | §5.1 typed kinds |
| `/changes` plumbing | design W7 | §7 lists it |
| collapse data, import cycle | design W8, senior S | §6.2 `from`, join rule, `PROVIDER_LABEL` move |
| regex admits modality ids | design W9, senior W | §6.1 denylist |
| stalled Jev notice needs action | design W10 | §4.1 `jev_card`, §5.3 card kind |
| `env: {}` hidden mechanism | senior W | §5.1 `card` route |
| `wall_collapsed` is a security control | senior W | §5.4 kept page |
| storm summary to log | senior W | §4.1 chat |
| retirement before `resolveAll` | senior W | §6.4 order |
| rollback residual | senior W | §10 |
| `/status` double count | senior W | §7 one line by route |
| gate not hermetic / idle | senior W | §10 stub roles, injected now |
| `omp_contract_drift` counter-reading | senior W | §5.4, 7-day reminder |
| 50-line rule | senior W | `logChange`, `changesLine` |
| non-production sites, fixture helper, dedupe scope, clock, flap, cut, chat regression line | senior S | §4.1, §4.3, §4.2, §7, §10 |
| Rev 1.1 re-review: event-kind skip mechanism, card chat fallback, `via` reader, type rename, wording | senior re-review | §5.1, §6.4, §4.1, §5.3, §10 (Rev 1.2) |
