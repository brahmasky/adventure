# Idea Radar R1 — Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development. Steps use checkbox syntax.

**Goal:** daily flag-gated radar tick — code-owned public sources → slimmed items → one extract
LLM call → `ideas` cards with match-or-new dedupe → `/radar` view. Ships dark.

**Spec (source of truth):** `docs/superpowers/specs/2026-07-24-idea-radar-r1-design.md` — read
it FULLY first; the spec-review resolution section lists 3 resolved blockers (fetch `charCap`,
dryRun gate-bypass, code-computed slug). Honor them exactly.

**Patterns to mirror (read before coding):**
- `src/capabilities/lesson-consolidate.ts` — tick shape (flag → interval → work → markRan →
  ledger-if-ran), `dryRun` bypassing flag+interval, discipline prompt hardening, pure parse fn.
- `src/capabilities/bounty-intake.ts:90-110` — `fetchUrl` with `charCap` override for JSON.
- `src/run/run-store.ts` — state-marker pair (`getLessonConsolidateLastRun`/`markLessonConsolidateRan`),
  migration blocks (~5119), `applyLessonMerge` txn style.
- `src/run/run-ledger.ts` — event union + `requiredPayloadFields` exhaustiveness gate.
- `src/gateway/gateway.ts` `handleUsage`/`handleStatus` — command handler + section formatting.
- `src/triggers/telegram-command-parser.ts` — slash-command → typed event.
- `src/telegram/telegram-daemon.ts:340-360` — tick wiring after `runLessonConsolidateTick`,
  riding `episodicLlm` (`{question,system} → {ok,answer}`).
- `src/capabilities/wiki.ts` — `normalizeTopicSlug` (slug), `sanitizeWikiText` (storage backstop).

**Repo invariants:** NodeNext `.js` imports, strict + exactOptionalPropertyTypes, TDD, commit
per task, migration-count test 18→19 (ONE `idea-radar` block, both tables).

---

### Task 1 — Source registry + slimmers (`src/capabilities/idea-radar-sources.ts` new)
- [ ] `RadarSource`/`RadarItem` types per spec §1; registry: hn_front, hn_show (Algolia),
      hf_papers, devpost, gh_new (URL-encoded `created:%3E<date>` from injected now, +
      `&sort=stars&order=desc`), lobsters; reddit/x as `dormant: true` rows.
- [ ] Slimmer per source: pure `(body: string) => RadarItem[]`, caps 25 items, id charset
      `^[A-Za-z0-9_:\-\/\.]+$` ≤64 (namespaced `<key>:<native>`), title ≤160, meta ≤120, url
      https + expected-host check else drop item. Throws on unparseable body (source failure).
- [ ] `fetchRadarSources({fetch, now})` helper: per-source `fetchUrl(input, { timeoutMs,
      maxBytes: 262_144, charCap: 262_144, deny: [] })`, per-source try/catch isolation →
      `{ok: [{key, items}], failed: [key]}`.
- [ ] Tests: golden trimmed fixture per source (real shape, few items); hostile fixture (bad
      ids/foreign urls/oversized) → items dropped, no throw escape; 30-item feed → 25; dormant
      sources never fetched (assert fetch mock not called for them).
- [ ] Commit.

### Task 2 — Ideas store + ledger (`src/run/run-store.ts`, `src/run/run-ledger.ts`)
- [ ] ONE `idea-radar` migration block: `ideas` + `radar_state` tables per spec §2 SQL.
      Migration-count test 18→19 + comment list entry.
- [ ] `getRadarLastRun()` / `markRadarRan(now)` (mirror lesson markers).
- [ ] `insertIdeaCard({slug,title,summary,sources,now})` — computes distinct_items/
      distinct_sources from sources; slug collision → `-2`/`-3` suffix; returns `{id}`.
- [ ] `touchIdeaCard({id, newItems, summaryUpdate, now})` — union per-source item lists
      (cap 20/source, drop oldest), recompute distinct counts, re-sighted known id → last_seen
      only; summaryUpdate null keeps summary.
- [ ] `listActiveIdeas(limit)` — status NOT IN ('archived','killed'), ORDER BY
      `distinct_items * distinct_sources` DESC, last_seen DESC.
