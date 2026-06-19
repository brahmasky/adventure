# ADR 0008: Houge's identity & authenticated read

- **Status:** accepted (boundary; v1 scope below, implementation later)
- **Date:** 2026-06-19
- **Deciders:** Paco

## Context

Tier-1 web read ([ADR 0006](0006-web-read-capability.md)) covers the open web, but the
valuable cases increasingly sit behind a login — e.g. an X long-form article that
returned a login wall even to a real browser (`dev-browser`). Reading that needs an
*authenticated* session, and the only safe way to give an agent one is a **dedicated,
isolated identity** — never the operator's own session (driving the user's logins is the
Comet/Operator lethal-trifecta failure). Paco has registered `wukong.houge@gmail.com` as
Houge's own identity for exactly this. This ADR sets the **boundaries** for it; it extends
ADR 0006's gated Tier-3 with an identity layer. Implementation is deferred until the
boundary is agreed.

## Decision

### 1. Isolated identity — the foundation

Houge operates a **dedicated identity fully separated from Paco's**: its own Gmail
(`wukong.houge@gmail.com`), its own browser profile / cookie jar, its own token store.
It **never touches Paco's accounts, sessions, or inbox.** If Houge's identity is
compromised or injected, the blast radius is *his*, not Paco's. Houge is a **transparent
agent identity**, not a human impersonation. **The Gmail is the crown jewel** (the
recovery hub for everything he registers) and gets the strongest protection — its
security is not relaxable.

### 2. Read-only under the identity (v1)

Authenticated access is for **reading**. **Out of scope for v1:** sending email, posting/
publishing, paid actions, account changes, anything with an external side effect. (Sending
email is explicitly deferred — revisit later.) Reading authenticated content is the "explore
freely" part; consequence stays gated, exactly as `external_write` already is.

### 3. API + scoped token over browser session (the safety principle)

**Prefer a scoped, read-only API token wherever a site offers one; fall back to an isolated
browser session only when forced.** A token is structured, rate-limited, revocable, and
cannot be session-hijacked or talked beyond its scope; a logged-in browser carries a whole
session an injection could ride. This is the most risk-reducing rule in this ADR.

### 4. Manual registration; Houge requests, Paco holds the keys (v1)

Houge **does not self-register or handle credentials in v1.** He may **raise a request**
("I'd like read access to site X for purpose Y"); **Paco** approves, registers, and
**establishes the access** (issues the read-only token / logs the isolated browser profile
in). Houge merely *uses* that pre-established access to read — so he never sees a password,
a 2FA code, or a login flow. (Houge-reads-his-own-inbox and self-registration are deferred
with the future "send/act" scope.)

This "Houge requests, human approves + performs the privileged step" pattern **is governed
self-extension** (the Beyond-V2 track): the agent gets agency to *ask* to go further; the
human keeps the keys. It reuses the existing proposed → approved gate.

### 5. Authorization is scoped: per service + purpose + time-bound (v1)

An authorization grants read access to **one service, for a stated purpose, for a bounded
window** — never a blanket "use the identity freely." This prevents "read this article" from
creeping into "do anything." Scope widens only as concrete scenarios accumulate.

### 6. The v1 allowlist

| Site | Mechanism | Notes |
|------|-----------|-------|
| **github.com** | **read-only scoped API token (PAT)** | First-class API; structured/revocable; most content is public anyway. Lowest risk, high value. |
| **x.com** | **isolated browser session** (`dev-browser --connect` to his profile) | No useful read API → forces Tier-3 browser. Accept the caveat: logged-in automation likely **breaches X's ToS** (ban risk) and is fragile (anti-bot). The motivating case, the riskier one. |

Excluded for v1: sites that need no login (arXiv, HN, public GitHub — Tier-1 already reads
them); **LinkedIn** (aggressive anti-bot, near-certain ban); anything **paywalled/paid**.
Future candidate: **Reddit** (via API) for community coverage.

### 7. The outer wall — ethics / ToS / legal (constitutional)

Respect Terms of Service: **no abusive automation, no anti-bot/CAPTCHA evasion in violation
of terms, no fake engagement, no scraping at scale.** Nothing illegal or harmful; be honest
it's an agent. This sits in the constitution (紧箍咒) — no authorization or lesson relaxes it.

### 8. Containment & the lethal trifecta (still applies, even isolated)

- **Reader/actor separation holds.** Authenticated content (and, later, the inbox) is
  **untrusted data** — a prime injection vector (the EchoLeak class). The component reading
  it has no action authority; it cannot, in the same ungated breath, act. Isolated identity
  does not dissolve the trifecta — read-only v1 removes the outbound/action leg.
- **Full audit + reviewable footprint** — every registration request, granted access, and
  read under the identity is recorded in the ledger; Paco can review Houge's footprint.
- **Bounded** by the global budget breaker; pausable via `/guard`; credentials in an
  isolated, encrypted store.

## Consequences

- **Reach without exposure:** Houge can read gated content (X articles, GitHub) under *his*
  identity, with Paco's blast radius untouched. The isolated identity is the containment.
- **Honest costs:** the X account risks a ToS ban; the Gmail is a high-value target; browser
  automation is fragile (CAPTCHA/2FA/anti-bot) — expectations are modest.
- **First time Houge acts under an identity** — even read-only authenticated access is a real
  escalation, which is why it's gated, isolated, allow-listed, and human-keyed. Sending/
  posting/paying remain firmly out until a future ADR re-scopes them with their own review.

## Alternatives considered

- **Drive Paco's logged-in browser/session** — rejected outright: it's the Comet/Operator
  failure (the user's whole session + untrusted content + a navigating agent).
- **Browser session for GitHub too** — rejected: a scoped read-only token is strictly safer
  and fits the existing provider pattern; use the API.
- **Let Houge self-register via the inbox now** — deferred: registration agrees to ToS (a
  legal act) and creates footprint; v1 keeps the human performing the privileged step.
- **Open browsing under the identity (no allowlist)** — rejected: per-service/purpose/
  time-bound scope is what keeps authorization from becoming a blanket key.
