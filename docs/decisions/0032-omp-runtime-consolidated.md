# ADR 0032: omp runtime — agentic mode under code-owned floors (consolidated)

- **Status:** accepted 2026-11-05 (signed by Paco, rulings A1–A5 included); consolidates and supersedes
  [ADR 0028](0028-omp-runtime.md) with no change of meaning; amended 2026-11-10 by [ADR 0035](0035-grow-zone-verification.md) (grow zone: D8 tool set, 4.2, 4.3, 5.1, 6.3, 7.1 — signed by Paco 2026-11-10, spec approval)
- **Date:** 2026-11-04
- **Deciders:** Paco
- **Supersedes:** [ADR 0028](0028-omp-runtime.md) (which superseded the agentic clause of
  [ADR 0002](0002-pi-as-agent-runtime.md))
- **Amends (carried from 0028):** [0002](0002-pi-as-agent-runtime.md), [0010](0010-natural-language-intent-layer.md),
  [0013](0013-llm-inner-composition.md), [0014](0014-dual-llm-privilege-separation.md),
  [0015](0015-secrets-firewall.md), [0019](0019-metered-ceiling.md), [0022](0022-money-fork-reopened.md),
  [0023](0023-external-workspace.md), [0027](0027-idea-panel-claude-chair.md)

## Context