- [ ] `archiveStaleIdeas({now, afterDays})` (only seen/tracked; sets archived_at, reversible) +
      `pruneIdeaOverflow({cap})` (archive lowest momentum beyond cap) + `countActiveIdeas()`.
- [ ] Ledger: `"idea_radar_tick"` union member, requiredPayloadFields
      `["sources_ok","sources_failed","cards_new","cards_updated","cards_archived"]`,
      `recordIdeaRadarTick(payload)`.
- [ ] Tests per spec §6 store list (collision suffix, union caps, last_seen-only re-sighting,
      momentum order, archive rules, prune, markers, migration count, ledger payload throw).
- [ ] Commit.

### Task 3 — Tick capability (`src/capabilities/idea-radar.ts` new)
- [ ] Constants + resolvers: `resolveRadarEnabled` (canonical 1/true/yes/on),
      `resolveRadarIntervalMs` (`HOUGE_RADAR_INTERVAL_HOURS`, default 24h), spec §3 constants.
- [ ] `RADAR_EXTRACT_DISCIPLINE` — DATA framing hardened like `LESSON_CONSOLIDATE_DISCIPLINE`;
      output contract per spec §3 (verdict new/match; NO slug field; NO urls echoed back).
- [ ] `buildRadarQuestion(items, activeCards)` — items as `<id> | <title> | <meta>` (NO urls
      shown to model), cards as `#<id> <title>` (top 100).
- [ ] `parseRadarExtraction(text, validItemIds, validCardIds)` — pure: first `{...}`; drop card
      on unknown item ref / unknown matched_id / empty refs; cap title 80 / summary 400 /
      summary_update 400; `sanitizeWikiText` every stored string; malformed → `[]`.
- [ ] `runIdeaRadarTick({store, llmAnswer, fetch?, env, now, dryRun})` per spec §3 order.
      dryRun: bypass flag+interval, REAL fetch+LLM, zero writes, return proposals
      (member item titles + proposed card). Zero-sources-ok path: markRan + all-failed ledger,
      no LLM call. Slug = `normalizeTopicSlug(title)` in code. Never throws.
- [ ] Tests per spec §6 parse+tick lists (incl. cap 30→10, interval idempotency, dryRun
      byte-identical DB, flag OFF no-op, one-source-fail isolation, injection-bearing titles
      stored inert).
- [ ] Commit.

### Task 4 — Wire-up: daemon, disarm, /radar, /status line, CLI
- [ ] `disarm-posture.ts`: `DISARM_FLAGS += "HOUGE_RADAR_ENABLED"`; update exact-array test.
- [ ] Daemon: `runIdeaRadarTick({store, llmAnswer: episodicLlm, env: process.env, now})` right
      after `runLessonConsolidateTick`; comment in house style; never throws.
- [ ] Parser: `/radar` → event type `radar`; gateway `handleRadar`: top 10 `listActiveIdeas`,
      `• <title> — momentum <n>, seen <age>, <status>` + footer `<n> active · last tick <when>`,
      all through `escapeForTelegram`; flag off → "radar off" line. `/help` list + README later.
- [ ] `/status`: radar line in the sweeps section (`radar: last tick <when> · <n> active`),
      absent when flag off.
- [ ] CLI: `houge radar --dry-run` (render proposals; write nothing; close store in finally) +
      `houge radar` (one immediate non-dry pass).
- [ ] Tests: disarm array; daemon tick invoked (mirror lesson daemon test); parser event;
      handleRadar render + empty state; CLI dry-run leaves DB byte-identical.
- [ ] Commit.

### Task 5 — Green + adversarial review + live gate + docs (main session orchestrates)
- [ ] `npm run build` + full `npx vitest run` green.
- [ ] Adversarial review subagent over the diff (hostile payloads, cap enforcement, dryRun
      purity, injection→/radar render, quarantine claims in §5). Fix + regression tests.
- [ ] `houge radar --dry-run` on the mini against REAL sources → Paco eyeballs → arm + kickstart.
- [ ] Docs: configuration.md, README, ADR 0026, todo/sessions. Push.

## Notes
- Ship DARK — `HOUGE_RADAR_ENABLED` stays unset until the Paco eyeball gate.
- The extract call rides the daemon tick adapter; do not add new provider plumbing.
- No git digest files in R1. No slug from the model. No URLs from the model.
