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
The runtime is **omp** (`@oh-my-pi/pi-coding-agent`, an oh-my-pi fork), unpinned (any version `omp --version` reports
runs; amendment 2026-10-07) and run under its own profile `houge`. This is sub-project 1 of 4. SP2 is Paco's personal tools, SP3 is the
auth broker plus OS-user isolation plus the quota invariant, and SP4 is self-evolution v2.

## Decision

We will run every Telegram turn on an omp agent loop: one supervised omp RPC process per chat (the
**planner**), plus one-shot omp spawns for every other seat. The old inner loop, the intent
classifier call, and the pi / kimi-api / gemini-api / claude-cli providers are deleted in the same
slice. Code keeps owning the gates. omp composes between them.

### Locked decisions (spec §1)

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | Runtime binary | **omp** under profile `houge`, no version pin (amended 2026-10-07) | pi upstream; Hermes; Muse |
| D2 | Cutover | **hard**: old loop + pi/agy providers deleted in the same slice | flag-gated parallel path |
| D3 | Dual-LLM wall | **kept for the read tools** (`web_search`, `http_fetch`, `gmail_read`, `google_api`), enforced in the bridge; **shell output is exempt** by D12 | drop; per-source trust |
| D4 | Conversation memory | **omp session owns the transcript**; Houge owns knowledge | stateless recomposition |
| D5 | Planner autonomy | **yolo under `$HOME`**: file read/write/edit and shell commands run without a prompt, **except external writes and destructive deletes** (matcher, spec §5.5) | workspace jail; approve-every-bash |
| D6 | Floors | (A) secret/protected paths denied at the OS level + policy hook; (B) external effects wait for `/approve`. For `bash` this is a **best-effort, code-owned command matcher** (D12); for bridge tools it is the registry's `external_write` level | — |
| D7 | Models | subscription OAuth only; Claude via Anthropic Max OAuth **inside omp**, the model named by the code-owned role lists resolved against omp's catalog (amended 2026-10-07) (terms risk accepted; fallback is one env line) | `claude -p`; metered API |
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
  (`HOUGE_OMP_VERSION`) was checked at every spawn until 2026-10-07; see the amendment under Decisions made during the
  build.

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
12. **Seat routing.** `lesson_write` distill and reconcile run on the Tiny role (memory work; `HOUGE_OMP_TICKS` until 2026-10-07).
    `/ask`, `/research` and `skill_author` authoring run on the planner chain, because they answer
    Paco directly.
13. **Steered runs.** A message that arrives mid-turn is claimed under the parent's worker id and
    `steer`ed into the turn. Paco gets **one** reply, the parent's. If the parent fails, the steered
    runs fail with it as `merged_parent_failed`. Media and schedule-born runs never steer; each queues
    as its own turn.
14. **Version drift is loud.** A one-shot on a mismatched binary returns `unavailable` without an
    audit row, because no leg ran. The caller opens `omp_version_mismatch`, and the next passing check
    resolves it.
    **An unknown model fails at spawn.** omp rejects an unknown `--model` at process start,
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
    - **The gate canonicalises every path the way omp resolves it** (`@`, `:`, `~` forms,
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
- **Amendment 2026-10-07 — no runtime version pins (Paco).** "Another hard-code version config issue that we should
  avoid just like llm model version." The exact omp pin (`HOUGE_OMP_VERSION`, `HOUGE_OMP_VERSION_ALLOW`) is removed:
  a routine upgrade to 18.7.0 would have refused every spawn. Any version `omp --version` reports runs; only an omp
  that cannot run or prints no `x.y.z` version refuses (`omp_unavailable`). A legacy open `omp_version_mismatch` row
  resolves at the first passing check. The voice leg's model is resolved from `agy models` (highest Gemini Flash at low
  effort, cached, re-resolved once on a retired-model refusal) instead of a pinned `HOUGE_AGY_MODEL` default. What the
  pin guarded (frames and refusal texts Houge parses) is checked by `live-gate-omp.mjs --smoke` after an upgrade; a
  once-per-new-version contract probe that does this automatically is a follow-up slice.

## Consequences

- **Easier:** Houge can read, edit, and run things on the mini in one turn, with a transcript that
  survives restarts. `src/` loses the inner loop, the classifier call, five providers, and the money
  track. A new capability is one JSON declaration plus one daemon-side adapter (spec §13).
