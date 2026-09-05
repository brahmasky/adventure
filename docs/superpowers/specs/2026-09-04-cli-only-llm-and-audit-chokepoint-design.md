# CLI-only LLM legs + structural audit chokepoint

Date: 2026-09-04
Status: spec reviewed + independently code-reviewed 2026-09-06 (findings below). **Slice 1 SHIPPED** 2026-09-06, live gate PASS. Slice 2 (audit chokepoint) not started.
Author: Paco + Claude

## Problem

A Google bill of ~15–16 AUD/month traced to Gemini API usage does not tally with
Houge's own ledger, which records $1.06 of `gemini-api` spend across the whole
2026-06-26 → 2026-09-03 window. Investigation found four separate defects.

### D1 — the flat-rate Gemini leg is dead

`AGY_DEFAULT_MODEL` in `src/llm/providers/agy-cli.ts` pins `"Gemini 3.5 Flash (Low)"`.
That model no longer exists in the installed `agy` binary. A live probe returns:

```
"status":"ERROR","error":"invalid model selection (--model \"Gemini 3.5 Flash (Low)\")...
Available models: Gemini 3.8/3.7/3.6 Flash (High|Medium|Low), Gemini 3.1 Pro (High|Low),
Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B (Medium)"
```

The provider maps a non-zero exit to `unavailable`, so the chain silently falls
through to the metered legs. The subscription-funded leg has been contributing
nothing, and no signal was emitted because failed legs are not recorded anywhere.

### D2 — the reader chain leads with a metered leg

`HOUGE_LLM_READER_PROVIDERS=gemini-api,agy-cli`. The Dual-LLM quarantined reader
(ADR 0014) fires on every external-read tool output and is the highest-volume LLM
consumer in the system (742 `web_search_performed` events). It has always gone to
the paid Gemini API first, with the dead CLI leg as its only fallback.

The *intent* was right: the reader must sit on a different model family from the
planner for injection resistance. The mistake was reaching for the metered Gemini
API rather than the Gemini CLI.

### D3 — thinking tokens are invisible

`extractUsage` (`src/llm/providers/openai-compat.ts:71`) reads only `prompt_tokens`
and `completion_tokens`. Google's OpenAI-compat endpoint bills the gap between those
and `total_tokens` as output. Measured live:

| probe | prompt | completion | total | hidden |
|---|---|---|---|---|
| trivial | 12 | 54 | 611 | 545 |
| reader-shaped, small | 94 | 132 | 849 | 623 |
| reader-shaped, 1.4k input | 1438 | 147 | 2418 | 833 |

Output is undercounted 5–11x; total cost ~3.6x. The metered-$ ceiling (ADR 0019)
sums these same figures, so `metered_fuse_state.fused = 0` is not evidence of
restraint — the fuse cannot trip on spend it cannot see.

### D4 — whole call paths emit no telemetry

Telemetry is an opt-in `onUsage` hook passed at adapter construction. These sites
never pass it, so they record nothing at all:

- `src/telegram/telegram-daemon.ts:149` — the daemon tick adapter, used by episodic
  distill (1 extract + 1 reconcile per fact), episodic consolidate, lesson
  consolidate, and idea radar.
- `buildPanelSeatBindings` (~`telegram-daemon.ts:459`) — both pinned panel judges.
- `src/core/core-worker.ts:1001`, `:2562`, `:2579` — direct `this.llmAdapter` calls
  that bypass the instrumented `llmAdapterFor`.

A structural cause sits underneath D4: `recordLlmCall` writes via
`appendRunLedgerEvent`, which requires a `run_id`. Daemon tick work has no run, so
even a wired hook would have had nowhere to write.

## Goals

1. No LLM call in Houge's runtime reaches a metered pay-per-token API by default.
2. Every LLM call attempt — success, failure, or fallthrough — is recorded in the
   ledger, including calls made outside any run.
3. Token counts, where the engine reports them, include thinking/reasoning tokens.
4. A leg dying the way agy died becomes visible within one tick.