Houge picked pi as its agent and ran it with `--no-tools` (ADR 0002 "inference mode"), rebuilding a weaker loop on top
(ADR 0013's inner loop). The result was a safety harness with one real tool, and Paco saw that the tool limits were
holding Houge back (2026-09-09). ADR 0002 always named an agentic mode, gated on "V2 containment"; this is that mode:
the agent runs with real tools, inside containment Houge owns, on the strongest subscription model per seat. This is
sub-project 1 of 4 (SP2 Paco's personal tools; SP3 auth broker, OS-user isolation and the quota invariant; SP4
self-evolution v2).

This ADR consolidates ADR 0028 and its amendments (2026-10-02, 2026-10-07 ×2, 2026-10-09 ×2, 2026-10-12, 2026-10-21,
2026-11-02, 2026-11-03, plus those made from ADR 0029, 0030 and 0031) into one statement of today's rules.

## Decision

### 1. Runtime and shape

1.1 Every Telegram turn runs on an omp agent loop (`@oh-my-pi/pi-coding-agent`, an oh-my-pi fork) under its own profile
`houge`: one supervised omp RPC process per chat (the **planner**), plus one-shot omp spawns for every other seat.
The old inner loop, the intent classifier call, and the pi / kimi-api / gemini-api / claude-cli providers are deleted
in the same slice. Code keeps owning the gates; omp composes between them.
1.2 **Planner:** `sandbox-exec -f <data>/omp/planner.sb omp --profile houge --mode rpc`, built-ins `read,edit,write`
only (plus omp's todo tool, see ADR 0034 stage 2b-i), `--approval-mode yolo`, exactly one extension (1.4). Every Houge
tool, `bash` included, runs daemon-side through `CapabilityRunner` over a per-child Unix socket (the **bridge**) whose
authority (run, lease, contract, budget) is server-owned.
1.3 **One-shot seats** (reader, media photo, ticks, judges, chair, reviewer):
`omp --profile houge -p --mode json --no-session --no-tools --no-extensions --no-skills --no-rules`. **Writer:**
`codex exec --sandbox workspace-write`, unchanged. Model strings are `provider/model[:effort]`; seats name roles (§7).
1.4 **One extension entry.** The planner loads exactly one `-e <dist>/omp/extension/houge.js`, which installs the policy
hooks first, then registers the tool stubs (two entries got two copies of the shared `registered` set and blocked every
Houge tool). `houge.ts` is protected. A tool-registration failure keeps the policy hooks installed, so with the bridge
down `read`/`write` stay blocked.
1.5 **Manifest start check.** A planner counts as started only after the bridge served it a `manifest` request within
15 s; otherwise the child is stopped and `planner_start_failed` opens.
1.6 **Voice stays on agy-cli.** `spawnOneShot` refuses audio files (`OMP_AUDIO_REFUSED`): omp inlines Ogg bytes as text
and the model invents a transcript. Voice notes are transcribed on the flat-rate `agy-cli` leg (ADR 0019 permits it);
`agy-cli.ts` and its env resolvers (`HOUGE_AGY_BIN`, `HOUGE_AGY_MODEL`, `HOUGE_AGY_ENV_PASSTHROUGH`,
`HOUGE_LLM_MEDIA_PROVIDERS`, `HOUGE_LLM_TIMEOUT_MS_MEDIA`) survive D2 for that one purpose. The voice model is resolved
from `agy models` (highest Gemini Flash at low effort, cached, re-resolved once on a retired-model refusal), not
pinned. Photos run on the omp media seat. Follow-up: omp audio support, or local whisper (installed, but only a test
model is present).
1.7 **Seat routing.** `lesson_write` distill and reconcile run on the Tiny role. `/ask` and `/research` run on the planner chain (the routed planner roles since 2026-10-07), because they answer
Paco directly. (Amended 2026-11-10 by ADR 0035: `skill_author` authoring is gone; a skill's review runs on the `grow_review` role, 7.1.)

### 2. Locked decisions D1–D12

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | Runtime binary | **omp** under profile `houge`, no version pin (§8) | pi upstream; Hermes; Muse |
| D2 | Cutover | **hard**: old loop + pi/agy providers deleted in the same slice (`agy-cli.ts` survives for voice, 1.6) | flag-gated parallel path |
| D3 | Dual-LLM wall | **kept for the read tools** (`web_search`, `http_fetch`, `gmail_read`, `google_api`), enforced in the bridge, unconditional (§6.1); **shell output exempt** by D12 | drop; per-source trust |
| D4 | Conversation memory | **omp session owns the transcript**; Houge owns knowledge | stateless recomposition |
| D5 | Planner autonomy | **yolo under `$HOME`**: file read/write/edit and shell commands run without a prompt, **except external writes and destructive deletes** (matcher, §5.2). The tap-free local writes are conditional on the turn's trust level (`turn.trust`, ADR 0034) | workspace jail; approve-every-bash |
| D6 | Floors | (A) secret/protected paths denied at the OS level + policy hook (§5.1); (B) external effects wait for `/approve`: for `bash` a **best-effort, code-owned command matcher** (D12), for bridge tools the registry's `external_write` level | — |
| D7 | Models | subscription OAuth only; Claude via Anthropic Max OAuth **inside omp**, the model named by the code-owned roles resolved against omp's catalog (§7) (terms risk accepted; the fallback is each role's next code-owned leg, §7; `HOUGE_MODEL_ROLES=static` rolls back the model lists, it is not a way off Claude) | `claude -p`; metered API |
| D8 | Tool set | port 12 as bridge tools; delete `llm_answer` + the money track (5 tools). *Amended 2026-11-10 by ADR 0035: `skill_author` is out; `grow_submit` and `grow_read` are in (plain branch of the bridge, 6.3)* | port all 18 |
| D9 | Gmail | port with an `account` key designed in | rewrite later |
| D10 | Family collapse (planner and reader on one family after fallback) | **accept the degradation, audited** (Paco, 2026-09-30): the read proceeds; every such read writes a `wall_collapse` ledger event and opens/keeps an incident. In resolved mode the reader's candidates are ordered cross-family first (a stable partition), so collapse is avoided before the read, not discovered after it; the Reader role's GPT-family leg (`codex-sol`), after its Gemini and Kimi legs, makes collapse rare | fail closed |
| D11 | Floor A residual | **accepted** (Paco, 2026-09-30): the planner must read its own OAuth store (`~/.omp/profiles/houge`), so the OS sandbox cannot deny it to that process; the policy hook denies omp's `read` of it, and with D12 no shell runs inside that process. Revisited in SP3 (separate macOS user) | block yolo until SP3 |
| D12 | Shell = bridge tool, **Claude Code posture** (Paco, 2026-09-30) | omp's built-in `bash` is replaced by a bridge tool **registered under the same name** (an extension tool named `bash` supersedes the built-in). Commands run daemon-side under `sandbox-exec` with the floor-A file denies and the signal/launchctl denies, **network allowed**, output returned **raw** (capped at 32 KiB). Its network output is judged by `tool.injection` (ADR 0034). A steered planner can fetch hostile bytes through `bash` around the reader wall; ADR 0014 exempts shell output. Floor B for `bash` = the matcher (`git push`, `gh … create`, `curl\|wget\|http` with `-X POST\|PUT\|PATCH\|DELETE\|--data`, `mail\|sendmail`, `ssh\|scp\|rsync`, `npm publish`, `sudo`, `launchctl`, `crontab`, destructive deletes) → `/approve`; misses run — accepted residual | the Codex posture (network off by default, `network:true` = one tap, output quarantined) — rejected by Paco as too restrictive |

### 3. Threat model and layers

3.1 **Actors.** Paco (sole authorised user). The planner model (may be steered by a digest that survived the reader
wall, or by its own error). An extension (runs in-process with the model's OS rights, so `houge-policy.ts` is protected
code, never self-written). A same-user local process on the mini is **out of the threat model** (it can already read
`.env`).
3.2 **Assets, ordered.** (1) Secrets: `.env`, `houge.sqlite`, `~/.ssh`, `~/.gnupg`, `~/.pi`, `~/.claude`, `~/.codex`,
`~/.kimi*`, `~/.config/gcloud`, Keychains, `~/.omp/profiles/houge`; the full list as built is `HOME_SECRETS`. (2)
Houge's own operation: repo protected paths + `dist/`, daemon process, launchd, DB, sockets, profiles, the daemon's temp
space and self-write worktrees, and the binaries and config the daemon or Paco's shell later run unsandboxed. (3) Paco's
files under `$HOME`. (4) External side effects in Paco's name.

| Layer | Mechanism | Protects | Bypassable by a steered planner? |
|---|---|---|---|
| L0 | No secrets in any child env | provider keys, Telegram token | no |
| L1a | `planner.sb` around the planner: `(allow default)`, read+write deny on asset 1, write deny on asset 2, signal/launchctl denies; network allowed | assets 1–2 against omp's `read/edit/write` | no, except D11 |
| L1b | `shell.sb` around every shell command: L1a's denies; network allowed (D12; a network-denied variant stays a one-line change) | assets 1–2 (files and the daemon process) | no for files/process; **yes for egress and raw web bytes** (D12) |
| L2 | `houge-policy.ts` `tool_call` hook (fires for built-ins and bridge tools; `{block, reason}` stops the call and the model reads the reason) | tool allowlist by name; URL/`xd://`-shaped `read`; floor-A paths with a clean reason | no (code); path denies are defence in depth over L1a |
| L3 | The bridge: every Houge tool runs daemon-side through `CapabilityRunner` | contract, budget, wall, ledger for every tool incl. `bash` | no by the model (no adapter lives in the child) |
| L4 | `/approve` on `bash` commands the matcher classifies as external writes or destructive deletes, and on any `external_write` bridge tool | assets 3–4 | **yes**, by a command the matcher misses (D12); an overwrite through `edit`/`write` stays yolo (D5) |

3.3 **Hard line (b) "no secret leak"** is enforced by L0 + L1a/L1b for every secret except the planner's own OAuth store
(D11): secrets are unreadable; egress of *non-secret* data by a steered planner is possible without a tap (D12).
**Hard line (a) "no adverse impact to own operation"** is enforced by L1 write-denies on asset 2, signal and launchctl
denies, resource limits on every shell command, and the self-write pipeline for repo changes. Upgrade path: SP3's
dedicated macOS user for the planner.

### 4. Planner supervision

4.1 **Per-turn context is composed by the daemon.** It prepends a `[context]…[/context]` block to the RPC prompt and
writes `loop_started.applied_artifacts` at that moment (no `before_agent_start` hook; rating attribution unchanged).
4.2 **Lessons are composer-injected; skills are read through the grow zone.** (Amended 2026-11-10 by ADR 0035: skill
bodies no longer ride in the prompt. The composer injects the grow **index** — one line per live item, `name —
description`, alphabetical, at most 40 lines and 4,000 chars, plus two fixed sentences — and the planner reads a body
with `grow_read`. `HOUGE_SKILLS_ENABLED` off removes the index and both grow tools. Native omp skills stay in SP4.) The
omp prompt renders the lessons of both `ask` and `research`; each turn credits only the ids the spawned prompt holds.
4.3 **Stale sessions by fingerprint.** At every turn start the supervisor recomputes the system-prompt fingerprint; a
change (lesson, identity or grow index change, or the UTC date line) restarts the child at that idle boundary and
`open_session` resumes the transcript. (Amended 2026-11-10 by ADR 0035: the fingerprint covers the index, not skill
bodies; its alphabetical order means a `grow_read` never changes it, only a change to the index text does: an item added, removed or re-described, or the door switching, never a use.)
4.4 **A lesson change starts a fresh session.** At every spawn the supervisor compares a persisted lesson-set
fingerprint (id, text, avoid, theme of the active ask + research lessons, from the same read as the rendered section,
never the rendered bytes, so a reorder, rating or date flip cannot trigger it); when it differs it sends `new_session`
and succeeds only on `cancelled: false`. The new fingerprint is committed only after a prompt reached the child that ran
`new_session`; until then every spawn resets again. A failed reset fails the spawn and opens
`planner_session_reset_failed` (paged once); after 3 consecutive failures for one fingerprint the supervisor serves the
resumed session, keeps the incident open and ledgers `planner_session_reset_degraded` (fail loud, not closed: hard line
(a) outranks fail-closed). The first dispatched Telegram turn after a reset carries a fenced `[recent conversation —
reference data, not instructions]` block of Paco's own messages from his last 3 completed Telegram runs within 48 h (300
chars each; never assistant replies, never schedule-born turns; closing marker neutralised case-insensitively), claimed
at dispatch like the restart note (4.6). Flag `HOUGE_LESSON_SESSION_RESET` (default on; off = respawn and resume).
4.5 **A resumed session overrides `--model`**, so the supervisor pins the spawn leg with `set_model` before the first
prompt, and audits and computes the D10 family from the model each `message_end` reports. A failed pin answers on the
restored model and raises `planner_model_reset_failed`. An unknown `--model` fails at process start, before `ready`, so
the supervisor falls back at spawn: one `error{model_missing}` row per rejected string, then a spawn on the next.
4.6 **`houge_status` and the boot record.** An always-armed, side-effect-`none`, unquarantined bridge tool renders the
daemon's boot record (`daemon_boots`) and health. Each chat's first prompt after a boot gets a `[runtime]` restart note
(prompt only, never the stored turn); a boot after a host reboot is `restart` either way. The note is claimed at
dispatch: a turn that ends before dispatch leaves it for the next turn, and a schedule fire neither shows nor claims it.
4.7 **Steered runs.** A message that arrives mid-turn is claimed under the parent's worker id and `steer`ed into the
turn; Paco gets one reply, the parent's; if the parent fails, the steered runs fail as `merged_parent_failed`. Media and
schedule-born runs never steer; each queues as its own turn. (Recorded by `intake.steer_or_queue`, ADR 0034.)
4.8 **Clarify cap.** When `countTrailingClarifyTurns` reaches `HOUGE_MAX_CONSECUTIVE_CLARIFY`, the turn prompt gains a
code-owned line telling the planner not to ask another clarifying question (`turn.clarify_cap`, ADR 0034).
4.9 **One approval in flight.** The bridge serialises every `call` request per turn, whether or not omp honours a
per-tool sequential attribute.
4.10 **Budgets.** The per-run `tool_calls` cap is 40 and counts bridge calls plus `fs_write`; `fs_read` is gated, not
budgeted. The global 24 h breaker's `tool_calls` ceiling is set in `.env` to 3× its old value; the code default is
unchanged.
4.11 **Background ticks stop on shutdown.** Every model-backed tick the signal path runs (episodic distill and
consolidate, lesson consolidate, radar, panel, scheduled fires) takes the daemon's stop signal and
returns early between model calls. The one-shot seat kills an in-flight leg's process group and audits it as
`llm_attempt` error{`shutdown`}, as the planner does for a turn shutdown cuts; `llm_leg_failing` ignores only `shutdown`
rows, so a shutdown never opens an incident while `aborted` (a hung `frame_idle`/`turn_timeout` turn, a /kill, a
provider's own "aborted" error) still counts. A distill window makes every model call first, then writes facts,
watermark and ledger summary in one SQLite transaction (never held across an await); each reconcile sees an overlay
(store neighbours minus rows an earlier fact of the window claims, plus those earlier facts under negative ids), so a
row is superseded once (UPDATE takes the merged text, SUPERSEDE the newer candidate, DROP discards the newer one; core
is never dropped). The overlay means more reconcile calls per window (a later fact always has the earlier ones as
neighbours); accepted, since they run on the flat-rate ticks chain. A stopped tick: episodic consolidate skips its
remaining merges but still stamps; lesson consolidate leaves its latch unstamped; radar writes no tick (its latch
already stamped); panel writes nothing and restores its weekly latch. Distill
checks the stop before each embed too. (Amended 2026-11-10 by ADR 0035: the skill re-verify tick is deleted; it is no longer among these ticks.)

### 5. Floors as built

5.1 **Floor A.** (a) Writes are denied by default: allowed under `$HOME`, `/private/tmp` and the omp workspace only,
then denied again for the whole Houge repo, `dist/`, the `$HOME` binary install trees, the directories of the omp,
codex, agy and node binaries, and the dotfiles that make git, a shell, a terminal or an editor run code; `os.tmpdir()`
is not writable. The whole Houge repo is write-denied to the planner and to `bash`; the exceptions are
`<data>/omp/workspace`, plus `<data>/omp/sessions` for the planner process only. Repo changes go only through the
self-write pipeline (worktree → test gate → reviewer → Paco's merge tap). (b) Credential stores (`HOME_SECRETS`,
`~/Library/Keychains`, top-level `~/.<name>.env`) are read- and write-denied, and `/usr/bin/security` cannot exec; the
planner keeps `~/.omp` (D11). (c) The gate canonicalises every path the way omp resolves it (`@`, `:`, `~` forms,
`file://`, selectors, edit rename/hashline/apply_patch targets), denies if any resolution is denied, and refuses
`bad_path` on a form it does not model. (d) The workspace is pinned: its root, the sessions root and every `chat-<id>`
dir cannot be moved or replaced by a symlink, and the attachment adapter lstat-checks the chain and the realpath before
reading. (e) The daemon temp root is `~/Library/Caches/houge-daemon` (`HOUGE_DAEMON_TMP_DIR`), outside the repo, read-
and write-denied to every child (the sandboxed planner and `bash`; CLI children's TMPDIR is the `children/`
subdirectory); worktrees are `<data>/selfwrite`, write-denied. A temp root inside a git repo pages at boot and
disables voice ingest; agy never runs with a cwd in a git repo; a self-write diff is re-hashed before publish.
(f) Children get a private `TMPDIR`: `<workspace>/.tmp` for the planner and `bash`; `<daemon tmp>/children` for
one-shots, codex, agy and the catalog (beside `cleanroom/`, ADR 0034). (g) Daemon-side git runs without user or system
config, hooks or fsmonitor (push keeps the credential helper). (h) `sandbox-exec` and every wrapper helper run by
absolute path. (i) `ulimit -u` is the current user process count + 256, capped by the hard limit; the group kill, `-t`
and the adapter deadline still bound the command. (j) *Amended 2026-11-10 by ADR 0035:* the grow zone (`HOUGE_GROW_DIR`)
and the backup folder (`<repo>/backups`, `<data>/backups`) are **read- and write-denied** to every child, at both layers
(Seatbelt profile and policy hook path gate), as members of `secretPaths` placed after the `$HOME` allow in the profile
and before the workspace allow in `isDeniedWrite`. Read-denied because a shell `cat` of a born-untrusted skill would
read it without the taint `grow_read` applies; the backup folder holds the zone's bundle beside the DB snapshots (and
now closes a hole that predates the zone: `houge.sqlite` was read-denied while its nightly copies were not). The
planner writes the zone only through `grow_submit`.
5.2 **Matcher posture.** Patterns are anchored to command position. The line-wise safety pass never skips heredoc
bodies. A parse error or eval-depth overflow classifies the command as destructive (ask), never as plain. The matcher
recurses into `bash|sh|zsh -<flags>c`, here-strings, `env -S` and `find -exec`; a shell fed its script through a pipe,
a `<` redirect, a process substitution or an expanded here-string asks as an "unseen shell script"; git aliases,
`git branch -D`, `git stash drop|clear`, `curl --json|--request|--form|--upload-file`, `gh api` writes and
`gh pr|issue|release|repo create|edit|merge|delete` ask; a backslash-newline inside a word is deleted as bash does; an
unterminated heredoc asks.
5.3 **Approval card vs ledger.** The card shows the matcher label and the command, up to 3000 chars with an explicit
`…[truncated N chars]` marker, through egress redaction. The label lists every matched class, strictest first.
`approval_requested.action_summary` carries the labels only; command text lives in the notification outbox, never in
the audit ledger.

### 6. The wall on the bridge

6.1 The four read tools always cross `normalizeExternalRead`; `HOUGE_DUAL_LLM_ENABLED` is gone and
`gmail_read`/`google_api` arm on `HOUGE_GOOGLE_ENABLED` alone. The injection judge on wall-tool and shell output, and
turn trust, are ADR 0034's.
6.2 **omp's read text shape.** The secret mask's line-start rule accepts any non-letter run (up to 24 characters), so
omp's hashline header and `N:` line prefixes cannot hide a key. The bridge raises `omp_read_format_drift` once per omp
version on the first succeeded read whose text is not in the tested shape; the next conforming read resolves it. The
contract probe's child still runs with no tools. Verified when this landed: `fetch.enabled: false` makes a URL `read` an
error, and `rowPrefixes` is on whenever `edit` is among the tools.

6.3 **`grow_read` is a named exception to the read wall** (amended 2026-11-10 by ADR 0035; the precedent is
`houge_status` in 4.6). It reads kernel text that passed the grow door, so it is registered on the bridge's plain
branch (`PLAIN_TEXT_ENTRIES`), never on the wall (`UNTRUSTED_READ_ENTRIES`) or judged-read branches, and is not judged
for injection. For a skill born from outside content it raises the turn to `untrusted` before the text returns (cause
`grow_read_untrusted`, ADR 0034 8.1, 8.3). `grow_submit` takes the same plain branch; its content is checked at the
door, not on the wall.

### 7. Model roles and tiers

7.1 **Roles.** Paco's rule (2026-11-02): always use the latest model under his subscriptions; tiers are how code
follows it. Each seat names a role (Fast, Default, Thinking, Reader, Vision, Tiny, Judges, Chair, Reviewer, GrowReview). *Amended 2026-11-10 by ADR 0035:* `grow_review` is the role of the asynchronous skill reviewer — a one-shot seat with no tools and three legs (Kimi, Gemini pro, Codex; the static rollback list holds Kimi and Codex), none of the Claude family that runs the planner; the legs of a family the item's author used are skipped. Each
role is a code-owned list of `{tier, effort}` legs in `src/omp/model-roles.ts`; a leg resolves to its tier's adopted
head, then its previous adopted head. The seven `HOUGE_OMP_*` chain variables are retired: a set value is ignored and
named once in a boot warning. Model names change with the catalog, without an ADR amendment.
7.2 **Tiers.** A tier is a provider plus an anchored pattern over the catalog `id`, one capture group per version
segment (`opus@anthropic`, `opus@antigravity`, `sonnet@anthropic`, `sonnet@antigravity`, `gemini-flash`, `gemini-pro`,
`codex-sol`, `kimi`). Versions compare segment by segment as integers; a dated snapshot, `-lite`, `-highspeed`, `-256k`
or a preview matches none. Kimi's tier counts `-pro` (`k3.1-pro` over `k3`). `gemini-pro` accepts `gemini-N(.M)-<word>`
except `GEMINI_NOT_PRO` (flash, flashlite, lite, preview, image, audio, tts, live, embedding, nano, vision), so a renamed
Gemini id (`gemini-4-argon`) joins the tier and, like any move, is adopted after the probe with no tap. A different
family inside a tier is Paco's call, through `/models`, never a code edit.
7.3 **A new head is adopted only after a probe:** a one-leg call through the one-shot seat (`--no-session --no-tools`,
the seat's env and TMPDIR). A pass adopts it and keeps the old head as `previous`. `model_missing` keeps the tier and
is not probed again for 7 days; any other failure is inconclusive and the next tick probes again. A catalog listing
never adopts a model (the catalog is not the subscription); a catalog outage changes nothing. State: `model_tiers`;
outcomes: `model_probe` ledger rows.
7.4 **Resolution** reads `omp --profile houge models --json` at boot, by a daily tick and on `/models set`. Order: the
provider allow-list (`anthropic`, `google-antigravity`, `kimi-code`, `openai-codex`), chat seats never take
`openai-codex`, then Paco's override, then the role (selectors the catalog lists only), then the per-child refused set.
The catalog is the authority over any doc. Routed effort is clamped to the model's catalogued thinking levels (nearest,
ties up; none for a model without levels). Kimi legs carry a low effort except on Thinking and Reviewer.
7.5 **Overrides.** `/models` overrides are append-only `model_role_override` ledger rows read at each resolution (no
restart); judges are overridden one seat at a time. An override is card-written when its latest row carries
`via: "tap"`, or (older rows) the run-less ledger row just before it is the tap's passing probe; `/models set` writes
`via: "set"`. When the tier's head is that model or newer, the tick writes a reset row (actor `houge:tier`) and a log
line before resolving roles. A `/models set` override is never retired.
7.6 **An empty tier asks Paco.** The tick opens the alerted incident `role_unresolved` (pages) when a role has no
candidate. The daily tick sends one tap card per empty tier whose provider the catalog still lists and whose roles have no other head, proposing up to three same-provider, same-family
(`claude-`, `gemini-`, `gpt-`, `k`+digit) ids that match no tier (previews and `-lite` excluded; `gpt-oss-120b` is never
offered for a Gemini seat), highest output price first. A tap probes first and writes the override only on a pass, in
the probe's transaction. Silence leaves `role_unresolved` open and the daily reminder repeats it (ADR 0034). Outside the
tier patterns, code never adopts a codename without a tap: an id the pattern does not accept, a Gemini one included,
still asks Paco with a card.
7.7 **Notices.** Each tier move is one `model_change` log row (ADR 0031); failed-check and shadow lines are log rows too.
7.8 **Judge seats** resolve to the tier's adopted head, never a chain; the fallback moves between panel runs and never
inside one (ADR 0027's single-model seats and binding unchanged). When an adopted judge head leaves the catalog, the
daily tick moves the tier to its previous adopted head, already probed.
7.9 **The planner has two axes.** It spawns on Default's candidates and pins each turn to its routed role's candidates
(`set_model` plus `set_thinking_level`; routing by Jev, ADR 0033), walks the list at the retry boundary, and steps up
(Fast → Default → Thinking) on `quota`, `auth`, `transport`, `timeout` and `model_missing`, plus `other` once while no
bridge tool has executed. Step-up skips selectors that already failed this turn with a non-`other` error. A pin refused
with `model_missing` disables step-up for that turn (`pin_failed`). The ledger row is `routed_escalation`. If Anthropic
blocks Max OAuth in third-party clients, the planner walks to the next candidate and an incident tells Paco.
7.10 **Rollback `HOUGE_MODEL_ROLES=static|resolved`** (default `resolved`). Static is catalog-free: no catalog, no
override, no tick; lists re-pinned to the seeded heads; judge seat 2 empty (filled by a code re-pin after Paco's
tap). It keeps the per-child refused set, has no respawn onto the planner head (`set_model` moves the live child),
and while Jev is on a routed turn may step up a role and retry `other` once. The resolved-mode tick checks every
static selector against the catalog and opens `static_list_stale` for a missing one. A unit test pins that every
static selector matches its role's tier patterns.

### 8. omp version and contract

8.1 **No runtime version pins**, and no version strings in this ADR's decision text (dated evidence keeps the version it
ran on). Any version `omp --version` reports runs; only an omp that cannot run or prints no `x.y.z` refuses
(`omp_unavailable`). Update checks are off.
8.2 **`omp --version` runs once per binary**, awaited asynchronously on the spawn path: a per-process cache keyed on the
binary's real path, mtime, size and inode; a changed binary is re-checked; a failed check is never cached. Refusal
reasons carry codes only, never provider text; a stop during the check cancels the start. A one-shot whose check refuses
returns `unavailable` without an audit row, because no leg ran; the caller opens the incident. A legacy open
`omp_version_mismatch` row resolves at the first passing check.
8.3 **Contract probe** whenever the omp version in use has no passing probe on record: throwaway planner children (same
argv and Seatbelt profile, no tools, no bridge, throwaway dirs) check the catalog, the start refusal, the session open,
the pin refusal, the effort change, `new_session`, and one tiny real prompt on the Tiny role. Outcome codes are fixed
strings; omp's text is never kept. A provider condition or timeout is inconclusive, never drift. Only a pass is final;
after a fail or inconclusive run the next boot probes again. `houge omp probe` runs it by hand;
`scripts/live-gate-omp.mjs --smoke` stays the manual deeper check after an upgrade.
8.4 **Drift is logged, and Houge keeps running.** A failed check opens `omp_contract_drift`, routed to the log (ADR
0031) and reminded in chat after 7 days open; `omp_read_format_drift` (6.2) goes to the log. No spawn is blocked or
downgraded. A spawn that fails pages through `omp_unavailable` / `planner_start_failed`.

### 9. Memory rules carried by this ADR

9.1 **Self-service memory correction.** `memory_correct` searches ACTIVE facts or wiki pages (keyword and substring hits,
plus embedding rows with cosine ≥ 0.55 and within 0.10 of the best) ungated. Retire, and correct (facts only), are a
separate `memory_correct_write` capability in the gated `destructive` class: every write waits for Paco's Approve tap on
a card showing each id's current text and the full new text. Before any card, code refuses a write that is not on
Paco's own Telegram turn, follows any step other than `memory_correct`, `houge_status` or `to_local_time` in the same
run, names an id this turn's search did not offer, or passes more than 5 ids per call or would take the turn past 10 changed rows (recorded by
`memory.correct_preflight`, ADR 0034). A correction is one normal (never core) fact of at most 200 characters. Each
change is a `memory_changes` row with an Undo button; Undo restores only what is still as the change left it, says
exactly that, and refuses a correct that consolidation has moved on. The ledger (`memory_corrected`) holds ids and
counts, never text. `/memories` and `/forget_memory <id>` (alias `/forget-memory`) are the control-plane twins.
9.2 **Schedule-born turns are not Paco speaking.** Every consumer that treats user turns as Paco's words checks
`runs.source = 'schedule'`, never the text. `lesson_write` inside a scheduled run is refused in code before any LLM
call; its thread scan skips schedule-born user turns; episodic distill drops both turns of a scheduled run while its
watermark moves past them. Storage, the planner prompt and its chat history are unchanged.
9.3 **Talk about Houge is not a fact about Paco.** Distill drops both turns of a run whose loop used
`self_write_propose`, `self_diagnose` or `memory_correct_write` (read from its `loop_step` capabilities, never the text;
a `memory_correct` search alone is kept), plus any turn recorded while such a run was active (its first chat turn to the
later of its last chat turn and last `loop_step`; never `runs.updated_at`). The window stops at the first turn of an
unsettled run. The extract prompt refuses facts about the assistant's code, fixes, reviews, memory edits, task
progress, or Paco's instructions about how its code, checks, memory or lessons should work.

