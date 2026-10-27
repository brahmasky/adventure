# Decision ladder — clean-room runtime (Slice 1 of the clean-room profile)

**Status:** Rev 2 — senior review (Opus, live probes: no blockers, 6 warnings, all taken) and codex design pass round 1 (6 blockers: 5 taken, B1 rejected with evidence) folded in; codex round 2 pending; then Paco's approval of the reviewed spec.
**Date:** 2026-10-28
**Amends:** `docs/superpowers/specs/2026-10-27-ladder-cleanroom-profile-design.md` (Slice 0; its §Slice 0 rulings stand). Implements ADR 0030 §8.3's clean-room execution; **grants no standing approval and no sealed credit** — that is Stage 4A (`2026-10-26-ladder-stage4-standing-approval-scheduled-design.md`), which this slice unblocks.
**Depends on:** Slice 0 on `main` (`10df6b6`): `src/omp/cleanroom.ts` (validator, branded pair, sidecar writer, fixed env), `renderCleanroom` in `src/omp/seatbelt.ts`, `tests/omp/cleanroom.test.ts`, `scripts/live-gate-cleanroom-profile.mjs`.

## Goal

A command can be **run** in the clean room, end to end, through the real shell adapter and wrapper: fresh room and home made for that one run, the Slice 0 profile plus the P8 local-network and IPC rules, the fixed six-name environment, teardown in `finally`, every failure typed and loud. After this slice the runtime is *capable* and *behaviour-neutral*: nothing selects the clean room in production until Stage 4A sets the executor from a validated standing match.

Four things ship:

1. **P8 closed in the profile** — loopback in every address form, this host's own addresses, all UDP (broadcast and multicast included), Unix sockets (the bridge socket included), listening, and all Mach lookups are denied; DNS and HTTPS still work. Measured live on the target Mac (§P8 evidence) before this spec was written.
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
| bare `ip "localhost:*"` + `ip6 "*:*"` (one rule or two, either order) | **200/0 — regressed** | 000/7 | 000/7 | 200/0 |
| `ip4 "localhost:*"` + `ip6 "*:*"` (one rule, or two rules in either order) | 000/7 | 000/7 | 000/7 | 200/0 |
| `(deny network-outbound)` + `(allow … ip4 "*:*")` + `(deny … ip4 "localhost:*")`, no mDNS allow | **200/0** | 000/7 | 000/7 | 000/6 (DNS dead) |
| same, plus the mDNSResponder literal allow (senior re-probe) | 000/7 | 000/7 | 000/7 | 200/0 |
| `tcp4`/`tcp6` instead of `ip4`/`ip6` (senior) | 000/7 | 000/7 | 000/7 | 200/0 — but UDP loopback stays open: rejected |
| `ip6 "localhost:*"` instead of `ip6 "*:*"` (senior) | 000/7 | 000/7 | **200/0** | 200/0 |