## Non-goals

- Removing the metered provider code. It stays, unreachable by default (decision
  below).
- Optimising reader latency. Accepted as-is (decision below).
- Backfilling corrected token counts onto historical events.

## Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Metered legs | Keep the code, remove from every default chain | If a CLI leg dies again, re-enabling a paid leg is an env change, not a redeploy. The pricing table and fuse stay meaningful for that case. |
| Audit enforcement | Structural chokepoint in `answerWithChain` | Opt-in hooks are what produced D4. A required parameter cannot be forgotten. |
| Reader latency | Accept CLI spawn cost | Houge is asynchronous over Telegram. Measure before optimising. |

## Design

### Chain layout

| Surface | Before | After |
|---|---|---|
| Planner | `pi,agy-cli,kimi-api,gemini-api` | `pi,agy-cli` |
| Reader | `gemini-api,agy-cli` | `agy-cli,pi` |
| Panel judges | pinned `kimi-api` + `gemini-api` | pinned `agy-cli` + `pi` |
| Self-write | codex writer, kimi-cli reviewer | unchanged |

The reader is deliberately the planner reversed. The planner leads with Kimi, so the
reader leads with Gemini, preserving the ADR 0014 cross-family separation that the
current config was reaching for.

Panel diversity after the change spans four families with no paid API: Gemini via
`agy-cli`, Kimi via `pi`, OpenAI via the existing codex judge, Claude via the
existing chair.

### Slice 1 — CLI-only (stops the spend)

**`src/llm/providers/agy-cli.ts`**

- `AGY_DEFAULT_MODEL` → `"Gemini 3.8 Flash (Low)"`.
- Add `--output-format json` to argv. Parse the single-object envelope
  `{conversation_id, status, response, error, duration_seconds, num_turns, usage}`.
- `status !== "SUCCESS"` ⇒ failure. An `error` containing `invalid model selection`
  ⇒ `unavailable` (fall through), because a hard error would take the whole chain
  down on a model retirement. The audit event is what makes it loud.
- Normalise usage:

  ```
  input_tokens        := usage.input_tokens
  output_tokens       := usage.output_tokens + usage.thinking_tokens
  cached_input_tokens := usage.cache_read_tokens
  ```

  Thinking tokens are real output. This mirrors `normalizeCodexUsage`, which already
  folds `reasoning_output_tokens` into output.
- Interim reporting: until slice 2 lands, agy's parsed usage rides the existing
  `onUsage` hook, exactly as `pi` and `gemini-api` already do, so the intermediate
  state is strictly better than today and never worse. Slice 2 deletes every hook.

**`src/llm/providers/openai-compat.ts`**

Fix `extractUsage` even though the metered legs leave the default chain: derive
output as `completion_tokens_details.reasoning_tokens + completion_tokens` when
present, else `total_tokens - prompt_tokens` when that exceeds `completion_tokens`.
Without this, re-enabling a paid leg silently reintroduces D3.

**`src/llm/registry.ts`**

`DEFAULT_LLM_PROVIDERS` → `"pi,agy-cli"`. `METERED_PROVIDERS` and the fuse filter
stay as they are.

**`src/telegram/telegram-daemon.ts`**

`buildPanelSeatBindings` pins judges to `agy-cli` and `pi`.

**`.env`**

```
HOUGE_LLM_PROVIDERS=pi,agy-cli
HOUGE_LLM_READER_PROVIDERS=agy-cli,pi
HOUGE_AGY_MODEL=Gemini 3.8 Flash (Low)
```

The model is pinned in config, not left to the code default, so the next model
retirement is an env edit.

### Slice 2 — audit chokepoint

**New ledger event `llm_attempt`.**

Registered in `src/run/run-ledger.ts` alongside `llm_call`. Required payload fields:
`provider`, `role`, `outcome`. Optional: `model`, `latency_ms`, `input_tokens`,
`output_tokens`, `thinking_tokens`, `cached_input_tokens`, `cost_usd`, `error_kind`.

