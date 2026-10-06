# Configuration reference

Every Houge configuration parameter, its default, and what it does. This is the
canonical catalog — `.env.example` is the terse copy-paste template, this is the
explained version, and the README only links here.

**How configuration is loaded** (`src/config/load-env.ts`): the CLI reads
`<cwd>/.env` at startup (or the file named by `HOUGE_ENV_FILE`). **Real environment
variables take precedence over the file.** `.env` is gitignored.

**Resolution order for a given setting:** explicit request value → per-provider env
var → general env var → code default. Secrets are env-only and never written to
reports, memory, logs, or chat.

To share one `.env` across git worktrees, point each at an absolute path:
`set -x HOUGE_ENV_FILE /Users/pluo/Projects/adventure/.env`.

---

## Telegram

Required for `houge telegram-poll --once` (and the Milestone 3 daemon).

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `HOUGE_TELEGRAM_BOT_TOKEN` | — | yes | Bot token from @BotFather. |
| `HOUGE_TELEGRAM_USER_ID` | — | yes | Your numeric Telegram user id (e.g. from @userinfobot). The intake allowlist binds to it. |
| `HOUGE_TELEGRAM_CHAT_ID` | — | yes | Numeric chat id. For a 1:1 chat with your bot this equals your user id. |

## Always-on daemon