Findings that shape the rules:
- SBPL `remote ip` accepts only `*` or `localhost` as host (`sandbox-exec: host must be * or localhost in network address`); no per-address or CIDR denial exists. `localhost` covers `127.0.0.1`, `localhost`, `0.0.0.0`, `[::1]`, `[fe80::1%lo0]` **and this host's LAN address** (`192.168.1.110` → rc 7) but **not** the IPv4-mapped form `[::ffff:127.0.0.1]`, which reaches a `::` listener.
- **The hazard is the bare `ip` family, not rule splitting** (senior review corrected the first reading, both sets of probes agree): a `(remote ip "localhost:*")` filter stops matching IPv4 loopback as soon as any `ip6` rule is present, in one rule or two; `ip4` named explicitly works in every arrangement tried. Beyond that, network rules interact **non-locally** — the allow-then-deny shape flipped from open to closed when an unrelated mDNS allow was added. So no reasoning about "last match" or "one rule" is trusted: the renderer names the family on every filter, a unit assertion fails on any `(remote ip "` in the profile, and the darwin live test (every suite run, not just the gate) runs the full address matrix against the **full rendered profile**. Any edit to any network line re-runs that matrix.
- `(deny network-outbound (remote unix-socket))` + `(allow network-outbound (literal "/private/var/run/mDNSResponder"))`: a Unix socket in cwd → rc 7; DNS still resolves (`example.com` 200).
- `(deny mach-lookup)` with no allowlist: HTTPS `example.com` 200, `expired.badssl.com` rc 60, `self-signed.badssl.com` rc 60 (trust evaluation still enforced), bash `for`/`$()`/pipes work, a POST with `-c cj.txt -b cj.txt` in cwd returns 200 and writes a 131-byte jar. Denied lookups logged: `opendirectoryd.libinfo`, `notification_center`, `SystemConfiguration.configd`, `logd` — none needed.
- `(deny network-bind)` + `(deny network-inbound)`: `nc -l 127.0.0.1 48140` inside the sandbox leaves no reachable listener.
- **UDP (codex design pass, B3):** with only the rules above, `nc -u 192.168.1.255 48153` (LAN **broadcast**) returned rc 0 from the sandbox — a datagram to a local UDP service bound to `0.0.0.0` is not in Seatbelt's `localhost` class. UDP to `127.0.0.1` and to the LAN address were already denied (rc 1). Adding `(remote udp4 "*:*")` **to the same rule** denies broadcast (rc 1) and multicast `224.0.0.251:5353` (rc 1), and a raw `dig @8.8.8.8` fails with `bind: Operation not permitted`; curl's resolution goes through the mDNSResponder socket, so HTTPS to `example.com` and `1.1.1.1` still work (200 / 301) and `expired.badssl.com` still fails (rc 60). A sealed command therefore has **TCP egress only** — no raw DNS, no UDP of any kind.
- Not probed because this host has none configured: IPv4 link-local (`169.254/16`, rc 7 — no route), interface aliases. The gate lists the host's configured addresses (`ifconfig`) and probes each as a TCP target; a new alias shows up as a new row, not a silent gap.
- `127.0.0.2` / `127.1.2.3` time out (rc 28) sandboxed **and** unsandboxed: macOS routes 127/8 but only `127.0.0.1` is configured on `lo0`; not reachable on this host, so not a residual. The gate records both values and fails if the unsandboxed one ever becomes reachable without the sandboxed one being denied.

Final rule block, verified as one profile (`full.sb`) against all of the above:

```scheme
(deny mach-lookup)
(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*") (remote udp4 "*:*"))
(deny network-outbound (remote unix-socket))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(deny network-inbound)
(deny network-bind)
```

**What this block proves, exactly** (codex B3 — the claim is no wider than the evidence): from a sealed run no TCP connection reaches any address this host owns (loopback in every spelling, the LAN address, `0.0.0.0`, link-local scope), no UDP datagram leaves at all (so no broadcast or multicast path to a local UDP service), no Unix socket but mDNSResponder's is reachable (the bridge sockets under `<data>/omp/bridge/` included), nothing can listen, and no Mach service can be looked up. Not covered, and not claimed: Mach operations other than lookup (`mach-register`, `iokit-open`), `sysctl` reads (`sysctl -n kern.ostype` works), and kernel-control sockets. None of these is a Houge-managed service or a planted-file path, which is what ADR 0030 §8.3's property names; they are listed in `configuration.md` as the clean room's known non-file surface, not as a residual.

