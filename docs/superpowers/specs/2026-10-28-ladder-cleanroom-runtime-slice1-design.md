# Decision ladder — clean-room runtime (Slice 1 of the clean-room profile)

**Status:** draft, awaiting senior + codex review, then Paco's approval of the reviewed spec.
**Date:** 2026-10-28
**Amends:** `docs/superpowers/specs/2026-10-27-ladder-cleanroom-profile-design.md` (Slice 0; its §Slice 0 rulings stand). Implements ADR 0030 §8.3's clean-room execution; **grants no standing approval and no sealed credit** — that is Stage 4A (`2026-10-26-ladder-stage4-standing-approval-scheduled-design.md`), which this slice unblocks.
**Depends on:** Slice 0 on `main` (`10df6b6`): `src/omp/cleanroom.ts` (validator, branded pair, sidecar writer, fixed env), `renderCleanroom` in `src/omp/seatbelt.ts`, `tests/omp/cleanroom.test.ts`, `scripts/live-gate-cleanroom-profile.mjs`.

## Goal

A command can be **run** in the clean room, end to end, through the real shell adapter and wrapper: fresh room and home made for that one run, the Slice 0 profile plus the P8 local-network and IPC rules, the fixed six-name environment, teardown in `finally`, every failure typed and loud. After this slice the runtime is *capable* and *behaviour-neutral*: nothing selects the clean room in production until Stage 4A sets the executor from a validated standing match.

Four things ship:

1. **P8 closed in the profile** — loopback in every address form, this host's own addresses, Unix sockets (the bridge socket included), listening, and all Mach lookups are denied; DNS and HTTPS still work. Measured live on the target Mac (§P8 evidence) before this spec was written.
2. **No child TMPDIR above a room** — agy-cli, agy-models, coding-agent (codex), the omp one-shot seats and the model catalog get `<cache>/children` as TMPDIR; rooms live in `<cache>/cleanroom`. A test proves neither is an ancestor of the other.
3. **The runtime seam** — `executor: "cleanroom"` on the per-call runtime context (outside adapter input, so the action fingerprint is unchanged); the shell adapter selects the clean room from that field alone; fail closed when the sandbox is off or `sandbox-exec` is missing.
4. **Lifecycle** — `withCleanroom`: mkdtemp both, validate (Slice 0), write the sidecar, re-check both directories immediately before spawn, run, remove both in `finally`; teardown failure is an incident, never silent.

## Non-goals

- Standing-approval state, candidacy streaks, grant/revoke cards, re-validation (B14) changes, schedule eligibility — Stage 4A.
- **Sealed credit and report-delivery persistence** (`report_delivered_at`) — Stage 4A owns the credit decision and therefore the persistence; this spec binds Stage 4A to it (§Hand-off to Stage 4A) but builds neither.
- Changing the planner or shell profiles beyond what `secretPaths()` already denies.
- A Mach *allowlist*. The probe showed curl's HTTPS and bash need **no** Mach lookup at all, so the profile denies the operation outright; an allowlist is only needed if a later command needs one, and that is a new ruling.

## P8 evidence (live, this Mac, 2026-10-28, macOS 24.6.0, curl 8.7.1)

Real listeners: Python `http.server` on `0.0.0.0:48130` and `[::]:48131`, `nc -lU` on a Unix socket, `nc -l` for the bind test. Every row is a sandboxed `curl -s -m 6 -o /dev/null -w '%{http_code}'` → `code/rc`.

| Rule set | `127.0.0.1` | `[::1]` | `[::ffff:127.0.0.1]` | `example.com` |
|---|---|---|---|---|
| `(deny network-outbound (remote ip "localhost:*"))` alone | 000/7 | 000/7 | **200/0 — hole** | 200/0 |
| `ip "localhost:*"` + `ip6 "*:*"` (two rules, either order) | **200/0 — regressed** | 000/7 | 000/7 | 200/0 |
| `(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*"))` | 000/7 | 000/7 | 000/7 | 200/0 |
| `(deny network-outbound)` + `(allow … ip4 "*:*")` + `(deny … ip4 "localhost:*")` | **200/0** | 000/7 | 000/7 | 200/0 |