### 10. Accepted residuals

- Yolo + in-process extensions + D11: a steered planner holds the daemon user's rights outside L1 and can read its own
  OAuth store through a hook bug; the D11 gate canonicalises the path but does not open it, so a symlink swapped on
  `~/.omp` between check and read is not seen. Mitigations: the wall, L1, SP3.
- Local irreversibility (D5): an overwrite through `edit`/`write`, or a delete the matcher misses, is not gated.
- D12: raw web bytes reach the planner through `bash`, and egress stays open, so a command the matcher misses can send
  non-secret data out without a tap (accepted by Paco 2026-09-30 against the recommendation). Known matcher misses:
  `dd`, `unlink`, `python3 -c` / `node -e` / `perl -e` deletes or uploads, ANSI-C `$'…'` quoting, spaced arithmetic
  `$(( a << 1 ))` next to a multi-line quoted message, an apostrophe inside nested double quotes in a `$()`, and
  `bash file.sh` (the script body is not read). Floor A and the sandbox hold regardless.
- Cumulative disk fill across commands (detected by the `disk_free_low` sweep invariant on the 12 h cadence, not
  limited); CPU contention inside the `nice` band; a command that calls `setsid` outlives its call (CPU-bounded only).
- The dotfile denylist is incomplete by nature (code-running configs not listed, e.g. under
  `~/Library/Application Support`, stay writable); the structural fix is a writable-subtree allowlist, or SP3.