**Exec allowlist (senior WARNING, confirmed live by both: a `perl … fork; setsid(); close fds` child leaves the wrapper's process group, is missed by `pgrep -g $$` and by the `escaped` pipe check, outlives teardown, re-creates the room and keeps TCP egress).** The clean room denies `process-exec*` by default and allows a named set — `/bin/bash`, `/bin/sh`, `/usr/bin/env`, `/usr/bin/nice`, `/usr/bin/curl`, `/bin/date`, `/usr/bin/grep`, `/usr/bin/sed`, `/usr/bin/awk`, `/usr/bin/head`, `/usr/bin/tail`, `/usr/bin/tr`, `/usr/bin/cut`, `/usr/bin/sort`, `/usr/bin/uniq`, `/usr/bin/wc`, `/bin/cat`, `/bin/echo`, `/bin/ls`, `/bin/mkdir`, `/bin/rm`, `/usr/bin/basename`, `/usr/bin/dirname`, `/usr/bin/printf`, `/usr/bin/tee`, `/usr/bin/xargs`, `/usr/bin/base64`, `/bin/sleep`, `/usr/bin/true`, `/usr/bin/false`, `/usr/bin/test` — as one exported constant `CLEANROOM_EXEC_ALLOW` in `seatbelt.ts`. Verified 2026-10-28: the `env -i → nice → bash -c` chain, a `curl | grep | tr` pipeline and `date` work; `perl`, `ruby`, `script`, `screen`, `python3`, `osascript`, `openssl`, `nc` are refused (`Operation not permitted`, bash rc 126). None of the allowed binaries can call `setsid()`, and a bash subshell cannot leave the process group, so the wrapper's `pgrep -g $$` sweep is sufficient again. This supersedes the three literal exec denials (`launchctl`, `security`, `python3`), which stay in the profile as explicit lines. It is the shape Slice 0 ruling 8 already implies (self-contained commands only); a command that needs another binary is a per-command ruling, never a profile loosening. **Belt and braces:** after teardown the runtime re-stats the room path once after 500 ms; if it exists again, `shell_escaped` is raised and `torn_down` is false (so Stage 4A never seals it).

**Time zone (senior WARNING, confirmed: `date` in the room printed UTC because `/private/var/db/timezone` is unreadable; an Alishan-style "book tomorrow" would be wrong for 8–11 hours a day and still exit 0).** The read set gains `(literal "/private/etc/localtime") (subpath "/private/var/db/timezone") (subpath "/usr/share/zoneinfo")` plus metadata on `/private`, `/private/var`, `/private/var/db` — all root-owned, outside every write set; the `subpath` covers the versioned `tz/<ver>/zoneinfo` target so no `realpath` rendering is needed. Verified: `date` → `AEDT`, `TZ=Asia/Taipei date` → `CST`. The gate asserts the room's `date +%Z` equals the host's. (`whoami` prints `501` under `(deny mach-lookup)`; harmless, noted.)

**Stated limitation (ruling, cost-if-wrong: one command fails loudly, keeps asking):** `ip6 "*:*"` denies all IPv6 egress, so an IPv6-only remote endpoint is unreachable from a sealed run. This host has no global IPv6 address today; curl falls back to A records when both exist. Recorded in `configuration.md` under the clean room. If Paco's network gains IPv6 and a command needs it, the only safe move is a per-command ruling, not a looser rule — there is no SBPL filter that denies loopback-mapped IPv6 while allowing the rest.

## Profile changes (Slice 0 renderer, `renderCleanroom`)

Append the block above after the existing process/IPC denials. The three network filters stay **in one rule** (the two-rule shape re-opened `127.0.0.1`, see the table). `(deny mach-lookup (global-name "com.apple.launchd"))` becomes redundant under `(deny mach-lookup)`; **keep it** (explicit, and the planner/shell profiles still carry it — the three profiles stay comparable).

Tests (unit, grammar): the rule block is present byte-for-byte, the three network filters are in **one** rule, `ip4`/`udp4` are named, mDNSResponder is the only `allow network-outbound`. Tests (live, darwin, in `tests/omp/cleanroom.test.ts`): a `::` listener on an ephemeral port is unreachable via `127.0.0.1`, `[::1]` and `[::ffff:127.0.0.1]` (rc 7 each); a Unix socket in the room is unreachable; `nc -l` cannot bind. The HTTPS positive control needs the network and stays in the gate.

## Children's TMPDIR

`src/run/daemon-tmp.ts` gains `childTmpRoot(): string` = `<daemonTmpRoot()>/children`, created 0700 like the root. The five spawn sites that today pass `TMPDIR: daemonTmpRoot()` switch to `childTmpRoot()`:
`src/llm/providers/omp.ts:65`, `src/llm/providers/agy-models.ts:54`, `src/llm/providers/agy-cli.ts:197`, `src/capabilities/coding-agent.ts:36`, `src/omp/model-catalog.ts:47`. `agy-models` also uses `daemonTmpRoot()` as **cwd** — that stays (cwd is not a write grant; its TMPDIR moves).

Unchanged: `daemonMkdtemp*` (agy workdirs, codex out-files are direct children of the root, siblings of `cleanroom/` — never ancestors of a room), `isDaemonTmpDir` (media files must stay direct children), the planner/shell `childTmpDir(workspace)`.

**Threat model, per child (codex B1/B2 — each statement is a lock, not a hope):**
- **codex** (self-write writer, `-s workspace-write -C <worktree>`): codex's Seatbelt grants its *model-generated shell commands* writes to the worktree **and `$TMPDIR`** (codex `exec --help`: the sandbox applies to model-generated shell commands). With `TMPDIR=<cache>`, a prompt-injected turn could write `<cache>/cleanroom/home-x/.curlrc`. After the move its writable set is the worktree and `<cache>/children`. The `-o` out-file under `<cache>/houge-codex-out-*/` is written by the **codex CLI process itself**, which is not under that sandbox — so the move does not break it (codex B1 **rejected** on that reading; the `coding-agent` tests still run the real arg builder, and the gate's child-TMPDIR line asserts the out-file dir and TMPDIR are siblings). The senior found `exclude_tmpdir_env_var` in codex-cli 0.163.0's binary (the `sandbox_workspace_write` key whose default `false` makes `$TMPDIR` writable) but could not execute `codex sandbox` to prove it, so the premise is **documented, not executed**. Second lock, cheap: the workspace-write call (`coding-agent.ts:104`) adds `-c sandbox_workspace_write.exclude_tmpdir_env_var=true`; the build verifies codex accepts the key with one `codex exec -s workspace-write -c … 'echo ok'` (subscription, no metered spend) and the arg-builder test pins it.
- **agy-cli** (voice + reader leg, `--print`, agentic): it never receives `--dangerously-skip-permissions` or `--mode accept-edits|auto`, so a write tool or `run_command` needs a permission tap that headless mode auto-denies (probe 2026-09-29, `agy-cli.ts:175`). A static test locks the arg builder: no permission-skipping flag, no edit mode. Its cwd is a fresh direct child of `<cache>`, a sibling of `cleanroom/`.
- **omp one-shot seats** (`--no-tools`) and **model-catalog** (`omp models`): no tool, no file writes beyond omp's own state under its config dir.
- **planner / shell children**: `shell.sb` / `planner.sb` read- and write-deny `<cache>` whole (`secretPaths()`), proven by the Slice 0 effective-policy test.

