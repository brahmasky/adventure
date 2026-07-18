# P2 Bounty Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bounty venue scanning + deterministic legitimacy scoring + durable `projects`/`bounty_sightings` store + 4 loop tools, per `docs/superpowers/specs/2026-07-18-p2-bounty-intake-design.md` (the spec is normative; this plan sequences it).

**Architecture:** One capability module (`bounty-intake.ts`: fetchVenueJson wrapping `fetchUrl`, GitHub/shields adapters, hygiene sanitizer, scorer, scan orchestrator) + RunStore migration/methods + tool-manifest/contract/core-worker wiring. All I/O injectable (DI bundle, extwork pattern).

**Tech Stack:** Node builtins only (deps stay `{}`), node:sqlite via RunStore, vitest.

---

### Task 1: Store — migration + projects/sightings methods + ledger events
**Files:** Modify `src/run/run-store.ts` (applyProjectsMigration `2026-07-18-projects`, registered last in `migrate()`; `ProjectRow`/`BountySightingRow` interfaces; methods `addProject` (idempotent on source_url UNIQUE → return existing), `getProject`, `listProjects(state?)`, `transitionProject` (table: tracked→working→submitted→paid, *→dropped, dropped→tracked; illegal ⇒ throw, no event), `upsertSighting` (non-downgrading: unverified never overwrites substantive verdict/score; times_seen/last_seen_at always bump), `listSightings(urls[])`, `latestBountyScanAt()`; recorders `recordBountyScanCompleted`/`recordProjectCreated`/`recordProjectStateChanged`, actor `core`). Modify `src/run/run-ledger.ts` (3 event types + requiredPayloadFields). Add `src/run/state-machines` project transition guard if that's where run transitions live (follow existing pattern).
**Tests:** `tests/run/projects-store.test.ts` — migration idempotence (open twice), CRUD, duplicate-track idempotency, full transition table incl. illegal, non-downgrading upsert, ledger required-fields.
**Commit:** `feat(p2): projects + bounty_sightings store, transition table, ledger events`

### Task 2: Capability — fetchVenueJson + hygiene + adapters (pure/deterministic parts first)
**Files:** Create `src/capabilities/bounty-intake.ts`:
- `resolveBountyEnabled(env)`, `resolveBountyMaxCandidates(env)` (default 8).
- `fetchVenueJson(url, deps)`: allowlist exact-host (WHATWG hostname, strip trailing dot; api.github.com | algora.io; https; default port) → `deps.fetchUrl(url, {maxBytes: 512_000, timeoutMs: 8_000})` → status 200 gate (3xx/4xx/5xx ⇒ VenueError) → JSON.parse.
- `sanitizeVenueText(s, max)`: strip C0 + bidi (U+202A–202E, U+2066–2069) + zero-width (U+200B–200D, U+FEFF); flatten `\r\n`→space; code-point-boundary truncate.
- `parseAmountUsd(labels/comment)`: numeric, $1–$100_000 bounds else null.
- Grammar guards `isValidOwner/isValidRepo/parseIssueUrl` (`https://github.com/<owner>/<repo>/issues/<n>`).
- `githubSearchAdapter(deps)`: 2 searches (`label:"💎 Bounty" state:open`, `+ commenter:algora-pbc`, per_page 30, sort newest); normalize → `BountyCandidate` (body DISCARDED at parse); window-covered bot_verified set.
- `enrichCandidate(deps, c)`: `/repos/:o/:r` + `/pulls?state=closed&per_page=30` (any merged_at) + shields `algora.io/api/shields/<org>/bounties?status=completed` (404 ⇒ unknown/neutral). In-memory TTL cache 1 h. `x-ratelimit-remaining` low ⇒ stop; Retry-After honored; no same-scan 403/429 retry.
- Scorer: exported `BOUNTY_SCORE_WEIGHTS` consts per spec §2; hard rejects (fork unconditional; young/<90d, no-merged-PR-in-window, label-only-$ — each only when `!bot_verified && shields_completed_total===0`); star/fork sanity `stars >= max(1, forks/4)`.
- `runBountyScan(deps, store, now)`: mutex + 10-min throttle via `latestBountyScanAt` (fresh ⇒ prior table + notice), 75 s wall clock, per-venue degrade lines, sightings upsert, deterministic table render (verdict/score columns appended outside model), scam tally, window-relative NEW markers. Returns `ok: true` always (degrade text inside).
**Tests:** `tests/capabilities/bounty-intake.test.ts` — fixtures: fork-fake, agent-bait, young-but-bot-verified, hostile-body (assert body appears NOWHERE in output), hygiene table cases, allowlist (evil.com / api.github.com.evil.com / trailing dot / 3xx / non-https), grammar, amount bounds, scorer ordering criterion (bot-verified+shields > unverified), conditional vs unconditional rejects, throttle, budget stop, non-downgrade path via store.
**Commit:** `feat(p2): bounty-intake capability — venue adapters, hygiene, deterministic scorer`

### Task 3: Wiring — manifest, contract, core-worker, disarm, caps
**Files:** Modify `src/core/tool-manifest.ts` (4 descriptors: bounty_scan external_read armed; project_track/project_update/project_list none armed); `src/contracts/task-contract.ts` (allowed_actions for turn envelope); `src/core/core-worker.ts` (capability switch cases + invocation branches; `loopToolTimeoutMs` case bounty_scan 90_000; `resultCharCapFor` carve-out 6_000; project_track ANCHOR: source_url ∈ bounty_sightings ∪ verbatim-in-user-message else deterministic refusal); `src/config/disarm-posture.ts` (add HOUGE_BOUNTY_ENABLED to DISARM_FLAGS); outbox path: venue-derived strings plain-text-escaped (check dispatcher parse_mode; escape at table render if needed).
**Tests:** `tests/core/` turn-loop integration (armed⇒listed/disarmed⇒unlisted; degraded scan ok:true; digest survives carve-out; anchor rejection); disarm-posture test update; PINNED_ENV additions for both env vars in the default-asserting sweeps.
**Commit:** `feat(p2): wire bounty tools into loop manifest/contract/worker + disarm`

### Task 4: Sweep + verifier
- [ ] Full `npm test` (expect all green, incl. daemon-env sweep) + `npm run build`.
- [ ] Adversarial verifier subagent on the diff (project pattern: file:line-verified findings; fix MAJORs + regression tests).
- [ ] Commit fixes.

### Task 5: Live gate (real daemon, mini) + docs
- [ ] Arm `HOUGE_BOUNTY_ENABLED=true` in .env, rebuild dist, reload daemon (launchd).
- [ ] Telegram: scan request → ranked plan (≥1 bot-verified; tally line; live rejection observed-if-present only).
- [ ] `project_track` one → restart daemon → row survives; ledger events present.
- [ ] Update tasks/todo.md (new Current State header), sessions.md, roadmap P2 status; ADR if governance-relevant (expect: no new ADR — no charter change; note carve-out in spec only).
- [ ] Final commit.

**Self-review done:** spec sections all covered by tasks 1–5 (carve-out→T2/T3 anchor+render; hygiene→T2; store→T1; wiring/caps/disarm→T3; testing→each; live gate→T5). No placeholders; names consistent (BountyCandidate, runBountyScan, project_track anchor).
