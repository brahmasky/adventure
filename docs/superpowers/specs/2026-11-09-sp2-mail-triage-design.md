# SP2 slice 1 — Paco's Gmail: read + inbound triage (Jev lane 4, re-scoped)

**Rev 1.2 · 2026-11-09 · status: reviewed, for Paco's approval.** Rev 1.0 was reviewed by spec-review-senior (Fable 5.1:
2 BLOCKER, 14 WARNING, 9 SUGGESTION) and a codex design pass (6 BLOCKER, 4 WARNING, 1 SUGGESTION), both against the live
code and ADRs. Every blocker and warning is addressed below; the change log is §13.

**Why.** SP2 is "Paco's personal tools", the thing he asked for in June. Jev lane 4 (spec 2026-10-04 §6.3) was built to be
SP2's gate for inbound items, but its premises moved: the nightly digest is gone (2026-11-07), Houge's own notifications
are routed by code per topic (ADR 0031, `TOPIC_ROUTE`), and Jev arms on Paco's word with no shadow period. Read-only
counts on the live DB (30 days, 2026-11-09): about 190 Telegram messages (57 answers to Paco's turns, 53 schedule
reports, 81 run-less cards and pages), 12 incidents, 2 enabled schedules. Houge's own traffic is small, already
code-routed and mostly answers to Paco; the judgment call lane 4 was meant for is **untrusted inbound mail**. So lane 4
becomes slice 1 of SP2.

## 1. Decisions (Paco, in chat, 2026-11-09)