Findings that shape the rules:
- SBPL `remote ip` accepts only `*` or `localhost` as host (`sandbox-exec: host must be * or localhost in network address`); no per-address or CIDR denial exists. `localhost` covers `127.0.0.1`, `localhost`, `0.0.0.0`, `[::1]`, `[fe80::1%lo0]` **and this host's LAN address** (`192.168.1.110` → rc 7) but **not** the IPv4-mapped form `[::ffff:127.0.0.1]`, which reaches a `::` listener.
- Network filters do **not** compose last-match-wins the way file rules do: splitting `ip` and `ip6` across rules, or layering allow-then-deny, re-opened `127.0.0.1`. The two filters must sit **in one rule**, with the `ip4` family named. The renderer emits that exact line and the gate probes every address form, so a future "tidy-up" that splits the rule fails the gate.
- `(deny network-outbound (remote unix-socket))` + `(allow network-outbound (literal "/private/var/run/mDNSResponder"))`: a Unix socket in cwd → rc 7; DNS still resolves (`example.com` 200).
- `(deny mach-lookup)` with no allowlist: HTTPS `example.com` 200, `expired.badssl.com` rc 60, `self-signed.badssl.com` rc 60 (trust evaluation still enforced), bash `for`/`$()`/pipes work, a POST with `-c cj.txt -b cj.txt` in cwd returns 200 and writes a 131-byte jar. Denied lookups logged: `opendirectoryd.libinfo`, `notification_center`, `SystemConfiguration.configd`, `logd` — none needed.
- `(deny network-bind)` + `(deny network-inbound)`: `nc -l 127.0.0.1 48140` inside the sandbox leaves no reachable listener.
- `127.0.0.2` / `127.1.2.3` time out (rc 28) sandboxed **and** unsandboxed: macOS routes 127/8 but only `127.0.0.1` is configured on `lo0`; not reachable on this host, so not a residual. The gate records both values and fails if the unsandboxed one ever becomes reachable without the sandboxed one being denied.

Final rule block, verified as one profile (`full.sb`) against all of the above:

```scheme
(deny mach-lookup)
(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*"))
(deny network-outbound (remote unix-socket))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(deny network-inbound)
(deny network-bind)
```

**Stated limitation (ruling, cost-if-wrong: one command fails loudly, keeps asking):** `ip6 "*:*"` denies all IPv6 egress, so an IPv6-only remote endpoint is unreachable from a sealed run. This host has no global IPv6 address today; curl falls back to A records when both exist. Recorded in `configuration.md` under the clean room. If Paco's network gains IPv6 and a command needs it, the only safe move is a per-command ruling, not a looser rule — there is no SBPL filter that denies loopback-mapped IPv6 while allowing the rest.

## Profile changes (Slice 0 renderer, `renderCleanroom`)

Append the block above after the existing process/IPC denials. `(deny mach-lookup (global-name "com.apple.launchd"))` becomes redundant under `(deny mach-lookup)`; **keep it** (explicit, and the planner/shell profiles still carry it — the three profiles stay comparable).

Tests (unit, grammar): the rule block is present byte-for-byte, the two network filters are in **one** rule, `ip4` is named, mDNSResponder is the only `allow network-outbound`. Tests (live, darwin, in `tests/omp/cleanroom.test.ts`): a `::` listener on an ephemeral port is unreachable via `127.0.0.1`, `[::1]` and `[::ffff:127.0.0.1]` (rc 7 each); a Unix socket in the room is unreachable; `nc -l` cannot bind. The HTTPS positive control needs the network and stays in the gate.

## Children's TMPDIR

`src/run/daemon-tmp.ts` gains `childTmpRoot(): string` = `<daemonTmpRoot()>/children`, created 0700 like the root. The five spawn sites that today pass `TMPDIR: daemonTmpRoot()` switch to `childTmpRoot()`:
`src/llm/providers/omp.ts:65`, `src/llm/providers/agy-models.ts:54`, `src/llm/providers/agy-cli.ts:197`, `src/capabilities/coding-agent.ts:36`, `src/omp/model-catalog.ts:47`. `agy-models` also uses `daemonTmpRoot()` as **cwd** — that stays (cwd is not a write grant; its TMPDIR moves).

Unchanged: `daemonMkdtemp*` (agy workdirs, codex out-files are direct children of the root, siblings of `cleanroom/` — never ancestors of a room), `isDaemonTmpDir` (media files must stay direct children), the planner/shell `childTmpDir(workspace)`.

