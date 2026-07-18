# P2 — Bounty intake + legitimacy classifier + durable project state (design)

**Status:** DESIGN v2 (autonomous `/goal p2`, 2026-07-18) — amended for all findings from the
eng review + senior spec review (1 BLOCKER + 3 BLOCKERs resolved, all MAJORs incorporated).
Scope pre-approved in `2026-07-17-money-work-roadmap.md` §P2; charter bounds from ADR 0022.

**Goal:** Houge scans real bounty venues via APIs (no browser), filters scams, ranks by
legitimacy/competition/effort, and delivers a ranked plan to Paco over Telegram. Durable
`projects` state tracks the bounties Paco decides to pursue across sessions.

## Charter position

Read-only, identity-free, unauthenticated GETs against public APIs — charter-clean under
ADR 0022 (earning IN; no account, no submission, no credentials, no payments). Deterministic
code owns every scam/legitimacy signal, all venue I/O, and all write validation; the model only
narrates. Flag-gated default OFF (`HOUGE_BOUNTY_ENABLED`), **added to `DISARM_FLAGS`**
(`src/config/disarm-posture.ts`) + its test.
NOT in P2: external submission, credential store, earnings ledger (P3); auto-pursuit (P4);
TaskBounty adapter (its API needs a `tb_live_*` key → P3 credential store).

## Venue reality (live-verified 2026-07-18)

- **GitHub Search API** is the listing spine: `GET api.github.com/search/issues` with
  `label:"💎 Bounty" state:open` (Algora bot label, 571 open) and `commenter:algora-pbc`
  (bot-verified subset). Unauthenticated limits: **10 search req/min, 60 core req/hr, per-IP**
  (shared with anything else on the mini hitting api.github.com).
- **Algora**: public listing API dead (returns `[]` by design);
  `GET algora.io/api/shields/<org>/bounties?status=completed` works unauthenticated — the
  escrow-backed paid-out-history oracle. **Keyed by Algora handle, which may differ from the
  GitHub org login** — a 404 means "not found under this key", NOT "not on Algora".
- **Scam landscape**: bounty labels are attacker-creatable (verified fakes: forks carrying
  copied `💎 Bounty` labels; agent-bait repos). Legit signals are API-checkable.

## ADR 0014 carve-out (explicit, argued)

`bounty_scan` is `side_effect_level: "external_read"` for policy/arming purposes but is **NOT
added to `UNTRUSTED_READ_TOOLS`** (`src/core/quarantine.ts:35`). Justification: the quarantine
protects the planner from *raw untrusted bytes*; `bounty_scan`'s output is not raw bytes — it
is a deterministically constructed digest of capped, sanitized, schema-typed fields. Routing it
through the Q-LLM would re-summarize a deterministic table into equally-attacker-derived free
text (laundering, not protection) and destroy the structured deliverable.

**Invariant (acceptance criterion + unit-tested):** no string from a venue payload reaches any
model except through the sanitizer (§ hygiene table). Issue **bodies arrive in the search
payload** and are **discarded at the parse boundary** — never stored, logged, or passed past
the normalizer (fixture test: hostile body must appear nowhere in the tool result).

**Residual risk, and its structural backstop:** a hostile title can still color the planner's
*narrative*. It cannot move a candidate across the scam line (verdict/score are rendered from
the deterministic table, appended outside the model), and it cannot cause a durable write to an
attacker URL: `project_track` **deterministically refuses any `source_url` that is not already
recorded in `bounty_sightings` or present verbatim in the current user message** (the anchor).
Deliberate deep reads of a repo happen via `http_fetch`, which rides the existing quarantine.

## Architecture

### 1. `src/capabilities/bounty-intake.ts` — venue I/O + normalize (deterministic)

- `resolveBountyEnabled(env)` (default OFF, `1/true/yes/on`); `HOUGE_BOUNTY_MAX_CANDIDATES`
  (default **8**). Both PINNED_ENV'd.
- **`fetchVenueJson(url, deps)` wraps the exported `fetchUrl`** (`http-fetch.ts:406`) — it
  inherits resolve-all + classify + IP-pinned request, redirect-never-follow, identity
  encoding, byte cap, wall-clock timeout (~100 lines of hardened I/O NOT reimplemented).
  Before calling: exact-host allowlist check on the WHATWG-normalized hostname (trailing dot
  stripped) — `api.github.com`, `algora.io` — https only, default port only. Config:
  `maxBytes: 512_000`, `timeoutMs: 8_000`. A 3xx from an allowlisted host = venue failure →
  degrade (redirect classes moot by construction). `JSON.parse` + per-adapter tolerant shape
  validation (`parseReaderExtraction` philosophy: wrong type ⇒ drop field, never throw).
  Owner/repo names pass GitHub grammar (`^[A-Za-z0-9][A-Za-z0-9-]*$` owner,
  `[A-Za-z0-9._-]+` repo) **before** interpolation into any URL path.
