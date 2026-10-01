# ADR 0028: omp runtime — agentic mode under code-owned floors

- **Status:** accepted
- **Date:** 2026-09-30
- **Deciders:** Paco
- **Supersedes:** the agentic clause of [ADR 0002](0002-pi-as-agent-runtime.md) (the agentic mode is
  built here, on omp instead of pi)
- **Amends:** [0002](0002-pi-as-agent-runtime.md), [0010](0010-natural-language-intent-layer.md),
  [0013](0013-llm-inner-composition.md), [0014](0014-dual-llm-privilege-separation.md),
  [0015](0015-secrets-firewall.md), [0019](0019-metered-ceiling.md),
  [0022](0022-money-fork-reopened.md), [0023](0023-external-workspace.md),
  [0027](0027-idea-panel-claude-chair.md)
- **Spec:** [2026-09-30-omp-runtime-design.md](../superpowers/specs/2026-09-30-omp-runtime-design.md)
  (Rev 15; 13 Codex design passes + a whole-document self-review; Paco's D10–D12)

## Context

Four months produced a safety harness with one real tool: `web_search` was 78% of all tool steps in
the ledger, and human messages fell from 193 (July) to 14 (August). On 2026-09-09 Paco observed that
the tool limits in the backend were holding Houge back. Houge picked pi as its agent and then ran it with `--no-tools`
(ADR 0002 "inference mode"), rebuilding a weaker loop on top of it (ADR 0013's inner loop).

ADR 0002 always named an agentic mode, gated on "V2 containment". This ADR is that mode. The agent
runs with real tools, inside containment Houge owns, on the strongest subscription model per seat.
The runtime is **omp** (`@oh-my-pi/pi-coding-agent`, an oh-my-pi fork), pinned at 18.4.4 and run
under its own profile `houge`. This is sub-project 1 of 4. SP2 is Paco's personal tools, SP3 is the
auth broker plus OS-user isolation plus the quota invariant, and SP4 is self-evolution v2.

## Decision

We will run every Telegram turn on an omp agent loop: one supervised omp RPC process per chat (the
**planner**), plus one-shot omp spawns for every other seat. The old inner loop, the intent
classifier call, and the pi / kimi-api / gemini-api / claude-cli providers are deleted in the same
slice. Code keeps owning the gates. omp composes between them.

### Locked decisions (spec §1)

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | Runtime binary | **omp 18.4.4** under profile `houge` | pi upstream; Hermes; Muse |
| D2 | Cutover | **hard**: old loop + pi/agy providers deleted in the same slice | flag-gated parallel path |
| D3 | Dual-LLM wall | **kept for the read tools** (`web_search`, `http_fetch`, `gmail_read`, `google_api`), enforced in the bridge; **shell output is exempt** by D12 | drop; per-source trust |
| D4 | Conversation memory | **omp session owns the transcript**; Houge owns knowledge | stateless recomposition |
| D5 | Planner autonomy | **yolo under `$HOME`**: file read/write/edit and shell commands run without a prompt, **except external writes and destructive deletes** (matcher, spec §5.5) | workspace jail; approve-every-bash |
| D6 | Floors | (A) secret/protected paths denied at the OS level + policy hook; (B) external effects wait for `/approve`. For `bash` this is a **best-effort, code-owned command matcher** (D12); for bridge tools it is the registry's `external_write` level | — |
| D7 | Models | subscription OAuth only; Opus 5.5 via Anthropic Max OAuth **inside omp** (terms risk accepted; fallback is one env line) | `claude -p`; metered API |
| D8 | Tool set | port 12 as bridge tools; delete `llm_answer` + money track (5 tools) | port all 18 |
| D9 | Gmail | port with an `account` key designed in | rewrite later |
| D10 | Family collapse (planner and reader on one model family after fallback) | **accept the degradation, audited** (Paco, 2026-09-30): the read proceeds; every such read writes a `wall_collapse` ledger event and opens/keeps an incident so the frequency is visible; a fourth reader string on the GPT family (Codex Plus) makes collapse rare in practice | fail closed |
| D11 | Floor A residual | **accepted** (Paco, 2026-09-30): the omp planner process must read its own OAuth store (`~/.omp/profiles/houge`), so the OS sandbox cannot deny it to that process; the policy hook denies omp's `read` of it, and with D12 no shell runs inside that process. Revisited in SP3 (separate macOS user) | block yolo until SP3 |
| D12 | Shell = bridge tool, **Claude Code posture** (Paco, 2026-09-30) | omp's built-in `bash` is replaced by a Houge bridge tool **registered under the same name** (*probed*: an extension tool named `bash` supersedes the built-in). Commands run daemon-side under `sandbox-exec` with the floor-A file denies and the signal/launchctl denies, **network allowed**, output returned **raw** (capped). Consequence accepted by Paco: a steered planner can fetch hostile bytes through `bash` around the reader wall; ADR 0014 is amended to exempt shell output. Floor B for `bash` = the regex matcher (`git push`, `gh … create`, `curl\|wget\|http` with `-X POST\|PUT\|PATCH\|DELETE\|--data`, `mail\|sendmail`, `ssh\|scp\|rsync`, `npm publish`, `sudo`, `launchctl`, `crontab`, destructive deletes) → `/approve`; misses run — accepted residual | the recommended Codex posture (network off by default, `network:true` = one tap, output quarantined) — rejected by Paco as too restrictive |

### Shape

- **Planner**: `sandbox-exec -f <data>/omp/planner.sb omp --profile houge --mode rpc`, with built-ins
  `read,edit,write` only, `--approval-mode yolo`, and exactly **one** extension
  (`<dist>/omp/extension/houge.js`). The extension registers one stub per bridge tool and installs the
  policy hook. Every Houge tool, `bash` included, runs daemon-side through `CapabilityRunner`, over a
  per-child Unix socket whose authority (run, lease, contract, budget) is server-owned.
- **One-shot seats** (reader, media photo, ticks, judges, chair, reviewer):
  `omp --profile houge -p --mode json --no-session --no-tools --no-extensions --no-skills --no-rules`.
- **Writer**: `codex exec --sandbox workspace-write`, unchanged.
- **Model strings** are `provider/model[:effort]`, one env var per seat (`HOUGE_OMP_*`, see
  [configuration.md](../reference/configuration.md#llm-runtime--omp-adr-0028)). The version pin
  (`HOUGE_OMP_VERSION`) is checked at every spawn. A mismatch refuses unless the version is listed in
  `HOUGE_OMP_VERSION_ALLOW`.

### Threat model and boundaries (spec §3, verbatim)

**Actors.** Paco (sole authorised user). The planner model (may be steered by a digest that survived the reader
wall, or by its own error). An extension (runs in-process with the model's OS rights; so `houge-policy.ts` is
protected code, never self-written). A same-user local process on the mini: **out of the threat model** (it can
already read `.env` today).

**Assets, ordered.** (1) Secrets: `.env`, `houge.sqlite`, `~/.ssh`, `~/.gnupg`, `~/.pi`, `~/.claude`, `~/.codex`,
`~/.kimi*`, `~/.config/gcloud`, Keychains, `~/.omp/profiles/houge` (OAuth store); the full list as built is
`HOME_SECRETS` (below). (2) Houge's own operation: repo protected paths + `dist/`, daemon process, launchd, DB,
sockets, profiles, the daemon's temp space and self-write worktrees, and the binaries and config the daemon or Paco's
shell later run unsandboxed. (3) Paco's files under `$HOME`. (4) External side effects in Paco's name.

| Layer | Mechanism | Protects | Bypassable by a steered planner? |
|---|---|---|---|
| L0 | No secrets in any child env (§4) | provider keys, Telegram token | no |
| L1a | `sandbox-exec` profile `planner.sb` around the omp planner process: `(allow default)`, `deny file-read* file-write*` on asset 1, `deny file-write*` on asset 2, signal/launchctl denies (§5.6); network allowed (the model API needs it). *Probed.* | assets 1–2 against omp's `read/edit/write` | no, except D11 |
| L1b | profile `shell.sb` around every shell command the daemon runs: L1a's denies (files, signals, launchctl); network allowed (D12). (*Probed*: a network-denied variant works too and stays available as a one-line change if D12 is ever revisited.) | assets 1–2 (files **and** the daemon process) | no for files/process; **yes for egress and for raw web bytes** (D12) |
| L2 | `houge-policy.ts` `tool_call` hook (*probed*: fires for built-ins and bridge tools with `toolName`, `toolCallId`, `input`; `{block, reason}` stops the call and the model reads the reason) | tool allowlist by name; URL/`xd://`-shaped `read`; floor-A paths with a clean reason | no (code); path denies are defence in depth over L1a |
| L3 | The bridge: every Houge tool runs daemon-side through `CapabilityRunner` (§5.2) | contract, budget, wall, ledger for every tool incl. `bash` | no by the model (no adapter lives in the child) |
| L4 | `/approve` on `bash` commands the code-owned matcher classifies as external writes **or destructive deletes**, and on any `external_write` bridge tool | assets 3–4 | **yes**, by a command the matcher misses (D12 residual); overwriting a file through `edit`/`write` stays yolo by D5 |

**Stated for ADR 0028.** Hard line (b) "no secret leak": enforced by L0 + L1a/L1b for every secret except the
planner's own OAuth store (D11) — secrets are unreadable; egress of *non-secret* data by a steered planner is
possible without a tap (D12). Hard line (a) "no adverse impact
to own operation": enforced by L1 write-denies on asset 2, signal and launchctl denies, resource limits on every
shell command (§5.6), and the self-write pipeline for repo changes. **Accepted residuals:** cumulative disk fill
across many commands (detected by a new `disk_free_low` sweep invariant on the 12 h cadence, not limited); CPU
contention inside the `nice` band; a command that calls `setsid` outlives its call (CPU-bounded, not wall-clock
bounded); local overwrites and unmatched destructive commands (D5). Upgrade path (SP3): a dedicated macOS user for the planner.

### Decisions made during the build

These came out of the per-task reviews (`.superpowers/sdd/2026-09-30-omp-runtime/progress.md`) and
change the architecture the spec describes:

1. **One extension entry.** The planner loads exactly one `-e <dist>/omp/extension/houge.js`. It
   installs the policy hooks first, then registers the tool stubs. omp imports each `-e` module
   with a `?mtime=` query. With two entries, the tools module and the policy module each got their
   own copy of the shared `registered` set, so the set the policy saw was empty and every Houge tool
   was blocked. That failure cannot be reproduced under vitest, so live-gate case 18 guards it.
   `houge.ts` is protected.
2. **Manifest start check.** omp treats an extension load failure as a warning and runs on without
   Houge's tools or policy. A planner therefore counts as started only after the bridge has served it
   a `manifest` request within 15 s. Otherwise the child is stopped and incident
   `planner_start_failed` opens. `houge.ts` catches a tool-registration failure and keeps the policy
   hooks installed: when the bridge is down, `read`/`write` stay blocked.
3. **The whole Houge repo is write-denied** to the planner and to `bash`. The exceptions are
   `<data>/omp/workspace`, plus `<data>/omp/sessions` for the planner process. Repo changes go only
   through the self-write pipeline (worktree → test gate → reviewer → Paco's merge tap).
4. **Per-turn context is composed by the daemon.** The daemon prepends a `[context]…[/context]` block
   to the prompt it sends over RPC and writes `loop_started.applied_artifacts` at that moment. There
   is no `before_agent_start` hook, so rating attribution is unchanged.
5. **Skills stay composer-injected in SP1.** omp's `--skills <globs>` has not been verified against
   Houge's `skills/` store, so native omp skills move to SP4.
6. **Stale sessions are detected by fingerprint.** At every turn start the supervisor recomputes the
   system-prompt fingerprint. A change (a lesson, identity or skills edit, or the UTC date line)
   restarts the child at that idle boundary, and `open_session` resumes the transcript.
7. **`ulimit -u` is relative.** macOS counts `-u` per user (about 435 processes are in use on the
   mini), so the wrapper sets it to the current user process count + 256, capped by the hard limit.
   This supersedes spec R2's fixed 512. The group kill, `-t`, and the adapter deadline still bound
   the command.
8. **Matcher posture.** Patterns are anchored to command position, which removes false positives
   like `ls ~/.ssh` and `grep mail`. The line-wise safety pass never skips heredoc bodies. A parse
   error or eval-depth overflow classifies the command as destructive (ask), never as plain. The
   final review widened it: the matcher recurses into `bash|sh|zsh -<flags>c`, here-strings,
   `env -S` and `find -exec`; a shell fed its script through a pipe, a `<` redirect, a process
   substitution or an expanded here-string asks as an "unseen shell script"; git aliases,
   `git branch -D`, `git stash drop|clear`, `curl --json|--request|--form|--upload-file`, `gh api`
   writes and `gh pr|issue|release|repo create|edit|merge|delete` ask; a backslash-newline inside a
   word is deleted as bash does; an unterminated heredoc asks.
9. **Approval card vs ledger.** The Telegram card shows the matcher label and the command, up to
   3000 chars with an explicit `…[truncated N chars]` marker beyond that, passed through egress
   redaction, because Paco cannot approve what he cannot see. The label lists **every** matched
   class, strictest first, so a decoy cannot hide a push behind a delete. The ledger's
   `approval_requested.action_summary` carries the labels only. Command text lives in the
   notification outbox, never in the audit ledger.
10. **One approval in flight.** The bridge serialises every `call` request per turn, whether or not
    omp honours a per-tool sequential attribute.
11. **Clarify cap.** When `countTrailingClarifyTurns` reaches `HOUGE_MAX_CONSECUTIVE_CLARIFY`, the turn
    prompt gains a code-owned line telling the planner not to ask another clarifying question.
12. **Seat routing.** `lesson_write` distill and reconcile run on `HOUGE_OMP_TICKS` (memory work).
    `/ask`, `/research` and `skill_author` authoring run on the planner chain, because they answer
    Paco directly.
13. **Steered runs.** A message that arrives mid-turn is claimed under the parent's worker id and
    `steer`ed into the turn. Paco gets **one** reply, the parent's. If the parent fails, the steered
    runs fail with it as `merged_parent_failed`. Media and schedule-born runs never steer; each queues
    as its own turn.
14. **Version drift is loud.** A one-shot on a mismatched binary returns `unavailable` without an
    audit row, because no leg ran. The caller opens `omp_version_mismatch`, and the next passing check
    resolves it.
    **An unknown model fails at spawn.** omp 18.4.4 rejects an unknown `--model` at process start,
    before `ready`, so live `set_model` cannot rescue a bad top planner string. The supervisor instead
    falls back at spawn: one `error{model_missing}` row per rejected string, then a spawn on the next
    string (commit `96448cd`).
15. **The wall is unconditional.** The four read tools always cross `normalizeExternalRead`, so
    `HOUGE_DUAL_LLM_ENABLED` is gone and `gmail_read`/`google_api` arm on `HOUGE_GOOGLE_ENABLED` alone.
16. **Voice stays on agy-cli.** The live probe on 2026-09-30 showed that omp inlines Ogg bytes into
    the prompt as text and the model invents a transcript. `spawnOneShot` refuses audio files at the
    chokepoint (`OMP_AUDIO_REFUSED`). Voice notes are transcribed on the flat-rate `agy-cli` leg,
    which ADR 0019 permits, and `agy-cli.ts` survives the D2 deletions for that one purpose. Photos
    run on the omp media seat.
17. **Budgets.** The per-run `tool_calls` cap goes from 14 to 40 and counts bridge calls plus
    `fs_write`. `fs_read` is gated but not budgeted. The global 24 h breaker's `tool_calls` ceiling is
    re-tuned in `.env` to 3× its old value
    ([configuration.md](../reference/configuration.md#global-autonomy-circuit-breaker)). The operator
    sets it before the cutover kickstart; the code default is unchanged.
18. **Floor A as built (final review fix wave, 2026-10-01; spec §3 "Floor A as built").**
    - **Writes are denied by default.** D5 is read literally: writes are allowed under `$HOME`,
      `/private/tmp` and the omp workspace only, and then denied again for the repo, `dist/`, the
      `$HOME` binary install trees, the directories of the omp, codex, agy and node binaries, and the
      dotfiles that make git, a shell, a terminal or an editor run code. `os.tmpdir()`
      (`/private/var/folders`) is not writable.
    - **Credential stores are read- and write-denied** (`HOME_SECRETS`: AI-tool, bot, cloud,
      container and key/token stores, `~/Library/Keychains`, top-level `~/.<name>.env`), and
      `/usr/bin/security` cannot exec. The planner keeps `~/.omp` (D11).
    - **The gate canonicalises every path the way omp 18.4.4 resolves it** (`@`, `:`, `~` forms,
      `file://`, selectors, edit rename/hashline/apply_patch targets), denies if any resolution is
      denied, and refuses `bad_path` on a form it does not model.
    - **The workspace is pinned.** Its root, the sessions root and every `chat-<id>` dir cannot be
      moved or replaced by a symlink, and the attachment adapter lstat-checks the chain and the
      realpath before it reads a file.
    - **Daemon temp space moved to `~/Library/Caches/houge-daemon` (`HOUGE_DAEMON_TMP_DIR`), outside
      the repo, worktrees to `<data>/selfwrite`.** The temp root is read- and write-denied to every
      child, the worktrees write-denied. A temp root inside a git repo pages at boot and disables
      voice ingest; agy never runs with a cwd in a git repo. A self-write diff is re-hashed before publish.
    - **Children get a private `TMPDIR`**: `<workspace>/.tmp` for the planner and `bash`, and
      the daemon temp root for one-shots, codex and agy.
    - **Daemon-side git runs without user or system config**, hooks or fsmonitor (push keeps the
      credential helper).
    - **`sandbox-exec` and every wrapper helper run by absolute path.**

## Consequences

- **Easier:** Houge can read, edit, and run things on the mini in one turn, with a transcript that
  survives restarts. `src/` loses the inner loop, the classifier call, five providers, and the money
  track. A new capability is one JSON declaration plus one daemon-side adapter (spec §13).
- **The AGENTS.md invariant "Claude is never in the runtime … (pi, agy, codex)" is changed by this
  ADR.** Opus 5.5 is the default planner under D7, the panel chair is an omp seat on
  `HOUGE_OMP_CHAIR`, and every seat is subscription OAuth. AGENTS.md is protected, so Paco updates
  that line by hand.
- **Deletions:** `src/core/inner-loop.ts`, `src/core/tool-manifest.ts`, the classifier call, the
  pi / kimi-api / gemini-api / openai-compat / cli-spawn providers, `llm-answer.ts`, and the money-track
  code (commit `3aabc04`). The tables stay, and the historical ledger rows stay readable.
- **Operator surface:** four subscription logins under `omp --profile houge login <provider>`
  (Anthropic Max, Google Antigravity, Kimi Code, OpenAI Codex). The Kimi env pair
  (`KIMI_CODE_OAUTH_HOST`, `KIMI_CODE_BASE_URL`) passes through `HOUGE_OMP_ENV_PASSTHROUGH`. Moving the
  version pin means smoking the new binary first, with the pin overridden for that run only
  (`HOUGE_OMP_VERSION=<new> HOUGE_ENV_FILE=… node scripts/live-gate-omp.mjs --smoke`), and then
  setting the pin in `.env` (`HOUGE_OMP_VERSION`, or `HOUGE_OMP_VERSION_ALLOW`).
- **Verification:** `scripts/live-gate-omp.mjs` (cases 1–24 plus silent-degradation checks;
  `--smoke` = cases 1, 3, 6, 13, 22 against a temp DB copy) and `scripts/eval-replay.mjs` (the answer-only
  replay eval, spec §13 seam 3). Case 3 is an explicit operator self-test that must show a `bash` row; a
  planner that refuses it twice (`model_refusal`) makes the gate INCONCLUSIVE (exit 4), never PASS.

### Residuals (spec §14 plus the build)

- Yolo + in-process extensions + D11: a steered planner holds the daemon user's rights outside L1 and
  can read its own OAuth store through a hook bug. Mitigations: the wall, L1, and the SP3 OS user.
- Local irreversibility (D5): destructive deletes are matched and ask. An overwrite through
  `edit`/`write`, or a delete the matcher misses, is not gated.
- **D12 residuals:** raw web bytes reach the planner through `bash`, and **egress stays open**
  (network is allowed in both profiles), so any command the matcher misses can send non-secret data
  out without a tap. Both were recommended against and accepted by Paco on 2026-09-30.
- **Matcher misses (D12, best effort).** Known at ship: `dd`, `unlink`, `python3 -c` / `node -e` /
  `perl -e` deletes or uploads, ANSI-C `$'…'` quoting, spaced arithmetic `$(( a << 1 ))` next to a
  multi-line quoted message, an apostrophe inside nested double quotes in a `$()`, and `bash file.sh`
  (the script body is not read). Floor A and the sandbox hold regardless.
- **D11 symlink race on `~/.omp`.** The gate canonicalises the path string but does not open the
  file, so a symlink swapped between the check and omp's read is not seen. The exposure is what the
  planner process can already read: its own OAuth store. SP3 closes it.
- **The dotfile denylist is incomplete by nature.** Tool configs under `$HOME` that run code and are
  not listed (for example under `~/Library/Application Support`) stay writable; they fire only in
  Paco's interactive tools. The structural fix is an allowlist of writable `$HOME` subtrees, or SP3.
- **Signal deny is per process group** (probed 2026-10-01): `(deny signal (target others))` covers
  processes outside the sender's group. `bash` commands run in their own group and cannot signal the
  daemon; the planner child shares the daemon's group, so only omp's own code could, and omp gives
  the model no signal tool.
- **Binary dirs are resolved once per supervisor**: a relocated reinstall is covered after a restart.
- **No step or repeated-denial cap.** The old inner loop's step and denial caps have no omp
  equivalent. Tool calls are bounded by the contract budget; model requests and repeated denials
  only by the turn deadline and the frame watchdog.
- Anthropic may block Max OAuth in third-party clients. The planner then falls to Opus 4.6
  automatically, and an incident tells Paco.
- Antigravity's weekly ceiling covers a shared Claude/GPT bucket; reader volume rides Gemini's bucket.
- omp moves fast: the version is pinned, update checks are off, and frames are re-captured on
  upgrade. The sequential-tool attribute name and the omp config key semantics are verified at build.
- **A bridge call dropped mid-flight is invisible.** The silent-degradation check proves that every
  gated built-in and every approval has a `tool_finished`. A bridge `call` that dies between request
  and finish (child exit, daemon crash) leaves no row to miss. Follow-up: `handleCall` writes a
  `tool_started` row, so a `tool_started` without a `tool_finished` is detectable.
- k3's default thinking is verbose (525 tokens for "OK"), so every k3 string carries `:low` except
  the reviewer's.
- A `steer` merge means one reply answers two messages. The ledger records both runs; Paco sees one
  message.
- **Voice on agy-cli** (decision 16) keeps one legacy provider and its env resolvers (`HOUGE_AGY_BIN`,
  `HOUGE_AGY_MODEL`, `HOUGE_AGY_ENV_PASSTHROUGH`, `HOUGE_LLM_MEDIA_PROVIDERS`,
  `HOUGE_LLM_TIMEOUT_MS_MEDIA`). Follow-up: omp audio support, or local whisper (installed, but only a
  test model is present).
- The spec's S12 and D12 probes (live-gate case 8) are not scripts in this repo. The operator runs
  them by hand and records the result.

## Alternatives considered

- **pi upstream with tools on:** it lacks the extension-tool supersession and RPC session resume that
  omp 18.4.4 was probed to have.
- **Hermes or Muse:** both would replace Houge's harness instead of running inside it.
- **Flag-gated parallel path (old loop kept):** this doubles every contract and test for a loop being
  retired, and the old path would rot unexercised.
- **Workspace jail or approve-every-bash:** both repeat the tool starvation this ADR exists to end.
- **The Codex shell posture** (network off by default, one tap for `network:true`, output
  quarantined): recommended by the review, and rejected by Paco as too restrictive (D12).
- **`claude -p` or a metered API for Opus:** rejected in favour of subscription OAuth inside omp, with
  the terms risk accepted and a one-line env fallback (D7).
