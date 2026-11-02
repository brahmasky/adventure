# Loud degradation — newest model per tier, repeating reminders, trust carry with an exit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace code-owned model *version* strings with code-owned *tiers* whose newest catalog member is adopted only after a one-shot probe, make an empty tier ask Paco on a tap card, remind Paco daily of open actionable incidents, turn `hostile_schedule_turn` into an event, and give a carried trust level an exit (`/fresh`, cause-tracked carry, a `/status` line).

**Architecture:** Part A adds `src/omp/model-tiers.ts` (pure tier model), `src/omp/tier-step.ts` (pure plan/apply per tick), `src/omp/model-probe.ts` (the probe over the unchanged one-shot seat) and a `model_tiers` table; role lists become `{tier, effort}` legs that `RoleResolver` resolves against `model_tiers` at every call. The daily tick becomes: catalog → plan → probes (outside any transaction) → one transaction. Part B adds `REMIND_KINDS` and a once-a-day reminder step that runs before the model ticks, independent of `HOUGE_MODEL_ROLES`. Part C makes `TurnTrust` keep its cause set and store a *carry level*, adds a persisted `/fresh` marker honoured at every planner start with its own commit condition, and a `/status` line.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-11-02-loud-degradation-design.md` (Rev 1.2, APPROVED by Paco 2026-11-02: D1-A, D2-A, D3-A, D4-A). Read it whole, including the Rev 1.1 and Rev 1.2 change tables, before any task. Reviews behind it: `.superpowers/sdd/loud-degradation/senior-review.md`, `codex-design.md`, `codex-rereview.md`. Format exemplar: `docs/superpowers/plans/2026-11-01-remainder-r4-crash-retry.md`.

**Plan status:** Rev 1.1 — the plan review (claude-fable-5-1, `.superpowers/sdd/loud-degradation/plan-review.md`: 1 blocker, 5 warnings, 8 suggestions; it ran Task 1 green) applied; see "Plan Rev 1.1 changes" at the end. Rev 1.0 was written against `main@df4176f` (every line number re-read there; the spec's numbers were taken at `e757ad1`, docs-only since), with `tests/fixtures/omp-catalog-2026-11-02.json` created alongside (uncommitted).

## Rulings (plan author; where the spec is silent or its implementation text does not match the code)

Format: `P<n>: <what> — <why> — <cost if wrong>`.

- **P1 — merge base and old build.** The branch `loud-degradation` is cut from `main` after this plan's commit. Every commit after `df4176f` is docs-only (verify `git diff --stat df4176f <merge base> -- src scripts tests` is empty; Task 14 stops if not). The old build is the real merge base, built and stamped in `.worktrees/base-<12-char sha>` (`npm ci && npm run build`, then from the main checkout `node scripts/stamp-dist.mjs .worktrees/base-<sha>`). After the merge it is passed explicitly (`--old-base <full sha>`; lessons 2026-10-30: on `main` the merge base is HEAD). — The rollback check needs a genuine previous build. — A wrong base makes the rollback check vacuous; `verifyStampedDist` refuses it.
- **P2 — `/kill` pins.** Any test, corpus or gate that could intake `kill` pins `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` to a temp dir and asserts no `houge.kill` in the cwd afterwards (lessons R1). — A cwd-relative tombstone stops the live daemon. — Paco's daemon stops.
- **P3 — `HOUGE_TELEGRAM_CHAT_ID`.** Cleared (`""`) in unit tests that open alerted incidents; the stub `-1003` in gates. — An alerted incident pages the env chat. — A test or gate pages Paco.
- **P4 — exact rows, never filters.** Every new assertion compares the exact row set (`model_tiers` rows, `model_probe` payloads, outbox rows by key, `turn_trust` rows) — never "contains" or "at least one" (lessons 4C, R2). — PASS-on-nothing is the repeat failure of this repo. — A silent degradation passes.
- **P5 — one planted mutation per new assertion** in every task's "verify" step, shown failing, then reverted. — Lessons R2. — An assertion that cannot fail.
- **P6 — the probe's failure class (spec §4.2 vs the code).** The spec says "`classifyOmpError` over the adapter's error". The adapter's error is `all probe legs failed — <provider/id>: <kind>` (`src/llm/providers/omp.ts:164`, `:167`); `classifyOmpError` matches no word in it for `model_missing` (none of its regexes, `omp-frames.ts:77–88`, reads the literal `model_missing`), so every retirement would be "inconclusive" and the 7-day rule dead. `probeKindOf` parses the trailing `: <kind>` against the closed `LlmErrorKind` set and falls back to `classifyOmpError` on anything else; a test drives the real `spawnOneShot` over `tests/fixtures/fake-omp.mjs` (`rpcBadModelAtStart`) so a change to that format in `omp.ts` fails loudly. — `omp.ts` stays unchanged (spec §11). — If `omp.ts` changes its format, probes go inconclusive (loud: retried daily, never adopted), never wrongly adopted.
- **P7 — the probe seam's exact call.** `oneShotAdapter(store, cfg, { correlation_id: "probe:<uuid>", role: "probe" }, undefined, { chain: [selector], deadlineMs: 60_000 })` (`registry.ts:199`): the chain goes in `opts`, the 60 s bound is `deadlineMs` (there is no `timeoutMs` option), the stop signal rides `req.signal` and returns `aborted: true` (→ the tick commits nothing). `"probe"` joins `LlmCallRole` (`run-store.ts:64`, protected). Probe legs write `llm_attempt` rows; `findFailingLlmLegs` (`run-store.ts:6402`) groups by provider and needs `ok = 0` in 24 h, so a lone failed probe never pages unless the provider is wholly failing or its last error is `auth` — both true signals. Accepted. — Same seam as every tick seat. — A probe could add one attempt row to a provider already failing.
- **P8 — price in the catalog.** `catalogEntry` (`src/omp/model-catalog.ts:16`) keeps only provider/id/thinking; spec §4.4's ordering needs `cost.output` and `cost.timeBased.effectiveRates`. `CatalogModel` gains an optional `price`, set only when `cost` parses (so `tests/fixtures/omp-models.json`, which has no `cost`, parses byte-identically). `model-catalog.ts` is protected (`src/omp`) and **absent from spec §11**; it is edited under the approved spec. — The proposal order is a spec requirement. — None beyond a protected edit the spec did not list (Task 15 names it in the ADR row).
- **P9 — "preview" and "matches no tier".** A proposal is a catalog id of the tier's provider that no `TIERS` pattern of **any** tier on that provider matches, whose id does not contain `preview`, and does not end in `-lite`. — Spec §4.4 names the three filters; `tab_flash_lite_preview` carries `preview` mid-id. — A future `…-preview-…` id is excluded (fine) .
- **P10 — task order.** The resolver rewrite (legs over `model_tiers`) is its own task (3), apart from the pure tier model (1) and the table (2): it ripples into five test files and one gate script. `transcript_trust_at` + the `/status` line (10) precedes `/fresh` (11), because `/fresh`'s commit writes `transcript_trust_at`. — Reviewer-meaningful boundaries. — None.
- **P11 — `ROLE_LISTS` is removed.** Its callers are rewritten: `role-resolver.ts:98,107` and `models-commands.ts:82` (seat count → `JUDGE_SEATS`), `telegram-command-parser.ts:222` (comment), `scripts/live-gate-jev-tree.mjs:101,476,495`, and `tests/omp/model-roles.test.ts`, `role-resolver.test.ts`, `model-roles-tick.test.ts`. A derived `ROLE_LISTS` would keep a third list that can disagree with `model_tiers`. — Spec S1 ("chains(), resolveAll() and the panel cannot disagree"). — More test churn in Task 3.
- **P12 — the empty static judge seat.** `STATIC_ROLE_LISTS.judges` becomes a 2-element array (seat 2 has no static selector, spec §4.3). `chains().judges` keeps today's index-stable expression (`or("judges", seat)[0] as ModelString`, `role-resolver.ts:98`), so an empty seat is `undefined` at its index, as today's code already allows; `judgeSeat(cfg, 2)` (`registry.ts:167`) returns `[]` for it and the panel seat answers `{ok:false, unavailable:true}` (`idea-panel-seats.ts:43`). Task 3 pins `judgeSeat(resolveOmpConfig({}, roles.chains()), 2)` → `[]`. Every other reader of `cfg.judges` (`registry.ts:135` `seatChain("judge")`, only reached with an explicit chain by `idea-panel-seats.ts:41`; `tests/llm/seat-routing.test.ts:30–31`, which maps by index and stays green; `scripts/eval-replay.mjs:136` `cfg.judges[0]`) is listed in Task 3 Step 0. Retyping `judges` as `Array<ModelString | undefined>` (plan review suggestion) is **not** done: `seatChain`'s `case "judge": return cfg.judges;` (`registry.ts:135`) would then fail to typecheck, and `registry.ts` stays unchanged (spec §11). — A filtered array would shift seat indices. — A future `for…of cfg.judges` reader sees `undefined`.
- **P13 — one probe per tier per tick, head first.** `planTier` follows a retirement first (adopted gone from the catalog → its previous, which was already probed, with no probe; neither listed → the tier is empty), then picks at most one probe: the catalog head if it is not the adopted head and not rejected in the last 7 days, else the next-newest below the adopted head when the tier has no live previous. A retired previous is dropped. **A partial read (Rev 1.1, review W1):** when the catalog lists no model at all for the tier's provider, `planTier` keeps the tier exactly as it is and plans no probe — the read is partial for that provider (an auth lapse, a transient provider error), not evidence of a retirement. The resolver's `catalogued` filter still keeps an unlisted model from running that day, as today, and the tier's memory survives, so the next full read resolves at once with no probe, no card and no wipe. A retirement is followed only when the provider is listed and the tier's ids are not. — Spec §4.2 step 3 lists both probe reasons; one per tick bounds quota and keeps the step pure; §4.2 "a catalog outage changes nothing" extends to a one-provider outage. — A tier that moves its head and lacks a previous fills its previous a day later; a provider that drops one tier's family entirely while listing other models is still read as a retirement.
- **P14 — "X failed its check" lines** are written for `model_missing` only; an inconclusive probe is silent (it runs again next tick and the incident path is unchanged). — Spec §4.2 "Inconclusive: … probe runs again"; a quota blip would otherwise notice daily. — An inconclusive streak is visible only in `model_probe` rows.
- **P15 — empty-tier card scope.** A card is sent for an empty tier (no adopted head after the tick) that is the **sole** tier of at least one key: a judge seat bound to it, or a role whose every leg is that tier (today: `judges:0..2`, `vision`, `chair`). The tap writes one `/models set` row per such key (`pattern` = the model id, `actor` = the tapper) and resolves those keys' `role_unresolved` in the same transaction as the `model_probe` event. A tier that empties but leaves every key resolved gets no card (its roles run their other legs; the change notice already names any head that moved). No proposals → a text-only card naming the `/models set` form. "Not now" only answers. — An override goes ahead of a whole role's legs (`resolveRole`), so writing one for a role that still resolves would reroute healthy legs; spec §4.4's only case (`gemini-pro` → `judges:2`) is covered. — A multi-leg tier that empties gets no card.
- **P16 — the tap's async seam.** Gateway intake is synchronous (`gateway.ts:221` returns inside `oncePerTrigger`). The tap handler validates, replies "Checking …", and starts the probe on a promise it tracks; `Gateway.whenTierTapsSettled()` awaits every tracked promise (tests and the gate use it). The probe's own catch replies `TAP_FAILED_TEXT`. Callback data is `mt:<tier>:<hash12>:use` / `mt:<tier>:no` (Telegram's 64-byte cap; `jevAcceptData`'s hash precedent, `jev-version-job.ts:74`); the handler re-derives the tier's current proposals and answers `TAP_HANDLED_TEXT` when the hash matches none, the tier is no longer empty, or every sole key already has an override. `model_tier_tap` joins `RATE_LIMIT_EXEMPT` (`gateway.ts:151`) and the audit SQL exemption list (`run-store.ts:2659`, protected). The handler returns `ok: true` on every path, so no new denial code reaches `HANDLED_INTAKE_DENIAL_CODES` (lessons 4A). **Stop (Rev 1.1, review W5):** `TierTapDeps.signal` is the daemon's stop signal (`Gateway` option `stopSignal`, the daemon passes `options.stopSignal`); the probe gets it, so a stop kills the probe's child and the `"aborted"` answer commits nothing; the daemon's shutdown awaits `gateway.whenTierTapsSettled()` bounded by `TIER_TAP_SHUTDOWN_CAP_MS = 5_000` before the store closes. — Spec §4.4 "probes first, off the tap's path"; §4.2 "a stop signal aborts a running probe and commits nothing". — A tap probe cut by a stop answers nothing on that card (the next card comes tomorrow).
- **P17 — `model_probe` payload.** Required fields `["tier", "selector", "purpose", "result", "kind"]` (`run-ledger.ts:127` `requiredPayloadFields`): `purpose ∈ head|previous|tap`, `result ∈ pass|model_missing|inconclusive`, `kind` a closed code (`ok`, `empty`, `unavailable`, `threw`, or an `LlmErrorKind`). No output text. — Spec §4.2 gives `{selector, result}`; tier and purpose make a row self-explaining, kind tells quota from auth. — None.
- **P18 — the `/status` line lives in `gateway.ts` `formatStatusText` (`:1282`),** the command Paco types, after the `Self-check:` line, chat-scoped by `event.notify.chat_id`. `src/status/houge-status.ts` renders the planner's `houge_status` tool and is not changed, although spec §11 names it. — Plain reading of "`/status` shows one line". — The planner's own status tool does not mention the carry.
- **P19 — `transcript_trust_at` moves only when the level changes.** `setTranscriptTrust` sets `transcript_trust_at = now` when the stored level differs (or the row is new), else keeps it, so "since <time>" is when the carry began, not the last turn's end. `/fresh`'s commit writes `clean` with its own instant. — "carries <level> since <time>" names a start. — None.
- **P20 — `persistRise` is unchanged:** it persists the in-turn `level()` (`planner-supervisor.ts:808–813`). A daemon that dies mid-turn after a withhold leaves `hostile`; only `endTrust` stores the carry level. — Fail closed on a crash (security re-review 1). — One extra hostile carry after a mid-turn crash; `/fresh` clears it.
- **P21 — `/fresh` details.** (a) The marker is honoured regardless of `HOUGE_LESSON_SESSION_RESET` (an explicit command; the flag gates lesson resets). (b) The marker is an upsert: with no `planner_session_state` row it inserts one with `lesson_fingerprint = ''` (as `setTranscriptTrust` does, `run-store.ts:3139`). (c) A fresh reset records `planner_session_reset {reason: "fresh"}` with the current lesson fingerprint (or the committed one when the lesson read failed), so the lesson set is promoted as today. (d) A failed fresh reset while the lesson set also changed follows the lesson rule for the spawn (failures 1–2 fail it, the 3rd serves the resumed session), the marker stays either way, and the prefix goes on any reply served from the old transcript. (e) The prefix is added to the outgoing reply only (`outcome.complete` text); the stored assistant chat turn stays the planner's text. (f) `freshTried` (in memory) stops a live child from being restarted at every turn start for a marker it already tried; a new start (idle exit, restart, a new marker) tries again. — Spec §6.2 leaves these unstated. — (d): a lesson-and-fresh double failure fails the spawn twice before degrading, as a lesson failure does today.
- **P22 — the boot resolve** of open `hostile_schedule_turn` rows is a `schema_migrations`-gated step in `RunStore.migrate()` (version `2026-11-02-hostile-schedule-event`), resolving each through `resolveIncident` (so each gets its `incident_resolved` row). — Spec §11 places it in run-store; a version row makes it once. — It also runs on a gate's or test's copy (wanted: the gate checks it).
- **P23 — reminder once-a-day latch** is the outbox key `incident_remind:<display-zone date>` (`resolveDisplayZone`, as `trust-ask.ts:52`). `enqueueNotification` returns `duplicate` for the same payload and `conflict` for a different one on the same key (`run-store.ts:7427–7435`); both read as "already sent". Age is `<d>d<h>h`. — No new latch table. — A conflict result is not an error here (documented in the function).
- **P24 — panel model ids** go in the `idea_panel_tick` payload only (`judge_models: {kimi, codex, gemini} → selector | null`, a required field so every call site writes it, `null` when the caller passed no seats' models). `radar_shortlists` is unchanged. — Spec §8 names the tick payload. — The shortlist rows themselves do not carry the ids.
- **P25 — D3-A and a carried-hostile schedule turn that itself withholds:** its level does not rise (already `hostile`), so nothing pages. — `raise()` pages only on a rise (`trust.ts:39,45`). — Such a turn's own withhold is visible only in its `turn_trust`-less run and its `tool.injection` row.
- **P26 — the tick's probe and catalog are optional inputs.** `ModelRolesTickInput.probe?` (absent → no probe runs; retirements still follow) and `roles.catalog?` (absent → no tier work). The daemon always passes both. — Keeps `scripts/live-gate-jev-tree.mjs:533` and the existing tick tests valid without a real probe. — A caller that forgets `probe` never adopts a new head (the daemon wiring test pins it).
- **P27 — gates and the tick's 24 h latch.** A gate's tick uses `now = latest model_roles_resolved.resolved_at + 25 h` on the copy, else the copy's own row makes it IDLE. — `model-roles-tick.ts:28`. — None.
- **P28 — static stale check scope.** It checks every distinct `provider/id` in `STATIC_ROLE_LISTS`; it also resolves an open `static_list_stale` whose subject is no longer in the static lists (a re-pin). — Spec §4.3 "the next check that finds it listed resolves it" does not cover a re-pin. — None.
- **P29 — test-store access:** `store.db` is private; use `(store as unknown as { db: DatabaseSync }).db` in tests (R4 P11). Known flakes (R4 P18): "aborts on the turn deadline" and "a start slower than the deadline is cancelled" in `planner-supervisor.test.ts` can fail under load; rerun the file alone before chasing them.
- **P30 — commit trailer** names the implementing model (`Co-Authored-By: Claude <Model> <version> <noreply@anthropic.com>`).
- **P31 — `/fresh` does not seed.** A lesson reset marks `seed_pending = 1` so the next dispatch re-sends recent user turns into the new transcript (memory A1 §6, `turn-context.ts:117,292`). `/fresh`'s reply promises "the planner will not see earlier turns", so a fresh reset records `seed_pending = 0`. — The reply must be true. — The first turn after `/fresh` has no conversational context (which is the request).
- **P32 — the stage-4 differential** compares whole DBs (`dumpDb`), so this slice's new table, columns and migration rows are dropped there by name (Task 14 Step 0). — The old builds never had them; without it every corpus fails on schema, not behaviour. — A named drop could hide a real write to those objects in an old-vs-new corpus (none of the corpora drive the tick or `/fresh`).

## Global Constraints

- `dependencies: {}` stays empty. Node stdlib and devDeps only.
- **Tiers (spec §4.1, D1-A), verbatim:**
  - `opus@anthropic` `anthropic` `^claude-opus-(\d{1,2})(?:-(\d{1,2}))?$` head `claude-opus-5-5`; `opus@antigravity` `google-antigravity` same pattern, head `claude-opus-5-5`;
  - `sonnet@anthropic` `anthropic` `^claude-sonnet-(\d{1,2})(?:-(\d{1,2}))?$` head `claude-sonnet-5-5`; `sonnet@antigravity` `google-antigravity` same, head `claude-sonnet-5-5`;
  - `gemini-flash` `google-antigravity` `^gemini-(\d{1,2})(?:\.(\d{1,2}))?-flash$` head `gemini-3.8-flash`; `gemini-pro` `google-antigravity` `^gemini-(\d{1,2})(?:\.(\d{1,2}))?-pro$` head **none**;
  - `codex-sol` `openai-codex` `^gpt-(\d{1,2})(?:\.(\d{1,2}))?-sol$` head `gpt-6.1-sol`; `kimi` `kimi-code` `^k(\d{1,2})(?:\.(\d{1,2}))?(?:-pro)?$` (D1-A: widened to `-pro`, `-highspeed` excluded by the anchor) head after the first tick `k3.1-pro`.
  - Opus is the top Anthropic tier; Codex stays on `sol`; Fable and Mythos are in no tier (D1-A).
  - Versions compare segment by segment as integers, a missing segment = 0 (`5` < `5-5`, `6` < `6.1` < `6.10`, `3.8` > `2.5`); equal versions: the shorter id wins.
- **Seeded heads (spec §4.2 bootstrap):** `opus@*` `claude-opus-5-5`; `sonnet@*` `claude-sonnet-5-5`; `gemini-flash` `gemini-3.8-flash`; `codex-sol` `gpt-6.1-sol`; `kimi` `k3`; `gemini-pro` no adopted head. `previous` is null for all.
- **Role legs (spec §4.1), in order:** Fast `sonnet@anthropic:low, sonnet@antigravity:low, gemini-flash:low`; Default `opus@anthropic:medium, opus@antigravity:medium, kimi:low`; Thinking `opus@anthropic:high, opus@antigravity:high, kimi:high`; Reader `gemini-flash:low, kimi:low, codex-sol:low`; Vision `gemini-flash:low`; Tiny `kimi:low, gemini-flash:low`; Chair `opus@anthropic:low`; Reviewer `kimi:high, opus@antigravity:medium`; Judges seat 0 `kimi`, seat 1 `codex-sol`, seat 2 `gemini-pro`. Each leg resolves to its tier's adopted head, then its previous head; **a judge seat resolves to its tier's adopted head only, never a chain.** Duplicates drop and the effort clamp applies as today. `/models` overrides go ahead of the legs as today.
- **Probe (spec §4.2):** prompt `Reply with exactly OK.`, one leg, 60 s, through `oneShotAdapter` (P7); pass = `ok` with a non-empty reply (no exact `OK` match); `model_missing` → tier stays, `rejected_selector`/`rejected_at` set, not probed again for **7 days**; any other failure → inconclusive, tier stays, probed again next tick. A stop signal aborts a running probe and the tick commits nothing.
- **Tick order (spec §4.2):** read the catalog → per tier compute the catalog head → probes one at a time outside any transaction → one transaction: probe events, `model_tiers`, re-resolve every role, `model_roles_resolved`, the change notice (one line per moved role; `X failed its check; staying on Y`; `tier head X is available; your override Y is in place (/models reset <key>)`), `role_unresolved` sync, `static_list_stale` sync, empty-tier cards. A catalog outage changes nothing.
- **Static rollback (D4-A, spec §4.3):** `HOUGE_MODEL_ROLES=static` stays catalog-free (no reads, no probes). `STATIC_ROLE_LISTS` is re-pinned to the seeded heads, `gpt-5.5` → `gpt-6.1-sol`; **judge seat 2 in static is empty**. The stale check runs in resolved mode only (opens `static_list_stale`, subject = the selector; resolves on return).
- **Card (spec §4.4):** text `Judges:2 has no model: Google's pro tier is empty. Use \`gemini-4-argon\`?`, buttons `[Use gemini-4-argon] [Not now]`; up to three proposals by current output price, highest first (`timeBased.effectiveRates` in force); one card a day per empty tier; a tap probes first and writes the override only on pass, in the probe event's transaction; code never adopts a codename without a tap.
- **`REMIND_KINDS` (spec §5), exactly:** `role_unresolved` → "tap the card, or `/models set <key> <pattern>`"; `static_list_stale` → "re-pin `STATIC_ROLE_LISTS`"; `model_catalog_unavailable` → "check `omp --profile houge models`"; `planner_session_reset_failed` → "send `/fresh`, or check the omp session dir". Never `undelivered_notification`, `trust_tap_budget`, `omp_contract_drift`, `planner_no_leg`. One message, incidents older than 24 h, idempotency key `incident_remind:<Sydney date>` (the display zone), once a day, **before** the model ticks (`telegram-daemon.ts:538`), in static mode and through a catalog outage too. Text: kinds, subjects, ages, action lines only.
- **`hostile_schedule_turn` is an event** (`event: true`, resolved right after its page); at the first boot of this build the open rows of that kind are resolved once by code. **D3-A:** a carried-hostile schedule turn pages nothing.
- **Carry (D2-A, spec §6.1):** `TurnTrust` keeps every cause it was asked to raise; the stored level is the highest carry level over that set; carry level = `CAUSE_LEVEL` except `injection_withheld` → `untrusted`. `carried_hostile`, `judge_lost_outside`, `unjudged_outside` still carry `hostile`. In-turn behaviour unchanged. `endTrust`'s `keepOld` compares carry levels. Standing credit follows the stored level (`run-store.ts:6996`, unchanged code).
- **`/fresh` (spec §6.2), verbatim texts:** reply `The next message starts a fresh conversation; the planner will not see earlier turns.`; failure prefix `Could not start a fresh conversation; this reply continues the old one.` Persisted `fresh_requested_at`; honoured at every start regardless of the lesson fingerprint; `commitReset` clears it and stores `clean` + `transcript_trust_at` only when `servedFresh` equals the stored marker (one statement); a failed fresh reset serves the old transcript with its carry, keeps the marker, opens `planner_session_reset_failed`, and prefixes the reply; an idle child is stopped now; a turn in flight is never cancelled.
- **`/status` line (spec §6.3), verbatim:** `Conversation carries <level> since <time> · /fresh clears it`; with a null time the ` since <time>` part is omitted; shown only when the stored level is not `clean`.
- **Protected files** (`src/capabilities/self-write-guard.ts:67–135`) are edited only as the approved spec requires; each task lists the protected files it touches. `src/llm/providers/omp.ts` and `src/llm/registry.ts` stay **unchanged** (spec §11).
- **Gates:** run from `.worktrees/` only (refuse otherwise); a VACUUM copy of the live DB under a temp root, deleted on every exit path (finally, SIGINT, SIGTERM, SIGHUP); never write `houge.sqlite`; `HOUGE_TELEGRAM_CHAT_ID=-1003`; `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` pinned under the temp root; print fixed codes, counts, booleans and closed labels only — never message text, model output, `error_ref`, `e.message`, or a live-DB id. Worktrees have no `.env`: `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/<gate>.mjs`; gate scripts import `../dist/`, so build the branch first.
- New functions under 50 lines; tests in `tests/<area>/` mirroring `src/`; each test says why the behaviour matters. Telegram output goes through the outbox (the rich renderer). Errors handled explicitly, never swallowed silently.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/omp/model-tiers.ts` (new) | 1 | `TIERS`, versions, members, head, `SEED_HEADS`, `TierHeads`, price, proposals |
| `src/omp/model-roles.ts` | 1, 3, 5, 6 | `CatalogPrice`; `ROLE_LEGS`, `JUDGE_SEATS`, leg resolution; static re-pin; `keysOfTier`, `soleKeysOf` |
| `src/omp/model-catalog.ts` | 1 | parse `cost` into `price` (P8) |
| `tests/fixtures/omp-catalog-2026-11-02.json` (new) | 1 | trimmed real catalog |
| `src/run/run-store.ts` | 2, 6, 8, 10, 11 | `model_tiers`, columns, accessors, `model_probe`, `"probe"` role, audit exemption, boot resolve, trust-at, fresh marker |
| `src/run/run-ledger.ts` | 2, 7 | `model_probe` type + required fields; `judge_models` |
| `src/omp/role-resolver.ts`, `src/gateway/models-commands.ts`, `scripts/live-gate-jev-tree.mjs` | 3 | resolve from `model_tiers`; seat count |
| `src/omp/model-probe.ts`, `src/omp/tier-step.ts` (new); `src/omp/model-roles-tick.ts`; `src/telegram/telegram-daemon.ts` | 4, 5, 6 | probe, plan/apply, tick reorder, notices, stale check, cards |
| `src/gateway/model-tier-commands.ts` (new), `src/gateway/gateway.ts`, `src/domain/types.ts`, `src/triggers/telegram-command-parser.ts`, `src/triggers/telegram-trigger-adapter.ts` | 6 | card text, tap |
| `src/capabilities/idea-panel.ts`, `src/capabilities/idea-panel-seats.ts` | 7 | `judge_models` |
| `src/run/incident-alert.ts`, `src/decisions/trust.ts` | 8 | `REMIND_KINDS`, reminder, event page |
| `src/decisions/entries/turn-trust.ts`, `src/decisions/trust.ts`, `src/omp/planner-supervisor.ts` | 9 | cause set, carry levels, D3-A |
| `src/gateway/gateway.ts` | 10, 11 | `/status` line; `/fresh` handler and help |
| `src/omp/planner-supervisor.ts` | 11 | marker honoured at start, `servedFresh`, commit, failure prefix, idle stop |
| `scripts/live-gate-model-tiers.mjs` (new) | 12 | Part A gate |
| `scripts/live-gate-loud-degradation.mjs` (new) | 13 | Parts B/C gate incl. real-omp `/fresh` |
| `scripts/check-loud-degradation-rollback.mjs` (new) | 14 | rollback |
| docs | 15 | ADR rows, configuration, README, ROADMAP, state block, lessons, sessions |

---
### Task 1: The tier model (pure), catalog price, the fixture

**Files:**
- Create: `src/omp/model-tiers.ts`, `tests/fixtures/omp-catalog-2026-11-02.json`, `tests/omp/model-tiers.test.ts`
- Modify: `src/omp/model-roles.ts:54` (`CatalogModel` gains `price?`; new `CatalogPrice`), `src/omp/model-catalog.ts:16–25` (`catalogEntry`)
- Test (existing, must stay green unchanged): `tests/omp/model-catalog.test.ts`
- Protected: `src/omp/model-tiers.ts`, `src/omp/model-roles.ts`, `src/omp/model-catalog.ts` (`src/omp`, P8)

**Interfaces — Produces** (`src/omp/model-tiers.ts`):
```ts
export type TierId = "opus@anthropic" | "opus@antigravity" | "sonnet@anthropic" | "sonnet@antigravity" | "gemini-flash" | "gemini-pro" | "codex-sol" | "kimi";
export interface TierDef { id: TierId; provider: string; pattern: RegExp; label: string }
export const TIERS: readonly TierDef[];
export const TIER_IDS: readonly TierId[];
export function isTierId(s: string): s is TierId;
export function tierDef(id: TierId): TierDef;
export function tierVersion(def: TierDef, id: string): number[] | null;
export function compareVersions(a: readonly number[], b: readonly number[]): number; // > 0: a is newer
export function tierMembers(def: TierDef, catalog: readonly CatalogModel[]): string[]; // newest first; equal version: shorter id first
export function catalogHead(def: TierDef, catalog: readonly CatalogModel[]): string | null;
export const SEED_HEADS: Readonly<Record<TierId, string | null>>;
export type TierHeads = ReadonlyMap<TierId, { adopted: string | null; previous: string | null }>;
export function seedTierHeads(): TierHeads;
export function tierHeadsOf(rows: ReadonlyArray<{ tier: string; adopted: string | null; previous: string | null }>): TierHeads; // unknown tiers ignored; a missing tier = its seed
export function outputPriceAt(m: CatalogModel, nowMs: number): number | null;
export function proposalsFor(def: TierDef, catalog: readonly CatalogModel[], nowMs: number): string[]; // ≤ 3 ids
```
`src/omp/model-roles.ts`: `export interface CatalogPrice { output: number; rates: ReadonlyArray<{ from: number; output: number }> }`; `CatalogModel` gains `price?: CatalogPrice`.

- [ ] **Step 1: verify the fixture.** `tests/fixtures/omp-catalog-2026-11-02.json` was written with this plan (from the plan author's read of `omp --profile houge models --json` on 2026-11-02, the catalog spec §3 describes), by:
```bash
node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const allowed = new Set(["anthropic", "google-antigravity", "kimi-code", "openai-codex"]);
const models = d.models.filter((m) => allowed.has(m.provider)).map(({ provider, id, thinking, cost }) => ({ provider, id, thinking, cost }));
fs.writeFileSync("tests/fixtures/omp-catalog-2026-11-02.json", JSON.stringify({ models }, null, 1) + "\n");
console.log(models.length);' <catalog.json>
```
Verify, do not regenerate: `shasum -a 256 tests/fixtures/omp-catalog-2026-11-02.json` → `10a9a71774725af04d438dc64d5bc8288fce325c5bdd55d09bfbe66f1983367c`; 56 entries; it holds `gemini-4-argon` with `cost.timeBased.effectiveRates` (two entries, the second `effectiveFrom: 1796112000000`), `k3.1-pro`, `k3.1-pro-highspeed`, `gpt-6.1-sol`, `gpt-6.1-terra`, `claude-opus-4-20250514`, and no `gemini-3.1-pro`. It is committed in this task.

A green draft of this task (the review ran it: `tests/omp/model-tiers.test.ts` + the `model-catalog.test.ts` case 21/21, `tests/omp/` 1114 green, typecheck clean; mutations (a) and (d) below shown failing) is at `/private/tmp/claude-501/-Users-xiaochuan-Projects-adventure/63a581ab-8d09-4840-a85b-58b78129f365/scratchpad/task1-green/` (`src/omp/model-tiers.ts`, `tests/omp/model-tiers.test.ts`, `task1-edits.patch` for the two modified files). It matches this task's code line for line except that it drops the doc comments; keep the comments as written here. Implementers may start from it; it still goes through task review.

- [ ] **Step 2: failing tests** — `tests/omp/model-tiers.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import {
  catalogHead, compareVersions, outputPriceAt, proposalsFor, SEED_HEADS, seedTierHeads, tierDef, tierHeadsOf, TIER_IDS, tierMembers, tierVersion,
  type TierId
} from "../../src/omp/model-tiers.js";