`outcome ∈ ok | error | unavailable`.

`error_kind` is a bounded classifier (`auth`, `model_missing`, `timeout`, `spawn`,
`transport`, `parse`, `other`) — never raw provider text, which could carry
untrusted bytes. The existing bodies-out-of-the-ledger invariant holds: counts and
metadata only, never prompt or response content.

**`answerWithChain` becomes the chokepoint.**

```
answerWithChain(chain, req, audit)
  for each leg:
    t0 = now
    result = await leg.answer(req)
    audit.record({ provider, model, role, outcome, latency_ms, usage? , error_kind? })
    if result.ok: return result
  return { ok:false, provider:"chain", ... }
```

`audit` is a required third parameter. Every existing call site must supply one, so
the compiler enforces coverage. This replaces the `onUsage` hook, which is deleted
from `LlmAnswerAdapterConfig`, `PiProviderConfig`, `OpenAiCompatConfig` and
`AgyCliProviderConfig`.

**Providers return usage instead of calling a hook.**

`LlmResult`'s success arm gains `usage?: LlmUsage`. `LlmUsage` gains an optional
`thinking_tokens`. The provider's job becomes parsing, not reporting; the chain owns
reporting. This is what makes the guarantee structural.

`thinking_tokens` is reported for visibility only and is ALREADY included in
`output_tokens`. Cost computation must keep reading `output_tokens` alone. Adding the
two together would double-count and is the one arithmetic error this field invites.

**Run-less audit.**

The audit sink carries `{ run_id?, correlation_id, role }`. With a `run_id` it writes
through `appendRunLedgerEvent` as today. Without one it writes through
`appendLedgerEvent` with a correlation id naming the tick
(`tick:episodic_distill`, `tick:idea_radar`, `tick:idea_panel`, …), following the
`recordEvalCompleted` precedent. This is what finally makes daemon tick LLM work
visible.

**CLI seats outside the chain.**

The codex judge, the claude chair, and the self-write writer/reviewer do not route
through `answerWithChain`. Each emits `llm_attempt` at its own spawn site. The chair
already runs `--output-format json` and codex already runs `--json`, so both have
usage available to parse.

### Data flow

```
call site (role, correlation)
  └ createLlmAnswerAdapter
      └ answerWithChain(chain, req, audit)
          └ per leg: spawn/http → parse usage → audit.record → return on first ok

spawn seats (codex judge / claude chair / self-write)
  └ parse JSON envelope → audit.record
```

### Error handling

- Audit emission is best-effort and wrapped: a telemetry failure must never fail a
  good answer. Existing precedent is `recordLlmCallSafe`.
- Unlike today, a failed emission logs a warning rather than passing silently.
- Provider failures are recorded with their outcome, which is the mechanism that
  makes D1-class regressions visible within one tick.

### Observability

`usageByModel` and `meteredSpendUsd` switch to reading `llm_attempt` rows with
`outcome = 'ok'`, unioned with historical `llm_call` rows so the existing three
months of history stays queryable. Pre-cutover Gemini output figures are known to
undercount by roughly 5x and are annotated as such in the reference doc rather than
rewritten.

A `/usage` surface breaking down calls by provider, role and outcome is the natural
follow-on but is out of scope here.

## Testing

Vitest, per repo standard. New and changed coverage:

- agy JSON envelope: SUCCESS parse, ERROR status, `invalid model selection` mapped to
  unavailable, malformed JSON, missing usage block.
- agy usage normalisation folds `thinking_tokens` into output and maps
  `cache_read_tokens` to cached input.
- `openai-compat` usage: reasoning-token field present, absent-but-total-exceeds-sum,
  and neither.
- `answerWithChain` emits exactly one `llm_attempt` per leg attempted, in order, with
  the right outcome for ok / error / unavailable.
- Run-less audit writes a correlation-scoped event; run-scoped audit writes a
  run-scoped one.
