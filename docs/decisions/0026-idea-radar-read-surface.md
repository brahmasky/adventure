# ADR 0026: Idea Radar — a code-owned read surface for builder-idea sensing

- **Status:** accepted · **extended by [ADR 0027](0027-idea-panel-claude-chair.md)** (panel write path + chair)
- **Date:** 2026-07-24
- **Deciders:** Paco (2026-07-24 session)
- **Relates to:** extends the [ADR 0022](0022-money-fork-reopened.md) money fork with a
  sensing loop (radar → review → build); reuses the [ADR 0025](0025-google-api-surface.md)
  registry pattern and the http-fetch SSRF floor; feeds the R2 weekly panel, whose
  claude-cli chair amends [ADR 0010](0010-natural-language-intent-layer.md)/[ADR 0011](0011-self-evolution-architecture.md)
  in [ADR 0027](0027-idea-panel-claude-chair.md) — **this ADR grants no new provider and no write path**

## Context

The money fork needs a supply of vetted, monetizable build ideas. Paco's direction
(2026-07-24): Houge should research hackathons and builder forums daily, sink findings into a
durable local store, and feed a weekly multi-agent review. Two adversarial review passes
shaped the final architecture: the originally proposed autonomous build pipeline (R3) was
**overturned** — greenfield builds need product decisions a daemon tick cannot ask, and the
[ADR 0023](0023-external-workspace.md) extwork boundary already holds the bounded version.
What ships in slices: R1 (this ADR) = daily sensing; R2 = weekly judge panel + shortlist;
R3 = picked-card → kickoff brief → an interactive Claude Code session.

## Decision

1. **Code-owned source registry** (`idea-radar-sources.ts`): HN front + Show/Ask (Algolia),
   HuggingFace daily papers, Devpost open hackathons, GitHub new-repo search proxy, lobste.rs.
   The model never picks a URL. Reddit and X ship as dormant rows — Reddit pends the Data-API
   approval requested 2026-07-24 under Wukong's account; X pends a paid dev account
   (pay-per-use ~$0.005/read). All fetches ride `fetchUrl` (SSRF floor, no redirects, byte cap
   with the `charCap` override) with per-source failure isolation.
2. **Deterministic slimmers are the first trust boundary**: per-source shape locks on native
   ids, char caps on every field (URL included, drop-whole at 512), https + own-host checks,
   userinfo rejected, hostile-char class stripped (C0/C1, bidi, zero-width — shared
   `stripHostileChars`), code-point capping. Stored URLs are code-constructed or host-checked —
   never model-emitted.
3. **One extract LLM call per tick** (daily latch, stamped BEFORE fetch so a store fault can
   never cause a fetch/LLM retry storm): DATA-framed discipline, match-or-new dedupe against
   existing card titles (the reconcile pattern — slug is a code-computed filename key, not the
   dedupe mechanism), ≤10 new cards/tick, strict pure parse that drops any card referencing
   unknown items or cards.
4. **`ideas` store with lifecycle**: momentum = distinct items × distinct sources (re-sighting
   a known item bumps `last_seen` only); auto-archive after 30 stale days (reversible);
   active cap 100. SQLite is truth; `/radar` and the `/status` line are the views; **no git
   digest files** in R1.
5. **Flag-gated + disarmable**: `HOUGE_RADAR_ENABLED` in `DISARM_FLAGS`; ships dark; the
   pre-arm gate is `houge radar --dry-run` (real fetches + real LLM, zero writes) eyeballed by
   Paco. Human pick gates stay in front of anything the radar ever feeds (R2+).

## Consequences

- Houge gains a daily, bounded, read-only sensing loop costing ≤6 fetches + 1 metered LLM call
  per day; a hostile source can degrade coverage but cannot expand spend, smuggle URLs, or
  reach a write path.
- Card text is untrusted forever: every downstream consumer (R2 judges, chair, briefs,
  Telegram) must keep the DATA framing and the render escapes.
- Deferred, recorded in the spec: per-source consecutive-failure alerting (invariant sweep),
  L4 same-tick prune shadowing, L7 summary-drift guard for operator-blessed statuses.