// Spec §4.1: exact version strings broke Houge four times (a retired planner string, a pinned omp and voice model, a
// pinned Jev version, and judge seat 2 empty for three weeks). A tier names a family; its newest catalog member is
// computed, so a release never needs a code edit, and a dated snapshot or a -lite/-highspeed variant never sneaks in.
const FIXTURE = new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname;
const catalog = (): CatalogModel[] => { const c = parseOmpCatalog(readFileSync(FIXTURE, "utf8")); if (!c) throw new Error("fixture did not parse"); return c; };
const NOV2 = Date.parse("2026-11-02T00:00:00Z");

describe("tiers over the 2026-11-02 catalog", () => {
  it("each tier's head is spec §4.1's (D1-A: Kimi widened to -pro; gemini-pro empty)", () => {
    const heads = Object.fromEntries(TIER_IDS.map((t) => [t, catalogHead(tierDef(t), catalog())]));
    expect(heads).toEqual({
      "opus@anthropic": "claude-opus-5-5", "opus@antigravity": "claude-opus-5-5", "sonnet@anthropic": "claude-sonnet-5-5",
      "sonnet@antigravity": "claude-sonnet-5-5", "gemini-flash": "gemini-3.8-flash", "gemini-pro": null, "codex-sol": "gpt-6.1-sol", kimi: "k3.1-pro"
    });
  });
  it("members are ordered newest first and exclude snapshots, -lite, -highspeed, -256k, previews and other families", () => {
    expect(tierMembers(tierDef("opus@anthropic"), catalog())).toEqual(
      ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4-0"]);
    expect(tierMembers(tierDef("gemini-flash"), catalog())).toEqual(["gemini-3.8-flash", "gemini-2.5-flash"]);
    expect(tierMembers(tierDef("codex-sol"), catalog())).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"]);
    expect(tierMembers(tierDef("kimi"), catalog())).toEqual(["k3.1-pro", "k3"]);
    const notIn: Array<[TierId, string]> = [["opus@anthropic", "claude-opus-4-20250514"], ["opus@anthropic", "claude-opus-4-5-20251101"],
      ["gemini-flash", "gemini-3.5-flash-lite"], ["kimi", "k3.1-pro-highspeed"], ["kimi", "k3-256k"], ["kimi", "kimi-k2-turbo-preview"], ["codex-sol", "gpt-6.1-terra"]];
    for (const [t, id] of notIn) expect(tierVersion(tierDef(t), id), `${t} ${id}`).toBeNull();
    expect(tierMembers(tierDef("opus@anthropic"), catalog())).not.toContain("claude-fable-5-1"); // D1-A: Fable/Mythos stay out
  });
  it("versions compare by integer segment, a missing segment is 0; equal versions: the shorter id wins", () => {
    const v = (t: TierId, id: string) => tierVersion(tierDef(t), id)!;
    expect(compareVersions(v("opus@anthropic", "claude-opus-5"), v("opus@anthropic", "claude-opus-5-5"))).toBeLessThan(0);
    expect(compareVersions(v("codex-sol", "gpt-6-sol"), v("codex-sol", "gpt-6.1-sol"))).toBeLessThan(0);
    expect(compareVersions(v("codex-sol", "gpt-6.1-sol"), v("codex-sol", "gpt-6.10-sol"))).toBeLessThan(0);
    expect(compareVersions(v("gemini-flash", "gemini-3.8-flash"), v("gemini-flash", "gemini-2.5-flash"))).toBeGreaterThan(0);
    const tie: CatalogModel[] = [{ provider: "anthropic", id: "claude-opus-5-0", thinking: null }, { provider: "anthropic", id: "claude-opus-5", thinking: null }];
    expect(tierMembers(tierDef("opus@anthropic"), tie)).toEqual(["claude-opus-5", "claude-opus-5-0"]);
  });
});

describe("seeded heads (spec §4.2 bootstrap)", () => {
  it("are today's known-good selectors; gemini-pro has none; tierHeadsOf fills a missing tier from its seed and ignores unknown rows", () => {
    expect(SEED_HEADS).toEqual({ "opus@anthropic": "claude-opus-5-5", "opus@antigravity": "claude-opus-5-5", "sonnet@anthropic": "claude-sonnet-5-5",
      "sonnet@antigravity": "claude-sonnet-5-5", "gemini-flash": "gemini-3.8-flash", "gemini-pro": null, "codex-sol": "gpt-6.1-sol", kimi: "k3" });
    expect(seedTierHeads().get("kimi")).toEqual({ adopted: "k3", previous: null });
    const h = tierHeadsOf([{ tier: "kimi", adopted: "k3.1-pro", previous: "k3" }, { tier: "nonsense", adopted: "x", previous: null }]);
    expect(h.get("kimi")).toEqual({ adopted: "k3.1-pro", previous: "k3" });
    expect(h.get("codex-sol")).toEqual({ adopted: "gpt-6.1-sol", previous: null });
    expect(h.size).toBe(TIER_IDS.length);
  });
});

describe("empty-tier proposals (spec §4.4)", () => {
  it("argon's output price is the effective rate in force: 10 until 2026-12-01T08:00Z, then 20", () => {
    const argon = catalog().find((m) => m.id === "gemini-4-argon")!;
    expect(outputPriceAt(argon, NOV2)).toBe(10);
    expect(outputPriceAt(argon, Date.parse("2026-12-01T07:59:59Z"))).toBe(10);
    expect(outputPriceAt(argon, Date.parse("2026-12-01T08:00:00Z"))).toBe(20);
    expect(outputPriceAt({ provider: "x", id: "y", thinking: null }, NOV2)).toBeNull();
  });
  it("gemini-pro proposes Google ids no tier reads, no preview, no -lite, by output price highest first", () => {
    expect(proposalsFor(tierDef("gemini-pro"), catalog(), NOV2)).toEqual(["gemini-4-argon", "gpt-oss-120b"]);
  });
  it("at most three, price order", () => {
    const m = (id: string, output: number): CatalogModel => ({ provider: "google-antigravity", id, thinking: null, price: { output, rates: [] } });
    expect(proposalsFor(tierDef("gemini-pro"), [m("a", 1), m("b", 4), m("c", 3), m("d", 2)], NOV2)).toEqual(["b", "c", "d"]);
  });
});
```
Add to `tests/omp/model-catalog.test.ts` (new `it` inside the `parseOmpCatalog` describe):
```ts
  it("carries cost.output and timeBased.effectiveRates as price; an entry without cost has no price key (spec §4.4)", () => {
    const c = parseOmpCatalog(JSON.stringify({ models: [
      { provider: "google-antigravity", id: "gemini-4-argon", thinking: null, cost: { output: 10, timeBased: { effectiveRates: [{ effectiveFrom: 0, output: 10 }, { effectiveFrom: 5, output: 20 }, { effectiveFrom: "x", output: 1 }] } } },
      { provider: "anthropic", id: "claude-opus-5-5", thinking: null }
    ] }));
    expect(c).toEqual([
      { provider: "google-antigravity", id: "gemini-4-argon", thinking: null, price: { output: 10, rates: [{ from: 0, output: 10 }, { from: 5, output: 20 }] } },
      { provider: "anthropic", id: "claude-opus-5-5", thinking: null }
    ]);
  });
```

- [ ] **Step 3: run, see fail** — `npx vitest run tests/omp/model-tiers.test.ts tests/omp/model-catalog.test.ts` → module not found / price missing.

- [ ] **Step 4: implement.**

`src/omp/model-roles.ts`, replacing the `CatalogModel` line (`:54`):
```ts
/** A catalog entry's output price per million tokens (spec §4.4): the flat rate, and any time-based steps (epoch ms). */
export interface CatalogPrice { output: number; rates: ReadonlyArray<{ from: number; output: number }> }
export interface CatalogModel { provider: string; id: string; thinking: readonly OmpEffort[] | null; price?: CatalogPrice }
```

`src/omp/model-catalog.ts` — add above `catalogEntry`, and make both of its returns carry the price:
```ts
/** `cost.output` and `cost.timeBased.effectiveRates` (spec §4.4, plan P8); null when `cost` has no finite output. */
function priceOf(cost: unknown): CatalogPrice | null {
  if (typeof cost !== "object" || cost === null) return null;
  const { output, timeBased } = cost as Record<string, unknown>;
  if (typeof output !== "number" || !Number.isFinite(output)) return null;
  const raw = typeof timeBased === "object" && timeBased !== null ? (timeBased as { effectiveRates?: unknown }).effectiveRates : undefined;
  const rates = Array.isArray(raw) ? raw.flatMap((r) => {
    const { effectiveFrom, output: o } = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    return typeof effectiveFrom === "number" && typeof o === "number" && Number.isFinite(o) ? [{ from: effectiveFrom, output: o }] : [];
  }) : [];
  return { output, rates };
}
```
In `catalogEntry`: `const { provider, id, thinking, cost } = raw as Record<string, unknown>;` … `const priced = (e: CatalogModel): CatalogModel => { const p = priceOf(cost); return p ? { ...e, price: p } : e; };` and wrap both returns: `return priced({ provider, id, thinking: null });` / `return priced({ provider, id, thinking: levels.length > 0 ? levels : null });`. Import `type CatalogPrice` beside `CatalogModel`.

`src/omp/model-tiers.ts`:
```ts
import type { CatalogModel } from "./model-roles.js";

/**
 * Model tiers (spec 2026-11-02 §4.1, ADR 0028 amendment): a tier is a provider plus an anchored pattern over the catalog id,
 * one capture group per version segment. "Newest" comes from the version in the id (the catalog has no release date).
 * `\d{1,2}` keeps dated snapshots out; the anchors keep out -lite, -highspeed, -256k and previews. A different family is
 * Paco's call (D1, or /models), never this file's.
 */
export type TierId = "opus@anthropic" | "opus@antigravity" | "sonnet@anthropic" | "sonnet@antigravity" | "gemini-flash" | "gemini-pro" | "codex-sol" | "kimi";
export interface TierDef { id: TierId; provider: string; pattern: RegExp; label: string }

const OPUS = /^claude-opus-(\d{1,2})(?:-(\d{1,2}))?$/;
const SONNET = /^claude-sonnet-(\d{1,2})(?:-(\d{1,2}))?$/;
export const TIERS: readonly TierDef[] = [
  { id: "opus@anthropic", provider: "anthropic", pattern: OPUS, label: "Opus" },
  { id: "opus@antigravity", provider: "google-antigravity", pattern: OPUS, label: "Opus" },
  { id: "sonnet@anthropic", provider: "anthropic", pattern: SONNET, label: "Sonnet" },
  { id: "sonnet@antigravity", provider: "google-antigravity", pattern: SONNET, label: "Sonnet" },
  { id: "gemini-flash", provider: "google-antigravity", pattern: /^gemini-(\d{1,2})(?:\.(\d{1,2}))?-flash$/, label: "flash" },
  { id: "gemini-pro", provider: "google-antigravity", pattern: /^gemini-(\d{1,2})(?:\.(\d{1,2}))?-pro$/, label: "pro" },
  { id: "codex-sol", provider: "openai-codex", pattern: /^gpt-(\d{1,2})(?:\.(\d{1,2}))?-sol$/, label: "sol" },
  // D1-A (Paco 2026-11-02): -pro counts (k3.1-pro > k3); -highspeed and -256k stay out by the anchor
  { id: "kimi", provider: "kimi-code", pattern: /^k(\d{1,2})(?:\.(\d{1,2}))?(?:-pro)?$/, label: "K" }
];
export const TIER_IDS: readonly TierId[] = TIERS.map((t) => t.id);
export const isTierId = (s: string): s is TierId => (TIER_IDS as readonly string[]).includes(s);
export function tierDef(id: TierId): TierDef { return TIERS.find((t) => t.id === id)!; }

/** The id's version segments (a missing segment = 0), or null when the id is not in the tier. */
export function tierVersion(def: TierDef, id: string): number[] | null {
  const m = def.pattern.exec(id);
  return m ? m.slice(1).map((s) => (s === undefined ? 0 : Number(s))) : null;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The tier's catalog ids, newest first; equal versions: the shorter id first, then by id. */
export function tierMembers(def: TierDef, catalog: readonly CatalogModel[]): string[] {
  const ids = [...new Set(catalog.filter((c) => c.provider === def.provider && tierVersion(def, c.id) !== null).map((c) => c.id))];
  return ids.sort((x, y) => compareVersions(tierVersion(def, y)!, tierVersion(def, x)!) || x.length - y.length || (x < y ? -1 : x > y ? 1 : 0));
}

export function catalogHead(def: TierDef, catalog: readonly CatalogModel[]): string | null { return tierMembers(def, catalog)[0] ?? null; }

/** Spec §4.2 bootstrap (W4): the list entries that matched each tier and ran on 2026-11-01. gemini-pro has none (§4.4). */
export const SEED_HEADS: Readonly<Record<TierId, string | null>> = {
  "opus@anthropic": "claude-opus-5-5", "opus@antigravity": "claude-opus-5-5", "sonnet@anthropic": "claude-sonnet-5-5",
  "sonnet@antigravity": "claude-sonnet-5-5", "gemini-flash": "gemini-3.8-flash", "gemini-pro": null, "codex-sol": "gpt-6.1-sol", kimi: "k3"
};

export type TierHeads = ReadonlyMap<TierId, { adopted: string | null; previous: string | null }>;
export function seedTierHeads(): TierHeads { return new Map(TIER_IDS.map((t) => [t, { adopted: SEED_HEADS[t], previous: null }])); }

/** `model_tiers` rows → heads; a tier with no row keeps its seed; a row for an unknown tier is ignored. */
export function tierHeadsOf(rows: ReadonlyArray<{ tier: string; adopted: string | null; previous: string | null }>): TierHeads {
  const m = new Map(seedTierHeads());
  for (const r of rows) if (isTierId(r.tier)) m.set(r.tier, { adopted: r.adopted, previous: r.previous });
  return m;
}

/** The output price in force at `nowMs`: the latest effective rate that has started, else the flat rate; null when unpriced. */
export function outputPriceAt(m: CatalogModel, nowMs: number): number | null {
  if (!m.price) return null;
  const started = m.price.rates.filter((r) => r.from <= nowMs).sort((a, b) => b.from - a.from)[0];
  return started ? started.output : m.price.output;
}

/** P9: same provider, matched by no tier of that provider, not a preview, not -lite. */
function isProposal(def: TierDef, m: CatalogModel): boolean {
  if (m.provider !== def.provider || m.id.includes("preview") || m.id.endsWith("-lite")) return false;
  return !TIERS.some((t) => t.provider === def.provider && tierVersion(t, m.id) !== null);
}

/** Spec §4.4: up to three ids for an empty tier, by current output price, highest first (unpriced last, then by id). */
export function proposalsFor(def: TierDef, catalog: readonly CatalogModel[], nowMs: number): string[] {
  const price = (m: CatalogModel) => outputPriceAt(m, nowMs) ?? -1;
  return catalog.filter((m) => isProposal(def, m)).sort((a, b) => price(b) - price(a) || (a.id < b.id ? -1 : 1)).slice(0, 3).map((m) => m.id);
}
```

- [ ] **Step 5: run, see pass** — `npx vitest run tests/omp/ && npm run typecheck`. Plant and show failing, one at a time, then revert: (a) drop `(?:-pro)?` from the Kimi pattern (head test fails); (b) sort members by `x.localeCompare(y)` only (order test fails: `claude-opus-5` before `claude-opus-5-5`? — whichever assertion catches it); (c) `outputPriceAt` returns `m.price.output` always (argon 20 case fails); (d) drop the `preview` filter (proposal list gains `tab_*`).
- [ ] **Step 6: commit** — `git add src/omp/model-tiers.ts src/omp/model-roles.ts src/omp/model-catalog.ts tests/omp/model-tiers.test.ts tests/omp/model-catalog.test.ts tests/fixtures/omp-catalog-2026-11-02.json` → `feat(omp): model tiers — newest catalog member per family, seeded heads, priced proposals`.

---

### Task 2: `model_tiers` table, new columns, accessors, `model_probe`, the `probe` audit role

**Files:**
- Modify: `src/run/run-store.ts` — `LlmCallRole` (`:64–96`, add `| "probe"`); `migrate()` (`:8352–8429`, append `this.applyLoudDegradationMigration();` after `applyStandingApprovalMigration`); new migration beside `applyStandingApprovalMigration` (`:8431`); new accessors beside `recordModelRolesResolved` (`:6309`); new exported types near `ModelRolesResolvedRow` (`:385`).
- Modify: `src/run/run-ledger.ts` — `LedgerEventType` (add `| "model_probe"` after `"omp_contract_probe"`, `:27`); `requiredPayloadFields` (after `omp_contract_probe`, `:351`).
- Test: `tests/run/loud-degradation-store.test.ts` (new)
- Protected: `src/run/run-store.ts`, `src/run/run-ledger.ts`

**Interfaces — Consumes:** Task 1 `SEED_HEADS`, `TIER_IDS`. **Produces** (`run-store.ts`):
```ts
export interface ModelTierRow { tier: string; adopted: string | null; previous: string | null; adopted_at: string | null;
  rejected_selector: string | null; rejected_at: string | null; updated_at: string }
export type ModelProbeResult = "pass" | "model_missing" | "inconclusive";
export interface ModelProbeRow { tier: string; selector: string; purpose: "head" | "previous" | "tap"; result: ModelProbeResult; kind: string }
// RunStore:
listModelTiers(): ModelTierRow[];                       // ORDER BY tier
getModelTier(tier: string): ModelTierRow | undefined;
writeModelTier(r: Omit<ModelTierRow, "updated_at">, now: string): void; // upsert
recordModelProbe(p: ModelProbeRow): void;              // run-less ledger event, correlation "model-roles"
```
Columns (nullable, used by Tasks 10–11): `planner_session_state.fresh_requested_at TEXT`, `planner_session_state.transcript_trust_at TEXT`.

- [ ] **Step 1: failing tests** — `tests/run/loud-degradation-store.test.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_HEADS, TIER_IDS } from "../../src/omp/model-tiers.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.2 bootstrap (W4): the first boot of this build must resolve exactly today's working models, never an empty table
// (an empty table would run every role on its static fallback for a day). The tier rows are state the tick owns, so a reopen
// must never reseed over a tick's write. Probe outcomes are ledgered with codes only, never model output.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const fileStore = () => { const d = mkdtempSync(join(tmpdir(), "hld-")); dirs.push(d); return join(d, "h.sqlite"); };

describe("model_tiers migration", () => {
  it("seeds exactly one row per tier with the known-good head, no previous, no rejection", () => {
    const s = RunStore.openInMemory();
    const rows = s.listModelTiers();
    expect(rows.map((r) => [r.tier, r.adopted, r.previous, r.rejected_selector, r.rejected_at])).toEqual(
      [...TIER_IDS].sort().map((t) => [t, SEED_HEADS[t], null, null, null]));
    expect(rows.filter((r) => r.adopted_at === null).map((r) => r.tier)).toEqual(["gemini-pro"]);
    s.close();
  });
  it("a reopen never reseeds over a tick's write", () => {
    const path = fileStore();
    const a = RunStore.open(path);
    a.writeModelTier({ tier: "kimi", adopted: "k3.1-pro", previous: "k3", adopted_at: "2026-11-03T00:00:00.000Z", rejected_selector: null, rejected_at: null }, "2026-11-03T00:00:00.000Z");
    a.close();
    const b = RunStore.open(path);
    expect(b.getModelTier("kimi")).toEqual({ tier: "kimi", adopted: "k3.1-pro", previous: "k3", adopted_at: "2026-11-03T00:00:00.000Z",
      rejected_selector: null, rejected_at: null, updated_at: "2026-11-03T00:00:00.000Z" });
    expect(b.listModelTiers()).toHaveLength(TIER_IDS.length);
    b.close();
  });
  it("adds the two nullable planner_session_state columns", () => {
    const s = RunStore.openInMemory();
    const cols = db(s).prepare("PRAGMA table_info(planner_session_state)").all() as Array<{ name: string; notnull: number }>;
    expect(cols.filter((c) => c.name === "fresh_requested_at" || c.name === "transcript_trust_at").map((c) => [c.name, c.notnull]))
      .toEqual([["fresh_requested_at", 0], ["transcript_trust_at", 0]]);
    s.close();
  });
});

describe("model_probe", () => {
  it("is one run-less event with exactly the five code fields", () => {
    const s = RunStore.openInMemory();
    s.recordModelProbe({ tier: "kimi", selector: "kimi-code/k3.1-pro", purpose: "head", result: "pass", kind: "ok" });
    const rows = s.getLedgerEvents().filter((e) => e.event_type === "model_probe");
    expect(rows.map((e) => [e.run_id ?? null, e.correlation_id, e.payload])).toEqual([[null, "model-roles",
      { tier: "kimi", selector: "kimi-code/k3.1-pro", purpose: "head", result: "pass", kind: "ok" }]]);
    s.close();
  });
  it("a probe's attempt is audited under role `probe`", () => {
    const s = RunStore.openInMemory();
    s.llmAuditSink({ correlation_id: "probe:x", role: "probe" }).record({ provider: "kimi-code", role: "", outcome: "ok", model: "k3.1-pro" });
    expect(s.getLedgerEvents().filter((e) => e.event_type === "llm_attempt").map((e) => [e.correlation_id, (e.payload as { role: string }).role])).toEqual([["probe:x", "probe"]]);
    s.close();
  });
});
```
(`RunStore.open(path)` is the file-backed opener (`run-store.ts:1431`); `getLedgerEvents()` with no run id returns every row (`run-ledger.ts:418–436`). Check `llmAuditSink`'s correlation path at `run-store.ts:2348` for the `correlation_id` it writes — if it stores the scope's correlation under another key, compare that key.)

- [ ] **Step 2: run, see fail** — `npx vitest run tests/run/loud-degradation-store.test.ts` → `listModelTiers is not a function`.

- [ ] **Step 3: implement** in `run-store.ts`:
```ts
// beside the other DDL constants
/** Spec 2026-11-02 §4.2: one row per tier. `adopted`/`previous` are catalog ids (the provider is the tier's); `rejected_selector` is provider/id. */
const MODEL_TIERS_DDL = `CREATE TABLE IF NOT EXISTS model_tiers (
  tier TEXT PRIMARY KEY, adopted TEXT, previous TEXT, adopted_at TEXT, rejected_selector TEXT, rejected_at TEXT, updated_at TEXT NOT NULL
)`;

  /** Loud degradation (spec 2026-11-02 §4.2, §6.2, §6.3): the tier table, seeded once, and two nullable columns. Additive: the old build ignores all three. */
  private applyLoudDegradationMigration(): void {
    const version = "2026-11-02-loud-degradation";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(MODEL_TIERS_DDL);
      const cols = this.tableColumns("planner_session_state");
      if (!cols.has("fresh_requested_at")) this.db.exec(`ALTER TABLE planner_session_state ADD COLUMN fresh_requested_at TEXT`);
      if (!cols.has("transcript_trust_at")) this.db.exec(`ALTER TABLE planner_session_state ADD COLUMN transcript_trust_at TEXT`);
      if (applied) return;
      this.seedModelTiers(new Date().toISOString());
      this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** W4: the known-good heads, so the first resolution after this build never sees an empty table. INSERT OR IGNORE: never over a tick's row. */
  private seedModelTiers(now: string): void {
    const ins = this.db.prepare(`INSERT OR IGNORE INTO model_tiers (tier, adopted, previous, adopted_at, rejected_selector, rejected_at, updated_at) VALUES (?, ?, NULL, ?, NULL, NULL, ?)`);
    for (const t of TIER_IDS) ins.run(t, SEED_HEADS[t], SEED_HEADS[t] === null ? null : now, now);
  }

  // accessors, beside recordModelRolesResolved
  listModelTiers(): ModelTierRow[] {
    return this.db.prepare(`SELECT tier, adopted, previous, adopted_at, rejected_selector, rejected_at, updated_at FROM model_tiers ORDER BY tier`).all<ModelTierRow>();
  }
  getModelTier(tier: string): ModelTierRow | undefined {
    return this.db.prepare(`SELECT tier, adopted, previous, adopted_at, rejected_selector, rejected_at, updated_at FROM model_tiers WHERE tier = ?`).get<ModelTierRow>(tier);
  }
  /** The daily tick's (and only its) write of one tier's state (spec §4.2 step 4). */
  writeModelTier(r: Omit<ModelTierRow, "updated_at">, now: string): void {
    this.db.prepare(`
      INSERT INTO model_tiers (tier, adopted, previous, adopted_at, rejected_selector, rejected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tier) DO UPDATE SET adopted = excluded.adopted, previous = excluded.previous, adopted_at = excluded.adopted_at,
        rejected_selector = excluded.rejected_selector, rejected_at = excluded.rejected_at, updated_at = excluded.updated_at
    `).run(r.tier, r.adopted, r.previous, r.adopted_at, r.rejected_selector, r.rejected_at, now);
  }
  /** One probe's outcome (spec §4.2, plan P17): codes only, never the model's reply or omp's text. */
  recordModelProbe(p: ModelProbeRow): void {
    this.appendLedgerEvent(createLedgerEvent({
      correlation_id: "model-roles", event_type: "model_probe", actor: "system", sequence: this.nextLedgerSequence(),
      payload: { tier: p.tier, selector: p.selector, purpose: p.purpose, result: p.result, kind: p.kind }
    }));
  }
```
Import `SEED_HEADS, TIER_IDS` from `../omp/model-tiers.js` (a value import; `model-tiers.ts` imports only a type from `model-roles.ts`, so no cycle). `LlmCallRole`: append `// a model probe before adoption (spec 2026-11-02 §4.2): its own role so probe traffic is readable apart` and `| "probe"`.

`run-ledger.ts`: `| "model_probe"` in `LedgerEventType`; in `requiredPayloadFields` after `omp_contract_probe`:
```ts
  // Spec 2026-11-02 §4.2: one probe before a tier adopts a model. Codes only (plan P17): purpose head|previous|tap,
  // result pass|model_missing|inconclusive, kind a closed failure code — never the model's reply or omp's text.
  model_probe: ["tier", "selector", "purpose", "result", "kind"],
```

- [ ] **Step 4: run, see pass** — `npx vitest run tests/run/ && npm run typecheck`. Mutations, each shown failing then reverted: seed without `INSERT OR IGNORE` guard (`INSERT OR REPLACE`) → the reopen test fails; drop `kind` from `requiredPayloadFields` and from the payload → the exact-payload test fails.
- [ ] **Step 5: commit** — `git add src/run/run-store.ts src/run/run-ledger.ts tests/run/loud-degradation-store.test.ts` → `feat(run): model_tiers seeded with the known-good heads; model_probe event; probe audit role`.

---
### Task 3: Role legs resolved from `model_tiers`

**Files:**
- Modify: `src/omp/model-roles.ts` — replace `ROLE_LISTS` (`:24–34`) with `Leg`, `ROLE_LEGS`, `JUDGE_SEATS`; `roleSelectors` (`:79–83`), `ResolveInput` (`:72–73`), `overrideCandidates` (`:102–110`), `resolveRole` (`:135–141`); new `keysOfTier`.
- Modify: `src/omp/role-resolver.ts` — imports (`:2–5`), `Snapshot` (`:25`), `chains()` (`:93–101`), `resolveAll()` (`:104–115`), `snapshot()` (`:149–158`), `resolveWith()` (`:161–167`).
- Modify: `src/gateway/models-commands.ts:3,82` (`ROLE_LISTS.judges.length` → `JUDGE_SEATS`); `src/triggers/telegram-command-parser.ts:222` (comment: "the ROLE_LEGS.judges index").
- Modify: `scripts/live-gate-jev-tree.mjs:101,475–477,495` (P11).
- Modify tests: `tests/helpers/model-roles.ts` (add `SEED_LISTS`), `tests/omp/model-roles.test.ts`, `tests/omp/role-resolver.test.ts` (`:12–16`, `:144`, `:168–171`, `:179–181`), `tests/omp/model-roles-tick.test.ts:3,111–124`, `tests/gateway/models-commands.test.ts:5,127` (review W3).
- Modify (comment only): `src/capabilities/idea-panel-seats.ts:14` ("gemini-3.1-pro" → "the gemini-pro tier's adopted head").
- Test (new): `tests/omp/model-roles-legs.test.ts`
- Protected: `src/omp/model-roles.ts`, `src/omp/role-resolver.ts`

**Interfaces — Consumes:** Task 1 `TierId`, `TierHeads`, `seedTierHeads`, `tierHeadsOf`, `tierDef`; Task 2 `store.listModelTiers()`. **Produces** (`model-roles.ts`):
```ts
export interface Leg { tier: TierId; effort?: OmpEffort }
export const ROLE_LEGS: Readonly<Record<RoleName, readonly Leg[]>>;
export const JUDGE_SEATS: number; // ROLE_LEGS.judges.length (3)
export function roleSelectors(role: RoleName, seat?: number, mode?: ModelRolesMode, heads?: TierHeads): ModelString[]; // heads default: seedTierHeads()
export interface ResolveInput { role; seat?; catalog; override; refused; mode; tiers?: TierHeads }
export function overrideCandidates(role, seat, override, catalog, tiers?: TierHeads): ModelString[];
export function keysOfTier(tier: TierId): Array<RoleName | `judges:${number}`>; // every key with a leg on the tier
```

- [ ] **Step 0: grep the ripple.** `rg -n "ROLE_LISTS|claude-opus-4-6|gemini-3\.1-pro|judges\.length|cfg\.judges|\.judges\[" src scripts tests` — list every hit in the task report as "rewritten here", "static (Task 5)", or "unrelated (why)". Expected (re-grepped for Rev 1.1, `rg -n "ROLE_LISTS|STATIC_ROLE_LISTS|cfg\.judges|\.judges\[|judgeSeat\(|panelSeats|PanelSeatBindings|RATE_LIMIT_EXEMPT|gpt-5\.5|gemini-3\.1-pro|claude-opus-4-6" src scripts tests`): the files above; `src/llm/registry.ts:135,168` (unchanged, P12); `tests/llm/seat-routing.test.ts:30–31` (index maps; green with 2 static seats); `scripts/eval-replay.mjs:136` (`cfg.judges[0]`, unchanged); unrelated — own role lists or stub catalogs, not the role tables: `tests/helpers/supervisor-harness.ts`, `tests/omp/planner-supervisor.test.ts`, `scripts/stage4-corpora/supervision.mjs:16`, `scripts/live-gate-ladder-remainder-r4.mjs:83,86`, `scripts/check-ladder-remainder-r4-rollback.mjs:120`, `tests/run/run-store-model-roles.test.ts:10`, `tests/omp/model-string.test.ts:25,27`, `tests/llm/providers/agy-models.test.ts:12`, `src/decisions/entries/intake-rate-limit.ts:7` (comment). Owned by later tasks: `tests/omp/omp-config.test.ts`, `tests/capabilities/idea-panel-seats.test.ts`, `tests/capabilities/panel-judge-providers.test.ts` (Task 5), `tests/gateway/intake-decisions.test.ts` (Task 6), `tests/telegram/telegram-daemon.test.ts:718` (Task 7).

- [ ] **Step 1: failing tests.** Add to `tests/helpers/model-roles.ts`:
```ts
/** Spec §4.2 bootstrap: every key's resolution on the seeded heads over a catalog that lists them — today's lists minus
 * the three selectors the catalog dropped (google-antigravity/claude-opus-4-6 ×3 roles, google-antigravity/gemini-3.1-pro). */
export const SEED_LISTS: Readonly<Record<string, readonly string[]>> = {
  fast: ["anthropic/claude-sonnet-5-5:low", "google-antigravity/claude-sonnet-5-5:low", "google-antigravity/gemini-3.8-flash:low"],
  default: ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "kimi-code/k3:low"],
  thinking: ["anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-5-5:high", "kimi-code/k3:high"],
  reader: ["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6.1-sol:low"],
  vision: ["google-antigravity/gemini-3.8-flash:low"],
  tiny: ["kimi-code/k3:low", "google-antigravity/gemini-3.8-flash:low"],
  "judges:0": ["kimi-code/k3"], "judges:1": ["openai-codex/gpt-6.1-sol"], "judges:2": [],
  chair: ["anthropic/claude-opus-5-5:low"],
  reviewer: ["kimi-code/k3:high", "google-antigravity/claude-opus-5-5:medium"]
};
```
`tests/omp/model-roles-legs.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import { JUDGE_SEATS, keysOfTier, resolveRole, ROLE_LEGS, ROLE_NAMES, roleSelectors, type ResolveInput } from "../../src/omp/model-roles.js";
import { formatModelString } from "../../src/omp/model-string.js";
import { tierHeadsOf } from "../../src/omp/model-tiers.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { fixtureCatalog, SEED_LISTS } from "../helpers/model-roles.js";

// Spec §4.1: a role is a list of tier legs; each leg is its tier's adopted head then its previous head, so a retired head
// falls back to an already-probed model, never to a guess. A judge seat is its tier's adopted head alone: a judge never
// falls back inside a panel run (ADR 0027). The resolver reads model_tiers at every call, so an adoption needs no restart.
const NONE: ReadonlySet<string> = new Set();
const keyOf = (role: string, seat?: number) => (seat === undefined ? role : `${role}:${seat}`);
const slots = () => ROLE_NAMES.flatMap((role) => (role === "judges" ? Array.from({ length: JUDGE_SEATS }, (_, seat) => ({ role, seat })) : [{ role }]));
const resolved = (i: Partial<ResolveInput> & Pick<ResolveInput, "role">) =>
  resolveRole({ catalog: fixtureCatalog(), override: null, refused: NONE, mode: "resolved", ...i }).map(formatModelString);

describe("legs over the seeded heads", () => {
  it("resolve every key to today's lists minus the three selectors the catalog dropped; judges:2 is empty", () => {
    for (const { role, seat } of slots()) expect(resolved({ role, ...(seat === undefined ? {} : { seat }) }), keyOf(role, seat)).toEqual(SEED_LISTS[keyOf(role, seat)]);
  });
  it("the legs are spec §4.1's, in order; three judge seats", () => {
    expect(JUDGE_SEATS).toBe(3);
    expect(ROLE_LEGS.default).toEqual([{ tier: "opus@anthropic", effort: "medium" }, { tier: "opus@antigravity", effort: "medium" }, { tier: "kimi", effort: "low" }]);
    expect(ROLE_LEGS.judges).toEqual([{ tier: "kimi" }, { tier: "codex-sol" }, { tier: "gemini-pro" }]);
    expect(ROLE_LEGS.reviewer).toEqual([{ tier: "kimi", effort: "high" }, { tier: "opus@antigravity", effort: "medium" }]);
  });
});

describe("previous heads", () => {
  const heads = tierHeadsOf([{ tier: "codex-sol", adopted: "gpt-6.1-sol", previous: "gpt-6-sol" }]);
  it("follow the adopted head in a leg", () => {
    expect(roleSelectors("reader", undefined, "resolved", heads).map(formatModelString))
      .toEqual(["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6.1-sol:low", "openai-codex/gpt-6-sol:low"]);
  });
  it("never join a judge seat (no chain inside a panel run)", () => {
    expect(roleSelectors("judges", 1, "resolved", heads).map(formatModelString)).toEqual(["openai-codex/gpt-6.1-sol"]);
  });
  it("an adopted head the catalog no longer lists drops; its previous still resolves", () => {
    const cat = [...fixtureCatalog(), { provider: "openai-codex", id: "gpt-6-sol", thinking: null }].filter((m) => m.id !== "gpt-6.1-sol");
    expect(resolved({ role: "reader", catalog: cat, tiers: heads })).toEqual(["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6-sol:low"]);
  });
});

describe("keysOfTier", () => {
  it("names every role and judge seat with a leg on the tier", () => {
    expect(keysOfTier("kimi")).toEqual(["default", "thinking", "reader", "tiny", "reviewer", "judges:0"]);
    expect(keysOfTier("gemini-pro")).toEqual(["judges:2"]);
  });
});

describe("RoleResolver reads model_tiers at every resolution", () => {
  it("a tier write changes the next resolution without a restart; three judge seats, index-stable", async () => {
    const store = RunStore.openInMemory();
    const nov2 = parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => nov2 });
    await roles.refreshCatalog();
    const bare = (s: string | null | undefined) => (s ? s.split(":")[0]! : null); // resolveAll clamps efforts to the catalog's levels; compare provider/id
    expect(roles.resolveAll().map((r) => [r.key, bare(r.head)])).toEqual(slots().map(({ role, seat }) => [keyOf(role, seat), bare(SEED_LISTS[keyOf(role, seat)]![0])]));
    store.writeModelTier({ tier: "opus@anthropic", adopted: "claude-opus-5", previous: null, adopted_at: "t", rejected_selector: null, rejected_at: null }, "t");
    expect(bare(roles.resolveAll().find((r) => r.key === "chair")?.head)).toBe("anthropic/claude-opus-5");
    expect(roles.chains().judges).toHaveLength(3);
    store.close();
  });
});
```
(`resolveRole` does not clamp efforts — `RoleResolver.resolveWith` does — so the leg's `:low` stays. The push makes sure `gpt-6-sol` is catalogued whatever the old fixture holds.)

Rewrite the existing tests (each a mechanical replacement; behaviour pinned stays the same where the tier model keeps it):
- `tests/omp/model-roles.test.ts`: import `SEED_LISTS` and `JUDGE_SEATS` instead of `ROLE_LISTS`; `:19` iterate `roleSelectors(role, seat)` for every slot; `:58–62` expect `SEED_LISTS.fast`, `SEED_LISTS.thinking`, `SEED_LISTS.tiny`; `:70` iterate `ROLE_LEGS[role]` and check some leg's tier provider is not `kimi-code` (`tierDef(l.tier).provider`); `:79–80` expect `SEED_LISTS` per slot; `:93` and the "no catalog" case expect `SEED_LISTS.default`; the override cases at `:97–103` drop `google-antigravity/claude-opus-4-6` from the tails (`opus-4-6` as an override still matches the old fixture's id and goes first); the "drops a listed selector" case (`:105–111`): `newGen` → `SEED_LISTS.default`; `oldGen` (no Antigravity 5-5) → `["anthropic/claude-opus-5-5:medium", "kimi-code/k3:low"]` (the antigravity leg's adopted head left and it has no previous — the tier model's meaning, spec §4.1); the refused case drops `…opus-4-6…`. Static cases (`:30–55`, `:120–125`) stay as they are in this task (Task 5 re-pins).
- `tests/omp/role-resolver.test.ts:12–16`: `listChains()` becomes the seed: `const s = (k: string) => SEED_LISTS[k]!.map(parseModelString)`; `judges: [0, 1, 2].map((i) => s(\`judges:${i}\`)[0])` — and note in the test name that seat 2 is the static fallback until Task 5 (the resolver falls back to `STATIC_ROLE_LISTS.judges[2]` when the seat resolves empty): expect `chains().judges[2]` to equal `parseModelString("google-antigravity/gemini-3.1-pro")` here; Task 5 changes that line to `undefined`.
- `tests/omp/model-roles-tick.test.ts:3,111–124`: build `all` from `Object.values(SEED_LISTS).flat()`; `retired = "anthropic/claude-opus-5-5"`; expect the Thinking line to contain `google-antigravity/claude-opus-5-5`.
- `tests/omp/role-resolver.test.ts:144` (refused + clamp): the default chain loses the gone Antigravity 4-6 leg → `["google-antigravity/claude-opus-5-5:medium", "kimi-code/k3:high"]`.
- `tests/omp/role-resolver.test.ts:168–171` (fallback notes, catalog with no claude and no k3): `chains()` now also falls back for the empty `judges:2` seat, in `chains()` order → `[{ role: "default" }, { role: "judges:0" }, { role: "judges:2" }, { role: "chair" }, { role: "reviewer" }]`, and the post-read count `toHaveLength(6)`. Run it and pin the exact array it prints; if the order differs, the order is `chains()`'s (planner, reader, media, ticks, judges 0..2, chair, reviewer) — never sort or filter.
- `tests/omp/role-resolver.test.ts:179–181` (judges keep their index): in this task the seats are `["google-antigravity/claude-opus-4-6" (override), "openai-codex/gpt-5.5" (static fallback), "google-antigravity/gemini-3.1-pro" (static fallback, the tier is empty)]`, the notes `[{ role: "vision" }, { role: "judges:1" }, { role: "judges:2" }]`; format with `c.judges.map((m) => (m ? formatModelString(m) : null))` so Task 5 can pin a hole.
- `tests/gateway/models-commands.test.ts:5,127`: import `JUDGE_SEATS` instead of `ROLE_LISTS`; `` `/models set judges ${JUDGE_SEATS} opus` `` still refuses `no_seat`. Its stub catalog's `gemini-3.1-pro` rows (`:40`, `:59–116`, `:177–180`) are `/models` pattern tests over their own stub catalog — unrelated, unchanged.

- [ ] **Step 2: run, see fail** — `npx vitest run tests/omp/model-roles-legs.test.ts` → `ROLE_LEGS` not exported.

- [ ] **Step 3: implement.** `src/omp/model-roles.ts` (keep `RoleName`, `ROLE_NAMES`, `STATIC_ROLE_LISTS`, `ALLOWED_PROVIDERS`, `CHAT_ROLES`, `matchOverride`, `clampEffort`, `STEP_UP`, `staticRoleChains`, `isOverrideKey` as they are; `JUDGE_SEAT_KEY` is unchanged):
```ts
import { seedTierHeads, tierDef, type TierHeads, type TierId } from "./model-tiers.js";

/** One leg of a role (spec 2026-11-02 §4.1): a tier and the effort the role asks of it. */
export interface Leg { tier: TierId; effort?: OmpEffort }
const leg = (tier: TierId, effort?: OmpEffort): Leg => (effort ? { tier, effort } : { tier });

/**
 * The roles `resolved` mode runs (spec 2026-11-02 §4.1, ADR 0028 amendment): code-owned tiers in today's order, each
 * resolving to its adopted head then its previous head (model_tiers, the daily tick's state). Judges are one tier per seat
 * and resolve to the adopted head only: a judge never falls back inside a panel run (ADR 0027); the fallback happens
 * between runs, in the tick. Kimi exits next year (Paco, 2026-10-07): every multi-leg role keeps a non-Kimi leg.
 */
export const ROLE_LEGS: Readonly<Record<RoleName, readonly Leg[]>> = {
  fast: [leg("sonnet@anthropic", "low"), leg("sonnet@antigravity", "low"), leg("gemini-flash", "low")],
  default: [leg("opus@anthropic", "medium"), leg("opus@antigravity", "medium"), leg("kimi", "low")],
  thinking: [leg("opus@anthropic", "high"), leg("opus@antigravity", "high"), leg("kimi", "high")],
  reader: [leg("gemini-flash", "low"), leg("kimi", "low"), leg("codex-sol", "low")],
  vision: [leg("gemini-flash", "low")],
  tiny: [leg("kimi", "low"), leg("gemini-flash", "low")],
  judges: [leg("kimi"), leg("codex-sol"), leg("gemini-pro")],
  chair: [leg("opus@anthropic", "low")],
  reviewer: [leg("kimi", "high"), leg("opus@antigravity", "medium")]
};
/** The panel's seat count (S1: chains(), resolveAll() and the panel read this one number). */
export const JUDGE_SEATS = ROLE_LEGS.judges.length;

/** A leg's adopted head, then its previous head; a judge seat its adopted head only. */
function legIds(l: Leg, heads: TierHeads, judge: boolean): string[] {
  const h = heads.get(l.tier);
  return (judge ? [h?.adopted] : [h?.adopted, h?.previous]).filter((id): id is string => typeof id === "string");
}

function staticSelectors(role: RoleName, seat?: number): ModelString[] {
  if (role !== "judges") return STATIC_ROLE_LISTS[role].map(parseModelString);
  return seat === undefined ? [] : STATIC_ROLE_LISTS.judges.slice(seat, seat + 1).map(parseModelString);
}

/**
 * The role's own selectors: static mode STATIC_ROLE_LISTS; resolved mode its legs over `heads` (default: the seeded heads).
 * A judge seat is its one index; the judges role without a seat has none.
 */
export function roleSelectors(role: RoleName, seat?: number, mode: ModelRolesMode = "resolved", heads: TierHeads = seedTierHeads()): ModelString[] {
  if (mode === "static") return staticSelectors(role, seat);
  const legs = role !== "judges" ? ROLE_LEGS[role] : seat === undefined ? [] : ROLE_LEGS.judges.slice(seat, seat + 1);
  return legs.flatMap((l) => legIds(l, heads, role === "judges").map((id): ModelString =>
    (l.effort ? { provider: tierDef(l.tier).provider, model: id, effort: l.effort } : { provider: tierDef(l.tier).provider, model: id })));
}

/** Every key with a leg on `tier` (the change notice's shadowed-override line, spec §4.2). */
export function keysOfTier(tier: TierId): Array<RoleName | `judges:${number}`> {
  const roles = ROLE_NAMES.filter((r) => r !== "judges" && ROLE_LEGS[r].some((l) => l.tier === tier));
  const seats = ROLE_LEGS.judges.flatMap((l, i): Array<`judges:${number}`> => (l.tier === tier ? [`judges:${i}`] : []));
  return [...roles, ...seats];
}
```
`ResolveInput` gains `tiers?: TierHeads`. `overrideCandidates(role, seat, override, catalog, tiers?: TierHeads)` computes `own = roleSelectors(role, seat, "resolved", tiers)`. `resolveRole`: `const own = roleSelectors(i.role, i.seat, "resolved", i.tiers);` and passes `i.tiers` to `overrideCandidates`. Update the doc comments that said "ROLE_LISTS" to "the role's legs". Delete `ROLE_LISTS` and its comment block.

`src/omp/role-resolver.ts`:
```ts
interface Snapshot { mode: ModelRolesMode; overrides: Map<OverrideKey, string>; tiers: TierHeads }
// chains():
      judges: Array.from({ length: JUDGE_SEATS }, (_, seat) => or("judges", seat)[0] as ModelString),
// resolveAll(): (role === "judges" ? Array.from({ length: JUDGE_SEATS }, (_, seat) => ({ role, seat })) : [{ role }])
//   and: overrideCandidates(role, seat, override, this.cat, s.tiers)
  private snapshot(): Snapshot {
    const mode = resolveModelRolesMode(this.env());
    if (mode === "static") return { mode, overrides: new Map(), tiers: seedTierHeads() };
    return { mode, overrides: this.readOverrides(), tiers: this.readTiers() };
  }
  private readOverrides(): Map<OverrideKey, string> {
    try { return this.d.store.latestModelRoleOverrides(); } catch (error) {
      console.warn(`[model-roles] override read failed, resolving on the lists: ${why(error)}`);
      return new Map();
    }
  }
  /** model_tiers, read at every resolution like the overrides (spec §4.2: no restart); a failed read resolves on the seeded heads. */
  private readTiers(): TierHeads {
    try { return tierHeadsOf(this.d.store.listModelTiers()); } catch (error) {
      console.warn(`[model-roles] tier read failed, resolving on the seeded heads: ${why(error)}`);
      return seedTierHeads();
    }
  }
// resolveWith(): resolveRole({ role, ...seatOpt(o.seat), catalog: this.cat, override, refused: NOTHING_REFUSED, mode: s.mode, tiers: s.tiers })
```
`src/gateway/models-commands.ts`: import `JUDGE_SEATS` (drop `ROLE_LISTS`); `:82` `t.seat >= JUDGE_SEATS`.

`scripts/live-gate-jev-tree.mjs`: in `need` (`:101`) replace `"ROLE_LISTS"` with `"ROLE_NAMES", "JUDGE_SEATS", "roleSelectors", "tierHeadsOf"`, and add `"omp/model-tiers.js"` to the module list (`:94–96`). Replace `listSelectors` and the line at `:495`:
```js
/** Every key's own selectors on the copy's tier heads (spec 2026-11-02 §4.1): what resolution starts from. */
function keySelectors(g) {
  const heads = g.m.tierHeadsOf(g.store.listModelTiers());
  const sel = (role, seat) => g.m.roleSelectors(role, seat, "resolved", heads).map((s) => `${s.provider}/${s.model}${s.effort ? `:${s.effort}` : ""}`);
  return g.m.ROLE_NAMES.flatMap((role) => (role === "judges"
    ? Array.from({ length: g.m.JUDGE_SEATS }, (_, i) => ({ key: `judges:${i}`, list: sel(role, i) }))
    : [{ key: role, list: sel(role, undefined) }]));
}
function listSelectors(g) { return keySelectors(g).flatMap((k) => k.list.map((s) => ({ role: k.key, s: noEffort(s) }))); }
```
`:489` becomes `listSelectors(g)`; `:495` becomes `const list = keySelectors(g).find((k) => k.key === r.key)?.list ?? [];` and a key whose list is empty (`judges:2`) is reported INFO, not FAIL (`if (list.length === 0) { console.log(\`  INFO ${r.key}: tier empty (spec 2026-11-02 §4.4)\`); continue; }`).

- [ ] **Step 4: run, see pass** — `npx vitest run tests/omp/ tests/gateway/ tests/triggers/ && npm run typecheck && npm run build && node --check scripts/live-gate-jev-tree.mjs`. Mutations (each failing, reverted): a judge seat resolving `[adopted, previous]` (the "never join a judge seat" test fails); `readTiers` returning `seedTierHeads()` always (the "tier write" test fails); `legIds` returning `[previous, adopted]` (the "follow the adopted head" test fails).
- [ ] **Step 5: commit** — stage the files above by name → `refactor(omp): role legs resolve from model_tiers; ROLE_LISTS removed`.

---

### Task 4: The probe, the tier step, the reordered tick

**Files:**
- Create: `src/omp/model-probe.ts`, `src/omp/tier-step.ts`, `tests/omp/model-probe.test.ts`, `tests/omp/tier-step.test.ts`, `tests/omp/model-roles-tick-tiers.test.ts`
- Modify: `src/omp/model-roles-tick.ts` (whole file restructured: `runModelRolesTick` `:25–34`, `settle` `:37–45`, new helpers); `src/telegram/telegram-daemon.ts` `runRolesTick` (`:689–704`) — export a `modelRolesTickInput` builder and pass `probe`.
- Test (existing, must stay green): `tests/omp/model-roles-tick.test.ts`
- Protected: `src/omp/model-probe.ts`, `src/omp/tier-step.ts`, `src/omp/model-roles-tick.ts`

**Interfaces — Consumes:** Tasks 1–3. **Produces:**
```ts
// src/omp/model-probe.ts
export const PROBE_PROMPT = "Reply with exactly OK.";
export const PROBE_DEADLINE_MS = 60_000;
export interface ProbeOutcome { result: ModelProbeResult; kind: string }
export type ProbeFn = (selector: string, signal?: AbortSignal) => Promise<ProbeOutcome | "aborted">;
export function probeKindOf(error: string): string;
export function probeOutcomeOf(r: LlmResult): ProbeOutcome | "aborted";
export function ompProbe(store: RunStore, cfg: OmpConfig, opts?: { versionCheck?: OneShotAdapterOptions["versionCheck"] }): ProbeFn;
// src/omp/tier-step.ts
export const REJECT_PROBE_MS: number; // 7 days
export interface TierState { tier: TierId; adopted: string | null; previous: string | null; adopted_at: string | null; rejected_selector: string | null; rejected_at: string | null }
export interface TierProbe { id: string; selector: string; purpose: "head" | "previous" }
export interface TierPlan { before: TierState; state: TierState; probe: TierProbe | null }
export const selectorOf: (tier: TierId, id: string | null) => string | null;
export function planTier(before: TierState, catalog: readonly CatalogModel[], now: string): TierPlan;
export function applyProbe(p: TierPlan, o: ProbeOutcome | null, now: string): TierState;
// src/omp/model-roles-tick.ts
export interface ModelRolesTickInput { store; roles: Pick<RoleResolver, "refreshCatalog" | "resolveAll"> & Partial<Pick<RoleResolver, "catalog">>;
  probe?: ProbeFn; now: string; signal?: AbortSignal; notify: (text: string) => void }
export function failedLine(selector: string, stay: string | null): string;
export function shadowLine(key: string, head: string, pattern: string): string;
// src/telegram/telegram-daemon.ts
export function modelRolesTickInput(store: RunStore, roles: RoleResolver, now: string, notify: (t: string) => void, signal: AbortSignal): ModelRolesTickInput;
```

- [ ] **Step 1: failing tests.**

`tests/omp/model-probe.test.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ompProbe, probeKindOf, probeOutcomeOf, PROBE_PROMPT } from "../../src/omp/model-probe.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { RunStore } from "../../src/run/run-store.js";
import { useFakeOmp } from "../helpers/omp-env.js";

// Spec §4.2: the catalog is not the subscription. A model is adopted only after one short prompt answers through the same
// one-shot seat every tick seat uses; a model_missing answer is remembered for 7 days, anything else is retried. The kind
// must survive spawnOneShot's aggregate text (plan P6): if it degraded to "other", a retired model would never be rejected.
const dirs: string[] = []; const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "hpr-")); dirs.push(d); return d; };
const ok = () => ({ ok: true as const, version: "18.4.4" });

describe("probeKindOf / probeOutcomeOf", () => {
  it("reads the leg's kind from the aggregate text; falls back to classifyOmpError", () => {
    expect(probeKindOf("all probe legs failed — google-antigravity/gemini-3.1-pro: model_missing")).toBe("model_missing");
    expect(probeKindOf("all probe legs failed — kimi-code/k3.1-pro: quota")).toBe("quota");
    expect(probeKindOf("Model \"x/y\" not found")).toBe("model_missing");
    expect(probeKindOf("all probe legs failed — a/b: deadline")).toBe("other");
  });
  it("pass needs ok and a non-empty reply; abort is its own answer; an unavailable omp is inconclusive", () => {
    expect(probeOutcomeOf({ ok: true, provider: "p", model: "m", answer: " OK " })).toEqual({ result: "pass", kind: "ok" });
    expect(probeOutcomeOf({ ok: true, provider: "p", model: "m", answer: "  " })).toEqual({ result: "inconclusive", kind: "empty" });
    expect(probeOutcomeOf({ ok: false, provider: "omp", error: "aborted", aborted: true })).toBe("aborted");
    expect(probeOutcomeOf({ ok: false, provider: "omp", error: "x", unavailable: true })).toEqual({ result: "inconclusive", kind: "unavailable" });
  });
});

describe("ompProbe through the real one-shot seat (fake omp binary)", () => {
  it("a model omp refuses at start is model_missing; the leg is audited under role probe", async () => {
    useFakeOmp({ rpcBadModelAtStart: ["google-antigravity/gemini-3.1-pro"], "*": { text: "OK" } }, tmp());
    const store = RunStore.openInMemory();
    const probe = ompProbe(store, resolveOmpConfig(process.env), { versionCheck: ok });
    expect(await probe("google-antigravity/gemini-3.1-pro")).toEqual({ result: "model_missing", kind: "model_missing" });
    const roles = store.getLedgerEvents().filter((e) => e.event_type === "llm_attempt").map((e) => (e.payload as { role: string; error_kind?: string }));
    expect(roles.map((r) => [r.role, r.error_kind])).toEqual([["probe", "model_missing"]]);
    store.close();
  });
  it("a model that answers passes; the prompt is the fixed probe text", async () => {
    const d = tmp(); useFakeOmp({ "*": { text: "OK" } }, d);
    process.env.FAKE_OMP_ARGV_LOG = join(d, "argv.log");
    const store = RunStore.openInMemory();
    expect(await ompProbe(store, resolveOmpConfig(process.env), { versionCheck: ok })("kimi-code/k3.1-pro")).toEqual({ result: "pass", kind: "ok" });
    const { readFileSync } = await import("node:fs");
    const line = JSON.parse(readFileSync(join(d, "argv.log"), "utf8").trim().split("\n").at(-1)!) as { argv: string[]; stdin: string };
    expect(line.stdin).toBe(PROBE_PROMPT);
    expect(line.argv).toEqual(expect.arrayContaining(["--no-session", "--no-tools", "--model", "kimi-code/k3.1-pro"]));
    store.close();
  });
  it("a quota failure is inconclusive with its kind", async () => {
    useFakeOmp({ "*": { exit: 1, stderr: "429 usage limit reached" } }, tmp());
    const store = RunStore.openInMemory();
    expect(await ompProbe(store, resolveOmpConfig(process.env), { versionCheck: ok })("kimi-code/k3.1-pro")).toEqual({ result: "inconclusive", kind: "quota" });
    store.close();
  });
  it("a stop signal aborts the probe", async () => {
    useFakeOmp({ "*": { text: "OK", sleepMs: 5_000 } }, tmp());
    const store = RunStore.openInMemory(); const ac = new AbortController();
    const p = ompProbe(store, resolveOmpConfig(process.env), { versionCheck: ok })("kimi-code/k3.1-pro", ac.signal);
    setTimeout(() => ac.abort(), 200);
    expect(await p).toBe("aborted");
    store.close();
  });
});
```
(Check that the fake's `-p` mode honours `rpcBadModelAtStart`, `text`, `exit`/`stderr` and `sleepMs` and that `FAKE_OMP_ARGV_LOG` records `stdin` in `-p` mode — `tests/fixtures/fake-omp.mjs` header; if a field differs, use the fake's own name for it, never edit the fake's semantics.)

`tests/omp/tier-step.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import { applyProbe, planTier, REJECT_PROBE_MS, type TierState } from "../../src/omp/tier-step.js";

// Spec §4.1–§4.2: a retired head falls back to its already-probed previous at once (a retired judge costs at most a day);
// a newer head is adopted only through a probe; a rejected one is left alone for 7 days; one probe per tier per tick (P13).
const cat = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const NOW = "2026-11-02T09:00:00.000Z";
const st = (tier: TierState["tier"], adopted: string | null, previous: string | null = null, rej: [string, string] | null = null): TierState =>
  ({ tier, adopted, previous, adopted_at: adopted ? "2026-11-01T00:00:00.000Z" : null, rejected_selector: rej?.[0] ?? null, rejected_at: rej?.[1] ?? null });

describe("planTier", () => {
  it("a newer catalog head is probed as head", () => {
    expect(planTier(st("kimi", "k3"), cat(), NOW).probe).toEqual({ id: "k3.1-pro", selector: "kimi-code/k3.1-pro", purpose: "head" });
  });
  it("an adopted head with no previous probes the next-newest below it", () => {
    expect(planTier(st("codex-sol", "gpt-6.1-sol"), cat(), NOW).probe).toEqual({ id: "gpt-6-sol", selector: "openai-codex/gpt-6-sol", purpose: "previous" });
  });
  it("nothing to do: head adopted and previous live", () => {
    expect(planTier(st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"), cat(), NOW)).toEqual({ before: st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"), state: st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"), probe: null });
  });
  it("a retired adopted head moves to its previous with no probe (then fills the previous)", () => {
    const p = planTier(st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"), cat().filter((m) => m.id !== "gpt-6.1-sol"), NOW);
    expect(p.state).toEqual({ ...st("codex-sol", "gpt-6-sol"), adopted_at: NOW });
    expect(p.probe).toEqual({ id: "gpt-5.6-sol", selector: "openai-codex/gpt-5.6-sol", purpose: "previous" });
  });
  it("a retired head with no live previous empties the tier; an empty catalog family probes nothing", () => {
    const p = planTier(st("kimi", "k3"), cat().filter((m) => !(m.provider === "kimi-code" && /^k\d/.test(m.id))), NOW); // kimi-k2 etc. stay listed
    expect(p.state).toEqual(st("kimi", null));
    expect(p.probe).toBeNull();
    expect(planTier(st("gemini-pro", null), cat(), NOW).probe).toBeNull();
  });
  it("a read that lists nothing of the provider changes no tier and probes nothing (P13, partial read)", () => {
    const before = st("kimi", "k3.1-pro", "k3");
    expect(planTier(before, cat().filter((m) => m.provider !== "kimi-code"), NOW)).toEqual({ before, state: before, probe: null });
  });
  it("a head rejected less than 7 days ago is skipped; at 7 days it is probed again", () => {
    const at = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
    expect(planTier(st("kimi", "k3", null, ["kimi-code/k3.1-pro", at(REJECT_PROBE_MS - 1)]), cat(), NOW).probe).toBeNull();
    expect(planTier(st("kimi", "k3", null, ["kimi-code/k3.1-pro", at(REJECT_PROBE_MS)]), cat(), NOW).probe?.id).toBe("k3.1-pro");
  });
});

describe("applyProbe", () => {
  const head = planTier(st("kimi", "k3"), cat(), NOW);
  it("pass on a head adopts it and keeps the old head as previous", () => {
    expect(applyProbe(head, { result: "pass", kind: "ok" }, NOW)).toEqual({ ...st("kimi", "k3.1-pro", "k3"), adopted_at: NOW });
  });
  it("model_missing keeps the tier and records the rejection", () => {
    expect(applyProbe(head, { result: "model_missing", kind: "model_missing" }, NOW)).toEqual(st("kimi", "k3", null, ["kimi-code/k3.1-pro", NOW]));
  });
  it("inconclusive, or no probe run, changes nothing", () => {
    expect(applyProbe(head, { result: "inconclusive", kind: "quota" }, NOW)).toEqual(st("kimi", "k3"));
    expect(applyProbe(head, null, NOW)).toEqual(st("kimi", "k3"));
  });
  it("pass on a previous fills the previous only", () => {
    expect(applyProbe(planTier(st("codex-sol", "gpt-6.1-sol"), cat(), NOW), { result: "pass", kind: "ok" }, NOW)).toEqual(st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"));
  });
});
```

`tests/omp/model-roles-tick-tiers.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import type { ProbeFn, ProbeOutcome } from "../../src/omp/model-probe.js";
import { changeLine, failedLine, runModelRolesTick, shadowLine } from "../../src/omp/model-roles-tick.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.2 tick order and §8 "Probe" + "Retirement": probes run outside the transaction, one at a time; their effects land
// in one transaction with the resolution; a stop mid-probe commits nothing. Every effect is asserted as exact rows (P4).
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const FIX = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();
const PASS: ProbeOutcome = { result: "pass", kind: "ok" };
let catalog: () => CatalogModel[] | null = FIX;
const roles = () => new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog() });
function probeBy(answer: (sel: string) => ProbeOutcome | "aborted", calls: string[] = []): ProbeFn {
  return async (sel) => { calls.push(sel); return answer(sel); };
}
const tiers = () => Object.fromEntries(store.listModelTiers().map((r) => [r.tier, [r.adopted, r.previous, r.rejected_selector]]));
const probes = () => store.getLedgerEvents().filter((e) => e.event_type === "model_probe").map((e) => e.payload);
const resolvedRows = () => store.getLedgerEvents().filter((e) => e.event_type === "model_roles_resolved");
async function tick(r: RoleResolver, probe: ProbeFn | undefined, now: string, notes: string[] = [], signal?: AbortSignal) {
  return runModelRolesTick({ store, roles: r, ...(probe ? { probe } : {}), now, notify: (t) => notes.push(t), ...(signal ? { signal } : {}) });
}
const FIRST_CALLS = ["openai-codex/gpt-6-sol", "google-antigravity/gemini-2.5-flash", "kimi-code/k3.1-pro", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5"];
beforeEach(() => { catalog = FIX; });

describe("the first tick over the 2026-11-02 catalog", () => {
  it("probes each moved head and each missing previous, once, in tier order; passes adopt; one event per probe", async () => {
    const calls: string[] = []; const r = roles();
    expect((await tick(r, probeBy(() => PASS, calls), day(0))).ran).toBe(true);
    expect(calls).toEqual(FIRST_CALLS);
    expect(tiers()).toEqual({
      "codex-sol": ["gpt-6.1-sol", "gpt-6-sol", null], "gemini-flash": ["gemini-3.8-flash", "gemini-2.5-flash", null], "gemini-pro": [null, null, null],
      kimi: ["k3.1-pro", "k3", null], "opus@anthropic": ["claude-opus-5-5", "claude-opus-5", null], "opus@antigravity": ["claude-opus-5-5", null, null],
      "sonnet@anthropic": ["claude-sonnet-5-5", "claude-sonnet-5", null], "sonnet@antigravity": ["claude-sonnet-5-5", null, null]
    });
    expect(probes()).toEqual([
      { tier: "codex-sol", selector: "openai-codex/gpt-6-sol", purpose: "previous", result: "pass", kind: "ok" },
      { tier: "gemini-flash", selector: "google-antigravity/gemini-2.5-flash", purpose: "previous", result: "pass", kind: "ok" },
      { tier: "kimi", selector: "kimi-code/k3.1-pro", purpose: "head", result: "pass", kind: "ok" },
      { tier: "opus@anthropic", selector: "anthropic/claude-opus-5", purpose: "previous", result: "pass", kind: "ok" },
      { tier: "sonnet@anthropic", selector: "anthropic/claude-sonnet-5", purpose: "previous", result: "pass", kind: "ok" }
    ]);
  });
  it("with a baseline, the notice names exactly the keys whose head moved (Kimi's adoption)", async () => {
    const r = roles(); const notes: string[] = [];
    await tick(r, undefined, day(0));                       // baseline, no probe (P26)
    await tick(r, probeBy(() => PASS), day(1), notes);
    const [before, after] = resolvedRows().map((e) => new Map((e.payload as { roles: Array<{ key: string; head: string | null }> }).roles.map((x) => [x.key, x.head])));
    const moved = [...after!.keys()].filter((k) => before!.get(k) !== after!.get(k));
    expect(moved).toEqual(["tiny", "judges:0", "reviewer"]);
    expect(notes).toEqual(moved.map((k) => changeLine(k, before!.get(k) ?? null, after!.get(k) ?? null)));
  });
});

describe("probe outcomes", () => {
  it("model_missing keeps the tier, names it once, and is not probed again for 7 days", async () => {
    const r = roles(); const notes: string[] = []; const calls: string[] = [];
    const answer = (sel: string): ProbeOutcome => (sel === "kimi-code/k3.1-pro" ? { result: "model_missing", kind: "model_missing" } : PASS);
    await tick(r, probeBy(answer, calls), day(0), notes);
    expect(tiers().kimi).toEqual(["k3", null, "kimi-code/k3.1-pro"]);
    expect(notes).toEqual([failedLine("kimi-code/k3.1-pro", "kimi-code/k3")]);
    calls.length = 0;
    await tick(r, probeBy(answer, calls), day(1));
    expect(calls).not.toContain("kimi-code/k3.1-pro");
    await tick(r, probeBy(answer, calls), day(7));
    expect(calls.filter((c) => c === "kimi-code/k3.1-pro")).toHaveLength(1);
  });
  it("inconclusive keeps the tier silently and retries the next day", async () => {
    const r = roles(); const notes: string[] = []; const calls: string[] = [];
    const answer = (sel: string): ProbeOutcome => (sel === "kimi-code/k3.1-pro" ? { result: "inconclusive", kind: "quota" } : PASS);
    await tick(r, probeBy(answer, calls), day(0), notes);
    expect(tiers().kimi).toEqual(["k3", null, null]);
    expect(notes).toEqual([]);
    calls.length = 0;
    await tick(r, probeBy(answer, calls), day(1));
    expect(calls).toContain("kimi-code/k3.1-pro");
  });
  it("a catalog outage probes nothing and changes no tier", async () => {
    catalog = () => null; const calls: string[] = []; const before = store.listModelTiers();
    await tick(roles(), probeBy(() => PASS, calls), day(0));
    expect(calls).toEqual([]);
    expect(store.listModelTiers()).toEqual(before);
  });
  it("a stop mid-probe commits nothing: no probe event, no tier write, no resolution row", async () => {
    const ac = new AbortController(); let n = 0; const before = store.listModelTiers();
    const probe: ProbeFn = async () => { if (++n === 2) { ac.abort(); return "aborted"; } return PASS; };
    expect(await tick(roles(), probe, day(0), [], ac.signal)).toEqual({ ran: false, changed: [], unresolved: [] });
    expect([probes(), store.listModelTiers(), resolvedRows()]).toEqual([[], before, []]);
  });
});

describe("retirement (the regression this slice exists for)", () => {
  it("an adopted judge head leaving the catalog moves the seat to its previous head in one tick", async () => {
    const r = roles();
    store.writeModelTier({ tier: "codex-sol", adopted: "gpt-6.1-sol", previous: "gpt-6-sol", adopted_at: day(-1), rejected_selector: null, rejected_at: null }, day(-1));
    catalog = () => FIX().filter((m) => m.id !== "gpt-6.1-sol");
    const res = await tick(r, probeBy(() => PASS), day(0));
    expect(r.resolveAll().find((x) => x.key === "judges:1")?.head).toBe("openai-codex/gpt-6-sol");
    expect(res.unresolved).toEqual(["judges:2"]);
    expect(tiers()["codex-sol"]).toEqual(["gpt-6-sol", "gpt-5.6-sol", null]);
  });
  it("a seat with no previous head opens role_unresolved", async () => {
    const r = roles();
    catalog = () => FIX().filter((m) => !(m.provider === "kimi-code" && /^k\d/.test(m.id))); // the tier's family gone, the provider still listed
    const res = await tick(r, probeBy(() => PASS), day(0));
    expect(res.unresolved).toEqual(["judges:0", "judges:2"]);
    expect(store.listOpenIncidents().filter((i) => i.kind === "role_unresolved").map((i) => i.subject)).toEqual(["judges:0", "judges:2"]);
  });
});

describe("a partial read (P13, review W1)", () => {
  it("a provider missing from one read changes no tier, probes nothing for it, and recovers with no probe", async () => {
    const r = roles(); const calls: string[] = [];
    await tick(r, probeBy(() => PASS), day(0));                    // kimi adopts k3.1-pro, previous k3
    const kimiBefore = store.getModelTier("kimi");
    catalog = () => FIX().filter((m) => m.provider !== "kimi-code");
    await tick(r, probeBy(() => PASS, calls), day(1));
    expect(store.getModelTier("kimi")).toEqual(kimiBefore);        // unchanged row, updated_at included (writeTiers skips an unchanged tier)
    expect(calls.filter((c) => c.startsWith("kimi-code/"))).toEqual([]);
    catalog = FIX; calls.length = 0;
    await tick(r, probeBy(() => PASS, calls), day(2));
    expect(r.resolveAll().find((x) => x.key === "judges:0")?.head).toBe("kimi-code/k3.1-pro");
    expect(calls.filter((c) => c.startsWith("kimi-code/"))).toEqual([]);
  });
});

describe("a shadowing override", () => {
  it("is named when its tier's head moves", async () => {
    const r = roles(); const notes: string[] = [];
    await tick(r, undefined, day(0));
    store.recordModelRoleOverride({ key: "judges:0", pattern: "k3", actor: "paco" });
    await tick(r, probeBy(() => PASS), day(1), notes);
    const [before, after] = resolvedRows().map((e) => new Map((e.payload as { roles: Array<{ key: string; head: string | null }> }).roles.map((x) => [x.key, x.head])));
    const moved = [...after!.keys()].filter((k) => before!.get(k) !== after!.get(k));
    expect(notes).toEqual([...moved.map((k) => changeLine(k, before!.get(k) ?? null, after!.get(k) ?? null)), shadowLine("judges:0", "kimi-code/k3.1-pro", "k3")]);
    expect(shadowLine("judges:0", "kimi-code/k3.1-pro", "k3")).toBe("ℹ️ Tier head `kimi-code/k3.1-pro` is available; your override `k3` is in place (/models reset judges 0).");
    expect(failedLine("kimi-code/k3.1-pro", null)).toBe("⚠️ `kimi-code/k3.1-pro` failed its check; staying on nothing.");
  });
});
```
(If `role_unresolved` subjects come out in another order, the order is `listOpenIncidents`' `first_seen_at, incident_id` — compare sorted, and say so in the test.)

- [ ] **Step 2: run, see fail** — `npx vitest run tests/omp/model-probe.test.ts tests/omp/tier-step.test.ts tests/omp/model-roles-tick-tiers.test.ts` → modules missing.

- [ ] **Step 3: implement.**

`src/omp/model-probe.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { LlmErrorKind } from "../llm/audit.js";
import { oneShotAdapter, type OneShotAdapterOptions } from "../llm/registry.js";
import type { LlmResult } from "../llm/types.js";
import type { ModelProbeResult, RunStore } from "../run/run-store.js";
import { parseModelString } from "./model-string.js";
import type { OmpConfig } from "./omp-config.js";
import { classifyOmpError } from "./omp-frames.js";

/**
 * The check before a tier adopts a model (spec 2026-11-02 §4.2): one short prompt through the existing one-shot seat
 * (src/llm/providers/omp.ts, unchanged): one leg, --no-session --no-tools, the tick seats' child env and TMPDIR, 60 s.
 * Pass = ok and a non-empty reply (no exact match, as the contract probe). The reply is never stored or logged.
 */
export const PROBE_PROMPT = "Reply with exactly OK.";
export const PROBE_DEADLINE_MS = 60_000;
export interface ProbeOutcome { result: ModelProbeResult; kind: string }
export type ProbeFn = (selector: string, signal?: AbortSignal) => Promise<ProbeOutcome | "aborted">;

const KINDS: ReadonlySet<string> = new Set<LlmErrorKind>(["auth", "model_missing", "timeout", "spawn", "transport", "parse", "other", "quota",
  "model_refusal", "aborted", "wall_collapse", "shutdown", "rate_limited", "overloaded", "malformed_question"]);

/** Plan P6: spawnOneShot ends its failure text with `<provider/id>: <kind>` (omp.ts:164,167); else classify the text. */
export function probeKindOf(error: string): string {
  const m = /: ([a-z_]+)$/.exec(error);
  return m && KINDS.has(m[1]!) ? m[1]! : classifyOmpError(error);
}

export function probeOutcomeOf(r: LlmResult): ProbeOutcome | "aborted" {
  if (r.ok) return r.answer.trim().length > 0 ? { result: "pass", kind: "ok" } : { result: "inconclusive", kind: "empty" };
  if (r.aborted) return "aborted";
  if (r.unavailable) return { result: "inconclusive", kind: "unavailable" };
  const kind = probeKindOf(r.error);
  return { result: kind === "model_missing" ? "model_missing" : "inconclusive", kind };
}

/** The daemon's probe (plan P7): audited per leg under `probe:<uuid>`, role `probe`. `opts.versionCheck`: tests only. */
export function ompProbe(store: RunStore, cfg: OmpConfig, opts: { versionCheck?: OneShotAdapterOptions["versionCheck"] } = {}): ProbeFn {
  return async (selector, signal) => {
    const seat = oneShotAdapter(store, cfg, { correlation_id: `probe:${randomUUID()}`, role: "probe" }, undefined,
      { chain: [parseModelString(selector)], deadlineMs: PROBE_DEADLINE_MS, ...(opts.versionCheck ? { versionCheck: opts.versionCheck } : {}) });
    try {
      return probeOutcomeOf(await seat.answer({ question: PROBE_PROMPT, ...(signal ? { signal } : {}) }));
    } catch (e) {
      console.error(`[model-probe] probe threw: ${e instanceof Error ? e.name : "non-Error"}`);
      return { result: "inconclusive", kind: "threw" };
    }
  };
}
```
(`LlmRequest` carries `signal` — `src/llm/types.ts:10`; confirm the field name and use it.)

`src/omp/tier-step.ts`:
```ts
import type { ProbeOutcome } from "./model-probe.js";
import type { CatalogModel } from "./model-roles.js";
import { tierDef, tierMembers, type TierId } from "./model-tiers.js";

/** Spec §4.2: a model_missing selector is not probed again for 7 days. */
export const REJECT_PROBE_MS = 7 * 24 * 60 * 60_000;
export interface TierState { tier: TierId; adopted: string | null; previous: string | null; adopted_at: string | null; rejected_selector: string | null; rejected_at: string | null }
export interface TierProbe { id: string; selector: string; purpose: "head" | "previous" }
export interface TierPlan { before: TierState; state: TierState; probe: TierProbe | null }

export const selectorOf = (tier: TierId, id: string | null): string | null => (id === null ? null : `${tierDef(tier).provider}/${id}`);

/** Step 2 of the tick (plan P13): follow a retirement, then pick at most one probe. Pure. */
export function planTier(before: TierState, catalog: readonly CatalogModel[], now: string): TierPlan {
  const def = tierDef(before.tier);
  // P13 (review W1): a read that lists nothing of the tier's provider is partial for this tier, not a retirement
  if (!catalog.some((m) => m.provider === def.provider)) return { before, state: before, probe: null };
  const members = tierMembers(def, catalog);
  const state = followRetirement(before, members, now);
  return { before, state, probe: probeFor(state, members, Date.parse(now)) };
}

/** Spec §4.1: an adopted head gone from the catalog moves the tier to its previous head (already probed); none → empty. */
function followRetirement(s: TierState, members: readonly string[], now: string): TierState {
  const live = (id: string | null): id is string => id !== null && members.includes(id);
  if (live(s.adopted)) return live(s.previous) || s.previous === null ? s : { ...s, previous: null };
  if (live(s.previous)) return { ...s, adopted: s.previous, previous: null, adopted_at: now };
  return s.adopted === null && s.previous === null ? s : { ...s, adopted: null, previous: null, adopted_at: null };
}

function probeFor(s: TierState, members: readonly string[], nowMs: number): TierProbe | null {
  const rejected = (id: string) => s.rejected_selector === selectorOf(s.tier, id) && s.rejected_at !== null && nowMs - Date.parse(s.rejected_at) < REJECT_PROBE_MS;
  const pick = (id: string, purpose: TierProbe["purpose"]): TierProbe => ({ id, selector: selectorOf(s.tier, id)!, purpose });
  const head = members[0];
  if (head !== undefined && head !== s.adopted && !rejected(head)) return pick(head, "head");
  if (s.adopted === null || s.previous !== null) return null;
  const below = members.slice(members.indexOf(s.adopted) + 1).find((id) => !rejected(id));
  return below === undefined ? null : pick(below, "previous");
}

/** Step 4: the tier after its probe (null = not run). Inconclusive changes nothing; model_missing remembers the selector. */
export function applyProbe(p: TierPlan, o: ProbeOutcome | null, now: string): TierState {
  const s = p.state;
  if (!p.probe || !o || o.result === "inconclusive") return s;
  if (o.result === "model_missing") return { ...s, rejected_selector: p.probe.selector, rejected_at: now };
  if (p.probe.purpose === "previous") return { ...s, previous: p.probe.id };
  return { ...s, adopted: p.probe.id, previous: s.adopted ?? s.previous, adopted_at: now };
}
```
(`followRetirement`'s first line keeps `s` identical — `toEqual` in "nothing to do" — when nothing moved.)

`src/omp/model-roles-tick.ts` — keep `MODEL_ROLES_TICK_INTERVAL_MS`, `ROLE_UNRESOLVED`, `ModelRolesTickResult`, `IDLE`, `jsonSafe`, `changedRoles`, `shown`, `changeLine`, `syncUnresolved`; replace the rest:
```ts
import { escapeForTelegram } from "../capabilities/text-hygiene.js";
import type { ProbeFn, ProbeOutcome } from "./model-probe.js";
import { keysOfTier, resolveModelRolesMode, type CatalogModel } from "./model-roles.js";
import { isTierId, type TierId } from "./model-tiers.js";
import { applyProbe, planTier, selectorOf, type TierPlan, type TierState } from "./tier-step.js";

export interface ModelRolesTickInput {
  store: RunStore;
  /** `catalog` absent → no tier work (plan P26). */
  roles: Pick<RoleResolver, "refreshCatalog" | "resolveAll"> & Partial<Pick<RoleResolver, "catalog">>;
  /** Spec §4.2: the one-shot probe (the daemon passes ompProbe). Absent → no probe runs; retirements still follow (P26). */
  probe?: ProbeFn;
  now: string;
  signal?: AbortSignal;
  notify: (text: string) => void;
}

/**
 * Spec 2026-11-02 §4.2: read the catalog, plan each tier, probe outside any transaction (one at a time), then commit the
 * probe events, the tiers, the resolution, the notice and the incidents in one transaction. A stop during the read or a
 * probe commits nothing; the next boot's tick runs the whole unit. A catalog outage changes nothing (Decision 4).
 */
export async function runModelRolesTick(i: ModelRolesTickInput): Promise<ModelRolesTickResult> {
  if (resolveModelRolesMode(process.env) === "static" || i.signal?.aborted) return { ...IDLE };
  const last = i.store.latestModelRolesResolved();
  if (last && Date.parse(i.now) - Date.parse(last.resolved_at) < MODEL_ROLES_TICK_INTERVAL_MS) return { ...IDLE };
  const catalogOk = await i.roles.refreshCatalog();
  if (i.signal?.aborted) return { ...IDLE };
  const catalog = catalogOk ? i.roles.catalog?.() ?? null : null;
  const plans = catalog ? planAll(i.store, catalog, i.now) : [];
  const outcomes = await runProbes(plans, i.probe, i.signal);
  if (outcomes === "aborted" || i.signal?.aborted) return { ...IDLE };
  return i.store.inTransaction(() => settle(i, catalogOk, plans, outcomes));
}

function planAll(store: RunStore, catalog: readonly CatalogModel[], now: string): TierPlan[] {
  return store.listModelTiers().flatMap((r) => (isTierId(r.tier)
    ? [planTier({ tier: r.tier, adopted: r.adopted, previous: r.previous, adopted_at: r.adopted_at, rejected_selector: r.rejected_selector, rejected_at: r.rejected_at }, catalog, now)]
    : []));
}

async function runProbes(plans: readonly TierPlan[], probe: ProbeFn | undefined, signal?: AbortSignal): Promise<Array<ProbeOutcome | null> | "aborted"> {
  const out: Array<ProbeOutcome | null> = [];
  for (const p of plans) {
    if (!p.probe || !probe) { out.push(null); continue; }
    if (signal?.aborted) return "aborted";
    const o = await probe(p.probe.selector, signal);
    if (o === "aborted") return "aborted";
    out.push(o);
  }
  return out;
}

/** One transaction (spec §4.2 step 4): a notice is never lost after its row, nor sent without it. */
function settle(i: ModelRolesTickInput, catalogOk: boolean, plans: readonly TierPlan[], outcomes: ReadonlyArray<ProbeOutcome | null>): ModelRolesTickResult {
  const baseline = catalogOk ? i.store.latestModelRolesResolved({ catalogOk: true }) : undefined;
  const written = writeTiers(i, plans, outcomes);
  const roles = i.roles.resolveAll();
  i.store.recordModelRolesResolved({ resolved_at: i.now, catalog_ok: catalogOk, roles: roles.map(jsonSafe) });
  if (!catalogOk) return { ran: true, changed: [], unresolved: [] };
  const changed = baseline ? changedRoles(baseline.roles, roles) : [];
  for (const c of changed) i.notify(changeLine(c.key, c.from, c.to));
  for (const f of written.failed) i.notify(failedLine(f.selector, f.stay));
  for (const line of shadowLines(i.store, roles, written.moved)) i.notify(line);
  return { ran: true, changed: changed.map((c) => c.key), unresolved: syncUnresolved(i.store, roles, i.now) };
}

interface Written { failed: Array<{ selector: string; stay: string | null }>; moved: Array<{ tier: TierId; head: string }> }

function writeTiers(i: ModelRolesTickInput, plans: readonly TierPlan[], outcomes: ReadonlyArray<ProbeOutcome | null>): Written {
  const w: Written = { failed: [], moved: [] };
  plans.forEach((p, n) => {
    const o = outcomes[n] ?? null;
    if (p.probe && o) i.store.recordModelProbe({ tier: p.state.tier, selector: p.probe.selector, purpose: p.probe.purpose, result: o.result, kind: o.kind });
    const next = applyProbe(p, o, i.now);
    if (!sameTier(next, p.before)) i.store.writeModelTier(next, i.now); // review suggestion: an unchanged tier keeps its row and updated_at
    if (p.probe && o?.result === "model_missing") w.failed.push({ selector: p.probe.selector, stay: selectorOf(next.tier, next.adopted) });
    if (next.adopted !== null && next.adopted !== p.before.adopted) w.moved.push({ tier: next.tier, head: selectorOf(next.tier, next.adopted)! });
  });
  return w;
}

const sameTier = (a: TierState, b: TierState): boolean => a.adopted === b.adopted && a.previous === b.previous && a.adopted_at === b.adopted_at
  && a.rejected_selector === b.rejected_selector && a.rejected_at === b.rejected_at;

/** Spec §4.2: a moved tier head that an override on one of its keys shadows. */
function shadowLines(store: RunStore, roles: ResolvedRole[], moved: Written["moved"]): string[] {
  const overrides = store.latestModelRoleOverrides();
  return moved.flatMap((m) => keysOfTier(m.tier).flatMap((key) => {
    const pattern = overrides.get(key);
    return pattern && roles.find((r) => r.key === key)?.source === "override" ? [shadowLine(key, m.head, pattern)] : [];
  }));
}

/** "X failed its check; staying on Y" (spec §4.2); selectors are code-owned catalog strings. */
export function failedLine(selector: string, stay: string | null): string {
  return `⚠️ \`${selector}\` failed its check; staying on ${shown(stay)}.`;
}

/** Spec §4.2; Paco's own pattern is rendered markdown-inert, as /models does. */
export function shadowLine(key: string, head: string, pattern: string): string {
  return `ℹ️ Tier head \`${head}\` is available; your override \`${escapeForTelegram(pattern)}\` is in place (/models reset ${key.replace(":", " ")}).`;
}
```
(`latestModelRoleOverrides()` returns only live overrides — a reset row removes the key; confirm at its definition and filter `pattern !== ""` if it does not.)

`src/telegram/telegram-daemon.ts`: import `ompProbe` from `../omp/model-probe.js`, `resolveOmpConfig` (already imported? check) and `type ModelRolesTickInput`; add
```ts
/** The roles tick's input (plan P26: the daemon always passes the probe and the resolver's catalog). Exported for the wiring test. */
export function modelRolesTickInput(store: RunStore, roles: RoleResolver, now: string, notify: (text: string) => void, signal: AbortSignal): ModelRolesTickInput {
  return { store, roles, probe: ompProbe(store, resolveOmpConfig(process.env)), now, signal, notify };
}
```
and in `runRolesTick` call `await runModelRolesTick(modelRolesTickInput(options.store, worker.modelRoles(), now, notify, signal));`. Wiring test (add to `tests/omp/model-roles-tick-tiers.test.ts`): `modelRolesTickInput(store, roles(), day(0), () => {}, new AbortController().signal)` has `typeof probe === "function"` and `typeof roles.catalog === "function"`.

- [ ] **Step 4: run, see pass** — `npx vitest run tests/omp/ tests/telegram/ && npm run typecheck`. Mutations (each failing, reverted): `probeKindOf` returning `classifyOmpError(error)` always (the fake-omp model_missing test fails — this is P6's catcher); `applyProbe` adopting on `inconclusive` (inconclusive test); write the tiers before the probes inside a transaction around the awaits (move `inTransaction` to wrap `runProbes`: the stop test or typecheck fails — record which); drop the `rejected` check (7-day test).
- [ ] **Step 5: commit** — `feat(omp): probe before adoption — tier step, reordered daily tick, rejection memory, notice lines`.

---
### Task 5: Static re-pin (D4-A) and the `static_list_stale` check

**Files:**
- Modify: `src/omp/model-roles.ts` — `STATIC_ROLE_LISTS` (`:43–55`); new `staticSelectorKeys()`.
- Modify: `src/omp/model-roles-tick.ts` — `settle` gains `catalog` and calls `syncStaticStale`.
- Modify tests: `tests/omp/model-roles.test.ts` (static cases `:30–40`, `:120–125`), `tests/omp/role-resolver.test.ts` (`:179–181`: seats → `["google-antigravity/claude-opus-4-6", "openai-codex/gpt-6.1-sol", null]`, notes unchanged from Task 3; any literal static string), `tests/omp/omp-config.test.ts:16–25` (static planner → `["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-5-5", "kimi-code/k3"]`, test name "Opus 5.5 then Opus 5.5 via Antigravity then k3"; reader last leg → `gpt-6.1-sol`), `tests/capabilities/idea-panel-seats.test.ts:35–45` (static seat 2 is empty: the gemini seat answers `{ ok: false }` with **no** spawn — `spawns()` models exactly `[want("kimi"), want("codex")]`, `rows("judge")` length 2, and `want` defined only for those two), `tests/capabilities/panel-judge-providers.test.ts:20–32` (static: seats 0 and 1 have one model, seat 2 none; the three-families test moves to a resolved cfg — a `RoleResolver` over the 2026-11-02 fixture with the override `judges:2 = gemini-4-argon`, as after Paco's tap — and still asserts three families).
- Test (new): `tests/omp/static-lists.test.ts`
- Protected: `src/omp/model-roles.ts`, `src/omp/model-roles-tick.ts`

**Interfaces — Produces:** `export function staticSelectorKeys(): string[]` (distinct `provider/id` over every static list, list order); `STATIC_ROLE_LISTS.judges` has 2 entries (P12).

- [ ] **Step 1: failing tests** — `tests/omp/static-lists.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { judgeSeat } from "../../src/llm/registry.js";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import { ROLE_LEGS, ROLE_NAMES, STATIC_ROLE_LISTS, staticRoleChains, staticSelectorKeys, type CatalogModel, type RoleName } from "../../src/omp/model-roles.js";
import { runModelRolesTick } from "../../src/omp/model-roles-tick.js";
import { formatModelString, parseModelString } from "../../src/omp/model-string.js";
import { tierDef, tierVersion } from "../../src/omp/model-tiers.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.3 (D4-A): HOUGE_MODEL_ROLES=static is the rollback; it is catalog-free, so it rots silently. Re-pinned at this ship
// (judge seat 2 empty: pinning a codename would adopt it without Paco's tap), and checked daily in resolved mode so Paco
// learns the rollback is stale before he needs it.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const FIX = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const f = (l: Array<{ provider: string; model: string }>) => l.map((m) => formatModelString(m as never)).join(",");
/** Static Fast and Thinking run the Default list by design (no model added in a rollback), so they are checked against Default's tiers. */
const tierRole = (r: RoleName): RoleName => (r === "fast" || r === "thinking" ? "default" : r);
const stale = () => store.listOpenIncidents().filter((i) => i.kind === "static_list_stale").map((i) => i.subject).sort();

describe("the re-pinned static lists", () => {
  it("are the seeded heads, seat for seat; judge seat 2 has none", () => {
    const c = staticRoleChains();
    expect(f(c.planner)).toBe("anthropic/claude-opus-5-5:medium,google-antigravity/claude-opus-5-5:medium,kimi-code/k3:low");
    expect(f(c.reader)).toBe("google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low,openai-codex/gpt-6.1-sol:low");
    expect(f(c.media)).toBe("google-antigravity/gemini-3.8-flash:low");
    expect(f(c.ticks)).toBe("kimi-code/k3:low");
    expect(f(c.judges)).toBe("kimi-code/k3,openai-codex/gpt-6.1-sol");
    expect(f(c.chair)).toBe("anthropic/claude-opus-5-5:low");
    expect(f(c.reviewer)).toBe("kimi-code/k3:high,google-antigravity/claude-opus-5-5:medium");
    expect(judgeSeat(resolveOmpConfig({}, c), 2)).toEqual([]);
  });
  it("every static selector is a member of its role's tiers (judges: its seat's tier)", () => {
    for (const role of ROLE_NAMES) {
      STATIC_ROLE_LISTS[role].forEach((s, i) => {
        const m = parseModelString(s);
        const legs = role === "judges" ? [ROLE_LEGS.judges[i]!] : ROLE_LEGS[tierRole(role)];
        expect(legs.some((l) => tierDef(l.tier).provider === m.provider && tierVersion(tierDef(l.tier), m.model) !== null), `${role} ${s}`).toBe(true);
      });
    }
  });
  it("in resolved mode an empty judge seat runs no model: seat 2 fails alone", async () => {
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => FIX() });
    await roles.refreshCatalog();
    expect(roles.chains().judges[2]).toBeUndefined();
    expect(judgeSeat(resolveOmpConfig({}, roles.chains()), 2)).toEqual([]);
    expect(judgeSeat(resolveOmpConfig({}, roles.chains()), 1).map(formatModelString)).toEqual(["openai-codex/gpt-6.1-sol"]);
  });
});

describe("static_list_stale (resolved mode only)", () => {
  const T0 = Date.parse("2026-11-02T09:00:00.000Z");
  const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();
  let catalog: () => CatalogModel[] = FIX;
  const tick = (now: string) => runModelRolesTick({ store, roles: new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog() }), now, notify: () => {} });
  it("opens one incident per uncatalogued static selector, resolves it when the selector returns, and on a re-pin", async () => {
    expect(staticSelectorKeys()).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-5-5", "kimi-code/k3",
      "google-antigravity/gemini-3.8-flash", "openai-codex/gpt-6.1-sol"]);
    catalog = () => FIX().filter((m) => m.id !== "k3");
    await tick(day(0));
    expect(stale()).toEqual(["kimi-code/k3"]);
    store.openIncident({ kind: "static_list_stale", subject: "openai-codex/gpt-5.5", detail: {}, now: day(0) }); // a pre-re-pin row
    catalog = FIX;
    await tick(day(1));
    expect(stale()).toEqual([]);
  });
  it("does not run in static mode (no tick at all) nor on a catalog outage", async () => {
    catalog = () => [] as CatalogModel[]; // parse → null → outage
    await tick(day(0));
    expect(stale()).toEqual([]);
  });
});
```
(`readCatalog` returning `[]` is a failed read — `role-resolver.ts:122`.) Update `tests/omp/model-roles.test.ts`'s static string pins to the strings above (the "static chains are today's seven defaults" test becomes "the re-pinned static chains"; its comment cites spec 2026-11-02 §4.3), and its static `resolved({ role: "judges", seat: 1, mode: "static" })` to `["openai-codex/gpt-6.1-sol"]`, the reader case's comment ("the fixture has no gpt-5.5") removed.

- [ ] **Step 2: run, see fail.**

- [ ] **Step 3: implement.** `model-roles.ts`:
```ts
/**
 * The lists `static` mode runs (spec 2026-11-02 §4.3, D4-A: the rollback switch): re-pinned at this ship to the seeded tier
 * heads, gpt-5.5 → gpt-6.1-sol. Static adds no model: Fast and Thinking are the Default list. Judge seat 2 has no static
 * selector: pinning gemini-4-argon would adopt a codename without Paco's tap; a code re-pin fills it after the tap. A
 * resolved role that comes up empty also falls back here (RoleResolver). The daily tick (resolved mode) reports any
 * selector here the catalog no longer lists as static_list_stale.
 */