- Chain defaults contain no metered provider; an explicit metered env still builds.
- Panel judges resolve to `agy-cli` and `pi`.
- Spawn seats emit `llm_attempt` on both success and failure.

## Rollout

1. Slice 1 behind no flag — it is a repair, and the current state is already broken.
2. Verify live: one `/ask` turn and one web-search turn, confirm `llm_attempt` rows
   show `agy-cli` and `pi` only.
3. Watch the next Google bill cycle to confirm the metered spend stops.
4. Slice 2 lands after slice 1 is verified, so the audit is proving a known-good
   configuration rather than debugging two changes at once.

## Risks

| Risk | Mitigation |
|---|---|
| agy model retired again | Model pinned in `.env`; audit makes the failure visible in one tick instead of never. |
| CLI spawn latency on the reader path | Accepted by decision. Per-attempt `latency_ms` now measured, so a pool can be justified with data later. |
| Both CLI legs down leaves no chain | `METERED_FALLBACK_PROVIDERS` behaviour is unchanged; operator can set `HOUGE_LLM_PROVIDERS` to a paid leg as a one-line escape hatch. |
| `answerWithChain` signature change is wide | That is the point — it converts a silent-omission bug class into a compile error. Diff is mechanical. |
| agy's ~13.9k-token system overhead per call | Harmless on flat rate; noted so it is never assumed cheap if a metered leg returns. |


## Spec review, 2026-09-06 (senior review gate)

Reviewed against the live `agy` binary rather than the design text. Four probe results changed the
implementation; they are recorded here because the spec's parse rules read as safe without them.

| Probe | Result |
|---|---|
| `agy models` | `Gemini 3.8 Flash (Low)` exists — the model choice is valid |
| SUCCESS envelope | matches the spec's field list exactly |
| Retired-model call | `status:"ERROR"` … **and exit code 0** |
| Tool-inducing prompt | `status:"SUCCESS"`, `response:""`, `denied_actions:[{action:"command"}]`; warnings on stderr, JSON clean on stdout |

**B1 — `--output-format json` exits 0 on ERROR, so exit-code logic goes dead.** The pre-existing
provider branched on `result.code === 0` with non-empty stdout, which would have returned the raw
JSON *error* blob as a successful answer, and would have silently disabled the auth-marker gate
(`!exitedClean && markers`). Resolved: the envelope's `status` is authoritative; exit code survives
only as the fallback for stdout that is not parseable JSON.

**B2 — `status:"SUCCESS"` can carry an empty `response`.** Not in the spec, but it is the real shape
when a tool call is auto-denied in headless mode — which is exactly what an injected reader payload
would provoke. Resolved: empty response is a failure regardless of status, and the denied action
names go into the error text so the attempt is visible rather than silent.

**B3 — the reader moves from a tool-less HTTP call to an agentic CLI.** The Dual-LLM reader exists
to process attacker-controlled content; `gemini-api` had no tool surface, `agy` does. Operator
decision (Paco, 2026-09-06): **allow agents to use tools; contain and audit rather than forbid.**
Implemented as `--disable-slash-commands` on every agy call (untrusted text can never expand a slash
command or skill), the existing empty-tmpdir cwd and minimal env allowlist, and
`--dangerously-skip-permissions` still never passed — so tool requests hit agy's own permission
model. Recorded as an amendment on ADR 0014.

**B4 — the rollout verified slice 1 via `llm_attempt`, which slice 2 introduces.** Resolved:
`scripts/live-gate-cli-only.mjs` is the slice-1 gate — it fires one planner-shaped and one
reader-shaped call through the real `.env` chains and fails if any metered leg appears or if
`agy-cli` reports no usage. Read-only, so it runs with the daemon parked.

**W1 — the spec's stated rationale for `invalid model selection` → `unavailable` is wrong.**
`answerWithChain` falls through on *both* `unavailable` and plain `error`; no failure "takes the
whole chain down". The mapping is kept (it names the real cause, and slice 2 turns it into an
`outcome`), but the reason given in §"Slice 1" should not be relied on.

