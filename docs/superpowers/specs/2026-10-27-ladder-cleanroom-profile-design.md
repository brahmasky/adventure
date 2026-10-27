# Decision ladder — clean-room Seatbelt profile (prerequisite for stage 4 standing approval)

**Status:** draft — prerequisite for `docs/superpowers/specs/2026-10-26-ladder-stage4-standing-approval-scheduled-design.md`
**Date:** 2026-10-27
**Amends:** none; implements ADR 0030 §8.3’s clean-room requirement.
**Depends on:** ADR 0030 §8.3; research `docs/superpowers/research/2026-10-12-in-loop-decisions/13-cleanroom-probe.md`.

## Goal

Render and use a per-run Seatbelt profile (`cleanroom.sb`) that makes a standing-approved command’s effect depend only on its approved bytes, the clock, and the remote server response — never on files planted in the shell workspace, user home, or daemon environment. Until this profile exists, the Stage 4 standing-approval v1 must not declare a sealed trial, per Codex review.

## Non-goals

- Standing approval logic, grant state, `/schedule` revoke UI, and schedule eligibility.
- New protected surface / ADR merge required here.
- Hunt for every possible exfiltration path; the profile mirrors the live probe results and is tested against the planted cases named in the evidence.
- Replacing the existing planner/shell profiles.

## Build slices

- **Slice 0 (renderer and chamber property only):** render and test the SBPL, path roots, profile grammar, per-run write/teardown IO-free checks.
- **Slice 1 (runtime):** add cleanroom execution helper, room/home lifecycle, report transfer.
- Stage 4A may not count a “sealed trial” until Slice 0 and the P8 live probe are both green.

## Existing context

- `src/omp/seatbelt.ts` currently renders two profiles (`renderSeatbelt(ctx)` → planner, shell).
- `src/omp/shell-adapter.ts` always uses `shell.sb`, the turn workspace, and `cfg.sandbox`.
- ADR 0030 §8.3 requires a fresh room and fresh home, fixed env, and a profile whose readable set does not overlap the planner/shell write set.

## Rendering API

Add a separate, explicit renderer:

```ts
export function renderCleanroom(ctx: PathContext, room: string, freshHome: string): string;
```

There is **no global write helper**. Each exec writes its rendered profile to a unique path derived from the unique room, then removes it in teardown. `writeSeatbeltProfiles` remains responsible only for planner and shell profiles.
- `room` and `freshHome` come from daemon-created, fresh, empty, non-overlapping directories under `HOUGE_DAEMON_TMP_DIR`; caller-supplied values are validated with `realpath`, containment and symlink rejection. A violation is a denied clean-room run, not profile forgiveness.
- The profile is rendered **per room path** because SBPL `subpath` rules and metadata rules are path-specific (`getcwd` needs ancestor metadata; planted symlinks).
- The profile body uses the round-5 probe findings and keeps SBPL order in explicit order: default allow baseline inherited by roots; then file deny/read/write layering; then process/network protections.

### Required SBPL facts (authoritative)

Profile must contain at least these rules (plus quoting via existing `esc`):

```scheme
(version 1)
(allow default)
(deny file-read*)
(allow file-read* (literal "/")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/private/etc/ssl")
  (literal "/dev/null")
  (subpath ROOM)
  (subpath HOME))
(allow file-read-data (literal "/"))
(allow file-read-metadata
  (literal "/")
  (literal "/etc") (literal "/var") (literal "/tmp")
  ANCESTORS-OF-ROOM ANCESTORS-OF-HOME)
(deny file-write*)
(allow file-write* (subpath ROOM) (literal "/dev/null"))
(deny signal (target others))
(deny process-exec (literal "/bin/launchctl"))
(deny process-exec (literal "/usr/bin/security"))
(deny process-exec (literal "/usr/bin/python3"))
(deny mach-lookup (global-name "com.apple.launchd"))
```