**Why this matters, precisely (threat model, for the reviewer):** codex runs under its own Seatbelt in `workspace-write`, which grants writes to its cwd **and `$TMPDIR`**. With `TMPDIR=<cache>` a prompt-injected codex turn could write `<cache>/cleanroom/home-x/.curlrc` between validation and spawn. After the move its writable set is `<cache>/children` and its worktree. agy-cli and the omp seats are not sandboxed by Houge; they are same-user processes, as is every process on the Mac — ADR 0030 §8.3's sealed property is about the write set of Houge's **sandboxed** profiles, and that is what the overlap test proves. The pre-spawn re-check (§Lifecycle) narrows the remaining window to the spawn itself.

Test: `tests/run/daemon-tmp.test.ts` — `childTmpRoot()` is neither an ancestor nor a descendant of `cleanroomRoot()` (by path and by inode on a real temp root); `tests/omp/child-tmpdir-sites.test.ts` — each of the five sites, spawn stubbed, passes `env.TMPDIR === childTmpRoot()`, and no site in `src/` passes `TMPDIR: daemonTmpRoot()` (a grep-style source assertion, the way `PROTECTED_FILES` lockstep tests work).

## Runtime seam

`SsrfContext` in `src/tools/tool-registry.ts` is already the per-call runtime context the bridge hands `CapabilityRunner.execute` and the runner forwards to the adapter (`capability-runner.ts:259`). It gains one optional field:

```ts
export interface SsrfContext {
  run_id: string | null;
  tool_call_id?: string | null;
  recorder?: DecisionRecorder;
  /** Set only from a validated standing match (ADR 0030 §8.3, B20). Never from model or adapter input. */
  executor?: "cleanroom";
}
```

- The field is outside `input.input`, so the action fingerprint (`capability-runner.ts:143`, `stableHash` over the input) is unchanged; a test asserts the fingerprint of a call with and without `executor` is identical.
- `shellToolExecute` reads `ctx?.executor === "cleanroom"` and calls `runCleanroomShell`; otherwise today's path, byte for byte.
- **No production caller sets it in this slice.** `bridge-handler.ts` is not touched. Stage 4A's standing match is the first setter. A test proves the bridge path *without* the field still selects `shell.sb` (the planner's cwd is the workspace).
- `readonly` tools, loop tools, `http_fetch`: ignore the field (they never spawn a shell).

## `runCleanroomShell`

`src/omp/cleanroom-run.ts` (new; `cleanroom.ts` keeps validation and rendering pure):

```ts
export type CleanroomFailure = ShellFailure | "cleanroom_unavailable" | "cleanroom_invalid" | "cleanroom_tampered";
export interface CleanroomRunResult extends ShellRunResult { reason?: CleanroomFailure; room?: string }

export function runCleanroomShell(deps: {
  cfg: OmpConfig; distDir: string; onIncident: (kind: string, detail: Record<string, unknown>) => void;
}, command: string, signal?: AbortSignal): Promise<CleanroomRunResult>;
```

