# omp runtime — ADR 0002 V2: the agent gets its tools back

**Date:** 2026-09-30 · **Rev:** 15 (clean rewrite after 13 Codex passes + a whole-document self-review + the final pass, then Paco's D10–D12; record in §15)
**Status:** design complete pending Paco's review of the written spec (D10, D11, D12 decided 2026-09-30) · **Deciders:** Paco
**Supersedes at ship:** ADR 0002 inference-only mode · **Amends:** 0013, 0014, 0015, 0019, 0022, 0023
**Binary pinned:** `omp/18.4.4` (`@oh-my-pi/pi-coding-agent`), profile `houge`. Every flag, frame and behaviour
marked *probed* was exercised on this binary and this host on 2026-09-30; anything else is marked *(verify at build)*.

## 0. Why

Four months produced a safety harness with one real tool: `web_search` is 78% of all tool steps in the ledger;
human messages fell from 193 (July) to 14 (August). On 2026-09-09 Paco observed that the tool limits in the
backend were holding Houge back. Houge picked
pi (the core of OpenClaw) as its agent and then ran it with `--no-tools` (ADR 0002 "inference mode"), rebuilding a
weaker loop on top. This spec finishes ADR 0002 V2: the agent runs with tools, inside containment Houge owns, on
the strongest subscription model per seat. Sub-project 1 of 4 (2 = Paco's personal tools; 3 = auth broker + OS
user isolation + quota invariant; 4 = self-evolution v2, seams in §13).

## 1. Locked decisions

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | Runtime binary | **omp 18.4.4** under profile `houge` | pi upstream; Hermes; Muse |
| D2 | Cutover | **hard**: old loop + pi/agy providers deleted in the same slice | flag-gated parallel path |
| D3 | Dual-LLM wall | **kept for the read tools** (`web_search`, `http_fetch`, `gmail_read`, `google_api`), enforced in the bridge; **shell output is exempt** by D12 | drop; per-source trust |
| D4 | Conversation memory | **omp session owns the transcript**; Houge owns knowledge | stateless recomposition |
| D5 | Planner autonomy | **yolo under `$HOME`**: file read/write/edit and shell commands run without a prompt, **except external writes and destructive deletes** (matcher, §5.5) | workspace jail; approve-every-bash |
| D6 | Floors | (A) secret/protected paths denied at the OS level + policy hook; (B) external effects wait for `/approve` — for `bash` this is a **best-effort, code-owned command matcher** (D12), for bridge tools the registry's `external_write` level | — |
| D7 | Models | subscription OAuth only; Opus 5.5 via Anthropic Max OAuth **inside omp** (terms risk accepted; fallback is one env line) | `claude -p`; metered API |
| D8 | Tool set | port 12 as bridge tools; delete `llm_answer` + money track (5 tools) | port all 18 |
| D9 | Gmail | port with an `account` key designed in | rewrite later |
| D10 | Family collapse (planner and reader on one model family after fallback) | **accept the degradation, audited** (Paco, 2026-09-30): the read proceeds; every such read writes a `wall_collapse` ledger event and opens/keeps an incident so the frequency is visible; a fourth reader string on the GPT family (Codex Plus) makes collapse rare in practice | fail closed |
| D11 | Floor A residual | **accepted** (Paco, 2026-09-30): the omp planner process must read its own OAuth store (`~/.omp/profiles/houge`), so the OS sandbox cannot deny it to that process; the policy hook denies omp's `read` of it, and with D12 no shell runs inside that process. Revisited in SP3 (separate macOS user) | block yolo until SP3 |
| D12 | Shell = bridge tool, **Claude Code posture** (Paco, 2026-09-30) | omp's built-in `bash` is replaced by a Houge bridge tool **registered under the same name** (*probed*: an extension tool named `bash` supersedes the built-in). Commands run daemon-side under `sandbox-exec` with the floor-A file denies and the signal/launchctl denies, **network allowed**, output returned **raw** (capped). Consequence accepted by Paco: a steered planner can fetch hostile bytes through `bash` around the reader wall; ADR 0014 is amended to exempt shell output. Floor B for `bash` = the regex matcher (`git push`, `gh … create`, `curl|wget|http` with `-X POST|PUT|PATCH|DELETE|--data`, `mail|sendmail`, `ssh|scp|rsync`, `npm publish`, `sudo`, `launchctl`, `crontab`) → `/approve`; misses run — accepted residual. | the recommended Codex posture (network off by default, `network:true` = one tap, output quarantined) — rejected by Paco as too restrictive |

## 2. Goals / non-goals

**Goals.** (1) Every Telegram turn runs on a real agent loop (read/edit/write + sandboxed shell + Houge tools) on
Opus 5.5 by default. (2) Continuity across turns and daemon restarts. (3) Every locked safety property survives
with its enforcement point named: wall, protected paths, secret hygiene, `/approve` on the irreversible, budget
breaker, kill switch, audit chokepoint, rating attribution. (4) `src/` shrinks.

**Non-goals.** Paco's own Gmail/Calendar/reminders (SP2). Auth broker, OS user isolation, quota invariant (SP3).
Weakness mining, prompt A/B (SP4). The self-write writer (codex), the merge pipeline, and the panel chair's logic
are unchanged (the chair's model moves to an env string, §8).

## 3. Threat model and boundaries

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

**Floor A as built (final review fix wave, 2026-10-01).** The layers above are implemented as follows; the code is
`src/omp/protected-paths.ts`, `seatbelt.ts`, `gate-path.ts` and `workspace.ts`, and the gate mirrors the profiles.

- **Writes are denied by default** (D5 read literally: yolo *under `$HOME`*). Both profiles render, in order and with
  SBPL's last-match-wins: `(deny file-write*)`; allow `$HOME`, `/private/tmp` and the omp workspace (plus the sessions
  dir for the planner); allow only `/dev/null`, `/dev/tty` and `/dev/fd`; deny the whole repo, `dist/`, the daemon's
  operational files, the `$HOME` binary install trees (`~/.bun`, `~/.local`, `~/.npm`, `~/.nvm`, `~/.cargo`,
  `~/.rustup`, `~/.pyenv`, `~/.volta`, `~/.deno`, `~/go`, `~/.homebrew`, `~/.oh-my-zsh`), the directories (PATH
  lookup and realpath) of the omp, codex, agy and node binaries, and the dotfiles that make git, a shell, a terminal
  or an editor run code (`HOME_CODE_CONFIG`: git config, every zsh/bash/fish/tcsh startup and logout file and
  ZDOTDIR, `~/.p10k.zsh`, terminal configs, `~/.vimrc`/`~/.vim`/`~/.config/nvim`, tmux config, `~/.envrc`);
  re-allow the workspace; pin roots and every `chat-<id>` dir; secrets last. `/private/var/folders`
  (`os.tmpdir()`) is **not** writable.
- **Credential stores are read- and write-denied** in both profiles (`HOME_SECRETS`): `~/.ssh`, `~/.omp` (shell
  only; D11 for the planner), AI and dev tools (`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gemini`, `~/.kimi`,
  `~/.kimi-code`, `~/.copilot`, `~/.grok`, `~/.hermes`, `~/.antigravity`, `~/.antigravity-ide`, `~/.pi`,
  `~/.agentmemory`, `~/.agents`), bots (`~/.houge`, `~/.dsh`, `~/.whatsapp-bot`), cloud and containers
  (`~/.docker`, `~/.config/gh`, `~/.config/gcloud`, `~/.aws`, `~/.azure`, `~/.kube`), keys and tokens (`~/.npmrc`,
  `~/.cargo/credentials*`, `~/.gnupg`, `~/.netrc`, `~/.git-credentials`), `~/Library/Keychains`, and by regex every
  top-level `~/.env` / `~/.<name>.env`. `/usr/bin/security` cannot exec (the Keychain is reached over Mach IPC).
  Secrets render after every write allow, so `$HOME`'s allow cannot re-open one.
- **The gate canonicalises paths as omp does.** `gateTargets` mirrors omp 18.4.4's own resolver (`expandPath`,
  `expandTilde`, `resolveToCwd`): the `@` and `:` prefixes, `~`, `~/x`, `~x`, `file://`, unicode spaces, `:selector`
  and list forms. The gate denies when *any* resolution is denied, and refuses `bad_path` on any form it does not
  model (control characters, backslashes, other `@`/`:` prefixes, double prefixes, more than 256 candidates).
  `edit` rename, hashline `[path#HASH]` / `MV` and apply_patch targets are gated too; an edit body with no target the
  hook can see is refused.
