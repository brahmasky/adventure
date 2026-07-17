# ADR 0022: Money fork re-opened — earning is IN (human-fronted), custody stays OUT

- **Status:** accepted
- **Deciders:** Paco (charter-level `/goal p0`, 2026-07-17)

## Context

The charter's strategic fork 3 (`docs/ROADMAP.md`) has stood LOCKED since 2026-06-26:

> 3. Real money / trading / fund custody DEFERRED until the spine proves stable autonomy.

Free/non-financial task execution ("producing work") stayed IN as a test of the spine; only the
financial class was deferred, and the deferral was explicitly conditional — *"until the spine
proves stable autonomy."* That condition is now met: the self-evolution spine (⓪ inner loop, ①
eval loop, ② episodic memory, ③ http_fetch, ④ wiki) is complete and live-gated, and the safety
floor has been substantially hardened since the deferral (kill-switch ADR 0018, metered ceiling
ADR 0019, DB backup ADR 0021, plus the S12 secrets-firewall and D12 dual-LLM live probes both
passed 2026-07-17).

Paco has declared the next major direction — **Houge earning money via bounty jobs / hackathon
projects / credits** — and it is a charter-level decision, not an ordinary build. Un-deferring
requires re-deciding fork 3. This ADR records that re-decision and, crucially, draws the line
*inside* the deferred class: earning is not the same risk as custody.

The full capability + infrastructure plan lives in
`docs/superpowers/specs/2026-07-17-money-work-roadmap.md` (scope approved 2026-07-17). This ADR is
the governance decision that opens the fork; that spec is the sequenced build plan.

## Decision

We re-open fork 3, **narrowly**: Houge may do the *engineering work* that earns money, but never
holds, moves, or has custody of the money.

1. **Earning is IN — human-fronted.** Houge may find, understand, implement, and test paid work
   (bounties, hackathon projects, credit-earning tasks). The **human owns the account, wallet,
   identity/KYC, the approve-to-submit tap, and receives all funds.** Houge does the reversible
   cognitive + engineering work up to a reviewed, submittable deliverable.

2. **Custody stays OUT (fork 3's hard core remains deferred).** Houge **never holds private keys,
   never has payment custody, never moves or trades money.** Trading and fund custody remain
   deferred with no near-term path. An **earnings ledger** may track what was earned — accounting
   only, the mirror of the existing spend governor (`src/budget/global-budget-ledger.ts`) — and it
   holds no value and no keys.

3. **The ADR 0001 floor is unchanged and binding.** Every irreversible/paid/identity action stays
   deterministic and human-`/approve`-gated: payments, account creation, acting-under-identity,
   external code submission (push/PR to a remote we don't own), and credential handling. The model
   may DRAFT these; deterministic code validates and a human approves. No such gate ever moves
   into the LLM. The `paid`/`external_write` side-effect levels already exist as gated
   placeholders — they gain adapters *behind* the gate, never a weaker gate.

4. **The two hard lines still bound everything:** (a) no adverse impact to Houge's own operation;
   (b) no leaking secrets — which now extends to any human-fronted credential Houge is entrusted
   to use.

5. **Explicitly still deferred (not opened by this ADR):** Houge holding funds/keys, trading, fund
   custody; the browser/acting-web tier (the roadmap targets API-driven venues to avoid it); and
   the autonomy flip (Milestone A) — the first money-work phases run under the *existing*
   human-tapped gate, so none of Milestone A's pending preconditions are required to begin.

## Consequences

- **Un-blocks** the money-work roadmap's first build phase (P1: an isolated container workspace
  where Houge clones, fixes, and tests an external repo → a reviewed patch), which is charter-clean
  under this decision — it produces work, holds no money, submits nothing externally.
- **The human-in-the-loop is load-bearing, by design and by reality.** The same human tap that the
  charter requires for paid/identity actions is also what every real venue requires (accounts,
  KYC, the accept decision, and the payment rail are human-gated everywhere). The first versions
  therefore need none of the heavy autonomy infrastructure; the human `/approve` is the safety net.
- **Reversible.** This is a scope decision, not a mechanism. It commits no code; the eventual
  money-work capabilities will be flag-gated (default OFF) and covered by the existing kill-switch
  / disarm posture (ADR 0018). Paco can re-close the fork at any point.
- **Constrains future work:** anything that would have Houge hold value, move money, trade, or act
  under a human's identity *without* a per-action human approval requires a *new* charter ADR
  superseding this one. The autonomy flip for money actions is a separate, later re-decision
  (roadmap P4), gated on Milestone A.

## Alternatives considered

- **Keep fork 3 fully deferred.** Rejected: the deferral's stated precondition (spine proves
  stable autonomy) is met, and Paco has chosen to proceed. Keeping it closed would leave a
  charter-clean, high-value capability (producing paid engineering work) on the table for no
  safety gain — the risk lives in custody, not in doing the work.
- **Open the full fork (custody + trading + autonomous money movement).** Rejected: custody is the
  one class that breaks the charter's reversibility premise ("mistakes are cheap and reversible");
  it is irreversible harm to the operator and squarely in ADR 0001's deterministic floor. There is
  no need to take on custody risk to earn — the human fronts the funds.
- **Houge holds a scoped receive-only wallet now.** Rejected for v1 (offered and declined at
  scoping): even receive-only custody re-opens key handling and the deferred class prematurely.
  Deferred to a possible later ADR if human-fronted earning proves out and Paco re-decides.