ADR 0030 §8.3 (design lines 949–957) defines the sealed property as "the clean room's readable set and the set Houge's own processes can write must not overlap" and then names that write set as the planner and shell profiles' `$HOME` and `/private/tmp`. The reviewer read "Houge's own processes" wider; the **stricter** reading is taken here (standing pre-ruling: review split → stricter reading, continue): every child Houge spawns is bounded above by one of the locks listed, and the gate asserts the two directories are disjoint. A process that is none of Houge's (Paco's own shell, another app) is outside the threat model, as root is — **at every point in the run, not only before spawn** (senior confirmed: a `.curlrc` written into the home by an unsandboxed same-user process 1 s after spawn was honoured by the sandboxed curl; the home is read-only to the *child*, not to other processes). The pre-spawn and post-run checks (§Lifecycle) are tamper **detection**, so a plant that persists is caught and the run is never sealed; they are not prevention and the spec does not claim it.

Tests: `tests/run/daemon-tmp.test.ts` — `childTmpRoot()` is neither an ancestor nor a descendant of `cleanroomRoot()` (by path and by inode on a real temp root); `tests/omp/child-tmpdir-sites.test.ts` — each of the five sites, spawn stubbed, passes `env.TMPDIR === childTmpRoot()`, and no site in `src/` passes `TMPDIR: daemonTmpRoot()` (a grep-style source assertion, the way `PROTECTED_FILES` lockstep tests work); `tests/llm/agy-cli.test.ts` — the arg builder never emits `--dangerously-skip-permissions` or `--mode`.

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
- **The field is a selector, not a proof** (codex W7). `CapabilityRunner.execute` accepts a caller-built context, so Slice 1 adds the one check it can make without a standing record: `shellToolExecute` honours `executor: "cleanroom"` only when the context also carries `run_id` and `tool_call_id` (an anonymous direct call with the flag is refused with `cleanroom_invalid` and an incident). Binding the flag to a validated standing match (fingerprint + chat + B14) is Stage 4A's, in §Hand-off; the tests here cover the first execution path, the approval-resume path (`bridge-handler.ts:377`) and a direct runner entry, all without the flag → `shell.sb`.

## `runCleanroomShell`

`src/omp/cleanroom-run.ts` (new; `cleanroom.ts` keeps validation and rendering pure):

