# Skill retirement — commanded retire/restore + weekly re-verify advisor

**Date:** 2026-07-29 · **Status:** approved (brainstorm 2026-07-28, Paco) · **Phase:** extends
Phase 2a/2b/2c skills layer (ADR 0011, spec `2026-06-21-phase2-skills.md`)

## Why

The skill lifecycle has birth (commanded author) and refine, but no death. Live gap found
2026-07-28: the first-ever commanded skill (`siem-soar-ueba-weekly-report`) was authored with the
wrong domain (SOC-ops report instead of news digest, Gate B 0.27 advisory). A rename-refine
produced the correct replacement (`periodic-news-newsletter`) but left the bad predecessor
active — both matched the same scope/when, so contradictory procedures would co-fold into the
next scheduled run. There was no way to remove it short of hand-deleting the file.

Design principle (matches every other Houge layer): **retire, never delete.** Lessons supersede
(never delete), blocked drafts park in `_pending/` (inert), /kill leaves a tombstone. Hard delete
would be the only irreversible verb in the evolution stack — skills/ is gitignored and the backup
tick snapshots only the sqlite, so a deleted skill file is gone for good.

## Decisions (locked with Paco, 2026-07-28)

- **D1 — scope:** commanded retire/restore + rename-refine auto-retire + a weekly ADVISORY pass.
  The advisor only *suggests*; the destructive verb stays with Paco. No autonomous retirement.
- **D2 — advisor home:** own weekly tick (lesson-consolidate idiom), quiet — a Telegram message
  ONLY when it flags candidates; silent when healthy (invariant-sweep silent-healthy idiom).
- **D3 — advisor signal:** re-verify only. Stale skills (`last_verified` > 28 d) get a fresh
  3-pass Gate B ensemble; failures are flagged, passers get `last_verified` refreshed. (Fold-count
  / near-dupe / LLM-judgment signals considered and NOT selected.) This closes the Phase-2c
  deferred item "re-verifying existing skills as world-facts drift".
- **D4 — command surface:** slash (`/skills retire|restore|retired`) AND natural language
  ("退役周报技能") routed through Gate A. Both paths call the same store function. NL name
  resolution: exact or unambiguous substring against the registry; ambiguous → ask, never guess.
- **D5 — storage:** mirror `_pending/` exactly — `skills/_retired/<scope>/<name>.md`, under
  containment, excluded from every active read. Rejected alternatives: SQLite lifecycle table
  (splits source-of-truth from frontmatter), trash dir outside the skills root (breaks
  containment).

## 1. Storage & lifecycle (skill-store)

- `RETIRED_DIR = "_retired"`, sibling of `PENDING_DIR`. Excluded from `readScopeFiles` /
  `readScopeBlock` / `list` / `listScopes` and the ≤cap, same mechanism as `_pending`.
- **`retireSkill(scope, name, opts)`** — move `<root>/<scope>/<name>.md` →
  `<root>/_retired/<scope>/<name>.md`, stamping frontmatter:
  `retired: <ISO date>` · `retired_by: paco | refine` · optional `superseded_by: <name>`.
  Regenerates `REGISTRY.md` (active-only view).
- **`restoreSkill(scope, name)`** — move back + strip the three retire stamps (keep `version`,
  `score`, `last_verified`, `origin`). If an ACTIVE skill with the same scope+name now exists →
  error, never overwrite. If restoring would exceed the ≤cap for the scope → allow (cap governs
  folding, not storage; composer already folds only the cap).
- **`listRetired()`** — parsed metas from `_retired/**`, including the retire stamps.
- `REGISTRY.md` stays active-only; retired skills are listed live from the dir, never from the
  registry.
- DEFENSIVE (store invariant holds): malformed/oversized files under `_retired` are skipped,
  never thrown; a missing `_retired` root = "no retired skills".

## 2. Commands

**Slash (deterministic, no LLM):**
- `/skills retire <name>` — exact name match across scopes; hit → retire (`retired_by: paco`) +
  confirm line; miss → error listing active skill names. Already-retired → clean no-op message.
  Same name in >1 scope → error asking for `/skills retire <scope>/<name>` (accepted form).
- `/skills restore <name>` — inverse; name-collision error surfaces as a clear message.
- `/skills retired` — list: `name · scope · retired <date> · by <who> [· superseded by <name>]`.
  Empty → "No retired skills."
