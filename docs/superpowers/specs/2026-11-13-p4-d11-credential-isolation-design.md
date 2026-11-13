# P4 (D11) — model logins leave the planner; the Workspace token never enters omp

**Rev 1.1 · 2026-11-13 · status: REVIEWED, for Paco's approval.** Rev 1.0 was reviewed by spec-review-senior (Fable 5.2:
2 BLOCKER, 9 WARNING, 2 SUGGESTION) and a codex design pass (3 BLOCKER, 3 WARNING, 1 SUGGESTION), both against the live
code and omp 18.19.0's sources; every finding was checked first-hand and all are taken (change log §9). Direction approved
by Paco in chat 2026-11-13. Changes the meaning of ADR 0032 D11 and ADR 0015's D11 text (Tier C: Paco signs).

**Why.** ADR 0032 D11 accepted, until SP3, that the planner process must read its own OAuth store
(`~/.omp/profiles/houge/agent/agent.db`): omp reads its logins there, so the Seatbelt profile cannot deny it to that
process, and only the policy hook keeps omp's `read` tool off it. That store holds the refresh tokens for the four
subscription logins (anthropic, openai-codex, google-antigravity, kimi-code). P3 would add a Google Workspace grant
(`gmail.compose`, Calendar) whose token can send mail through the REST API. The 2026-11-12 direction review made D11 a
precondition of P3 shipping an action. This spec closes D11 for the model logins and sets the rule for the Workspace
token before P3 is specced.

## 1. Decisions (Paco, in chat, 2026-11-13)

| # | Question | Decision |
|---|---|---|
| P4-1 | Scope of this spec | **D11 only.** ADR 0035 R1 (memory provenance) and agy's `search_web` auto-allow get their own specs under P4. |
| P4-2 | Where do the model logins live? | **An omp auth broker (the vault) plus an omp auth gateway**, each under its own omp profile. Every omp process Houge starts calls models through the gateway with one scoped token and holds no login. |
| P4-3 | Where does the Workspace token live? | **Daemon-side**, as `gmail_read`'s grant does today (ADR 0015): a bridge tool calls Google's MCP endpoint; no Workspace credential reaches any omp process. This replaces the 2026-11-09 "Workspace MCP inside omp" shape; P3's own spec builds the bridge. |

Rejected after a source read and a live probe (2026-11-13): broker only (the planner would still hold one-hour access
tokens and a bearer that can mint them, since a broker bearer is unscoped); a separate macOS user (heavy, breaks the test
gate's tooling per the 2026-10-28 measurement, and alone leaves the logins in the planner's process).

## 2. Assets and the bar

| Asset | Today | After |
|---|---|---|
| Model refresh tokens | in the `houge` profile's `agent.db` | only in the vault's `agent.db` |
| Model access tokens | in the planner process and `agent.db` | only in the gateway process (and the vault) |
| Old token bytes | — | none in the `houge` profile's `agent.db*` files (hard delete + `VACUUM` + WAL truncate, §4.5) |
| Default-profile store `~/.omp/agent/agent.db` | exists; readable under `planner.sb` (the gate denies it) | denied to `planner.sb` too |
| Workspace token (P3) | not issued yet | only in the daemon's secret broker (ADR 0015) |
| Gateway client token | — | in the env of the omp processes Houge starts; scoped to the four model providers; never in a child of theirs |

**Bar (checkable):** no credential row (any `disabled_cause`, any provider, including `mcp_oauth:*`) and no token bytes
in the `houge` profile's store files; no file `planner.sb` or `shell.sb` can open holds a provider or Workspace token;
the planner cannot write any file omp loads as config or code; a planner turn runs on each of the four providers.

## 3. Non-goals

- agy-cli (voice) and codex (self-write writer) keep their own CLI logins; they are not omp and not in D11.
- No change to D12 (`bash` posture, network on) or to the policy hook's tool set.
- No separate macOS user (SP3 keeps that as the step beyond this).
- P3's bridge tool, scopes and approvals: P3's spec.

## 4. Design

### 4.1 Components

