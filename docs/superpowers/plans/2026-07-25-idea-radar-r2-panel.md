# Idea Radar R2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development — one fresh builder
> per task, adversarial review after all tasks, live gate last. Spec is the contract:
> `docs/superpowers/specs/2026-07-25-idea-radar-r2-panel-design.md` (read it FIRST, whole).

**Goal:** Weekly 3-judge panel + contained claude chair over the R1 `ideas` store; shortlist
snapshot; `/radar <n>` detail; `/idea` + `/idea pick <n>`; weekly brief file; ADR 0027.

**Architecture:** Panel-local seats (never in `buildLlmChain`); latch-before-calls; pure parse
floors everywhere; SQLite truth, brief = projection; ships dark behind
`HOUGE_RADAR_PANEL_ENABLED`.

**Tech stack:** TypeScript strict ESM NodeNext, node:sqlite, vitest, zero runtime deps.

**Build order:** T1 ∥ T2 → T3 ∥ T4 → T5. Commit per task (`feat(radar-panel): …`), full
`npm test` green before each commit.

---

### T1: Store + ledger layer

**Files:** Modify `src/run/run-store.ts`, `src/run/run-ledger.ts`;
test `tests/run/idea-panel-store.test.ts` (new), update `tests/run/idea-radar-store.test.ts`,
migration-count assertion (19→20) wherever asserted, `tests/gateway/gateway-radar.test.ts`
ordering expectations.

- Migration `2026-07-25-idea-panel` (append after radar block, same BEGIN IMMEDIATE idiom,
  run-store.ts:5101-5142 as template): `radar_panel_state (id INTEGER PRIMARY KEY, last_run_at
  TEXT)` + seed row; `radar_shortlists (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL,
  week_key TEXT NOT NULL UNIQUE, cards_json TEXT NOT NULL, picked_idea_id INTEGER)`.
- Methods (§8 of spec): `getPanelLastRun`/`markPanelRan` (mirror radar_state pair at
  run-store.ts:2589-2605); `setIdeaStatus` with the transition guard matrix (allowed:
  `seen|tracked→shortlisted`, `shortlisted→tracked`, `shortlisted→picked`, `picked→shortlisted`;
  anything else `{updated:false}`); `writeIdeaScores`; `upsertShortlistSnapshot` (UNIQUE week_key
  upsert); `getLatestShortlist` (max id); `setShortlistPick`; `getIdeaById`; `getPickedIdea`
  (`WHERE status='picked'` — singleton by construction, but return first by id and let tests
  assert count).
- `listActiveIdeas` ORDER BY becomes: status priority (`picked`=0, `shortlisted`=1, else 2) ASC,
  momentum DESC, last_seen DESC, id ASC.
- `pruneIdeaOverflow`: victim WHERE adds `AND first_seen != :now AND status NOT IN
  ('shortlisted','picked')` (L4 + B1).
- `touchIdeaCard`: apply `summaryUpdate` only when current status ∈ `seen|tracked` (L7) — items
  union still applies regardless.
- `run-ledger.ts`: add `"idea_panel_tick"` to the union + `requiredPayloadFields` entry
  `["result","judges_ok","judges_failed","chair_used","cards_scored","shortlist_ids","week_key","brief_written"]`
  (`reason` optional — not in required list).
- Tests: guard matrix, L4/B1 prune survival at cap, L7 immunity, ordering with pinned statuses,
  snapshot upsert replaces same week, pick round-trip incl. archived-prior no-op, ledger
  validation (missing field throws), migration count.

### T2: Seats — chair spawn, codex judge, broker #8, week-key + schedule parse utils

**Files:** Create `src/capabilities/idea-panel-seats.ts` (chair + codex judge spawn legs),
`src/capabilities/week-key.ts`; modify `src/config/secret-broker.ts`;
tests `tests/capabilities/idea-panel-seats.test.ts`, `tests/capabilities/week-key.test.ts`,
update `tests/config/secret-broker.test.ts`.