**W2 — flat-rate quota under reader volume is untested.** The reader is the highest-volume consumer
(742 searches) and has never once been served by agy, because the leg was dead the whole time. Each
call carries ~13.4k tokens of agy system overhead. No behaviour is defined for quota exhaustion;
today it degrades to `pi`.

**W3 — reader latency is worse than assumed.** Measured: 8.5s for a reader-shaped agy call vs 3.6s
for the planner's `pi`. A second probe hung past 180s and was killed; our 60s timeout bounds it, but
a hung agy burns the full 60s before falling through. The default chain budget therefore moves
90s → 120s and the derived runner cap 105s → 135s.

**W4 — cross-family separation degrades to none when agy is down**, since planner and reader are the
same two legs reversed. Accepted (ADR 0014 permits same-model-different-call), but it is the exact
condition that hid for three months.

## Slice 1 — shipped 2026-09-06

Changed: `agy-cli.ts` (JSON envelope, status-authoritative parse, usage with thinking folded,
`--disable-slash-commands`, model default `Gemini 3.8 Flash (Low)`), `normalizeAgyUsage` in
`llm-usage.ts`, `openai-compat.ts` `extractUsage` (D3), `registry.ts` default `pi,agy-cli`,
`llm-answer.ts` threads `agyConfig.onUsage`, `PANEL_JUDGE_PROVIDERS` exported and repinned to
`pi`/`agy-cli`, `.env` planner/reader/model. Docs: README, configuration reference, ADR 0014/0019/
0027 amendments.

Live gate (`node scripts/live-gate-cli-only.mjs`, daemon parked):

```
planner chain : pi,agy-cli      → served by pi · kimi-for-coding (3.6s)
reader  chain : agy-cli,pi      → served by agy-cli · Gemini 3.8 Flash (Low) (8.5s)
                                  usage 13432 in / 1 out — the leg reports for the first time
✓ PASS — CLI-only, both legs live, agy reporting usage
```

Still open before slice 2: a real `/ask` turn and a real web-search turn through the daemon, which
needs the daemon un-parked (`houge.kill`), and one Google bill cycle to confirm the spend stops.


## Independent review round, 2026-09-06

Four parallel reviewers (security, correctness, testing, adversarial) over the working-tree diff.
Every finding below was verified first-hand before being acted on. Two were rejected; the rest are
fixed in the shipped diff.

### Fixed

**Missed call site.** `src/cli.ts` (`houge radar-panel`, including its `--dry-run` pre-arm gate)
still pinned `kimi-api`/`gemini-api` — a second panel seat-binding block that the migration did not
touch, while the newly added test asserted "no metered provider in the panel". `PANEL_JUDGE_PROVIDERS`
now lives in `idea-panel.ts` as one source of truth for both sites, and a test scans all of `src/`
for `pinnedJudge("<literal>")` and for metered names outside the LLM layer, since asserting the
constant is what failed to catch this.

**The D3 formula was wrong in both directions.** The design's `reasoning_tokens + completion_tokens`
double-counts: OpenAI's schema puts `reasoning_tokens` INSIDE `completion_tokens` (the
`normalizeCodexUsage` analogy does not carry — Codex reports the two disjointly). Worse, branching on
the field's PRESENCE meant a vendor sending `reasoning_tokens: 0` would skip the total-based
derivation entirely and restore the exact 11x undercount D3 exists to remove. Now
`max(completion_tokens, total_tokens - prompt_tokens)`, gated on both fields being present so a
missing `prompt_tokens` cannot read the whole prompt as output at output pricing. `reasoning_tokens`
is deliberately not read. The original test passed under both formulas because its fixture was
numerically ambiguous; the replacement uses a self-consistent OpenAI-shaped envelope.