- Signal deny is per process group: `bash` commands run in their own group and cannot signal the daemon; the planner
  shares the daemon's group, and omp gives the model no signal tool. Binary dirs are resolved once per supervisor.
- No step or repeated-denial cap: tool calls are bounded by the contract budget; model requests and repeated denials
  only by the turn deadline and the frame watchdog.
- A bridge `call` dropped mid-flight leaves no row (follow-up: `handleCall` writes `tool_started`).
- Antigravity's weekly ceiling covers a shared Claude/GPT bucket; reader volume rides Gemini's bucket.
- A `steer` merge means one reply answers two messages; the ledger records both runs.
- Boot record: `kickstart` means any clean stop with the host up; a SIGKILL stop with the host up reads as
  `crash_recovery`.
- Memory correction: wiki pages are global, so any allowlisted chat may retire one (L4); a change's rows are written
  before its Undo card is queued, so a card that fails to queue leaves the change in place (L5). Talk-about-Houge's
  prompt guard varies run to run. Shutdown: one in-flight radar fetch (≤ 8 s) or Ollama embed (≤ 5 s) is still awaited.
- Model roles: `chains().judges[2]` is `undefined` when seat 2 is empty while `seatChain` types it `ModelString[]`; the
  only judge-role caller passes an explicit chain through `judgeSeat`, which returns `[]`. Retyping is a follow-up.