Order, each step typed:
1. **Availability**: `cfg.sandbox === false` or `/usr/bin/sandbox-exec` not executable → `{ status: "failed", reason: "cleanroom_unavailable" }`, incident `cleanroom_unavailable`, **no spawn**. (Stage 4A: a void standing match asks as normal.)
2. **Make**: `mkdirSync(cleanroomRoot(), 0o700)`; `room = mkdtempSync(join(root, "room-"))`, `home = mkdtempSync(join(root, "home-"))`.
3. **Validate**: `validateCleanroomDirs({ room, home })` → on `CleanroomPathError`: `reason: "cleanroom_invalid"`, incident with `error.reason`, teardown, no spawn.
4. **Sidecar**: `writeCleanroomProfile(dirs)`; a throw → teardown (removes `cleanroom.sb.tmp-<pid>` with the home), `reason: "spawn"`, incident.
5. **Pre-spawn re-check**: `readdirSync(home)` is exactly `["cleanroom.sb"]` and `readdirSync(room)` is empty, else `reason: "cleanroom_tampered"`, incident `cleanroom_tampered` with the unexpected names, teardown, no spawn.
6. **Run**: `runShell({ command, cwd: room, profilePath: <home>/cleanroom.sb, wrapperPath, env: { HOUGE_SHELL_CLEANROOM: "1", CR_HOME: home, CR_ROOM: room }, timeoutMs: cfg.shellTimeoutMs, outputCapBytes: 32 KiB, sandbox: true, signal })`. **`buildChildEnv` is not called**; the spawn env holds only the wrapper's control names (`SB`, `HOUGE_SHELL_SANDBOX`, and these three), consumed by the unsandboxed wrapper and never entering the command's `execve` (see §Wrapper).
7. **Teardown** in `finally`: `rmSync(room, { recursive: true, force: true })`, same for `home`; a throw → incident `cleanroom_teardown_failed` with the path; the run result is **not** rewritten (a succeeded command stays succeeded; the leftover is the incident's business), except `wrapperStatus: "cleanup_failed"` from the wrapper, which already fails the run today.
8. **Escape**: `escaped === true` → incident `shell_escaped` exactly as today. Stage 4A: an escaped sealed run is never a seal (§Hand-off).

**One validated pair per command**: `room`/`home` are local to one call; nothing caches them. **Sweep**: before step 2, entries under `cleanroomRoot()` older than 60 minutes (`room-*`, `home-*`) are removed and counted in one incident `cleanroom_sweep` — a previous teardown failure must not accumulate silently.

`shellToolExecute` maps `CleanroomRunResult` to `ToolAdapterResult` as today (`ok:false, error: "bash <reason>…"`); the incident kinds above go through `deps.onIncident` unchanged.

## Wrapper (`src/omp/shell-wrapper.sh`, protected — edited under this spec)

One new mode, selected by `HOUGE_SHELL_CLEANROOM=1`, tested **before** the `HOUGE_SHELL_SANDBOX=0` branch:

```bash
if [ "${HOUGE_SHELL_CLEANROOM:-0}" = "1" ]; then
  [ -n "$CR_HOME" ] && [ -n "$CR_ROOM" ] || lf
  /usr/bin/sandbox-exec -f "$SB" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C.UTF-8 \
    HOME="$CR_HOME" CURL_HOME="$CR_HOME" XDG_CONFIG_HOME="$CR_HOME" TMPDIR="$CR_ROOM" \
    /usr/bin/nice -n 10 /bin/bash -c "$1" 3>&-; rc=$?
elif [ "${HOUGE_SHELL_SANDBOX:-1}" = "0" ]; then
  …unchanged…
else
  …unchanged…
fi
```

- `HOUGE_SHELL_SANDBOX=0` (tests' no-sandbox switch) **does not** apply to clean-room mode: the branch order is clean-room first, and clean-room mode never runs unsandboxed (fail closed in the adapter already; the wrapper is the second lock).
- The caller's PATH is **not** restored for the command (today's `PATH=$cmd_path` is the normal branch only).
- The six names are literal in the wrapper. `cleanroomEnv()` in `cleanroom.ts` stays the TypeScript source of truth, and the live test asserts the child's `env` output equals `cleanroomEnv(dirs)` plus bash's own `PWD`, `SHLVL`, `_` — a drift between the two fails the test.
- `WRAPPER_SHA256` in `src/omp/shell-wrapper.ts` is updated; the lockstep test keeps them equal; `scripts/copy-omp-assets.mjs` is unchanged.

## Live properties (tests, darwin only, same shape as Slice 0)

Through `runCleanroomShell` with the real wrapper and `sandbox-exec`, under a per-test `HOUGE_DAEMON_TMP_DIR`:
1. `pwd` prints the room; `env` prints exactly the six names + bash's three, values from `cleanroomEnv`.
2. A file planted in the test's `$HOME` (`-H @$HOME/x`) and in the room's **parent** (`<cache>/cleanroom/planted`) is unreadable (curl 26).
3. `::`-bound listener unreachable via the three address forms; Unix socket in the test's data dir unreachable; `nc -l` cannot bind.
4. Teardown: after a succeeded, a failed (exit 3), a timed-out and an aborted command, `cleanroomRoot()` has no `room-*`/`home-*` entries.
5. Tampering: a file dropped into the home between validation and spawn (test hook on the writer) → `cleanroom_tampered`, no spawn (the command would have created a marker file; it does not exist).
6. `cfg.sandbox = false` → `cleanroom_unavailable`, no directories created.
7. Seam: `CapabilityRunner.execute` with `ssrfCtx.executor = "cleanroom"` runs in a room (`pwd` ≠ workspace), without it runs in the workspace; the action fingerprint is identical in both.
8. Sweep: a stale `room-old` with mtime −2 h is removed on the next call and reported once.

## Live gate — `scripts/live-gate-cleanroom-runtime.mjs`

Real `dist/`, real wrapper, gate-owned `HOUGE_DAEMON_TMP_DIR` (so rooms are under a gate root the planner/shell profiles deny — asserted by `secretPaths()` as in Slice 0), sweeps and `SIGINT` cleanup as Slice 0. Lines, each PASS/FAIL with the observed value:
- HTTPS 200 from a sealed run (`curl https://example.com`); a bad certificate rejected (rc 60) — **FAIL if 200**.
- Alishan shape: `curl -c cj.txt -b cj.txt -X POST https://httpbin.org/post` → 200, jar written in the room, jar gone after teardown.
- Every local address form + Unix socket + bind: denied (rc 7 / no listener). `127.0.0.2` recorded (unsandboxed vs sandboxed), FAIL only if reachable unsandboxed yet not denied sandboxed.
- Planted `.curlrc` in the daemon's real `$HOME`? **Not** planted (never touch Paco's real home); instead planted under the gate root's `children/` and `cleanroom/` and asserted unreadable.
- Child TMPDIR invariant: `childTmpRoot()` vs `cleanroomRoot()` not nested, on the real cache root.
- Teardown after success, failure, timeout; nothing left under the gate root; no `room-*` under the **real** `cleanroomRoot()` either (the gate must not leak into production).
- Sandbox off → `cleanroom_unavailable` and no directory made.
- INCONCLUSIVE (network down, curl missing) exits 2 with `ok:false`, as Slice 0.