export const STATIC_ROLE_LISTS: Readonly<Record<RoleName, readonly string[]>> = (() => {
  const planner = ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "kimi-code/k3:low"];
  return {
    fast: planner, default: planner, thinking: planner,
    reader: ["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6.1-sol:low"],
    vision: ["google-antigravity/gemini-3.8-flash:low"],
    tiny: ["kimi-code/k3:low"],
    judges: ["kimi-code/k3", "openai-codex/gpt-6.1-sol"],
    chair: ["anthropic/claude-opus-5-5:low"],
    reviewer: ["kimi-code/k3:high", "google-antigravity/claude-opus-5-5:medium"]
  };
})();

/** Every distinct provider/id in the static lists, in list order (the stale check's subjects). */
export function staticSelectorKeys(): string[] {
  return [...new Set(ROLE_NAMES.flatMap((r) => STATIC_ROLE_LISTS[r].map((s) => selectorKey(parseModelString(s)))))];
}
```
`model-roles-tick.ts`: `settle(i, catalogOk, catalog, plans, outcomes)` (pass `catalog` from `runModelRolesTick`); after `syncUnresolved`, `if (catalog) syncStaticStale(i.store, catalog, i.now);`:
```ts
const STATIC_STALE: ReadonlySet<string> = new Set(["static_list_stale"]);

