# 05 — Inbound triage lane: Jev as System One for everything that is not Paco

Research + design note, 2026-10-04. Read-only probe of `main@6f52dea` and the live `houge.sqlite`. Direction fixed: Jev decides typed judgment calls first, code owns gates and thresholds, low confidence falls through to today's path.

## 1. Inventory — what reaches Paco today without him asking (live DB)

| Input class | Volume (60 d, DB) | Path today | Code-owned urgency rule? |
|---|---|---|---|
| Scheduled runs (`AI日报` daily 08:00 Sydney, `SIEM/SOAR/UEBA` weekly) | 67 runs, ~1.1/day; 2 enabled rows | A full **planner turn** (Opus 5.5 compose + ~6–8 reader calls) → one `final_report` per run (`run-store.ts:5417-5424`), 1.6–3.9 k chars, 66/67 delivered | None: straight to Telegram |
| Incidents | **6 ever** (heartbeat_gap 2, undelivered_notification 2, wall_collapsed 1, omp_unavailable 1); 11 alerts | `invariant-sweep.ts:331-345`, `incident-alert.ts:30-42` → `progress` notification | Yes, the best in the system: alert per transition, storm cap 3 + summary (`:63`), flap 30 min (`:69`), resolve notify ≥ 1 h (`:57`), own output excluded (`run-store.ts:4650`) |
| Idea panel | 9 weekly pushes | `idea-panel.ts:612-620` | Cadence only |
| Idea radar | 57 ticks, 305 cards (205 archived) | **Store only**, `/radar` view (ADR 0026 §4) | Already "store silently" |
| Houge's inbox (`gmail_read`) | 9 API calls, all 2026-07-22/23; none since | Inside a planner turn behind the reader wall (ADR 0025 §4); no poller | n/a |
| Rating prompts / memory cards | 34 / 6 | Code-owned, straight out | Rating window only |

Baseline: 1–4 outbox rows/day Aug–Sep (median 2; the 78/32 spikes on 10-01/02 were the live gate). Non-Paco-triggered items ≈ 130 in 60 d ≈ **2.2/day**. Paco's own turns: 124 in 29 d (4.3/day), peaking 08–09 Sydney, right after the 日报.

The firehose is a trickle today, and the only input with a real urgency model (incidents) has the least volume; schedule reports cost the most per item and have no routing at all. SP2 changes the shape: tens of untrusted mail/calendar items a day.

Outbox mechanics to keep: retries 30 s / 2 m / 8 m / 30 m, 5 attempts, 6 h staleness, terminal rows reported 24 h (`run-store.ts:8235-8241`). **No global per-hour send cap** exists outside the sweep. Jev client supports `choice` only (`jev-client.ts:21-25`); 429 is a silent retry (`:116-123`) though the memory rule says it must reach Paco.

## 2. The triage call

One code-owned envelope, built per item by the producer, never by a model:

```
TriageItem { class: schedule_report|incident|panel|radar_card|houge_mail|paco_mail|calendar_event|reminder,
  origin: code|model_output|untrusted,   // untrusted = passed the reader wall, snippet ≤ 300 chars, hostile chars stripped
  title ≤ 200, snippet ≤ 300, sender_known: bool, sender_domain?, deadline_min?: number,
  repeat_24h: number, local_hour: number, paco_active_30m: bool, language: zh|en|mixed }
```

Jev questions (literal wording, one request per item, ~0.3 s):

- `needs_paco` (choice): `now` — "Paco would want to be interrupted for this within the hour: a person is waiting on him, a deadline is under 24 h, money or access is at stake, or Houge itself is broken." `digest` — "Worth reading once today, nothing is lost by waiting until the next digest." `never` — "Routine, automated, or a repeat of something already shown (`repeat_24h` > 0 counts as a repeat)."
- `kind` (choice): `action_required` | `fyi` | `risk` (security, account, money) | `noise`.
- `needs_llm` (choice): `yes` — "Paco needs a written summary or judgment to act; the title and snippet do not suffice." `no`.

Code decides from the answers:

| Lane | Trigger | What happens |
|---|---|---|
| **now** | floor, or `needs_paco=now` at conf ≥ 0.6 | Outbox as today, rich card, buttons `triage:wrong:<id>` (one tap = "wrong urgency") and `triage:open:<id>` |
| **digest** | `digest` at conf ≥ 0.85, or any low-confidence non-floor item | Row in `triage_items`, rendered by the digest tick (§4) |
| **store** | `never` at conf ≥ 0.85 and `kind=noise` | Row only; visible via `/inbox` |
| **llm** | `needs_llm=yes` | Untrusted → reader seat (`HOUGE_OMP_READER`); schedule reports already *are* a planner turn, Jev only places the finished report |
| **discard** | never | Nothing is deleted: calibration needs the row |