| # | Question | Decision |
|---|---|---|
| D1 | What does lane 4 triage? | **SP2's first slice**: items from outside, mail first. Houge's own notifications keep `TOPIC_ROUTE`; nothing in it changes. |
| D2 | What happens to Paco's incoming mail? | **Ping now + `/inbox`.** Urgent or action-needed mail gets one card at once; everything else waits in `/inbox` to be pulled. Nothing is pushed on a timer. |
| D3 | What may Jev (TypeSafe's hosted API) see? | **Sender + subject + snippet** (+ labels, importance, known flag), after redaction. Never body or attachments. This is Paco's approval of the mail egress class for Jev (the 2026-10-04 spec's "Rulings (Paco, 2026-10-04)" item 3 left it "not approved yet"). |
| D4 | Unsure or Jev down? | **Asymmetric bars**: ping on Jev `now` at ≥ 0.6; `/inbox` only on Jev `later` at ≥ 0.85; anything else, or Jev unavailable, pings. Storm fold: more than 6 pings in 60 min fold. |
| D5 | What does a "wrong urgency" tap change? | **A sender rule, announced, with undo** ("always ping from" / "never ping from"); every tap is also stored as a label. |

Chosen in the design, approved section by section in chat: approach A (code poller + a ladder entry; Gmail push via
Pub/Sub and a planner-turn triage were rejected), 30-day text retention, failure handling (§7), testing and gate (§9–10).

## 2. Scope

**In:** a second Google OAuth grant (Paco's account, `gmail.readonly`); a code poller; the `mail.triage` ladder entry with
one Jev question; code floors and sender rules; the mail card and its taps; `/inbox`; `/mail on|off|status`; on-demand
planner reads of Paco's mail (`gmail_read` / `google_api` with `account: "paco"`); retention sweep; `houge mail auth` and
`houge mail purge` (CLI); a silent-send flag and URL buttons on the Telegram send path; ADR amendments (§8).

**Out:** sending, drafting or labelling mail (a later SP2 slice, `/approve`-gated); Calendar, reminders, files (their own
slices); triage of Houge's own notifications (the 2026-10-04 §6.3 floors about approval cards, supervisor incidents and
the notification storm cap were for those and are **not** part of this spec); attachments; a morning brief; Gmail push
(Pub/Sub); editing sent Telegram messages (Rev 1.0's edit-in-place fold is dropped, §3.4).

## 3. Architecture

```
mail tick (every 5 min, single-flight, 90 s deadline)
  └─ Gmail history.list since cursor (all pages) ─▶ new message ids (INBOX, messagesAdded, de-duplicated)
       └─ for each id not already in mail_items (≤ 3 in flight):
            messages.get format=metadata (From, Subject, Date; snippet; labelIds)        ← never the body
            └─ envelope (code-built, redacted) ─▶ decide("mail.triage") with a queuing recorder   [async: Jev]
                 └─ ONE sync transaction: insert mail_items · flush the decision row · enqueue the card (if lane ping)
  └─ cursor := response historyId, only when every id of the whole range is stored
```

### 3.1 Grant and identity
- `scripts/gmail-auth.mjs --account paco`: client id and secret from `.env` (`HOUGE_GMAIL_CLIENT_ID` /
  `HOUGE_GMAIL_CLIENT_SECRET`; the `client_secret.json` path becomes optional for this branch); `login_hint` and the
  post-auth identity check from `HOUGE_PACO_GMAIL_ADDRESS`, refusing any other signed-in account; it writes **exactly one**
  line `HOUGE_PACO_GMAIL_REFRESH_TOKEN=…`, **replacing** an existing line rather than appending (the env loader keeps the
  first value of a name, `src/config/load-env.ts:43`), and prints "restart the daemon to load it". Without `--account`,
  the script is byte-identical to today (Houge's grant). Scope stays `gmail.readonly` — the hard floor (ADR 0025).
- One new broker-held secret, `HOUGE_PACO_GMAIL_REFRESH_TOKEN`: added to `SECRET_ENV_NAMES`, given a **broker getter**
  and included in the broker's redaction set (`src/config/secret-broker.ts`). (The `/_TOKEN$/` pattern would strip it
  anyway; the getter is what makes it reachable.)
- Houge's own address becomes an exported constant `HOUGE_GMAIL_ADDRESS = "wukong.houge@gmail.com"` (today it lives only
  in the script and a doc).
- `src/capabilities/google-api.ts` gains `account: "houge" | "paco"`; the worker holds **two auth clients keyed by
  account** (each its own token cache, `google-auth.ts`), so `/mail off` can `invalidate()` Paco's alone. The allowlist
  registry stays one row per granted scope; the account selects the token, never the path set.
- `houge mail auth` runs the paco branch above (Paco runs it; browser consent is operator-side).

### 3.2 Poller (`src/mail/poller.ts`, new)
- **On only when** `HOUGE_MAIL_ENABLED` (default off; in `DISARM_FLAGS`, because it reads under Paco's identity) **and**
  the stored switch `/mail on` (`mail_state.enabled`) are both on, a refresh token is present, and the daemon is not
  killed or parked.
- Cadence `HOUGE_MAIL_POLL_MIN` (default 5, min 2, max 60). Single-flight: a tick that finds the previous one running is
  skipped and logged. **Tick deadline 90 s** (the `GMAIL_OP_DEADLINE_MS` precedent); at most 3 `messages.get` in flight.
- **Cursor** `mail_state.history_id`. A tick reads `history.list?startHistoryId=<cursor>&historyTypes=messageAdded&labelId=INBOX`
  through every page (`maxResults=500`), collecting `history[].messagesAdded[].message.{id, threadId}` and de-duplicating
  ids (Gmail's `messages[]` may repeat; it is not read). It then processes ids not already in `mail_items`. The cursor
  advances to the last page's response `historyId` **only when every collected id has been stored**. A tick that hits its
  deadline stores what it finished and leaves the cursor; the next tick re-reads the same range (cheap: ids only) and
  skips stored ids by the unique `gmail_message_id`. Nothing in the range is skipped.
- `messages.get?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date` (the shape
  `gmail-read.ts` already uses). The poller never requests `format=full` or `raw`; a test pins every request URL. A 404 on
  `messages.get` (deleted or moved before fetch) skips that id without blocking the range.
- **First run** (no cursor): take the profile's current `historyId` as the cursor, list `in:inbox newer_than:1d` (cap 200),
  store those with lane `inbox` and reason `backfill` — no Jev call, no ping.
- **Cursor expired** (Gmail 404 on `history.list`; per the API reference a `historyId` is valid "typically at least a
  week, in rare cases only a few hours", so this path is tested from day one): list `in:inbox after:<last received epoch>`
  (cap 500, newest first), store them as `backfill` (`inbox`) except where an `always` rule applies (those ping, under the
  fold), then reset the cursor to the profile's current `historyId`. One `mail_log` change-log line: "Mail caught up:
  N in /inbox" — and, if the cap was hit, "M older not listed, see Gmail". This is the one place items can be left
  unlisted (an outage of more than 500 mails); it is reported, not silent.

### 3.3 Envelope and the Jev state
Two shapes, built by code (`src/mail/envelope.ts`, new), never by a model:

- **`MailItemState`** (rule side, never leaves the machine): `{ item_id, from_address, from_name, known_sender, subject,
  snippet, labels, important, thread_id, thread_pinged_6h, received_at, backfill }`.
- **`MailJevState`** (what Jev sees — **exactly D3's set**, the egress set the ADR 0033 amendment approves):
  `{ from_name, from_address, known_sender, subject, snippet, labels, important }`. No time, presence, thread or
  language field (Rev 1.0's `received_local_hour`, `paco_active_30m`, `thread_size`, `language` are dropped from the Jev
  state; Q3 answered: code only). A test serialises the Jev request and asserts this key set.

Text handling, applied to **every untrusted text field** (`from_name`, `subject`, `snippet`) before it is stored, sent
to Jev or rendered:
1. Caps from `src/capabilities/gmail-read.ts` (`HEADER_FIELD_CAP` 200 for `from_name` and `subject`, `SNIPPET_CAP` 300),
   exported, not restated; text hygiene as gmail-read does.
2. The judge redactor (ADR 0034 7.2): `redactForJudge(text, { brokerRedact, codeShapes: true, linkTokens: true })`
   (`src/decisions/egress.ts`). `codeShapes` is what masks standalone 6–8 digit codes such as `482913`.
3. The redacted text is the only form stored, sent and shown. Raw text is never stored.

`from_address` is parsed from the `From` header by code and accepted only if it matches an addr-spec allowlist
(`^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$`, lower-cased); otherwise it is stored as `invalid`, rules
cannot match it, and `known_sender` is false. The address is sent to Jev as is (D3 approves the sender); it is the key for
exact rules.

`known_sender`: true when an `always` rule exists for the address, or Paco's Sent mail has a message to it
(`q=in:sent to:"<validated address>"`, `maxResults=1`, one query per address, cached in `mail_senders` for 30 days). An
invalid address never reaches a query. Cost: at most one extra Gmail call per new sender per 30 days.

ADR 0034 7.2 I1 ("the planner gets no text as judged that Jev did not see") does not bind here: the planner never receives
the envelope; it reads mail only on demand through the reader wall (§3.6).

### 3.4 The `mail.triage` entry (`src/decisions/entries/mail-triage.ts`, new)
- `id: "mail.triage"`, unlocked, `input: "tool"`, `stage: "inbound"` (new value in `DECISION_STAGES`, same commit; no
  planner turn exists, and `after_turn` would wrongly enrol it in the streak pager, `record.ts:117`), `alwaysRecord: true`
  (every mail is a decision Paco may review; without it a floor-decided default `ping` writes no row, `record.ts:36–40`).
- Verdicts `ping | inbox`; `defaultVerdict: "ping"`, `fail: "ping"`.
- Ladder:
  1. **rule `mail_floors`** — answers or abstains, in order: sender is `HOUGE_GMAIL_ADDRESS` → `inbox`, `own_output`
     (belt and braces: Houge has no send scope, ADR 0025); `never` rule → `inbox`, `rule_never`; `always` rule → `ping`,
     `rule_always`; backfill → `inbox`, `backfill`. Otherwise abstain.
  2. **system_one `mail_urgency`** — bars: one `ProvisionalBar` `{ question: "mail_urgency", p: 0.6, source: "Paco D4
     2026-11-09, armed at ship" }`; the downgrade bar is an exported constant `MAIL_DOWN_BAR = 0.85` applied inside the
     rung. The rung **always answers** when Jev answers (the `improve.route` ruling-18 precedent, `improve-route.ts:93`):
     `now` at p ≥ 0.6 → `ping`, `jev_now`; `later` at p ≥ 0.85 → `inbox`, `jev_later`; otherwise → `ping`, `jev_unsure`,
     with `p` = the top option's. When Jev is unavailable (transport, timeout, parse, skip, metered fuse), the runner
     records it in its own vocabulary: `rung: "fail"`, `fallback_rung: "system_one"`, `fallback_reason` ∈ {outage,
     timeout, parse, threw}, verdict `fail` = `ping`. No other rung exists.
- Effects: `ping` → `{ kind: "effect", reversible: false, announced: "card" }` (a sent message); `inbox` → `{ kind:
  "effect", reversible: true, announced: "inbox" }`. `Announce` gains `"inbox"` ("listed in `/inbox` with a
  should-have-pinged tap; a pull surface, accepted only under rule 2.6"). A third set `ROUTED_ANNOUNCED = {card, inbox}`
  is consulted only by the 2.6 arm; `ANNOUNCED` and `GATED_ANNOUNCED` do not change.
- `perItemRouting` — a **runtime gate with a call site**, not just a declaration: `perItemRouting(state: MailItemState,
  verdict): boolean` returns true only when `verdict ∈ {ping, inbox}` and the state is one item's (`item_id` set, built by
  `envelope.ts`, no sibling item). The poller calls it before the transaction; false → the item is stored `inbox`,
  reason `routing_refused`, and a `decision_internal` log line is written (it should never happen).
- `MAIL_TRIAGE_ID` joins `JEV_PAGED_ELSEWHERE` (`record.ts:30`): a Jev outage pages through the Jev client's own `jev_*`
  incidents, with `jev_skip_rate` as the sweep's slow backstop; no `decision_fallback` page for mail ("one call, one
  page").
- Decision rows: `run_id` null and the `mail_items.item_id` in `tool_call_id` (both allowed: 115 live rows have a null
  `run_id`; only `tool.policy` and `standing-approval.ts` interpret `tool_call_id`, each scoped by entry id). Codes only —
  sender and subject never enter `decisions`.
- **Write path** (closes both reviews' transaction blocker): (1) build the envelope; (2) `decide(MAIL_TRIAGE, …)` with a
  **queuing recorder** (the front door's `deferredRecorder` / `flushLadder` pattern, `core-worker.ts:3015–3035`), so the
  async Jev call happens before any write; (3) `perItemRouting`; (4) the fold and thread rules (code, below); (5) **one
  synchronous `BEGIN IMMEDIATE`** that inserts `mail_items`, writes the queued decision row with a **strict flush**, and,
  for lane `ping`, enqueues the card with outbox key `mail:<gmail message id>`. The strict flush is a new export of
  `src/decisions/record.ts`, `recordStrict(store, entry, r, ctx, now): string`, sharing `rowOf` and `shouldRecord` with
  `storeRecorder` but calling `store.insertDecision` **without** the catch: it returns the decision id or throws, so a
  failed insert aborts the transaction. (`storeRecorder` swallows insert failures and returns `null`, `record.ts:49–62`,
  and `flushLadder` does not treat `null` as a failure, `core-worker.ts:3033`; neither can enforce this.) The bookkeeping
  `storeRecorder` does around the insert (`clearFallback`, `afterRecord`) runs **after the commit**. If the transaction
  throws, nothing of the item is stored, the cursor has not moved, the next tick retries it, and a failed decision insert
  opens `decision_record_failed` (the existing kind) after the rollback — a mail is never stored without its decision
  row, nor pinged without its row.
- **Fold** (code, after the verdict; not a decision): if ≥ 6 items with `lane='ping'` were stored in the last 60 min
  (counted from `mail_items`, not the outbox), the item is stored `lane='inbox'`, reason `folded`, and — once per hour
  bucket — one card is enqueued: "More urgent mail this hour — see /inbox" (key `mail:fold:<YYYY-MM-DDTHH>`). No message
  is ever edited. Kill/park outrank the fold; nothing else does.
- **Thread**: a mail whose thread pinged in the last 6 h is stored `lane='inbox'`, reason `thread_pinged`, with no card.
  Folded and thread items are therefore always reachable in `/inbox`.

### 3.5 Jev question (`src/jev/questions/mail.ts`, new)
`MAIL_URGENCY` choice, options in order `later` (escape first: jev-1.13 leans to the first option), `now`; criteria:
`now` = "Paco must see or act on this within hours: a person writing to him, a deadline today, a security or money alert
about his own accounts, a reply he is waiting for"; `later` = "it can wait until Paco looks: newsletters, receipts,
notifications, marketing, automated updates". A second choice `MAIL_KIND` (`fyi | action | risk | noise`) labels the card
and groups `/inbox`; its answer never changes the lane. Both calls go through `src/jev/decide.ts` (run-less, as
`improve-ask.ts`); **no `jev_verdicts` row** is written (that table is the front door's, `run_id NOT NULL`), and
`jev_decisions` rows are **not persisted** for mail (as `improve-ask` and `memory-kind-ask` choose); the `decisions` row
carries the p. The Jev request state is `MailJevState` only.

### 3.6 Card, taps, commands
- Topics: `mail_card` → chat and `mail_log` → log, new rows in `TOPIC_ROUTE`. Rendered by the rich renderer:
  `📧 <from_name, redacted> · <kind>` / redacted subject / `(Jev unavailable)` when so. No snippet on the card.
- Telegram send path gains `disable_notification?: boolean` on `TelegramSendMessageInput` and the outbox payload, and
  **URL buttons** (today buttons carry callback data only). Both are additive; existing payloads are unchanged.
- Quiet hours 23:00–07:00 Sydney (`HOUGE_MAIL_QUIET`, default `23-7`): mail cards send with `disable_notification`
  (silent), not held.
- Taps (callback data carries ids, never an address; each shape a pinned regex with a `Buffer.byteLength ≤ 64` test, as
  the other families in `telegram-command-parser.ts`): **Open** — a URL button
  `https://mail.google.com/mail/u/?authuser=<address>#inbox/<thread id>` (code-built, the only link on the card; an
  unverified deep-link format, checked in the live gate); **Wrong urgency** `mail:wu:<item_id>` → a follow-up card with
  **Never ping from this sender** `mail:never:<item_id>` / **Always ping from this sender** `mail:always:<item_id>`. The
  rule is keyed by the item's validated address, applies from the next mail, and is announced as a `/changes` line
  carrying the rule id and a masked address (`maskSubject` precedent, `incident-route.ts:94`) with its undo command
  `/mail_undo <rule id>`. A tap also writes a `mail_labels` row.
- `/inbox`: unseen items with `lane='inbox'` (any reason: `jev_later`, `folded`, `thread_pinged`, `backfill`, rules),
  grouped by kind, oldest first, **30 per page with a "next" tap** (`mail:page:<n>`); an item is marked seen
  (`mail_items.seen_at`) when its page renders, so nothing unseen is skipped. `/inbox all` shows the last 7 days, seen or
  not. Each line carries a "should have pinged" tap (`mail:shp:<item_id>`: label + offer of an `always` rule). Items past
  retention render as `sender · date · kind`.
- `/mail on|off|status`: the switch, and a status line (enabled, last successful poll, items today, pings today, folded
  this hour, Jev state including "fused" when the ADR 0019 metered fuse has latched). `/mail off` stops the poller,
  invalidates Paco's cached access token, and blocks on-demand reads (below). The refresh token stays in `.env`; revoking
  it is Paco's, at myaccount.google.com/permissions.
- **On-demand reading:** `gmail_read` and `google_api` take `account: "houge" | "paco"` (default `houge`; today's calls
  unchanged). `account: "paco"` is refused by code unless `HOUGE_MAIL_ENABLED` **and** `/mail on` (one wrapper check,
  one test). Results go through the reader wall and `tool.injection` exactly as today's gmail results do.

## 4. Data

```sql
CREATE TABLE mail_items (
  item_id TEXT PRIMARY KEY, gmail_message_id TEXT NOT NULL UNIQUE, gmail_thread_id TEXT NOT NULL,
  from_address TEXT NOT NULL, from_name TEXT, known_sender INTEGER NOT NULL, labels_json TEXT NOT NULL,
  important INTEGER NOT NULL, received_at TEXT NOT NULL, subject TEXT, snippet TEXT,   -- redacted; NULL after retention
  lane TEXT NOT NULL CHECK (lane IN ('ping','inbox')),
  kind TEXT CHECK (kind IS NULL OR kind IN ('fyi','action','risk','noise')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('jev_now','jev_later','jev_unsure','jev_unavailable','rule_always',
    'rule_never','own_output','backfill','folded','thread_pinged','routing_refused')),
  decision_id TEXT, notification_id TEXT, seen_at TEXT, text_cleared_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX mail_items_lane_seen ON mail_items(lane, seen_at, received_at);
CREATE TABLE mail_sender_rules (rule_id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('always','never')), source_item_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE mail_labels (label_id TEXT PRIMARY KEY, item_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('wrong_urgency','should_have_pinged')), created_at TEXT NOT NULL);
CREATE TABLE mail_senders (address TEXT PRIMARY KEY, in_sent INTEGER NOT NULL, checked_at TEXT NOT NULL);
CREATE TABLE mail_state (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, history_id TEXT,
  last_ok_at TEXT, last_error_code TEXT, failing_since TEXT);
```
`mail_items.reason_code` `jev_unavailable` is the item's own code for a `rung fail` decision row. Additive migration only.
Undo of a rule deletes the rule row and writes a change-log line; labels stay. `mail_senders` and `mail_sender_rules` hold
addresses by design.

**Retention.** A daily sweep, for items older than `HOUGE_MAIL_TEXT_DAYS` (default 30, min 1):
- sets `mail_items.subject` / `snippet` / `from_name` to NULL and stamps `text_cleared_at`;
- rewrites every `mail_card` outbox row of those items to the stripped form (`📧 · <kind>`), recomputing `payload_hash`
  with `stableHash`. A row still queued after 30 days cannot normally exist (the outbox dead-letters after its retry
  budget); if one does, it is stripped too, so a stale card can only ever send without text.
Metadata, decisions, labels and rules stay. **Accepted gaps, written into the ADR:** the nightly DB snapshots
(`src/run/db-backup.ts`) keep older text until they rotate out; Paco's own Telegram history keeps what was sent; the
`/changes` lines keep masked addresses. `houge mail purge --yes` (CLI only, irreversible) does all of the sweep now for
every item and deletes `mail_senders`.

**What leaves the machine.** TypeSafe: `MailJevState`, redacted (D3). Telegram: the card (redacted sender name, redacted
subject, kind). Nothing else. Logs, `/status`, decision rows and gate output carry ids, counts and codes only.

## 5. Floors Jev cannot cross
1. Kill / park / `/disarm` stop the poller (no decisions while stopped); `/disarm` reaches mail through
   `HOUGE_MAIL_ENABLED` (`HOUGE_JEV_ENABLED` is the front door's master only).
2. Mail never causes an action: no tool call, reply, rule, lesson or schedule comes from mail content. Rules come only
   from Paco's taps. No `improve.route` signal is fed from `mail_items`.
3. Paco's sender rules outrank Jev.
4. Houge's own mail is never pinged (`own_output`); triage never reads its own output.
5. Each Jev call judges one item's `MailJevState` only (`perItemRouting` checks it at runtime).
6. The poller never fetches a body or attachment.

## 6. Commands, env vars, docs surface
- Telegram: `/inbox` (`all`), `/mail` (`on|off|status`), `/mail_undo <rule id>`; the parser uses the
  `command === "/x"` form (docs parity). README entries.
- CLI: `houge mail auth`, `houge mail purge --yes`.
- Env (`docs/reference/configuration.md`): `HOUGE_MAIL_ENABLED` (off, `DISARM_FLAGS`), `HOUGE_MAIL_POLL_MIN` (5),
  `HOUGE_MAIL_QUIET` (`23-7`), `HOUGE_MAIL_TEXT_DAYS` (30), `HOUGE_PACO_GMAIL_ADDRESS` (plain), `HOUGE_PACO_GMAIL_REFRESH_TOKEN`
  (secret, broker-held).
- Registry: `ENTRY_IDS`, `REGISTRY` (the `toHaveLength(40)` assertions in `tests/decisions/registry.test.ts` become 41);
  `docs/reference/decision-map.md` registry row; ladder spec §6.1; `docs/reference/jev-decision-layer.md`: questions
  `mail_urgency`, `mail_kind`; CONTEXT.md: "mail item", "sender rule"; `status-lines.ts` re-read for stage assumptions.
- Incidents: `mail_auth_lost` and `mail_poll_failing` in `INCIDENT_ROUTE` (page, with act text); `mail_auth_lost` in
  `REMIND_KINDS` (a dead grant deserves the daily reminder); `mail_poll_failing` in `SWEEP_INCIDENT_KINDS`.

## 7. Failure modes

| Failure | Behaviour | Paco sees |
|---|---|---|
| `invalid_grant` / 401 after refresh | Poller pauses (`last_error_code`), cursor kept, no retry until a restart or `/mail on` | One `mail_auth_lost` page: "run `houge mail auth`, then restart the daemon"; daily reminder while open |
| 429 / 5xx / network | Backoff 1, 2, 4 … 30 min; cursor unchanged; `failing_since` stamped | `mail_poll_failing` page when the poller's own tick sees `failing_since` older than 2 h (5-min detection); resolved on the next success |
| Poller silently dead (a bug: no tick runs) | The invariant sweep reads `mail_state.last_ok_at`; older than 2 h while enabled → `mail_poll_failing`. It reads the poll timestamp, never mail cards (monitors must not observe their own output). Detection within one sweep interval (12 h default) — honest bound | One page |
| `history.list` 404 | Resync (§3.2) | One `mail_log` line, with the "M older not listed" count if the cap was hit |
| `messages.get` 404 | That id skipped; range continues | — |
| Tick hits 90 s | Stored items stay; cursor kept; next tick continues | — |
| Jev down / timeout / malformed / metered fuse | `rung fail` → `ping`; card says "(Jev unavailable)" | Jev client's `jev_*` incident (one call, one page; `JEV_PAGED_ELSEWHERE`); `/mail status` shows "fused" for the fuse |
| > 6 pings / 60 min | 7th onward → `/inbox` (`folded`); one fold card per hour | ≤ 7 mail messages an hour |
| Thread burst | Later mail in a pinged thread (6 h) → `/inbox` (`thread_pinged`) | One card per thread |
| Crash between Jev and the commit | Nothing of the item stored; cursor not advanced; next tick re-decides it | No loss; at most one extra Jev call |
| Crash after the commit, before the outbox sends | The outbox retries its own row (key `mail:<id>`) | One ping |
| Decision flush fails inside the transaction | Whole item rolls back, retried next tick | — |
| Overlapping ticks | Single-flight skip | — |
| Hostile subject or sender name | Reaches Jev only as data in one typed question (worst case: its own lane); the card escapes it; the planner sees mail only on demand, through the wall; an address outside the allowlist cannot reach a Gmail query | — |

## 8. ADR changes (drafted with the code, merged in the same branch, signed by Paco)

### 8.1 ADR 0034 — **change of meaning (Tier C), approved by Paco's spec approval**
- **New rule 2.6, the second named allowance (alongside 2.4).** Today rule 2.1 says that over tool-derived input,
  explicitly including mail, a Jev verdict "may only tighten". `mail.triage`'s Jev rung routes an untrusted mail between
  two code-owned lanes that both deliver the item to Paco: a card now, or a listing in `/inbox`. Rule 2.6 allows exactly
  that and nothing wider:
  (a) `defaultVerdict === fail ===` the card lane, so a Jev `ping` is indistinguishable from Jev being absent; **the only
  difference the Jev rung can cause is `inbox` — a reversible, listed delay of that item's own delivery**;
  (b) the down bar is ≥ 0.85, the up bar ≥ 0.6, unsure routes up;
  (c) Paco's sender rules and the code floors outrank the rung;
  (d) every `inbox` item carries a "should have pinged" tap;
  (e) the entry names `perItemRouting`, a runtime gate called before any write, true only for one item's state and a
  verdict in the two lanes. Like `pacoWordsOnly`, it is a declaration whose truth the entry's tests carry; the
  `tests/adr/0034-2.6` case asserts behaviour, not shape: an `inbox` item is listed by `/inbox`; an `always` rule beats a
  Jev `later`; a Jev `ping` writes the same outbox row as no Jev at all; a state with a second item is refused.
  Reason, restated and tested on today's system (lesson "ADR is a reason, not a rule"): rule 2.1 exists because Jev is
  steerable by injected text; under 2.6 the worst a hostile mail can do is change **its own** lane — delay itself to
  `/inbox` or ping itself — which degrades quality, never safety, and every outcome stays visible to Paco.
- **2.5 / `entryProblems`:** both `shapeProblems`' provisional-bar clause and `effectProblems`' R12 loop gain a
  `perItemRouting` arm: `input === "tool"`, a function-valued `perItemRouting`, exactly two verdicts, each an `effect`
  announced in `ROUTED_ANNOUNCED` (`card` for the up lane, `inbox` for the reversible down lane), and
  `defaultVerdict === fail ===` the `card` lane. Any other tool-input entry with a non-tightening Jev effect still fails.
  A registry test pins both sides (passes `mail.triage`; fails a copy without the predicate, one with a third verdict,
  and one whose default is the `inbox` lane).
- **6.1:** "the provisional-bar rule extends to that gated case" names 2.6 as well as 2.5's allowance.
- **Rule 4:** row for `mail.triage` (unlocked, rule + system_one, stage `inbound`, `alwaysRecord`, reasons, `tool_call_id`
  = item id, `run_id` null). **Stage list** gains `inbound`. **Rule 3** (recording): the queuing recorder flushed inside
  the caller's transaction joins the front door as a named pattern.
- Code greps for what 2.6 forbids (run in the plan and the final review): no mail text in `decisions`, `ledger_events`,
  `change_log` (beyond masked addresses), logs, `jev_verdicts` or `jev_decisions`; no planner tool or `improve.route`
  signal reads `mail_items`; no `format=full|raw` in `src/mail/`; no message edit on the mail path.

### 8.2 ADR 0033 (Jev System One)
Lane 4 is redefined as `mail.triage` (inbound mail; Houge's own notifications out of scope). The mail egress class for
Jev — `MailJevState`: redacted sender name, sender address, known flag, redacted subject and snippet, labels,
importance — is approved by Paco on 2026-11-09 (D3). Outages page through the Jev client's incidents as for every
entry in `JEV_PAGED_ELSEWHERE`.

### 8.3 ADR 0025 (Google API surface)
Two identities: Houge's (`HOUGE_GMAIL_ADDRESS`) and Paco's, both `gmail.readonly`; the account picks the token, never the
allowlist; `account: "paco"` is refused unless mail is enabled and on. Houge never sends from either in this slice.

### 8.4 ADR 0015 (secrets)
The broker-held set gains `HOUGE_PACO_GMAIL_REFRESH_TOKEN` (getter + redaction). The ADR's stale count ("five secrets",
`0015:57`; nine today) is corrected to match `SECRET_ENV_NAMES` (ten), with no change of meaning.

### 8.5 ADR 0031 (notification topics)
`mail_card` (chat) and `mail_log` (log) join the closed topic set; mail cards may send silently (quiet hours) and carry a
URL button.

`tasks/todo.md` records D1–D5 as "decided, not shipped" until merge; each ADR above carries "to be changed, spec
2026-11-09-sp2-mail-triage" until the amendment merges with the code. Checkable rules get `tests/adr/` cases named after
the rule id (2.6 behaviour, the 2.5 arm, 7.2 redaction of every envelope text field, 0033's egress key set).

## 9. Testing (hermetic: real SQLite; Gmail, Jev, Telegram, clock stubbed; synthetic mail only — the repo is public)
- Envelope: caps reuse the gmail-read constants; a planted `482913` and a verification link in subject, snippet **and
  sender name** are masked before the row write and before the Jev call (asserted absent from both); the Jev request's key
  set equals `MailJevState`; an address outside the allowlist is `invalid`, unmatched by rules, never queried.
- Poller: request URLs never carry `format=full|raw`; multi-page history is read to the end and the cursor advances only
  after every id is stored; a deadline mid-range leaves the cursor and the next tick finishes with no double row; a
  `messages.get` 404 skips one id; cursor 404 → backfill without pings, an `always` rule still pings, cap reporting;
  first run → 24 h to `/inbox`; `invalid_grant` → pause + exactly one `mail_auth_lost`; overlap → skip.
- Write path: a crash injected after the Jev answer and before the commit stores nothing and the retry pings once; a
  crash injected inside the transaction (after the row insert, before the enqueue) rolls back the row; a failing
  `insertDecision` inside `recordStrict` rolls back the item and opens `decision_record_failed` once; a crash after commit sends exactly one card.
- Ladder: floor order; bar boundaries 0.59/0.60 and 0.84/0.85; `jev_unsure` row carries the top p; Jev transport failure
  → `rung fail`, `fallback_rung system_one`, verdict `ping`, item reason `jev_unavailable`; no `decision_fallback` page
  after 3 Jev failures in an hour (`JEV_PAGED_ELSEWHERE`); every item has exactly one decision row (`alwaysRecord`);
  `perItemRouting` refuses a two-item state.
- Registry: `entryProblems` passes `mail.triage` and fails the three mutants of §8.1.
- Fold and thread: the 7th ping in 60 min is stored `inbox`/`folded` with one fold card per hour bucket and no edits; a
  second mail in a pinged thread is `inbox`/`thread_pinged`; both are listed by `/inbox`.
- `/inbox`: pages of 30, oldest first, nothing unseen skipped across pages; `seen_at` set on render; `/inbox all`.
- Taps: callback shapes match their regexes and are ≤ 64 bytes; never ⇄ always rules; `/changes` line with masked address
  and rule id; `/mail_undo` → next mail back on Jev.
- Switch: `/mail off` stops the poller, invalidates only Paco's token, and makes `account: "paco"` reads refuse;
  `gmail_read` without `account` is byte-identical to today (existing tests unchanged).
- Retention: day-30 sweep nulls item text and strips every `mail_card` outbox payload past retention (hash recomputed); `/inbox` renders the stripped form; `purge --yes` clears all.
- Telegram: `disable_notification` and URL buttons reach the client; existing payloads serialise byte-identically.
- No leak: `decisions`, `change_log`, `ledger_events`, `/status`, the daemon log and the Jev request capture never contain
  a planted subject; the address appears only masked outside `mail_*` tables and the Jev request.
- **Unchanged behaviour:** the Stage 4 differential (18 corpora) shows 0 differences against the merge base; a rollback
  check opens a DB this slice wrote with the pre-slice build.

## 10. Live gate (`scripts/live-gate-mail-triage.mjs`)
**Before the gate:** the daemon's mail is off (`/mail off`, or `HOUGE_MAIL_ENABLED` unset); the gate reads `mail_state`
from the live DB (read-only) and refuses to run otherwise, so Paco is never pinged twice. Paco runs `houge mail auth`, then
sends himself three mails from another address, each subject carrying a gate-chosen token: "URGENT: confirm by 5pm
today", a newsletter-style mail, and one containing "your code is 482913".

The gate runs the real poller against real Gmail (read-only), real Jev, a VACUUM copy of the DB, and Paco's Telegram
(inside the test surface). It matches only the three planted mails by token; any other mail in the window is counted,
never shown. Step 5 needs no fourth mail: it re-decides the stored newsletter item with the new rule applied.

PASS needs every line:
1. All three planted mails found, each with exactly one `mail_items` row and one `mail.triage` decision row.
2. Jev answered for at least 2 of the 3: rung `system_one` **and** `fallback_reason IS NULL` — a silent Jev outage fails.
3. The urgent mail pinged; the newsletter did not (else INCONCLUSIVE, Jev's call, as on the jev-tree gate).
4. `482913` appears nowhere: the DB copy, the Jev request capture, the card text, the gate output.
5. A `never` rule on the test sender routes the re-decided item to `inbox` (`rule_never`); `/mail_undo` restores Jev's
   call on a second re-decide.
6. An injected 401 (the gate's transport wrapper around the real client) opens exactly one `mail_auth_lost` incident.
7. A second poll over the same window sends no second ping.
8. The card's Open button opens the planted thread (Paco confirms by tapping; the deep-link format is otherwise unverified).

## 11. Rollout
After merge, rebuild and kickstart, `HOUGE_MAIL_ENABLED=1` and `/mail on`: armed at ship, per Paco's no-shadow rule.
`/mail off` stops it; `HOUGE_MAIL_ENABLED` is in `DISARM_FLAGS`.

## 12. Open questions
None left from Rev 1.0: Q1 (stage) — a new `inbound` value; Q2 (callback size) — ids only, pinned regexes, byte test;
Q3 (`paco_active_30m`) — dropped from the Jev state; quiet hours use the clock only.

## 13. Change log
**Rev 1.1–1.2 (2026-11-09)**, from the two reviews and codex's scoped re-review of 1.1:
- Write path made real: queuing recorder + one sync transaction with a strict flush (`recordStrict`) that throws on a
  failed insert (both reviews' blocker; codex's re-review found `storeRecorder` swallows failures); crash tests.
- Jev state limited to D3's set as `MailJevState`; rule-side fields stay local (Fable blocker); every untrusted text
  field redacted, including the sender name (codex blocker); exact redactor call (`codeShapes`).
- Cursor advances only after the whole history range is stored; deadline and resync cap reported (codex blocker).
- Fold and thread items stored as `inbox` with their own reasons; no message edits; `/inbox` paged with per-item
  `seen_at` (codex blocker, Fable warnings).
- Retention also strips every past-retention outbox payload, queued included; remaining gaps named (codex blocker and
  re-review, Fable warning).
- Not taken: redacting the sender **address** before Jev (codex). D3 approves sending the sender; the address is the rule
  key and passes an allowlist before use. Codex's re-review agrees D3 approves it.
- 2.6 predicate given a runtime call site, the bounding sentence, both `entryProblems` arms and behaviour mutants;
  `Announce` gains `inbox` with its own allowlist; one `ProvisionalBar` + `MAIL_DOWN_BAR` (codex blocker, Fable warnings).
- Reason codes in the runner's vocabulary (Jev rung always answers; `rung fail` for outages); `alwaysRecord`;
  `JEV_PAGED_ELSEWHERE` (Fable warnings, codex warning).
- Broker getter and redaction for the new token; auth script paco branch replaces its line and says to restart (codex and
  Fable warnings).
- `account: "paco"` gated by the mail switch; two auth clients (Fable warning).
- Telegram: `disable_notification` and URL buttons named as additions (codex warning).
- Incidents: one opener per kind and an honest sweep bound; route, remind and sweep lists (Fable warning).
- Per-tick 90 s deadline, 3 concurrent gets, `messages.get` 404 (Fable warning).
- `jev_verdicts` claim corrected; `jev_decisions` not persisted (Fable warning).
- Live gate: daemon's mail must be off; step 5 by re-decide; line 2 checks `fallback_reason`; line 8 checks the Open link.
- Suggestions taken: callback regexes + byte test; Gmail facts pinned; address allowlist before any query;
  `HOUGE_GMAIL_ADDRESS` constant; CHECKs on `kind` and `reason_code`; metered fuse in `/mail status`; parity list.