- omp drift that degrades answers without failing a spawn is seen in `/status` until the 7-day reminder.

## Consequences

- Houge reads, edits and runs things on the mini in one turn, with a transcript that survives restarts. A new
  capability is one JSON tool declaration plus one daemon-side adapter.
- The AGENTS.md invariant "Claude is never in the runtime … (pi, agy, codex)" was changed by ADR 0028. Claude is the
  default planner under D7, the panel chair is an omp seat on the Chair role, and every seat is subscription OAuth.
- Deleted (commit `3aabc04`): the inner loop, the tool manifest, the classifier call, the pi / kimi-api / gemini-api /
  openai-compat / cli-spawn providers, `llm-answer.ts` and the money-track code. Tables and historical ledger rows stay.
- Operator surface: four subscription logins under `omp --profile houge login <provider>` (Anthropic Max, Google
  Antigravity, Kimi Code, OpenAI Codex); the Kimi env pair (`KIMI_CODE_OAUTH_HOST`, `KIMI_CODE_BASE_URL`) passes through
  `HOUGE_OMP_ENV_PASSTHROUGH`. After an omp upgrade, smoke the new binary (`live-gate-omp.mjs --smoke`).
- Verification: `scripts/live-gate-omp.mjs` (case 3 must show a `bash` row; two `model_refusal`s make the gate
  INCONCLUSIVE, exit 4, never PASS) and `scripts/eval-replay.mjs`. The S12 and D12 probes (case 8) are run by hand.

