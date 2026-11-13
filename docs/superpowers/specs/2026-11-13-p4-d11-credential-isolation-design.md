# P4 (D11) — model logins leave the planner; the Workspace token never enters omp

**Rev 1.0 · 2026-11-13 · status: DRAFT, for spec-review-senior + codex design pass.** Direction approved by Paco in chat
2026-11-13 (decisions below). Changes the meaning of ADR 0032 D11 (Tier C: Paco signs the ADR amendment).

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
| P4-2 | Where do the model logins live? | **An omp auth broker (the vault) plus an omp auth gateway**, each under its own omp profile. The planner calls models through the gateway with one scoped token and holds no login. |
| P4-3 | Where does the Workspace token live? | **Daemon-side**, as `gmail_read`'s grant does today (ADR 0015): a bridge tool calls Google's MCP endpoint; no Workspace credential reaches any omp process. This replaces the 2026-11-09 "Workspace MCP inside omp" shape; P3's own spec builds the bridge. |

Chosen after a source read and a live probe (2026-11-13, omp 18.19.0); options rejected: broker only (the planner would
still hold one-hour access tokens and a bearer that can mint them), a separate macOS user (heavy, breaks the test
gate's tooling per the 2026-10-28 measurement, and still leaves the logins in the planner's process).

## 2. Assets and the bar

| Asset | Today | After |
|---|---|---|
| Model refresh tokens | in the planner profile's `agent.db` | only in the vault's `agent.db`; no planner-reachable path |
| Model access tokens | in the planner process memory and `agent.db` | only in the gateway process; the planner never receives one |
| Workspace token (P3) | not issued yet | only in the daemon's secret broker (ADR 0015); never in omp |
| Gateway client token | — | in the planner's env and memory only; scoped to the four model providers; never passed to a child |

**Bar (checkable):** after cutover, no credential row exists in the planner profile's store, no file the planner or
`bash` can open holds a provider or Workspace token, and a planner turn still runs on each of the four providers.

## 3. Non-goals

- agy-cli (voice) and codex (self-write writer) keep their own CLI logins; they are not omp and not in D11.
- No change to D12 (`bash` posture, network on) or to the policy hook's tool set.
- No separate macOS user (SP3 keeps that as a further step).
- P3's bridge tool, scopes and approvals: P3's spec.

## 4. Design

### 4.1 Components

| Unit | What it is | Runs as |
|---|---|---|
| vault | `omp --profile houge-vault auth-broker serve --bind 127.0.0.1:<vault port>` | launchd agent `com.houge.omp-vault`, KeepAlive |
| gateway | `omp --profile houge-gateway auth-gateway serve --bind 127.0.0.1:<gateway port> --clients <clients file>`; a broker client of the vault (`OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN` in its launchd env, read by a wrapper from the vault's token file) | launchd agent `com.houge.omp-gateway`, KeepAlive |
| planner profile `houge` | unchanged dirs; its provider config routes the four providers to the gateway (`transport: pi-native`, `baseUrl` = gateway, `apiKey` from env `HOUGE_OMP_GATEWAY_TOKEN`); zero credential rows | every omp child Houge spawns (planner, one-shots, `models --json`) |

The clients file has one entry, `houge`: `tokenSha256` of the client token, `models` = `anthropic/*`, `openai-codex/*`,
`google-antigravity/*`, `kimi-code/*`. A request with any other token, or for any other model, is refused by the gateway.

### 4.2 Token handling

- `HOUGE_OMP_GATEWAY_TOKEN` is a broker-held secret (ADR 0015): lifted at boot, stripped from `process.env`, redacted
  from egress, injected explicitly into every omp spawn the way `HOUGE_BRIDGE_TOKEN` is (`planner-session.ts:66`,
  `llm/providers/omp.ts`, `omp/model-catalog.ts`).
- `buildChildEnv` adds it to `CHILD_ENV_NEVER`, so no passthrough can hand it to `bash` or another CLI.
- The vault's bearer and the gateway's own token files stay inside their profile dirs, mode 0600.
- The Kimi overrides (`KIMI_CODE_OAUTH_HOST`, `KIMI_CODE_BASE_URL`) move to the gateway's launchd env; they leave
  `HOUGE_OMP_ENV_PASSTHROUGH`'s default.

### 4.3 Floors (ADR 0032 §5.1, new rule (m))

- `planner.sb`: read and write deny on `~/.omp/profiles/houge-vault`, `~/.omp/profiles/houge-gateway`, and the
  profile-independent broker/gateway token files under `~/.omp`; the `~/.omp` exception narrows from the whole tree to
  what omp's own process needs (`~/.omp/profiles/houge`, plus the shared root files a probe lists in task 0).
- `shell.sb` and the gate already deny all of `~/.omp`; a test pins that the two new dirs are covered.
- Boot check: the daemon (unsandboxed) opens the planner profile's `agent.db` read-only and counts `auth_credentials`
  rows. Any row opens an alerted incident `omp_planner_store_has_credentials` and the daemon refuses to start planner
  turns until it is cleared (fail closed: D11 would be silently back).

### 4.4 Availability

- A configured gateway never falls back to local logins, so a dead vault or gateway fails every model call.
- launchd KeepAlive restarts both. The daemon probes the gateway's unauthenticated `/healthz` at boot and on each
  planner spawn failure; down → one alerted incident `omp_gateway_down` (deduped per outage), cleared on recovery.
- A turn that fails on a gateway error reaches Paco through the existing turn-failure path, with the reason named.
- `/status` shows vault and gateway health in one line.

### 4.5 Cutover (order matters)

1. Paco logs in the four providers on the vault: `omp --profile houge-vault auth-broker login <provider>` (fresh
   grants, so the live `houge` rows keep working until step 4; no copy, no refresh-token race).
2. Start vault and gateway under launchd; run the live gate's provider leg against a scratch planner profile.
3. Check `houge.parked` / `houge.kill` and no run in flight; stop the daemon.
4. Delete the credential rows from the `houge` profile's store (Paco confirms this step; it cannot be undone, the
   rollback is re-login).