Rules:
1. `/private/etc` only exposes `/private/etc/ssl` as required by curl's OpenSSL configuration. Resolver setup uses DNS/mDNS IPC (`mDNSResponder`) rather than reads of `/etc/hosts` in this chain; the provisional rule set also attempts local denial for `localhost`, `127.0.0.0/8`, and `::1`, which P8 must either verify or capture as a signed residual. The property test must assert inability to read `/private/etc/hosts`, room's home, and `/private/tmp`.:
2. Ancestor metadata: from `/` down to `ROOM` and `HOME`, render `(allow file-read-metadata (literal <dir>))`. Do not render the leaf directory itself under metadata-only if it is already an `allow` root; SBPL is harmless but less tidy.
3. `(allow file-read-data (literal "/"))` is allowed (only directory-root entry listing).
4. IPC remains default in Slice 0 so rendering/unit tests compose. Slice 1 must probe and define an explicit allowlist (`com.apple.mDNSResponder`, `com.apple.trustd`, loader roots needed) plus candidate loopback/local-service denial rules on the target Mac. **Sealed trial credit stays disallowed** until that probe passes or ADR 0030 is amended to narrow the property. No sealed room claim may coexist with reachable Houge-managed local services.
5. No property of a child’s write root (`$HOME`, `/private/tmp`, workspace) is in ROOM’s readable set unless it is already an allowed system root. The renderer must have a test that proves this over real paths.

## Fixed environment and run directory

Standing clean-room execution must always use:
- `cwd = room`;
- `env -i` from `envClear` plus these variables only:
  - `PATH=/usr/bin:/bin:/usr/sbin:/sbin`
  - `LANG=C.UTF-8`
  - `HOME=HOME`
  - `CURL_HOME=HOME`
  - `XDG_CONFIG_HOME=HOME`
  - `TMPDIR=ROOM`
- Shell wrapper profile env: `SB = cleanroom.sb path`.
- Timeout and output cap inherited (32 KiB / `cfg.shellTimeoutMs`).
- `sandbox` must be enabled. If unavailable/disabled, clean-room use is invalid and Stage 4 logic must fall back to asking.

No field from the daemon (`OMP_PASSPHRASE`, API keys, token, workspace path) can reach the child. `buildChildEnv` must not be used for cleanroom exec.

**Environment enforcement:** outer wrapper holds `SB` and `HOUGE_SHELL_SANDBOX`; it launches the target as `sandbox-exec -f "$SB" /usr/bin/env -i PATH=... HOME=... ... /usr/bin/nice...`. The control values are consumed in the outer unsandboxed shell and are **not** entered in the command `execve` environment. Runtime evidence: child writes `env` output to stdout and test asserts exactly six names with exact values.

**Report delivery:** seal certification requires a report deliver-attempt observable by Paco (Telegram card or equivalent inbox), persisted as `report_delivered_at` with no schema rewrite. Command success alone, including silent exit 0/escaped, never awards credit. A failed delivery results in `sealed_trial_failed`, no credit, digest feedback, asking continues.

## Runtime seam (landing now, without standing behavior)

Implement `runCleanroomShell(deps, execution, signal?)` to mirror `shellToolExecute`, but:

- Rather than hard-coded `shell.sb`, write the cleanroom profile when `execution.room` and `execution.home` are valid; cache no profile globally (it is path specific).
- Pass `cwd=room`, `env` as above.
- Teardown both directories in `finally`, using an explicit room/home pair. Teardown errors surface as the existing `cleanup_failed` incident, not swallowed.
- The cleanroom profile is selected from the **validated execution record** (`executor: "cleanroom"`), which sits **outside** adapter input so it does not change the command fingerprint (ADR/degrade §8.3 B20). The bridge passes that validated flag to the executed study as an explicit, code-checked runtime field, and a bridge-to-wrapper test proves it selects `cleanroom.sb` instead of `shell.sb`.
- A clean-room run is certified only when its report reaches Paco. Delivery is counted only after a persisted audit/event record (existing decision runner path, or a migration-documented Stage 4 state) keyed to run_id + execution id. A `runShell.status === succeeded && escaped === true` result is **never** an eligible seal run; it counts as run failure and consumes denied-stage semantics. Silent exit-0 failures similarly do not certify. Teardown removes rooms in `finally`, but escaped children require incident and no Standing grant or sealed trial credit.