- Broker: `CLAUDE_CODE_OAUTH_TOKEN` → `SECRET_ENV_NAMES` (8th), closure capture, `redactable`,
  typed getter `claudeOauthToken()`. Exact-list test 7→8; redaction + `stripSecretsFromEnv` tests.
- Chair (`spawnPanelChair({digest, system, broker, env, spawnImpl?})`): mirrors pi leg
  (pi.ts:159-237) via `defaultSpawnImpl` (cli-spawn.ts:49-109 — never-reject, SIGKILL timeout,
  262_144 stdout cap). Bin from `HOUGE_CLAUDE_BIN` (absolute; unset/ENOENT → `{ok:false,
  unavailable:true}`). Argv: `-p --output-format json --max-turns 1 --tools ""
  --strict-mcp-config --mcp-config {} --system-prompt <system>`; digest on stdin ONLY.
  **Builder MUST verify flag names against `claude --help` (pinned /usr/local/bin/claude
  v2.1.219) and adjust constants; record actual argv in a code comment.** Env: `buildChildEnv()`
  base + `CLAUDE_CONFIG_DIR` (constant `~/.houge/claude-chair`, mkdir + minimal settings.json on
  first use: `{"permissions":{"allow":[],"deny":["*"]}}` or verified minimal equivalent) +
  `CLAUDE_CODE_OAUTH_TOKEN` from broker getter — exactly these 2 additions, test asserts env keys
  exact-set. Timeout `HOUGE_RADAR_CHAIR_TIMEOUT_MS` default 120_000. `cwd: os.tmpdir()`.
- Codex judge (`spawnCodexJudge({digest, system, env, spawnImpl?})`): `resolveCodexBin` reuse
  (coding-agent.ts:53-71), argv `exec --sandbox read-only` + prompt delivery per the coding-agent
  contract (builder verifies stdin vs file — mirror coding-agent.ts:82 exactly), neutral cwd,
  same spawn bounds, `buildChildEnv()` only (no secrets).
- `week-key.ts`: `computeWeekKey(nowIso, tz): string` — Intl date parts in tz → local Y-M-D →
  ISO-8601 week algorithm → `YYYY-Www`. Boundary tests: Sun 09:00 AEST (Sat 23:00Z, same week),
  Mon 08:00 AEST (Sun 22:00Z, NEW week), year boundary (2027-01-01 cases).
- `resolvePanelAt(env)` in seats or panel module: grammar per spec §4 (trim/lower/split/2 tokens/
  day union/AT_PATTERN); returns `{day, at} | null(off)`; malformed → default `{sun, 09:00}`.
  Full matrix test.

### T3: Panel tick + brief writer + push

**Files:** Create `src/capabilities/idea-panel.ts`, `src/report/brief-writer.ts`;
tests `tests/capabilities/idea-panel.test.ts`, `tests/report/brief-writer.test.ts`.

- `runIdeaPanelTick({store, judges:{kimi,gemini}, codexJudge, chair, broker, env, now,
  chatId?})` — self-gating, never throws, order per spec §4: flag → weekly due (first-arm null
  guard: `last===null → fire`) → **stamp latch** → read top-12 (`listActiveIdeas(12)`) → thin
  board (<3) skip trace → judges sequential w/ per-seat try/catch → quorum(2) else abort trace →
  chair or mean-score fallback (ties: momentum, then older first_seen) → apply (inner try/catch:
  scores_json overwrite `{"panel":{"week","judges":{...},"chair_rank"}}`, status transitions via
  `setIdeaStatus`, snapshot upsert) → brief (non-fatal) → ledger (one event, result ok/skipped/
  aborted) → push (key `idea-panel:<week_key>:<now>`, `/idea` render, non-fatal).
- Digest builder: index/title/summary/momentum/distinct_sources/age-days, NO URLs; DATA framing
  discipline copied from `buildRadarQuestion` (idea-radar.ts:109-123). Judge/chair parse floors:
  strict JSON, clamp 0-10 int, dup index first-wins, unknown drop, `cleanText` caps (200/400)
  via `stripHostileChars` + `sanitizeWikiText` + code-point slice (idea-radar.ts cleanText idiom).