```ts
export type CleanroomFailure = ShellFailure | "cleanroom_unavailable" | "cleanroom_setup" | "cleanroom_invalid" | "cleanroom_tampered";
/** `reason` is wider than ShellRunResult's, so the base is Omit-ed, not extended (codex B5). */
export type CleanroomRunResult = Omit<ShellRunResult, "reason"> & {
  reason?: CleanroomFailure;
  /** Both directories gone after the run and the room did not reappear. False never rewrites `status`; Stage 4A reads it. */
  torn_down: boolean;
  /** The home was not exactly [cleanroom.sb] with the rendered bytes after the run (post-run re-check). */
  tampered: boolean;
  /** Always "cleanroom" here; the shell adapter copies it and the room basename into the tool output so the ledger shows which executor ran (senior). */
  executor: "cleanroom";
  room: string;
  /** Teardown / escape facts for the single incident emitter (shellToolExecute). */
  teardown_error?: string;
};

export function runCleanroomShell(deps: { cfg: OmpConfig; distDir: string }, command: string, signal?: AbortSignal): Promise<CleanroomRunResult>;
```

**One incident emitter** (senior): `runCleanroomShell` raises nothing; every fact is a field on the result (`reason`, `torn_down`, `tampered`, `teardown_error`, `escaped`, `wrapperStatus`), and `shellToolExecute` emits the incidents in cause-before-effect order: `shell_cleanup_failed` / `shell_escaped` first (as today), then `cleanroom_<reason>` for a non-shell reason, then `cleanroom_tampered`, then `cleanroom_teardown_failed` with `after: { wrapperStatus, escaped }`. `rmSync` uses `{ maxRetries: 3 }` when `cleanup_failed` or `escaped` is set (a survivor may still be writing). "Incident" below means a field that `shellToolExecute` turns into one.

Order, each step typed; the function is **total** (codex B4): it never throws, every exit is one of the reasons above plus an incident, and `try/finally` is entered before the first directory is made so a partial allocation is always torn down.
1. **Availability**: `cfg.sandbox === false` or `/usr/bin/sandbox-exec` not executable → `{ status: "failed", reason: "cleanroom_unavailable", torn_down: true }`, incident `cleanroom_unavailable`, **no spawn**. (Stage 4A: a void standing match asks as normal.)
2. **Make**: `mkdirSync(cleanroomRoot(), { recursive: true, mode: 0o700 })` (a gate-owned cache parent may not exist yet), then `room = mkdtempSync(join(root, "room-"))`, `home = mkdtempSync(join(root, "home-"))`. Any throw here, in the sweep, or in a `readdir` → `reason: "cleanroom_setup"`, incident `cleanroom_setup` with the `code`, teardown of whatever exists, no spawn.
3. **Validate**: `validateCleanroomDirs({ room, home })` → on `CleanroomPathError`: `reason: "cleanroom_invalid"`, incident with `error.reason`, teardown, no spawn.
4. **Sidecar**: `writeCleanroomProfile(dirs)`; a throw → teardown (removes `cleanroom.sb.tmp-<pid>` with the home), `reason: "spawn"`, incident.
5. **Pre-spawn re-check** (tamper *detection*, codex W8 / senior; it does not claim to stop a same-user writer): `readdirSync(home)` is exactly `["cleanroom.sb"]`, `readdirSync(room)` is empty, the sidecar's bytes equal `renderCleanroom(dirs)`, and both directories still have the inodes the validator saw. Anything else → `reason: "cleanroom_tampered"`, incident `cleanroom_tampered` with the unexpected names, teardown, no spawn.
6. **Run**: `runShell({ command, cwd: room, profilePath: <home>/cleanroom.sb, wrapperPath, env: { HOUGE_SHELL_CLEANROOM: "1", CR_HOME: home, CR_ROOM: room }, timeoutMs: cfg.shellTimeoutMs, outputCapBytes: 32 KiB, sandbox: true, signal })`. **`buildChildEnv` is not called**; the spawn env holds only the wrapper's control names (`SB`, `HOUGE_SHELL_SANDBOX`, and these three), consumed by the unsandboxed wrapper and never entering the command's `execve` (see §Wrapper).
6b. **Post-run re-check** (senior): before teardown, `readdirSync(home)` must still be exactly `["cleanroom.sb"]` with the rendered bytes. Otherwise the command's `status` and `reason` stand (it did run), `tampered: true` is set, and an incident `cleanroom_tampered` follows; Stage 4A never seals a tampered run (§Hand-off).
7. **Teardown** in `finally`: `rmSync(room, { recursive: true, force: true })`, same for `home`; a throw → incident `cleanroom_teardown_failed` with the path and `torn_down: false`; `status` is **not** rewritten (a succeeded command stays succeeded for the tool result; Stage 4A disqualifies the seal on `torn_down: false`, §Hand-off — codex B6 and its ruling-5 objection, both taken). `wrapperStatus: "cleanup_failed"` from the wrapper still fails the run as today; it is recorded before teardown runs, so the two never mask each other. `rmSync` on a directory an escaped child still has open removes the names (the inode lives until the fd closes) — fine for the property, and the escape is already an incident.
8. **Escape**: `escaped === true` from `runShell`, **or** the room path existing again 500 ms after teardown → `escaped: true`, `torn_down: false`; `shellToolExecute` raises `shell_escaped` as today. Stage 4A: an escaped run is never a seal (§Hand-off).

