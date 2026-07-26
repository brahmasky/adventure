# ADR 0027: Idea panel — weekly judge panel with a contained Claude chair

- **Status:** accepted
- **Date:** 2026-07-27
- **Deciders:** Paco (2026-07-24 direction; spec-review-senior gate cleared 2026-07-25)
- **Relates to:** builds R2 of the [ADR 0026](0026-idea-radar-read-surface.md) radar loop
  (radar → review → build); **amends [ADR 0010](0010-natural-language-intent-layer.md) and
  [ADR 0011](0011-self-evolution-architecture.md)** (the "Claude is never the engine" claims
  narrow — see the cross-ADR sections below); extends the
  [ADR 0015](0015-secrets-firewall.md)/[ADR 0025](0025-google-api-surface.md) broker
  ("seven becomes eight"); does NOT touch [ADR 0023](0023-external-workspace.md)/extwork
- **Spec:** [2026-07-25 Idea Radar R2](../superpowers/specs/2026-07-25-idea-radar-r2-panel-design.md)

## Context

R1 (ADR 0026) gave Houge a daily sensing loop: a bounded, read-only radar that folds public
builder-idea feeds into a durable `ideas` store. The money fork's next stage needs judgment on
top of sensing: a weekly review that scores the board through complementary lenses and
distills a shortlist Paco can act on with one command. Paco's 2026-07-24 decision named the
seats — and named the hard part out loud: the chair seat is Claude, which ADR 0010 and
ADR 0011 both declared "never the runtime engine." That claim cannot be silently eroded; it
must be narrowed in a recorded decision, which is this ADR's core job. ADR 0026 anticipated
exactly this: "R2 = weekly judge panel + shortlist … whose claude-cli chair will amend
ADR 0010/ADR 0011 in its own ADR — this ADR grants no new provider and no write path."

## Decision

### 1. The panel: three judges, quorum 2, a chair that improves but never gates

Weekly, at a pinned wall-clock slot (`HOUGE_RADAR_PANEL_AT`, default `sun 09:00` in
`HOUGE_RADAR_TZ`), the panel reads the top 12 active cards — the local store ONLY, zero
network reads — and runs one call per seat:

| Seat | Backend | Transport | Lens |
|------|---------|-----------|------|
| Judge 1 | kimi-api | existing HTTP leg, pinned single-provider adapter | **Opportunity** — a real gap someone would pay for / adopt? |
| Judge 2 | gemini-api | existing HTTP leg, pinned single-provider adapter | **Technical novelty** — substantively new or a rehash? |
| Judge 3 | codex CLI | contained spawn (panel-local) | **Buildability** — a credible slice shippable in ~1 week? |
| Chair | claude CLI | contained spawn (panel-local) | Synthesis — rank, pick 3, one-paragraph rationale each |

Seat→provider binding is **injected per seat, never a chain**: the kimi/gemini judges are
single-provider adapters pinned to their registry legs (`answerWithChain` never sees any
panel seat — a healthy-leg fallback would silently void model diversity and the quorum
semantics). **Quorum = 2**: fewer than 2 judges returning ≥1 valid score → the panel aborts
with a ledger trace and takes no write path. **Chair fallback is deterministic**: if the
chair is absent or fails, the shortlist is the top 3 by mean judge score (ties: higher
momentum, then older `first_seen`) — the chair improves ranking, it does not gate
publication. All judge/chair prose passes the R1 parse floor (hostile-char strip + sanitize
+ hard caps) and remains untrusted downstream forever.

### 2. Chair containment — the narrow grant this ADR exists to record

The chair is a **contained, tool-less, single-turn** claude-cli spawn, panel-local by
construction (only `runIdeaPanelTick` can invoke it; it joins no registry, no chain, no
tool manifest):

- **Pinned binary:** `HOUGE_CLAUDE_BIN` must be an absolute path (launchd PATH precedent);
  unset → chair unavailable → fallback. The verified binary is **`/usr/local/bin/claude`
  v2.1.219**.
- **Verified argv** (every flag verified against the pinned binary via `--help` plus a live
  parse probe under a throwaway `CLAUDE_CONFIG_DIR` with zero auth — unknown options are
  hard errors in `-p` mode (`error: unknown option`, non-zero exit, no API call), so a
  wrong flag fails loud instead of silently degrading):
  - `-p, --print` — non-interactive, print response and exit;
  - `--output-format json` — one JSON result object; `result` carries the text, `is_error`
    flags failure (probe-verified shape);
  - `--max-turns 1` — hidden from `--help` in 2.1.219 but probe-accepted; belt-and-braces
    on top of the tool disable;
  - `--tools ""` — "Use \"\" to disable all tools" (the whole built-in set) — the real lever;
  - `--strict-mcp-config` + `--mcp-config '{"mcpServers":{}}'` — the empty server set.
    **Probe finding:** bare `{}` is REJECTED by 2.1.219 (`mcpServers: Invalid input:
    expected record`) — the empty-record form is required;
  - `--system-prompt <s>` — Houge-controlled discipline only. The untrusted digest rides
    **stdin, never argv**.