- `brief-writer.ts`: `writeBriefFile(projectRoot, {weekKey, ...})` → `memory/briefs/
  <weekKey>-ideas.md`; wiki-writer contract (non-fatal caller, `validateSlug`-style filename
  re-check, `flattenSourceLine` for structural lines, sanitizeWikiBody posture for body);
  MANDATORY injection banner literal (spec §6) as first block.
- Tests: R1 harness idiom (in-memory store, canned seat stubs, throwing stubs); every §11
  failure-mode row gets a test; latch-before-calls (throwing kimi stub, latch stamped); first-arm
  → Sunday sequence (one snapshot, two push keys); quorum abort writes nothing; fallback
  determinism; brief banner present; push key shape.

### T4: Command surface

**Files:** Modify `src/triggers/telegram-command-parser.ts`, `src/triggers/
telegram-trigger-adapter.ts`, `src/domain/types.ts`, `src/gateway/gateway.ts`;
update `tests/triggers/telegram-command-parser.test.ts`, `tests/gateway/gateway-radar.test.ts`,
new `tests/gateway/gateway-idea.test.ts`.

- Parser: `/radar [n]` (`{type:"radar", radar_number?}` — integer token only, else parse error
  message); `/idea` and `/idea pick <n>` (`{type:"idea", idea_action:"show"|"pick",
  idea_number?}`). `splitShellWords` already tokenizes.
- Adapter: metadata bag route (schedule_id precedent, telegram-trigger-adapter.ts:249-258);
  new `TaskEventType` `"idea"`.
- Gateway: `formatRadarText` numbered rows + footer hint; `handleRadar` branches on
  `metadata.radar_number` → detail render per spec §5 (escape everything; ≤3 items/source,
  ≤12 source lines; out-of-range distinct message; panel line from scores_json when present);
  `handleIdea` (idempotency via `beginTriggerProcessing` — replay test): show = snapshot render
  w/ week_key + picked marker; pick = singleton mechanism per spec §5 (global `getPickedIdea` →
  revert-or-note → set → stamp → confirm "picked #n from <week_key>"); `/status` panel line
  (resolved schedule render + `chair off` when last tick chairless — read from last
  `idea_panel_tick` ledger event or a panel_state field, builder picks simplest that tests
  cleanly); `/help` two lines.
- Result statuses: `"radar_returned"` reused; add `"idea_returned"` to the union.

### T5: Wiring, CLI, flags, docs, ADRs

**Files:** Modify `src/telegram/telegram-daemon.ts`, `src/cli.ts`,
`src/config/disarm-posture.ts`, `src/capabilities/diff-reviewer.ts` (line-17 comment),
`docs/reference/configuration.md`, `README.md`, `docs/decisions/README.md`,
`docs/decisions/0010-*.md`, `0011-*.md`, `0026-*.md`;
create `docs/decisions/0027-idea-panel-claude-chair.md`;
update `tests/config/disarm-posture.test.ts`, daemon wiring test.

- Daemon: build pinned per-seat adapters (kimi/gemini single-provider via registry pieces +
  broker + onUsage/ceiling accounting), pass into `runIdeaPanelTick` after `runIdeaRadarTick`
  in `runSignalPathTick`.
- CLI: `houge radar-panel [--dry-run]` — dry-run = real seats, zero writes/push/brief, terminal
  render via hostile-stripped renderer (renderRadarProposals idiom); cost note in output.
- `DISARM_FLAGS` + rationale comment + exact-array test.
- ADR 0027 per spec §9 (grants, both amendments as cross-ADR sections, residual risk, pinned
  binary version, broken-link fixes in 0026, status lines 0010/0011, README index).
- configuration.md §10 table; README `/idea` + `/radar <n>` lines.

### Adversarial review (after T5)

Fresh subagent, diff `main...HEAD` vs spec — same charter as R1 (hostile text, spend, write
paths, latch/retry storms, escape gaps, env leakage). Fix criticals/highs; defer only with spec
notes.

### Live gate

Spec §13 steps 0-4. Arm only on Paco's word.