- Parser: extend `parseSkills` (currently `/skills [scope]`) with the three subcommands;
  subcommand names win over a scope named "retire/restore/retired". Renders are HTML-safe,
  **bold** not `##` (converter has no heading support — regression class already fixed twice).

**Natural language (Gate A route):**
- The §2 routing rubric gains `retire` / `restore` verdicts with a target-name field. Resolution
  against the active registry (retired list for restore): exact or unambiguous substring →
  proceed via the same store call; ambiguous → reply asking which (list matches); none → say so.
  The resolver is code, not the LLM — Gate A only extracts the user's words for the name.

## 3. Rename-refine auto-retire (core-worker refine flow)

In `runSkill`'s refine path: the request referenced existing skill X (its file was fed to the
writer), the authored output parsed with name Y ≠ X, and Y wrote successfully → auto-retire X
with `retired_by: refine`, `superseded_by: Y`. The gate-stack report shows both lines
("wrote Y vN · retired X (superseded)"). Same-name refine (the normal case) is untouched.
If the write of Y fails, X is NOT retired.

## 4. Weekly re-verify advisor (new capability + tick)

- New capability `skill-reverify.ts` + a weekly tick wired like lesson-consolidate.
- **Candidates:** active skills with `last_verified` older than `HOUGE_SKILL_REVERIFY_AGE_DAYS`
  (default 28).
- **Per candidate:** run the existing 3-pass Gate B ensemble (`anchor-verify`, existing
  threshold). Pass → stamp `last_verified: today` (score updated), silent. Fail → collect
  `{name, scope, score, failing anchors}`.
- **Report:** one quiet Telegram message ONLY if ≥1 flagged: per skill one line + failing
  anchors + "retire with `/skills retire <name>`". The advisor NEVER moves files.
- **Gate B error / unscored:** skill left untouched — not flagged, `last_verified` NOT
  refreshed (an unscored pass never condemns and never launders staleness; matches 2c
  "a Gate B error never blocks").
- **Cadence/pinning:** weekly, Sydney-pinned via `HOUGE_SKILL_REVERIFY_AT` (default Sunday
  10:00, DST-safe like HOUGE_RADAR_AT). Appears in the `/schedule` 系统任务 footer alongside
  radar/panel.
- **Arming:** `HOUGE_SKILL_REVERIFY_ENABLED` (default OFF like other ticks), in DISARM_FLAGS.
- **Ledger:** `skill_reverify_tick: ["checked", "passed", "flagged"]` — counts only, no skill
  text (bodies-out-of-the-ledger invariant).
- **Cost:** ≤4 skills/scope × few scopes × 3 cheap-chain passes — negligible; still runs under
  the run budget ledger like every capability.

## 5. Out of scope

- Autonomous retirement (advisor acts) — revisit only after the advisor's suggestions prove
  reliable over live soak.
- Fold-count / near-dupe / effectiveness signals — need usage telemetry skills don't have.
- Auto-promote from distill (the "learned" origin caller) — separate feature.
- Re-verify-on-restore — restore keeps the old score; the weekly tick will catch it when stale.

## 6. Tests

- **Store:** retire moves+stamps · restore moves+strips · restore collision error · retired
  excluded from readScopeBlock/list/listScopes and cap · listRetired parses stamps · malformed
  retired file skipped · registry stays active-only.
- **Parser:** three subcommands · precedence over scope-arg · invalid forms.
- **Gateway:** renders for retire/restore/retired (HTML-safe, bold headers) · unknown name error
  lists names.
- **Core-worker:** rename-refine auto-retires predecessor (stamps + report) · same-name refine
  untouched · failed write of Y leaves X active · NL retire ambiguous → asks.
- **Reverify:** stale selection by age · pass refreshes last_verified · fail flags + message ·
  Gate B error leaves untouched/unflagged · disarm/flag posture · ledger event counts ·
  quiet-when-healthy (no message).
- **/schedule footer:** reverify line appears with computed next fire.

## 7. Live gate

1. `/skills retire siem-soar-ueba-weekly-report` in Telegram → file lands in `_retired/research/`
   with stamps; `/skills` no longer lists it; `/skills retired` does. (This is also the real
   cleanup the feature exists for.)
2. `/skills restore` + re-retire round-trip.
3. NL: "退役 xx 技能" happy path + ambiguous case asks.
4. Reverify: temporarily set age to 0 days + fire the tick manually (`houge` CLI or dev hook) →
   both live skills re-verified; confirm quiet/flag behavior; restore config; arm
   `HOUGE_SKILL_REVERIFY_ENABLED=1`.