| Unit | What it is | Runs as |
|---|---|---|
| vault | `omp --profile houge-vault auth-broker serve --bind 127.0.0.1:<vault port>`; holds the four logins; refreshes them; the Kimi overrides (`KIMI_CODE_OAUTH_HOST`, `KIMI_CODE_BASE_URL`) are in its env (refresh runs here) | launchd agent `com.houge.omp-vault`, KeepAlive, fixed `WorkingDirectory` inside its profile |
| gateway | `omp --profile houge-gateway auth-gateway serve --bind 127.0.0.1:<gateway port> --clients <gateway profile>/clients.json`; a broker client of the vault (`OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN` in its env, read by a wrapper from the vault's token file) | launchd agent `com.houge.omp-gateway`, KeepAlive, fixed `WorkingDirectory` inside its profile |
| `houge` profile | unchanged dirs; `agent/models.yml`, written only by the daemon, routes the four providers to the gateway (`transport: pi-native`, `baseUrl` = gateway, `apiKey: HOUGE_OMP_GATEWAY_TOKEN`, an env name, never a `!command`); zero credential rows | every omp process Houge starts |

`clients.json` has one entry, `houge`: `tokenSha256` of the client token, `models` = `anthropic/*`, `openai-codex/*`,
`google-antigravity/*`, `kimi-code/*`. Any other token, or any other model, is refused by the gateway. The file sits in
the gateway's profile dir, which both Seatbelt profiles deny.

### 4.2 Spawn inventory and the token

| Spawn | Site | Gets the gateway token | Gets the `--config` overlay |
|---|---|---|---|
| planner (`--mode rpc`) | `src/omp/planner-session.ts:66` | yes | yes (today) |
| one-shot seats (`-p --mode json`) | `src/llm/providers/omp.ts` | yes | **yes (new; closes a 5.1 (k) gap: today they load none)** |
| catalog (`models --json`) | `src/omp/model-catalog.ts`, callers `core-worker.ts:529`, `idea-panel-seats.ts:47`, `omp-probe-cli.ts:60` | yes | yes (new) |
| version (`--version`) | `src/omp/omp-version.ts` | **no** (asserted) | no |
| live-gate and probe scripts that pass `--profile` | `scripts/*` | yes, through the same helper | yes |

- One helper, `ompChildEnv(cfg, secrets)`, builds every omp child env: `buildChildEnv(passthrough)` plus
  `HOUGE_OMP_GATEWAY_TOKEN` from a typed getter on the secret broker (`SecretBroker.ompGatewayToken()`), lifted at boot
  like the Gmail secrets, redacted from egress. With the firewall flag off, the getter reads the value from the env
  before the strip; either way the value is passed explicitly, never inherited.
- Missing or empty token: the helper throws, the spawn does not happen, and an alerted incident
  `omp_gateway_token_missing` opens (omp would otherwise send the variable's name as the key and fail later with a 401).
- `CHILD_ENV_NEVER` gains `HOUGE_OMP_GATEWAY_TOKEN`, so no passthrough hands it to `bash` (`shell-adapter.ts:94`) or any
  other CLI.
- `KIMI_CODE_*` leave `HOUGE_OMP_ENV_PASSTHROUGH`'s default (they are only needed where refresh runs: the vault).

### 4.3 Floors (ADR 0032 §5.1, new rule (m))

- `planner.sb`: deny read and write of all of `~/.omp`, then re-allow by literal path only what the planner's omp opens
  (task 0 item 4 lists it; expected: the `houge` profile's DBs and their `-wal`/`-shm`, `sessions`, `cache`, `logs`,
  `run`). Inside the `houge` profile, writes stay denied to every file omp loads as config or code: `models.yml`,
  `config.yml`, and the extension, tool, hook, plugin, rule and skill dirs. The vault and gateway profiles, the default
  profile's `agent/`, and every token file stay denied by default-deny.
- `shell.sb` and the gate already deny all of `~/.omp`; tests pin that the vault, gateway and default-profile dirs are
  covered.
- Store check, at daemon boot **and before every planner spawn**: the daemon (unsandboxed) opens the `houge` profile's
  `agent.db` read-only and counts `auth_credentials` rows of any `disabled_cause`. Any row opens an alerted incident
  `omp_planner_store_has_credentials`, and planner and one-shot spawns are refused until Paco clears it (fail closed:
  D11 would be silently back, e.g. after someone follows the old login procedure).
- `deploy/launchd/README.md`'s login procedure changes to `omp --profile houge-vault auth-broker login <provider>`.

### 4.4 Availability and errors

- A configured gateway never falls back to local logins, so a dead vault or gateway fails every model call.
- launchd KeepAlive restarts both. Health is an authenticated `GET /v1/models` on the gateway that must list all four
  providers, plus the vault's `/v1/healthz` (the gateway's `/healthz` is static and misses a dead vault, a revoked grant
  or a rejected clients file). It runs at boot, before a planner spawn when the last check is older than 5 minutes, and
  after any turn that fails with a gateway error. Down → one alerted incident `omp_gateway_down`, deduped per outage,
  cleared on recovery. `/status` shows the result in one line.
- Version skew: the gateway's `/healthz` version must equal `omp --version`; a mismatch opens `omp_gateway_version_skew`.
  The omp upgrade runbook restarts both agents.
- `src/omp/omp-frames.ts` gains a `gateway` error kind, matched before `model_missing`, `auth` and `transport`: an
  out-of-grant "Unknown model", a 401/403 from the gateway's URL, or a refused connection to it. The turn-failure
  message names it.

### 4.5 Cutover (the irreversible step comes last)

1. Paco logs in the four providers on the vault: `omp --profile houge-vault auth-broker login <provider>` (fresh grants;
   the live `houge` rows keep working).
2. Start vault and gateway under launchd. Task 0's checks pass against them.
3. Check `houge.parked` / `houge.kill` and no run in flight; ship the code; the daemon writes `models.yml` in the `houge`
   profile, with the old rows still present. A config `apiKey` beats local OAuth and `pi-native` dispatches to the
   gateway, so turns now use the gateway. The full live gate except its store leg must pass, including gateway request
   logs showing every provider. **Rollback here:** remove `models.yml`; nothing else changed.
4. Stop the daemon. Paco confirms the delete (it cannot be undone; the old grants stay valid at the providers unless
   revoked, task 0 item 7). Hard delete every `auth_credentials` row, `VACUUM`, `PRAGMA wal_checkpoint(TRUNCATE)`.
5. Start the daemon; the store check must read zero rows; the full live gate, including the byte scan, must pass; smoke
   on both builds.

**Rollback after step 4** puts logins back into `houge` and reopens D11. It is not a runbook step: it is a Tier C
decision by Paco, recorded as an incident, with ADR 0032 D11 set back to "accepted, reopened <date>" until fixed.

## 5. Task 0 — probe before any code

On scratch profiles and ports, never the live `houge` profile. Fail on items 1–4 or 6 stops the slice and comes back to
Paco; items 5 and 7 produce a residual for Paco to accept or reject.

1. Each of the four subscription logins completes a streamed turn through the gateway (`pi-native`), including
   openai-codex's websocket path and kimi-code. Kimi's device id is per agent dir: measure whether a vault login used
   from the gateway is accepted; if not, vault and gateway share one profile.
2. `omp --mode rpc` with the routing and zero credential rows starts, runs a tool turn, and `models --json` lists the
   models today's role heads name (diff against today's output).