PASS criterion: every line PASS **and** HTTPS 200 observed; a run that merely "returns" is not a pass.

## Hand-off to Stage 4A (binding on that spec, built there)

- Stage 4A sets `executor: "cleanroom"` only from a validated standing/candidate match, re-validated with the fingerprint (B14), never from adapter or model input.
- **No sealed credit without a persisted delivery record**: the sealed run's report must reach Paco and be persisted (`report_delivered_at`, keyed to run id + execution id) before the candidacy advances. `status === "succeeded"` alone, exit 0 with `escaped`, or exit 0 with an empty jar, never counts (ADR 0030 §8.3 probe (d)).
- `cleanroom_unavailable` / `cleanroom_invalid` / `cleanroom_tampered` void the standing match for that call: it asks as normal, and a `cleanroom_tampered` incident is urgent.
- The approval card and digest state the eligibility consequence: a standing-approved command runs in an empty folder with a fresh home; only self-contained commands qualify (Slice 0 ruling 8).

## Docs sync on ship

`configuration.md`: the clean room's fixed environment, the IPv6 limitation, `<cache>/children` and `<cache>/cleanroom`. ADR 0030: amendment row "clean-room runtime landed; P8 closed: loopback (all forms), host addresses, Unix sockets, bind, Mach lookups denied; IPv6 egress denied" — drafted, marked awaiting Paco's signature. `AGENTS.md` Commands line on daemon temp files gains the two subdirectories (Paco's hand — listed in the report). ROADMAP: Stage 4 item #6 → shipped; Stage 4A next. `tasks/todo.md` state block, `tasks/lessons.md`, `sessions.md`.

## Rulings in this spec (recorded so the review can overturn them)

1. **Mach: deny all, no allowlist.** Measured: nothing in the Alishan shape needs a lookup. Cheaper and tighter than an allowlist; a future command that needs one is a new ruling.
2. **IPv6 egress denied** (the only SBPL shape that closes `::ffff:` mapped loopback). Stated limitation, documented.
3. **Report-delivery persistence is Stage 4A's**, bound by §Hand-off, not built here (there is no credit to persist yet and no table to put it in).
4. **The wrapper gets a mode, not a second wrapper**: limits, group cleanup and the status pipe stay one implementation.
5. **Teardown failure does not flip a succeeded command to failed**: the incident is the signal; a flipped result would make a disk hiccup look like a command fault to Stage 4A's candidacy.
6. **Sweep at 60 minutes**, on the next clean-room call, not a timer: no new scheduler surface for a rare failure.
7. **`SsrfContext` is reused, not renamed**: it is already the per-call runtime context; renaming touches every adapter signature for no behaviour.

## Acceptance

Typecheck, build, full suite green with none skipped; `scripts/live-gate-cleanroom-profile.mjs` (Slice 0) still PASS; `scripts/live-gate-cleanroom-runtime.mjs` PASS on `main`'s `dist/`. Kickstart: owed (runtime paths changed: wrapper hash, five children's TMPDIR), but **no behaviour changes for any live path until Stage 4A** — the report says so in one line.