`houge telegram-poll` (no `--once`) runs the continuous long-poll daemon. Design
and rationale: [ADR 0004](../decisions/0004-long-poll-daemon.md). Deployment under
launchd: [deploy/launchd/README.md](../../deploy/launchd/README.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_TELEGRAM_LONGPOLL_TIMEOUT_S` | `30` | Telegram `getUpdates` long-poll timeout (seconds). The daemon blocks on a held connection for up to this long; a message arriving sooner is delivered immediately. Not your message latency — just how long an *idle* connection is held. |
| `HOUGE_DAEMON_BACKOFF_BASE_MS` | `1000` | Base delay for exponential backoff after a Telegram error (`base · 2^(failures-1)`). |
| `HOUGE_DAEMON_BACKOFF_MAX_MS` | `60000` | Cap on the backoff delay. |
| `HOUGE_DAEMON_TMP_DIR` | `~/Library/Caches/houge-daemon` | The daemon's temp root (media downloads, codex out-files, agy workdirs). Must be absolute (a relative value falls back to the default). Created and kept at 0700; both Seatbelt profiles read- and write-deny it. It must sit outside any git repo: at boot an ancestor holding `.git` raises the `daemon_tmp_in_git_repo` incident (one alert) and voice ingest refuses with the code-owned "media ingest is off" reply, because agy may root file access at the repo's top level (`.env` included). Never `<repo>/tmp`. |
| `HOUGE_DAEMON_LOCK_PATH` | `houge.daemon.lock` (cwd) | PID lockfile for the single-instance guard; a second daemon with the same lock exits instead of fighting over the Telegram long-poll (which would cause HTTP 409). |

## LLM runtime — omp (ADR 0028)

Every LLM call runs on **omp** (`@oh-my-pi/pi-coding-agent`), pinned at `18.4.4` and run under its own
profile `houge` on subscription OAuth only ([ADR 0028](../decisions/0028-omp-runtime.md)). Each Telegram
chat gets one supervised omp RPC process, the **planner**: sandboxed, with the built-ins `read,edit,write`
and Houge's tools served through the bridge. Every other seat (reader, photo, ticks, judges, chair,
reviewer) is a one-shot spawn (`-p --mode json --no-session --no-tools --no-extensions`). The self-write
writer stays `codex exec`, and voice notes stay on `agy-cli` ([below](#voice-leg--agy-cli-voice-only)).

**Model strings** have the form `provider/model[:effort]`, where effort is
`off|minimal|low|medium|high|xhigh|max`. A seat variable is a comma-separated, ordered chain. On
`quota`, `auth`, `transport`, `timeout` or `model_missing`, the next string serves: the planner switches
with a live `set_model`, and a later turn retries the top string. `model_refusal` and `other` are final.
Judges take one string per seat index and never fall back.

**Pinned in tests (ROADMAP §3.5).** Every variable below is saved, deleted and restored around each suite
that builds a worker, the daemon, or `resolveOmpConfig(process.env)` (`pinOmpEnv`,
`tests/helpers/omp-env.ts`). `HOUGE_OMP_BIN` is then pointed at a non-executable path, so no suite can
reach a real omp. The defaults below are copied from `src/omp/omp-config.ts`.

| Variable | Default | Purpose | Pinned in tests |
|----------|---------|---------|-----------------|
| `HOUGE_OMP_BIN` | `omp` | The omp binary. Give the daemon an absolute path, because launchd runs it on a restricted PATH. | yes |
| `HOUGE_OMP_PROFILE` | `houge` | `--profile` for every spawn; never the default profile. The OAuth store lives at `~/.omp/profiles/houge`, which is a secret path ([ADR 0015 amendment](../decisions/0015-secrets-firewall.md)). | yes |
| `HOUGE_OMP_SANDBOX` | `1` | `0` runs the planner without `sandbox-exec` (tests only). With `1`, a missing `sandbox-exec` or a profile that fails to render stops the planner and opens incident `sandbox_unavailable`. | yes |
| `HOUGE_OMP_VERSION` | `18.4.4` | `omp --version` must equal this at every planner and one-shot start, or the spawn is refused (incident `omp_version_mismatch`, resolved by the next passing check). | yes |
| `HOUGE_OMP_VERSION_ALLOW` | *(empty)* | Comma-separated extra versions to accept. This is the operator's logged override, set only after `HOUGE_OMP_VERSION=<new> … scripts/live-gate-omp.mjs --smoke` passes on the new binary. | yes |
| `HOUGE_OMP_PLANNER` | `anthropic/claude-opus-5-5:medium,google-antigravity/claude-opus-4-6:medium,kimi-code/k3:low` | The per-chat planner chain. When every string is exhausted on a retryable error, the turn fails `no_planner_leg` and an incident opens. `/ask`, `/research` and `skill_author` authoring also use this chain. | yes |
| `HOUGE_OMP_READER` | `google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low,openai-codex/gpt-5.5:low` | The quarantined reader for `web_search`, `http_fetch`, `gmail_read` and `google_api` ([ADR 0014](../decisions/0014-dual-llm-privilege-separation.md)). Keep it cross-family from the planner. A same-family read still proceeds, but it is audited: the row gets `family_collapse`, a `wall_collapse` event is written, and incident `wall_collapsed` opens (D10). | yes |
| `HOUGE_OMP_MEDIA` | `google-antigravity/gemini-3.8-flash:low` | The photo seat: the image is passed as `@file` and the call is audited as `reader`. Voice never uses omp. | yes |
| `HOUGE_OMP_TICKS` | `kimi-code/k3:low` | Memory and background seats: distill, consolidate, extract, attribution, frame, verify, and `lesson_write`'s distill and reconcile. | yes |
| `HOUGE_OMP_JUDGES` | `kimi-code/k3,openai-codex/gpt-5.5,google-antigravity/gemini-3.1-pro` | Idea-panel judges, one string per seat index, with no fallback (quorum 2, [ADR 0027](../decisions/0027-idea-panel-claude-chair.md)). | yes |
| `HOUGE_OMP_CHAIR` | `anthropic/claude-opus-5-5:low` | The idea-panel chair, which replaces the claude-CLI chair. If it is unavailable, the panel uses the deterministic mean-score fallback. | yes |
| `HOUGE_OMP_REVIEWER` | `kimi-code/k3:high,google-antigravity/claude-opus-4-6:medium` | Self-write checker 3 when `HOUGE_SELFWRITE_REVIEWER` is `omp` (the default). A gpt-family string here logs the writer≠checker warning, because the writer is codex. | yes |
| `HOUGE_OMP_ENV_PASSTHROUGH` | `KIMI_CODE_OAUTH_HOST,KIMI_CODE_BASE_URL` | Extra env var **names** passed to every omp child, on top of `PATH HOME TERM LANG USER`. The default is the Kimi pair, kept for token refresh against kimi.ai. Never list a secret here. | yes |
| `HOUGE_OMP_TURN_TIMEOUT_MS` | `600000` | The turn deadline, paused while a card awaits `/approve`. Expiry writes `loop_halted{turn_timeout}` and sends the partial answer. | yes |
| `HOUGE_OMP_FRAME_IDLE_MS` | `180000` | Watchdog: no omp frame and no bridge activity for this long while a turn runs → abort (`frame_idle`). | yes |
| `HOUGE_OMP_APPROVAL_TIMEOUT_MS` | `1800000` | How long an in-turn approval card waits. On expiry the call is refused (`approval_expired`); the planner is told and continues. | yes |
| `HOUGE_OMP_ONESHOT_TIMEOUT_MS` | `120000` | Per-leg wall clock for one-shot seats, enforced with SIGKILL. A seat's runner cap is legs × this + 15 s. | yes |
| `HOUGE_OMP_IDLE_EXIT_MS` | `3600000` | An idle planner child exits after this long. The next message restarts it and resumes the session. | yes |
| `HOUGE_OMP_SHELL_TIMEOUT_MS` | `120000` | Deadline for one `bash` command; the adapter kills the process group. The runner's cap is this + 5 s. | yes |
| `HOUGE_OMP_LEASE_TTL_S` | `120` | The planner's run lease, renewed every 30 s (also while awaiting approval). An expired `planner:*` lease is failed, never requeued. Minimum 90 (3× the heartbeat): a lower value is rejected as `omp_config_invalid`, because the recovery timer would fail live turns between renewals. | yes |

Set by the daemon, not operator config: `HOUGE_BRIDGE_SOCK` and `HOUGE_BRIDGE_TOKEN` are minted per
planner child, and `HOUGE_SHELL_SANDBOX` is the shell wrapper's copy of `HOUGE_OMP_SANDBOX`. `TMPDIR` is
set for every child: `<workspace>/.tmp` for the planner and each `bash` command, the daemon temp root for
one-shots, codex and agy. The Seatbelt profiles deny `os.tmpdir()` (`/private/var/folders`), so a child never writes
where the daemon later reads. The daemon's own temp space (media downloads, codex out-files, agy workdirs) is the
daemon temp root below, outside the repo; self-write worktrees live in `<data>/selfwrite` (git by design; `<data>`
is the directory holding `houge.sqlite`, gitignored, write-denied to every sandboxed child; ADR 0028, decision 18).
`HOUGE_CONFIG_YML` is not an environment variable: it is the name of the code constant
(`src/omp/planner-supervisor.ts`) holding the profile config the daemon writes to
`<data>/omp/houge-config.yml` (`tools.xdev: false`, `startup.checkUpdate: false`,
`marketplace.autoUpdate: false`, `telemetry.otlpExportEnabled: false`). There is nothing to set.

**Subscriptions.** Four OAuth logins live in the `houge` profile. Run each once on the mini with
`omp --profile houge login <provider>`, for `anthropic` (Claude Max), `google-antigravity`, `kimi-code`
and `openai-codex`. Every omp row has `cost_usd` 0 (shown as "sub" in `/usage`).

**Moving the version pin.** Install the new omp, then smoke it with the pin overridden for that run
only: `HOUGE_OMP_VERSION=<new> HOUGE_ENV_FILE=/abs/path/.env node scripts/live-gate-omp.mjs --smoke`.
Only when it passes, set `HOUGE_OMP_VERSION=<new>` in `.env` (or list it in
`HOUGE_OMP_VERSION_ALLOW`) and restart the daemon.
omp's own update checks are off in the profile config.

### Voice leg — agy-cli (voice only)

Voice notes never reach omp, because omp inlines audio bytes as text and the model invents a transcript
(ADR 0028, decision 16). They are transcribed on the flat-rate `agy-cli` leg. These variables only
affect voice. The media chain and its timeout are in [Multimodal ingest](#multimodal-ingest--voice-notes-and-photos-spec-2026-09-29).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_AGY_BIN` | `agy` (on PATH) | Voice only. Absolute path to the `agy` binary. Set it for the daemon, which runs on a restricted PATH. |
| `HOUGE_AGY_MODEL` | `Gemini 3.8 Flash (Low)` | Voice only. The transcription model (`agy models` lists the choices). **Pin it in `.env`, not the code default.** A retired pin fails every call: agy reports it as `status:"ERROR"` with `invalid model selection` and still exits 0. |
| `HOUGE_AGY_ENV_PASSTHROUGH` | — | Voice only. Extra env var **names** for the agy child, on top of the same minimal allowlist. agy reads its auth from `$HOME`, so this is rarely needed. |

### Answer-path prompt override

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_ASK_SYSTEM_PROMPT` | composed from `memory/` + `lessons` | Overrides the whole `/ask` system prompt. When unset it is **composed** from identity, answer discipline, the `ask` scope's lessons and guardrails (see [Learning](#learning--conversational-distillation-and-the-lessons-table)). |

## Web read (powers the **research** intent)

Tier-1 web access — a pluggable, keyed provider chain (like the LLM chain). Design and
guardrails: [ADR 0006](../decisions/0006-web-read-capability.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_WEB_PROVIDERS` | `tavily,firecrawl` | Ordered chain with fallback (first `ok` wins; unavailable/error falls through). Known: `tavily`, `firecrawl`. |
| `TAVILY_API_KEY` | — | Tavily key ([tavily.com](https://www.tavily.com) — 1,000 credits/mo, no card). Unset → provider unavailable, chain falls through. |
| `FIRECRAWL_API_KEY` | — | Firecrawl key ([firecrawl.dev](https://www.firecrawl.dev) — 1,000 credits/mo, no card). |
| `HOUGE_WEB_MAX_RESULTS` | `5` | Results per search — bounds synthesis tokens and the global breaker's exposure. |
| `HOUGE_WEB_TIMEOUT_MS` | tavily 20000 / firecrawl 30000 | Per-provider request timeout (ms). |
| `HOUGE_TAVILY_BASE_URL` | `https://api.tavily.com` | Tavily API base. |
| `HOUGE_FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev` | Firecrawl API base. |

In a chat turn the omp planner calls `web_search` itself, as often as the turn's budget allows,
and reads each result as a reader digest (the wall, below). The `web-research` program (`/run`)
keeps the fixed pipeline: search the live web (`web_search`, `external_read`) → 猴哥 synthesizes
an answer treating results as **untrusted data** and **citing source URLs** → a **STORM-style
self-critique pass** re-reads the draft and returns a corrected final answer
([ADR 0006](../decisions/0006-web-read-capability.md) amendment). Its synthesis and critique
prompts come from the composer (below), so the `research` scope's lessons steer both. Telegram link previews are disabled to cut the outbound
exfil leg; the URLs read are recorded in the ledger (`web_search_performed`).

## Direct URL read (`http_fetch`, loop tool — Phase 3.6 step ③)

`http_fetch` fetches ONE public http(s) URL as a bridge tool (like `web_search`, but
armed): GET/HEAD only, redirects never followed — a 3xx reports its
target so the next fetch revalidates from scratch. The SSRF floor is **code-owned and
not configurable**: private/reserved/special-range IPs are always refused
(resolve-and-pin, one DNS resolution per fetch), credentials-in-URL refused, and the
byte cap binds the *decompressed* body. Accepted Posture-A residuals are documented in
the module docblock (`src/web/http-fetch.ts`); the URLs read are recorded in the ledger
(`http_fetch_performed`).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_HTTPFETCH_ENABLED` | off | Arms the tool (armed-listing, like `HOUGE_SELFWRITE_ENABLED`): disarmed ⇒ unlisted ⇒ unreachable. Accepts 1/true/yes/on. |
| `HOUGE_HTTPFETCH_TIMEOUT_MS` | `15000` | Wall-clock cap per fetch (ms) — bounds the whole body read, not just the connect, so slow-trickle bodies can't stall a turn. |
| `HOUGE_HTTPFETCH_MAX_BYTES` | `1000000` | Byte cap on the **decompressed** body (zip-bomb guard). Cap hit ⇒ the kept prefix ships with `truncated: true`. |
| `HOUGE_HTTPFETCH_DENY` | — | Optional comma-separated host denylist, **punycode form** (WHATWG URL parsing punycodes IDN hosts before matching). Each entry matches the exact host and every subdomain (dot-suffix), e.g. `evil.test` also blocks `a.evil.test`. |

## Secrets firewall (ADR 0015, Phase 1)

When armed, the five real secrets (`KIMI_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`,
`FIRECRAWL_API_KEY`, `HOUGE_TELEGRAM_BOT_TOKEN`) are lifted into an in-process
`SecretBroker` at boot and then **deleted from `process.env`** — the daemon holds no
ambient credential, so a self-written `process.env.KIMI_API_KEY` reads `undefined`. The
broker feeds the provider chain builders (single source of truth: `config.apiKey`, the
`?? process.env` fallback is gone) and the Telegram client, and masks any secret **value**
in outbound chat replies, ledger payloads, and error text. Codex children always get an
explicit allowlisted env regardless of this flag. See
[ADR 0015](../decisions/0015-secrets-firewall.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SECRETS_FIREWALL_ENABLED` | off | Arms the firewall (lift-into-broker + strip `process.env` + redact egress). Accepts 1/true/yes/on. OFF ⇒ byte-identical to before the firewall existed. |
| `HOUGE_CODEX_ENV_PASSTHROUGH` | — | Optional comma-separated extra env var names the Codex child may inherit, on top of the `PATH/HOME/TERM/LANG/USER` allowlist. |

> **After the omp cutover (2026-10):** `KIMI_API_KEY`, `GEMINI_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
> have no consumer. The broker still lifts, strips and redacts them if they are present, so remove
> them from `.env`. omp children never receive a broker secret; their env is the allowlist plus
> `HOUGE_OMP_ENV_PASSTHROUGH` ([ADR 0015 amendment](../decisions/0015-secrets-firewall.md)).

## Dual-LLM privilege separation (ADR 0014)

The **act** half of the lethal trifecta (the secrets firewall above is the **exfil** half). Every
successful result from the four read tools (`web_search`, `http_fetch`, `gmail_read`, `google_api`) is
summarized by the **quarantined reader** (`HOUGE_OMP_READER`) into a schema-constrained extraction with
no action field. The planner reads that extraction, never the raw fetched bytes. On a reader failure,
a fixed code-owned text is returned instead of the raw bytes.

Since the omp cutover this is **unconditional** and has no variables. The wall is enforced in the
bridge (`normalizeExternalRead`), and `HOUGE_DUAL_LLM_ENABLED` and `HOUGE_LLM_READER_PROVIDERS` are
gone. Output of the `bash` tool is **exempt** and reaches the planner raw (ADR 0028 D12). See
[ADR 0014](../decisions/0014-dual-llm-privilege-separation.md) and its 2026-09-30 amendment.

## Google identity — `gmail_read` / `google_api` (ADR 0025)

Houge's read surface onto his own Google identity (`wukong.houge@gmail.com`, ADR 0008):
**`gmail_read`** (list / search / get one message, plus deterministic verification code/link
extraction for venue registration) and **`google_api`** (generic GET behind an exact allowlist
registry — one row per granted OAuth scope, 1:1; today `gmail/v1/users/me/*` ↔ `gmail.readonly`).
The OAuth scope is the hard floor: the refresh token carries `gmail.readonly` and nothing else.
Credentials are produced by `scripts/gmail-auth.mjs`; the two secrets below are broker-held
(ADR 0015's "exact five" → seven). See [ADR 0025](../decisions/0025-google-api-surface.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_GOOGLE_ENABLED` | off | Arms both tools (armed-listing). Accepts 1/true/yes/on. In `DISARM_FLAGS` — this surface acts under Houge's identity, so `/disarm` covers it. Since the omp cutover this flag alone arms both tools (the reader wall is unconditional). |
| `HOUGE_GMAIL_CLIENT_ID` | — | OAuth client id of the Gmail desktop client. Plain config, not a secret (client ids are public identifiers); read from env at call time. |
| `HOUGE_GMAIL_CLIENT_SECRET` | — | **Secret — broker-held** (ADR 0015): lifted into the secret broker at boot, stripped from `process.env`, redacted from egress. Written by `scripts/gmail-auth.mjs`. |
| `HOUGE_GMAIL_REFRESH_TOKEN` | — | **Secret — broker-held** (ADR 0015), same treatment. The long-lived `gmail.readonly` grant; revoking it in the Google console is the remote kill for this surface. |

**Arming (changed 2026-10).** The old arming couple (`HOUGE_GOOGLE_ENABLED` **and**
`HOUGE_DUAL_LLM_ENABLED`) is gone. Under omp the reader wall is unconditional for both tools, so
un-quarantined mail bytes still never reach the planner, and `HOUGE_GOOGLE_ENABLED` alone decides
whether the tools appear in the turn's manifest.

## Deterministic timezone tool (`to_local_time`, loop tool)

A trusted, zero-dep loop tool that fixes the recurring cross-dateline date errors (the World Cup
`明天有哪几场` bug): Houge anchors "today/tomorrow" in his local timezone but reads fixture times in
the source/venue timezone and never converts. The tool takes a **batch** of `{when, tz}` items and
returns each stamped with its local datetime **and a `today`/`tomorrow`/`in N days` label computed in
CODE (`Intl`, no LLM arithmetic)** — one round-trip, not per-item ping-pong. The model's only job is
to extract `(when, source-tz)` (sources state it, e.g. "noon ET"); the harness does the math. It is a
pure-compute tool: no I/O, no untrusted bytes (so Dual-LLM never quarantines it), no secrets.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_TIME_TOOL_ENABLED` | off | Arms the tool (armed-listing). Accepts 1/true/yes/on. OFF ⇒ unlisted ⇒ loop behavior unchanged. |
| `HOUGE_TZ_EVIDENCE_ENABLED` | off | Enforces source-stated timezone evidence per item (`zone_evidence` checked against the turn's prior digests). Accepts 1/true/yes/on. **The omp path has no `zone_evidence` input yet:** the `to_local_time` declaration (`src/omp/tools/to_local_time.json`) does not carry the field, so arming this under omp would refuse every converted row. Leave it off. |
| `HOUGE_TIMEZONE` | runtime tz | Override Houge's local timezone (IANA name, e.g. `Australia/Sydney`). Unset ⇒ the daemon's runtime timezone. Resolves "today/tomorrow" for the converter. |

## Short-term conversation memory (`chat_turns`)

A per-chat rolling thread of recent turns gives follow-ups context, so a reaction like
"too long" needs no reply-pointer and the chat feels like a conversation, not a vending
machine ([ADR 0010](../decisions/0010-natural-language-intent-layer.md) §4). Turns are
stored in the `chat_turns` table; three env vars bound how much of that thread is shared
and fed into a prompt. **Full turn text is always stored** — the char cap below applies
only when feeding a prompt.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_CHAT_CONTEXT_WINDOW_MINUTES` | `60` | How far back a follow-up still shares a thread. A message arriving after this gap starts a fresh thread (no prior context). |
| `HOUGE_CHAT_CONTEXT_TURNS` | `8` | Max recent turns fed into a prompt. Bounds the short-thread context tokens added per message. |
| `HOUGE_CHAT_CONTEXT_TURN_CHARS` | `500` | Per-turn char cap applied **only when feeding a prompt** (the stored turn keeps its full text). Truncates a long prior turn so the thread stays cheap. |

## Learning — conversational distillation and the `lessons` table

Every LLM-touching surface (the **answer** path, the research synthesis + critique, the
feedback distiller) builds its system prompt from one place — the **composer**
(`src/prompt/composer.ts`): Core Identity (`memory/core/houge.md`, loaded not duplicated) +
a per-surface discipline + the relevant **scope's lessons** (active rows composed at read
time) + guardrails.
Design: [ADR 0009](../decisions/0009-architecture-coherence.md); interaction model:
[ADR 0010](../decisions/0010-natural-language-intent-layer.md); learning loop:
[ADR 0007](../decisions/0007-learning-loop.md); reconcile/supersede + eval metadata:
[ADR 0012](../decisions/0012-self-evolution-spine-closed-loop.md) (spine Slice A, ⓪·3).

**Learning is conversational, not a command.** When the user reacts to a prior answer,
Houge **always re-answers** honoring the feedback, and **only when the feedback generalizes
into a clear, reusable preference** it **silently distills** it into a lesson — no toast, no
approval prompt. The distiller treats the *user's* feedback as the instruction and the prior
answer as reference only, so the untrusted-data wall holds: Houge never adopts an instruction
embedded in answer content as a lesson. This supersedes ADR 0007's `/teach` + per-lesson
approval gate **for user-sourced lessons** — trading the upfront gate for a high-precision
threshold plus inspect-and-undo. A correction that implies a "don't" also carries an
**`AVOID` line**, rendered under the lesson in the prompt.

**Reconcile-on-write, never append (⓪·3 S1).** Each durable lesson is **one row** in the
SQLite `lessons` table (the old one-block-per-scope `lesson_blocks` store was migrated —
its bullets split into rows — and is kept only as a frozen archive). Before a new lesson is
written, one cheap-chain compare against the scope's active lessons decides
**ADD / SUPERSEDE / UPDATE / DROP**: a changed preference *supersedes* its predecessor via
bidirectional pointers (never deleted — the chain is the memory rollback), a supplement is
merged, a duplicate is dropped. Rows carry eval metadata (`applied_count`,
`corrected_count`, `reuse_value`, `rating_history`, `last_used`) that the spine's S2 signal
path feeds; the composer renders active rows most-valuable-first, char-capped (~1200) like
the old block. The old over-cap LLM consolidation rewrite is gone — dedupe happens at write
time, and overflow past the row cap prunes the lowest `reuse_value` rows (reversibly).

| Env var | Default | Purpose |
|---------|---------|---------|
| `HOUGE_LESSON_CAP_PER_SCOPE` | `20` | Max **active** lesson rows per scope. Writing past the cap prunes the lowest-`reuse_value` rows (a reversible status flip, never a delete; the just-written row is always spared). Also caps how many rows the composer even considers when rendering. |

**Lesson consolidation — the daily preserve-all merge tick (spec 2026-07-23).** Reconcile-on-write
dedupes at *write* time, but the backlog still accumulates near-duplicates across many sessions
(e.g. several "be concise" variants). A daily tick (`src/capabilities/lesson-consolidate.ts`, wired
into the daemon signal path right after the episodic-facts consolidation) clusters semantically
near-duplicate ACTIVE lessons **within a scope** and merges each cluster into ONE **preserve-all**
lesson — every distinct directive (and every `AVOID` clause) kept. It is **ADD-then-supersede-all**
like episodic-facts (a new merged row is added; the members are marked superseded, never deleted —
fully reversible; `lessonsSupersededBy(id)` enumerates the members). Bounded (≤1 LLM call/scope,
≤5 clusters/tick, ≤4 members/cluster), scope-isolated, and guarded by two floors: a gross-collapse
floor (reject a merge shorter than its longest member) and an avoid-drop floor (reject a merge that
drops any member's `AVOID`). Preview merges without writing via `houge lessons-consolidate --dry-run`
(shows each member text → the proposed merge, and `⚠ REJECTED` for floor-blocked clusters) — the
**pre-arm eyeball is the real preserve-all net**, so run it before arming.

| Env var | Default | Purpose |
|---------|---------|---------|
| `HOUGE_LESSON_CONSOLIDATE_ENABLED` | off | Arms the daily consolidation tick. Accepts 1/true/yes/on. In `DISARM_FLAGS` — it rewrites Houge's own behavioral guidance, so `/disarm` halts it. Off = no tick, no writes. Memory A1: keep it off; an over-cap merge (text over 240, AVOID over 120) is rejected, and the old "not shorter than the longest member" floor is gone. Merging is same-theme only. |
| `HOUGE_LESSON_CONSOLIDATE_INTERVAL_HOURS` | `24` | Min hours between consolidation ticks (END-stamped latch). |
| `HOUGE_LESSON_CHAR_CAP` | `4000` | Char cap on the omp planner's lesson section (every active `ask` + `research` lesson, theme then id). A lesson that does not fit is skipped and the next is tried; each skip is a `lesson_dropped` ledger row and incident, and the skipped lesson's `last_used` is refreshed (seen, not credited) so decay cannot delete it. Non-positive or garbage gives the default. Write-side caps are code constants: text 240 (`LESSON_MAX_CHARS`), AVOID 120 (`LESSON_AVOID_MAX_CHARS`); an over-cap write is refused (`lesson_write_capped`). Lesson text is flattened to one line at write and render. |
| `HOUGE_LESSON_SESSION_RESET` | on | Operator escape hatch. A change in the active lesson set (id, text, avoid, theme) starts a fresh omp session at the next spawn (`new_session`), seeded with Paco's own messages from his last 3 Telegram runs within 48 h. The reset commits at the first dispatched prompt. `0`/`false`/`no`/`off` = respawn and resume the old transcript, as before A1. After 3 consecutive reset failures for one fingerprint the supervisor serves the resumed session anyway and keeps `planner_session_reset_failed` open (ledger `planner_session_reset_degraded`); set this to `off` to stop the retries. |

Lesson lifecycle and the clarify cap:

| Env var | Default | Purpose |
|---------|---------|---------|
| `HOUGE_LESSON_DECAY_DAYS` | `14` | Days without use before an active lesson starts to decay in the daily tick. Non-positive or non-integer → default. |
| `HOUGE_LESSON_PRUNE_THRESHOLD` | `0.2` | `reuse_value` below which a decayed lesson is pruned (reversibly). The wiki decay tick uses the same line. |
| `HOUGE_LESSON_REPEAT_DAYS` | `7` | A repeat supersede of the same lesson inside this window marks the memory layer ineffective (escalates). |
| `HOUGE_MAX_CONSECUTIVE_CLARIFY` | `1` | Consecutive clarifying replies allowed. At the cap the next turn's prompt carries a code-owned line telling the planner not to ask again (read from `chat_turns.intent`). `0` = never clarify; negative or garbage → default. |

Inspect and undo with the slash-only control commands `/lessons` (shows each row's id,
reuse/applied counters, AVOID, and `supersedes #n` lineage) and `/forget <scope|id>` (see the
[command reference](#telegram-command-reference)). `memory/core/houge.md` is committed (his
spine); the `lessons` table is local runtime state. The only prompt knob is
`HOUGE_ASK_SYSTEM_PROMPT` (in [Answer-path prompt override](#answer-path-prompt-override)
table) — an escape hatch to override the composed **answer**-path prompt wholesale.

## Self-evolution (Phase 1) — code self-diagnose

Houge can read his **own source** to diagnose a bug. The planner's `self_diagnose` tool runs a
**read-only Codex consult in a fresh git worktree** of committed `HEAD`, then relays the root
cause in his voice. The worktree holds only *tracked* files, so gitignored secrets are absent
by construction and the daemon's tree is untouched; the consult is `external_read` (no
`/approve` gate), `codex exec --sandbox read-only` is the inner wall, and no
`--dangerously-bypass-*` flag is ever passed. `coding_agent_cli` is reachable only from the
`self-diagnose` contract — every normal turn keeps it forbidden. Read-only diagnosis only —
Houge never edits a file in this phase. Design: [ADR 0011](../decisions/0011-self-evolution-architecture.md);
spec: [Phase 1 spec](../superpowers/specs/2026-06-20-phase1-code-self-diagnose.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_CODEX_ENABLED` | `off` | Master switch for the read-only Codex consult. When not truthy (`1`/`true`/`yes`/`on`), `self_diagnose` is unarmed: a call is refused `not_armed` and the planner answers without it — so the feature ships dark and is opt-in. |
| `HOUGE_CODEX_MODEL` | unset → codex's own configured model | Model override passed to `codex exec -m <model>`. Unset → Codex uses its own default. |
| `HOUGE_CODEX_TIMEOUT_MS` | `240000` | Wall-clock timeout (ms) for one Codex consult — Codex is slow (minutes). The CapabilityRunner's enforced cap is **derived** as this value + 15000 buffer, so a legitimately-long consult is not killed early. |
| `HOUGE_CODEX_BIN` | `codex` | The Codex CLI binary name/path. A missing binary maps to a clean error (the consult fails, the run reports it) rather than crashing. |

## Self-evolution (Phase 2a) — ambient skills

A **skill** is a reusable *procedure* for a class of task ("how Houge does X well") — distinct
from a *lesson* (a one-line preference) and from *code*. Skills are hand-authored markdown under
`skills/<scope>/<name>.md` (`scope` ∈ the composer surfaces: `ask` | `research` | `selfcode` | …),
loaded by the composer into a run **between discipline and lessons**. They are **ambient — never
invoked by name**: the ≤cap in-scope skills ride in-prompt, each prefixed by its `when:` hint, and
Houge self-applies the relevant ones during an ordinary natural-language turn. Skills are prose
that executes no logic (low-risk, instantly revertible), so they live outside SQLite and outside
git (`skills/` is gitignored runtime state). A run with **no skills composes byte-identically** to
the pre-skills prompt. Design: [ADR 0011](../decisions/0011-self-evolution-architecture.md); spec:
[Phase 2 spec](../superpowers/specs/2026-06-21-phase2-skills.md).

Skill file format (frontmatter is the source of truth; `skills/REGISTRY.md` is a generated view):

```markdown
---
name: cross-check-figures
scope: research
when: comparing numbers across multiple sources   # trigger hint; Houge self-applies
anchors:                                           # world-fact assertions (Gate B, 2c)
  - a part never exceeds its whole
  - units are converted before comparison
version: 2
last_verified: 2026-06-21
origin: refined                                    # commanded | learned | refined
---

<the numbered procedure Houge follows for this class of task>
```

A malformed or missing skill file is **skipped, never throws** — a bad skill weakens an answer at
most, it can never break a turn. Use `/skills [scope]` to view the loaded skills (read-only).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SKILLS_ENABLED` | `on` | Kill switch for the ambient skills layer. Skills are read-only/low-risk, so this defaults **on** — only an explicit `0`/`false`/`no`/`off` disables it, in which case the composer omits the skills section (composing byte-identically to a no-skills run). |
| `HOUGE_SKILL_MAX_PER_SCOPE` | `4` | Max skills folded into a prompt per scope (alphabetical by filename; the rest are dropped). Bounds the prompt and keeps self-selection precise. |
| `HOUGE_SKILL_REFINE_PASSES` | `3` | Max **guided-refine** passes for a blocked auto-authored skill (the paper peaks at 3). Each pass re-authors the draft against Gate B's specific failing criteria, then re-verifies. |
| `HOUGE_SKILL_REVERIFY_ENABLED` | `off` | Arms the **weekly re-verify advisor** (skill-retirement spec 2026-07-29): stale skills get a fresh Gate B ensemble; passers are re-stamped, failers are flagged to you with the failing criteria and the exact `/skills retire <name>` command. **Suggest-only — it never moves a file.** In `DISARM_FLAGS`. First armed tick fires immediately (a first sweep today), then weekly at the slot. |
| `HOUGE_SKILL_REVERIFY_AT` | `sun 10:00` | The advisor's weekly slot (same `"<weekday> HH:MM"` grammar as `HOUGE_RADAR_PANEL_AT`, rendered in the radar tz). `off` disables the slot; malformed falls back to the default. Shown in the `/schedule` 系统任务 footer when armed. |
| `HOUGE_SKILL_REVERIFY_AGE_DAYS` | `28` | A skill is **stale** (a re-verify candidate) when `last_verified` is missing or older than this many days. Positive integers only — `0` is rejected back to the default, so use `1` to force staleness at a live gate. ≤12 skills re-verified per tick (`REVERIFY_MAX_PER_TICK`); excess picked up next week. |

### Gate B — the anchor verifier (Phase 2c)

Gate B is a **separate, walled-off** verifier that scores an authored skill's *procedure* for
correctness. It runs a **3-pass ensemble**: each pass independently derives 4–6 procedure-level
quality criteria from world-knowledge (it is fed **only** the skill's `when:` + procedure body —
**never** the author's own `anchors:`, so an author can't grade its own homework) and judges
whether following the procedure satisfies each; the final score is the mean of the passes. A skill
**passes** when `score ≥ threshold`. The threshold is a *separation* bar, not a high-quality bar —
good skills score modestly; the gate works on the good/bad gap (the validating spike cleanly split
good skills 0.28–0.89 from broken ones ≤0.06).

**Advisory vs blocking by origin (D5):**
- **Commanded** skills (you asked Houge to write one) → **advisory**: written regardless; the score
  is stamped into the frontmatter (`score`, `last_verified`) and shown in the report, with a `⚠ low
  score` note when below threshold.
- **Auto-authored** skills (promoted from a recurring-procedure correction) → **blocking**: kept
  only if Gate B passes; otherwise **guided-refine ≤ `HOUGE_SKILL_REFINE_PASSES`**, then if still
  failing the draft is **parked** in `skills/_pending/` (inert — never applied) and a lightest-form
  lesson is saved. Every auto-author is surfaced in a report (pass **or** blocked) — nothing silent.

A Gate B parse failure / LLM error **never** blocks a turn: it is treated as *unscored* and falls
back to an advisory write with a noted error (only a real **low score** blocks, never an error).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_GATE_B_ENABLED` | `on` | Kill switch for Gate B. Off → every skill is treated as unscored/advisory (commanded and auto both write). Only `0`/`false`/`no`/`off` disables it. |
| `HOUGE_GATE_B_PASSES` | `3` | Number of independent Gate B passes averaged into the score (the ensemble that tamed single-pass noise in the spike). |
| `HOUGE_GATE_B_THRESHOLD` | `0.15` | Pass threshold on the mean score — the good/bad **separation** gap from the spike, not an absolute quality bar. |

## Self-evolution (Phase 3) — code self-write

Houge can write a **diff to his own source** to fix a bug. When the planner decides the fix belongs in
code (*"fix it so you stop asking which 猴哥"*) it calls `self_write_propose`, which runs `runSelfWrite`
in the background and ends the turn: Houge frames the task,
has **Codex write a diff in a fresh git worktree** under `<data>/selfwrite` (`codex exec --sandbox workspace-write`), then runs
it **autonomously** through three checkers — (1) a deterministic **protected-path check** (HARD DENY on
any gate/identity/dep/existing-test path; **not** overridable by `/approve`), (2) the **test gate**
(typecheck + test + build in the worktree), (3) an **independent reviewer** (model diversity:
the writer is Codex, the checker is an omp seat on `HOUGE_OMP_REVIEWER` or a separate Codex session) — with a **refine loop ≤3**. Only if all pass does Houge
**publish the diff as a branch** (`houge/selfwrite/<run-id>`) and **notify Paco**. The daemon **never
hot-swaps**: Paco merges + reloads at his leisure (the [ADR 0011](../decisions/0011-self-evolution-architecture.md)
§5 one constant). **Off by default.** Design: [ADR 0011](../decisions/0011-self-evolution-architecture.md)
§7 + [its 2026-06-25 amendment](../decisions/0011-self-evolution-architecture.md#amendment-2026-06-25-self-write-is-autonomous-to-branch-checkpoint--merge-not-approve);
spec: [Phase 3 spec](../superpowers/specs/2026-06-25-phase3-code-self-write.md). The write adapter
**reuses the `HOUGE_CODEX_*` variables** (above, in [Phase 1](#self-evolution-phase-1--code-self-diagnose)):
`HOUGE_CODEX_MODEL`, `HOUGE_CODEX_TIMEOUT_MS`, `HOUGE_CODEX_BIN`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SELFWRITE_ENABLED` | `false` | Master switch for the **entire** code-self-write surface. Off until Paco flips it. When not truthy, `self_write_propose` is unarmed (a call is refused `not_armed`; `self_diagnose` stays available if Codex is on) — so the feature ships dark and is opt-in. |
| `HOUGE_SELFWRITE_REVIEWER` | `omp` | Which agent runs **checker 3** (the independent reviewer). `omp` (**default**) is a one-shot on the `HOUGE_OMP_REVIEWER` chain, which is model-diverse from the Codex writer. `codex` is an independent Codex session with a fresh session and the adversarial prompt. Any other value, including a stale `kimi` or `claude`, falls back to `omp`. writer≠checker holds either way; a gpt-family reviewer string logs a warning. |
| `HOUGE_TESTGATE_TIMEOUT_MS` | `300000` | Wall-clock timeout (ms) for the whole **test gate** (typecheck + test + build) run in the worktree. A gate that exceeds it is treated as red (no publish), not a crash. |

> **Stale-row cleanup (2026-07-27):** the former `claude` reviewer option, its
> `HOUGE_CLAUDE_TIMEOUT_MS`, and the self-write `HOUGE_CLAUDE_BIN` row documented a Claude
> reviewer/writer that no longer exists in code (`ReviewerKind = "codex" | "kimi"`,
> `WriterKind = "codex"`). `HOUGE_CLAUDE_BIN` kept one consumer, the ADR 0027 panel chair, until
> the omp cutover removed it too (see [Removed 2026-10](#removed-2026-10-omp-cutover)).

#### Phase 3.5 — kimi reviewer backend (removed 2026-10)

The `kimi-cli` reviewer backend and its `HOUGE_KIMI_CLI_*` variables were removed with the omp cutover.
Its seat is now the `HOUGE_OMP_REVIEWER` chain, a tool-less omp one-shot (see
[Removed 2026-10](#removed-2026-10-omp-cutover)).

### Phase 3.1 — swappable writer + per-role models

Phase 3.1 makes the **writer** swappable too (it was hardcoded to Codex), so the heavy-token role
can sit on whichever subscription is largest. The writer is the token-heavy role (measured: Codex
writer ~200K–1.2M tokens/run, mostly cached input from agentic file-reading; Claude reviewer ~25K
in + ~1.2K out). Paco's case → `WRITER=claude` + `REVIEWER=codex` (Claude Max 5x writer + Codex Plus
reviewer); the proven default is the reverse. The deterministic protected-path guard checks the
**diff**, not who wrote it, so swapping the writer cannot widen what may land.

**Model diversity** (writer ≠ reviewer provider) is recommended and is the default. Setting both
roles to the **same provider** logs a soft warning — it is **not blocked**.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SELFWRITE_WRITER` | `codex` | Which agent **writes the diff** (the heavy-token role). `codex` is the only backend: `codex exec --sandbox workspace-write --json`, so token usage is captured. Any other value, including a stale `claude`, falls back to `codex`. |

> The Claude writer/reviewer rows (`HOUGE_CLAUDE_WRITER_MODEL`, `HOUGE_CLAUDE_MODEL`,
> `HOUGE_CLAUDE_REVIEWER_MODEL`, `HOUGE_CLAUDE_TIMEOUT_MS`) documented backends the code stopped
> reading before the omp cutover. They were removed from this page on 2026-10.

### LLM telemetry — the `llm_attempt` ledger event (slice 2, 2026-09-07)

Every LLM **leg attempt** in Houge — success, error, or unavailable; run-scoped or run-less —
lands in the ledger as one **`llm_attempt`** event. Not by remembering a hook: the adapter factory
(`oneShotAdapter` / `spawnOneShot`), the planner supervisor and the voice leg take a **required** `LlmAuditSink`
(`src/llm/audit.ts`), built by `RunStore.llmAuditSink(scope)`; `answerWithChain` records every leg
it tries, and `tests/llm/audit-coverage.test.ts` scans `src/` so no construction site can omit it.
This replaced the Phase 3.1 opt-in `onUsage` hook and its `llm_call` event, which recorded only
successes and only where someone had passed the hook — whole call paths (every daemon tick, both
panel judges, the self-write reviewer's fallback legs) recorded nothing (defect D4, spec
2026-09-04). Historical `llm_call` rows are never rewritten; the readers union them.

Scopes: a run (`run_id`) or a run-less correlation — `tick:episodic_distill`,
`tick:episodic_consolidate`, `tick:lesson_consolidate`, `tick:idea_radar`, `tick:idea_panel`,
`tick:skill_reverify`, `cli:lessons-consolidate`, `cli:radar`, `cli:radar-panel`,
`rating:attribution`, `gate:b` (skill Gate B verify). Run-less rows read back with `run_id`
absent, not null. Payload fields:

| Field | Required | Notes |
|-------|----------|-------|
| `provider` | yes | The leg. Since 2026-10: an omp provider (`anthropic`, `google-antigravity`, `kimi-code`, `openai-codex`), `agy-cli` (voice), `codex`, or `jev`. Older rows also carry `pi`, `kimi-api`, `gemini-api`, `kimi-cli` and `claude`. |
| `role` | yes | The call's purpose, set by the scoped sink (the chain does not know it): `answer` \| `compose` \| `classify` \| `frame` \| `reader` \| `writer` \| `reviewer` \| `distill` \| `consolidate` \| `extract` \| `judge` \| `chair` \| `verify` \| `attribution`. |
| `outcome` | yes | `ok` \| `error` \| `unavailable`. *Unavailable* = the provider was not constructively callable (binary absent, not authenticated, model retired, key unset); timeout, non-zero exit, over-cap and parse failures are `error`. Both fall through the chain identically. |
| `model` | on `ok` | The model that answered (`unknown` + a warning if a provider ever omits it). |
| `latency_ms` | optional | Wall-clock for this leg. |
| `attempt_group` · `leg_index` | optional | One 12-hex id per chain invocation and the leg's 0-based position, so "Opus 5.5 failed, then Opus 4.6 served" is reconstructable, not inferred from timestamps. |
| `input_tokens` · `output_tokens` · `cached_input_tokens` | on `ok` | `output_tokens` is the total billable output for every engine: Codex reports `reasoning_output_tokens` disjointly and it is added; agy nests thinking inside `output_tokens` (measured `total == input + output`) and it is never re-added; omp rows take omp's own usage figures. (The deleted OpenAI-compat legs derived `max(completion, total − prompt)` on older rows.) |
| `thinking_tokens` | optional | Informational — already inside `output_tokens`, never priced, never summed. Reported by agy and Codex. |
| `cost_usd` | metered only | Priced **in the sink** (`computeCostUsd`, the one seam every path shares) for metered providers only. No metered leg exists since the omp cutover, so OAuth rows carry none; the live gate fails on any `cost_usd > 0` from an OAuth provider. |
| `error_kind` | on failure | Bounded: `auth` \| `model_missing` \| `timeout` \| `spawn` \| `transport` \| `parse` \| `quota` \| `model_refusal` \| `aborted` \| `other`. It is classified per leg from our own provider strings or omp's error frames, never from the joined aggregate or vendor prose. |
| `family` | omp rows | `claude` \| `gemini` \| `gpt` \| `kimi` \| `other`, taken from the model id (the D10 family resolver). |
| `family_collapse` | optional | `true` on a reader call that ran on the planner's family (D10); a `wall_collapse` event is written beside it. |
| `request_key` | omp rows | `<correlation_id>:<n>`, one per model request. A unique index makes a repeat a no-op. |
| `credential_id` · `ttft_ms` | optional | omp: which stored OAuth credential served the request, and time to first token. |

**Counts/metadata ONLY — by construction and by test.** The prompt, diff, and response bodies never
reach the sink; `tests/run/llm-audit-sink.test.ts` pins the payload's key set and asserts no body
field can appear. Recording is best-effort: a sink failure logs a warning and never fails an answer.
A provider that *throws* is recorded as an error and falls through like any other failure.

Since the omp cutover the panel judges and chair are omp one-shots and record through
`spawnOneShot` like every other seat. The seats outside omp record at their spawn site: the
self-write writer (codex) and each **reviewer leg** — the reviewer's internal retry/fallback chain
records every leg it tries, so a dead configured reviewer cannot hide behind a fallback that passed.
(Before the cutover the codex judge and the claude-CLI chair recorded here too.)

`houge usage` / `/usage` (`usageByModel`) and the metered ceiling (`meteredSpendUsd`) read
`llm_attempt` rows with `outcome = 'ok'` unioned with the pre-cutover `llm_call` history (whose
`gemini-api` output figures undercount ~5×, ADR 0019 amendment). Both predicates are indexed
(`ledger_events_type_time_idx`; the monthly window is a sargable range, not `strftime`).

In addition, the **`self_write_published`** event carries an optional compact **`usage_summary`**
(writer + reviewer token totals for the published run — counts/metadata only, same no-bodies rule),
so a published branch's per-role cost is visible without scanning the individual attempt events.

Live gate: `node scripts/live-gate-omp.mjs`. Its silent-degradation checks fail on a missing
`llm_attempt`, on equal planner and reader families without a `wall_collapse`, and on `cost_usd > 0`
from an OAuth provider. Run-less proof after a daemon restart: rows under `tick:*` correlations.

### Phase 3.3 — interactive Telegram merge controls

The published-fix notification carries an inline keyboard — **[View diff] · [Merge & reload] ·
[Discard]** (`callback_data` = `selfwrite:<action>:<run-id>`) — so the §5 merge checkpoint moves from a
terminal `git merge` to an **authenticated Telegram tap**. The human gate is **preserved**: the daemon
merges + reloads self-authored code **only on Paco's tap**, never on its own. **Callbacks are
allowlist-authed** — the callback's `from` user is checked against the same allowlist as messages, so
**only Paco's taps act** (a non-allowed tap is rejected); the buttons are cleared after a tap and the
actions are idempotent, so a branch can't be double-merged. Design: [ADR 0011](../decisions/0011-self-evolution-architecture.md)
§5 + [its Amendment 2](../decisions/0011-self-evolution-architecture.md#amendment-2-2026-06-25-the-mergereload-checkpoint-moves-to-telegram-still-human-gated);
spec: [Phase 3 spec](../superpowers/specs/2026-06-25-phase3-code-self-write.md#phase-33--interactive-telegram-merge-controls--5-amendment).

The buttons (handled by `src/telegram/self-write-action-handler.ts` over the merge actions in
`src/capabilities/self-write-merge.ts`):

- **[View diff]** — read-only `git diff main...<branch>` (bounded; buttons left in place, repeatable).
- **[Merge & reload]** — capture the pre-merge ref → `git merge` → `npm run build` → **re-run the
  test-gate on merged `main`** → green: durable "merged, reloading…" notice, optional push, then a
  detached `launchctl kickstart` self-restart onto the new `dist/`. **POST-MERGE-VERIFY safeguard:** a
  red build or test-gate triggers an auto-revert (`git reset --hard` to the pre-merge ref) with **no
  restart and no push** — the daemon keeps running the old code, nothing landed.
- **[Discard]** — `git branch -D <branch>` (idempotent: an already-gone branch is a no-op).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SELFWRITE_PUSH` | `false` | When truthy (`1`/`true`/`yes`/`on`), a **green** [Merge & reload] also runs `git push origin <branch>` (the merged `main`) after the merge+build+test-gate pass, before the self-restart. Default off — the merge lands locally only; a red post-merge gate never pushes. |
| `HOUGE_DAEMON_LABEL` | `com.houge.daemon` | The launchd label the self-restart kickstarts (`launchctl kickstart -k gui/$uid/<label>`). Set this only if the daemon is installed under a non-default label. |

## Telegram command reference

Natural language first: just type, and the chat's omp planner decides what to do — there are
no `/ask`, `/research`, or `/teach` commands. Slash commands survive only for the
control/safety plane (idempotent, no run, no budget unless noted), and `/approve` · `/deny`
are **unforgeable** — never inferred from prose. They are handled by the poll loop even while
a turn runs (detached turns).

| Command | Plane | Purpose |
|---------|-------|---------|
| `/status` | control | Per-cap breaker headroom, run counts by state, last error. |
| `/run <program> [args]` | control | Escape hatch to launch a named program directly (consumes budget). |
| `/approve <id>` · `/deny <id>` | safety | Resolve a pending approval: a run-level gate or an in-turn tool approval (floor B, ADR 0028). Unforgeable — slash-only, never inferred. |
| `/approvals` | safety | List the answerable pending approvals (run-level and in-turn tool approvals alike), each with the command to answer it. |
| `/usage` | control | Token use per provider and model from the ledger; omp rows show "sub", never dollars. |
| `/help` | control | The command list; an unknown `/command` returns it instead of starting a turn. |
| `/lessons [scope]` | control | View the active lesson rows: each with its id, reuse/applied counters, `AVOID` line, and `supersedes #n` lineage. No scope → lists all scopes. |
| `/forget <scope\|id>` | control | Prune that scope's lessons, or one lesson by numeric id (a reversible status flip — rows are never deleted) and ack. |
| `/memories [query]` | control | Up to 10 of this chat's ACTIVE episodic facts as `#id · text · date`: the matches for the query (keyword and substring search), or with no query the 10 most-applied. Read-only. |
| `/forget_memory <id>` | control | (Alias `/forget-memory`.) Retire one active fact of this chat (a reversible status flip, recorded in `memory_changes`) and reply with the card's **Undo** button. Allowlist only; an unknown, retired or other chat's id gets a refusal reply. |
| `/skills [scope]` | control | Read-only **viewer** of the ambient skills (name · scope · `when:` · version); regenerates `skills/REGISTRY.md`. Never invokes a skill. No scope → lists all scopes. |
| `/skills pending` | control | Read-only **viewer** of the parked (blocked auto-author) drafts under `skills/_pending/` — inert, never applied. Inspect to hand-fix + promote, or discard. |
| `/radar [n]` | control | Numbered top-10 active idea cards (picked > shortlisted pinned first, then momentum) + last-tick footer; `/radar <n>` 详情 — per-card drill-down with summary, momentum, panel scores, and source titles + URLs. Flag off → off notice. Read-only view of the ADR 0026 `ideas` store. |
| `/idea [pick <n>]` | control | Latest weekly panel shortlist snapshot (ADR 0027): rank · title · mean score · chair rationale, with the picked marker. `/idea pick <n>` resolves rank n IN the frozen snapshot and maintains the global pick singleton (at most one `picked` card, ever — re-pick reverts the prior). |
| `/schedule` | control | List this chat's scheduled tasks (id · spec · next fire · goal; `⚠ failed` rows shown so they can be cleared). |
| `/schedule cancel <id>` | control | Cancel a schedule (reversible state flip, never deleted; failed rows cancellable too). Chat-scoped — other chats' ids read as not-found. |
| `/kill [reason]` | safety | **Durable kill switch** (ADR 0018): aborts every chat's omp planner, writes the `houge.kill` tombstone, acks with the revival steps, stops the daemon. launchd relaunches into a PARKED process (no polling, no runs) until the file is manually deleted. Unforgeable — slash-only + allowlist + no-forwards; exempt from the command rate limit. |
| `/disarm` | safety | One-command posture: forces `HOUGE_SELFWRITE_ENABLED` / `HOUGE_CODEX_ENABLED` / `HOUGE_SKILLS_ENABLED` / `HOUGE_SCHEDULER_ENABLED` to `false` — live AND across restarts (`houge.disarm` posture file outranks `.env`). Conversation + episodic memory stay on. |
| `/rearm` | safety | Delete the disarm posture; flags re-apply from `.env` on the **next restart** (the ack says how). |

## Scheduler (ADR 0017)

Recurring/one-time tasks fired from the daemon poll loop; created conversationally via the
`schedule_task` loop tool ("每周一早上8点给我AI周报") or cancelled via `/schedule cancel`.
Fired runs are ordinary `turn` runs (`source:"schedule"`) through the same gateway→worker
path; the global 24h breaker is the blast-radius net (a fuse PAUSES due schedules — they
catch up with exactly one fire when it lifts). Misfire policy: fire once, advance from now.

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOUGE_SCHEDULER_ENABLED` | `false` | Master arm for the tick AND the `schedule_task` tool (unlisted when disarmed). `/schedule` viewing stays available either way. |
| `HOUGE_DISPLAY_TZ` | `Australia/Sydney` | The fallback display zone for schedule lists and digests (`resolveDisplayZone`), used when a schedule carries no zone of its own. |
| `HOUGE_SCHEDULER_MAX_PER_CHAT` | `10` | Cap on active (enabled) schedules per chat. Defense-in-depth only since scheduler v2 — the self-replication bound is now the provenance strip (below), not the cap. |

**Scheduler v2 (ADR 0017 amendment, 2026-07-20).** `schedule_task` has four verbs:
`{goal,spec,tz}` create · `{list:true}` · `{update:"sch_…", goal?/spec?/tz?}` · `{cancel:"sch_…"}`.
Creating an exact duplicate of an enabled schedule returns the existing id instead of a twin.
A goal-only update never moves the next fire time; a spec/tz update recomputes it. Updating a
`failed` row re-enables it (the repair path).

**Provenance strip (the self-replication bound).** `compileTurnContract` removes `schedule_task`
from `allowed_actions` when `event.source === "schedule"`, so a run BORN FROM a schedule fire
cannot create or mutate schedules — the tool never reaches the model's menu, and a scripted call
is denied. This replaced the per-chat cap as the containment mechanism after a fired run misread
its own replayed goal as "set up a weekly report" and minted a duplicate (2026-07-19).

## Idea Radar (R1, ADR 0026)

A daily flag-gated tick fetches a code-owned set of public builder-idea sources (HN, HF daily
papers, Devpost, GitHub new-repo search, lobste.rs — Reddit/X dormant pending approvals),
extracts deduplicated idea cards via ONE DATA-framed LLM call, and maintains a bounded `ideas`
store (momentum = distinct items × sources; auto-archive after 30 stale days; active cap 100).
Views: `/radar` (top cards) and a `/status` line. Pre-arm gate: `houge radar --dry-run` — real
fetches + real LLM call, zero writes, bypasses flag and latch by design.

| Env var | Default | Purpose |
|---------|---------|---------|
| `HOUGE_RADAR_ENABLED` | off | Arms the daily radar tick. Accepts 1/true/yes/on. In `DISARM_FLAGS`. Off = no fetches, no LLM spend, no writes; `/radar` renders the off notice. |
| `HOUGE_RADAR_AT` | `07:30` | Wall-clock pin (`HH:MM` in `HOUGE_RADAR_TZ`): the tick fires on the first daemon cycle past this time daily — fresh cards each morning, no drift with restarts. `off` reverts to the rolling interval. First arm (no prior run) fires immediately. |
| `HOUGE_RADAR_TZ` | display zone (Australia/Sydney) | IANA zone for the pin; DST-safe via the scheduler's calendar walk. |
| `HOUGE_RADAR_INTERVAL_HOURS` | `24` | Rolling-interval fallback, only used when `HOUGE_RADAR_AT=off`. The latch stamps when the tick COMMITS to running (before fetches) — a store fault costs one interval, never a retry storm. |

## Idea Panel (R2, ADR 0027)

A weekly flag-gated tick judges the top 12 active idea cards through three pinned seats
(Kimi opportunity · GPT buildability · Gemini novelty on `HOUGE_OMP_JUDGES`; quorum 2) and the
omp chair seat (`HOUGE_OMP_CHAIR`) synthesizes a shortlist of 3 (chair absent/broken → deterministic mean-score
fallback). Writes: per-card `scores_json`, `shortlisted`/`tracked` status transitions, a frozen
weekly snapshot (`/idea` + `/idea pick <n>` resolve against it), a `memory/briefs/<week>-ideas.md`
projection, and ONE Sunday digest push. Cost: 4 subscription omp one-shots per week. Seat names are
model families, not provider names; panel diversity (Gemini · Kimi · OpenAI · Claude) is unchanged. Pre-arm gate: `houge radar-panel --dry-run` — real seats, zero writes, no push, no
brief, bypasses flag and latch by design.

| Env var | Default | Purpose |
|---------|---------|---------|
| `HOUGE_RADAR_PANEL_ENABLED` | off | Arms the weekly panel tick. Accepts 1/true/yes/on. In `DISARM_FLAGS`. Off = no seat calls, no writes, no push; `/idea` still renders the last snapshot. |
| `HOUGE_RADAR_PANEL_AT` | `sun 09:00` | Weekly slot, grammar exactly `"<day> HH:MM"` (day ∈ sun…sat, zero-padded 24h — `sun 9:00` is malformed). `off` disables tick AND push (no interval fallback). Malformed → default; `/status` renders the RESOLVED slot so a swallowed typo is visible. First arm (no prior run) fires immediately. Tz: `HOUGE_RADAR_TZ`. |

> **Since 2026-10:** the seats are omp one-shots (see [LLM runtime](#llm-runtime--omp-adr-0028)).
> `HOUGE_RADAR_CHAIR_TIMEOUT_MS` and `HOUGE_CLAUDE_BIN` are no longer read, and `CLAUDE_CODE_OAUTH_TOKEN`
> has no consumer. The chair uses `HOUGE_OMP_ONESHOT_TIMEOUT_MS`.

Reuses: `HOUGE_RADAR_TZ` (slot + week-key zone). All four seats, the GPT judge included, are omp
one-shots; the panel no longer spawns `codex`.

## Introspection — the invariant sweep (slice A, ADR 0024)

A deterministic, zero-LLM sweep on the daemon signal path: reads Houge's own flight recorder
(schedules, runs, outbox, heartbeat, LLM attempts), checks seven invariants, and records violations as
**incidents** with an open→resolve lifecycle. Pure SQL reads plus incident bookkeeping — no LLM,
no capability, no run creation, so it can never act on what it finds.

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOUGE_INVARIANT_SWEEP_ENABLED` | `false` | Master arm for the sweep. Deliberately NOT in `DISARM_FLAGS` — disarming Houge must not blind him. |
| `HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES` | `720` (12 h) | Sweep cadence. Invalid/non-positive values fall back to the default. |

Invariants: duplicate enabled schedules · stuck runs (active state, lease expired >10 min;
`waiting_for_approval` is NEVER an incident — that run is parked on Paco, working as designed) ·
undelivered notifications (>15 min, EXCLUDING the sweep's own `incident_*` alerts; a `failed_terminal` row stops counting 24 h or two sweep intervals, whichever is longer, after it went terminal) · overdue
schedules (>15 min past cursor) · failed schedules · heartbeat gaps (>10 min; a gap that spans a deliberate `/kill` park is logged, not opened) · **failing LLM legs** (`llm_leg_failing`, slice 2: a provider with ≥3 `llm_attempt` rows and zero `ok` in the rolling 24 h — the shape in which the agy leg died silently for three months; subject = provider, detail = attempts/ok/latest error_kind; a leg that recovers but is not called again stays open until its failed rows age out, ≤24 h at the 12 h cadence).

**Cadence buys detection latency, not quiet.** Alerts fire on incident *transitions*, so a
persistent violation costs exactly one Telegram message at any cadence and a clean database is
silent at any cadence. Twice a day suits the retro-style invariants; lower it toward 30 min if
`stuck_run` latency starts to matter (that is the one class meaning Houge is silently not doing
something Paco asked).

**Alert damping.** At most 3 alerts per sweep plus one summary line (a systemic failure trips
many invariants at once); a reopen within 30 min of the previous resolve is recorded silently.
Incident rows and ledger events are always complete — only the human channel is throttled.

Inspect: `sqlite3 houge.sqlite "SELECT kind, subject, state, seen_count, first_seen_at FROM incidents ORDER BY first_seen_at DESC"`

### Memory A1 ledger events and incident kinds (2026-10-02)

Ids and counts only, never text. Ledger: `lesson_dropped`, `lesson_write_capped`, `lesson_cross_theme`,
`lesson_cross_scope`, `lesson_theme_unknown`, `lesson_render_failed`, `planner_session_reset`,
`planner_session_reset_degraded`, `evidence_rejected`, `embedding_backfill` (daily tick: up to 20 facts and 10 wiki
pages with a NULL embedding, stop signal checked before each), `memory_migration`.

| Incident kind | Opens when | Resolves |
|---|---|---|
| `lesson_dropped` | an active ask/research lesson did not fit `HOUGE_LESSON_CHAR_CAP` (sweep) | the next sweep that finds none dropped |
| `lesson_render_failed` | the lesson read or render threw, so the spawn prompt carries no lessons (alerted once) | the next successful render |
| `core_overflow` | active core facts exceed `HOUGE_EPISODIC_CORE_CAP` (sweep) | the sweep that finds it back under |
| `embeddings_unavailable` | embedding outage (Ollama down): retrieval is keyword-only (sweep) | embeddings succeed again |
| `planner_session_reset_failed` | `new_session` failed; the spawn fails. After 3 consecutive failures it degrades to the resumed session and STAYS open | a later successful reset |

The consolidation tick (`HOUGE_LESSON_CONSOLIDATE_ENABLED`) stays off after A1.

## Episodic memory (Phase M, ADR 0016)

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOUGE_EPISODIC_ENABLED` | `false` | Master arm: fast-path distillation, composer retrieval, daily consolidation. |
| `HOUGE_EMBED_URL` | `http://localhost:11434` | Local Ollama endpoint for embeddings. |
| `HOUGE_EMBED_MODEL` | `embeddinggemma` | Embedding model (multilingual; CJK recall rides the cosine leg). |
| `HOUGE_EMBED_TIMEOUT_MS` | `5000` | Per-embed cap; any failure degrades to BM25/recency (never blocks a turn). |
| `HOUGE_EPISODIC_FACT_CAP_PER_CHAT` | `200` | Active-fact cap per chat (lowest reuse pruned reversibly). |
| `HOUGE_EPISODIC_RETRIEVE_CAP` | `6` | Facts folded into a turn's prompt (≈900-char guard). |
| `HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS` | `14` | Recency decay half-life in retrieval scoring. |
| `HOUGE_EPISODIC_DECAY_DAYS` | `30` | Idle age before a fact starts losing reuse_value in the daily tick. |
| `HOUGE_EPISODIC_PRUNE_THRESHOLD` | `0.2` | reuse_value floor below which an idle fact was pruned; **not applied in A1** (decay lowers reuse but never prunes; the per-chat cap still bounds the count) |
| `HOUGE_EPISODIC_MERGE_SIM` | `0.92` | Cosine threshold for the nightly duplicate-merge clustering. |
| `HOUGE_EPISODIC_CORE_CAP` | `8` | Cap on core facts folded into the always-known band of every turn's context. Min 1; garbage → default. Above it a `core_overflow` incident opens (sweep). Core facts never decay and are never cap-pruned. |
| `HOUGE_EPISODIC_MIN_COSINE` | `0.42` | Relevance gate: with a query embedding a fact enters a turn only at cosine at least this over the chat's whole active pool; a fact without an embedding only by an FTS hit; without a query embedding (Ollama down) only FTS hits. The FTS keyword legs drop English function words and non-CJK tokens of 2 chars or fewer. Retrieval excludes only the core ids the always-known band rendered. `0` = the pre-A1 pool (FTS plus newest 50) and 0.05 floor. Outside [0,1] or garbage gives the default. Benchmarked 2026-10-02 on `embeddinggemma`. |
| `HOUGE_EPISODIC_EVIDENCE` | `shadow` | Extracted facts cite a numbered user line and a quote that code checks (a user turn, not schedule-born, quote found after NFKC and whitespace normalisation). `shadow`: a failing fact is kept, never core, and counted (`evidence_rejected`); `enforce`: dropped; `off`: no per-fact check and `core` is not gated on evidence, but turn text is still flattened (the transcript the extractor reads is built the same way in every mode). An evidence-failing fact never touches a core row: a verdict targeting core becomes a non-core ADD. Over-cap merged text becomes an ADD. |

## Session rating (ADR 0012, spine Slice A)

Houge asks for a 0–3 rating at a session boundary: enough user turns, a lull, and outside the
cooldown. A bare digit reply is captured against the session's applied lessons, and a low rating runs
one attribution read on the ticks seat. The distill tick reuses the lull.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_RATING_ENABLED` | on | Kill switch for the ask. Only `0`/`false`/`no`/`off` turn it off. |
| `HOUGE_RATING_MIN_TURNS` | `3` | User turns since the last ask or capture before a new ask is due. |
| `HOUGE_SESSION_LULL_MINUTES` | `30` | Quiet time that marks a session boundary: for the rating ask, and for the episodic distill tick. |
| `HOUGE_RATING_COOLDOWN_HOURS` | `20` | Minimum hours between two asks. |
| `HOUGE_RATING_PENDING_MINUTES` | `120` | How long an ask stays answerable by a bare digit. |

## LLM wiki (Phase W, ADR 0020)

Durable per-topic knowledge pages built from a turn's quarantined read digests and cross-source
verified by the reader seat (`wiki_build` / `wiki_refine` bridge tools, armed by the flag).
SQLite is truth; `memory/wiki/<slug>.md` is the render.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_WIKI_ENABLED` | off | Arms the wiki tools, retrieval and the decay tick. Accepts 1/true/yes/on. |
| `HOUGE_WIKI_MIN_SOURCES` | `2` | Distinct source URLs required in the turn before a page saves. |
| `HOUGE_WIKI_VERIFY_PASSES` | `2` | Verify ensemble size (mean of independent passes). |
| `HOUGE_WIKI_MAX_PAGES` | `200` | Global active-page cap; overflow prunes the lowest `reuse_value` rows reversibly. |
| `HOUGE_WIKI_RETRIEVE_CAP` | `1` | Max pages folded into one turn's context. |
| `HOUGE_WIKI_MIN_COSINE` | `0.42` | Relevance gate for pages: with a query embedding a page enters only at cosine at least this; without one only FTS hits (the topic-identity "all" mode drops stopwords only, short tokens kept). `0` = the pre-A1 pool and floor. |
| `HOUGE_WIKI_RECENCY_HALFLIFE_DAYS` | `30` | Retrieval recency half-life. |
| `HOUGE_WIKI_DECAY_DAYS` | `45` | Days unused before a page's reuse decays (A1: decay never prunes a page); the prune line is `HOUGE_LESSON_PRUNE_THRESHOLD` for the lessons |

## Global autonomy circuit-breaker

A durable cross-run **breaker** (not a throttle) over a rolling 24h window — the
safety floor for the always-on daemon. Once any cap is reached, new run admissions
are **refused** at the Gateway with a `global_budget_fuse` ledger event and exactly
one deduped Telegram alert per fuse episode; admissions re-arm automatically as the
window clears. Status/approve/deny are never blocked. Rationale and design:
[ADR 0003](../decisions/0003-global-budget-breaker.md).

| Variable | Default | Axis | Protects against |
|----------|---------|------|------------------|
| `HOUGE_GLOBAL_MAX_RUNS_24H` | `200` | Volume (how many jobs) | Looping schedules, re-enqueue bugs, command floods. |
| `HOUGE_GLOBAL_MAX_TOOL_CALLS_24H` | `1000` | Cost (compute/$) | Aggregate LLM/tool spend across all runs — e.g. a single run that burns thousands of calls. |
| `HOUGE_GLOBAL_MAX_GATED_ATTEMPTS_24H` | `100` | Risk (dangerous intent) | Repeated attempts at approval-requiring actions (bad lesson, injection, loop) and the approval-prompt spam they cause. |

**Re-tune `tool_calls` for omp (2026-10).** Set `HOUGE_GLOBAL_MAX_TOOL_CALLS_24H=3000` in `.env`: 3×
the code default of 1000, or 3× your current override if you already set one. Under omp more work
writes `tool_finished` rows. Every bridge call counts, `bash` included, and so does every built-in
`fs_write` gate. The per-run cap also rose from 14 to 40. Only `fs_read` is gated without counting.
The old ceiling would trip on ordinary agentic days. The operator sets it in `.env` before the cutover
kickstart, then re-sets it from the first week's numbers. The code default is unchanged.

Defaults live in `DEFAULT_GLOBAL_BUDGET_CAPS` (`src/budget/global-budget-ledger.ts`);
a missing or non-numeric override falls back to the default. `/status` surfaces
per-cap headroom (used/limit/remaining), run counts by state, and the last error.

## Metered-API $ ceiling (ADR 0019)

> **Dormant since 2026-10.** No metered leg exists after the omp cutover: every seat runs on
> subscription OAuth, and voice runs on the flat-rate `agy-cli` leg. The ceiling code and these
> variables stay for a future metered leg ([ADR 0019 amendment](../decisions/0019-metered-ceiling.md)).

The count caps above bound volume; this bounds **dollars** on the pay-per-token legs
(today only TypeSafe `jev`, used by the Jev replay below and priced input-only; the
`kimi-api`/`gemini-api` legs the ceiling was built for were deleted with the omp cutover). Every metered `llm_attempt` is priced in the audit sink — the one
seam every path shares since slice 2 (`RunStore.llmAuditSink` → `src/llm/metered-pricing.ts`) —
into the ledger's `cost_usd`; spend is derived by summing the ledger (unioned with the
pre-cutover `llm_call` history). Every adapter, including the three CLI commands, honors a
latched fuse. On breach the metered legs are **dropped** (subscription legs keep working) and ONE
deduped Telegram alert fires per episode. `/status` shows
`Metered: $d.dd/$D.DD 24h, $m.mm/$M.MM month`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOUGE_METERED_DAILY_USD` | `5` | Ceiling over a rolling 24h window (USD). `0` = hard off (metered legs always dropped). |
| `HOUGE_METERED_MONTHLY_USD` | `50` | Ceiling over the calendar month, UTC — how the invoice actually resets. |
| `HOUGE_METERED_PRICES_JSON` | seed table | JSON object of model-id **prefix** → `{input_usd_per_mtok, output_usd_per_mtok, cached_input_usd_per_mtok?}`, merged over the seed table (longest prefix wins). A metered model matching NO prefix logs once and its spend is invisible until priced. |

## Multimodal ingest — voice notes and photos (spec 2026-09-29)

With `HOUGE_MEDIA_INGEST_ENABLED` on, a Telegram **voice note** becomes the turn's message (transcribed
on the flat-rate agy leg; the reply opens with `🎙 I heard: “…”` so a mis-hearing is visible) and a
**photo** is read by the omp media seat (`HOUGE_OMP_MEDIA`, audited as `reader`): its digest (`[external source — untrusted-derived
summary]`, with `contains_instructions`) is appended to the caption. Video, documents and stickers
are still answered with the "not yet" acknowledgement. The bytes live in a temp dir for one call and
never enter the DB; one `media_ingested` ledger row per media turn carries kind, status and counts only.

| Variable | Default | Meaning |
|---|---|---|
| `HOUGE_MEDIA_INGEST_ENABLED` | off | Arms the ingest step. Accepts 1/true/yes/on; read per poll; in `DISARM_FLAGS`. |
| `HOUGE_LLM_MEDIA_PROVIDERS` | `agy-cli` | Voice only. The voice chain; `agy-cli` is the only leg that hears audio. Any other name (a stale `pi`) is dropped with one warning. Photos use `HOUGE_OMP_MEDIA`. |
| `HOUGE_LLM_TIMEOUT_MS_MEDIA` | `45000` | Voice only. Per-leg timeout for the agy transcription call. The whole stage is capped at 150 s, before the turn's deadline. |

Caps: 10 MB per file, 300 s per voice note. A failure (too large, download, no leg, empty, timeout)
fails the turn with a one-line reply and a `media_ingested` row; resend to retry.

```bash
node scripts/live-gate-media.mjs   # opt-in: four real turns in memory on the omp planner; voice on agy, photos on omp
```

## Jev intent shadow — replay and live shadow (spec 2026-09-25)

> **Dormant since the omp cutover (2026-10).** The classifier call is gone, so the live shadow has
> nothing to shadow. `HOUGE_JEV_SHADOW_ENABLED` has left `DISARM_FLAGS`, and no caller reads its
> resolver. The replay still reads historical rows.

[Jev](https://docs.typesafe.ai/llms.txt) (TypeSafe's "System One" model) answers typed questions
with calibrated probabilities; it does not generate text. The question under test: can Jev take
over the intent label that `classifyIntent` currently spends a ~6 s CLI call on? The **replay**
answers it offline, with no daemon change: for every historical user turn it rebuilds the thread
as it stood at classification time, asks Jev AND the current LLM classifier the same question on
identical inputs, and prints a GO/STOP report (spec:
`docs/superpowers/specs/2026-09-25-jev-intent-shadow-design.md`).

```bash
houge jev-shadow replay --dry-run          # pre-flight: counts + estimated cost, calls nothing
houge jev-shadow replay                    # resumable; re-run to continue after a stop
houge jev-shadow replay --since 2026-09-01T00:00:00Z --limit 50 --max-usd 0.2
node scripts/live-gate-jev.mjs             # opt-in real-API gate (3 fixed messages, in-memory store)
```

- **Output:** `.houge/jev-shadow/replay.jsonl` (git-ignored) — labels, probabilities, confidence,
  `jev_model`, a fixed error category; **never message text**. The report prints turn ids only.
- **Verdict:** GO when Jev agrees with the replayed LLM label ≥ 75% at Jev confidence ≥ 0.7 and
  ≥ 60% of eligible turns reached a matched pair; `INCOMPLETE` if the run stopped early (budget,
  auth, fuse); `DRY RUN — no verdict` for a dry run. Only answers from the pinned `jev-1.13.0`
  count toward the verdict; the report splits by model and language.
- **Egress:** the latest message (≤ 8,000 chars) plus the thread the classifier already sees,
  ≤ 24,000 chars per request; over-cap turns are skipped, never truncated.
- **Audit:** every Jev HTTP attempt is one `llm_attempt` row (`provider: "jev"`, role
  `classify_replay`; the replayed classifier is `classify_replay_llm`). Both replay roles are
  excluded from the `llm_leg_failing` sweep, so an operator run cannot open daemon incidents.
- **Cost guard:** Jev honours the metered fuse before every attempt; `--max-usd` (default `1`)
  reserves each request's estimate before dispatch. The 2026-09-26 run over 374 turns cost $0.035.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TYPESAFE_API_KEY` | — | Broker secret #9. Held by the secrets broker when the firewall is armed (stripped from `process.env` like every `*_API_KEY`); sent only as the `Authorization` header to `api.typesafe.ai`; never logged. Unset → every Jev call is audited `unavailable`/`auth` and the replay stops. |
| `HOUGE_JEV_SHADOW_ENABLED` | off | **Dormant, superseded by [ADR 0029](../decisions/0029-jev-system-one.md).** Arms the live intent shadow. Accepts 1/true/yes/on; read per turn; in `DISARM_FLAGS`. On without `TYPESAFE_API_KEY` → one boot warning and the shadow stays off. |

**Live shadow** (flag-gated, default OFF). With `HOUGE_JEV_SHADOW_ENABLED` on, every real
`classifyIntent` also asks Jev the same question, **concurrently and never awaited**: the turn uses
the classifier's label exactly as before, and Jev's answer is written to the ledger only (one
`intent_shadow` row per classified turn: `status`, the classifier's raw `llm_intent`, `llm_parsed`,
`lang`, Jev's label/confidence/model/latency or a code-owned `jev_error` — never message text). The
Jev call is audited as `llm_attempt` role `classify_shadow` (5 s timeout, no retries, metered fuse);
a rejected key opens an `llm_leg_failing` incident for subject `jev` at the next invariant sweep
(12 h cadence). `/disarm` turns it off (the flag
is in `DISARM_FLAGS` and read per turn).

```bash
houge jev-shadow report                    # PROMOTE / HOLD / KILL per language
houge jev-shadow report --since 2026-10-01T00:00:00Z   # narrows the evaluated rows; tenure still counts from the first shadow row
```

The verdict per language is HOLD until ≥ 60 matched turns and ≥ 28 days since the first shadow row,
then PROMOTE only if Jev agrees with the classifier ≥ 90% at confidence ≥ 0.7 on ≥ 60% of that
language's turns (else KILL). The report also prints the costly direction (Jev overruling a
`research` call) and clarify agreement, which never gate. Promotion itself is a separate spec.

## Jev System One (ADR 0029)

Jev answers typed questions before the planner runs; code owns every threshold and the fall-through. Lane 1 is
the pre-planner triage: a pure memory instruction is saved on the ticks seat and answered with an undoable card, and
a status question is answered from code. Everything defaults **off**. The flow, lane table and how to read a `triage`
row: [jev-decision-layer.md](jev-decision-layer.md). Needs `TYPESAFE_API_KEY` (above); without it the first armed turn
opens a `jev_no_key` incident and the planner runs as today.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_JEV_ENABLED` | off | Master switch. Accepts 1/true/yes/on; read per turn; in `DISARM_FLAGS` (`/disarm` forces it off). Off overrides every lane flag. |
| `HOUGE_JEV_TRIAGE_ENABLED` | `off` | `off` \| `shadow` \| `arm`. `shadow` asks Jev and writes rows only; the planner runs exactly as today. `arm` lets a calibrated verdict act. Any other value (including `/disarm`'s `false`) reads as `off`. |
| `HOUGE_JEV_TRIAGE_MIN_CONF` | `0.7` | Confidence floor on the `lane` answer. Out-of-range or non-numeric falls back to the default. |
| `HOUGE_JEV_TRIAGE_MIN_PURE` | `0.8` | Bar on `p(pure)` for the memory lane to skip the planner (below it, a `mixed` verdict saves and informs the planner). |
| `HOUGE_JEV_TRIAGE_MIN_STATUS` | `0.8` | Bar on `p(status)` for the code-rendered status reply. |
| `HOUGE_JEV_DISARM_PATH` | `<dataDir>/houge.jev-disarmed` | Auto-disable marker. Code writes it when `triage_overrides` fires and caps `arm` at `shadow` while it exists. **Re-arming is Paco deleting the file**; nothing else clears it. |
| `HOUGE_JEV_CALIBRATION_FILE` | unset | **Gate only.** A JSON array of calibration rows for the live gate or a labelled DB copy. Outside `HOUGE_JEV_GATE=1` a set file caps `arm` at `shadow`. Never set it in the daemon's `.env`. |
| `HOUGE_JEV_GATE` | unset | Set to `1` by `scripts/live-gate-jev-triage.mjs` only; lifts the file cap above for that process. Never set in the daemon's `.env`. |

**Calibration rows are code, not env.** `CALIBRATED_ROWS` in `src/jev/calibration.ts` ships **empty**, so the lane
cannot act until Paco commits rows after the replay report prints its "ROWS TO ADD" block. A row is keyed by
`(question_id, criteria_hash, model, lang)`. The memory lane arms on the three rows `lane`, `complete` and `scope`.
The status lane arms **independently** on a distinct pseudo-row `question_id: "lane:status"` (its criteria hash is the
`lane` question's): the two lanes clear different bars, so one row never arms both. A criteria or model change
invalidates the matching rows and the question re-enters shadow.

**Ledger events** (run ledger; ids, enums and numbers only, never message text): `triage` (one per eligible turn,
the denominator), `ack_nudged`, `lesson_saved`, `lesson_change_undone`, `triage_override`.

**Incidents** (the first failure opens one and alerts Paco): `jev_auth`, `jev_rate_limited`, `jev_overloaded`,
`jev_question_invalid`, `jev_no_key`, `triage_overrides` (the override rate crossed the auto-disable bar),
`triage_threw`. The next answered Jev call resolves any open `jev_*` incident, and `triage_overrides` resolves on the
next turn once the disarm marker is gone, so a later episode opens and pages again (flap-damped). Jev is excluded from
`llm_leg_failing`; its failures surface as these instead. `LlmErrorKind` gains
`rate_limited`, `overloaded`, `malformed_question`.

**Tables:** `jev_decisions` (one row per answered or skipped question: ids, probabilities, thresholds, outcome) and
`lesson_changes` (the change set behind a memory-lane save, which the Undo tap reverses).

**CLI** (state under `.houge/jev-triage/`, git-ignored):

```bash
houge jev replay triage --dry-run               # pre-flight: counts and estimated cost, calls nothing
houge jev replay triage [--max-usd N] [--limit N] [--permute]   # resumable; --permute re-asks with options reordered
houge jev label triage --sample=40              # labelling sitting; the = form only ("--sample 40" is rejected)
houge jev report triage                         # per-language verdict, Wilson bounds, ROWS TO ADD
node scripts/live-gate-jev-triage.mjs           # opt-in: real Jev + Kimi on a copy of the live DB (27 checks)
```

Replay universe on a live-DB copy (2026-10-06): 293 Telegram turns since 2026-07-02, estimated $0.033.

## Kill switch + disarm posture (ADR 0018)

`/kill` writes a tombstone; the boot gate then **parks** the daemon (launchd `KeepAlive`
relaunches into an idle process — never a live agent) until the file is manually deleted.
`/disarm` writes a posture file that forces the evolution/scheduler flags to `false` live
and on every restart (applied BEFORE `.env`, so it outranks it); `/rearm` deletes it.
Revival steps: [deploy/launchd/README.md](../../deploy/launchd/README.md#kill-switch--revival-adr-0018).

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOUGE_TOMBSTONE_PATH` | `houge.kill` (cwd) | Where `/kill` writes and the boot gate reads the tombstone. A present-but-corrupt file still kills (fail-closed). |
| `HOUGE_PARK_MARKER_PATH` | `houge.parked` (cwd) | Written by the parked daemon beside the tombstone, read by the invariant sweep after revival so the heartbeat gap is classified as a deliberate park (logged, no incident) rather than a crash, removed on the first successful poll cycle. Not a stop switch — deleting it revives nothing. |
| `HOUGE_DISARM_PATH` | `houge.disarm` (cwd) | Where `/disarm` writes the posture. Must be a REAL env var if moved — it is read before `.env` is loaded. |

## DB backup (ADR 0021)

WAL-safe periodic snapshot of `houge.sqlite` riding the daemon poll loop: `VACUUM INTO`
a `.tmp` path, `PRAGMA quick_check` gate, rename into `backups/houge-<stamp>Z.sqlite`,
prune to the newest K. Fail-open (a failed snapshot logs `db_backup_failed` and retries
next tick — never breaks the daemon). **Local-only** — see the restore runbook in
[README § Backup & restore](../../README.md#backup--restore).

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOUGE_BACKUP_ENABLED` | `false` | Master arm for the backup tick (accepts 1/true/yes/on). |
| `HOUGE_BACKUP_INTERVAL_HOURS` | `24` | Hours between snapshots (latch advances only on a verified snapshot). ≤0/garbage → default. |
| `HOUGE_BACKUP_KEEP` | `7` | Newest snapshots kept by retention; older ones unlinked. Min 1. |

## Removed 2026-10 (omp cutover)

These variables are no longer read anywhere in `src/`. They can be deleted from `.env`, and a
leftover value is ignored. The list is every name read in `src/` at `e626e94` (the commit before
the cutover deletions) and not at the head of `feat/omp-runtime`, checked by grepping for
`env.NAME`, `env["NAME"]` and the quoted name.

| Removed | Was | Now |
|---------|-----|-----|
| `HOUGE_LLM_PROVIDERS` | The provider chain | `HOUGE_OMP_PLANNER` and the other `HOUGE_OMP_*` seat chains |
| `HOUGE_LLM_READER_PROVIDERS` | The reader chain | `HOUGE_OMP_READER` |
| `HOUGE_DUAL_LLM_ENABLED` | Armed the quarantined reader | The wall is unconditional (ADR 0014 amendment) |
| `HOUGE_LLM_MODEL_PI` · `HOUGE_LLM_MODEL_KIMI` · `HOUGE_LLM_MODEL_GEMINI` | Per-provider models | The model sits in each `HOUGE_OMP_*` string |
| `HOUGE_LLM_TIMEOUT_MS` · `HOUGE_LLM_TIMEOUT_MS_<PROVIDER>` (`_PI`, `_AGY`, `_KIMI`, `_GEMINI`) | Per-provider timeouts | `HOUGE_OMP_ONESHOT_TIMEOUT_MS`; voice keeps `HOUGE_LLM_TIMEOUT_MS_MEDIA` |
| `HOUGE_PI_ENV_PASSTHROUGH` | pi child env | `HOUGE_OMP_ENV_PASSTHROUGH` |
| `HOUGE_KIMI_BASE_URL` · `HOUGE_KIMI_MAX_TOKENS` | kimi-api leg | Kimi Code OAuth inside omp |
| `HOUGE_GEMINI_BASE_URL` · `HOUGE_GEMINI_MAX_TOKENS` | gemini-api leg | Google Antigravity OAuth inside omp |
| `HOUGE_KIMI_CLI_BIN` · `HOUGE_KIMI_CLI_MODEL` · `HOUGE_KIMI_CLI_TIMEOUT_MS` | kimi-cli reviewer | `HOUGE_OMP_REVIEWER` |
| `HOUGE_CLAUDE_BIN` · `HOUGE_RADAR_CHAIR_TIMEOUT_MS` | claude-CLI panel chair | `HOUGE_OMP_CHAIR`, `HOUGE_OMP_ONESHOT_TIMEOUT_MS` |
| `HOUGE_BOUNTY_ENABLED` · `HOUGE_BOUNTY_MAX_CANDIDATES` | Money track, `bounty_scan` | Deleted ([ADR 0022 amendment](../decisions/0022-money-fork-reopened.md)) |
| `HOUGE_EXTWORK_ENABLED` · `HOUGE_EXTWORK_IMAGE` · `HOUGE_EXTWORK_MEMORY` · `HOUGE_EXTWORK_CPUS` · `HOUGE_EXTWORK_PIDS` · `HOUGE_EXTWORK_SIZE_CAP_MB` · `HOUGE_EXTWORK_SCRATCH_DIR` · `HOUGE_EXTWORK_CLONE_TIMEOUT_MS` · `HOUGE_EXTWORK_STAGE_TIMEOUT_MS` | External workspace | Deleted ([ADR 0023 amendment](../decisions/0023-external-workspace.md)) |

Still parsed but inert: `HOUGE_JEV_SHADOW_ENABLED` (superseded by ADR 0029). Its resolver in `src/jev/shadow.ts` survives, but
nothing calls it. Secrets with no consumer: `KIMI_API_KEY`, `GEMINI_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN` (see [Secrets firewall](#secrets-firewall-adr-0015-phase-1)).

These were documented here but unread even before the cutover, and their rows are gone too:
`HOUGE_LLM_PROVIDER`, `HOUGE_CLAUDE_MODEL`, `HOUGE_CLAUDE_WRITER_MODEL`,
`HOUGE_CLAUDE_REVIEWER_MODEL`, `HOUGE_CLAUDE_TIMEOUT_MS`.