- **The AGENTS.md invariant "Claude is never in the runtime … (pi, agy, codex)" is changed by this
  ADR.** Claude is the default planner under D7, the panel chair is an omp seat on
  the Chair role, and every seat is subscription OAuth. AGENTS.md is protected, so Paco updates
  that line by hand.
- **Deletions:** `src/core/inner-loop.ts`, `src/core/tool-manifest.ts`, the classifier call, the
  pi / kimi-api / gemini-api / openai-compat / cli-spawn providers, `llm-answer.ts`, and the money-track
  code (commit `3aabc04`). The tables stay, and the historical ledger rows stay readable.
- **Operator surface:** four subscription logins under `omp --profile houge login <provider>`
  (Anthropic Max, Google Antigravity, Kimi Code, OpenAI Codex). The Kimi env pair
  (`KIMI_CODE_OAUTH_HOST`, `KIMI_CODE_BASE_URL`) passes through `HOUGE_OMP_ENV_PASSTHROUGH`. After an omp
  upgrade, smoke the new binary (`HOUGE_ENV_FILE=… node scripts/live-gate-omp.mjs --smoke`); there is no version pin
  to move (amendment 2026-10-07).
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
- Anthropic may block Max OAuth in third-party clients. The planner then walks to the next
  candidate in its role list automatically, and an incident tells Paco.
- Antigravity's weekly ceiling covers a shared Claude/GPT bucket; reader volume rides Gemini's bucket.
- omp moves fast: there is no version pin (amendment 2026-10-07), update checks are off, and the frames and refusal
  texts Houge parses are re-checked by `live-gate-omp.mjs --smoke` after an upgrade. The sequential-tool attribute name and the omp config key semantics are verified at build.
- **A bridge call dropped mid-flight is invisible.** The silent-degradation check proves that every
  gated built-in and every approval has a `tool_finished`. A bridge `call` that dies between request
  and finish (child exit, daemon crash) leaves no row to miss. Follow-up: `handleCall` writes a
  `tool_started` row, so a `tool_started` without a `tool_finished` is detectable.
- Kimi's default thinking is verbose (525 tokens for "OK"), so its role-list entries carry a low effort except on
  the Thinking and Reviewer roles.
- A `steer` merge means one reply answers two messages. The ledger records both runs; Paco sees one
  message.
- **A resumed omp session overrides `--model`** (live gate, 2026-10-01): `open_session` restores the model the
  session last used, so a spawn-time fallback or a `HOUGE_OMP_PLANNER` change never reached an existing chat.
  Mitigation: the supervisor pins the spawn leg with `set_model` before the first prompt, and audits and
  computes the D10 family from the model each `message_end` reports. A failed pin answers on the restored
  model and raises `planner_model_reset_failed`.