5. Write the provider routing into the `houge` profile; start the daemon; the boot check must read zero rows.
6. Live gate in full; smoke on both builds.

**Rollback:** remove the routing from the `houge` profile and log the four providers in again on it
(`omp --profile houge login <provider>`, the current procedure in `deploy/launchd/README.md`); stop the two agents.

## 5. Task 0 — probe before any code

On scratch profiles and ports, never the live `houge` profile:

1. Each of the four subscription logins completes a streamed turn through the gateway (`pi-native` transport), including
   openai-codex's websocket path and kimi-code with its overrides.
2. `omp --mode rpc` with the routing and zero credential rows: starts, lists models (`models --json`), runs a tool turn.
3. Where the provider routing must live (`models.yml` in the profile, or the `--config` overlay) and whether a
   workspace settings layer can override it (it must not: ADR 0032 5.1 (k) residual).
4. The exact files under `~/.omp` the planner's omp still opens, to narrow the `planner.sb` exception.
5. Whether a same-uid sandboxed process can attach to the gateway process (task_for_pid / lldb) and read its memory.
6. Gateway refuses: no token, wrong token, a model outside the client's grant.

Any failure in 1–2 stops the slice and comes back to Paco.

## 6. ADR changes

- ADR 0032 D11: from "accepted until SP3" to **closed by §5.1 (m)** for the model logins; the history row names this
  spec. Until the code ships, D11 reads "to be changed, spec 2026-11-13-p4-d11".
- ADR 0032 §5.1 (m), new and checkable, test `tests/adr/0032-5.1m-planner-holds-no-login.test.ts`:
  no credential row in the planner profile; both profiles deny the vault and gateway dirs; the gateway token is in
  `CHILD_ENV_NEVER`; every omp spawn carries the gateway routing.
- ADR 0025 (Google identity): a Workspace grant is daemon-side only; no `mcp_oauth:*` row and no Workspace MCP server in
  any omp profile or config. Test: the config overlay names no MCP server, and the boot check also counts `mcp_oauth`
  rows (zero).
- ROADMAP SP3: the auth-broker item is done; the separate macOS user stays.

## 7. Tests and live gate

- Unit: profile render (new denies, narrowed exception), `buildChildEnv` never passes the token, every spawn's env and
  args carry the routing, the boot check (zero rows → ok; any row → incident + no turns), gateway-down incident dedupe.
- `scripts/live-gate-credential-isolation.mjs`, PASS only if all hold: zero credential and `mcp_oauth` rows in the live
  planner store; one planner turn per provider through the gateway; `sandbox-exec` under both live profiles cannot read
  either new profile dir or token file; the gateway refuses no-token, wrong-token and out-of-grant requests; a `bash`
  child's env lacks the gateway token. Any provider that silently falls back or is skipped is FAIL, not PASS.

## 8. Residuals (Tier C, for Paco to accept or reject)

- The gateway token sits in the planner process: a steered planner can make model calls through the gateway, which it
  can do today anyway; it cannot obtain a provider token.
- Vault, gateway and daemon run as the same macOS user. The profiles deny the files; process memory is guarded by macOS
  same-user rules (task 0 item 5 measures it). SP3's separate user remains the step beyond this.
- If the gateway is down, Houge cannot think until it restarts; the alert is the mitigation.