- **The workspace cannot be swapped.** The profiles pin the workspace and sessions roots and every `chat-<id>` dir
  under them with literal/regex write denies (the daemon creates them), so the sandbox cannot move, remove or
  symlink-replace one. Before an attachment is read, `verifiedWorkspace` lstat-checks each component from
  `<data>/omp` down to `chat-<id>` and requires `realpath(ws)` to equal the expected path.
- **Daemon temp space is off `os.tmpdir()` and out of the repo.** Media downloads, codex out-files and agy
  workdirs live in `~/Library/Caches/houge-daemon` (`HOUGE_DAEMON_TMP_DIR`; 0700, read- and write-denied in both
  profiles). A root with a `.git` ancestor pages `daemon_tmp_in_git_repo` at boot and voice ingest refuses; agy
  never runs with a cwd inside a git repo (it may root file access at the toplevel, `.env` included). Self-write
  worktrees stay in `<data>/selfwrite` (0700, write-denied). Before publish the unified diff is re-hashed and
  compared with the reviewed one; a change refuses the publish.
- **Children get a private `TMPDIR`.** The planner and every `bash` command run with `TMPDIR=<workspace>/.tmp`;
  one-shots, codex and agy with `TMPDIR=` the daemon temp root. Nothing a child writes lands where the daemon later reads.
- **Daemon-side git ignores user and system config** (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, no
  fsmonitor, no hooks), except `push`, which keeps the credential helper; `~/.gitconfig` is write-denied.
- **Absolute binaries.** `/usr/bin/sandbox-exec` and every wrapper helper are called by absolute path under a fixed
  `PATH`; the command alone gets the caller's `PATH`.

## 4. Process topology

```
launchd → houge daemon (Telegram long-poll, ledger, scheduler, sweeps, approvals, bridge server, supervisors)
  │
  ├─ planner: ONE omp RPC process per chat, supervised (§7)
  │    sandbox-exec -f <data>/omp/planner.sb omp --profile houge --mode rpc
  │        --config <data>/omp/houge-config.yml    (tools.xdev:false, startup.checkUpdate:false,
  │                                                  marketplace.autoUpdate:false, telemetry.otlpExportEnabled:false)
  │        --session-dir <data>/omp/sessions/chat-<id>   --cwd <data>/omp/workspace/chat-<id>
  │        --tools read,edit,write   -e <dist>/omp/houge-tools.js   -e <dist>/omp/houge-policy.js
  │        --no-extensions --no-rules   (skills: omp 18.4.4 has --skills <globs> and --no-skills, not pi's --skill <path>;
  │                                     how <data>/skills is mounted into the profile is resolved in the plan)
  │        --approval-mode yolo   --model <planner[0]>   --thinking <planner[0].effort>
  │        --append-system-prompt <data>/omp/system-chat-<id>.md
  │    after `ready`: open_session(<session-dir>)  (*probed*: resumes the transcript AND obeys a changed prompt)
  │    stdin : prompt | steer | abort | set_model | set_thinking_level | open_session
  │    stdout: JSON frames → ledger.  (never --no-ui / UI dialogs: approvals live in the bridge, §7.2)
  │
  ├─ one-shot seats (reader, media, distill, consolidate, extract, judges, chair, reviewer): one spawn per call
  │    omp --profile houge -p --mode json --no-session --no-tools --no-extensions --no-skills --no-rules
  │        --model <seat[i]>          (prompt on stdin, *probed*; media via @file)
  │
  └─ writer: codex exec --sandbox workspace-write                                            [unchanged]
```

*Probed flag facts:* `--no-tools` disables built-ins only; extension tools load unless `--no-extensions`;
`--tools` does not filter extension tools; with `tools.xdev` on, unlisted tools are reachable through `read`/`write`
`xd://` devices. Therefore **the policy hook is the tool allowlist; flags are belt.**

- **`<data>`** = the directory of `houge.sqlite`. New gitignored subtree `omp/`: `sessions/`, `workspace/`,
  `bridge/` (one socket per planner child), `planner.sb`, `shell.sb`, `houge-config.yml`,
  `system-chat-<id>.md`. `skills/` moves under `<data>`. Workspaces persist (they hold files the planner made for
  Paco); no retention policy in SP1.