/** Spec §4.3 (D4-A) and plan P28: one alerted incident per static selector the catalog no longer lists; resolved on return or re-pin. */
function syncStaticStale(store: RunStore, catalog: readonly CatalogModel[], now: string): void {
  const listed = new Set(catalog.map((c) => `${c.provider}/${c.id}`));
  const pinned = staticSelectorKeys();
  for (const s of pinned) {
    if (listed.has(s)) resolveOpenIncidents(store, STATIC_STALE, s, now);
    else openAlertedIncident(store, { kind: "static_list_stale", subject: s, detail: { selector: s }, now });
  }
  for (const open of store.listOpenIncidents()) if (open.kind === "static_list_stale" && !pinned.includes(open.subject)) store.resolveIncident(open.incident_id, now);
}
```

- [ ] **Step 4: run, see pass** — `npx vitest run tests/omp/ tests/llm/ tests/capabilities/ && npm run typecheck`. Mutations: put `"google-antigravity/gemini-4-argon"` back at static judge seat 2 (seat test fails); drop the re-pin loop (the `gpt-5.5` row stays open, test fails); run `syncStaticStale` before the `catalogOk` return with an empty catalog (outage test fails).
- [ ] **Step 5: commit** — `feat(omp): static lists re-pinned to the seeded heads; static_list_stale checked daily in resolved mode`.

---

### Task 6: The empty-tier card and its tap

**Files:**
- Modify: `src/omp/model-roles.ts` (new `soleKeysOf`), `src/omp/model-roles-tick.ts` (`card?` input, `EmptyTierCard`, the card step in `settle`).
- Create: `src/gateway/model-tier-commands.ts`, `tests/gateway/model-tier-commands.test.ts`
- Modify: `src/domain/types.ts:4` (`TaskEventType` += `"model_tier_tap"`); `src/triggers/telegram-command-parser.ts` (after `parseJevAcceptCallback`, `:369–376`); `src/triggers/telegram-trigger-adapter.ts` (`:282–283` branch, builder beside `buildJevAcceptTapEvent` `:389`); `src/gateway/gateway.ts` (`GatewayIntakeResult` `:90` area, `RATE_LIMIT_EXEMPT` `:151`, options type `:166`, dispatch after `:221`, `whenTierTapsSettled`); `src/run/run-store.ts:2659` (exemption list); `src/telegram/telegram-daemon.ts` (Gateway options `:219–226`; `modelRolesTickInput` gains `card`; `runRolesTick`).
- Test: `tests/omp/model-roles-tick-tiers.test.ts` (card cases), `tests/triggers/` parser/adapter case (add to the file that tests `parseJevAcceptCallback`), `tests/gateway/intake-decisions.test.ts:81` (the exact exempt set gains `"model_tier_tap"`: `["decision_review", "improvement_tap", "jev_accept_tap", "kill", "model_tier_tap"]`, test name updated; `:70`, `:84` iterate it and need an `ev("model_tier_tap")` the helper can build — check `ev`; the P2 tombstone pin already applies there), a daemon shutdown case in `tests/telegram/telegram-daemon.test.ts`.
- Protected: `src/omp/model-roles.ts`, `src/omp/model-roles-tick.ts`, `src/run/run-store.ts`

**Interfaces — Consumes:** `proposalsFor`, `tierDef`, `isTierId` (Task 1); `recordModelProbe`, `getModelTier` (Task 2); `ProbeFn` (Task 4). **Produces:**
```ts
// model-roles.ts
export function soleKeysOf(tier: TierId): Array<RoleName | `judges:${number}`>; // judge seats on the tier + roles whose every leg is the tier
// model-roles-tick.ts
export interface EmptyTierCard { tier: TierId; keys: string[]; proposals: string[] }
// ModelRolesTickInput gains: card?: (c: EmptyTierCard) => void
// src/gateway/model-tier-commands.ts
export const tierModelHash: (id: string) => string; // sha256 hex, 12 chars
export const tierCallbackData: (tier: TierId, id: string | null) => string; // mt:<tier>:<hash12>:use | mt:<tier>:no
export function tierCardText(c: EmptyTierCard): string;
export function enqueueTierCard(store: RunStore, chatId: string, now: string, c: EmptyTierCard): void;
export interface TierTapDeps { roles?: ModelsRoles; probe?: ProbeFn; track: (p: Promise<void>) => void; signal?: AbortSignal }
export function handleModelTierTap(store: RunStore, deps: TierTapDeps, event: TypedTaskEvent, now?: string): GatewayIntakeResult;
// telegram-command-parser.ts
export function parseModelTierCallback(data: unknown): { tier: string; hash: string | null } | null;
// gateway.ts: options.modelProbe?: ProbeFn; options.stopSignal?: AbortSignal; Gateway.whenTierTapsSettled(): Promise<void>; status "model_tier_tapped"
// telegram-daemon.ts: TIER_TAP_SHUTDOWN_CAP_MS = 5_000
// telegram-daemon.ts: modelRolesTickInput(store, roles, now, notify, signal, card?)
```

- [ ] **Step 1: failing tests.** Add to `tests/omp/model-roles-tick-tiers.test.ts`:
```ts
describe("empty-tier cards (spec §4.4)", () => {
  it("one card a day for gemini-pro, naming judges:2, proposals by price; none once an override fills the seat", async () => {
    const r = roles(); const cards: unknown[] = [];
    const run = (now: string) => runModelRolesTick({ store, roles: r, now, notify: () => {}, card: (c) => cards.push(c) });
    await run(day(0));
    expect(cards).toEqual([{ tier: "gemini-pro", keys: ["judges:2"], proposals: ["gemini-4-argon", "gpt-oss-120b"] }]);
    await run(day(1));
    expect(cards).toHaveLength(2);
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gemini-4-argon", actor: "paco" });
    await run(day(2));
    expect(cards).toHaveLength(2);
  });
  it("a tier that empties but leaves every key resolved sends no card (P15)", async () => {
    const r = roles(); const cards: unknown[] = [];
    catalog = () => FIX().filter((m) => !(m.provider === "google-antigravity" && m.id === "claude-sonnet-5-5"));
    await runModelRolesTick({ store, roles: r, now: day(0), notify: () => {}, card: (c) => cards.push(c) });
    expect(cards.map((c) => (c as { tier: string }).tier)).toEqual(["gemini-pro"]);
  });
});
```
`tests/gateway/model-tier-commands.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { TAP_HANDLED_TEXT } from "../../src/gateway/improvement-commands.js";
import { enqueueTierCard, tierCallbackData, tierCardText, tierModelHash } from "../../src/gateway/model-tier-commands.js";
import type { ProbeFn, ProbeOutcome } from "../../src/omp/model-probe.js";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { parseModelTierCallback } from "../../src/triggers/telegram-command-parser.js";