- **`houge_status` and the boot record** (2026-10-02): an always-armed, side-effect-`none`, unquarantined bridge tool renders the daemon's boot record (`daemon_boots`) and health, and each chat's first prompt after a boot gets a `[runtime]` restart note (prompt only, never the stored turn); a boot after the host itself rebooted is `restart`, whether or not the previous daemon stopped cleanly (power loss is not a daemon crash). The note is claimed at dispatch, just before the prompt reaches the child: a turn that ends before dispatch leaves it for the next turn, and a schedule fire neither shows nor claims it. Residual: `kickstart` means any clean stop with the host up (also `launchctl unload`/`load` or a manual `kill`), and a stop that ends in SIGKILL with the host up reads as `crash_recovery`.
- **Self-service memory correction** (2026-10-02): the `memory_correct` bridge tool searches ACTIVE facts or wiki pages (keyword and substring hits, plus embedding rows with cosine ≥ 0.55 and within 0.10 of the best) ungated. Retire, and correct (facts only), are a separate `memory_correct_write` capability in the gated `destructive` class: every write waits for Paco's Approve tap on a card that shows each id's current text and the full new text, because the omp session outlives a turn and no taint rule can prove its context clean. Before any card, code refuses a write that is not on Paco's own Telegram turn, follows any step other than memory_correct, houge_status or to_local_time in the same run, names an id this turn's search did not offer, or passes 5 ids per call or 10 rows per turn. A correction is one normal (never core) fact of at most 200 characters. Each change is a `memory_changes` row with an Undo button; Undo restores only what is still as the change left it, says exactly that, and refuses a correct that consolidation has moved on. The ledger (`memory_corrected`) holds ids and counts, never text. Paco's `/memories` and `/forget_memory <id>` (alias `/forget-memory`) are the control-plane twins. Residuals: wiki pages are global, so any allowlisted chat may retire one (accepted: one operator chat, L4); a change's rows are written before its Undo card is queued, so a card that fails to queue leaves the change in place, reversible by hand or a later /forget_memory (accepted, L5).
- **Schedule-born turns are not Paco speaking** (2026-10-02): a scheduled run's goal is stored as a `user` chat turn, so every consumer that treats user turns as Paco's words checks the run's source (`runs.source = 'schedule'`), never the text. `lesson_write` inside a scheduled run is refused in code before any LLM call; its code-owned thread scan skips schedule-born user turns; and the episodic distill drops both turns of a scheduled run (goal and digest reply) while its watermark still moves past them. Storage, the planner prompt and the chat history the planner sees are unchanged. Episodic consolidate (reads stored facts) and the wiki (reads the turn's recorded external reads) never read chat turns, so they needed no change.
- **Talk about Houge itself is not a fact about Paco** (2026-10-02): distill had stored Houge's build history ("Paco approved the assistant's lesson_write fix plan", bug narratives, fix progress) as active facts. The distill pass now also drops both turns of a run whose loop used `self_write_propose`, `self_diagnose` or `memory_correct_write` (read from the run's `loop_step` capabilities, never the text; a `memory_correct` search alone writes nothing and is kept), plus any turn recorded while such a run was active (its first chat turn to the later of its last chat turn and last `loop_step`; never `runs.updated_at`, which lease recovery stamps minutes after a crash): a steered message has its own run while the parent makes the calls, and no row links the two. The window stops at the first turn of an unsettled run, since `loop_step` lands only when a call finishes and an approval can outlast the session lull. The extract prompt refuses facts about the assistant's code, fixes, reviews, memory edits, task progress, or Paco's instructions about how its code, checks, memory or lessons should work, for dev talk no tool call marks (e.g. "刚才的修复被审查拒了…"). Residual: that prompt guard varies run to run (one memory-criticism remark in two gate runs). Facts are about Paco's world; Houge's own history stays in git, the ledger and `sessions.md`. Live gate `scripts/live-gate-distill-dev-chatter.mjs` (temp DB copy, real ticks seat). Live-gate probes ("my code word is …") still look like real requests and are cleaned up with `memory_correct` after a gate.
- **Background ticks stop on shutdown** (2026-10-02): live, a kickstart landed mid episodic distill (7–13 s per call), the poll loop awaited the whole tick, and launchd's 40 s `ExitTimeOut` SIGKILLed the daemon. Every model-backed tick the signal path runs (episodic distill and consolidate, lesson consolidate, radar, panel, skill re-verify, scheduled fires) takes the daemon's stop signal and returns early between model calls; the one-shot seat kills an in-flight leg's process group and audits that leg as `llm_attempt` error{`shutdown`}, as the planner does for a turn its shutdown cuts; the `llm_leg_failing` sweep ignores only `shutdown` rows, so a shutdown never opens an incident while `aborted` (a hung `frame_idle`/`turn_timeout` turn, a /kill, a provider's own "aborted" error) still counts. Nothing is half-committed: a distill window makes every model call first and then writes its facts, watermark and ledger summary in one SQLite transaction (never held across an await). Because nothing is written until then, each reconcile sees an overlay: the store's neighbors minus rows an earlier fact of the window already claims, plus those earlier facts under negative ids; a verdict on a pending fact folds into it and keeps its store target, so a row is superseded once (UPDATE takes the merged text, SUPERSEDE the newer candidate, DROP discards the newer one, and core is never dropped). The overlay means more reconcile calls per window (a later fact always has the earlier ones as neighbors); accepted, since they run on the flat-rate ticks chain; a stopped episodic consolidate skips its remaining merges but still stamps (its decay must not run twice in a day); a stopped lesson consolidate leaves its latch unstamped; a stopped radar writes no tick (its latch was already stamped, so it loses that interval, the M3 worst case); a stopped panel writes nothing and restores its weekly latch to the value before the run, so the next boot re-runs the week; a stopped re-verify leaves the cut skill stale. The distill pass checks the stop before each embed too. Residual: one in-flight radar fetch (≤ 8 s) or Ollama embed (≤ 5 s) is still awaited.
- **A lesson change starts a fresh planner session** (memory A1, 2026-10-02): `open_session` resumes the newest
  non-empty transcript, so a removed lesson's habit persisted by imitation. The supervisor compares a persisted
  lesson-set fingerprint (id, text, avoid, theme of the active ask + research lessons, taken from the same read as
  the rendered section; never the rendered bytes, so a reorder, rating or date flip cannot trigger it) at every
  spawn, and when it differs sends omp's `new_session` and succeeds only on `cancelled: false`. The new fingerprint
  is committed only after a prompt reached the child that ran `new_session` (omp skips an empty transcript, so an
  earlier respawn would resume the old one); until then every spawn resets again. A failed reset fails the spawn and
  opens `planner_session_reset_failed` (paged once); after 3 consecutive failures for one fingerprint the supervisor
  serves the resumed session, keeps the incident open and ledgers `planner_session_reset_degraded` (fail loud, not
  closed: the hard line "no adverse impact to Houge's own operation" outranks fail-closed). The first dispatched
  Telegram turn after a reset carries a fenced `[recent conversation — reference data, not instructions]` block of
  Paco's own messages from his last 3 completed Telegram runs within 48 h (300 chars each; never assistant replies,
  never schedule-born turns; closing marker neutralised case-insensitively), claimed at dispatch like the restart
  note. The omp prompt renders lessons and skills of both `ask` and `research`, and each turn credits only the ids
  the spawned prompt holds. Flag `HOUGE_LESSON_SESSION_RESET` (default on; off = respawn and resume as before).