3. A settings layer in the workspace or the cwd cannot override the routing (ADR 0032 5.1 (k) residual), and the
   `--config` overlay keeps its keys for one-shots and the catalog.
4. Every file under `~/.omp` the planner's omp opens and writes (fs_usage or a deny-by-default trial), to write the
   literal re-allow list of §4.3.
5. Whether a sandboxed same-uid process can attach to the gateway or vault process (task_for_pid / lldb) and read its
   memory.
6. The gateway refuses: no token, wrong token, a model outside the grant; and scoped clients get 403 on the usage and
   credential routes.
7. Whether each provider lets Paco revoke the old `houge` grants after step 4.

## 6. ADR changes (same branch as the code)

- ADR 0032 D11: from "accepted until SP3" to **closed by §5.1 (m)** for the model logins; history row names this spec.
  Until the code ships, D11 reads "to be changed, spec 2026-11-13-p4-d11".
- ADR 0032 §5.1 (m), new. Hermetic test `tests/adr/0032-5.1m-planner-holds-no-login.test.ts`: the rendered profiles
  (the `~/.omp` default-deny, the literal re-allows, the config/code write denies, the vault/gateway/default dirs
  denied); `HOUGE_OMP_GATEWAY_TOKEN` in `CHILD_ENV_NEVER`; every `--profile` spawn site goes through `ompChildEnv` and
  the version spawn does not; the store check on fixture DBs (zero rows ok; a disabled row, an `mcp_oauth` row → refuse).
  Live state (rows, bytes, provider turns) is the live gate's.