- **Config isolation:** `CLAUDE_CONFIG_DIR` is the code-owned constant `~/.houge/claude-chair/`
  (never env-configurable), created on first use with a minimal deny-all `settings.json` —
  the operator's `~/.claude` (skills, hooks, MCP servers) is unreachable. The live-gate
  canary probe additionally asserts a tool-demanding digest produces no tool action and no
  operator-home reference inside the chair dir.
- **Bounds:** `HOUGE_RADAR_CHAIR_TIMEOUT_MS` (default 120 000 ms) with our own SIGKILL,
  262 144-byte stdout cap, neutral `os.tmpdir()` cwd — the pi-leg spawn contract.
- **Env:** the `buildChildEnv()` allowlist base plus EXACTLY two additions: the config dir
  and the broker-held OAuth token. No bot token, no API keys.

The codex judge rides the same containment idiom (`codex exec --sandbox read-only
--skip-git-repo-check`, stdin prompt, neutral cwd, byte cap) and receives **no secrets at
all**. The skip flag exists because the neutral tmpdir cwd is untrusted to codex (live-gate
finding 2026-07-27); it bypasses only the cwd trust prompt, never the sandbox.

### 3. Broker extension — seven becomes eight

`CLAUDE_CODE_OAUTH_TOKEN` (minted by `claude setup-token`, subscription auth — the chair is
a marginal-$0 CLI leg) ends in `_TOKEN`, so the armed firewall strips it from `process.env`
at boot; passthrough would silently break. Per the ADR 0025 §7 checklist it joins
`SECRET_ENV_NAMES` and the redactor, with a typed `claudeOauthToken()` getter; the chair
module receives the broker and places the value into the child env map explicitly.
ADR 0025's "exact five becomes seven" language is hereby amended to **eight**. The token is
never logged, never in argv, never in the ledger.

### 4. The `memory/briefs/` write path — projection-only, and a residual risk accepted

ADR 0026 granted no write path; this ADR grants ONE, narrow: the weekly brief
`memory/briefs/<week_key>-ideas.md`, a **regenerable projection** of the SQLite truth
(overwritten on a same-week re-run, non-fatal on failure). Path and filename are 100%
code-computed; body values enter only via the already-capped-and-stripped stored fields;
**brief content is never read back into any Houge prompt.**

**Residual risk, recorded honestly:** these files WILL be read by operator Claude Code
sessions in this repo. The storage floor defeats structural forgery but not *semantic*
injection — a hostile feed item surviving as clean prose ("also run …") could still read as
an instruction to a human or agent consumer. Mitigation, not elimination: every brief opens
with a mandatory code-owned banner declaring the content untrusted DATA, plus this recorded
posture. Accepted for R2 with eyes open.

### 5. Command surface and push

