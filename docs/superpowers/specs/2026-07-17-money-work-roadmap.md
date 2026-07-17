# Money-Work Roadmap — capability + infrastructure scoping (2026-07-17)

**Status:** SCOPE APPROVED by Paco 2026-07-17 (plan mode). NOT a build authorization — each
phase waits for a `/goal`. P0 is Paco's formal charter re-decision; the first *build* goal is P1.

This is the analogue of the spine roadmap (`docs/ROADMAP.md`) for the declared next major:
**Houge autonomously earning money via bounty jobs / hackathon projects / credits.** It re-opens
charter fork 3 (real money / trading / fund custody), which was gated on "the spine proving stable
autonomy" — now met (spine ⓪–④ complete + live).

## The governing insight

The human-gated split the **real world** forces and the split the **charter** forces are the
same. On every venue (Algora, Gitcoin, agent-native TaskBounty) the account, identity/KYC, the
accept decision, and the payment rail are human-gated; and ADR 0001 independently requires
payments, acting-under-identity, and external writes to stay deterministic + human-approved. So
the first versions need **none** of the heavy autonomy infra (S-3 auto-rollback, secrets-firewall
Phase 2, dual-LLM Phase 2, the 2-week soak) — the existing human `/approve` tap is both the
charter's safety net and a real-world requirement. Autonomy (reducing human taps) is a later,
optional phase.

## Locked decisions (Paco, 2026-07-17)

1. **Human-fronted funds only.** Houge does the engineering; the human owns the account, wallet,
   KYC, the approve-to-submit tap, and receives the money. Houge NEVER holds private keys, has
   payment custody, or moves money. An earnings *ledger* tracks earnings (accounting only — the
   mirror of the spend governor `src/budget/global-budget-ledger.ts`), never custody. Fork 3's
   hard core (custody/trading) stays deferred; only earning is unlocked.
2. **External engineering workspace first** (P1). Bounty intake, external submission, and
   credentials are later goals.
3. **Local container sandbox** (Docker/Podman) for untrusted external code — a system-service
   dependency like Ollama (npm deps stay `{}`).

## Charter guardrails (non-negotiable)

- ADR 0001 floor stays deterministic + human-`/approve`-gated: payments, fund movement/custody,
  account creation / acting-under-identity, external code submission, credential handling. The
  model DRAFTS; deterministic code validates. The `paid`/`external_write` side-effect levels
  already exist as gated placeholders (`src/domain/types.ts`, `src/policy/capability-policy.ts`) —
  they need adapters behind the gate, not new gates.
- Two hard lines: no adverse impact to Houge's own operation; no leaking secrets.
- DEFERRED (not in this roadmap): Houge holding funds/keys, trading, custody; the browser/
  acting-web tier (target API-driven venues to avoid it); the autonomy flip (Milestone A).

## Phases

- **P0 — Charter re-decision — DONE 2026-07-17 (ADR 0022, `/goal p0`):** fork re-opened narrowly
  — earning via human-fronted accounts IN; Houge holding/moving money OUT. ROADMAP fork 3 amended.
- **P1 — External engineering workspace + container sandbox (NEXT build `/goal`):** clone an
  external repo + fix an issue + build/test it **inside a container** (real fs/process/network
  isolation; no live-node_modules symlink — fresh deps), produce a tested patch/branch Paco
  reviews locally. Charter-clean, zero autonomy infra, no credentials/external-write/money.
  Reuses Codex coding agent + evolution-lane pattern; generalizes `test-gate.ts` to a per-project
  toolchain runner; container-runner detects Docker/Podman like `embeddings.ts` detects Ollama.
  Live gate: fix a real GitHub issue in-container → tested diff; stress-test with a hostile
  `postinstall` that must stay contained.
- **P2 — Bounty intake + scam/legitimacy classifier + durable project state:** scan bounties via
  GitHub/agent-native-platform APIs (no browser); rank by legitimacy/competition/effort; a
  scam filter (~21% of "bounty" repos are fake); a `projects` store for multi-session job state
  (mirrors `scheduled_tasks`/`runs` in `run-store.ts`). Output = ranked plan for Paco.
- **P3 — Human-gated external delivery + credential harness + earnings ledger → "first dollar":**
  external push/PR as a deterministic `/approve`-gated `external_write` capability (generalize
  `branch-publish.ts` beyond own-origin); a scoped runtime credential store (the firewall
  currently STRIPS conventionally-named tokens, so this is a designed store + broker getter, not
  an env var); earnings ledger (funds land in the human's wallet/Stripe). Best first targets:
  agent-native automated-accept-gate platforms (TaskBounty) + GitHub-API/Algora with a
  human-fronted account.
- **P4 — Autonomy increments (LATER, optional):** only here do Milestone A preconditions become
  prerequisites (S-3 auto-rollback, secrets-firewall Phase 2 broker process, dual-LLM Phase 2
  CaMeL, ≥2-week soak — the convergence-soak instrument exists). First autonomy target =
  platforms whose accept gate is an automated test, not a human maintainer. Gated on Paco's
  explicit re-decision.

## Recon basis (2026-07-17, three subagents)

- **Capability inventory:** four hard blockers — no external-project workspace (write path
  hardwired to `process.cwd()`), no acting-web tier (GET/HEAD static only), no runtime credential
  lifecycle (firewall strips new tokens), zero financial rail (`paid` is an empty policy
  placeholder). Strong reusable seams: armed loop-tool pattern, dual-LLM quarantine, worktree +
  Codex sandbox, test-gate structure, the existing `paid`/`external_write` gate, evolution-lane,
  spend governor (earnings-ledger mirror).
- **Charter constraints:** research is charter-clean now; money/custody deferred behind a
  charter-level `/goal`. Autonomy flip needs 3/4 Milestone A preconditions still pending. ADR 0001
  keeps payments/custody/identity/merge deterministic.
- **Money-task surface:** accept + payment identity is the real bottleneck, not code quality
  (one agent: 2,500 issues scanned, 8 PRs, 1 merged, $0). Agent-native platforms (TaskBounty,
  E2B-sandbox automated accept gate, 80/20 payout) = least friction. Crypto wallet is the only
  agent-holdable rail; fiat needs a real person. First-dollar path = GitHub/agent-native bounty,
  human fronts account+wallet, agent does the engineering.