- **Call budget per scan (hard-coded, checked):** 2 search calls (listing + bot-verified
  window, `per_page: 30`); enrichment for top N=8 only: `GET /repos/:o/:r` (1 core) +
  `GET /repos/:o/:r/pulls?state=closed&per_page=30` (1 core, "any `merged_at` in window"
  boolean) + shields lookup (algora.io, not GitHub budget). Totals: **2 search ≪ 10/min;
  ≤ 16 core + ε ≪ 60/hr** ⇒ ceiling ~3 full scans/hr, stated to Paco if exceeded.
  Owner-age signal uses repo `created_at` (in `/repos`) — NOT `/users/:owner` (extra calls;
  embedded owner object lacks `created_at`).
- **Rate-limit behavior:** read `x-ratelimit-remaining`; stop enrichment early when low; honor
  `Retry-After`; never retry 403/429 within the same scan; single retry on network error only.
  In-memory TTL cache (1 h) for `/repos` + shields responses (per-process; no table in v1).
- **Timeouts:** per-request 8 s; scan wall-clock **75 s** — on expiry remaining candidates
  degrade to `unverified` (same mechanism as 403 degrade). `loopToolTimeoutMs` gets an explicit
  `bounty_scan` case (90_000), like `web_search`.
- **Scan throttle:** per-process mutex + minimum re-scan interval (10 min): if the last
  `bounty_scan_completed` is fresher, return the previous table and say so (guards close
  scheduled+manual scans on the shared per-IP budget).

### 2. Legitimacy scorer (deterministic, same module)

- **Hard rejects** (verdict `scam_suspect`, excluded from the plan, one-line tally):
  - *Unconditional:* repo is a fork carrying bounty labels.
  - *Conditional — apply only when strong verification is absent* (`!bot_verified &&
    shields_completed_total == 0`): repo `created_at` < 90 days; no merged PR observed in the
    closed-PR window; `$`-amount only via label with no `algora-pbc` comment. (Prevents
    false-rejecting legit young orgs running escrow-backed bounties.)
  - `bot_verified` is only asserted when determinable **within the fetched window**
    (window-covered tracking); shields 404 ⇒ `unknown`, **score-neutral, never negative**
    (the Algora-handle keying problem).
- **Score** (0–100, weight table as exported constants — lessons rule): org-type +10,
  repo age ≥ 1 y +15, pushed ≤ 30 d +15, merged-PR-in-window +15, star/fork sanity +10
  (formula `stars >= max(1, forks/4)`; zero-fork repos pass), `💰 Rewarded` siblings +10,
  shields completed-total > 0 +15, bot-verified +10. **Ordering acceptance criterion:**
  bot-verified + shields-positive always outranks `unverified`.
- Competition = issue age + comment count buckets; effort = label/title-class buckets. Coarse
  by design; the LLM may narrate nuance but the verdict/score columns are appended to the tool
  result deterministically, outside the model.

### 3. Hygiene table (every venue string, at parse)

| Field | Rule |
|---|---|
| title | strip C0 + bidi (U+202A–E, U+2066–69) + zero-width; flatten newlines; ≤ 120 chars at code-point boundary |
| labels | ≤ 10 rendered, each ≤ 50 chars, same strip |
| amount | numeric parse, bounds $1–$100k, else dropped; always rendered as *claimed*, never verified |
| org/repo/URLs | grammar-validated (above); issue URLs must match `https://github.com/<owner>/<repo>/issues/<n>` |
| body | **discarded at parse boundary** |
| anything else | tolerant shape-check; wrong type ⇒ drop field, never throw |

Telegram rendering: venue-derived strings are sent **plain-text / metachar-escaped** at the
outbox boundary (no attacker markdown link spoofing).

### 4. `projects` store + tool surface