**"Empty temp cwd" did not exist.** Code comment, ADR 0014 amendment and this spec all named it as a
containment control; the implementation passed `os.tmpdir()` — 270 entries on this machine,
including Houge's own `houge-approval-park-*`, `houge-approval-resume-*`, `houge-ca-cap-*` and
`houge-worktree-*` state. `agy` roots its agentic workspace at the cwd. Now a fresh `mkdtemp` per
call, removed in a `finally`. The old test had pinned `expect(opts.cwd).toBe(os.tmpdir())` under a
title claiming otherwise, which is why the divergence survived.

**A spawned agent could brick the daemon.** `defaultSpawnImpl` spawned without `detached`, so
`child.kill("SIGKILL")` reached only the leader, and `finish()` was reachable only from `close` —
which Node emits after stdio streams drain. An agentic CLI's surviving tool grandchild holds the
stdout write end, so `close` never fires and the promise never settles; the daemon's poll loop is a
single serialized `while`, so that stops Telegram polling, every tick, the outbox flush, and the
heartbeat, invisibly to `/status`. Dormant while agy was dead; this slice puts agy first on the
reader path and sanctions its tool use. Fixed with `detached: true`, a process-group kill, and a
grace timer that settles regardless. `tests/llm/providers/cli-spawn.test.ts` is new and spawns real
processes — the provider suites all inject a fake `spawnImpl`, which is why this class was
unreachable from the suite. Verified: 2 of its tests fail against the pre-fix code.

**Diagnosability regression I introduced.** The new parse dropped `stderr`, so an auth wall (which
prints to stderr and nothing to stdout) reported only `no JSON envelope (exit 1)` — strictly worse
than the code it replaced, in the change meant to make such failures visible. stderr now carries a
bounded excerpt into the error and is checked against the unavailable markers.

**Unbounded attacker-influenced error text**, flagged independently by three reviewers.
`deniedActionNames` had no entry cap, no length cap and no newline flattening, beside an
`errorExcerpt` that has all three — and on the reader path *which* tools the model attempts is
steered by the hostile page. Now capped at 5 entries, each through `errorExcerpt`, whole message
bounded.

**Silent substitutions made loud.** `answerWithChain` discarded every fall-through reason the moment
a later leg succeeded — the precise mechanism by which D1 hid for three months — and the metered
fuse silently rewrote an operator's explicit chain back to `pi`, which can undo the escape hatch
using the leg that was already failing. Both now log. Interim; slice 2's `llm_attempt` is the
durable answer.

**Documentation was wrong about the escape hatch.** README said "one env line". The reader has its
own chain variable and ignores `HOUGE_LLM_PROVIDERS`, so the documented fix leaves the
highest-volume path dead — and failing *silently*, since an unreadable source looks to the planner
like a page with no content. It is two vars plus a restart (env is read once at boot), it is not
reachable from Telegram, and a latched ceiling may drop the leg just enabled. Corrected in README
and the configuration reference. Stale timeout/default-chain comments in `core-worker.ts` and
`registry.ts` fixed too.

### Rejected, with reasons

**"Fire `onUsage` on failed agy calls."** Real concern — a SUCCESS-with-denied-tools turn burns
~13.4k tokens and reports nothing, so flat-rate quota exhaustion (W2) has no leading indicator. But
`onUsage` feeds `recordLlmCall`, whose `llm_call` rows mean *a call that produced an answer*.
Recording failures there would corrupt three months of comparable history to buy a stopgap. Deferred
to slice 2, where `llm_attempt` carries an explicit `outcome` — this is the deferral being a
decision rather than an oversight.

**`--sandbox` and a dedicated `$HOME` for agy.** The security reviewer notes that `HOME` is in the
CLI env allowlist, so any "always allow" the operator ever clicked in an interactive agy session
becomes an allow-rule for the quarantined reader, and that Houge cannot verify that state. Correct,
and it is a live decision for Paco rather than something to change unilaterally — the standing
instruction is to permit tool use and contain/audit it. Recorded here and in ADR 0014, not actioned.

### Open, not addressed in slice 1