// Spec §4.4: an empty tier asks Paco instead of failing quietly for three weeks. A tap probes first and only a pass writes
// the override (the same row `/models set judges 2 <id>` writes) in the probe event's transaction: code never adopts a
// codename without a tap, and a model the subscription cannot reach is never adopted at all.
let store: RunStore; let cb = 0;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const FIX = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const CARD = { tier: "gemini-pro" as const, keys: ["judges:2"], proposals: ["gemini-4-argon", "gpt-oss-120b"] };
const outbox = () => (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
  .prepare("SELECT idempotency_key, payload_json FROM notification_outbox ORDER BY created_at, rowid").all() as Array<{ idempotency_key: string; payload_json: string }>;
const texts = () => outbox().map((r) => (JSON.parse(r.payload_json) as { text: string }).text);
const tap = (data: string, callback = `cb${++cb}`) => {
  const p = parseModelTierCallback(data)!;
  return buildTypedTaskEvent({ source: "telegram", type: "model_tier_tap", requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "-1003" },
    idempotency_key: `telegram:1:callback:${callback}`, source_reference: `telegram:update:1:callback:${callback}`,
    metadata: { telegram_update_id: 1, telegram_callback_id: callback, tier: p.tier, ...(p.hash ? { model_hash: p.hash } : {}) } });
};
async function gateway(answer: ProbeOutcome, calls: string[] = []) {
  const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => FIX() });
  await roles.refreshCatalog();
  const probe: ProbeFn = async (sel) => { calls.push(sel); return answer; };
  return { gw: new Gateway(store, undefined, undefined, undefined, undefined, { roles, modelProbe: probe }), roles };
}
const probeRows = () => store.getLedgerEvents().filter((e) => e.event_type === "model_probe").map((e) => e.payload);

describe("the card", () => {
  it("is spec §4.4's text with Use buttons per proposal and Not now; one per tier per day", () => {
    expect(tierCardText(CARD)).toBe("Judges:2 has no model: Google's pro tier is empty. Use `gemini-4-argon`?");
    enqueueTierCard(store, "-1003", "2026-11-02T09:00:00.000Z", CARD);
    enqueueTierCard(store, "-1003", "2026-11-02T21:00:00.000Z", CARD);
    enqueueTierCard(store, "-1003", "2026-11-03T09:00:00.000Z", CARD);
    expect(outbox().map((r) => r.idempotency_key)).toEqual(["model_tier_card:gemini-pro:2026-11-02", "model_tier_card:gemini-pro:2026-11-03"]); // Sydney days: 09:00Z → 11-02 20:00; 21:00Z → 11-03 08:00; next 09:00Z → 11-03 20:00
    expect((JSON.parse(outbox()[0]!.payload_json) as { button_rows: unknown }).button_rows).toEqual([[
      { text: "Use gemini-4-argon", data: tierCallbackData("gemini-pro", "gemini-4-argon") },
      { text: "Use gpt-oss-120b", data: tierCallbackData("gemini-pro", "gpt-oss-120b") },
      { text: "Not now", data: "mt:gemini-pro:no" }]]);
  });
  it("callback data fits Telegram's 64 bytes and round-trips through the parser", () => {
    const d = tierCallbackData("sonnet@antigravity", "a-very-long-model-id-that-would-not-fit-in-callback-data-at-all");
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    expect(parseModelTierCallback(d)).toEqual({ tier: "sonnet@antigravity", hash: tierModelHash("a-very-long-model-id-that-would-not-fit-in-callback-data-at-all") });
    expect(parseModelTierCallback("mt:gemini-pro:no")).toEqual({ tier: "gemini-pro", hash: null });
    expect(parseModelTierCallback("mt:gemini-pro:zz:use")).toBeNull();
  });
  it("with no proposal, names the /models set form and offers no button", () => {
    expect(tierCardText({ ...CARD, proposals: [] })).toBe("Judges:2 has no model: Google's pro tier is empty. The catalog offers no other google-antigravity model; /models set judges 2 <pattern> fills it.");
  });
});

describe("a tap", () => {
  it("on a passing model: probe, then the override + probe event in one transaction; judges:2 resolves; role_unresolved closes", async () => {
    const { gw, roles } = await gateway({ result: "pass", kind: "ok" });
    store.openIncident({ kind: "role_unresolved", subject: "judges:2", detail: { role: "judges:2" } });
    expect(gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon")))).toMatchObject({ ok: true, status: "model_tier_tapped" });
    await gw.whenTierTapsSettled();
    expect(store.latestModelRoleOverrides().get("judges:2")).toBe("gemini-4-argon");
    expect(probeRows()).toEqual([{ tier: "gemini-pro", selector: "google-antigravity/gemini-4-argon", purpose: "tap", result: "pass", kind: "ok" }]);
    expect(roles.resolveAll().find((r) => r.key === "judges:2")?.head).toBe("google-antigravity/gemini-4-argon");
    expect(store.listOpenIncidents().filter((i) => i.kind === "role_unresolved")).toEqual([]);
    expect(texts()).toEqual(["🔎 Checking `gemini-4-argon` with one short prompt…",
      "✅ `gemini-4-argon` passed its check; judges:2 now uses it (an override: /models reset judges 2 undoes it)."]);
  });
  it("on a failing or inconclusive model writes no override and says so", async () => {
    for (const [answer, line] of [[{ result: "model_missing", kind: "model_missing" }, "❌ `gemini-4-argon` failed its check (not available on this subscription); nothing changed."],
      [{ result: "inconclusive", kind: "quota" }, "⏳ `gemini-4-argon` could not be checked right now (quota); nothing changed. Tap again later."]] as const) {
      store.close(); store = RunStore.openInMemory();
      const { gw } = await gateway(answer);
      gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon"))); await gw.whenTierTapsSettled();
      expect(store.latestModelRoleOverrides().has("judges:2")).toBe(false);
      expect(probeRows()).toEqual([{ tier: "gemini-pro", selector: "google-antigravity/gemini-4-argon", purpose: "tap", result: answer.result, kind: answer.kind }]);
      expect(texts()[1]).toBe(line);
    }
  });
  it("a stale hash, a filled seat, or a redelivered callback never probes twice", async () => {
    const calls: string[] = []; const { gw } = await gateway({ result: "pass", kind: "ok" }, calls);
    gw.intake(tap("mt:gemini-pro:000000000000:use")); await gw.whenTierTapsSettled();
    expect([calls, texts()]).toEqual([[], [TAP_HANDLED_TEXT]]);
    const ev = tap(tierCallbackData("gemini-pro", "gemini-4-argon"), "same");
    gw.intake(ev); gw.intake(ev); await gw.whenTierTapsSettled();
    expect(calls).toEqual(["google-antigravity/gemini-4-argon"]);
    gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon"))); await gw.whenTierTapsSettled();
    expect(calls).toHaveLength(1);
    expect(texts().at(-1)).toBe(TAP_HANDLED_TEXT);
  });
  it("Not now only answers", async () => {
    const calls: string[] = []; const { gw } = await gateway({ result: "pass", kind: "ok" }, calls);
    gw.intake(tap("mt:gemini-pro:no")); await gw.whenTierTapsSettled();
    expect([calls, texts()]).toEqual([[], ["👍 Not now: judges:2 stays empty; the daily reminder lists it until it is filled."]]);
  });
  it("a daemon stop aborts the tap's probe: nothing is written, only the 'Checking' reply exists (review W5)", async () => {
    const ac = new AbortController(); let seen: AbortSignal | undefined;
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => FIX() }); await roles.refreshCatalog();
    const probe: ProbeFn = (_sel, signal) => { seen = signal; return new Promise((r) => signal?.addEventListener("abort", () => r("aborted"), { once: true })); };
    const gw = new Gateway(store, undefined, undefined, undefined, undefined, { roles, modelProbe: probe, stopSignal: ac.signal });
    gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon")));
    ac.abort(); await gw.whenTierTapsSettled();
    expect(seen).toBe(ac.signal);
    expect([probeRows(), store.latestModelRoleOverrides().has("judges:2"), texts()]).toEqual([[], false, ["🔎 Checking `gemini-4-argon` with one short prompt…"]]);
  });
  it("is exempt from the per-chat rate limit, like the other card taps", async () => {
    const { gw } = await gateway({ result: "pass", kind: "ok" });
    for (let n = 0; n < 7; n++) expect(gw.intake(tap("mt:gemini-pro:no")).ok).toBe(true);
  });
});
```
Parser/adapter: in the test file for `parseJevAcceptCallback` (find it: `rg -ln parseJevAcceptCallback tests`), add: a `callback_query` with `data: "mt:gemini-pro:no"` from an allowlisted user normalizes to an event of type `model_tier_tap` with `metadata.tier === "gemini-pro"` and no `model_hash`.

- [ ] **Step 2: run, see fail.**

- [ ] **Step 3: implement.**

`model-roles.ts`:
```ts
/** The keys `tier` alone serves (plan P15): judge seats bound to it, and roles whose every leg is it. An empty-tier card names these. */
export function soleKeysOf(tier: TierId): Array<RoleName | `judges:${number}`> {
  const roles = ROLE_NAMES.filter((r) => r !== "judges" && ROLE_LEGS[r].every((l) => l.tier === tier));
  const seats = ROLE_LEGS.judges.flatMap((l, i): Array<`judges:${number}`> => (l.tier === tier ? [`judges:${i}`] : []));
  return [...roles, ...seats];
}
```
`model-roles-tick.ts`: `export interface EmptyTierCard { tier: TierId; keys: string[]; proposals: string[] }`; input `card?: (c: EmptyTierCard) => void`; `Written` gains `empty: TierId[]` (push `next.tier` when `next.adopted === null`); at the end of `settle` (after `syncStaticStale`), `if (catalog && i.card) for (const c of emptyTierCards(written.empty, roles, catalog, i.now)) i.card(c);`:
```ts
/** Spec §4.4 / P15: an empty tier whose sole keys still have no head asks Paco; the tick runs once a day, so one card a day. */
function emptyTierCards(empty: readonly TierId[], roles: ResolvedRole[], catalog: readonly CatalogModel[], now: string): EmptyTierCard[] {
  return empty.flatMap((tier) => {
    const keys = soleKeysOf(tier).filter((k) => roles.find((r) => r.key === k)?.head === null);
    return keys.length === 0 ? [] : [{ tier, keys, proposals: proposalsFor(tierDef(tier), catalog, Date.parse(now)) }];
  });
}
```
`src/gateway/model-tier-commands.ts`:
```ts
import { createHash } from "node:crypto";
import { errorCode } from "../domain/error-code.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { ProbeFn, ProbeOutcome } from "../omp/model-probe.js";
import type { EmptyTierCard } from "../omp/model-roles-tick.js";
import { soleKeysOf } from "../omp/model-roles.js";
import { isTierId, proposalsFor, tierDef, type TierId } from "../omp/model-tiers.js";
import { resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { TAP_FAILED_TEXT, TAP_HANDLED_TEXT } from "./improvement-commands.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";
import type { ModelsRoles } from "./models-commands.js";

/**
 * The empty-tier card and its tap (spec 2026-11-02 §4.4, plan P15–P16). Every text is code-owned; the only ids shown are
 * catalog ids and role keys. A tap probes first, off the tap's path, and only a pass writes the `/models set` row.
 */
const PROVIDER_LABEL: Readonly<Record<string, string>> = { anthropic: "Anthropic", "google-antigravity": "Google", "openai-codex": "OpenAI", "kimi-code": "Kimi" };
const ROLE_UNRESOLVED: ReadonlySet<string> = new Set(["role_unresolved"]);
const cap = (k: string) => `${k.charAt(0).toUpperCase()}${k.slice(1)}`;
const keyWords = (k: string) => k.replace(":", " ");
export const tierModelHash = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);
export const tierCallbackData = (tier: TierId, id: string | null): string => (id === null ? `mt:${tier}:no` : `mt:${tier}:${tierModelHash(id)}:use`);

export function tierCardText(c: EmptyTierCard): string {
  const def = tierDef(c.tier);
  const head = `${c.keys.map(cap).join(", ")} has no model: ${PROVIDER_LABEL[def.provider] ?? def.provider}'s ${def.label} tier is empty.`;
  const first = c.proposals[0];
  if (first !== undefined) return `${head} Use \`${first}\`?`;
  return `${head} The catalog offers no other ${def.provider} model; ${c.keys.map((k) => `/models set ${keyWords(k)} <pattern>`).join(" · ")} fills it.`;
}

/** One card per tier per display-zone day (the outbox key, as the reminder's, P23); through the outbox and the rich renderer. */
export function enqueueTierCard(store: RunStore, chatId: string, now: string, c: EmptyTierCard, env: NodeJS.ProcessEnv = process.env): void {
  const date = formatInstantInZone(now, resolveDisplayZone(env)).slice(0, 10);
  const buttons: NotificationButton[] = [...c.proposals.map((id) => ({ text: `Use ${id}`, data: tierCallbackData(c.tier, id) })), { text: "Not now", data: tierCallbackData(c.tier, null) }];
  store.enqueueNotification({ target: { kind: "telegram", chat_id: chatId }, intent_type: "progress", idempotency_key: `model_tier_card:${c.tier}:${date}`,
    correlation_id: "model-roles", payload: { text: tierCardText(c), ...(c.proposals.length > 0 ? { button_rows: [buttons] } : {}) } });
}

/** `signal`: the daemon's stop (review W5): a stop kills the tap's probe child and the aborted probe commits nothing. */
export interface TierTapDeps { roles?: ModelsRoles; probe?: ProbeFn; track: (p: Promise<void>) => void; signal?: AbortSignal }
interface OpenTap { tier: TierId; keys: string[]; proposals: string[] }

export function handleModelTierTap(store: RunStore, deps: TierTapDeps, event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    try { tapOnce(store, deps, event, now); } catch (e) {
      console.error(`[model-tiers] tap failed: ${errorCode(e)}`);
      try { replyTo(store, event, "model_tier_tap", TAP_FAILED_TEXT); } catch (e2) { console.error(`[model-tiers] tap reply failed: ${errorCode(e2)}`); }
    }
    return { ok: true, status: "model_tier_tapped", run_id: "" };
  });
}

function tapOnce(store: RunStore, deps: TierTapDeps, event: TypedTaskEvent, now: string): void {
  const reply = (text: string) => replyTo(store, event, "model_tier_tap", text);
  const t = openTap(store, deps.roles, String(event.metadata?.tier ?? ""), now);
  if (!t) return reply(TAP_HANDLED_TEXT);
  const hash = event.metadata?.model_hash;
  if (typeof hash !== "string") return reply(`👍 Not now: ${t.keys.join(", ")} stays empty; the daily reminder lists it until it is filled.`);
  const id = t.proposals.find((p) => tierModelHash(p) === hash);
  if (id === undefined) return reply(TAP_HANDLED_TEXT);
  if (!deps.probe) return reply("Model roles are not available in this process.");
  reply(`🔎 Checking \`${id}\` with one short prompt…`);
  deps.track(probeThenAdopt(store, deps.probe, t, id, event, deps.signal));
}

/** The card still applies: a known tier, still empty, a catalog, and a sole key without an override. */
function openTap(store: RunStore, roles: ModelsRoles | undefined, tier: string, now: string): OpenTap | null {
  if (!roles || !isTierId(tier)) return null;
  const catalog = roles.catalog();
  if (!catalog || (store.getModelTier(tier)?.adopted ?? null) !== null) return null;
  const overrides = store.latestModelRoleOverrides();
  const keys = soleKeysOf(tier).filter((k) => !overrides.has(k));
  return keys.length === 0 ? null : { tier, keys, proposals: proposalsFor(tierDef(tier), catalog, Date.parse(now)) };
}