- Migration `2026-07-18-projects` (in-class, `schema_migrations` template):
  - `projects(project_id TEXT PK /* proj_<uuid> */, kind TEXT NOT NULL /* bounty */,
    source_url TEXT NOT NULL UNIQUE, title TEXT, amount_usd INTEGER /* whole USD, claimed */,
    state TEXT NOT NULL, state_reason TEXT, notes_json TEXT /* valid JSON, ≤ 4 KB */,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`.
  - **Transition table (code-validated, `state-machines.ts` pattern):**
    `tracked→working→submitted→paid`; `*→dropped`; `dropped→tracked` (with reason). Illegal
    move ⇒ tool error, **no ledger event**. Duplicate `project_track` on an existing
    `source_url` ⇒ idempotent return of the existing row. Rows never deleted.
  - `bounty_sightings(issue_url TEXT PK, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT
    NULL, last_score INTEGER, last_verdict TEXT, times_seen INTEGER NOT NULL)`.
    **Non-downgrading upsert:** `unverified` never overwrites a substantive verdict/score;
    `times_seen`/`last_seen_at` always update. NEW markers are **window-relative** ("newly
    entered the fetched window") and worded so in the Telegram copy.
- Ledger events (union + `requiredPayloadFields`, actor **`core`** — the turn-lane provenance
  actor, per `web_search_performed` precedent): `bounty_scan_completed` `{venue_count,
  candidates, scam_suspects, new_sightings}`, `project_created` `{project_id, source_url}`,
  `project_state_changed` `{project_id, from, to}`.
- **Loop tools** (descriptors carry the `armed: resolveBountyEnabled` predicate; contract
  `allowed_actions` is static text — the `manifestFor` intersection does the unlisting):
  - `bounty_scan` — `external_read`, strict input `{}` (unknown fields rejected). Inline on
    the turn lane (justified by the 75 s cap — no evolution-lane detach). **`resultCharCapFor`
    carve-out (6_000)** so the table survives the 2 k loop digest cap.
  - `project_track` — **`side_effect_level: "none"`** (the `schedule_task`/`lesson_write`
    precedent: local sqlite row; `local_write` would auto-deny on the turn lane, which has no
    approval sink — `core-worker.ts:2031`). The human decision is anchored in flow (invoked on
    Paco's explicit pursue instruction) **and structurally by the sightings/user-message URL
    anchor** (§ carve-out). Input `{source_url, title?, amount_usd?}`.
  - `project_update` — `none`, `{project_id, state, reason?}`, transition-table-validated.
    Bookkeeping of states Paco reached externally (recording, not acting — ADR 0022-clean);
    every change ledgered; `paid` is a status flag only — **money accounting stays out** (the
    P3 earnings ledger owns it; no shadow ledger).
  - `project_list` — `none`, read-only.
- Scheduled scans: zero new scheduler code (`/schedule` goal replay; the 10-min throttle
  guards collisions).

## Data flow

Paco: 「找找有什么值得做的 bounty」→ planner picks `bounty_scan` → budgeted allowlisted GETs →
deterministic normalize + hygiene + hard-reject + score → tool result: ranked table (≤ 8) +
scam tally + window-relative NEW markers, verdict/score columns appended deterministically →
planner narrates the plan → outbox (plain-text venue strings). Paco: 「跟进第 2 个」→
`project_track` (anchor-validated) → durable row + `project_created` → future sessions:
`project_list` / scan delta.

## Error handling

- Per-venue degrade returns **`ok: true`** with a per-venue status line (an `ok: false` scan
  would burn one of the loop's `FAILURE_CAP = 2`); never throws to the loop.
- Zero candidates → honest empty plan. Budget/deadline exhaustion → `unverified` remainder,
  stated. Flag off / disarm → tool unlisted (armed predicate), extwork precedent.

## Testing

- Unit: adapters on fixture JSON (fork-fake, agent-bait, hostile-body, young-but-bot-verified
  org); scorer conditional/unconditional rejects + weight ordering criterion; full hygiene
  table (bidi/zero-width/code-point truncation); allowlist (evil.com,
  api.github.com.evil.com, trailing-dot host, 3xx, private-IP via fetchUrl pin); URL grammar;
  anchor rejection (`project_track` on an unseen URL fails).
- Store: migration idempotence; transition table incl. illegal moves + idempotent duplicate
  track; non-downgrading sightings upsert; ledger required-fields.
- Loop integration: armed ⇒ listed / disarmed ⇒ unlisted (`core-worker-turn-loop` precedent);
  degraded scan is `ok: true`; digest survives `resultCharCapFor` carve-out.
- PINNED_ENV: `HOUGE_BOUNTY_ENABLED`, `HOUGE_BOUNTY_MAX_CANDIDATES`; DISARM_FLAGS test.
- **Live gate** (real daemon, real APIs, Telegram): scan → ranked plan with ≥ 1 bot-verified
  candidate; scam-tally line rendered (`scam_suspects ≥ 0`); **rejection logic proven by
  fixtures, live rejection observed-if-present, not required** (fakes in the top-N window on
  gate day are not guaranteed); `project_track` → row survives daemon restart; ledger shows
  scan + project events.

## Alternatives considered

- Scan-only/no store — rejected: roadmap commits durable project state; re-scans would forget.
- LLM-judged scam classifier — rejected as the floor (AGENTS.md rule 5); LLM narrates on top
  of, never across, the deterministic line; deep reads ride the existing quarantine.
- Quarantining `bounty_scan` output via Q-LLM — rejected: see carve-out (laundering, not
  protection); the sightings anchor closes the injection→write chain structurally.
- `local_write` + approval tap on `project_track` — rejected: no approval sink exists on the
  turn lane (auto-deny); building park/resume is unjustified new machinery for a reversible
  local row. Precedent: `schedule_task` (creates future autonomous behavior) is `none`.
- TaskBounty adapter now — deferred to P3 (needs credential store); `VenueAdapter` stays a
  type signature, not a plugin registry.
- Auto-start extwork on top candidate — rejected: P2 output is a ranked plan for Paco
  (roadmap verbatim); auto-pursuit is P4.