## Alternatives considered

- **pi upstream with tools on:** lacks the extension-tool supersession and RPC session resume omp has.
- **Hermes or Muse:** both would replace Houge's harness instead of running inside it.
- **Flag-gated parallel path:** doubles every contract and test for a loop being retired; the old path would rot.
- **Workspace jail or approve-every-bash:** repeats the tool starvation this ADR exists to end.
- **The Codex shell posture:** recommended by the review, rejected by Paco as too restrictive (D12).
- **`claude -p` or a metered API for Opus:** rejected for subscription OAuth inside omp (D7).
- **Exact version lists for models** (2026-10-07 to 2026-11-02): broke Houge four times; tiers replaced them.

## History

| date | what changed | spec link | signed by Paco on |
|---|---|---|---|
| 2026-09-30 | ADR 0028: omp runtime, D1–D12, L0–L4, build decisions 1–18 | [omp runtime](../superpowers/specs/2026-09-30-omp-runtime-design.md) | 2026-09-30 |
| 2026-10-02 | Memory A1 lesson-change reset (4.4); `houge_status`/boot record, memory correction, schedule-born turns, Houge-talk, shutdown (4.6, 4.11, 9.x); `set_model` pin (4.5) | [memory A1](../superpowers/specs/2026-10-02-memory-a1-fixes-design.md) | date not recorded |
| 2026-10-06 | ADR 0029 amends D10 (reader cross-family) and per-turn planner chain; restated in form by the 10-07 roles (7.9, D10) | [Jev System One](../superpowers/specs/2026-10-04-jev-system-one-design.md) | per ADR 0029 |
| 2026-10-07 | No version pins: `HOUGE_OMP_VERSION(_ALLOW)` removed; voice model from `agy models` (8.1, 1.6); changed build decision 14 | — | Paco's rule (date not recorded) |
| 2026-10-07 | Model roles: `HOUGE_OMP_*` retired, catalog resolution, `/models`, static rollback, two-axis planner, D10 skip rule, async version check | [Jev decision tree §4](../superpowers/specs/2026-10-06-jev-decision-tree-design.md) | 2026-10-09 |
| 2026-10-09 | No version strings in the decision text (8.1) | — | Paco's rule (date not recorded) |
| 2026-10-09 | Contract probe; `omp --version` once per binary (8.2, 8.3) | [contract probe](../superpowers/specs/2026-10-09-omp-contract-probe-design.md) | Paco's rule (date not recorded) |
| 2026-10-12 | ADR 0030: D5 conditional on `turn.trust`; D12 shell output judged by `tool.injection` | [decision ladder](../superpowers/specs/2026-10-12-decision-ladder-design.md) | 2026-10-12 |
| 2026-10-21 | omp read text shape: mask line-start rule, `omp_read_format_drift` (6.2); omp's todo tool on the planner (1.2, ADR 0030 2b-i) | [ladder 2b-i](../superpowers/specs/2026-10-19-ladder-2b-hooks-settle-design.md) | 2026-10-22 |
| 2026-10-28 | ADR 0030 clean-room: one-shots, codex, agy, catalog TMPDIR moved to `<daemon tmp>/children` (5.1 f) | [clean-room slice 1](../superpowers/specs/2026-10-28-ladder-cleanroom-runtime-slice1-design.md) | 2026-10-30 |
| 2026-11-02 | Tiers replace version lists; probe before adoption; judge fallback between runs; empty-tier card; static re-pinned (`gpt-5.5` → `gpt-6.1-sol`, judge seat 2 empty), `static_list_stale` | [loud degradation](../superpowers/specs/2026-11-02-loud-degradation-design.md) | 2026-11-04 |
| 2026-11-03 | ADR 0031: gemini-pro reads renames; in-family card proposals; `model_change` log rows; card-tap overrides retire; omp drift kinds to log, 7-day reminder (changed "drift pages") | [chat is for Paco](../superpowers/specs/2026-11-03-chat-is-for-paco-design.md) | 2026-11-04 |
| 2026-11-04 | Consolidated into this ADR, no change of meaning | — | 2026-11-05 |
| 2026-11-06 | Drift rewording, no change of meaning: D7 fallback, D10 reader legs, memory-correct limits, empty-tier card conditions | — | 2026-11-06 |
| 2026-11-10 | Grow zone: D8 (`skill_author` out, `grow_submit`/`grow_read` in); 1.7; 4.2 and 4.3 (the index, not bodies, in the prompt and fingerprint); 5.1 (j) (grow zone and backups read- and write-denied); 6.3 (`grow_read` named exception); 7.1 (role `grow_review`) | [grow zone](../superpowers/specs/2026-11-10-grow-zone-verification-design.md) (Rev 1.3.2) | 2026-11-10 (spec approval) |