/** Spec §4.4 (codex B3, senior W5): the probe, then the event and (on pass) the override in one transaction, then the answer. */
async function probeThenAdopt(store: RunStore, probe: ProbeFn, t: OpenTap, id: string, event: TypedTaskEvent, signal?: AbortSignal): Promise<void> {
  const selector = `${tierDef(t.tier).provider}/${id}`;
  try {
    const o = await probe(selector, signal);
    if (o === "aborted" || signal?.aborted) return; // the daemon is stopping: nothing written, nothing said (P16)
    store.inTransaction(() => {
      store.recordModelProbe({ tier: t.tier, selector, purpose: "tap", result: o.result, kind: o.kind });
      if (o.result !== "pass") return;
      for (const key of t.keys) store.recordModelRoleOverride({ key, pattern: id, actor: event.requested_by.id });
      for (const key of t.keys) resolveOpenIncidents(store, ROLE_UNRESOLVED, key);
    });
    replyTo(store, event, "model_tier_probe", resultText(t, id, o));
  } catch (e) {
    console.error(`[model-tiers] tap probe failed: ${errorCode(e)}`);
    try { replyTo(store, event, "model_tier_probe", TAP_FAILED_TEXT); } catch (e2) { console.error(`[model-tiers] tap reply failed: ${errorCode(e2)}`); }
  }
}

function resultText(t: OpenTap, id: string, o: ProbeOutcome): string {
  if (o.result === "pass") return `✅ \`${id}\` passed its check; ${t.keys.join(", ")} now ${t.keys.length === 1 ? "uses" : "use"} it (an override: ${t.keys.map((k) => `/models reset ${keyWords(k)}`).join(" · ")} undoes it).`;
  if (o.result === "model_missing") return `❌ \`${id}\` failed its check (not available on this subscription); nothing changed.`;
  return `⏳ \`${id}\` could not be checked right now (${o.kind}); nothing changed. Tap again later.`;
}
```
(`recordModelRoleOverride`'s `key` type is `OverrideKey`; `soleKeysOf` returns that shape — cast once if TS needs it. Check `errorCode`'s path, as `jev-accept-commands.ts:3` imports it.)

`telegram-command-parser.ts`, after `parseJevAcceptCallback`:
```ts
const MODEL_TIER_CB = /^mt:([a-z@-]{1,24}):(?:([0-9a-f]{12}):use|no)$/;
/** An empty-tier card's tap (spec 2026-11-02 §4.4): the tier and the proposal's hash, or null for "Not now". */
export function parseModelTierCallback(data: unknown): { tier: string; hash: string | null } | null {
  if (typeof data !== "string") return null;
  const m = MODEL_TIER_CB.exec(data);
  return m ? { tier: m[1]!, hash: m[2] ?? null } : null;
}
```
`telegram-trigger-adapter.ts`: import it; after the `jevAccept` branch: `const tierTap = parseModelTierCallback(callback.data); if (tierTap) return { ok: true, event: buildModelTierTapEvent(update, callback, message.chat.id, auth.identity, tierTap) };` and the builder (the `buildJevAcceptTapEvent` shape, `type: "model_tier_tap"`, metadata `{ telegram_update_id, telegram_callback_id, tier, ...(hash ? { model_hash: hash } : {}) }`).
`domain/types.ts`: `| "model_tier_tap"` in `TaskEventType`.
`gateway.ts`: `| { ok: true; status: "model_tier_tapped"; run_id: string }` in `GatewayIntakeResult`; `RATE_LIMIT_EXEMPT` += `"model_tier_tap"` (comment: empty-tier card taps, spec 2026-11-02 §4.4); options type += `modelProbe?: ProbeFn`; fields and method:
```ts
  /** Empty-tier taps in flight (plan P16): the probe runs off the intake path; tests and gates await them. */
  private readonly tierTaps = new Set<Promise<void>>();
  whenTierTapsSettled(): Promise<void> { return Promise.all([...this.tierTaps]).then(() => undefined); }
  private trackTierTap = (p: Promise<void>): void => { this.tierTaps.add(p); void p.finally(() => this.tierTaps.delete(p)); };
```
dispatch beside `jev_accept_tap`: `if (event.type === "model_tier_tap") return this.accepted(event, now, handleModelTierTap(this.runStore, { ...(this.options.roles ? { roles: this.options.roles } : {}), ...(this.options.modelProbe ? { probe: this.options.modelProbe } : {}), ...(this.options.stopSignal ? { signal: this.options.stopSignal } : {}), track: this.trackTierTap }, event, now));`
`run-store.ts:2659`: `AND command NOT IN ('decision_review', 'improvement_tap', 'jev_accept_tap', 'model_tier_tap')` and extend the trailing comment with "; empty-tier card taps (spec 2026-11-02 §4.4)".
`telegram-daemon.ts`: Gateway options `{ dataDir: …, roles: worker.modelRoles(), modelProbe: ompProbe(options.store, resolveOmpConfig(process.env)), stopSignal: options.stopSignal }`; in the shutdown sequence, right after `await worker.shutdownPlanners();` (`:380`): `await settledWithin(gateway.whenTierTapsSettled(), TIER_TAP_SHUTDOWN_CAP_MS);` (the helper the Jev job uses on the next line; `export const TIER_TAP_SHUTDOWN_CAP_MS = 5_000` with a comment: a tap probe aborted by the stop settles at once, the cap only bounds a probe that ignores its signal); `modelRolesTickInput(store, roles, now, notify, signal, card?)` passes `card` through; `runRolesTick` passes `card = (c) => { if (chatId) enqueueTierCard(options.store, chatId, now, c); }`.

Daemon shutdown case (`tests/telegram/telegram-daemon.test.ts`, the file's own `runTelegramDaemon` harness): with a `model_tier_tap` whose probe never settles on its own but honours the signal, aborting the daemon's `stopSignal` ends `runTelegramDaemon` within `TIER_TAP_SHUTDOWN_CAP_MS` + 1 s and leaves no `model_probe` row. If the daemon's Gateway probe cannot be injected there, add a `modelProbe` field to the daemon options (tests only, like `panelSeats`) and say so.

- [ ] **Step 4: run, see pass** — `npx vitest run tests/omp/ tests/gateway/ tests/triggers/ tests/telegram/ && npm run typecheck`. Mutations: write the override before the probe (the failing-model test fails); drop the `signal` from `probe(selector, signal)` (the stop test hangs to its timeout — fails); drop `model_tier_tap` from `RATE_LIMIT_EXEMPT` (rate-limit test fails at the 6th tap); match proposals by id prefix instead of hash (stale-hash test fails); send a card for every empty tier regardless of sole keys (the P15 test fails).
- [ ] **Step 5: commit** — `feat(models): empty-tier card — Paco's tap probes first and writes the override only on a pass`.

---

### Task 7: Each judge's model id in the panel tick

**Files:**
- Modify: `src/capabilities/idea-panel-seats.ts` (`PanelSeatBindings` `:17–21`, `buildOmpPanelSeats` `:37–65`); `src/capabilities/idea-panel.ts` (`PanelTickInput` `:304–325`, the three `recordIdeaPanelTick` calls at `:369`, `:417`, `:594`); `src/run/run-store.ts` `recordIdeaPanelTick` (`:4386–4405`); `src/run/run-ledger.ts` `idea_panel_tick` (`:277–286`).
- Test: the existing panel tests (`rg -ln "runIdeaPanelTick|buildOmpPanelSeats" tests`) gain one case each.
- Protected: `src/run/run-store.ts`, `src/run/run-ledger.ts`

**Interfaces — Produces:** `PanelSeatBindings.judgeModels?: Record<"kimi" | "codex" | "gemini", string | null>` — optional on the bindings (review W3: `tests/telegram/telegram-daemon.test.ts:718` and any injected `panelSeats` build the bindings without it; `buildOmpPanelSeats` always fills it, and the payload field below stays required, `null` when absent); `PanelTickInput.judgeModels?: Record<…, string | null>`; `recordIdeaPanelTick` payload gains `judge_models: Record<…, string | null> | null` (required field, P24).

- [ ] **Step 1: failing tests.** In the `buildOmpPanelSeats` test file: with chains whose judges are `[k3.1-pro, gpt-6.1-sol, (none)]`, `buildOmpPanelSeats({...}).judgeModels` equals `{ kimi: "kimi-code/k3.1-pro", codex: "openai-codex/gpt-6.1-sol", gemini: null }`. In the panel tick test file: a run (ok path) with `judgeModels` given records `idea_panel_tick` whose payload `judge_models` equals it exactly; a thin-board skip records the same `judge_models`; a run without `judgeModels` records `judge_models: null`. Why (test comment): spec §12 — a newer model changes judge scores overnight; the row must say which model scored.
- [ ] **Step 2: run, see fail.**
- [ ] **Step 3: implement.** `idea-panel-seats.ts` (`judgeModels?` on `PanelSeatBindings`, filled here): `const modelOf = (name: keyof typeof PANEL_JUDGE_SEAT_INDEX): string | null => { const m = judgeSeat(cfg, PANEL_JUDGE_SEAT_INDEX[name])[0]; return m ? formatModelString(m) : null; };` and return `judgeModels: { kimi: modelOf("kimi"), codex: modelOf("codex"), gemini: modelOf("gemini") }`. `idea-panel.ts`: `judgeModels?: Record<PanelJudgeName, string | null>` on the input (doc: "spec 2026-11-02 §2: which model each seat ran"); each of the three `recordIdeaPanelTick({...})` calls adds `judge_models: input.judgeModels ?? null`. `run-store.ts`: the payload type gains `judge_models: Record<string, string | null> | null`. `run-ledger.ts`: append `"judge_models"` to `idea_panel_tick` with the comment "model ids per seat (spec 2026-11-02 §2), code-owned catalog strings". The daemon already spreads `buildPanelSeatBindings(...)` into the tick input (`telegram-daemon.ts:736–739`), so `judgeModels` reaches it; confirm, and that `houge radar-panel` (CLI) does the same.
- [ ] **Step 4: run, see pass** — `npx vitest run tests/capabilities/ tests/run/ && npm run typecheck`. Mutation: drop `judge_models` from one of the three calls (typecheck or the skip test fails — record which).
- [ ] **Step 5: commit** — `feat(panel): the idea panel tick records each judge's model id`.

---

### Task 8: Daily reminder, `hostile_schedule_turn` as an event, the boot resolve