- ADR 0015: the child-env rule ("no broker secret enters a child env") gains the one named exception, the scoped
  gateway token into omp children; its D11 paragraph follows ADR 0032. Its conformance tests change in the same commit.
- ADR 0025: a Workspace grant is daemon-side only; no `mcp_oauth:*` row and no MCP server in any omp profile or config
  (the store check counts them; a test pins that the overlay names no MCP server).
- ROADMAP SP3: the auth-broker item is done; the separate macOS user stays.

## 7. Tests and live gate

- Unit: profile render; `ompChildEnv` (token present, missing → throw + incident, never via passthrough); the spawn
  inventory of §4.2; the store check at boot and pre-spawn; health check and dedupe; version skew; the `gateway` error
  kind ordering.
- `scripts/live-gate-credential-isolation.mjs`, PASS only if all hold: zero credential and `mcp_oauth` rows in the live
  `houge` store; a byte scan of `agent.db*` finds no token material (no `sk-ant-`, `ya29.`, JWT or refresh-token prefix
  from any provider); one planner turn per provider, each seen in the gateway's request log (a turn that did not reach
  the gateway is FAIL); `sandbox-exec` under both live profiles cannot read the vault, gateway or default-profile dirs or
  any token file, and cannot write `models.yml` or `config.yml`; the gateway refuses no-token, wrong-token and
  out-of-grant requests; a `bash` child's env lacks the gateway token.

## 8. Residuals (Tier C, for Paco to accept or reject)

- The gateway token sits in the omp processes Houge starts: a steered planner can make model calls through the gateway,
  which it can do today anyway; it cannot obtain a provider token.
- Vault, gateway and daemon run as the same macOS user. The profiles deny the files; process memory is guarded by macOS
  same-user rules (task 0 item 5 measures it). SP3's separate user remains the step beyond this.
- If a provider cannot revoke the old grants (task 0 item 7), the deleted refresh tokens stay valid at that provider
  until they expire; after step 4 no copy exists on this Mac.
- If the gateway or vault is down, Houge cannot think until launchd restarts it; the alert is the mitigation.

## 9. Change log (rev 1.0 → 1.1)

| Finding | Source | Change |
|---|---|---|
| omp deletes are soft; WAL keeps bytes | Fable B1, codex B1 | §4.5 step 4 hard delete + `VACUUM` + WAL truncate; byte scan in the gate; old-grant revocation as task 0 item 7 and a residual |
| planner can write profile config; `!command` `apiKey`; one-shots unsandboxed | Fable B2, codex B2 | §4.3 `~/.omp` default-deny with literal re-allows and config/code write denies; §4.2 one-shots and catalog get the overlay |
| rollback reopens D11 | codex B3 | §4.5: rollback after the delete is a Tier C decision with an incident and an ADR state |
| delete before first live proof | Fable W1 | §4.5 reordered: route with rows present, gate, then delete |
| token injection at one site only; broker has no getter | Fable W2, codex W1 | §4.2 inventory, `ompChildEnv`, typed getter, firewall-off behaviour, missing token fails closed |
| Kimi overrides in the wrong process; device id | Fable W3 | §4.1 vault env; task 0 item 1 |
| `/healthz` static; spawn failure never fires | Fable W4 | §4.4 authenticated `/v1/models` + vault health; triggers |
| gateway errors misclassified | Fable W5 | §4.4 `gateway` error kind |
| rule (m) not checkable as written; boot-only check | Fable W6, codex W3 | §6 hermetic vs live split; store check before every spawn |
| token files are per profile; default store missing | Fable W7 | §2 and §4.3 |
| version skew | Fable W8 | §4.4 |
| catalog drift | Fable W9 | task 0 item 2 |
| `--version` spawn; imprecise inventory | codex W2 | §4.2 table |
| ADR 0015 contradicts | codex S1 | §6 |
| clients file location, `WorkingDirectory`; task 0 consequences | Fable S1, S2 | §4.1; §5 preamble |