Jev and policy do **not** yet expose or force clean-room execution except through the future `approval.standing` entry. This means runtime becomes capable while staying behavior neutral for unlocked shell calls.

## Protected sandbox and compatibility

- The shell wrapper’s sandbox handling (`HOUGE_SHELL_SANDBOX`) remains as existing tests need it.
- If `sandbox-exec` is unavailable, clean-room exec fails safe by asking the normal path.
- Rendered profile idempotency: unchanged room/home yields identical SBPL bytes (stable tests).
- Room and home paths must be child paths of `HOUGE_DAEMON_TMP_DIR` (or equivalent cache root). That subpath must not overlap planner/shell write roots.

## Safety/security property tests

Unit/integration assertions:
1. `renderCleanroom` output contains all required blocking rules and no `planner`/ `shell` profile names by default.
2. Effective-profile overlap test: model the same room/home under `HOUGE_DAEMON_TMP_DIR`, then render/check planner and shell profiles for those cache paths and verify planner/shell deny areas remain later-denied. The test asserts *effective denial*, not naïve `writeRoots()` overlap.
3. Golden simulation tests:
   - `curl https://httpbin` style command can read OS TLS and DNS roots with canonical env;
   - `-H @/tmp/planted` fails;
   - symlink traversal outside room and through room symlink fails;
   - a planted `~/.curlrc` in `HOME0` is honored only if `HOME0` is freshest; in `ROOM` ignored;
   - malformed paths throw.
4. P8 probe:
   - sandboxed `curl 127.0.0.1` is blocked and profile prevents loopback read/modes;
   - command blocked with clear exit code, not swallowed.
5. Teardown:
   - both room/home removed even on failed command;
   - if one fails after command, incident emitted and profile not left.

## Probes / residual (P8)

Probe on target Mac (hard blocked residual/sealed trial):
- start a listener at `127.0.0.1`, `127.0.0.2`, `localhost`, `::1`; each must fail from sandbox for network connect and no file access.
- bridge socket probe: Houge's local daemon control socket or linked local service must be unreachable.
- test IPC process attempt (`sandbox-exec` minimal process) to confirm launchd, trustd and mDNS only where necessary.
- compare escape of `-d @/private/etc/hosts`, home, and `/private/tmp/x` to make sure they fail to read.
- If any local network service or Mach socket remains reachable, report to Paco with a signed residual before changing Stage 4 status.

## Acceptance gate (“when does Stage 4A inherit sealed run?”)

Stage 4A may switch pending to “cleanroom-sealed run” only when all four:
1. Cleanroom renderer and effective-policy overlap test pass.
2. P8 live probe documents **loopback + localhost + ::1 + bridge socket** as blocked; **no** sealed trial credit is granted if any reachable local services.
3. Spec and engine tests green.
4. Docs reflect either “all local services blocked” or a formal ADR 0030 amendment retreating the property claim.

## Open decisions

- Sleeve home as read-only to child: yes on first pass (probe confirms `.curlrc` must be honored only in readable HOME0).
- Whether to write `cleanroom.sb` into a new data file or reuse a generic builder. Proposed: renderer + write is isolated in `seatbelt.ts` because ADR needs clear rendering symmetry.
- `executor: "cleanroom"` is a **reserved validated-record flag**; direct helper tests may select it only behind a purpose-built trusted test harness, but seal and standing credit require the real bridge-to-wrapper selection test. No user/model input can add or override the flag.

## Next workflow

Write implementation plan via `writing-plans` after senior/codex review of this spec; then TDD, tests, full live verification, and Stage 4A work may reuse it.

```json
{ "name": "cleanroom profile", "status": "draft", "claims": "unit tests + probes", "blokers": ["P8 probe result"] }
```