**Files:**
- Modify: `src/run/incident-alert.ts` (new `REMIND_KINDS`, `REMIND_AFTER_MS`, `reminderText`, `runIncidentReminder`).
- Modify: `src/decisions/trust.ts:81–84` (`page`: `event: kind === "hostile_schedule_turn"`).
- Modify: `src/telegram/telegram-daemon.ts:537–538` (reminder step before `await runModelTicks`).
- Modify: `src/run/run-store.ts` (`migrate()` += `this.applyHostileScheduleEventMigration();` after Task 2's; the migration).
- Test: `tests/run/incident-reminder.test.ts` (new); `tests/decisions/trust.test.ts` or the existing `TurnTrust` test file (`rg -ln "hostile_schedule_turn" tests`); `tests/run/loud-degradation-store.test.ts` (boot resolve).
- Protected: `src/decisions/trust.ts`, `src/run/run-store.ts`

**Interfaces — Produces** (`incident-alert.ts`):
```ts
export const REMIND_KINDS: ReadonlyMap<string, string>;
export const REMIND_AFTER_MS: number; // 24 h
export function reminderText(open: ReadonlyArray<Pick<IncidentRow, "incident_id" | "kind" | "subject" | "first_seen_at">>, now: string): string | null;
export function runIncidentReminder(i: { store: RunStore; chatId: string | null; env: NodeJS.ProcessEnv; now: string }): "sent" | "none" | "already" | "no_chat";
```

- [ ] **Step 1: failing tests** — `tests/run/incident-reminder.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMIND_KINDS, reminderText, runIncidentReminder } from "../../src/run/incident-alert.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §5: an actionable incident paged once and then said nothing for three weeks (judge seat 2). A reminder repeats daily
// until it is fixed — but only for kinds Paco can act on, and never for delivery health (a reminder about undelivered alerts
// would multiply during an outage, memory: monitors must not observe their own output).
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const NOW = "2026-11-02T22:00:00.000Z"; // 2026-11-03 09:00 in Sydney
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney" } as NodeJS.ProcessEnv;
const rows = () => (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
  .prepare("SELECT idempotency_key, payload_json FROM notification_outbox").all() as Array<{ idempotency_key: string; payload_json: string }>;

describe("REMIND_KINDS", () => {
  it("is exactly spec §5's set and action lines", () => {
    expect([...REMIND_KINDS]).toEqual([
      ["role_unresolved", "tap the card, or `/models set <key> <pattern>`"],
      ["static_list_stale", "re-pin `STATIC_ROLE_LISTS`"],
      ["model_catalog_unavailable", "check `omp --profile houge models`"],
      ["planner_session_reset_failed", "send `/fresh`, or check the omp session dir"]
    ]);
  });
});

describe("runIncidentReminder", () => {
  it("one message, only kinds in the set, only incidents older than 24 h, with age and action; at most once a day", () => {
    store.openIncident({ kind: "role_unresolved", subject: "judges:2", detail: {}, now: ago(20 * 24 + 7) });
    store.openIncident({ kind: "static_list_stale", subject: "kimi-code/k3", detail: {}, now: ago(23) });        // too young
    store.openIncident({ kind: "undelivered_notification", subject: "telegram:1", detail: {}, now: ago(48) });   // never reminded
    store.openIncident({ kind: "trust_tap_budget", subject: "2026-11-02", detail: {}, now: ago(30) });          // rolls over itself
    expect(runIncidentReminder({ store, chatId: "-1003", env: ENV, now: NOW })).toBe("sent");
    expect(rows().map((r) => [r.idempotency_key, (JSON.parse(r.payload_json) as { text: string }).text])).toEqual([[
      "incident_remind:2026-11-03",
      "🔔 **Still open** (daily reminder)\n- role_unresolved · judges:2 · open 20d7h — tap the card, or `/models set <key> <pattern>`"
    ]]);
    expect(runIncidentReminder({ store, chatId: "-1003", env: ENV, now: new Date(Date.parse(NOW) + 3_600_000).toISOString() })).toBe("already");
    expect(rows()).toHaveLength(1);
  });
  it("nothing old enough → no message; no chat → nothing", () => {
    store.openIncident({ kind: "role_unresolved", subject: "judges:2", detail: {}, now: ago(1) });
    expect(runIncidentReminder({ store, chatId: "-1003", env: ENV, now: NOW })).toBe("none");
    expect(runIncidentReminder({ store, chatId: null, env: ENV, now: NOW })).toBe("no_chat");
    expect(rows()).toEqual([]);
  });
  it("reminderText lists every kind in the set, oldest first", () => {
    expect(reminderText([
      { incident_id: "inc_b", kind: "planner_session_reset_failed", subject: "chat:42", first_seen_at: ago(25) },
      { incident_id: "inc_a", kind: "model_catalog_unavailable", subject: "omp", first_seen_at: ago(49) }
    ], NOW)).toBe("🔔 **Still open** (daily reminder)\n- model_catalog_unavailable · omp · open 2d1h — check `omp --profile houge models`\n"
      + "- planner_session_reset_failed · chat:42 · open 1d1h — send `/fresh`, or check the omp session dir");
  });
});
```
(`resolveDisplayZone` reads `HOUGE_DISPLAY_TZ`, default `Australia/Sydney` — `src/run/schedule-spec.ts:132–134`. The expected date assumes Sydney.)

Daemon-path test (add to the test file that drives `runSignalPathTick` or the daemon's tick — `rg -ln "runSignalPathTick|signal-path tick" tests`; if none exists, export `runReminderStep(options, chatId, now)` from `telegram-daemon.ts` and test it): with `HOUGE_MODEL_ROLES=static`, and separately with a resolver whose catalog read fails, the reminder is still enqueued once; and it is enqueued before the roles tick runs (a `roles.refreshCatalog` that never resolves does not prevent it — call the step with a 0 ms race).

Trust (in the `TurnTrust` test file): a schedule-born turn that raises `injection_withheld` opens `hostile_schedule_turn` and it is **resolved** right after its page (`listOpenIncidents()` has none of that kind; the outbox holds one `incident_opened:<id>` row when `HOUGE_TELEGRAM_CHAT_ID` is a stub). The subject is the run id, so each schedule turn is its own event: two schedule turns that each raise it page exactly twice, once each.

Also update `tests/decisions/turn-trust.test.ts:55–65` ("a schedule-born hostile turn also pages hostile_schedule_turn once"): the incident is now opened **and resolved** — assert exactly one `hostile_schedule_turn` row in `incidents` with `state = 'resolved'`, zero open, and exactly one `incident_opened:<id>` outbox row (the page), plus the urgent card as before.

Boot resolve (in `tests/run/loud-degradation-store.test.ts`): on a file store, open three `hostile_schedule_turn` incidents and remove the `2026-11-02-hostile-schedule-event` row from `schema_migrations` (simulating a DB written by the previous build), reopen → zero open of that kind, three `incident_resolved` events with `kind: "hostile_schedule_turn"`; open one more, reopen again → it stays open (once).

- [ ] **Step 2: run, see fail.**

- [ ] **Step 3: implement.** `incident-alert.ts`:
```ts
import { formatInstantInZone, resolveDisplayZone } from "./schedule-spec.js";
import type { IncidentRow } from "./run-store.js";

/**
 * Spec 2026-11-02 §5: the alerted kinds a daily reminder repeats until fixed, each with the action that fixes it. Left out
 * on purpose: undelivered_notification and every delivery-health kind (a reminder would multiply during an outage),
 * trust_tap_budget (per day, rolls over itself), omp_contract_drift and planner_no_leg (each re-detects or pages on its own path).
 */
export const REMIND_KINDS: ReadonlyMap<string, string> = new Map([
  ["role_unresolved", "tap the card, or `/models set <key> <pattern>`"],
  ["static_list_stale", "re-pin `STATIC_ROLE_LISTS`"],
  ["model_catalog_unavailable", "check `omp --profile houge models`"],
  ["planner_session_reset_failed", "send `/fresh`, or check the omp session dir"]
]);
export const REMIND_AFTER_MS = 24 * 60 * 60_000;

const age = (ms: number): string => `${Math.floor(ms / 86_400_000)}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`;

/** Code-owned text: kinds, subjects (role keys, selectors, chat ids), ages and action lines; null when nothing qualifies. */
export function reminderText(open: ReadonlyArray<Pick<IncidentRow, "incident_id" | "kind" | "subject" | "first_seen_at">>, now: string): string | null {
  const t = Date.parse(now);
  const due = open.filter((i) => REMIND_KINDS.has(i.kind) && t - Date.parse(i.first_seen_at) > REMIND_AFTER_MS)
    .sort((a, b) => Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at) || (a.incident_id < b.incident_id ? -1 : a.incident_id > b.incident_id ? 1 : 0)); // deterministic for one millisecond (review)
  if (due.length === 0) return null;
  return ["🔔 **Still open** (daily reminder)", ...due.map((i) => `- ${i.kind} · ${i.subject} · open ${age(t - Date.parse(i.first_seen_at))} — ${REMIND_KINDS.get(i.kind)}`)].join("\n");
}

/**
 * The daily reminder (spec §5, plan P23): one message a display-zone day, keyed `incident_remind:<date>`. The outbox answers
 * `duplicate` (same text) or `conflict` (a later text the same day) for a second send: both mean "already sent today".
 */
export function runIncidentReminder(i: { store: RunStore; chatId: string | null; env: NodeJS.ProcessEnv; now: string }): "sent" | "none" | "already" | "no_chat" {
  if (!i.chatId) return "no_chat";
  const text = reminderText(i.store.listOpenIncidents(), i.now);
  if (text === null) return "none";
  const date = formatInstantInZone(i.now, resolveDisplayZone(i.env)).slice(0, 10);
  const r = i.store.enqueueNotification({ target: { kind: "telegram", chat_id: i.chatId }, intent_type: "progress",
    idempotency_key: `incident_remind:${date}`, correlation_id: "incident-remind", payload: { text } });
  return r.status === "queued" ? "sent" : "already";
}
```
(`incident-alert.ts` already imports `type RunStore`; `IncidentRow` is exported from `run-store.ts` — confirm; the import of `schedule-spec.js` is the one `trust-ask.ts:3` uses.) Also extend the file's header comment: "`hostile_schedule_turn` is an event (spec 2026-11-02 §5)".

`trust.ts` `page`: `openAlertedIncident(this.d.store, { kind, subject: this.d.run_id, detail: { run_id: this.d.run_id }, ...(kind === "hostile_schedule_turn" ? { event: true } : {}), ...(this.d.env ? { env: this.d.env } : {}) })` with the comment "spec 2026-11-02 §5: an event, resolved after its page — a carried turn re-paged the same morning twice".

`telegram-daemon.ts` (`runSignalPathTick`, between `:537` and `:538`):
```ts
    // Spec 2026-11-02 §5 (B3, N5): the daily reminder, before the model ticks and independent of HOUGE_MODEL_ROLES, so a
    // slow or stopped model tick (or a catalog outage) cannot delay that day's reminder. Its own catch.
    runReminderStep(options.store, chatId, now);
```
```ts
export function runReminderStep(store: RunStore, chatId: string | null, now: string): void {
  try { runIncidentReminder({ store, chatId, env: process.env, now }); } catch (error) { console.error(`[telegram-daemon] incident reminder failed: ${errorCode(error)}`); }
}
```
`run-store.ts`:
```ts
  /** Spec 2026-11-02 §5 (plan P22): hostile_schedule_turn became an event; the rows a previous build left open are resolved once. */
  private applyHostileScheduleEventMigration(): void {
    const version = "2026-11-02-hostile-schedule-event";
    this.inTransaction(() => {
      if (this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version)) return;
      const now = new Date().toISOString();
      for (const open of this.listOpenIncidents()) if (open.kind === "hostile_schedule_turn") this.resolveIncident(open.incident_id, now);
      this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, now);
    });
  }
```
(`resolveIncident` appends a ledger event through `appendLedgerEvent`, which reads `this.redact`, set before `migrate()` in the constructor, `:1418–1421`.)

- [ ] **Step 4: run, see pass** — `npx vitest run tests/run/ tests/decisions/ tests/telegram/ && npm run typecheck`. Mutations: add `undelivered_notification` to `REMIND_KINDS` (the exact-set test fails); `>=` 23 h threshold (too-young row appears); drop `event: true` (the trust event test fails); drop the migration's version check (the "stays open" case fails).
- [ ] **Step 5: commit** — `feat(incidents): daily reminder of open actionable incidents; hostile_schedule_turn is an event, old rows resolved once`.

---

### Task 9: `TurnTrust` keeps its causes; the transcript stores the carry level (D2-A); D3-A

**Files:**
- Modify: `src/decisions/entries/turn-trust.ts` (after `CAUSE_LEVEL`, `:20–22`: `CARRY_LEVEL`); `src/decisions/trust.ts` (`TurnTrust` `:26–85`: `#causes`, `raise`, `carryLevel`, `onHostile`); `src/omp/planner-supervisor.ts` `endTrust` (`:819–830`).
- Test: `tests/decisions/turn-trust.test.ts` (new cases), `tests/omp/planner-supervisor.test.ts:1934–1957` (the carry test: rewrite its first cause, below), new supervisor cases beside it.
- Protected: `src/decisions/entries/turn-trust.ts`, `src/decisions/trust.ts`, `src/omp/planner-supervisor.ts`

**Interfaces — Produces:** `export const CARRY_LEVEL: Readonly<Record<TrustCause, TrustLevel>>` (`turn-trust.ts`); `TurnTrust.carryLevel(): TrustLevel`.

- [ ] **Step 1: failing tests.** `tests/decisions/turn-trust.test.ts` (reuse its `setup()`):
```ts
// Spec 2026-11-02 §6.1 (D2-A, senior B1): a caught, withheld passage never reached the planner, so after the turn the
// transcript carries `untrusted`, not `hostile` — but only when the withhold is the turn's ONLY hostile cause. raise() used to
// drop a cause that did not raise the level, so a withhold followed by unjudged outside text was indistinguishable.
describe("carry level (D2-A)", () => {
  const carryOf = (causes: TrustCause[], carried: string | null = null) => {
    const { trust } = setup(); trust.carry(carried); for (const c of causes) trust.raise(c, "tc"); return [trust.level(), trust.carryLevel()];
  };
  it("withhold only → hostile in the turn, untrusted carried", () => expect(carryOf(["injection_withheld"])).toEqual(["hostile", "untrusted"]));
  it("withhold, then unjudged outside text (bridge-handler.ts:539/540) → hostile carried", () => expect(carryOf(["injection_withheld", "unjudged_outside"])).toEqual(["hostile", "hostile"]));
  it("withhold, then a judgement lost on outside text → hostile carried", () => expect(carryOf(["injection_withheld", "judge_lost_outside"])).toEqual(["hostile", "hostile"]));
  it("a carried-hostile turn that withholds still carries hostile (D2 alone never lowers today's transcript)", () => expect(carryOf(["injection_withheld"], "hostile")).toEqual(["hostile", "hostile"]));
  it("untrusted causes carry untrusted; nothing carries clean", () => {
    expect(carryOf(["unjudged_local", "judge_timeout"])).toEqual(["untrusted", "untrusted"]);
    expect(carryOf([])).toEqual(["clean", "clean"]);
  });
  it("in the turn nothing changes: one turn_trust row per rise, none for the non-rising second cause", () => {
    const { trust, events } = setup(); trust.raise("injection_withheld", "a"); trust.raise("unjudged_outside", "b");
    expect(events("turn_trust")).toEqual([{ level: "hostile", cause: "injection_withheld" }]);
  });
  it("a cause asked after finalize is not kept", () => {
    const { trust } = setup(); trust.raise("injection_withheld"); trust.finalize(); trust.raise("unjudged_outside");
    expect(trust.carryLevel()).toBe("untrusted");
  });
  it("CARRY_LEVEL differs from CAUSE_LEVEL only at injection_withheld", () => {
    expect(Object.keys(CAUSE_LEVEL).filter((c) => CARRY_LEVEL[c as TrustCause] !== CAUSE_LEVEL[c as TrustCause])).toEqual(["injection_withheld"]);
  });
});

// Spec 2026-11-02 §6.4 (D3-A): the turn that read the text paged; a schedule turn that only carries it pages nothing (the
// 10-31 and 11-01 mornings each re-paged the same event).
describe("D3-A", () => {
  it("a carried-hostile schedule turn opens no hostile_schedule_turn and queues no page", () => {
    const sc = setup("schedule"); sc.trust.carry("hostile");
    expect(sc.store.getLedgerEvents().filter((e) => e.event_type === "incident_opened")).toEqual([]);
  });
  it("a schedule turn that itself raises hostile still pages once", () => {
    const sc = setup("schedule"); sc.trust.raise("injection_withheld");
    expect(sc.store.getLedgerEvents().filter((e) => e.event_type === "incident_opened").map((e) => (e.payload as { kind: string }).kind)).toEqual(["hostile_schedule_turn"]);
  });
});
```
(import `CARRY_LEVEL` and `type TrustCause`.)

`tests/omp/planner-supervisor.test.ts:1934–1957`: the first turn's `cause` becomes `"unjudged_outside"` (a cause that carries `hostile`), the rest unchanged. Add beside it:
```ts
  it("D2-A: a withhold-only turn stores untrusted; the next turn carries untrusted, and standing credit is no longer barred", async () => {
    let cause: TrustCause | null = "injection_withheld";
    let sup: PlannerSupervisor | undefined;
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); if (cause) sup?.activeTurnForTest()?.trust?.raise(cause, "tc"); session.assistant("ok"); e({ type: "agent_end" }); } });
    const h = harness(session); sup = h.sup; const { store } = h;
    const run = async () => { const id = createQueuedTurnRun(store); h.sup.submit(req(id)); await h.sup.whenIdle(); return id; };
    const first = await run();
    expect(finalOf(store, first)).toEqual({ max_level: "hostile" }); // in-turn behaviour unchanged
    expect(store.getTranscriptTrust("42")).toBe("untrusted");
    cause = null;
    expect(trustEvents(store, await run())).toEqual([{ level: "untrusted", cause: "carried_untrusted" }]);
  });
  it("the double raise from one result (withhold, then unjudged_outside) stores hostile", async () => {
    let sup: PlannerSupervisor | undefined;
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); const t = sup?.activeTurnForTest()?.trust; t?.raise("injection_withheld", "tc"); t?.raise("unjudged_outside", "tc"); session.assistant("ok"); e({ type: "agent_end" }); } });
    const h = harness(session); sup = h.sup;
    h.sup.submit(req(createQueuedTurnRun(h.store))); await h.sup.whenIdle();
    expect(h.store.getTranscriptTrust("42")).toBe("hostile");
  });
```
And find the existing "uncommitted fresh transcript keeps the old level" case (`rg -n "keep|committed" tests/omp/planner-supervisor.test.ts | rg -i trust`); add its withhold-only variant: stored `hostile`, a fresh-but-uncommitted transcript whose turn withholds only → stored stays `hostile` (carry `untrusted` < `hostile`). If no such case exists, write it: a lesson reset (sessionState "none") whose first prompt RPC rejects (`fakeSession({ onPrompt: () => { throw new PlannerRpcError("command_failed:prompt"); } })` — read how other cases fail a prompt) after the turn raised `injection_withheld`, with `store.setTranscriptTrust("42", "hostile", …)` before → stored stays `hostile`.

Bridge level (review suggestion): in `tests/omp/bridge-handler-trust.test.ts`, drive the real `raiseFor` (`bridge-handler.ts:538–544`, private; reach it through the judged tool path that file already uses) with a judge outcome of `{ withheld: 2, withheldUnjudged: 1, framed: 0, notChecked: 0, unanswered: 0, skipped: false }` — the live `:539/:540` pair from one result — and assert the active turn's `trust.carryLevel() === "hostile"`; with `{ withheld: 1, withheldUnjudged: 0, … }` alone, `"untrusted"`.

- [ ] **Step 2: run, see fail.**

- [ ] **Step 3: implement.** `turn-trust.ts`:
```ts
/**
 * D2-A (spec 2026-11-02 §6.1): the level a cause leaves on the planner transcript after its turn. A withheld passage was
 * replaced by WITHHELD_TEXT before the planner saw it, so it carries `untrusted`; every other cause carries its own level.
 * The turn itself is unchanged: CAUSE_LEVEL still sets the in-turn level.
 */
export const CARRY_LEVEL: Readonly<Record<TrustCause, TrustLevel>> = { ...CAUSE_LEVEL, injection_withheld: "untrusted" };
```
`trust.ts`:
```ts
  #causes = new Set<TrustCause>();

  /** True when the level rose. Every cause asked is kept for the carry (B1), even one that does not raise the level. */
  raise(cause: TrustCause, tool_call_id: string | null = null): boolean {
    if (this.#ended) return false;
    this.#causes.add(cause);
    if (rankOf(CAUSE_LEVEL[cause]) <= rankOf(this.#current)) return false;
    // … the rest of today's body, unchanged
  }

  /** Spec 2026-11-02 §6.1: what the transcript carries after this turn — the highest CARRY_LEVEL over every cause asked. */
  carryLevel(): TrustLevel {
    let best: TrustLevel = "clean";
    for (const c of this.#causes) if (rankOf(CARRY_LEVEL[c]) > rankOf(best)) best = CARRY_LEVEL[c];
    return best;
  }

  /**
   * Spec §8.2: one urgent card per hostile turn; a schedule-born one (nobody to tap) also pages hostile_schedule_turn, an
   * event. A carried level sends no card and, D3-A (spec 2026-11-02 §6.4), no page: the turn that read the text already paged.
   */
  private onHostile(carried: boolean): void {
    if (carried) return;
    if (this.d.born === "schedule") this.page("hostile_schedule_turn");
    try { enqueueUrgentCard(...); } catch (e) { … unchanged … }
  }
```
`planner-supervisor.ts` `endTrust`:
```ts
  /**
   * Every turn end: turn_trust_final once, then (a dispatched turn only) the level the transcript now carries — the carry
   * level (D2-A, spec 2026-11-02 §6.1), not the in-turn level. A fresh transcript that was never committed is not the one a
   * respawn resumes, so the old level is kept unless this one carries higher.
   */
  private endTrust(t: Turn): void {
    const trust = t.active.trust;
    trust?.finalize();
    if (!trust || !t.dispatched) return;
    const { store, chatId } = this.d;
    try {
      const carry = trust.carryLevel();
      const stored = store.getTranscriptTrust(chatId);
      const keepOld = t.freshTranscript && !t.committedFresh && (stored === "untrusted" || stored === "hostile") && rankOf(stored) > rankOf(carry);
      store.setTranscriptTrust(chatId, keepOld ? stored : carry, new Date().toISOString());
    } catch (e) {
      console.error(`planner supervisor: transcript_trust_not_written (${message(e)})`);
    }
  }
```
`persistRise` is unchanged (P20); add one comment line there: "persists the in-turn level; endTrust lowers it to the carry level at the turn end (plan P20)".

- [ ] **Step 4: run, see pass** — `npx vitest run tests/decisions/ tests/omp/ && npm run typecheck`. Mutations: `raise` adding the cause after the early return (the double-raise tests fail); `endTrust` storing `trust.level()` (withhold-only fails); `onHostile` paging before the `carried` return (D3-A fails); `CARRY_LEVEL` also lowering `unjudged_outside` (the CARRY/CAUSE diff test fails).
- [ ] **Step 5: commit** — `feat(trust): carry the highest carry level over every cause; a withhold-only turn carries untrusted (D2-A); no page for a carried schedule turn (D3-A)`.

---

### Task 10: `transcript_trust_at` and the `/status` line

**Files:**
- Modify: `src/run/run-store.ts` — `setTranscriptTrust` (`:3137–3142`); new `getTranscriptTrustSince`.
- Modify: `src/gateway/gateway.ts` — `statusPayload` (`:1276–1280`) passes the chat id; `formatStatusText` (`:1282`) gains `chatId: string | null` and the line after `Self-check:` (`:1370`).
- Test: `tests/run/loud-degradation-store.test.ts` (trust-at cases), `tests/gateway/status-carry.test.ts` (new; build the `/status` event as `tests/gateway/status-decisions.test.ts` does).
- Protected: `src/run/run-store.ts`

**Interfaces — Produces:** `getTranscriptTrustSince(chat_id: string): { level: string; at: string | null } | null`.

- [ ] **Step 1: failing tests.** Store (P19 — "since" names when the carry began):
```ts
describe("transcript_trust_at", () => {
  it("is set when the level changes and kept while it stays; a new row gets it too; a legacy row reads null", () => {
    const s = RunStore.openInMemory();
    s.setTranscriptTrust("42", "hostile", "2026-11-01T00:00:00.000Z");
    s.setTranscriptTrust("42", "hostile", "2026-11-02T00:00:00.000Z");
    expect(s.getTranscriptTrustSince("42")).toEqual({ level: "hostile", at: "2026-11-01T00:00:00.000Z" });
    s.setTranscriptTrust("42", "untrusted", "2026-11-03T00:00:00.000Z");
    expect(s.getTranscriptTrustSince("42")).toEqual({ level: "untrusted", at: "2026-11-03T00:00:00.000Z" });
    db(s).prepare("UPDATE planner_session_state SET transcript_trust_at = NULL WHERE chat_id = '42'").run();
    expect(s.getTranscriptTrustSince("42")).toEqual({ level: "untrusted", at: null });
    expect(s.getTranscriptTrustSince("nope")).toBeNull();
    s.close();
  });
});
```
`tests/gateway/status-carry.test.ts`: (a) chat `-1003` stored `hostile` at `2026-11-01T22:00:00.000Z` → the `/status` text has exactly one line matching `/^Conversation carries/`, equal to `Conversation carries hostile since 2026-11-02 09:00 (Sydney) · /fresh clears it` (compute the time part with the gateway's own `formatInstantInZone(iso, zone) + " (Sydney)"` to avoid a zone-format mismatch — read `localOf` at `:1300`); (b) stored `clean` → no such line; (c) legacy null time → `Conversation carries untrusted · /fresh clears it`; (d) another chat's carry is not shown. Why: spec §6.3 — Paco could not see that every shell command asked because of a carry from 19 days earlier.
- [ ] **Step 2: run, see fail.**
- [ ] **Step 3: implement.** `run-store.ts`:
```ts
  /**
   * Records it at a dispatched turn's end (and at every rise). `transcript_trust_at` is when the stored level last changed
   * (plan P19), so /status can say since when the conversation carries it. With no row, a clean level writes nothing.
   */
  setTranscriptTrust(chat_id: string, level: string, now: string): void {
    const r = this.db.prepare(`
      UPDATE planner_session_state SET transcript_trust_at = CASE WHEN transcript_trust IS ? THEN transcript_trust_at ELSE ? END, transcript_trust = ?
      WHERE chat_id = ?
    `).run(level, now, level, chat_id);
    if (r.changes === 1 || level === "clean") return;
    this.db.prepare(`
      INSERT INTO planner_session_state (chat_id, lesson_fingerprint, seed_pending, updated_at, transcript_trust, transcript_trust_at) VALUES (?, '', 0, ?, ?, ?)
    `).run(chat_id, now, level, now);
  }

  /** Spec 2026-11-02 §6.3: the stored level and since when; null without a row. */
  getTranscriptTrustSince(chat_id: string): { level: string; at: string | null } | null {
    const r = this.db.prepare(`SELECT transcript_trust, transcript_trust_at FROM planner_session_state WHERE chat_id = ?`)
      .get<{ transcript_trust: string | null; transcript_trust_at: string | null }>(chat_id);
    return r ? { level: r.transcript_trust ?? "clean", at: r.transcript_trust_at } : null;
  }
```
(SQLite evaluates every `SET` expression against the old row, so the `CASE` reads the previous level.) `gateway.ts`: `statusPayload` passes `event.notify.kind === "telegram" ? event.notify.chat_id : null` to `formatStatusText(status, now, chatId)`; inside the overview branch, after the `Self-check:` line: `...this.carryLine(chatId, localOf),`:
```ts
  /** Spec 2026-11-02 §6.3: one line while the chat's planner transcript carries a raised level; /fresh is its exit. */
  private carryLine(chatId: string | null, localOf: (iso: string) => string): string[] {
    const t = chatId ? this.runStore.getTranscriptTrustSince(chatId) : null;
    if (!t || (t.level !== "untrusted" && t.level !== "hostile")) return [];
    return [`Conversation carries ${t.level}${t.at ? ` since ${localOf(t.at)}` : ""} · /fresh clears it`];
  }
```
- [ ] **Step 4: run, see pass** — `npx vitest run tests/run/ tests/gateway/ && npm run typecheck`. Mutations: always set `transcript_trust_at = now` (the "kept while it stays" case fails); show the line for `clean` (case b fails).
- [ ] **Step 5: commit** — `feat(status): /status names a carried trust level and since when`.

---

### Task 11: `/fresh`

**Files:**
- Modify: `src/run/run-store.ts` — `recordPlannerSessionReset` (`:3095–3103`, gains `reason`); new `requestFreshTranscript`, `freshRequestedAt`, `commitFreshTranscript` (beside `getTranscriptTrust`, `:3129`).
- Modify: `src/omp/planner-supervisor.ts` — fields (after `resetGen`, `:338`); `ensureSession` refresh (`:965`); `resetForLessonChange` (`:1167–1186`); new `resetForFresh`, `freshResetFailed`, `freshDue`, `commitFresh`, `onFreshRequested`; `commitReset` (`:788–793`); `finishSuccess` (`:1513–1524`); export `FRESH_FAILED_PREFIX`.
- Create: `src/gateway/fresh-command.ts`
- Modify: `src/domain/types.ts:4` (`| "fresh"`); `src/triggers/telegram-command-parser.ts` (`TelegramCommand` union `:5–29`, `/fresh` branch after `/rearm` `:80`, `parseNoArgs`'s type `:249`); `src/triggers/telegram-trigger-adapter.ts:499–502` (`case "fresh":` joins the group); `src/gateway/gateway.ts` (`GatewayIntakeResult` += `fresh_requested`, dispatch after `rearm` `:293–295`, `HELP_TEXT` `:1590–1611`); `src/telegram/telegram-daemon.ts` `onPlannerControl` (`:491–505`).
- Test: `tests/omp/planner-supervisor-fresh.test.ts` (new), `tests/run/loud-degradation-store.test.ts` (marker cases), `tests/gateway/fresh-command.test.ts` (new), the parser test file.
- Modify (test helper): `tests/helpers/supervisor-harness.ts` — `Script` gains `beforePrompt?: (text: string) => Promise<void>`, awaited inside `prompt` (after the `promptError` check, before it records the prompt and resolves): `if (script.beforePrompt) await script.beforePrompt(t);`. It holds the prompt RPC open, so a test can act between the reset and `commitReset` (`planner-supervisor.ts:706`), the N2 window (review blocker). Existing scripts are unaffected (the field is optional).
- Protected: `src/run/run-store.ts`, `src/omp/planner-supervisor.ts`

**Interfaces — Consumes:** Task 2 columns; Task 9 `carryLevel`; Task 10 `transcript_trust_at`. **Produces:**
```ts
// run-store.ts
recordPlannerSessionReset(chat_id: string, lesson_fingerprint: string, now: string, reason?: "lesson_change" | "fresh"): void;
requestFreshTranscript(chat_id: string, now: string): void;           // upsert (P21b)
freshRequestedAt(chat_id: string): string | null;
commitFreshTranscript(chat_id: string, served: string, now: string): boolean; // one UPDATE … WHERE fresh_requested_at = served
// planner-supervisor.ts
export const FRESH_FAILED_PREFIX = "Could not start a fresh conversation; this reply continues the old one.";
PlannerSupervisor.onFreshRequested(): Promise<void>;
// src/gateway/fresh-command.ts
export const FRESH_REPLY = "The next message starts a fresh conversation; the planner will not see earlier turns.";
export function handleFresh(store: RunStore, event: TypedTaskEvent, now: string): GatewayIntakeResult;
```

Ruling P31 (in the Rulings list) applies here: a fresh reset does not seed.

- [ ] **Step 1: failing tests.** Store (`tests/run/loud-degradation-store.test.ts`):
```ts
describe("the /fresh marker", () => {
  it("is an upsert, survives a reopen, and only the commit that serves the stored request clears it (N2)", () => {
    const path = fileStore();
    const a = RunStore.open(path);
    a.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");                     // no row yet: inserted (P21b)
    a.close();
    const b = RunStore.open(path);
    expect(b.freshRequestedAt("42")).toBe("2026-11-02T01:00:00.000Z");
    b.requestFreshTranscript("42", "2026-11-02T02:00:00.000Z");                     // a second /fresh replaces it
    b.setTranscriptTrust("42", "hostile", "2026-11-02T00:00:00.000Z");
    expect(b.commitFreshTranscript("42", "2026-11-02T01:00:00.000Z", "2026-11-02T03:00:00.000Z")).toBe(false);
    expect(b.freshRequestedAt("42")).toBe("2026-11-02T02:00:00.000Z");
    expect(b.commitFreshTranscript("42", "2026-11-02T02:00:00.000Z", "2026-11-02T03:00:00.000Z")).toBe(true);
    expect([b.freshRequestedAt("42"), b.getTranscriptTrustSince("42")]).toEqual([null, { level: "clean", at: "2026-11-02T03:00:00.000Z" }]);
    b.close();
  });
  it("a fresh reset records reason fresh and no seed (P31); a lesson reset still seeds", () => {
    const s = RunStore.openInMemory();
    s.recordPlannerSessionReset("42", "fp", "t", "fresh");
    expect(s.getPlannerSessionState("42")).toMatchObject({ pending_fingerprint: "fp", seed_pending: 0 });
    s.recordPlannerSessionReset("43", "fp", "t");
    expect(s.getPlannerSessionState("43")).toMatchObject({ seed_pending: 1 });
    expect(s.getLedgerEvents().filter((e) => e.event_type === "planner_session_reset").map((e) => (e.payload as { reason: string }).reason)).toEqual(["fresh", "lesson_change"]);
    s.close();
  });
});
```
`tests/omp/planner-supervisor-fresh.test.ts` (harness from `tests/helpers/supervisor-harness.ts`; `heldSession` for a live turn):
```ts
import { afterEach, describe, expect, it } from "vitest";
import { FRESH_FAILED_PREFIX, type PlannerSupervisor } from "../../src/omp/planner-supervisor.js";
import { PlannerRpcError } from "../../src/omp/planner-session.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { setSharedOmpVersionCacheForTest } from "../../src/omp/omp-version-cache.js";
import { cleanups, fakeSession, harness, heldSession, req } from "../helpers/supervisor-harness.js";

// Spec 2026-11-02 §6.2: the transcript carried `hostile` for 19 days and nothing could start a new one. /fresh is that exit:
// persisted (a restart or a child exit cannot lose it), honoured at the next start whatever the lesson set, committed only by
// the reset that served it, and a failed reset never pretends — the reply says so and the carry stays.
afterEach(async () => { setSharedOmpVersionCacheForTest(null); for (const c of cleanups.splice(0)) await c(); }); // the harness's own idiom (planner-supervisor.test.ts:22)
const turnTrust = (store: ReturnType<typeof harness>["store"], run: string) =>
  store.getLedgerEvents(run).filter((e) => e.event_type === "turn_trust").map((e) => e.payload);
const resetReasons = (store: ReturnType<typeof harness>["store"]) =>
  store.getLedgerEvents().filter((e) => e.event_type === "planner_session_reset").map((e) => (e.payload as { reason: string }).reason);
const run = async (h: { store: ReturnType<typeof harness>["store"]; sup: PlannerSupervisor }) => { const id = createQueuedTurnRun(h.store); h.sup.submit(req(id)); await h.sup.whenIdle(); return id; };
/** The reset rows this case added: harness() with sessionState "current" seeds one lesson_change row (supervisor-harness.ts:195–197). */
const newResets = (store: ReturnType<typeof harness>["store"], base: number) => resetReasons(store).slice(base);

describe("/fresh", () => {
  it("idle child: it stops now; the next turn resets, carries nothing, commits clean and clears the marker", async () => {
    const h = harness(); const base = resetReasons(h.store).length; // 1: the harness seed
    await run(h);
    h.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await h.sup.onFreshRequested();
    expect(h.sup.state()).toBe("STOPPED");
    const next = await run(h);
    expect([h.session.resets, newResets(h.store, base), turnTrust(h.store, next)]).toEqual([1, ["fresh"], []]);
    expect([h.store.freshRequestedAt("42"), h.store.getTranscriptTrust("42")]).toEqual([null, "clean"]);
  });
  it("turn in flight: the turn is not cancelled; the next turn is fresh", async () => {
    const held = heldSession(); const h = harness(held.session);
    const first = createQueuedTurnRun(h.store); h.sup.submit(req(first)); await held.live();
    h.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await h.sup.onFreshRequested();
    expect(h.sup.state()).toBe("RUNNING");
    held.end(); await h.sup.whenIdle();
    expect(h.store.getRunState(first)).toBe("completed");
    const next = createQueuedTurnRun(h.store); h.sup.submit(req(next)); await held.live(2); held.end(); await h.sup.whenIdle();
    expect([held.session.resets, turnTrust(h.store, next), h.store.freshRequestedAt("42")]).toEqual([1, [], null]);
  });
  it("a daemon restart between /fresh and the next turn: still fresh", async () => {
    const a = harness();
    await run(a);
    a.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
    a.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await a.sup.shutdown();
    const b = harness(fakeSession(), {}, {}, { store: a.store });
    const next = await run(b);
    expect([b.session.resets, turnTrust(b.store, next), b.store.freshRequestedAt("42")]).toEqual([1, [], null]);
  });
  it("a failed reset: served on the old transcript with its carry, the prefix sent, the marker kept, the incident open", async () => {
    const h = harness(fakeSession({ newSession: async () => { throw new PlannerRpcError("command_failed:new_session"); } }));
    h.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    const id = await run(h);
    expect(turnTrust(h.store, id)).toEqual([{ level: "hostile", cause: "carried_hostile" }]);
    expect((h.outcome.done[0] as { text: string }).text.startsWith(`${FRESH_FAILED_PREFIX}\n\n`)).toBe(true);
    // P21e: the stored assistant chat turn for `id` is the planner's own text (read it with the store's chat_turns reader, e.g. the one
    // recentTelegramUserTurns uses) and does not start with FRESH_FAILED_PREFIX
    expect(h.store.freshRequestedAt("42")).toBe("2026-11-02T01:00:00.000Z");
    expect(h.outcome.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ k: "planner_session_reset_failed" })]));
  });
  it("N2: a /fresh written while a lesson-reset child's first prompt RPC is in flight survives that turn's commit", async () => {
    // The marker is written INSIDE the prompt RPC (beforePrompt), i.e. after the lesson reset and before commitReset
    // (planner-supervisor.ts:706): the window codex's N2 named. Writing it after held.live() would land after the commit.
    let h!: ReturnType<typeof harness>; let prompts = 0;
    const session = fakeSession({ beforePrompt: async () => { if (++prompts === 1) h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z"); } });
    h = harness(session, {}, {}, { sessionState: "none" }); // no stored lesson set → a lesson reset at spawn
    const base = resetReasons(h.store).length;              // 0: sessionState "none" seeds nothing
    await run(h);
    expect(newResets(h.store, base)).toEqual(["lesson_change"]);
    expect(h.store.getPlannerSessionState("42")?.pending_fingerprint).toBeNull();      // the lesson reset WAS committed …
    expect(h.store.freshRequestedAt("42")).toBe("2026-11-02T01:00:00.000Z");        // … and did not consume the marker
    await run(h);
    expect([newResets(h.store, base), h.store.freshRequestedAt("42"), session.resets]).toEqual([["lesson_change", "fresh"], null, 2]);
  });
  it("is honoured with HOUGE_LESSON_SESSION_RESET off (P21a)", async () => {
    const h = harness(fakeSession(), {}, { env: { HOUGE_LESSON_SESSION_RESET: "0" } });
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await run(h);
    expect([h.session.resets, h.store.freshRequestedAt("42")]).toEqual([1, null]);
  });
});
```
(Read the harness for: how `extra.env` reaches `resolveLessonSessionReset` (the supervisor reads `this.d.env`); `heldSession().live(n)`/`end()`; `outcome.done` / `outcome.incidents`' shapes (`k` is the incident kind); and the store's chat_turns reader for the P21e assertion: the run's assistant turn `text` is the planner's own reply, without the prefix — write it as a real `expect`.)

`tests/gateway/fresh-command.test.ts`: a Telegram `/fresh` through the parser → adapter → `Gateway.intake` returns `{ ok: true, status: "fresh_requested" }`, sets the marker for the event's chat, and queues exactly one reply whose text is `FRESH_REPLY`; a redelivered update (same idempotency key) writes no second marker instant; `/fresh extra` is a parse error (`parseNoArgs`); `HELP_TEXT` contains a `/fresh` line. A daemon-level case (where `onPlannerControl` is reachable — export it if it is not): status `fresh_requested` calls `onFreshRequested()` on every supervisor.

- [ ] **Step 2: run, see fail.**

- [ ] **Step 3: implement.**

`run-store.ts`:
```ts
  /** A fresh omp session was started: store it as PENDING and ledger the reset. A lesson reset seeds the next dispatch; a /fresh one does not (plan P31). */
  recordPlannerSessionReset(chat_id: string, lesson_fingerprint: string, now: string, reason: "lesson_change" | "fresh" = "lesson_change"): void {
    const seed = reason === "fresh" ? 0 : 1;
    this.inTransaction(() => {
      this.db.prepare(`
        INSERT INTO planner_session_state (chat_id, lesson_fingerprint, pending_fingerprint, seed_pending, updated_at) VALUES (?, '', ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET pending_fingerprint = excluded.pending_fingerprint, seed_pending = excluded.seed_pending, updated_at = excluded.updated_at
      `).run(chat_id, lesson_fingerprint, seed, now);
      this.recordMemoryEvent("planner_session_reset", { reason, chat_id }, `planner:${chat_id}`);
    });
  }

  /** /fresh (spec 2026-11-02 §6.2): the request's instant, persisted (a restart or a child exit cannot lose it). An upsert (P21b). */
  requestFreshTranscript(chat_id: string, now: string): void {
    this.db.prepare(`
      INSERT INTO planner_session_state (chat_id, lesson_fingerprint, seed_pending, updated_at, fresh_requested_at) VALUES (?, '', 0, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET fresh_requested_at = excluded.fresh_requested_at
    `).run(chat_id, now, now);
  }

  freshRequestedAt(chat_id: string): string | null {
    return this.db.prepare(`SELECT fresh_requested_at FROM planner_session_state WHERE chat_id = ?`).get<{ fresh_requested_at: string | null }>(chat_id)?.fresh_requested_at ?? null;
  }

  /** The commit that serves a /fresh (N2): one statement clears the marker and stores `clean` only while it still holds `served`. */
  commitFreshTranscript(chat_id: string, served: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE planner_session_state SET fresh_requested_at = NULL, transcript_trust = 'clean', transcript_trust_at = ? WHERE chat_id = ? AND fresh_requested_at = ?
    `).run(now, chat_id, served).changes === 1;
  }
```
`planner-supervisor.ts`:
```ts
/** Spec 2026-11-02 §6.2: the fixed first line of a reply served from the old transcript after a failed /fresh reset. */
export const FRESH_FAILED_PREFIX = "Could not start a fresh conversation; this reply continues the old one.";

  // fields, after resetGen:
  /** /fresh (spec 2026-11-02 §6.2, N2): the request this child's reset served, bound to its generation; only its commit clears that request. */
  private servedFresh: { gen: number; at: string } | undefined;
  /** The /fresh marker a start already tried (P21f): a live child is restarted at a turn start only for a marker it has not tried. */
  private freshTried: string | undefined;
  /** The child generation serving the old transcript after a failed /fresh reset: its replies carry FRESH_FAILED_PREFIX (N1). */
  private freshFailedGen = 0;

  // ensureSession: const refresh = this.stale || this.freshDue() || systemPromptFingerprint(turnContext, chatId) !== this.fingerprint;

  /** A /fresh this child has not tried yet; an unreadable marker is no request (the next start reads it again). */
  private freshDue(): boolean {
    try {
      const at = this.d.store.freshRequestedAt(this.d.chatId);
      return at !== null && at !== this.freshTried;
    } catch (e) {
      console.error(`planner supervisor: fresh marker unreadable (${message(e)})`);
      return false;
    }
  }

  /** /fresh: an idle live child stops now, so the next turn spawns and resets; a turn in flight is never cancelled (freshDue restarts at the next start). */
  async onFreshRequested(): Promise<void> {
    if (this.busy || this.startInFlight || !this.session) return;
    await this.stopSession();
  }

  // resetForLessonChange: after `const fingerprint = this.lessonFingerprint;` insert
  //   const fresh = store.freshRequestedAt(chatId);
  //   if (fresh !== null) return this.resetForFresh(s, gen, fresh);
  // (before the flag check: /fresh is honoured with the lesson flag off, P21a). The rest is unchanged.

  /**
   * /fresh (spec 2026-11-02 §6.2): honoured at every start, whatever the lesson fingerprint. The lesson set is recorded and
   * promoted as on the lesson path (P21c). A failure never degrades silently into "fresh" (N1, freshResetFailed).
   */
  private async resetForFresh(s: PlannerSessionLike, gen: number, at: string): Promise<string | null> {
    const { store, chatId, env } = this.d;
    this.freshTried = at;
    const committed = store.getPlannerSessionState(chatId)?.lesson_fingerprint ?? "";
    const fingerprint = this.lessonFingerprint ?? committed;
    try {
      if ((await s.newSession()).cancelled) throw new PlannerRpcError("new_session_cancelled");
    } catch (e) {
      if (gen !== this.gen || this.session !== s) return START_SUPERSEDED;
      return this.freshResetFailed(gen, e, resolveLessonSessionReset(env) && fingerprint !== committed ? fingerprint : undefined);
    }
    store.recordPlannerSessionReset(chatId, fingerprint, new Date().toISOString(), "fresh");
    if (gen !== this.gen || this.session !== s) return START_SUPERSEDED;
    this.resetGen = gen;
    this.servedFresh = { gen, at };
    return this.resetOk();
  }

  /**
   * A failed /fresh reset (N1): planner_session_reset_failed opens, the marker stays, and this child serves the resumed old
   * transcript with its carry (no resetGen) and FRESH_FAILED_PREFIX on its replies. When the lesson set also changed, the
   * lesson rule decides the spawn first (failures 1–2 fail it; P21d).
   */
  private freshResetFailed(gen: number, e: unknown, lessonFingerprint: string | undefined): string | null {
    if (lessonFingerprint !== undefined) {
      const refused = this.resetFailed(lessonFingerprint, e);
      if (refused !== null) return refused;
    } else {
      this.incident("planner_session_reset_failed", { reason: rpcCode(e) });
    }
    this.freshFailedGen = gen;
    return null;
  }

  // commitReset: after `turn.committedFresh = true;` add `this.commitFresh(turn);`

  /** Spec §6.2 (N2): clears the /fresh marker only when this child's reset served the request still stored. */
  private commitFresh(turn: Turn): void {
    const served = this.servedFresh;
    if (!served || served.gen !== turn.childGen) return;
    this.servedFresh = undefined;
    try { this.d.store.commitFreshTranscript(this.d.chatId, served.at, new Date().toISOString()); }
    catch (e) { console.error(`planner supervisor: fresh_commit_not_written (${message(e)})`); }
  }

  // finishSuccess: the outgoing text carries the prefix; the stored assistant turn stays the planner's own (P21e)
  //   const sent = this.freshFailedGen !== 0 && this.freshFailedGen === t.childGen ? `${FRESH_FAILED_PREFIX}\n\n${text}` : text;
  //   const base = { worker_id: t.worker, text: sent, duration_ms: …, tool_calls: … };
  //   store.recordChatTurn({ …, text, … })  ← unchanged, the unprefixed text
```
(`resetForFresh` is called from `resetForLessonChange`, which the spawn path already awaits under `resetOrRefuse`, `:1148`; a refused fresh reset therefore stops the child and fails the spawn exactly as a refused lesson reset does.)

`src/gateway/fresh-command.ts`:
```ts
import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/** Spec 2026-11-02 §6.2: the reset happens at the next start, so the reply does not claim it already has. */
export const FRESH_REPLY = "The next message starts a fresh conversation; the planner will not see earlier turns.";

/**
 * `/fresh` (Paco only, as every command: the adapter's allowlist). Writes the persisted marker for the chat; the daemon then
 * stops an idle planner child (onPlannerControl). Only a Telegram event can carry it (the parser), so the non-chat branch is
 * unreachable from the poll loop and needs no HANDLED_INTAKE_DENIAL_CODES entry.
 */
export function handleFresh(store: RunStore, event: TypedTaskEvent, now: string): GatewayIntakeResult {
  if (event.notify.kind !== "telegram") return { ok: false, error: { code: "TELEGRAM_COMMAND_UNSUPPORTED", message: "/fresh is a chat command" } };
  const chat = event.notify.chat_id;
  return oncePerTrigger(store, event, () => {
    store.requestFreshTranscript(chat, now);
    replyTo(store, event, "fresh", FRESH_REPLY);
    return { ok: true, status: "fresh_requested", run_id: "" };
  });
}
```
`gateway.ts`: `| { ok: true; status: "fresh_requested"; run_id: string }`; after the `rearm` branch: `if (event.type === "fresh") return this.accepted(event, now, handleFresh(this.runStore, event, now));`; `HELP_TEXT` after the `/models` line: `"/fresh — 开始新对话（规划器不再看到之前的对话，清除携带的信任级别）",`. Parser: `| { type: "fresh" }`; `if (command === "/fresh") return parseNoArgs("fresh", rest);` (with the comment "spec 2026-11-02 §6.2"); `parseNoArgs`'s type `Extract<TaskEventType, "disarm" | "rearm" | "approvals" | "fresh">`. Adapter: `case "fresh":` beside `case "approvals":`. `domain/types.ts`: `| "fresh"`. `telegram-daemon.ts` `onPlannerControl`, first branch:
```ts
  if (status === "fresh_requested") {
    // Spec 2026-11-02 §6.2: the marker is persisted; an idle child stops now so the next turn spawns and resets.
    for (const s of worker.plannerSupervisors()) void s.onFreshRequested().catch((e) => console.error(`[telegram-daemon] /fresh stop failed: ${errorCode(e)}`));
    return;
  }
```

- [ ] **Step 4: run, see pass** — `npx vitest run tests/omp/ tests/run/ tests/gateway/ tests/triggers/ tests/telegram/ && npm run typecheck`; rerun `tests/omp/planner-supervisor.test.ts` alone if a P29 flake shows. Mutations (each failing, reverted): `commitFreshTranscript` without `AND fresh_requested_at = ?` (the store N2 case fails); `commitFresh` ignoring `servedFresh` — clearing whatever marker is stored at any commit, e.g. `commitFreshTranscript(chatId, store.freshRequestedAt(chatId) ?? "", now)` before the `served` check (the supervisor N2 case fails: the marker is gone after turn 1); `freshResetFailed` returning `null` without setting `freshFailedGen` (prefix case fails); `freshDue` returning false always (in-flight case fails: no reset on the next turn); the fresh check placed after the flag check (P21a case fails); `seed_pending` 1 for fresh (P31 store case fails).
- [ ] **Step 5: commit** — `feat(planner): /fresh — a persisted request for a new transcript, honoured at the next start, committed only by the reset that served it`.

---
### Task 12: Live gate, Part A — `scripts/live-gate-model-tiers.mjs`

**Files:** Create `scripts/live-gate-model-tiers.mjs`. Pattern: `scripts/live-gate-ladder-remainder-r4.mjs` (read whole: header, pins, VACUUM copy, `verdict`, `runLine`, `errCode`, cleanup on every exit path) and `scripts/stage4-diff-lib.mjs` (`initTemp`, `cleanupTemp`, `loadDist`, `redactForPrint`, `SetupError`).

**Header contract** (write it at the top, as the R4 gate does): run from the worktree after `npm run build` there; `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-model-tiers.mjs [--live-db <path>]`; refuses unless `DIST` contains `/.worktrees/`; six lines `PASS|FAIL <n> <name> — <detail>`, exit 0 only when all six PASS (1 FAIL, 2 setup error); the live DB opened read-only once by `VACUUM INTO` a temp copy, removed on every exit path; pins set before any store opens and restored on exit: `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` under the temp root (P2), `HOUGE_TELEGRAM_CHAT_ID=-1003` (P3), `HOUGE_MODEL_ROLES` deleted (resolved mode), scheduler/radar/media flags deleted. **This gate spends real subscription quota**: the catalog read and about seven one-line probes (`Reply with exactly OK.`) through the one-shot seat under profile `houge`, as the daemon's tick will. It never starts a planner child and never talks to Telegram (no client; the outbox of the copy is the only sink, and it is deleted). Prints: line names, counts, booleans, closed codes and catalog selectors only (code-owned strings); never a model reply, an `error_ref`, or a live-DB id.

**Setup:** VACUUM copy → before `RunStore.open`, read the raw copy's `schema_migrations` for `2026-11-02-loud-degradation` (print `fresh_migration` or `already_migrated`; a copy taken after the ship already holds tick-written rows — then lines 1 and 3 compare against the copy's rows, not the seed: say so in the detail). Open with the dist `RunStore`; `cfg = resolveOmpConfig(process.env)`; `catalog = await readOmpCatalog(cfg)` (null → setup error 2, "catalog unavailable"); `PLANTED = { provider: "google-antigravity", id: "gemini-3.1-pro", thinking: null }`; `roles = new RoleResolver({ store, env: () => process.env, readCatalog: async () => [...catalog, PLANTED] })`; `await roles.refreshCatalog()`. `now` per P27 (latest `model_roles_resolved.resolved_at` + 25 h, else wall clock).

**Lines** (spec §9 Part A; exact values, P4):
1. `seed_resolution` — before any tick: `roles.resolveAll()` keys with `head === null` are exactly `["judges:2"]`; every other key's head equals the first selector of `roleSelectors(role, seat, "resolved", tierHeadsOf(store.listModelTiers()))` that the real catalog lists (computed in the gate from the dist exports), **and** that is the seed head's selector for that key's first leg (i.e. no key fell back to static). Detail: `null_heads=[judges:2] fallbacks=0`.
2. `static_seat_2` — `staticRoleChains().judges.length === 2` and `judgeSeat(resolveOmpConfig(process.env, roles.chains()), 2)` is `[]` and `roles.chains().judges[2] === undefined`.
3. `planted_retired` — run the dist `runModelRolesTick({ store, roles, probe: ompProbe(store, cfg), now, notify, card })` once (notify/card push to arrays). Exactly one `model_probe` row has `tier: "gemini-pro"`, and it equals `{ tier: "gemini-pro", selector: "google-antigravity/gemini-3.1-pro", purpose: "head", result: "model_missing", kind: "model_missing" }`; afterwards `getModelTier("gemini-pro")` has `adopted: null` and `rejected_selector: "google-antigravity/gemini-3.1-pro"`; the notices contain `failedLine("google-antigravity/gemini-3.1-pro", null)` exactly once (compare to the dist export).
4. `real_tick_no_silent_loss` — every other `model_probe` row of that tick has `result ∈ {pass, inconclusive, model_missing}`, and `applyProbe`'s exact per-row effect holds on the `model_tiers` row after the tick (recomputed in the gate from the pre-tick row with the dist `planTier`/`applyProbe` and the row's outcome): `pass` head → `adopted` = the probed id, `previous` = the old head; `pass` previous → `previous` = the probed id; `model_missing` → `adopted`/`previous` unchanged and `rejected_selector` = that selector; `inconclusive` → unchanged. A `model_missing` on a catalogued, non-planted member is the code working (spec §3: the catalog is not the subscription): it prints an INFO line `INFO model_missing <selector>` (a catalog string), never a FAIL (review W4); after the tick `resolveAll()` keys with `head === null` are still exactly `["judges:2"]`; the number of `model_probe` rows equals the number of tiers whose plan had a probe (recompute the plans in the gate with the dist `planTier` over the pre-tick rows and `[...catalog, PLANTED]`). Detail: `probes=<n> pass=<n> inconclusive=<n>`.
5. `one_card` — the tick's `card` calls are exactly one, `{ tier: "gemini-pro", keys: ["judges:2"] }` with `proposals[0] === "gemini-4-argon"`; the gate then calls the dist `enqueueTierCard(store, "-1003", now, card)` and checks one outbox row keyed `model_tier_card:gemini-pro:<date>` whose `payload.text === tierCardText(card)` and whose first button's `data === tierCallbackData("gemini-pro", "gemini-4-argon")`.
6. `tap_probe_then_override` — a dist `Gateway(store, undefined, undefined, undefined, undefined, { roles, modelProbe: ompProbe(store, cfg) })`; intake a `model_tier_tap` event (chat `-1003`, `metadata: { tier: "gemini-pro", model_hash: tierModelHash("gemini-4-argon") }`); `await gw.whenTierTapsSettled()`. PASS: the newest `model_probe` row is `{ tier: "gemini-pro", selector: "google-antigravity/gemini-4-argon", purpose: "tap", result: "pass", kind: "ok" }`; `latestModelRoleOverrides().get("judges:2") === "gemini-4-argon"`; `roles.resolveAll()` `judges:2` head `=== "google-antigravity/gemini-4-argon"`; the event's outbox rows are exactly two (the 🔎 and ✅ texts, compared to the strings in `model-tier-commands.ts`). If the probe comes back inconclusive (quota), the line FAILs with `kind` in the detail: the gate is rerun later, never weakened.

**`--only <n>[,<n>]`** (review suggestion, the R4 gate's precedent): run only the named lines plus the setup they need (line 6 needs line 3's tick for the empty `gemini-pro` tier; `--only 6` runs the tick without asserting line 3), so a mutation rerun spends only its own probes.

**Mutations (show each failing once, then restore — on a scratch copy of `dist/`, never the source; each rerun with `--only` its line):** line 1 — seed `gemini-pro` with `gemini-4-argon` in the dist `SEED_HEADS` (null-heads set changes); line 3 — make the dist `probeKindOf` return `classifyOmpError(error)` always (`result` becomes `inconclusive`); line 6 — swap the order in `probeThenAdopt` so the override is written before the probe and the probe answer is forced `model_missing` (override present → FAIL).

- [ ] **Step 1:** write the gate; `node --check`; `npm run build`; run it from the worktree with `HOUGE_ENV_FILE=…`: 6 PASS, exit 0. Paste the six lines in the task report.
- [ ] **Step 2:** the three mutations, each FAIL once; restored; rerun 6 PASS.
- [ ] **Step 3:** rerun `scripts/live-gate-jev-tree.mjs` (its role-heads cases changed in Task 3): exit 0 (or report the cases that read live data and drifted, P8 of the R4 plan).
- [ ] **Step 4: commit** — `test(gate): model tiers live gate — seed, planted retirement, real probes, the card and its tap on a copy of the live DB`.

---

### Task 13: Live gate, Parts B and C — `scripts/live-gate-loud-degradation.mjs`

**Files:** Create `scripts/live-gate-loud-degradation.mjs`. Patterns: `scripts/live-gate-ladder-remainder-r4.mjs` (header, pins, copy lifecycle, the fake-session supervisor through `scripts/stage4-supervisor-fixture.mjs`: `mkSupervisor`, `fakeSession` with `script.onPrompt`, `req`, `cleanup`, chat `"42"`), and `scripts/live-gate-omp.mjs` `runSmoke` (`:761–790`: `loadHougeEnv`, `smokeEnv`, a temp data root under `/tmp/hg-…` short enough for `sun_path`, `new CoreWorker(store, repo, …12 undefined…, { dataDir: root, distDir: DIST })`, `worker.submitTurn`, `worker.shutdownPlanners()`) for line 6.

**Header contract:** as Task 12, except the env, set once, in this order, before the copy is made and before any store opens: `loadHougeEnv()` (as `runSmoke` does; line 6 needs omp's config) → `smokeEnv(root, DISARM_FLAGS)` (deletes `HOUGE_TELEGRAM_*`, sets every disarm flag false, pins the tombstone, park marker and disarm paths under the root) → the P2/P3 pins (`HOUGE_TELEGRAM_CHAT_ID=-1003` last) → the VACUUM copy → the store. No value from `.env` can override a pin. Supports `--only <n>` like Task 12. Line 6 starts **real omp RPC children** under profile `houge` in throwaway dirs under the temp root (sessions, workspace, bridge sockets), three short turns (`Reply with exactly OK.`), Jev and every `DISARM_FLAGS` flag off as `--smoke` sets them; the floors deny the live repo as for the daemon. Seven lines; exit 0 only when all PASS.

**Lines** (spec §9 Parts B/C):
1. `boot_resolve` — before `RunStore.open`: `N0` = open `hostile_schedule_turn` rows on the raw copy, and whether `2026-11-02-hostile-schedule-event` is in `schema_migrations`. After open: zero open of that kind; exactly `N0` new `incident_resolved` events whose `incident_id` is one of those `N0` rows. Close and reopen: zero further `incident_resolved` (once). Detail `N0=<n>` (spec §3 expects 3 at writing; any `N0` passes when the counts match, and `N0=0` with the migration already applied prints `already_applied`).
2. `reminder` — compute in the gate, by SQL on the copy, the open incidents of the four `REMIND_KINDS` older than 24 h at `now`; call the dist `runIncidentReminder({ store, chatId: "-1003", env: process.env, now })`. PASS: it returns `"sent"` when that set is non-empty (else `"none"`, and the line checks zero rows); exactly one outbox row keyed `incident_remind:<display date>`, whose text equals the dist `reminderText(listOpenIncidents(), now)`; the text contains `role_unresolved · judges:2` iff that incident is open and older than 24 h on the copy; it contains no `undelivered_notification`; a second call returns `"already"` and the row count stays 1. Then with `HOUGE_MODEL_ROLES=static` set and a fresh date (`now + 1 day`): the reminder is sent again (a second row) — the path does not depend on the roles mode.
3. `carry_then_fresh` — `L` = the copy's `transcript_trust` for the operator chat (`allowlist.chats[0]`, read via the dist allowlist loader or from `HOUGE_TELEGRAM_CHAT_ID` of the env file before the pin — read-only); `store.setTranscriptTrust("42", "hostile", now)` and print `copied` when `L === "hostile"`, else `planted` (the live carry may have been cleared by then). Turn 1 (fake session, chat 42): its `turn_trust` rows are exactly `[{ level: "hostile", cause: "carried_hostile" }]`. Intake `/fresh` through the dist `Gateway` (event chat `"42"`, built with `buildTypedTaskEvent`, type `fresh`) → `{ ok: true, status: "fresh_requested" }`; `await sup.onFreshRequested()`; turn 2: `turn_trust` rows `[]`; `freshRequestedAt("42") === null`; `getTranscriptTrust("42") === "clean"`; the fake session's `resets` rose by exactly 1; exactly one new `planner_session_reset` with `reason: "fresh"`.
4. `withhold_only` — turn 3's `script.onPrompt` raises `injection_withheld` on the active turn (`sup.activeTurnForTest().trust.raise("injection_withheld", "tc")`, then answers): stored `getTranscriptTrust("42") === "untrusted"`; turn 4's `turn_trust` rows are exactly `[{ level: "untrusted", cause: "carried_untrusted" }]`. (Extend the fixture's `fakeSession` with nothing new: it already takes `script.onPrompt`, `scripts/stage4-supervisor-fixture.mjs:49`.)
5. `schedule_turns` — `setTranscriptTrust("42", "hostile")`; a schedule-born turn (`req(id, "x", "schedule")`): zero new `hostile_schedule_turn` incidents (D3-A); then a schedule-born turn whose `onPrompt` raises `unjudged_outside` on a store reset to `clean` first: exactly one new `hostile_schedule_turn` incident, `state = 'resolved'` (an event), and exactly one `incident_opened:<that id>` outbox row to `-1003`.
6. `real_fresh` — real omp (above). On chat `-1003` (no `planner_session_state` row on the copy, so turn A's spawn makes a lesson reset — counted from after turn A): worker A, turn A completes; `S1` = the `*.jsonl` files under `<root>/omp/sessions/chat--1003/` (recursive), newest `f1`. `/fresh` through the dist `Gateway` for chat `-1003`; for every `workerA.plannerSupervisors()` call `onFreshRequested()`; `await workerA.shutdownPlanners()` (the restart). Worker B (new `CoreWorker`, same store and root): turn B completes; `S2` = `S1` plus exactly one new file `f2 ≠ f1`, and `f2` is the newest; exactly one new `planner_session_reset {reason: "fresh"}`; `freshRequestedAt("-1003") === null`; turn B has no `turn_trust` row with a `carried_*` cause. `shutdownPlanners()`; worker C: turn C completes; the file set is still `S2` (it resumed `f2`), and no new `planner_session_reset`. Detail: file counts and booleans only. (Before writing the assertion, run turn A once and print the directory layout's depth and file count to stderr, to confirm where omp writes session files — the contract probe drives the same `PlannerSession`; a different layout changes only the glob, never the PASS meaning: "the transcript turn B ran on is a new one, and turn C resumed it".)
7. `no_secret_print` — the gate's own stdout captured so far contains none of: the env file's values for keys matching `/TOKEN|KEY|SECRET|PASSWORD/`, the operator chat id, `error_ref`. (A self-check of the print contract, lessons R4.)

**Mutations (scratch `dist/` copy):** line 1 — drop the migration's version check (the reopen produces more `incident_resolved` rows); line 3 — `commitFresh` without the generation check is not reachable here, so instead make `resetForFresh` skip `servedFresh` (marker stays → FAIL); line 4 — `endTrust` storing `trust.level()` (`hostile` → FAIL); line 5 — `onHostile` paging before the `carried` return (D3-A → FAIL).

- [ ] **Step 1:** write the gate; `node --check`; build; run from the worktree: 7 PASS, exit 0; paste the lines.
- [ ] **Step 2:** the four mutations, each FAIL once; restored; rerun 7 PASS.
- [ ] **Step 3: commit** — `test(gate): loud degradation live gate — boot resolve, reminder, carry and /fresh on a copy, a real omp /fresh across a restart`.

---

### Task 14: Rollback check — `scripts/check-loud-degradation-rollback.mjs`

**Files:** Create `scripts/check-loud-degradation-rollback.mjs`; Modify `scripts/stage4-diff-lib.mjs` (`dumpDb`, Step 0). Pattern: `scripts/check-ladder-remainder-r4-rollback.mjs` (read whole) and `scripts/old-dist-provenance.mjs` (`verifyStampedDist`, `mergeBaseOf`, `provenanceText`); provenance file `omp/model-roles-tick.js` (lessons 4A: name the compiled file this slice changes).

- [ ] **Step 0: the stage-4 differential (P32).** `scripts/stage4-diff-lib.mjs:184` `dumpDb` dumps every regular table, so every pair (old build vs this dist) now differs by `model_tiers` (8 seeded rows), the two `schema_migrations` rows and the two `planner_session_state` columns. Add to `dumpDb` a named, slice-scoped normalisation (`LOUD_DEGRADATION_NEW`: drop table `model_tiers`; drop `schema_migrations` rows whose `version` is `2026-11-02-loud-degradation` or `2026-11-02-hostile-schedule-event`; drop the keys `fresh_requested_at`, `transcript_trust_at` from `planner_session_state` rows) — drop only these names, never a pattern (lessons 4C: default to relabelling; here the objects do not exist on the old side at all). Then run the full differential with every pair's flags (the invocation in the R4 plan's Task 3 Step 5 plus `--old-dist-r4 … --old-base-r4 …`): every corpus PASS. A corpus that still differs must trace to a spec change (D2-A carry, `hostile_schedule_turn` as an event, D3-A): name it, and fix it with an expectation update in a `fix(gate):` commit, never a broader strip. Commit `test(gate): differential drops the loud-degradation tables and columns the old builds never had`.
- [ ] **Step 1: old build (P1).** `MB=$(git merge-base HEAD main)`; verify `git diff --stat df4176f $MB -- src scripts tests` is empty (stop and report if not); `git worktree add .worktrees/base-${MB:0:12} $MB`; in it `npm ci && npm run build`; from the main checkout `node scripts/stamp-dist.mjs .worktrees/base-${MB:0:12}`.
- [ ] **Step 2: write the check.** Two VACUUM copies: A (never touched by the new build) and F (cut from A, then written by **this** build): open F with the new dist (migrations: `model_tiers` seeded, two columns, the boot resolve); seed through the new code paths: a `model_probe` row, a tier write (`kimi` → `k3.1-pro`/`k3`), a `model_roles_resolved` row from the new tick (a `RoleResolver` over `tests/fixtures/omp-catalog-2026-11-02.json`, `probe` absent, `now` per P27), `requestFreshTranscript("42", …)`, `setTranscriptTrust("42", "untrusted", …)` (so `transcript_trust_at` is set), and one `idea_panel_tick` row with `judge_models`. Then the **old** dist (`--old-dist .worktrees/base-<sha>/dist`, verified by `verifyStampedDist`) opens A and F. Lines, each exact:
  1. `schema_stable` — the old build opens F without throwing; `sqlite_master` of F minus A is exactly `{ table model_tiers }`; `PRAGMA table_info(planner_session_state)` of F minus A is exactly `{fresh_requested_at, transcript_trust_at}`; the old build's own migration rows are untouched (`schema_migrations` of F minus A is exactly the two new versions).
  2. `models_renders` — the old `modelsListText(store, roles)` (old `RoleResolver` over the fixture catalog) renders on F without throwing, and its text equals the same render on A (the old build ignores `model_tiers`).
  3. `status_renders` — the old `/status` (old `Gateway.intake` of a `status` event for chat `"42"`) renders on F; every line equals A's render except the activity counts the seeding added (compare with those lines masked, list the masked line names in the detail).
  4. `old_change_diff_reads_new_payload` — the old `runModelRolesTick` on F with a fake `roles` whose `resolveAll` returns the new row's keys with one head changed (`tiny` → `kimi-code/k3:low`), `now` = the new row's `resolved_at` + 25 h: it returns `changed: ["tiny"]` and exactly one notice, the old `changeLine("tiny", <new row's tiny head>, "kimi-code/k3:low")` — the old diff reads the new payload's `key` and `head`.
  5. `carry_still_carries` — the old supervisor (old dist through `scripts/stage4-supervisor-fixture.mjs`'s `mkSupervisor(oldDist, storeF)`) runs one turn on chat `42`: its `turn_trust` rows are exactly `[{ level: "untrusted", cause: "carried_untrusted" }]` (the old build reads `transcript_trust` and ignores the marker and the new column). This depends on `mkSupervisor` re-recording and promoting the current lesson fingerprint for chat 42 first (`scripts/stage4-supervisor-fixture.mjs:90–91`): `requestFreshTranscript` may have inserted the row with `lesson_fingerprint = ''`, and without that step the old supervisor would lesson-reset at spawn, start clean and fail this line for the wrong reason. Keep the step; say so in a comment.
  6. `new_reopens` — the new build reopens F after the old build wrote to it: no throw; `listModelTiers()` unchanged; `freshRequestedAt("42")` unchanged.
- [ ] **Step 3: run** — every line PASS, exit 0; plant one mutation (point `--old-dist` at the new dist: `same_build` setup error, exit 2), and one line mutation (line 4: change the fake head to the same value → `changed: []` FAIL). Paste the output.
- [ ] **Step 4: commit** — `test(gate): loud degradation rollback — the merge-base build reads the new schema, payloads and carry`.

---

### Task 15: Docs sync

**Files** (placement rules: `CONTRIBUTING.md`; protected `docs/decisions/` edited under the approved spec, the amendments marked unsigned):
- `docs/decisions/0028-*.md` — append an amendment section "2026-11-02 — tiers, a probe before adoption, the empty-tier card (**awaiting Paco's signature**)": spec §4 in decision form — tiers replace version lists (D1-A families), adoption only after a probe, `model_missing` remembered 7 days, a judge seat never falls back inside a panel run (the fallback moves to the daily tick; ADR 0027 unchanged), the card (code never adopts a codename without a tap), static re-pinned and checked daily (D4-A), protected files touched including `src/omp/model-catalog.ts` (P8).
- `docs/decisions/0030-*.md` — amendment "2026-11-02 — carry with an exit (**awaiting Paco's signature**)": the cause set and carry levels (D2-A), standing credit follows the stored level (W7), `/fresh` with its commit condition and failure rule, `hostile_schedule_turn` is an event and a carried one does not page (D3-A), the reminder kinds.
- `docs/decisions/README.md` — the index rows for both amendments.
- `docs/reference/configuration.md` — no new env var; add `/fresh` wherever commands are listed there (if they are), and note that `HOUGE_MODEL_ROLES=static` now runs the re-pinned lists with judge seat 2 empty.
- `README.md` — the `/fresh` command (one line beside `/models`), and the model-roles paragraph: tiers and the probe.
- `docs/ROADMAP.md` — delta: this slice shipped before R5; next is R5.
- `tasks/todo.md` — the CURRENT SYSTEM STATE block: tiers live, Kimi on `k3.1-pro` if the first tick adopted it, judge seat 2 state (card sent / tapped), the reminder, `/fresh`; open items: static seat 2 re-pin after Paco's tap (code), the panel's shortlist rows still name seats (P24).
- `tasks/lessons.md` — the slice's lessons (at least: a spec's "classify the adapter's error" was wrong against the code — read the producer's format, P6; a once-per-open throttle needs a reminder for actionable kinds; a carried level needs an exit command, not only a better rule).
- `sessions.md` — one arc entry.

- [ ] **Step 1:** write each; `rg -n "ROLE_LISTS|gemini-3\.1-pro|gpt-5\.5" docs README.md` — every hit either historical (dated) or updated.
- [ ] **Step 2: commit per concern** — `docs(adr): 0028 and 0030 amendments for loud degradation (awaiting Paco's signature)`; `docs: loud degradation — README, configuration, ROADMAP, state block, lessons, session`.

---

## After the tasks (orchestrator)

Full suite + typecheck + build on a quiet machine (lessons 4C), none skipped; both live gates and the rollback check from the worktree; the R4, R3 and jev-tree gates rerun (their role and trust paths moved); final whole-branch reviews on the most capable non-orchestrator model, a mutation pass, and codex whole-diff (`codex exec … < /dev/null -o <file>`, `-s workspace-write` if it runs tests); one fix wave; merge, push, rebuild `dist/`, kickstart (Tier A: check `houge.parked` / `houge.kill` and no run in flight first; verify the new pid and the three new `schema_migrations` rows). Then, on the running daemon: (a) the first daily tick's `model_probe` rows and notice (expect Kimi's adoption and five previous fills); (b) the gemini-pro card reaches Paco; (c) after Paco's own `/fresh`, the next turn has no `carried_*` `turn_trust` row (spec §9); (d) the next morning's reminder lists `role_unresolved judges:2` until the tap.

## Self-review (plan author)

**Spec coverage.** §4.1 tiers/legs/judge rule → Tasks 1, 3; §4.2 probe seam, pass/fail/inconclusive, `model_tiers`, `model_probe`, tick order, `RoleResolver` reads per call, stop → Tasks 2, 4; bootstrap → Task 2 (seed) + Task 3 (`SEED_LISTS` test); catalog outage → Task 4; §4.3 static re-pin, seat 2 empty, stale check resolved-only, unit test of membership → Task 5; §4.4 card, proposals by price, probe-first tap, override in the probe's transaction, one card a day → Tasks 1, 6; §5 `REMIND_KINDS`, own daily path before the model ticks, static and outage, idempotency key, `hostile_schedule_turn` event + boot resolve → Task 8; §6.1 cause set, carry levels, `keepOld`, standing credit (no code change; Task 9's test asserts the stored `untrusted`, and the ADR states it) → Task 9; §6.2 `/fresh` marker, honoured regardless of fingerprint, `servedFresh`, commit condition, failure rule, idle stop, in-flight wait, reply text → Task 11; §6.3 `transcript_trust_at`, `/status` line → Task 10; §6.4 D3-A → Task 9; §2/§8 panel model ids → Task 7; §8 tests → each task's Step 1; §9 gates → Tasks 12, 13 (Paco's post-merge `/fresh` → "After the tasks" (c)); §10 rollback → Task 14; §11 protected files → each task's list (+ P8 `model-catalog.ts`, P7 `run-store.ts` `LlmCallRole`, P16 `run-store.ts:2659`).

**Divergences from the spec text, all ruled:** P6 (kind parsing), P7 (exact adapter call), P8 (`model-catalog.ts`), P12 (seat 2 as a missing index), P15 (card scope), P18 (`/status` in `gateway.ts`), P31 (no seed on `/fresh`).

**Type consistency checked:** `TierId`/`TierHeads`/`SEED_HEADS` (Task 1) used by Tasks 2, 3, 4, 6; `ModelTierRow`/`ModelProbeRow`/`ModelProbeResult` (Task 2) used by Tasks 4, 6; `ProbeFn`/`ProbeOutcome` (Task 4) used by Tasks 6, 12; `TierPlan`/`planTier`/`applyProbe`/`selectorOf` (Task 4) used by Task 12; `EmptyTierCard` (Task 6) used by `model-tier-commands.ts` and Task 12; `carryLevel` (Task 9) used by Task 11's `endTrust` reading; `getTranscriptTrustSince` (Task 10) used by Task 11's store test; `FRESH_FAILED_PREFIX`/`FRESH_REPLY`/`onFreshRequested` (Task 11) used by Task 13.

## Plan Rev 1.1 changes (plan review by claude-fable-5-1, `.superpowers/sdd/loud-degradation/plan-review.md`; each verified against the code first)

| Finding | Verified | Change |
|---|---|---|
| BLOCKER — Task 11's N2 case never enters the window | `fakeSession.prompt` resolves at once (`supervisor-harness.ts:126`); `commitReset` runs as soon as the prompt RPC resolves (`planner-supervisor.ts:706`), so a marker written after `held.live()` lands after the commit | Harness `Script.beforePrompt` (awaited inside `prompt`); the case writes the marker inside the first prompt RPC of a lesson-reset child, asserts the lesson commit happened (`pending_fingerprint` null) and the marker survived, then `["lesson_change", "fresh"]` and marker null next turn. Mutation named: `commitFresh` ignoring `servedFresh` (clearing any stored marker) |
| W1 — P13 partial read wipes tiers | `followRetirement` empties a tier whenever its ids are unlisted | `planTier` returns the tier unchanged with no probe when the catalog lists nothing of its provider; tier-step and tick tests added (no change, no probe, recovery with no probe); the two Rev 1.0 tests that removed the whole provider now remove only the family (`/^k\d/`); P13 amended |
| W2 — Task 11 test file does not compile; reset list wrong | the harness exports `cleanups`, not `cleanup`; `harness()` seeds a `lesson_change` row (`:195–197`) | `cleanups` + the file's `afterEach` idiom; `newResets(store, base)` counts rows added by the case |
| W3 — test ripple under-enumerated | each cited line read | Task 3: `models-commands.test.ts:5,127`, `role-resolver.test.ts:144,168–171,179–181` with exact new values, `idea-panel-seats.ts:14` comment; Task 5: `omp-config.test.ts:16–25`, `idea-panel-seats.test.ts:35–45`, `panel-judge-providers.test.ts:20–32` (found by the re-grep, not in the review); Task 6: `intake-decisions.test.ts:81` exact set; Task 7: `judgeModels` optional on `PanelSeatBindings` (`telegram-daemon.test.ts:718` unchanged), payload field still required. Task 3 Step 0 lists every other grep hit with its disposition |
| W4 — gate line 4 FAILs on a true subscription fact | spec §3 "the catalog is not the subscription" | `model_missing` on a non-planted member is `INFO model_missing <selector>`; line 4 asserts `applyProbe`'s exact per-row effect |
| W5 — tap probe ignores the stop | `probeThenAdopt` had no signal; nothing awaited `tierTaps` | `TierTapDeps.signal` ← Gateway `stopSignal` ← daemon `options.stopSignal`; aborted probe commits nothing; shutdown awaits `whenTierTapsSettled()` with `TIER_TAP_SHUTDOWN_CAP_MS = 5_000`; gateway and daemon tests; P16 amended |
| S — `writeTiers` upserts every row | trivial | write only when the tier changed (`sameTier`) |
| S — `raiseFor`-level D2-A test | `raiseFor` is private (`bridge-handler.ts:538`) | Task 9: a case through `tests/omp/bridge-handler-trust.test.ts`'s judged path |
| S — `cfg.judges` typing hole | `seatChain` returns `cfg.judges` as `ModelString[]` (`registry.ts:135`) | **Rejected**: the retype breaks `registry.ts`'s typecheck, and `registry.ts` stays unchanged (spec §11); P12 records why |
| S — name P8/P15/P18/P31 to Paco | — | already in the ADR rows (Task 15) and the handback |
| S — `--only` for gate reruns | — | Task 12 (and Task 13) take `--only` |
| S — Task 13 header wording | — | one ordered env sequence |
| S — `reminderText` tie-break | — | `incident_id` tie-break; the test rows carry ids |
| S — `correlation_id` in the Task 2 audit assertion | — | compared |
| S — exact shadow-notice list (testing section) | — | Task 4's shadow case compares the whole notice list |
| Task 1 green draft | diffed against the plan: identical code and tests except dropped doc comments | Task 1 points implementers at the draft; no code correction needed |