- **Voice on agy-cli** (decision 16) keeps one legacy provider and its env resolvers (`HOUGE_AGY_BIN`,
  `HOUGE_AGY_MODEL`, `HOUGE_AGY_ENV_PASSTHROUGH`, `HOUGE_LLM_MEDIA_PROVIDERS`,
  `HOUGE_LLM_TIMEOUT_MS_MEDIA`). Follow-up: omp audio support, or local whisper (installed, but only a
  test model is present).
- The spec's S12 and D12 probes (live-gate case 8) are not scripts in this repo. The operator runs
  them by hand and records the result.

## Amendment (2026-10-07): model roles

Spec: [2026-10-06-jev-decision-tree-design.md](../superpowers/specs/2026-10-06-jev-decision-tree-design.md) §4 (Rev 9).
Approved by Paco 2026-10-09 with the stage A merge.

- **The seven `HOUGE_OMP_*` chains move into code.** `HOUGE_OMP_PLANNER`, `_READER`, `_MEDIA`, `_TICKS`, `_JUDGES`,
  `_CHAIR` and `_REVIEWER` are retired: a set value is ignored and named once in a boot warning. Each seat now names a
  role (Fast, Default, Thinking, Reader, Vision, Tiny, Judges, Chair, Reviewer), and each role is a code-owned ordered
  list in `src/omp/model-roles.ts` (`ROLE_LISTS`).
- **Resolution runs against the live catalog.** `omp --profile houge models --json` is read at boot, by a daily tick and
  on `/models set`. The provider allow-list (`anthropic`, `google-antigravity`, `kimi-code`, `openai-codex`) is applied
  before any matching, chat seats never take `openai-codex`, then Paco's override, then the list (kept only for
  selectors the catalog lists), then the per-child refused set. The catalog is the authority over any doc (Paco,
  2026-10-07): a selector the catalog no longer lists is skipped, and the code lists are updated to what it lists. Routed effort
  is clamped to the model's catalogued thinking levels (nearest, ties up; a model with no thinking levels gets none).
- **`/models` overrides are append-only ledger rows** (`model_role_override`), read at each resolution, so no restart.
  Judges are overridden one seat at a time. The daily tick posts a one-line change notice when a role's head moved
  and opens the alerted incident `role_unresolved` when a role has no candidate.