Asymmetric thresholds on purpose: downgrading needs more confidence than interrupting (§7).

Code-owned floors Jev cannot override:
1. Kill/park/disarm: no triage runs; today's paths unchanged (ADR 0018).
2. `approval_prompt` / `approval_resolved` never enter triage — the `/approve` floor (ADR 0028 D6-B) is security-bearing.
3. Incidents in `SUPERVISOR_ALERT_KINDS` (`incident-alert.ts:58-61`) plus `stuck_run`, `heartbeat_gap`, `disk_free_low`, `llm_leg_failing` with `error_kind=auth` → always **now**. Jev may demote only `lesson_dropped`, `core_overflow`, `wall_collapsed`, resolve lines and the sweep summary.
4. `origin=untrusted`: Jev may pick a lane, never an action; `needs_llm` routes to the reader seat only. Label steering by injection is accepted because the label is advisory (same argument as the 2026-09-25 spec).
5. `deadline_min` < minutes to next digest → **now** regardless of Jev.
6. Rate floor: more than 6 `now` sends in 60 min → further items fold into the digest with one summary line (mirror of `INCIDENT_ALERTS_PER_SWEEP_MAX`).
7. Triage's own outputs (digest cards, `triage:*` taps) are never triage inputs (memory: monitors must not observe their own output).

## 3. SP2 preview — Paco's mail and calendar

