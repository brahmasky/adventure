# SP2 slice 1 — Paco's Gmail: read + inbound triage (Jev lane 4, re-scoped)

**Rev 1.0 · 2026-11-09 · status: draft for review** (spec-review-senior, codex design pass, then Paco's approval).

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
| D4 | Unsure or Jev down? | **Asymmetric bars**: ping on Jev `now` at ≥ 0.6; `/inbox` only on Jev `later` at ≥ 0.85; anything else, or Jev unavailable, pings. Storm fold: more than 6 pings in 60 min fold into one card. |
| D5 | What does a "wrong urgency" tap change? | **A sender rule, announced, with undo** ("always ping from" / "never ping from"); every tap is also stored as a label. |

Chosen in the design, approved section by section in chat: approach A (code poller + a ladder entry; Gmail push via
Pub/Sub and a planner-turn triage were rejected), 30-day text retention, failure handling (§7), testing and gate (§9–10).

## 2. Scope

**In:** a second Google OAuth grant (Paco's account, `gmail.readonly`); a code poller; the `mail.triage` ladder entry with
one Jev question; code floors and sender rules; the mail card and its taps; `/inbox`; `/mail on|off|status`; on-demand
planner reads of Paco's mail (`gmail_read` / `google_api` with `account: "paco"`); retention sweep; `houge mail auth` and
`houge mail purge` (CLI); ADR amendments (§8).

**Out:** sending, drafting or labelling mail (a later SP2 slice, `/approve`-gated); Calendar, reminders, files (their own
slices); triage of Houge's own notifications (the 2026-10-04 §6.3 floors about approval cards, supervisor incidents and
the notification storm cap were for those and are **not** part of this spec); attachments; a morning brief; Gmail push
(Pub/Sub).

## 3. Architecture

```
mail tick (every 5 min, single-flight)
  └─ Gmail history.list since cursor ─▶ new message ids (INBOX only)
       └─ messages.get format=metadata (From, Subject, Date; snippet; labelIds)   ← never the body
            └─ envelope (code-built, redacted) ─▶ mail_items row
                 └─ decide("mail.triage")  rule rung (floors, sender rules) → Jev rung (bars) → default ping
                      ├─ ping  ─▶ outbox (topic mail_card, key mail:<message id>) — same transaction as the row
                      └─ inbox ─▶ nothing sent; listed by /inbox
```

### 3.1 Grant and identity
- `scripts/gmail-auth.mjs` takes `--account houge|paco` (default `houge`, today's behaviour byte-identical). For `paco`
  the expected identity is read from `HOUGE_PACO_GMAIL_ADDRESS` (plain config) and the script refuses any other signed-in
  account, as it does today for Houge's. Scope stays `gmail.readonly` — the hard floor (ADR 0025).
- The client id/secret are reused (one desktop client, two grants). One new broker-held secret:
  `HOUGE_PACO_GMAIL_REFRESH_TOKEN` (joins `SECRET_ENV_NAMES`; stripped from `process.env`, redacted from egress).
- `src/capabilities/google-api.ts` gains `account: "houge" | "paco"` on its deps; each account has its own token cache.
  The allowlist registry stays one row per granted scope; the account selects the token, never the path set.
- `houge mail auth` is a thin alias for `node scripts/gmail-auth.mjs --account paco` (Paco runs it; the browser consent
  is operator-side).

### 3.2 Poller (`src/mail/poller.ts`, new)
- Gated by `HOUGE_MAIL_ENABLED` (default off; in `DISARM_FLAGS`, because it reads under Paco's identity) **and** a
  stored switch `/mail on|off` (a row in `mail_state`). Both must be on. Kill and park stop it like every tick.
- Cadence: every `HOUGE_MAIL_POLL_MIN` minutes (default 5, min 2, max 60). Single-flight: a tick that finds the previous
  one running is skipped and logged.
- Cursor: `mail_state.history_id` (one row). `history.list?startHistoryId=…&historyTypes=messageAdded&labelId=INBOX`,
  paged, at most 200 new ids per tick (the rest next tick). The cursor advances only after every id of the page is
  stored (row + decision + outbox, one transaction per item); a crash re-reads and the unique message id drops repeats.
- Per id: `messages.get?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`. The poller
  never requests `format=full` or `raw`; a test pins the request URLs.
- First run (no cursor): take the profile's current `historyId` as the cursor, list `in:inbox newer_than:1d` (cap 200),
  store those items with lane `inbox` and reason `backfill` — no Jev call, no ping.
- Cursor too old (Gmail 404 on `history.list`): resync with `in:inbox after:<last received epoch>` (cap 200), store as
  `backfill` except where an `always` sender rule applies (those ping, still under the fold), then reset the cursor. One
  `mail_log` change-log line: "Mail caught up: N items in /inbox".

### 3.3 Envelope (`src/mail/envelope.ts`, new; built by code, never by a model)
`{ from_address, from_name, known_sender, subject, snippet, labels, important, thread_size, thread_pinged_6h,
received_local_hour, paco_active_30m, language }`.
- `subject` and `snippet` are capped with the existing `HEADER_FIELD_CAP` (200) and `SNIPPET_CAP` (300) from
  `src/capabilities/gmail-read.ts` (export them; do not restate the numbers), pass text hygiene, then the **judge
  redactor `src/decisions/egress.ts`** (ADR 0034 7.2: codes, links, digit runs, named secrets, URL userinfo, query values).
  The redacted text is what is stored, sent to Jev and shown on the card. Raw subject/snippet are never stored.
- `known_sender`: true when Paco has an `always` rule for the address, or the address appears as To/Cc in Paco's Sent mail
  (`q=in:sent to:<address>`, `maxResults=1`, one query per address, cached in `mail_senders` for 30 days). Cost: at most one
  extra Gmail call per new sender per 30 days.
- `language`: code-detected (CJK share), as the turn tree does.
- 7.2 I1 ("the planner gets no text as judged that Jev did not see") does not bind here: the planner never receives the
  envelope; it reads mail only on demand through the reader wall (§3.6).

### 3.4 The `mail.triage` entry (`src/decisions/entries/mail-triage.ts`, new)
- Verdicts `ping | inbox`; `defaultVerdict: "ping"`, `fail: "ping"`; `input: "tool"`; unlocked; stage `inbound` (new
  stage value; no planner turn exists).
- Ladder:
  1. **rule `mail_floors`** (decides or passes, in order): kill/park → no decision (poller not running); sender is Houge's
     own address (`wukong.houge@gmail.com`) → `inbox`, reason `own_output`; `never` rule → `inbox`, `rule_never`;
     `always` rule → `ping`, `rule_always`; backfill → `inbox`, `backfill`. Otherwise pass.
  2. **system_one `mail_urgency`**: one Jev choice question (§3.5). `now` at p ≥ 0.6 → `ping`, reason `jev_now`;
     `later` at p ≥ 0.85 → `inbox`, `jev_later`; anything else → falls through, reason `jev_unsure`.
  3. default `ping`, reason `default` (Jev unsure) or `jev_unavailable` (skip/transport failure).
- Bars are named fixed bars on the entry (0.6 up, 0.85 down), armed at ship (Paco's no-shadow rule).
- Effects: `ping` → `effect`, irreversible (a sent message), announced `card`; `inbox` → `effect`, reversible (the item is
  listed in `/inbox` with a "should have pinged" tap), announced `inbox`. This needs the new rule 2.6 (§8.1); without it
  `entryProblems` fails the entry, as it must.
- Recording: through `recordSafe`/`decide` like every entry; the decision row carries the `mail_items` id in
  `tool_call_id` (no run exists); `run_id` null. Codes only — sender and subject never enter `decisions`.
- **Fold** (code, after the verdict, not a decision): if ≥ 6 `mail_card` sends in the last 60 min, the 7th onward update
  one fold card "+N more urgent — /inbox" (edit in place). Kill/park outrank the fold; nothing else does.
- **Thread**: a thread that pinged within 6 h does not ping again; its card's count line is edited ("+1 in this thread").

### 3.5 Jev question (`src/jev/questions/mail.ts`, new)
`MAIL_URGENCY` choice, options in order `later` (escape first: jev-1.13 leans to the first option), `now`; criteria:
`now` = "Paco must see or act on this within hours: a person writing to him, a deadline today, a security or money alert
about his own accounts, a reply he is waiting for"; `later` = "it can wait until Paco looks: newsletters, receipts,
notifications, marketing, automated updates". A second choice `MAIL_KIND` (`fyi | action | risk | noise`) labels the card
and groups `/inbox`; its answer never changes the lane. `jev_verdicts.reasoning` is **not written** for mail (Jev may echo
the subject); the verdict row keeps category, p and skip reason only.

### 3.6 Card, taps, commands
- Topic `mail_card` → chat (new row in `TOPIC_ROUTE`); topic `mail_log` → log (catch-up and rule lines). Rendered by the
  rich renderer: `📧 <from_name> · <kind>` / redacted subject / `(Jev unavailable)` when so. No snippet on the card.
- Taps: **Open** (URL `https://mail.google.com/mail/u/?authuser=<address>#inbox/<thread id>`, built by code; the only
  link on the card); **Wrong urgency** → offers **Never ping from <address>** / **Always ping from <address>**; the rule
  is stored, announced as a `/changes` line with its undo command (`/mail_undo <rule id>`), and applies from the next
  mail. A tap also writes a `mail_labels` row.
- 23:00–07:00 Sydney (`HOUGE_MAIL_QUIET`, default `23-7`): pings send with `disable_notification` (silent), not held.
- `/inbox`: items with lane `inbox` received since the chat's `/inbox` cursor (`mail_state.inbox_seen_at`, per chat,
  advanced when `/inbox` renders), grouped by kind, newest first, at most 30 lines + "N more"; each line carries a
  "should have pinged" tap (label + offer of an `always` rule). Items past retention render as `sender · date · kind`.
- `/mail on|off|status`: switch, and a status line (enabled, last successful poll, items today, pings today, open fold).
  `/mail off` also deletes the cached access token (the refresh token stays in `.env`; revoking it is Paco's, at
  myaccount.google.com/permissions).
- On-demand reading: `gmail_read` and `google_api` take `account: "houge" | "paco"` (default `houge`, today's calls
  unchanged). Results go through the reader wall and `tool.injection` exactly as today's gmail results do.

## 4. Data

```sql
CREATE TABLE mail_items (
  item_id TEXT PRIMARY KEY, gmail_message_id TEXT NOT NULL UNIQUE, gmail_thread_id TEXT NOT NULL,
  from_address TEXT NOT NULL, from_name TEXT, known_sender INTEGER NOT NULL, labels_json TEXT NOT NULL,
  important INTEGER NOT NULL, received_at TEXT NOT NULL, subject TEXT, snippet TEXT,   -- redacted; NULL after retention
  lane TEXT NOT NULL CHECK (lane IN ('ping','inbox')), kind TEXT, reason_code TEXT NOT NULL,
  decision_id TEXT, notification_id TEXT, text_cleared_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE mail_sender_rules (rule_id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('always','never')), source_item_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE mail_labels (label_id TEXT PRIMARY KEY, item_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('wrong_urgency','should_have_pinged')), created_at TEXT NOT NULL);
CREATE TABLE mail_senders (address TEXT PRIMARY KEY, in_sent INTEGER NOT NULL, checked_at TEXT NOT NULL);
CREATE TABLE mail_state (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, history_id TEXT,
  last_ok_at TEXT, last_error_code TEXT, failing_since TEXT);
CREATE TABLE mail_inbox_seen (chat_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
```
Additive migration only. Undo of a rule deletes the rule row and writes a change-log line; labels stay.

**Retention.** A daily sweep sets `subject`/`snippet` to NULL and stamps `text_cleared_at` on items older than 30 days
(`HOUGE_MAIL_TEXT_DAYS`, default 30, min 1). Metadata, decisions, labels and rules stay. Known gap, accepted: the nightly
DB snapshots (`src/run/db-backup.ts`) keep older text until they rotate out. `houge mail purge` (CLI only, irreversible,
asks for `--yes`) clears every subject/snippet now and deletes `mail_senders`.

**What leaves the machine.** TypeSafe: the redacted envelope (D3). Telegram: the card (sender name, redacted subject,
kind). Nothing else. Logs, `/status`, decision rows and gate output carry ids, counts and codes only.

## 5. Floors Jev cannot cross
1. Kill / park / `/disarm` stop the poller (no decisions while stopped).
2. Mail never causes an action: no tool call, reply, rule, lesson or schedule comes from mail content. Rules come only
   from Paco's taps.
3. Paco's sender rules outrank Jev.
4. Houge's own mail is never pinged (`own_output`); triage never reads its own output.
5. Each Jev call judges one item's envelope only; no other item's text is in its state.
6. The poller never fetches a body or attachment.

## 6. Commands, env vars, docs surface
- Telegram: `/inbox`, `/mail` (`on|off|status`), `/mail_undo <rule id>`. README entries (docs parity).
- CLI: `houge mail auth`, `houge mail purge --yes`.
- Env (`docs/reference/configuration.md`): `HOUGE_MAIL_ENABLED` (off, `DISARM_FLAGS`), `HOUGE_MAIL_POLL_MIN` (5),
  `HOUGE_MAIL_QUIET` (`23-7`), `HOUGE_MAIL_TEXT_DAYS` (30), `HOUGE_PACO_GMAIL_ADDRESS` (plain), `HOUGE_PACO_GMAIL_REFRESH_TOKEN`
  (secret, broker-held).
- Decision map + ladder spec §6.1: entry `mail.triage`; `docs/reference/jev-decision-layer.md`: question `mail_urgency`,
  `mail_kind`; CONTEXT.md: "mail item", "sender rule".

## 7. Failure modes

| Failure | Behaviour | Paco sees |
|---|---|---|
| `invalid_grant` / 401 after refresh | Poller pauses (`last_error_code`), cursor kept, no retries until `/mail on` or a successful auth | One incident `mail_auth_lost` (page once), text names `houge mail auth` |
| 429 / 5xx / network | Backoff 1, 2, 4 … 30 min; cursor unchanged | Incident `mail_poll_failing` only if no success for 2 h; resolved on next success |
| Cursor too old | Resync (§3.2), backfill to `/inbox` | One `mail_log` line |
| Jev down / timeout / malformed | Falls to default `ping`, reason `jev_unavailable`; card says "(Jev unavailable)" | Existing Jev outage incident (ADR 0033), unchanged |
| > 6 pings / 60 min | Fold card | ≤ 7 mail messages an hour |
| Thread burst | One ping per thread per 6 h, count edited | One card per thread |
| Restart mid-tick | Unique message id + outbox key `mail:<message id>`; row, decision, outbox in one transaction | No double ping, no loss |
| Overlapping ticks | Single-flight skip | — |
| Decision record fails | `recordSafe` (logged, mail still routed) | — |
| Poller silently dead (bug) | The invariant sweep checks `mail_state.last_ok_at` age > 2 h while enabled → `mail_poll_failing`. It reads the poll timestamp, never mail cards (monitors must not observe their own output) | One page |
| Hostile subject | Reaches Jev only as data in one typed question (worst case: its own lane); the card escapes it; the planner sees mail only on demand, through the wall | — |

## 8. ADR changes (drafted with the code, merged in the same branch, signed by Paco)

### 8.1 ADR 0034 — **change of meaning (Tier C), approved by Paco's spec approval**
- **New rule 2.6, the second named allowance (alongside 2.4).** Today rule 2.1 says that over tool-derived input,
  explicitly including mail, a Jev verdict "may only tighten". `mail.triage`'s Jev rung moves an untrusted mail between
  two code-owned lanes, both of which deliver the item to Paco: a ping now, or a listing in `/inbox`. Rule 2.6 allows
  exactly that and nothing wider: (a) the entry names a code predicate `perItemRouting` that holds by construction (the
  judged state is built from one item's envelope; every verdict is a lane that delivers the item; no verdict can act,
  store Paco-facing knowledge, or touch another item); (b) the downgrade bar is ≥ 0.85, the upgrade bar ≥ 0.6, and
  unsure or unavailable routes up; (c) Paco's sender rules and the code floors outrank the rung; (d) every `inbox` item
  carries a "should have pinged" tap. Reason, restated and tested on today's system (lesson "ADR is a reason, not a
  rule"): rule 2.1 exists because Jev is steerable by injected text; under 2.6 the worst a hostile mail can do is
  change **its own** lane — delay itself to `/inbox` or ping itself — which degrades quality, never safety, and every
  outcome is still visible to Paco.
- **2.5:** `entryProblems` gains `perItemRouting(e)`: `input === "tool"`, a function-valued `e.perItemRouting`, exactly two
  verdicts, each an `effect` whose `announced` is `card` (the up lane) or `inbox` (the down lane, reversible), and
  `defaultVerdict === fail ===` the up lane.
  Any other tool-input entry with a non-tightening Jev effect still fails. A registry test pins both sides.
- **Rule 4:** row for `mail.triage` (unlocked, rule + system_one, stage `inbound`, reasons). **Stage list** gains `inbound`.
- Code grep for what 2.6 forbids (to be run in the plan and the final review): no `mail` text reaches `decisions`,
  `ledger_events`, logs or `jev_verdicts.reasoning`; no planner tool or `improve.route` signal is fed from `mail_items`;
  the poller has no `format=full|raw`.

### 8.2 ADR 0033 (Jev System One)
Lane 4 is redefined as `mail.triage` (inbound mail; Houge's own notifications out of scope). The mail egress class for
Jev — redacted sender, subject, snippet, labels — is approved by Paco on 2026-11-09 (D3). Outage handling unchanged.

### 8.3 ADR 0025 (Google API surface)
Two identities: Houge's (`wukong.houge@gmail.com`) and Paco's, both `gmail.readonly`; the account picks the token, never
the allowlist. Houge never sends from either in this slice.

### 8.4 ADR 0015 (secrets)
The broker-held set gains `HOUGE_PACO_GMAIL_REFRESH_TOKEN` (the ADR's count is updated to match `SECRET_ENV_NAMES`).

### 8.5 ADR 0031 (notification topics)
`mail_card` (chat) and `mail_log` (log) join the closed topic set.

`tasks/todo.md` records D1–D5 as "decided, not shipped" until merge; each ADR above carries "to be changed, spec
2026-11-09-sp2-mail-triage" until the amendment merges with the code. Checkable rules get `tests/adr/` cases named after
the rule id (2.6, 2.5 predicate, 7.2 redaction on the envelope).

## 9. Testing (hermetic: real SQLite; Gmail, Jev, Telegram, clock stubbed; synthetic mail only — the repo is public)
- Envelope: caps reuse the gmail-read constants; a planted `482913` and a verification link are masked before the row
  write and before the Jev call (both asserted absent); the request URLs never carry `format=full|raw`.
- Ladder: floor order; bar boundaries 0.59/0.60 and 0.84/0.85; Jev skip → `ping` + `jev_unavailable`; `entryProblems`
  passes `mail.triage` with `perItemRouting` and fails a copy without it.
- Fold and thread: 7th ping in 60 min edits the fold card; second mail in a pinged thread inside 6 h edits the count.
- Poller: restart mid-page (no double ping, no loss); cursor 404 → backfill without pings, `always` rule still pings;
  first run → 24 h to `/inbox`; `invalid_grant` → pause + exactly one incident; overlap → skip.
- Rules: tap → rule + `/changes` line; `/mail_undo` → rule gone, next mail back on Jev.
- Retention: day-30 sweep nulls text, keeps metadata; `/inbox` renders the stripped form; `purge --yes` clears all.
- No leak: logs, `/status`, `decisions`, `jev_verdicts.reasoning` never contain sender address or subject.
- Account: `gmail_read` without `account` behaves byte-identically to today (existing tests unchanged).
- ADR conformance: `tests/adr/0034-2.6-*.test.ts` etc.
- **Unchanged behaviour:** the Stage 4 differential (18 corpora) shows 0 differences against the merge base; a rollback
  check opens a DB this slice wrote with the pre-slice build.

## 10. Live gate (`scripts/live-gate-mail-triage.mjs`)
Setup by Paco: `houge mail auth`; then send himself three mails from another address — "URGENT: confirm by 5pm today",
a newsletter-style mail, and one containing "your code is 482913". The gate runs the real poller against real Gmail
(read-only), real Jev, a VACUUM copy of the DB, and Paco's Telegram (inside the test surface). It matches only the three
planted mails (by a gate-chosen token in their subjects); any other mail in the window is counted, never shown.

PASS needs every line:
1. All three planted mails found, each with exactly one `mail_items` row and one `mail.triage` decision row.
2. Jev answered (not the fallback) for at least 2 of the 3 — a silent Jev outage fails the gate.
3. The urgent mail pinged; the newsletter did not (else INCONCLUSIVE, Jev's call, as on the jev-tree gate).
4. `482913` appears nowhere: the DB copy, the Jev request capture, the card text, the gate output.
5. A `never` rule on the test sender routes a re-sent mail to `/inbox`; `/mail_undo` restores Jev's call.
6. An injected 401 (fake transport) opens exactly one `mail_auth_lost` incident.
7. A second poll over the same window sends no second ping.

## 11. Rollout
After merge, rebuild and kickstart, `HOUGE_MAIL_ENABLED=1` and `/mail on`: armed at ship, per Paco's no-shadow rule.
`/mail off` stops it; `HOUGE_MAIL_ENABLED` is in `DISARM_FLAGS`.

## 12. Open questions for review
- Q1: is the stage value `inbound` better than reusing an existing stage? (No planner turn exists at triage.)
- Q2: Telegram callback data length for `Never ping from <address>` — the address must ride by rule id or item id, not
  inline (64-byte limit).
- Q3: should `paco_active_30m` be in the envelope at all (it is Houge-side state, not mail), or only used by code for the
  quiet-hours silence?