- **Child env** = `buildChildEnv` allowlist (`PATH HOME TERM LANG USER`) + `HOUGE_OMP_ENV_PASSTHROUGH`
  (`KIMI_CODE_OAUTH_HOST,KIMI_CODE_BASE_URL`; *probed*: k3 answers without them once logged in; kept for token
  refresh against kimi.ai) + `HOUGE_BRIDGE_SOCK` + `HOUGE_BRIDGE_TOKEN`, both **minted per child** by its
  supervisor (socket `<data>/omp/bridge/<chat>-<uuid>.sock`, 0600, random token; listener closed and token
  discarded on child exit), so every connection on that socket *is* that child. The token is anti-accident only.
- **One chat = one process.** Schedule fires run in the same session (§7.4).
- **Sandbox availability.** `HOUGE_OMP_SANDBOX=1` in production; `sandbox-exec` missing or a profile failing to
  render → the planner does not start, incident `sandbox_unavailable`. Tests run with `0`.

## 5. Tool surface

### 5.1 Bridge tools

`src/omp/tools/*.json`, one **declaration** per tool — **data, never code** (closes Codex pass-13's blocker:
a self-writable executable module would run inside the planner process with its rights): `bash` (§5.6),
`web_search`, `http_fetch`, `to_local_time`, `lesson_write`, `schedule_task`, `wiki_build`, `wiki_refine`,
`self_diagnose`, `self_write_propose`, `skill_author`, `gmail_read`, `google_api`. A declaration is
`{ name, description, parameters (JSON Schema, the single schema owner), annotations }` — **it never names a
capability.** The mapping from tool name (+ validated input) to registry entry is **code-owned and protected**
(`src/omp/capability-map.ts`: `bash` → `shell_external` when the code-owned matcher classifies the command as
an external write (approval-gated), else `shell`; every other tool 1:1 by name); a declaration whose name has no map entry is rejected, so a self-written declaration can
describe a tool but can never choose its policy class (final Codex pass). The **daemon** loads and validates the
directory at boot (unknown keys, non-schema values, or a name absent from the map → refuse to start the planner,
incident `tool_decl_invalid`) and serves
the validated list to the extension over the bridge (`manifest` request at session start). `houge-tools.ts`
(protected, unchanged by self-writes) registers one generic stub per declaration whose body is
`bridgeCall(name, input)`. Implementations stay daemon-side adapters in `src/capabilities/`, which self-writes
already reach through the existing pipeline (worktree → test gate → reviewer → human merge tap). Today's
manifest "input sketches" are replaced by these schemas; the daemon validates inputs with a hand-rolled
JSON-Schema subset (`type`, `properties`, `required`, `enum`, `additionalProperties:false`, `maxLength`;
`dependencies:{}` intact). Every stub is registered for sequential execution so at most one bridge call is in
flight per turn *(attribute name: verify at build)*.

### 5.2 The bridge

- **Transport.** Per-child Unix socket (§4), JSON lines, request ids, one request → one response.
- **Authority is server-owned.** The listener belongs to one supervisor, so `connection → child → chat → the run
  in flight` is a lookup, not an inference. The child sends `{id, kind, tool, input, toolCallId}` only; run id,
  requester, lease, contract, arming and `BudgetLedger` come from supervisor state. No turn in flight →
  `no_active_turn`. Token mismatch → connection closed.
- **Timeouts.** Bridge request timeout = adapter timeout + 5 s; the clock is suspended while the call is
  AWAITING_APPROVAL; the adapter timeout starts when execution begins. The stub sends omp a progress update
  every 30 s for the whole wait.
