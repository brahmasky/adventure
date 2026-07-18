# ADR 0023: External engineering workspace — container-sandboxed work on third-party repos

- **Status:** accepted
- **Deciders:** Paco (Money-Work Phase P1, 2026-07-17)

## Context

ADR 0022 re-opened the money fork narrowly: Houge may do the *engineering work* that earns money,
but never holds or moves the money. The first capability on that roadmap
(`docs/superpowers/specs/2026-07-17-money-work-roadmap.md`) is a workspace where Houge can do
engineering work on an **external, third-party repository** — clone a repo, implement a fix, and
prove it builds+tests — and hand back a reviewable patch.

This is fundamentally different from the self-write channel (ADR 0011). Self-write edits Houge's
OWN committed source (a worktree of HEAD, only tracked files, writer ≠ checker) and the objective
truth check runs on the host because the code IS ours. External work runs on **untrusted code we
did not write**: its build scripts, its test suite, its `postinstall` hooks, its dependencies. That
code must never touch the host.

## Decision

Add an isolated, container-sandboxed external engineering workspace as a new armed loop tool
(`external_work`), OFF by default. It is **charter-clean under ADR 0022**: it produces work only —
no money, no credentials, no external write, no autonomy. In P1 the deliverable is a **LOCAL patch**
(`runs/<id>/patch.diff` + `report.md`); a human reviews and applies it. Pushing to a remote is
explicitly deferred to a later phase (P3).

### Trust boundary — where each step runs

The untrusted external code runs in EXACTLY ONE place: the container. Host-side we do only the four
operations that cannot execute repo code:

| Step | Runs | Why it's safe on the host |
|------|------|---------------------------|
| `git clone --depth 1` | host | `git clone` executes NO repo hooks; `--no-tags --single-branch` minimizes surface; child env is the allowlist with no secrets. Host is SSRF-checked resolve-and-pin: `validateCloneUrl` (https-only, no creds, literal-IP block) THEN `assertCloneHostPublic` (DNS-resolve + classify every address) — a public name → private IP is refused |
| Codex edit (`workspace-write -C <clone>`) | host (Codex's own Seatbelt sandbox) | Codex writes files; it does not run the repo. NEVER a `--dangerously-bypass-*` flag (asserted in tests) |
| `git diff HEAD` | host | Run with **`--no-ext-diff --no-textconv`** — WITHOUT these, a malicious `.gitattributes` + repo-local git config could invoke an external-diff/textconv COMMAND on the host during diff (verifier MAJOR-2). The flags disable that host-exec path; the diff then only reads text |
| artifact write | host | writes `runs/<id>/` under the project root only |
| **deps install / build / test** | **container** | this is the only step that executes the repo's own code |

### Container containment (`buildContainerArgs`, the load-bearing surface)

Every container run is `docker/podman run --rm` with: `--network none` for build/test (fully
isolated) or the egress network for a deps install (the honest tradeoff below); EXACTLY ONE bind
mount (the scratch clone → `/work`); `--user 1000:1000` (non-root); `--read-only` root fs with a
`/tmp` tmpfs; `--cap-drop ALL`; `--security-opt no-new-privileges`; and `--memory`/`--cpus`/
`--pids-limit` caps. It NEVER emits a `docker.sock` mount, a host-root mount, or `--privileged`
(asserted by the load-bearing security test). The container env is the `buildChildEnv` allowlist
with no secrets — the untrusted code authenticates to nothing.

### Graceful degradation (no container runtime on this box)

`detectContainerRuntime` probes `docker version` then `podman version` and returns `null` on ANY
failure (mirrors the `embeddings.ts` probe-or-null contract). With no runtime, `external_work`
stops BEFORE cloning and delivers a "install docker/podman/colima" notice — it NEVER throws and
NEVER blocks the daemon. This machine has no runtime installed; live-container tests are deferred to
a live gate on a box that does, and every unit test injects a fake container runner.

### `side_effect_level: external_read`

The one outward flow is the `git clone` READ of a public repo (same class as `web_search`/
`http_fetch`/`self_diagnose` reading external data). The patch stays LOCAL — a human applies it — so
there is no write side effect and no `/approve` gate. This mirrors self-write's rationale: a
reversible, human-gated artifact is not in the irreversible class the approval gate guards.

### The install-stage egress tradeoff (honest)

Build/test run `--network none`. But a package manager (`npm ci`, `pip install`, `cargo fetch`)
MUST reach its registry, so the install stage runs on the egress network. This is a real, accepted
residual: during install, untrusted `postinstall`/`build.rs`/`setup.py` code runs with network
access (inside the container, non-root, no host mount, capped). It is contained to the container and
bounded by the resource caps, but it is not zero-network. Documented, not solved; a future phase can
add a registry proxy / vendored-deps mode inside this same chokepoint.

### Local-only artifact (P1)

The output is `runs/<id>/patch.diff` + `report.md`. No branch, no push, no PR. The notification
carries `[View diff]` / `[Discard]` — deliberately NO `[Merge]` (self-write has Merge because it is
OUR repo; an external patch is the human's to apply upstream). P3 owns external push.

## Consequences

- New files: `src/run/container-runner.ts`, `src/run/toolchain-gate.ts`,
  `src/capabilities/external-workspace.ts`.
- `external_work` joins the evolution loop tools: armed-listed (default OFF), terminal-after-success,
  runs on the background evolution lane under a 45-minute sub-contract, in the `/disarm` STOP set.
- Reuses without duplicating: the `http_fetch` SSRF floor (`validateFetchTarget`) for the clone URL,
  the cli-spawn total-function spawn for the container, the self-write refine loop shape, the
  report-writer artifact pattern, and the run-store ledger-event pattern
  (`external_work_published`/`external_work_failed`).
- Does NOT touch `quarantine.ts` / `self-write-guard.ts` / `secret-broker.ts`; zero npm deps.

## Amendment (2026-07-18) — live-gate findings

Live-gated on a real colima container (fix a real GitHub issue + containment probe). Two things
the gate surfaced, now fixed/recorded:

1. **Scratch root must be under a container-shared path.** `os.tmpdir()` on macOS
   (`/var/folders/…`) is NOT shared into colima's VM, so a clone there bind-mounts EMPTY and the
   non-root container user cannot write `node_modules`. Scratch clones now live under
   `~/.houge/extwork` (colima mounts `$HOME` writable), override `HOUGE_EXTWORK_SCRATCH_DIR`.
   Still never `process.cwd()`.
2. **Containment proven live:** in-container `id`=non-root, a write to the host home is BLOCKED
   (only the scratch `/work` is bind-mounted), the root fs is read-only, and `--network none`
   blocks egress on the build/test stage. The happy path ran real `npm ci [egress]` + `npm test
   [none]` and produced a correct local patch with the own repo untouched.