- The reader is invoked outside the CapabilityRunner and `resolveChainBudgetMs` reads only the
  planner chain, so **nothing bounds the reader's wall clock**: `quarantineRead` retries the whole
  chain twice, giving a 240s worst case per external read (up from 180s), and the loop deadline is
  checked between steps, not during one.
- **Fast-fail is gone from the default chain.** A dead HTTP leg refused in milliseconds; two CLI
  legs cannot fail faster than their timeouts, so chain exhaustion has a hard 120s floor. All three
  panel judges are now local CLI spawns sharing a failure domain, where two were HTTP.
- **Correlated local failure** (PATH, `$HOME`, launchd env, offline box) takes both CLIs down
  together far more plausibly than two independent vendor outages, and recovery needs shell access.


## Correction, 2026-09-06 — agy's thinking tokens are NOT additive

The design states, twice, that `thinking_tokens` should be folded into output
(§"Slice 1" and §"Providers return usage instead of calling a hook"), by analogy to
`normalizeCodexUsage`. **That is wrong for agy, and it shipped before being caught.**

Measured live across four probes, two of them with non-zero thinking:

| model | input | output | thinking | total | input+output |
|---|---|---|---|---|---|
| Gemini 3.8 Flash (Low) | 5281 | 1486 | 0 | 6767 | 6767 ✓ |
| Gemini 3.8 Flash (Low), CJK | 5276 | 338 | 0 | 5614 | 5614 ✓ |
| Gemini 3.1 Pro (High) | 5590 | 1511 | 842 | 7101 | 7101 ✓ |
| Gemini 3.8 Flash (High) | 5284 | 1353 | 905 | 6637 | 6637 ✓ |

`total_tokens == input_tokens + output_tokens` holds in every row *including the thinking ones*.
Adding thinking breaks agy's own identity. So `thinking_tokens ⊆ output_tokens` — the OpenAI
`reasoning_tokens` convention, not the Codex one. Codex genuinely reports
`reasoning_output_tokens` disjointly, which is why the analogy misled.

Why it survived review: the default pin is "Low", which reports `thinking_tokens: 0`, so the fold
was arithmetically inert on every probe and every live call. It would have inflated output 40–60%
the moment anyone pinned a reasoning model — which `HOUGE_AGY_MODEL` openly invites, and which the
`.env` comment lists as available. `normalizeAgyUsage` no longer adds it.

This is the same defect class the independent correctness review caught in `openai-compat`
(`reasoning_tokens` is a subset there too). It was fixed there and missed here — the lesson being
that the vendor's own `total` identity is the thing to check, not the field name.

**Consequence for slice 2:** the spec's note that `thinking_tokens` "is reported for visibility only
and is ALREADY included in `output_tokens`" is correct as written, and now matches the code. The
arithmetic error the spec warns against was live in slice 1 for the length of one session.

## agy stdout profile (measured, for the record)

| | agy-cli | pi |
|---|---|---|
| stdout shape | one JSON object | JSONL, one line per token delta |
| stdout / answer | **1.06×** | **58.6×** |
| 812-word answer | 6,908 B stdout / 6,515 B answer | 331,528 B stdout / 5,661 B answer |
| non-ASCII | raw UTF-8, no `\uXXXX` escaping | n/a |
| stderr on success | empty | empty |

agy's 256 KB cap therefore means what it says (~247 KB of answer). pi's does not: its cap is applied
to the streaming envelope, making it a ~4.5 KB / ~600-word ANSWER cap, because every `text_delta`
line carries a full zeroed `usage`+`cost` struct (~180 B) around ~4.6 B of text. That is a separate
pre-existing bug, not part of this migration — see the session notes.

Live token profile (15 agy calls): agy carries an ~8.1 K-token system preamble, cache-read on ~53%
of calls. A cache hit costs ~7–8 K input; a miss costs 16–20 K. Reader average ≈ 12.2 K input/call,
which is the number to size W2 (flat-rate quota) against, not the 13.4 K single-probe figure quoted
earlier in this document.
