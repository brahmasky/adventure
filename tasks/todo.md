# Goal 4 — Tier-1 Web Read (per ADR 0006)

**Active /goal (Stop-hook gate):** pluggable web-provider registry (Tavily provider, graceful
when key unset) → `web_search` external_read capability → `web-research` program reachable as
`/research <topic>`; 猴哥 answers WITH source URLs. Tier-1 guardrails: web content = untrusted
data (embedded instructions don't alter the prompt), provenance on every claim, Telegram link
previews disabled, per-run result cap + global breaker, ledger audit. Docs updated. `npm test`
green + typecheck clean + zero new deps + a LIVE `/research` run answered unattended with real
sources in Telegram.

## Design (mirror the LLM provider chain)

- `src/web/` mirrors `src/llm/`: types + registry + providers/{tavily,firecrawl}.
- `web_search` capability adapter (external_read) like `llm-answer.ts`.
- `web-research` program in core-worker: search → 猴哥 synthesis (web text as UNTRUSTED data,
  cite sources) → sourced report + Telegram answer.
- `/research <topic>` parsed as run/web-research/<topic> (sugar; no new run machinery).
- Build providers against REAL API shapes (lock via one live call each, like pi/kimi).

## Build steps (each independently green)

- [ ] 0. Lock real API shapes: one live Tavily + one live Firecrawl search (keys from .env,
      never printed) → capture response structure.
- [ ] 1. `src/web/types.ts` + `registry.ts` (buildWebChain `tavily,firecrawl`, searchWithChain
      first-ok-wins fallthrough) + tests.
- [ ] 2. `providers/tavily.ts` + `providers/firecrawl.ts` (injectable fetch; missing key →
      unavailable) + tests against real-shape fixtures.
- [ ] 3. `web_search` capability adapter (external_read) + tests.
- [ ] 4. `web-research` program (core-worker): search → synthesis with provenance + untrusted-
      data framing; per-run result cap; ledger audit of urls/sources + tests.
- [ ] 5. `/research <topic>` in telegram-command-parser → run/web-research + tests.
- [ ] 6. Disable Telegram link previews on bot messages (telegram-client/sendMessage) + test.
- [ ] 7. Docs: TAVILY/FIRECRAWL + web settings in configuration.md + .env.example; README/spec
      note web-research available.
- [ ] 8. typecheck clean, npm test green, build ok, zero new deps.
- [ ] 9. LIVE: `/research <topic>` → daemon answers unattended with real sources in Telegram.

## Review

DONE — all gate criteria met and live-verified.

- `src/web/` (types + registry + tavily/firecrawl providers) mirrors the LLM chain;
  providers locked against the live APIs. `web_search` capability (external_read) +
  `web-research` program (search → 猴哥 synthesis with sources) + `/research <topic>`.
- Tier-1 guardrails (ADR 0006): web results ride the data channel, synthesis system
  prompt is fixed (a test proves an injected "ignore your instructions" can't change it);
  provenance + `web_search_performed` ledger audit; Telegram link previews disabled;
  per-run result cap + global breaker.
- Tests +25 (262 total), typecheck + build clean, zero new deps.
- **Live-verified twice:** a CLI smoke (real Tavily + LLM → sourced Anthropic-news answer),
  then the full daemon+Telegram path — the daemon ran ~11h overnight, recovered from a
  transient fetch error, and answered a live `/research` (SPCX stock) with a detailed,
  cited, in-character 猴哥 answer delivered to Telegram.

Next candidates: Goal 3 scheduler (now has a useful job — a daily /research brief);
Tier-3 gated browser (dev-browser/agent-browser, needs /cso); `/guard` control surface.

---

# Goal 3 — Scheduler (DEFERRED behind the web capability)
# Goals 1–2 done (breaker, daemon); 猴哥 identity + ADRs 0001–0006 merged.