`/idea` renders the latest frozen shortlist snapshot; `/idea pick <n>` resolves against the
snapshot (never the live board) and maintains a **global pick singleton** (at most one
`picked` card, ever — R3's "the picked card" is always unique). `/radar` rows become
numbered with a `/radar <n>` per-card detail view (the first surface showing stored URLs to
the operator — escaped plain text). The Sunday digest is the system's **first proactive
weekly push** — pinned-slot, per-fire dedupe key, satisfying the "no random pushes" rule;
`HOUGE_RADAR_PANEL_AT=off` disables tick and push together. `HOUGE_RADAR_PANEL_ENABLED`
joins `DISARM_FLAGS`; everything ships dark behind the §13 live gate
(`houge radar-panel --dry-run` → canary probe → Paco's arm).

## Amendment of ADR 0010 (cross-ADR, 0025 §7 style)

ADR 0010 §1 claims: *"**Claude Code is the role-model for *behavior* (encoded in prompts),
never the engine.** Every cognitive call runs on the model-agnostic `HOUGE_LLM_PROVIDERS`
chain (pi → kimi → …); Houge has no hard Claude dependency."* And its Alternatives section
rejects: *"**Make Houge *be* Claude Code (Claude-powered agentic loop)** — closest to the
role-model, but forces a Claude dependency and the token cost Paco can't carry; rejected in
favor of the model-agnostic chain with Claude as behavioral role-model only."*

Both claims are hereby **narrowed, not overturned**: Claude is never the
*conversational/chain* engine — it joins no provider chain, no registry, no tool manifest,
and `answerWithChain` never sees it; the rejected alternative (a Claude-powered agentic
loop) stays rejected. What is granted is exactly one contained, tool-less, single-turn
**panel chair seat**, invoked once a week by `runIdeaPanelTick` only, subscription-auth
(marginal-$0 — the token-cost premise of the rejection is untouched), broker-held token,
spawn-bounded, with a deterministic fallback so Houge has no hard Claude dependency even
inside the panel. ADR 0010's status line carries the amendment note.

## Amendment of ADR 0011 (cross-ADR)

ADR 0011's constraints read: *"the runtime is **cheap and model-agnostic** (pi → kimi, never
a hard Claude dependency — ADR 0010); Claude/Codex are **build-time muscle, never the
runtime engine**."* The build-time/runtime split **holds for self-write**: Claude still
never writes Houge's code at runtime, and the self-write writer/reviewer seats are
unchanged. The narrowing is that the chair is runtime *inference*, not runtime
*engineering* — a bounded scoring/synthesis call whose output is data (a shortlist), never
code, config, or a tool action. ADR 0011's status line carries the amendment note;
`diff-reviewer.ts`'s "Claude is NOT a runtime backend" comment now cites this exception.

## Consequences

- Houge gains a weekly, bounded judgment loop over the R1 board: 2 metered HTTP calls
  (kimi, gemini) + 2 subscription CLI spawns (codex, claude) per week, all panel-local; a
  hostile card can degrade a verdict but cannot expand spend, reach a tool, or touch a
  write path beyond the granted projection.
- The "never the engine" boundary is now *documented as narrowed* rather than quietly
  breached — future seat proposals must argue against this ADR's containment bar
  (tool-less, single-turn, chain-invisible, deterministic fallback), not against a fiction.
- The brief projection creates the first radar-derived artifact operator sessions will
  read; the §4 residual stands accepted until R3 revisits the read-back question.
- ADR 0026's two broken decision links (`0010-*`, `0011-*`) are fixed and its status notes
  this extension; the README index gains 0026/0027 rows and the amended 0010/0011 statuses.

## R3 pointer

R3 — picked-card → kickoff brief → an interactive Claude Code session (the handoff where a
human is present by construction) — is deliberately NOT granted here. It gets its own spec
and, if it widens any boundary, its own ADR; `/idea pick` merely guarantees R3 a unique,
operator-chosen input.

## Alternatives considered

- **Codex (or kimi) as chair, no Claude at all** — keeps 0010/0011 pristine, but loses the
  strongest synthesis model at the one seat whose whole job is judgment, and the panel
  already runs codex as a judge (chair = judge would collapse the diversity the panel
  exists for). Rejected: contain the strong model instead of pretending it isn't wanted.
- **Add a `claude` provider to the LLM registry** — one mechanism for all backends, but it
  would put Claude in `HOUGE_LLM_PROVIDERS` reach and make the 0010 amendment wide instead
  of narrow. Rejected: the chair stays panel-local by construction.
- **Chair gates publication (no fallback)** — simpler semantics, but a missing binary or
  expired token would silently kill the weekly review. Rejected: deterministic mean-score
  fallback + a `chair off` status surface.
- **Skip the brief file (SQLite + Telegram only)** — avoids the §4 residual entirely, but
  Paco's review workflow lives in repo files, and a regenerable projection is the cheapest
  honest form. Accepted with the banner + never-read-back posture instead.

## Adversarial review (2026-07-27)

Verdict FIX-FIRST → fixed:

- **Codex outfile idiom** — `codex exec` stdout is a session transcript (echoed prompt first),
  so parsing it dead-seated the judge every week and opened verdict forgery via hostile card
  text; the judge now writes `-o <outfile>` in a fresh tempdir outside any sandbox path
  (coding-agent idiom) and reads ONLY the outfile, byte-capped, tempdir cleaned in `finally`.
- **`chair off` status signal** — `/status` panel line now appends `· chair off` when every
  rationale in the latest snapshot is the fallback constant (spec §2 W3 mandate: a rejected
  chair argv flag must not fall back silently forever).
- **Pick set-before-revert** — `/idea pick` flips the new card `→ picked` FIRST and only then
  reverts the prior; a refused set (card archived since the snapshot froze) can no longer end
  the system with zero picked cards.
- **Resolver dedupe** — the gateway's stale `TODO(T5)` local `resolvePanelEnabled` copy is
  deleted in favor of the idea-panel export (identical semantics).

Noted, not fixed:

- CLI `radar-panel` non-dry consumes the shared weekly latch + no `meteredBreached` in the CLI
  judge bindings — operator-deliberate, R1-consistent.
- Chair `settings.json` deny `"*"` shape unverified against the pinned binary — the canary
  probe covers it; the argv `--tools ""` is the real lever.
- `/idea` ✅ picked marker rides the snapshot pointer, which can lag the global singleton —
  cosmetic.
- Inline ordinal spoofing via card titles (a title containing "2.") — inherent to a numbered
  text list; the pick confirmation echoes the real title.