- **Five request kinds:**
  1. `call {tool, input, toolCallId}` → schema validation → the code-owned capability map (§5.1; one model-facing tool may map
     to several registry entries with static metadata, e.g. `bash` → `shell` | `shell_external`) →
     `CapabilityRunner.execute` (registry, budget, `decideCapability` against the run contract, adapter) → the
     bridge emits `tool_finished` with the ledger's existing required fields (`tool_call_id`,
     `status: succeeded|failed|denied`, `output_hash`, `duration_ms`, `bytes_out`) plus optional `tool`,
     `bytes_in`, `reason` → response `{content, structuredContent?, isError?}` capped at 32 KiB.
  2. `gate {tool: read|edit|write, input, toolCallId}` from the policy hook before omp runs a built-in: posture
     (kill/park/guard), contract `allowed_actions` (`fs_read` / `fs_write`), floor-A path check → `allow |
     deny{reason}`; writes the existing `policy_decision` event; a deny also writes `tool_finished{denied}` and
     `loop_step{ok:false}`. Budget: `fs_write` reserves a `tool_calls` unit; **`fs_read` is gated but not
     budgeted** (reads are the agent's eyes; the old 14-call cap would end exploration in one turn).
  3. `report {toolCallId, outcome, bytes_out, duration_ms}` from the hook's `tool_result` handler: writes
     `tool_finished` (`tool: builtin:<name>`) and `loop_step{step, action: builtin:<name>, capability:
     fs_read|fs_write, ok, result_digest}` — counts only, never content. Allowed-but-unreported calls (child
     died) get `tool_finished{failed, reason: unreported}` + `loop_step{ok:false}` at turn end, so the global
     breaker (counts `tool_finished` rows) never undercounts.
  4. `context {message}` from `before_agent_start`, read-only → `{preamble, applied_artifacts}` (§6).
  5. `manifest {}` at session start, read-only → the validated tool declarations (§5.1).
- **The wall.** `web_search`, `http_fetch`, `gmail_read`, `google_api` return through **one** function,
  `normalizeExternalRead()` (`bash` output is exempt, D12): `{digest, contains_instructions, trusted_extract?,
  source_meta}`; only `trusted_extract` (the existing code-built side-channel: ids re-validated
  `^[A-Za-z0-9_-]+$`, links byte-exact, OTP codes) may carry source bytes. A test pushes a marker through each
  adapter and asserts it appears only inside `digest` (rephrased) or `trusted_extract.links`, never in the
  response, `tool_finished`, or logs.
- **Provenance strip** is contract-level: schedule-born runs carry no `schedule_task` action; the runner denies it.
- **Replay.** A bridge call executes at most once per `toolCallId` (in-memory cache per supervisor); a duplicate
  returns the cached response. A daemon restart ends the turn, so no in-flight id can repeat afterwards.

### 5.3 Built-ins on the planner

`read`, `edit`, `write` only. The policy hook denies any other tool name (omp's own `web_search`, `fetch`, LSP,
PTY, MCP never load — config plus `--no-extensions` — and the allowlist blocks any future built-in), `read` of a
URL or `xd://` path, and floor-A paths (reason `protected_path`), including `read` of `~/.omp/profiles/houge/**`
(D11 mitigation).

### 5.4 Floor A: Seatbelt profiles

`src/omp/protected-paths.ts` exports `SECRET_PATHS`, `PROTECTED_REPO_PATHS` (the self-write guard's set,
exported for the first time and imported back by `self-write-guard.ts`), and `OPERATIONAL_WRITE_DENY`
(`<data>/houge.sqlite*`, `<data>/omp/bridge/`, `<data>/omp/*.sb`, `<data>/omp/houge-config.yml`,
`~/Library/LaunchAgents/com.houge.*`, `<repo>/dist`). `renderSeatbelt({home, repo, data}) → {planner, shell}`: paths resolved with `realpath` (a missing path is emitted literally so a later creation is covered);
directories → `(subpath …)`, files → `(literal …)`; Seatbelt escaping of `"` and `\`; `$HOME` aliases
(`/private/…`) added by realpath'ing `$HOME`; all three profiles carry `(deny signal (target others))`,
`(deny process-exec (literal "/bin/launchctl"))`, `(deny mach-lookup (global-name "com.apple.launchd"))`
(*probed*: `kill`/`pkill` of the daemon → `Operation not permitted`, `launchctl` cannot exec, self-signals work).
Profiles are written atomically (tmp + rename, 0600) at boot and before every planner start. The rule order and
path sets as built (default-deny writes, credential denies, workspace pins) are in §3, "Floor A as built".

### 5.5 Floor B: the approval matcher

External effects have two doors: `bash` commands the **code-owned matcher** (`src/omp/external-write-matcher.ts`,
protected) classifies as external writes — mapped to registry entry `shell_external` (side-effect
`external_write`, in `approval_gates`) — and any future bridge tool registered `external_write` (none of the
twelve ported tools). Both go through the runner's approval gate → `tool_approvals` row (§7.2) → approval card
(the matched pattern is the card's label) → `/approve <appr_id>` or `/deny <appr_id>` → the waiting bridge
request resolves. Patterns: `git push`, `gh (pr|issue|release) create`, `curl|wget|http[ie]` with `-X
(POST|PUT|PATCH|DELETE)` or `--data|-d |--upload`, `mail|sendmail|osascript`, `ssh|scp|rsync` to a remote,
`npm publish`, `pip upload|twine`, `sudo`, `launchctl`, `crontab`, and **destructive deletes anywhere, including
the workspace** (Paco, 2026-09-30): `rm` with `-r` or `-f`, `find … -delete`, `git clean`, `git reset --hard`,
`git checkout -- .`, `truncate`, `shred`, `mkfs`, `diskutil erase`. **A command the matcher misses runs without
a tap — accepted residual (D12).** Timeout `HOUGE_OMP_APPROVAL_TIMEOUT_MS` →
`denied{approval_timeout}`, the planner is told and continues.

### 5.6 The shell tool (`bash`)

**Model-facing.** `bash{command: string}`, described exactly like Claude Code's Bash tool: run a shell command on
the Mac mini; some commands (pushes, posts, sends, recursive or forced deletes) ask Paco first; output is capped
at 32 KiB.

**Requirements the adapter must satisfy** (the exact script lives in the implementation plan; each requirement
has a test in §11):

- R1 Runs the command only inside `sandbox-exec -f shell.sb`, under `nice -n 10`,
  cwd = the chat workspace, env = child allowlist, no PTY, output cap 32 KiB.
- R2 Resource limits are set **before** the command and **fail closed**: `ulimit -u 512 -t 600 -f 1048576 -n 1024`
  (*probed*: these four are accepted on macOS; `-v/-m/-d/-s` are rejected and not used). A limit that cannot be
  set means the command never runs. Caveat: `-u` is per-user (436 in use today), so a fork bomb stops within
  ~76 forks but may briefly make the daemon's own spawns fail (existing transport-error retry).
- R3 The daemon spawns a fixed, protected wrapper (`src/omp/shell-wrapper.sh`) as the **detached process-group
  leader outside the sandbox**; only the model's command is inside the sandbox line. (*Probed*: `$$` is the pgid
  in that layout; `pgrep` works there; inside `shell.sb` `ps` is exec-denied.)
- R4 **Normal completion leaves an empty group.** After the command returns, the wrapper kills every other group
  member and reports success only when the group is empty; it never signals after it has exited. (*Probed*:
  backgrounded, `nohup`'d and subshell-detached children are gone at exit; exit code preserved; `curl` inside is
  blocked; a missing `pgrep` yields a cleanup failure.)
- R5 The wrapper reports its own outcome on a **separate status channel (fd 3)** — one line `ok |
  limits_failed | cleanup_failed` — read by the adapter after the leader exits; the command runs with fd 3
  closed so it cannot forge a status; the wrapper's exit code mirrors the command's. `limits_failed` →
  `failed{limits_failed}`; `cleanup_failed` → `failed{cleanup_failed}` + incident; missing/malformed →
  `failed{wrapper_unknown}` + incident. **The model never sees success from an uncertain cleanup.**
- R6 The adapter owns the deadline (`HOUGE_OMP_SHELL_TIMEOUT_MS`, default 120 000; the runner's timeout for this
  capability is that + 5 s so the adapter fires first) and cancellation: on deadline, output cap, or any abort
  (runner race, turn deadline, frame watchdog, `/kill`, the `--once` bound, bridge disconnect) it `killpg(SIGKILL)`s the
  group and keeps doing so every second until the child's `exit` fires, then returns `failed{timeout|output_cap|
  aborted}`. Cleanup never leaves the adapter's lifetime: the daemon holds the child handle so the pid is
  reserved until reaped; a 5 s cleanup miss opens `cleanup_timeout` as **evidence only** — no later kill by pgid.
- R7 The runner never returns to the bridge before the adapter has settled or the 5 s bound expired;
  `CapabilityRunner.execute` passes an `AbortSignal` to every adapter (today's `Promise.race` has no
  cancellation).
- R8 Output is returned raw to the planner (D12), capped at 32 KiB with a truncation note; the ledger stores
  only `output_hash` and `bytes_out`.
- R9 The wrapper's trust chain — `src/omp/shell-wrapper.sh`, `src/omp/shell-wrapper.ts` (embedded script text +
  expected sha256), `scripts/copy-omp-assets.mjs` — is in the protected set; the daemon verifies the built file's
  hash before every planner start (mismatch → planner does not start, incident `wrapper_mismatch`).

### 5.7 Deleted tools

`llm_answer`. Money track: `bounty_scan`, `project_track`, `project_update`, `project_list`, `external_work` +
`bounty-intake.ts`, `anchor-verify.ts`, `external-workspace.ts`, `container-runner.ts`, their tests, the
external_work publish path. Tables stay. ADR 0022/0023 amended "dormant; code removed at <commit>".

## 6. Memory, prompt, attribution

- **Session.** Process start → `open_session(<session-dir>)`: `resumed:true` continues the newest session file,
  else a new one. `new_session(parentSession)` is lineage only and is not used.
- **System prompt.** `<data>/omp/system-chat-<id>.md` = `composer` for surface `loop` (identity + a rewritten
  loop discipline that explains tools, the wall, approvals and the attach marker + guardrails) + active lessons
  for scope `ask`. Lesson scopes are not renamed: `ask` keeps meaning the conversational surface (writer accepts
  `ask|research`, `getActiveLessons` scope-exact, `/lessons` unchanged); `research` lessons keep feeding the
  one-shot reader. Refresh: when lessons or identity change, the supervisor marks the session `stale`; at the
  next idle boundary it restarts the child with the new file and `open_session` resumes the transcript
  (*probed*: a resumed session kept a prior secret and obeyed the changed rule).
- **Per-turn context.** `before_agent_start` calls bridge `context` → `retrieveEpisodicFacts` +
  `retrieveWikiPages` → `{preamble, applied_artifacts:{lesson_ids, episodic_fact_ids, wiki_page_ids}}` (field
  names byte-identical to today's `loop_started.applied_artifacts`); the hook appends the preamble; the daemon
  writes `loop_started` and touches the artifacts, so rating attribution is unchanged.
- **`chat_turns`.** User row at prompt send (`intent: "loop"`); assistant row at `agent_end` (`intent:
  "clarify"` when the reply ends without a tool call and contains a question, else `"loop"`), so the
  consecutive-clarify cap keeps its input. `ClarifyCounter` moves to `core/clarify-cap.ts`; `classifyIntent`
  callers are deleted; Jev shadow/replay read historical rows only (`jev-shadow` prints a "dormant since" banner;
  `HOUGE_JEV_SHADOW_ENABLED` leaves `DISARM_FLAGS`). Built-in `loop_step` rows carry `action: builtin:<name>`,
  `capability: fs_read|fs_write`; the eval reader treats the `builtin:` prefix as that class.
- **Photos/voice.** Unchanged: media one-shot seat → digest/transcript → prompt text; never `images` on `prompt`.
- **Attachments.** A reply ending with `[[attach: <path>]]` under the workspace → outbox `sendDocument`; the
  daemon validates the path and strips the marker. Reply text still goes through the rich renderer.

## 7. Turn state machine and supervision

**Detached turns.** The poll loop no longer awaits `executeRun` for `turn` runs: it hands the run to the chat's
`PlannerSupervisor` and returns to polling. That is what lets `/approve`, `/kill`, a second message
and outbox flushes happen during a turn. Non-turn runs keep the synchronous path.

```
STOPPED ──start──▶ STARTING ──ready + open_session──▶ IDLE
IDLE ──prompt──▶ RUNNING ──agent_end──▶ IDLE
RUNNING ──bridge creates tool_approvals row──▶ AWAITING_APPROVAL ──approved|denied|expired|abort──▶ RUNNING
RUNNING|AWAITING_APPROVAL ──turn deadline | frame watchdog | /kill | --once bound | child exit──▶ ABORTING ──ack|5 s──▶ STOPPING ──▶ STOPPED
IDLE ──stale prompt | idle > HOUGE_OMP_IDLE_EXIT_MS──▶ STOPPING
```

- **Deadlines.** No `--max-time` (it is per session). Turn deadline `HOUGE_OMP_TURN_TIMEOUT_MS` (600 000),
  paused while AWAITING_APPROVAL. Watchdog: no frame for `HOUGE_OMP_FRAME_IDLE_MS` (180 000) while RUNNING →
  abort; bridge stubs feed it every 30 s during long tools.
- **Terminal transitions.** `agent_end` → `run_completed`; deadline/watchdog → `loop_halted{reason, steps}` +
  partial answer if any; child exit → failed `planner_exit`; every planner string exhausted → failed
  `no_planner_leg` + incident; `/kill` → failed `killed`. `recordRunFailed` gains an `error_type` parameter
  (`planner_exit | lease_lost | lease_expired | killed | no_planner_leg | turn_timeout | frame_idle`).
- **Restart.** Lazy on the next prompt. Crash-loop guard: 3 exits in 10 min → incident `planner_crash_loop`, no
  restart until the next sweep or `/rearm`.

### 7.1 Lease ownership

`claimRun` with a **unique owner per claim** (`worker_id = "planner:<chat>:<uuid>"`), TTL
`HOUGE_OMP_LEASE_TTL_S` = 120, renewal every 30 s via `heartbeat` (already checks `run_id + worker_id + state`).
Failed renewal → ABORTING; no terminal write after losing the lease. **One atomic terminal operation:**
`finishRun({run_id, expected_worker_id, next, event})` in one transaction — `UPDATE runs … WHERE run_id=? AND
worker_id=? AND state='running'`; `changes === 1` → append exactly one terminal event, else log
`terminal_lost`. `recoverExpiredLeases`: an expired `running` run owned by `planner:*` is **failed, not
requeued**, in one transaction keyed on the observed owner and expiry. The lease keeps renewing while
AWAITING_APPROVAL.

### 7.2 In-turn tool approvals

Run-level approvals (`createApprovalRequest` → `waiting_for_approval` → `queued`) stay for self-write and
schedule flows. Suspended bridge calls use a new record: `tool_approvals(approval_id, run_id, worker_id,
tool_call_id, capability, input_hash, action_fingerprint, requester_json, summary, side_effect_level, state:
pending|approved|denied|expired|consumed, created_at, expires_at, resolved_at)`; the run stays `running`.
Ids come from the same `appr_<uuid>` generator, so `/approve <appr_id>` and `/deny <appr_id>` use the existing
parser unchanged; `processApprovalTrigger` resolves in one transaction (`approvals` first, then `tool_approvals`,
else `unknown_approval`); `/approvals` lists both. `ToolApprovalSink { request(input) → {approval_id};
consume({approval_id, run_id, worker_id, capability, action_fingerprint, requester}) }` mirrors the runner's
existing sink; `consume` is a single CAS `approved → consumed` that also checks lease ownership and expiry, so a
row can never authorise two executions. The runner's existing `requires_approval` → re-entry with
`approved_approval_id` path is reused, with a new `budget_reserved: true` flag so the second pass reserves
nothing; a duplicate `toolCallId` while suspended attaches to the pending request. Expiry is swept by the
supervisor's timer. `gated_attempts` counts every row created. `approval_requested`/`approval_resolved` ledger
events keep their payloads.

### 7.3 Intake during a turn

Every Telegram message is still its own run (idempotency, contract, ledger unchanged). While RUNNING:
- a **user message** is created as a run, **claimed by the supervisor** (`claimRun` with the same owner id, so
  it is `running` and `finishRun` applies), then `steer`ed into the live turn (*probed*: the API exists). At
  `agent_end` the steered run is completed with the same reply reference and `state_reason:
  merged_into:<run_id>`; if the parent turn aborts or the child dies, every steered run is failed alongside it
  (`error_type: merged_parent_failed`); its `chat_turns` user row is written at steer time;
- a **schedule fire** is never steered (provenance): it waits for IDLE and then runs as its own turn with the
  code-owned preamble `[scheduled: <goal>]`;
- `/kill` → ABORTING; other commands are handled by the poll loop as today. (There is no `/guard` command: the
  `telegram --once` runner's own time bound calls `abortAll("guard")`, which fails the turn `killed` with ref
  `guard` and replies `GUARD_STOPPED_TEXT`, never the `/kill` text.)

## 8. Provider seam, models, audit

`src/llm/providers/omp.ts` (+ `omp-rpc.ts`) replaces `pi.ts`, `agy-cli.ts`, `kimi.ts`, `gemini.ts`,
`openai-compat.ts`, `cli-spawn.ts`. Two entry points: `spawnOneShot({seat, prompt, files?})` and
`class PlannerSession` (`start`, `prompt`, `steer`, `abort`, `setModel`, `stop`; typed events).

```
HOUGE_OMP_BIN=omp   HOUGE_OMP_PROFILE=houge   HOUGE_OMP_SANDBOX=1   HOUGE_OMP_VERSION=18.4.4   HOUGE_OMP_VERSION_ALLOW=
HOUGE_OMP_PLANNER=anthropic/claude-opus-5-5:medium,google-antigravity/claude-opus-4-6:medium,kimi-code/k3:low
HOUGE_OMP_READER=google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low,openai-codex/gpt-5.5:low
HOUGE_OMP_MEDIA=google-antigravity/gemini-3.8-flash:low
HOUGE_OMP_TICKS=kimi-code/k3:low
HOUGE_OMP_JUDGES=kimi-code/k3,openai-codex/gpt-5.5,google-antigravity/gemini-3.1-pro
HOUGE_OMP_CHAIR=anthropic/claude-opus-5-5:low
HOUGE_OMP_REVIEWER=kimi-code/k3:high,google-antigravity/claude-opus-4-6:medium
HOUGE_OMP_ENV_PASSTHROUGH=KIMI_CODE_OAUTH_HOST,KIMI_CODE_BASE_URL
HOUGE_OMP_TURN_TIMEOUT_MS=600000  HOUGE_OMP_FRAME_IDLE_MS=180000  HOUGE_OMP_APPROVAL_TIMEOUT_MS=1800000
HOUGE_OMP_ONESHOT_TIMEOUT_MS=120000  HOUGE_OMP_IDLE_EXIT_MS=3600000  HOUGE_OMP_SHELL_TIMEOUT_MS=120000
HOUGE_OMP_LEASE_TTL_S=120
```

- **Model strings** `provider/model[:effort]` (*probed* with `:low`); in RPC applied as `set_model` +
  `set_thinking_level` (*probed*).
- **Version pin.** `omp --version` must equal `HOUGE_OMP_VERSION` at every planner and one-shot start, else refuse
  (incident `omp_version_mismatch`) unless `HOUGE_OMP_VERSION_ALLOW` lists it — the operator's logged override
  after re-running the live gate. The profile config disables omp's own update checks (§4).
- **Family resolver** (D10): `family(provider/model)` = `claude | gemini | gpt | kimi | other` from the model id,
  route-independent. Checked at boot and after every `set_model`/reader fallback against resolved ids
  (`get_state`). Same family for planner and reader → **D10: the read proceeds**, the `llm_attempt` row carries
  `family_collapse: true`, a `wall_collapse` ledger event is written per affected read, and the sweep keeps an
  incident `wall_collapsed` open while the condition holds (transition-only alerts, as for every incident).
- **Fallback.** Error kinds from omp frames: `quota | auth | transport | timeout | model_refusal | aborted |
  other`. The first four → next string (planner: live `set_model`; a later turn retries the top string once);
  `model_refusal`/`other` are final for that call.
- **Audit.** `LlmAttempt` gains `credential_id?`, `ttft_ms?`, `family`; `LlmErrorKind` gains the kinds above.
  Exactly one row per model request: `request_key = <correlation_id>:<n>`, `n` incremented at dispatch on each
  `turn_start` frame (*probed*: one per model request), `n = 0` for a dispatch that fails before any frame;
  one-shot spawns mint their own correlation id (`tick:<name>:<uuid>`). Row written on the assistant
  `message_end` (carries `usage`), or the error frame, or at turn end as `error{aborted}`. Durable dedupe: unique
  expression index on `(correlation_id, json_extract(payload_json,'$.request_key')) WHERE
  event_type='llm_attempt'` + `INSERT OR IGNORE`. `cost_usd` is 0 for OAuth legs ("sub" in `/usage`).
- **Deleted env:** every `HOUGE_LLM_*`, `HOUGE_AGY_*`, `HOUGE_KIMI_*`, `HOUGE_GEMINI_*`, `HOUGE_CLAUDE_BIN`.
  The metered ceiling code stays, dormant.

## 9. Contract, safety, ADRs

- **Contract amendment.** Turn envelope: remove `intent_router`, `llm_answer`, `external_work`, `bounty_scan`,
  `project_*`; add `fs_read`, `fs_write`, `shell`, `shell_external` (side-effect `external_write`, in
  `approval_gates`); drop `generic_shell` from `forbidden_actions`. Schedule-born runs additionally drop
  `schedule_task` (unchanged). **Per-run budget:** `tool_calls` cap raised from 14 to 40 and counts bridge calls
  + `fs_write` (not `fs_read`); the global 24 h breaker counts `tool_finished` rows as today, with its ceiling
  re-tuned in `.env` for the new volume (documented in `configuration.md`).
- **Kill/park.** `/kill` → tombstone + ABORTING every supervisor; boot with tombstone → no child. The
  `telegram --once` bound aborts as `guard` (see §7.3); the next turn restarts lazily. `houge.parked` unchanged.
- **Secrets (ADR 0015 amendment).** L0 + L1. New secret location `~/.omp/profiles/houge/agent/agent.db` in
  `SECRET_PATHS` and in the S12 probe (D11 residual recorded).
- **Self-write.** `PINNED_ENV` pins for every `HOUGE_OMP_*`; protected set gains **every file the planner
  process loads** — `src/omp/houge-tools.ts`, `src/omp/houge-policy.ts` — plus `src/omp/protected-paths.ts`,
  `src/omp/seatbelt.ts`, the shell trust chain (R9). `src/omp/tools/*.json` is deliberately not protected: it is
  data the daemon validates (§5.1, §13).
- **ADRs.** New **ADR 0028** "omp runtime: agentic mode under code-owned floors" (supersedes ADR 0002's
  agentic clause; records D1–D12, §3 in full, the residuals). Amend 0013 (composition is omp's loop), 0014
  (wall in the bridge for the read tools + shell output exempt by D12 + family resolver + D10's audited
  degradation), 0015, 0019 (dormant), 0022/0023 (dormant).

## 10. Deletions

`src/core/inner-loop.ts`, `src/core/tool-manifest.ts`, `src/capabilities/intent.ts`, the six provider files,
`src/capabilities/llm-answer.ts`, the money-track files, and their tests. **Inventory first** (plan task 0):
every deleted test is listed with the behaviour it protected and either "retired with the feature" or the name
of the new contract test that replaces it. Target `src/` ≤ 25 k lines (from 37 k).

## 11. Testing

- **Protocol fixture.** `tests/fixtures/omp-frames/*.jsonl` = frames captured from the real 18.4.4 binary during
  this review (prompt/agent_end, set_model, get_state, open_session, tool_execution_*, error frames);
  `tests/fixtures/fake-omp.mjs` replays scenarios in `--mode json` and `--mode rpc`. `HOUGE_OMP_BIN` points at it;
  `HOUGE_OMP_SANDBOX=0`.
- **Suites** (each test names the behaviour it protects): provider parsing + error kinds; fallback ladder incl.
  `set_model` and the family resolver; bridge auth, server-owned run binding, `no_active_turn`, schema
  validation, replay-by-`toolCallId`, response cap; policy hook (allowlist, URL read, floor-A paths, deny
  reasons); approval matcher (every pattern + a miss), round-trip, CAS consume, timeout; supervisor state machine (every edge, crash-loop
  guard, lease renewal, `finishRun` CAS); intake during a turn (steer + merged run completion, schedule wait,
  `/approve`, `/kill`); attribution; wall marker test; Seatbelt rendering from `protected-paths.ts`; attach
  marker; **shell R1–R9**: limits fail closed (unsatisfiable `ulimit`), status channel (`limits_failed`,
  `cleanup_failed` via a fake `pgrep` on `PATH`, missing status, a command exiting 97 itself reads `ok`), forged
  `>&3` from the command fails, normal completion with backgrounded children leaves an empty group, every abort
  source during a running command (abort before spawn, runner timeout, turn deadline, `/kill`, the `--once` bound, bridge
  disconnect during the command and during cleanup) asserts group gone, one `tool_finished{failed}`, no second
  reservation, retry timer cleared at `exit`, no signal afterwards; `cleanup_timeout` via an injected no-op kill
  (child alive past 5 s, incident asserted, then reaped); PINNED_ENV; hermeticity (`HOME` at an empty temp dir,
  no read of `~/.omp`).
- **Extension unit tests** run both extension modules against a stub `pi` API.
- **Live gate `scripts/live-gate-omp.mjs`** (real daemon, `houge` profile, real Telegram), PASS only with the
  named ledger rows: (1) plain question → `llm_attempt` on `anthropic/claude-opus-5-5`; (2) web question →
  `web_search` bridge call, reader row `family=gemini`, digest only; (3) "read ~/.ssh/id_rsa" and "cat .env" →
  `Operation not permitted` + `protected_path`; (4) "git push" → matcher → card; `/deny` blocks, `/approve` runs; (5) daemon restart mid-conversation → next turn
  remembers; (6) planner string 1 forced invalid → `set_model` fallback row; (7) photo + voice `ok`; (8) S12/D12
  re-run; (9) second message mid-turn → steered, both runs completed; (10) `/kill` mid-turn → child gone in 5 s;
  (11) reader forced to the planner's family → the read still answers, `wall_collapse` row present, incident open; (12) replay eval (§13), answer-only, recorded;
  (13) `bash curl https://example.com` → raw output returned, `tool_finished` carries only its hash; (14) `bash`
  fetching the injection page → the planner receives it raw (D12) and the D12 probe records whether the planner
  was steered (observation, not a gate); (15) `bash kill -0 <daemon pid>` and
  `launchctl list` → denied, heartbeat unbroken; (16) `/approve` arrives during a detached turn and resumes it;
  (17) a schedule fire during a user turn waits and runs after. Silent-degradation checks: missing row, equal
  families without incident, `tool_finished` absent for a bridge call, `cost_usd>0` on an OAuth leg.

## 12. Cutover and rollback

Branch `feat/omp-runtime` in a worktree; tasks TDD, subagent-sized: (0) deletion inventory + frame capture;
(1) provider + fixture; (2) bridge server + `tool_finished` emission; (3) tools directory + `houge-tools.ts`;
(4) `protected-paths.ts` + `seatbelt.ts` + `houge-policy.ts`; (5) shell tool R1–R9; (6) `PlannerSupervisor`,
detached turns, leases, tool approvals; (7) turn lifecycle → ledger + attribution + intake rules; (8) one-shot
seats rewired incl. chair; (9) deletions + env + `DISARM_FLAGS` + contract amendment; (10) ADR 0028 + amendments
+ docs; (11) live gate script. **Build:** `npm run build` = `tsc -p tsconfig.build.json && node
scripts/copy-omp-assets.mjs` (copies the wrapper to `dist/omp/`). **Ship order:** merge → build → pre-restart
smoke (`live-gate-omp.mjs --smoke`: cases 1, 3, 6, 13 against a temp copy of the DB, no Telegram poller, temp
bridge dir, throwaway session dir; the live daemon untouched) → `launchctl kickstart` → full live gate (Paco's
taps) → docs sync. **Rollback:** `git revert <merge>` + build + kickstart; previous `dist/` tarred to
`backups/dist-pre-omp.tgz` first; session dirs harmless; no data migration to reverse.

## 13. Seams for self-evolution v2 (built here, used by SP4)

1. **Tool directory, not a list.** A new capability = one JSON declaration under `src/omp/tools/` + one
   daemon-side adapter, both through the existing self-write pipeline. The declaration directory is not
   protected (it is data the daemon validates); `houge-tools.ts`, `houge-policy.ts` and every file the planner
   process executes are.
2. **Native skills.** `skill_author` writes `SKILL.md` dirs under `<data>/skills/<name>/`; the planner loads them
   through the profile's skill discovery (flag/mount resolved in the plan). `/skills` commands keep working over the same dir.
3. **Replay eval.** `scripts/eval-replay.mjs --turns 20` replays `evals/replay-set.json` (real turns rated ≥ 2)
   through the one-shot planner seat and scores 0–3 with a judge string; SP4 wires it into the self-write test gate.

Deferred to SP4: weakness-mining tick over the ledger → ranked proposals with evidence; prompt-section A/B.

## 14. Risks and residuals (recorded in ADR 0028)

- Yolo + in-process extensions + D11: a steered planner holds the daemon user's rights outside L1 and can read its
  own OAuth store through a hook bug. Mitigations: wall, L1, SP3 OS user.
- Local irreversibility (D5): destructive deletes are matched and ask; an overwrite through `edit`/`write`, or a
  delete the matcher misses, is not gated.
- **D12 residuals:** raw web bytes reach the planner through `bash`; **egress stays open** (network is allowed in
  both profiles), so any command the matcher misses can send non-secret data out without a tap. Both were
  recommended against and accepted by Paco on 2026-09-30.
- **Matcher misses (D12).** Floor B for `bash` is best effort. Known misses at ship: `dd`, `unlink`, `python3 -c` /
  `node -e` / `perl -e` deletes or uploads, ANSI-C `$'…'` quoting, spaced arithmetic `$(( a << 1 ))` next to a
  multi-line quoted message, an apostrophe inside nested double quotes in a `$()`, and `bash file.sh` (the script's
  body is not read). Covered since the final review: `bash|sh|zsh -<flags>c`, here-strings, `env -S`, a shell fed
  through a pipe, `<` redirect or process substitution (asks as an unseen script), `find -exec rm` / `-delete`,
  `git branch -D`, `git stash drop|clear`, git aliases, `curl --json|--request|--form|--upload-file`, `gh api`
  writes, `gh pr|issue|release|repo create|edit|merge|delete`, backslash-newline inside a word, and unterminated
  heredocs (ask).
- **D11 symlink race on `~/.omp`.** The gate canonicalises the path *string*; it does not open the file. A planner
  that swaps a symlink between the gate's check and omp's read could reach a file the check did not see. The
  exposure is limited to what the planner process can already read: its own `~/.omp` store (D11). SP3 closes it.
- **The dotfile denylist is incomplete by nature.** `HOME_CODE_CONFIG` lists the shell, terminal, git, editor, tmux
  and direnv files that run code; any other tool config under `$HOME` that executes code (for example under
  `~/Library/Application Support`) stays writable and fires only in Paco's own interactive tools. The structural fix
  is an allowlist of writable `$HOME` subtrees, or the SP3 OS user.
- **Signal deny is per process group.** Probed on macOS 15.7 (2026-10-01): `(deny signal (target others))` denies
  signals to processes outside the sender's process group. Every `bash` command runs in its own group (the wrapper is
  a detached group leader), so it cannot signal the daemon. The planner child is spawned in the daemon's group, so
  code inside the omp process itself could; omp exposes no signal tool to the model (its `bash` is the bridged one).
- **Binary dirs are resolved once** per supervisor; a relocated reinstall of omp or codex is covered after a
  daemon restart.
- **No step or repeated-denial cap.** The old inner loop's caps have no omp equivalent: tool calls are bounded by
  the contract budget, model requests and repeated denials only by the turn deadline and the frame watchdog.
- Anthropic may block Max OAuth in third-party clients → automatic fall to Opus 4.6; incident tells Paco.
- Antigravity's weekly ceiling on the shared Claude/GPT bucket; reader volume rides Gemini's bucket.
- omp moves fast: version pin + update checks off; frames re-captured on upgrade. Sequential-tool attribute name
  and `omp` config key semantics verified at build.
- k3 default thinking is verbose (525 tokens for "OK"): every k3 string carries `:low` except the reviewer.
- The `steer` merge means one reply answers two messages; the ledger records both runs, the user sees one message.

## 15. Review record

Codex design passes 1–13 (2026-09-30) found 10 + 7 + 7 + 2 + 2 + 1 + 1 + 1 + 1 + 1 + 3 + 2 + 2 blockers across
the approval channel, detached turns, bridge authority, built-in accounting, lease atomicity, family resolver,
version pin, wall-through-shell, Seatbelt rendering, lesson scopes, classifier consumers, audit identity, shell
cancellation and cleanup, status channel, build and hash chain; each was verified against the binary or the code
before it was closed. The whole-document self-review that produced this revision added: unbudgeted `fs_read`
and the raised cap, steered-run completion and schedule wait (§7.3), `HOUGE_OMP_CHAIR`, omp update checks off,
the per-child bridge directory in `OPERATIONAL_WRITE_DENY`, the `network` parameter in the model-facing
description, and the removal of the shell script from the spec in favour of requirements R1–R9, and (from Codex pass 13)
declarative JSON tool declarations so nothing self-writable executes inside the planner process. The final
pass (14) added: the capability map is code-owned, never declaration-controlled; steered runs are claimed so
`finishRun` applies and they fail with their parent; omp's skill flags are resolved in the plan. Paco's D12
decision (Claude Code posture) then replaced the network switch with the matcher and removed `shell-net.sb`.