State for `paco_mail`: `from_domain`, `sender_known` (code-owned count of prior threads from that sender), `subject` ≤ 200, `snippet` ≤ 300 (**reader-digested when the body is used**, else Gmail's snippet after `stripHostileChars`), `has_attachment`, `thread_len`, `is_reply_to_paco`, `repeat_24h`. Redacted before egress: OTP codes (`gmail-read.ts` regexes already find them), URLs, phone/card-like numbers, the body. Calendar: `title`, `starts_in_min`, `attendees`, `organizer_known`, `conflict`. Reminders are Paco-authored: `origin=code`.

ADR 0025 keeps this read-only: scope bounds everything (§2), one registry row per scope (§3), both tools walled (§4). SP2 adds `account: paco` (ADR 0028 D9) and a second grant; **send** is `external_write` → floor B `/approve`. Jev never decides a send, reply or accept — only whether and when Paco sees the item. A poller for Paco's inbox triggers ADR 0025 §8's revisit and needs its own per-tick cap.

Shadow week: Jev labels, **nothing acts**; one morning card lists every item with its lane and a `wrong` button per line. Week 2+: `digest` goes live for mail; `now` for mail waits for the §5 bar.

## 4. Digest mechanics

There is **no generic digest today**. AI日报 is a planner turn with a schedule row (`schedule-tick.ts:81-93`); the panel pushes a weekly card; the sweep's summary line (`invariant-sweep.ts:352-359`) is the only "fold N things into one message" path. Minimal build:

- `triage_items` table (item_id, class, origin, title, snippet, state_json, jev_json, lane, floor_reason, label, created_at, shown_at).
- `runDigestTick`: wall-clock pin via `computeNextRunAt` (the radar's `radarPinnedDue` pattern, `idea-radar.ts:76-79`), default 08:00 Sydney, latch before render, idempotency `digest:<date>`, one rich-renderer card grouped by `kind`, cap 20 lines + "N more in /inbox". Empty digest = silence.
- `/inbox [class]`: today's rows. Reuse the outbox, buttons (`notification-types.ts:9-19`) and callback parsing (`telegram-command-parser.ts:232-260`).

## 5. Labels and calibration

Ground truth that exists: approve/deny taps (12/10), `session_ratings` (11 rows, mean 2.7, last 2026-09-25 — too sparse), incident resolution times (6 rows — unusable), replies within 2 h of a schedule report (76 of 79, but contaminated: Paco chats at 08–09 Sydney anyway). Nothing today says "this interruption was worth it".

Build the label first: the `triage:wrong:<id>` tap (no typing) and an implicit positive (reply or `open` within 30 min of a `now` card). Each tap nudges that class's threshold by a fixed step, Gmail-style, and is logged for replay.

Offline replay before any live shadow: rebuild envelopes from the DB (67 schedule reports, 6 incidents, 9 panel pushes, 305 radar cards), Paco labels ~80 mixed items in one sitting (`houge triage label`). Report per class: agreement at conf ≥ 0.7, coverage of that slice, and **zero** `now`-labelled items Jev put in `never`.

Shadow bar, sized against the measured rate (`tasks/lessons.md:113-116`): ~2.2 items/day → 30 days ≈ 65 items, too few per class. Bar, **per class**: ≥ 100 labelled items *and* ≥ 14 days, agreement ≥ 85 % on `now` vs not-`now` in the conf ≥ 0.7 slice, slice ≥ 60 %, no missed `now`. Schedule reports reach 100 in ~3 months; mail in a week; incidents never — they stay floor-driven. Per-language split as in the Jev spec (日报 goals are Chinese).

## 6. External research applied

- **Gmail Priority Inbox** (Aberdeen, Pacovsky, Slater 2010, [PDF](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/36955.pdf)): importance = P(user acts within a window); ~80 ± 5 % accuracy; threshold tuned so the **false-negative rate is 3–4× the false-positive rate** (show more rather than miss); a real-time threshold increment when the user marks consistently; corrections weighted higher. Applied: asymmetric thresholds (§2), one-tap nudge and "acted within 30 min" as implicit truth (§5).
- **Apple Intelligence notification summaries** ([Axios](https://www.axios.com/2025/01/17/apple-ai-news-alerts-fake-headlines)): suspended Jan 2025 after false headlines under the BBC logo. The failure is *generated* text, not routing. Applied: Jev generates nothing; digest lines are code-rendered titles; an LLM summary is marked as such, never the headline.
- **PagerDuty alert grouping** ([docs](https://support.pagerduty.com/main/docs/intelligent-alert-grouping)): dedup by key, rolling windows (5 min for critical, up to 1 h), incidents < 24 h old, learning only from manual merges. Houge's incidents already have fingerprint + flap + storm cap. Applied to mail: `thread_id` as dedup key, 30-min sender-burst grouping, `wrong` taps as the merge-feedback equivalent.
- **Batching notifications** (Fitz, Kushlev et al. 2019, [CHB](https://www.sciencedirect.com/science/article/abs/pii/S0747563219302596)): three batches a day beat continuous delivery on attention and stress. Applied: digest is the default lane; `now` must earn itself.
- **Superhuman / Shortwave** ([comparison](https://get-alfred.ai/blog/superhuman-vs-shortwave)): both route into streams rather than score urgency; judgment stays with the user. Applied: `kind` is the stream; the shadow digest is grouped by it so Paco sees the taxonomy before anything is suppressed.

## 7. Failure modes

- **Urgent item in the digest** (the costly miss): floors 3 and 5, downgrade needs conf ≥ 0.85, digest ≤ 24 h late by construction, `wrong` on a digest line raises the class threshold.
- **Alert storm**: the sweep has caps, the outbox does not → floor 6; mail bursts dedup by thread and sender window.
- **Jev down / 429 / auth**: class default = today's behaviour exactly. Auth already opens `llm_leg_failing` for `jev` (`configuration.md:872`); add an alerted `jev_rate_limited` incident at ≥ 3 × 429 in 1 h.
- **Self-amplification**: floor 7 plus the existing `incident_*` exclusion (`run-store.ts:4650`) bounds the sweep→digest→sweep loop.
- **Injection via snippet**: steers a label, never an action; `needs_llm` reaches only the reader seat.
- **Literal reader**: sarcasm, CJK, "URGENT" newsletter subjects; `repeat_24h` and `sender_known` are the code-side antidotes; the replay measures the rest.

## 8. Build order before SP2

1. `score`/`noul` in `jev-client.ts`; 429 → incident. 2. `triage_items` + envelope builders for the four existing classes + `/inbox`. 3. `wrong`/`open` buttons and the label store. 4. Offline replay + Paco's 80-item labelling. 5. Digest tick (shadow: lists everything). Only then SP2's poller plugs into an existing lane.

## 9. Open questions for Paco

1. Digest time and count: one morning card next to the 日报, or morning + evening?
2. May the 日报 itself become a digest section once its class passes the bar, or does it stay its own message?
3. Confirm the incident kinds Jev may demote (§2 floor 3).
4. Egress: subject + snippet of **your** mail to TypeSafe (codes/URLs/body redacted)? The Sep approval covered Telegram text only.
5. One 80-item labelling sitting before the shadow — yes?
6. Code-owned quiet hours (23:00–07:00 Sydney → digest unless floor)? None exist today.
