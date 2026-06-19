# ADR 0006: Web-read capability — free-read, gated-act

- **Status:** accepted (direction; Tier 1 built first) · **amended 2026-06-19** (research quality — see end)
- **Date:** 2026-06-18
- **Deciders:** Paco

## Context

Houge's execution capabilities are thin (`llm_answer`, `local_file_read`) — no live web.
A scheduled "research brief" or a current-events `/ask` is hollow without it. The operator's
stance: Houge should **explore the web freely, like a human**, but **surface what it learned
with sources** and **get confirmation before acting or self-modifying**. A survey of the
mid-2026 state of the art ([docs/research/web-access-2026.md](../research/web-access-2026.md))
showed that stance is sound *only if reading is structurally walled off from acting*, because
every 2024–2026 incident (Comet, Operator, EchoLeak, ZombAIs) shared one root cause: reading
and acting lived in one ungated context. Houge is unusually well-placed here — its harness
already enforces that separation (ADR 0001/0002).

## Decision

Add web access as a **pluggable, keyed `external_read` capability** under a **free-read /
gated-act** boundary — the 紧箍咒 ([ADR 0005](0005-agent-memory-architecture.md)) applied to
the open internet.

**1. Pluggable web-provider registry** (mirrors the LLM provider chain): web services are
swappable via config so no vendor is a lock-in (Brave already removed its free tier). Tiers:

- **Tier 1 — search/fetch API (default, ungated `external_read`).** Default **Tavily**
  (1,000 credits/mo, recurring, no card; search + clean extract) or **Firecrawl** (same).
  Key in `.env`, exactly like `KIMI_API_KEY`. The service is the egress, so Houge opens no
  sockets to arbitrary IPs — the SSRF/metadata class is offloaded. *(Jina rejected as default
  after live verification: anonymous reader is cached + rate-limited and search needs a key;
  free tokens are one-time, not recurring.)*
- **Tier 2 — keyed upgrade** (Firecrawl/Tavily/Exa) for higher volume/reliability: config only.
- **Tier 3 — browser shell-out (gated, heavy).** The already-installed **`dev-browser`**
  (QuickJS sandbox + Playwright) or **`agent-browser`** (Rust/CDP, encrypted credential vault),
  for JS-heavy/auth/interactive sites only. This carries the user's sessions and can act → the
  lethal-trifecta zone → treated as a privileged, **approval-gated** capability (closer to
  `coding_agent_cli`). Needs a dedicated `/cso` review before it ships.

**2. Deterministic tier escalation** (routing is the harness's job, not the LLM's): always
start at Tier 1; escalate to Tier 3 only on a deterministic signal (Tier 1 empty/blocked/
JS-required, or an explicit auth/interactive need) **and** with approval. The model may *flag*
"needs a browser"; the harness decides and gates.

**3. Read → act flow (plan-then-execute; the reader holds no trigger):**
`trigger (trusted) → plan/contract fixes allowed actions before any read → web_read returns
findings + sources as DATA (the reading LLM has no action tools) → surface to Paco with
provenance` — and most read tasks **end here**. If an action is warranted:
`→ structured PROPOSAL (action + rationale + which params came from the web) → /approve →
deterministic Capability Runner executes`. Even a fully-injected read can at most produce a
proposal Paco sees and rejects; it can never act. Self-modification is a consequential action,
gated like any other.

**4. Guardrail checklist (non-optional for Tier 1):**
- Web content is **untrusted data, never instructions**.
- **Provenance** — every claim carries source URL + timestamp.
- **Cut the outbound exfil leg** — disable Telegram link previews on answers
  (`disable_web_page_preview`); strip untrusted URLs except cited sources; never auto-render
  untrusted links/images. (If a future provider does direct fetch instead of via a service:
  http(s) only, allowlist on resolved IP, block metadata/loopback/RFC1918/link-local, no redirects.)
- **Budget-bounded** (the global breaker + per-task fetch caps) and **fully audited** (every
  URL fetched, source cited, action proposed/decided → ledger).

**5. Layered control (defense-in-depth; no single kill switch):**
- L1 **Constitution** (deterministic) — can't act/self-edit without approval; the LLM can't
  override it. Always holds.