**One validated pair per command**: `room`/`home` are local to one call; nothing caches them. **Sweep** (codex W9: age alone must not erase a live room): before step 2, entries under `cleanroomRoot()` named `room-*`/`home-*` that are **not in the module's in-process active set** and are older than `max(60 min, 2 × cfg.shellTimeoutMs)` are removed and counted in one incident `cleanroom_sweep`. Entries are matched with `lstat` on direct children only (a symlink is removed as a name, never followed). The active set is the only concurrency state; a run lasting longer than its timeout plus the runner's 5 s cap is impossible (the wrapper's group kill), and the age bound exceeds both even if `HOUGE_OMP_SHELL_TIMEOUT_MS` is raised, so a stale entry is from a previous process. A sweep error is `cleanroom_setup` (step 2).

`shellToolExecute` gains the third parameter (`ssrfCtx`) — the one closure serves the three `OMP_SHELL_META` entries (`core-worker.ts:2480`) — maps `CleanroomRunResult` to `ToolAdapterResult` as today (`ok:false, error: "bash <reason>…"`), and on success adds `executor: "cleanroom"` and `room: <basename>` to the output so the persisted tool result shows the executor (the ADR's "execution record" is Stage 4A's row; until then the tool output is the audit trail).

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

- A missing `CR_HOME`/`CR_ROOM` reports `limits_failed` (exit 97) — deliberately reused: the status pipe's three values are parsed by `shell-adapter.ts:parseStatus`, and a daemon that sends an incomplete control env is a programming error, not a new runtime state. The adapter test for it asserts `limits_failed`.
- `HOUGE_SHELL_SANDBOX=0` (tests' no-sandbox switch) **does not** apply to clean-room mode: the branch order is clean-room first, and clean-room mode never runs unsandboxed (fail closed in the adapter already; the wrapper is the second lock).
- The caller's PATH is **not** restored for the command (today's `PATH=$cmd_path` is the normal branch only).
- The six names are literal in the wrapper. `cleanroomEnv()` in `cleanroom.ts` stays the TypeScript source of truth, and the live test asserts the child's `env` output equals `cleanroomEnv(dirs)` plus bash's own `PWD`, `SHLVL`, `_` — a drift between the two fails the test.
- `WRAPPER_SHA256` in `src/omp/shell-wrapper.ts` is updated; the lockstep test keeps them equal; `scripts/copy-omp-assets.mjs` is unchanged.

## Live properties (tests, darwin only, same shape as Slice 0)

Through `runCleanroomShell` with the real wrapper and `sandbox-exec`, under a per-test `HOUGE_DAEMON_TMP_DIR`:
1. `pwd` prints the room; `env` prints exactly the six names + bash's three, values from `cleanroomEnv`; the tool output carries `executor: "cleanroom"` and the room basename.
2. A file planted in the test's `$HOME` (`-H @$HOME/x`) and in the room's **parent** (`<cache>/cleanroom/planted`) is unreadable (curl 26).
3. `::`-bound listener unreachable via the three address forms; Unix socket in the test's data dir unreachable; `nc -l` cannot bind; a UDP datagram to `127.0.0.1` is refused (`nc -u` rc 1).
4. Teardown: after an exit-0, an exit-3 (`status` is still `succeeded`, `exitCode: 3` — the shell adapter's contract today), a timed-out and an aborted command, `cleanroomRoot()` has no `room-*`/`home-*` entries and `torn_down === true`; with `rmSync` stubbed to throw, `torn_down === false`, incident raised, `status` unchanged.
5. Tampering: a file dropped into the home between validation and spawn (test hook on the writer) → `cleanroom_tampered`, no spawn (the command would have created a marker file; it does not exist); a file dropped into the home **during** the run (the command sleeps; the test writes) → the command's result stands, `tampered: true`, incident raised.
5b. Exec allowlist: `/usr/bin/perl -e 1` and `/usr/bin/script` are refused (rc 126), `date +%Z` equals the host's zone, `curl | grep` works.
5c. Escape: a bash `( sleep 5 & )` orphan is killed by the wrapper (no survivor, `escaped` unset); the room does not reappear after teardown.
6. `cfg.sandbox = false` → `cleanroom_unavailable`, no directories created.
7. Seam: `CapabilityRunner.execute` with `ssrfCtx.executor = "cleanroom"` runs in a room (`pwd` ≠ workspace), without it runs in the workspace; the action fingerprint is identical in both.
8. Sweep: a stale `room-old` with mtime −2 h is removed on the next call and reported once.

## Live gate — `scripts/live-gate-cleanroom-runtime.mjs`

Real `dist/`, real wrapper, gate-owned `HOUGE_DAEMON_TMP_DIR` (so rooms are under a gate root the planner/shell profiles deny — asserted by `secretPaths()` as in Slice 0), sweeps and `SIGINT` cleanup as Slice 0. Lines, each PASS/FAIL with the observed value:
- HTTPS 200 from a sealed run (`curl https://example.com`); a bad certificate rejected (rc 60) — **FAIL if 200**.
- Alishan shape: `curl -c cj.txt -b cj.txt -X POST https://httpbin.org/post` → 200, jar written in the room, jar gone after teardown.
- Every local address form (loopback spellings, `0.0.0.0`, each address `ifconfig` lists for this host, `[::ffff:127.0.0.1]`) + Unix socket + bind: denied (rc 7 / no listener); UDP to `127.0.0.1` and to the LAN broadcast address refused (`nc -u` rc 1). `127.0.0.2` recorded (unsandboxed vs sandboxed), FAIL only if reachable unsandboxed yet not denied sandboxed.
- Planted `.curlrc` in the daemon's real `$HOME`? **Not** planted (never touch Paco's real home); instead planted under the gate root's `children/` and `cleanroom/` and asserted unreadable.
- Child TMPDIR invariant: `childTmpRoot()` vs `cleanroomRoot()` not nested, on the real cache root.
- Teardown after success, failure, timeout; nothing left under the gate root; no `room-*` under the **real** `cleanroomRoot()` either (the gate must not leak into production).
- Sandbox off → `cleanroom_unavailable` and no directory made.
- `date +%Z` in the room equals the host's; `perl` refused; a `setsid`-style escape attempt (perl) is impossible because perl cannot exec — the gate asserts the refusal, not the escape.
- INCONCLUSIVE (network down, curl missing) exits 2 with `ok:false`, as Slice 0.

PASS criterion: every line PASS **and** HTTPS 200 observed; a run that merely "returns" is not a pass.

## Hand-off to Stage 4A (binding on that spec, built there)

- Stage 4A sets `executor: "cleanroom"` only from a validated standing/candidate match, re-validated with the fingerprint (B14), never from adapter or model input.
- **Seal eligibility is a conjunction Stage 4A computes from this slice's result, never from `status` alone** (codex B6): `status === "succeeded"` **and** `exitCode === 0` (the adapter reports a non-zero exit as `succeeded` with the code — `shell-adapter.ts:68`) **and** `escaped !== true` **and** `torn_down === true` **and** `tampered === false` **and** `truncated === false` **and** a persisted delivery record (`report_delivered_at`, keyed to run id + execution id) showing the report reached Paco. Exit 0 with an empty jar is caught by the delivery check, not by the exit code (ADR 0030 §8.3 probe (d)). Stage 4A's gate drives a non-zero exit and a teardown failure through the real bridge and asserts no seal.
- `cleanroom_unavailable` / `cleanroom_setup` / `cleanroom_invalid` / `cleanroom_tampered` void the standing match for that call: it asks as normal, and a `cleanroom_tampered` incident is urgent.
- Stage 4A persists `executor` and the room basename on its execution record (the ADR's "execution record" field) from the tool output; until then the tool output is the only trace.
- Stage 4A constructs the `executor` selector only after its binding check (fingerprint + chat + B14) and on no other path; a test covers first execution, approval resume and direct runner entry (codex W7).
- The approval card and digest state the eligibility consequence: a standing-approved command runs in an empty folder with a fresh home; only self-contained commands qualify (Slice 0 ruling 8).

## Docs sync on ship

`configuration.md`: the clean room's fixed environment, the IPv6 and UDP limitations, the exec allowlist, the time-zone read set, the known non-file surface (Mach ops other than lookup, sysctl), that **other LAN hosts stay reachable** (P8 covers this host's services only), `<cache>/children` and `<cache>/cleanroom`. ADR 0030: amendment row "clean-room runtime landed; P8 closed: loopback (all forms), host addresses, Unix sockets, bind, Mach lookups denied; IPv6 egress denied" — drafted, marked awaiting Paco's signature. `AGENTS.md` Commands line on daemon temp files gains the two subdirectories (Paco's hand — listed in the report). ROADMAP: Stage 4 item #6 → shipped; Stage 4A next. `tasks/todo.md` state block, `tasks/lessons.md`, `sessions.md`.