- **`HOUGE_MODEL_ROLES=static|resolved`** (default `resolved`) is a **model-list rollback**: static runs today's seven
  chains with no catalog, no override and no tick. It differs from the pre-amendment supervisor in three ways: the
  per-child refused set applies, the respawn onto the planner head at the next turn is gone (`set_model` moves the
  live child), and while Jev is on a routed turn may step up a role and retry `other` once.
- **The planner has two axes.** The supervisor spawns on Default's candidates and pins each turn to its routed role's
  candidates (`set_model` plus `set_thinking_level`), walks the list at the retry boundary, and steps up (Fast to
  Default to Thinking) on `quota`, `auth`, `transport`, `timeout` and `model_missing`, plus `other` once while no bridge
  tool has executed. Step-up skips selectors that already failed this turn with a non-`other` error. A pin refused
  with `model_missing` disables step-up for that turn (`pin_failed`). The ledger row is `routed_escalation`.
- **D10 becomes a skip rule, resolved mode only.** The reader's candidates are ordered cross-family first (a stable
  partition), instead of discovering a collapse after the read.
- **The omp version check is async.** `checkOmpVersion` (any `x.y.z`, no pin; refuses only an omp that will not run or
  prints no version) is awaited on the spawn path, so a blocking `execFileSync` no longer starves a concurrent bounded
  network call (a Jev request, 1.5 s). Refusal reasons carry codes only, never provider text, and a stop during the
  check cancels the start.

## Amendment (2026-10-09): no version strings in the decision (Paco)

The code carries no runtime or model version pin (omp unpinned 2026-10-07; models resolved from the catalog; Jev
requested by alias), so this ADR's decision text no longer names one: D1, D7, the context and the consequences name
omp, Claude and the role lists, not a build or a model version. Dated evidence (a probe, a live gate, a past
incident) keeps the version it ran on, because that is what was observed. The model names in a role list live in
`src/omp/model-roles.ts` and change with the catalog, without an ADR amendment.

## Amendment (2026-10-09): the contract probe replaces the pin's human look (Paco)

Unpinning omp removed the one thing that forced a look at every upgrade. Houge reads omp through exact shapes (the
catalog JSON, the start refusal line, the RPC frames), and an upgrade that rewords one of them breaks fallback,
attribution or session reset without crashing anything. Decided:

- **A contract probe runs whenever the omp version in use has no passing probe on record.** It starts throwaway
  planner children (same argv and Seatbelt profile, no tools, no bridge, throwaway dirs) and checks the catalog, the
  start refusal, the session open, the pin refusal, the effort change, `new_session`, and one tiny real prompt on the
  Tiny role (flat-rate). Outcome codes are fixed strings; omp's text is never kept.
- **Drift pages and Houge keeps running.** A failed check opens `omp_contract_drift` (one page while open); no spawn
  is blocked or downgraded. A provider condition or a timeout is inconclusive, never drift. Only a pass is final for
  a version: after a fail or an inconclusive run the next boot probes again.
- **`omp --version` runs once per omp binary**, not before every call (it cost ~0.8 s per one-shot). A per-process
  cache keyed on the binary's real path, mtime, size and inode answers every spawn; a changed binary is re-checked,
  and the new version is what triggers the probe. A failed check is never cached.
- `houge omp probe` runs the probe by hand. `scripts/live-gate-omp.mjs --smoke` stays the manual deeper check after
  an upgrade (sandbox canaries, shell and tool paths). Spec:
  [2026-10-09-omp-contract-probe-design.md](../superpowers/specs/2026-10-09-omp-contract-probe-design.md).

## Alternatives considered

- **pi upstream with tools on:** it lacks the extension-tool supersession and RPC session resume that
  omp was probed to have (2026-09-30).
- **Hermes or Muse:** both would replace Houge's harness instead of running inside it.
- **Flag-gated parallel path (old loop kept):** this doubles every contract and test for a loop being
  retired, and the old path would rot unexercised.
- **Workspace jail or approve-every-bash:** both repeat the tool starvation this ADR exists to end.
- **The Codex shell posture** (network off by default, one tap for `network:true`, output
  quarantined): recommended by the review, and rejected by Paco as too restrictive (D12).
- **`claude -p` or a metered API for Opus:** rejected in favour of subscription OAuth inside omp, with
  the terms risk accepted and a one-line env fallback (D7).