- L2 **Global budget breaker** — bounds 24h blast radius even if control is unreachable.
- L3 **`/guard`** (in-band) — `pause`/`resume` (a manual breaker reusing the gateway refusal)
  + a posture read; injection-proof because it's deterministic code, but can be delayed by an
  in-flight run, so control commands need a **fast path** not blocked by work. The 紧箍咒.
- L4 **OS kill** (out-of-band) — `launchctl unload com.houge.daemon` on the host (a plain
  `kill` won't do — `KeepAlive` relaunches). The 五行山; the absolute stop.

## Consequences

- **Easier:** Houge can genuinely explore and answer with sources; the scheduler finally has a
  useful job; Tier 1 reuses the `fetch()`/provider-chain pattern (zero new deps beyond a key).
- **Honest cost:** web access is keyed (no truly-free keyless search exists) — but it's one
  `.env` line, like kimi.
- **Risk posture:** Tier 1 is low-risk (read-only, proxied, no authority to hijack). Tier 3 and
  the future LLM "guard reviewer" are the genuinely dangerous additions and each need a `/cso`
  pass; they are explicitly deferred.
- **Deferred:** `/guard` and the LLM reviewer are *not* preconditions for low-risk Tier 1; build
  them before granting reach/authority (Tier 3), not before reading.

## Alternatives considered

- **Jina, keyless, as default** — rejected after live verification (cached/limited anon read,
  keyed search, one-time free tokens).
- **Direct fetch (zero-dep, no third party)** — re-opens the full SSRF/exfil burden *and* still
  can't search; keep as a possible later provider, not the default.
- **Full browser (`dev-browser`) as the default** — overkill (Chromium to read an article) and
  dangerous-by-default (carries sessions/authority); it's the gated heavy tier, not the everyday one.
- **An LLM monitoring/telemetry subagent** — rejected for the recording path: telemetry must be
  deterministic (the ledger already is it). An advisory read-only reviewer is a later option.

---

## Amendment (2026-06-19): research quality — a STORM-style pipeline

*This extends (does not reverse) the capability above: the `web-research` program's
internal **method**. Motivated by a real eval — the SPCX `/research` answer was well-formed
but had a fact-misassociation (a 10× unit error) and source bias (it took the most bullish
source at face value).*

### Context

Today `web-research` is **search → one synthesis** — the single-pass research that
systematically misses blind spots. **STORM** (Stanford OVAL Lab, *Synthesis of Topic
Outlines through Retrieval and Multi-perspective Question Asking*, NAACL 2024;
`github.com/stanford-oval/storm`, MIT) reframes research as a **staged pipeline** and is
~25% more organized / 10% broader in peer-reviewed testing. Its two named failure modes —
**source bias** and **fact misassociation** — are *exactly* the SPCX flaws, and its
**self-critique** step is the documented fix. Houge has an edge over the prompt-only version
the method is usually demoed with: it has **live retrieval**, so it can run the
*retrieval-grounded* STORM (each perspective backed by real sources), not just model priors.

### Decision

Adopt a STORM-informed method for `web-research`, sequenced cheapest → richest:

- **A — self-critique pass (do first).** After synthesis, a second LLM pass grades its own
  answer (confidence per claim, weakest link / what-to-verify, bias check, missing angle) and
  revises. One extra call; directly targets the SPCX-class errors. **This *is* the advisory
  reviewer** discussed elsewhere, built in.
- **B — contradiction + reliability structure.** Rank findings by confidence and flag where
  sources disagree (no more cherry-picking the rosiest source).
- **C — multi-perspective deep mode.** A gated `--deep` variant: generate questions from
  several expert lenses (practitioner / academic / skeptic / economist / historian),
  **retrieve per perspective**, map contradictions, synthesize, then self-critique. Many
  searches + calls → it is a **mode**, not the default, bounded by the global breaker.

### Consequences & ties

- **Quality bump where it's cheapest** (A) addresses the exact eval failures; **C** is the
  "research like a PhD" capability, deliberately gated by cost.
- **Fits the learning loop ([ADR 0007](0007-learning-loop.md)):** this staged method *is* the
  "fixed research discipline" layer of the composed synthesis prompt; the self-critique checklist
  can ship **built-in** or as Houge's **inaugural learned lesson**. The peer-review checklist
  (confidence / weakest-link / bias / missing-angle) comes straight from STORM.
- **Honest cost:** multi-call latency/budget — why C is a mode. (The source article frames this
  with some hype; the *method* is the sound, peer-reviewed part.)