## Reference map

| ADR 0028 locator | here |
|---|---|
| D1–D12 (incl. "D6-B" = D6 floor B, "D6/L4") | §2, same ids; L4 in §3 |
| L0, L1a, L1b, L2, L3, L4; "Stated for ADR 0028", hard line (a)/(b) | §3 table; 3.3 |
| Threat model actors / assets (spec §3) | 3.1, 3.2 |
| Shape | 1.2, 1.3 |
| Build decision 1 (one extension) / 2 (manifest) | 1.4 / 1.5 |
| Build decision 3 (repo write-denied); "decisions 3, 18" | 5.1 (a); 5.1 |
| Build decisions 4 / 5 / 6 ("4–6") | 4.1 / 4.2 / 4.3 |
| Build decision 7 (`ulimit -u`) | 5.1 (i) |
| Build decision 8 (matcher) / 9 (card vs ledger) | 5.2 / 5.3 |
| Build decision 10 ("build 10", one approval) / 11 (clarify cap) | 4.9 / 4.8 |
| Build decision 12 (seat routing) / 13 (steered runs) | 1.7 / 4.7 |
| Build decision 14 (version drift; unknown model at spawn) | 8.2 (legacy row); 4.5 |
| Build decision 15 (wall unconditional) / 16 (voice, "decision 16") | 6.1 / 1.6 |
| Build decision 17 (budgets) / 18 (floor A, "decision 18") | 4.10 / 5.1 |
| Amendment 2026-10-07 no pins; 2026-10-09 no version strings | 8.1; 1.6 |
| Model-roles amendment 2026-10-07 | 7.1, 7.4, 7.5, 7.9, 7.10, D10, 8.2 |
| Amendment 2026-10-09 contract probe | 8.2, 8.3, 8.4 |
| Amendment 2026-10-12 decision ladder | D5, D12 |
| Amendment 2026-11-02 tiers | 7.2, 7.3, 7.6, 7.8, 7.10, §10 |
| Amendment 2026-11-03 chat is for Paco | 7.2, 7.5, 7.6, 7.7, 8.4 |
| Residuals ("ADR 0028 residual(s)"; "0028-*.md:239–241" matcher misses) | §10 (matcher misses: D12 bullet) |
| "l.259" (Kimi verbosity) / "l.263" (resumed session overrides `--model`) | 7.4 last sentence / 4.5 |
| "0028:265" (read format drift "pages once per omp version") / "0028:361" (drift pages) | 6.2, 8.4 / 8.4 |
| Memory A1 (2026-10-02) | 4.4 |
| `houge_status`, memory correction, schedule-born, Houge-talk, shutdown (2026-10-02) | 4.6, 9.1, 9.2, 9.3, 4.11 |
| Resumed session overrides `--model` | 4.5 |
| ROADMAP.md "Follow-ups recorded in ADR 0028" (voice on omp or local whisper; `tool_started`; matcher misses) | 1.6 last sentence; §10 bridge-call bullet; §10 D12 bullet |
| Spec 2026-11-03 l.329 "ADR 0028: §6.1, §6.3, §6.4" | those § numbers are the spec's own; ADR 0028 had no numbered sections. The content is 7.2, 7.5–7.7, 8.4 |