## Rulings in this spec (recorded so the review can overturn them)

1. **Mach: deny all, no allowlist.** Measured: nothing in the Alishan shape needs a lookup. Cheaper and tighter than an allowlist; a future command that needs one is a new ruling.
2. **IPv6 egress and all UDP denied** (the only SBPL shapes that close `::ffff:` mapped loopback and LAN broadcast). A sealed command has TCP egress only. Stated limitation, documented.
8. **codex B1 rejected**: the codex `-o` out-file is written by the unsandboxed codex CLI, not by a sandboxed shell command, so moving `TMPDIR` cannot break it; the out-file dir stays a direct child of `<cache>` (sibling of `cleanroom/`).
10. **Exec allowlist, not a deny list** (senior offered both): a deny list of `perl/ruby/script/screen` is a guess at the next escape primitive; the allowlist is the shape ruling 8 already describes, and it was verified live with the Alishan pipeline.
11. **Time zone readable, not "times are UTC" on the card**: a wrong date with exit 0 is exactly the silent failure the seal is meant to exclude; the files are root-owned and cost nothing.
12. **The adapter's third parameter is added, the closure stays one** for the three shell tool names.
9. **"Houge's own processes" read strictly** (codex B2): every spawned child is bounded by a named lock (§Children's TMPDIR); none of this needs an ADR change because §8.3 itself names the planner/shell write set as the property's write side. If the senior review reads §8.3 as requiring more than the listed locks, that is a Tier B item in the report, not a mid-slice stop.
3. **Report-delivery persistence is Stage 4A's**, bound by §Hand-off, not built here (there is no credit to persist yet and no table to put it in).
4. **The wrapper gets a mode, not a second wrapper**: limits, group cleanup and the status pipe stay one implementation.
5. **Teardown failure does not flip `status`, but it does disqualify the seal**: the tool result keeps the command's own outcome; `torn_down: false` is a separate field Stage 4A must read (codex overturned the first wording — taken).
6. **Sweep on the next clean-room call, not a timer**, bounded by an in-process active set and `max(60 min, 2 × shellTimeoutMs)`: no new scheduler surface for a rare failure, and no live room is ever swept.
7. **`SsrfContext` is reused, not renamed**: it is already the per-call runtime context; renaming touches every adapter signature for no behaviour.

## Acceptance

Typecheck, build, full suite green with none skipped; `scripts/live-gate-cleanroom-profile.mjs` (Slice 0) still PASS; `scripts/live-gate-cleanroom-runtime.mjs` PASS on `main`'s `dist/`. Kickstart: owed (runtime paths changed: wrapper hash, five children's TMPDIR), but **no behaviour changes for any live path until Stage 4A** — the report says so in one line.
