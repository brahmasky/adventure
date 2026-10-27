# Clean-room runtime (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command can be run in the clean room end to end — fresh room/home, the Slice 0 profile plus the P8 network/IPC/exec rules, the fixed six-name environment, pre/post tamper checks, orphan scan, teardown in `finally` — selected only by `executor: "cleanroom"` on the per-call runtime context; nothing in production sets that flag yet.

**Architecture:** `seatbelt.ts` renders the hardened profile (pure). `cleanroom.ts` keeps validation/env/sidecar (Slice 0, unchanged API). New `cleanroom-run.ts` owns the lifecycle and returns a total, typed result; `shell-adapter.ts` is the single incident emitter and maps the result to the tool output. The wrapper gains one clean-room branch. Every other Houge child moves its TMPDIR to `<cache>/children`.

**Tech Stack:** Node 25 stdlib only (`dependencies: {}`), TypeScript strict (`noUncheckedIndexedAccess`), vitest, macOS `sandbox-exec` (SBPL), bash 3.2.57, curl 8.7.1, `/usr/sbin/lsof`.

**Spec:** `docs/superpowers/specs/2026-10-28-ladder-cleanroom-runtime-slice1-design.md` (Rev 5, approved; reading A of §Decision needed). Slice 0 spec `docs/superpowers/specs/2026-10-27-ladder-cleanroom-profile-design.md` §Slice 0 rulings stand.

## Global Constraints

- `dependencies: {}` stays empty. Node stdlib + devDeps only.
- Functions under 50 lines. Match surrounding style (dense one-liners, comments say *why*). No filename-header comments. No review tags (`B3`, `senior`, `codex`) in code comments or test names — write the reason instead.
- Tests live in `tests/<area>/` mirroring `src/`. Live (`sandbox-exec`) tests are `describe.runIf(process.platform === "darwin")`.
- Protected files edited under the approved spec: `src/omp/seatbelt.ts`, `src/omp/shell-wrapper.sh`, `src/omp/shell-wrapper.ts`, `src/llm/providers/omp.ts`. List them in the slice report.
- Every spawn site uses `buildChildEnv` **except** the clean-room run, which uses none of the daemon env.
- Commit per task, Conventional Commits, stage by name, each commit ends with `Co-Authored-By: Claude <model> <noreply@anthropic.com>` for the implementing model.
- Run `set -o pipefail; npm run typecheck && npx vitest run <file>` after every green step; never `| tail` without pipefail.
- Work in the worktree `.worktrees/cleanroom-slice1` on branch `feat/cleanroom-slice1` (created by the orchestrator). Gate scripts need `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env` and a built `dist/`.

## File structure

| File | Responsibility |
|---|---|
| `src/omp/seatbelt.ts` (modify) | `renderCleanroom`: P8 network/IPC block, exec allowlist (`CLEANROOM_EXEC_ALLOW`), zoneinfo reads, regex room write rule; new `sbplRegexLiteral` |
| `src/omp/cleanroom.ts` (unchanged API) | validation, brand, env, sidecar |
| `src/omp/cleanroom-run.ts` (create) | `runCleanroomShell`: availability, sweep, mkdtemp, validate, sidecar, pre-check, run, post-check, orphan scan, teardown; `CleanroomRunResult` |
| `src/omp/shell-adapter.ts` (modify) | `shellToolExecute(deps)(input, signal, ctx)`: executor selection, incident emitter, tool output shape |
| `src/omp/shell-wrapper.sh` + `shell-wrapper.ts` (modify) | clean-room branch; new hash |
| `src/tools/tool-registry.ts` (modify) | `SsrfContext.executor?: "cleanroom"` |
| `src/run/daemon-tmp.ts` (modify) | `childTmpRoot()` |
| `src/llm/providers/{omp,agy-models,agy-cli}.ts`, `src/capabilities/coding-agent.ts`, `src/omp/model-catalog.ts` (modify) | `TMPDIR: childTmpRoot()`; codex `-c sandbox_workspace_write.exclude_tmpdir_env_var=true` |
| `tests/omp/cleanroom.test.ts` (modify), `tests/omp/cleanroom-run.test.ts` (create), `tests/omp/shell-adapter.test.ts` (modify), `tests/omp/shell-wrapper.test.ts` (modify), `tests/run/daemon-tmp.test.ts` (modify), `tests/omp/child-tmpdir-sites.test.ts` (create), site tests (modify) | |
| `scripts/live-gate-cleanroom-runtime.mjs` (create) | the live gate |

---

### Task 1: Profile — P8 network/IPC block and the time-zone read set

**Files:**
- Modify: `src/omp/seatbelt.ts` (`renderCleanroom`, lines ~118–150)
- Test: `tests/omp/cleanroom.test.ts` (grammar `describe` at line 133; live `describe` at line 359)

**Interfaces:**
- Produces: `renderCleanroom(dirs: RoomPair): string` (unchanged signature) now containing, after the mach/launchd line:
  ```scheme
  (deny mach-lookup)
  (deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*") (remote udp4 "*:*"))
  (deny network-outbound (remote unix-socket))
  (allow network-outbound (literal "/private/var/run/mDNSResponder"))
  (deny network-inbound)
  (deny network-bind)
  ```
  and in the read set: `(allow file-read* (literal "/private/etc/localtime"))`, `(allow file-read* (subpath "/private/var/db/timezone"))`, `(allow file-read* (subpath "/usr/share/zoneinfo"))`, plus metadata literals for `/private`, `/private/var`, `/private/var/db`.
- Exports `CLEANROOM_NETWORK_RULES: readonly string[]` (the six lines, for the gate's byte check).

- [ ] **Step 1: Write the failing grammar tests** (append inside the `renderCleanroom —` describe):

```ts
  it("P8: denies every local network form, UDP, Unix sockets, listening and all Mach lookups — DNS keeps its one socket", () => {
    const p = renderCleanroom(dirs);
    expect(p).toContain("(deny mach-lookup)");
    // the three families sit in one rule and each names its family: a bare `(remote ip …)` stops matching IPv4
    // loopback as soon as any ip6 rule exists (measured 2026-10-28), so the grammar test forbids it outright
    expect(p).toContain('(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*") (remote udp4 "*:*"))');
    expect(p).not.toMatch(/\(remote ip "/);
    expect(p).toContain("(deny network-outbound (remote unix-socket))");
    expect(lines().filter((l) => l.startsWith("(allow network-outbound"))).toEqual(['(allow network-outbound (literal "/private/var/run/mDNSResponder"))']);
    expect(p).toContain("(deny network-inbound)");
    expect(p).toContain("(deny network-bind)");
    const mach = lines().indexOf("(deny mach-lookup)"); const net = lines().findIndex((l) => l.startsWith("(deny network-outbound (remote ip4"));
    expect(mach).toBeGreaterThan(0); expect(net).toBeGreaterThan(mach);
  });
  it("the room's clock is the host's: localtime and the zoneinfo trees are readable (root-owned, outside every write set)", () => {
    const p = renderCleanroom(dirs);
    for (const s of ['(literal "/private/etc/localtime")', '(subpath "/private/var/db/timezone")', '(subpath "/usr/share/zoneinfo")']) expect(p).toContain(`(allow file-read* ${s})`);
    for (const d of ["/private", "/private/var", "/private/var/db"]) expect(p).toContain(`(allow file-read-metadata (literal "${d}"))`);
  });
```
Update the existing count assertion (line ~148): `expect(allows).toHaveLength(11); // "/" literal + 4 system trees + /dev/null + 3 time-zone paths + room + home`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/omp/cleanroom.test.ts -t "P8|clock|re-allows reads"`
Expected: FAIL (`(deny mach-lookup)` missing; length 8 ≠ 11).

- [ ] **Step 3: Implement** in `src/omp/seatbelt.ts`:

```ts
/**
 * P8 (spec §P8 evidence, measured 2026-10-28): nothing on this host is reachable — loopback in every spelling, the
 * host's own addresses, IPv4-mapped IPv6, UDP of any kind (so no broadcast/multicast path to a local service), Unix
 * sockets but the resolver's, listening, Mach lookups. Families are named on every filter and sit in ONE rule: a bare
 * `ip` filter stops matching IPv4 loopback once any ip6 rule exists, and network rules interact non-locally, so the
 * exact text is pinned and the live matrix re-runs on every edit. Cost: TCP egress only, no IPv6 egress.
 */
export const CLEANROOM_NETWORK_RULES: readonly string[] = [
  "(deny mach-lookup)",
  '(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*") (remote udp4 "*:*"))',
  "(deny network-outbound (remote unix-socket))",
  '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
  "(deny network-inbound)",
  "(deny network-bind)"
];
/** Root-owned, outside every write set; without them `date` in the room is UTC and a "book tomorrow" command is wrong for hours a day. */
const CLEANROOM_TZ_READS = ['(allow file-read* (literal "/private/etc/localtime"))', '(allow file-read* (subpath "/private/var/db/timezone"))', '(allow file-read* (subpath "/usr/share/zoneinfo"))'];
const CLEANROOM_TZ_META = ["/private", "/private/var", "/private/var/db"];
```
In `renderCleanroom`: insert `...CLEANROOM_TZ_READS,` after the `/dev/null` read allow; add `...CLEANROOM_TZ_META` into the metadata `Set`; append `...CLEANROOM_NETWORK_RULES` after the launchd mach line. Update the doc comment: remove "Network and the rest of IPC stay default in Slice 0 …" and say the P8 block closes them.

- [ ] **Step 4: Run grammar tests** — `npx vitest run tests/omp/cleanroom.test.ts` → all PASS (the existing live tests still pass: `curl http://127.0.0.1:1/` is still exit 7 — denied connect reads as "failed to connect").

- [ ] **Step 5: Write the failing live tests** (inside the darwin `live clean room` describe; add `spawn` to the `node:child_process` import at the top):

```ts
  /**
   * A dual-stack HTTP listener on an ephemeral port, in a CHILD process: the control curl and `run` use spawnSync, which
   * blocks this event loop, so an in-process server could never answer the control (the test would then deadlock to 000).
   */
  async function localListener(): Promise<{ port: number; close: () => Promise<void> }> {
    const c = spawn(process.execPath, ["-e", 'const s=require("http").createServer((q,r)=>r.end("local"));s.listen(0,"::",()=>console.log(s.address().port))'], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<number>((r) => c.stdout!.once("data", (d) => r(Number(String(d).trim()))));
    return { port, close: async () => { c.kill(); } };
  }
  it("P8 live: a local HTTP listener is unreachable as 127.0.0.1, localhost, [::1], [::ffff:127.0.0.1] and 0.0.0.0, while the control (unsandboxed) reaches it", async () => {
    const { port, close } = await localListener();
    try {
      const ctl = spawnSync("/usr/bin/curl", ["-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/`], { encoding: "utf8" });
      expect(ctl.stdout).toBe("200"); // the listener works: a denied connect below is the sandbox, not a dead port
      const { run } = sealedRoom();
      for (const host of ["127.0.0.1", "localhost", "[::1]", "[::ffff:127.0.0.1]", "0.0.0.0"]) {
        const r = run(`/usr/bin/curl -s -m 3 -o /dev/null -w '%{http_code}' http://${host}:${port}/`);
        expect(r.status, host).toBe(7); expect(r.stdout, host).toBe("000");
      }
    } finally { await close(); }
  });
  it("P8 live: a UDP datagram to loopback is refused through bash's own /dev/udp (no nc: the allowlist denies it, so a probe through it would pass for the wrong reason)", () => {
    const { run } = sealedRoom();
    const r = run("exec 3<>/dev/udp/127.0.0.1/9 && echo sent >&3 && echo UDP-SENT");
    expect(r.stdout).not.toContain("UDP-SENT"); expect(r.stderr).toMatch(/Operation not permitted/);
  });
  it("P8 live: a Unix socket in the room is unreachable (the bridge sockets are Unix sockets); the unsandboxed control reaches it", async () => {
    const { run, dirs } = sealedRoom();
    const sock = join(dirs.room, "t.sock");
    const c = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>r.end("u")).listen(${JSON.stringify(sock)},()=>console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((r) => c.stdout!.once("data", () => r()));
    try {
      expect(spawnSync("/usr/bin/curl", ["-s", "-m", "3", "--unix-socket", sock, "http://x/"], { encoding: "utf8" }).stdout).toBe("u");
      expect(run(`/usr/bin/curl -s -m 3 --unix-socket "${sock}" http://x/`).status).toBe(7);
    } finally { c.kill(); }
  });
  it("P8 live: HTTPS to a remote host still works and a bad certificate is still rejected — TLS needs no Mach lookup (skipped offline)", () => {
    const { run } = sealedRoom();
    const ctl = spawnSync("/usr/bin/curl", ["-s", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com/"], { encoding: "utf8" });
    if (ctl.stdout !== "200") return; // offline: the gate owns the network verdict (INCONCLUSIVE there), this test must not fail a laptop
    expect(run("/usr/bin/curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com/").stdout).toBe("200");
    expect(run("/usr/bin/curl -s -m 8 -o /dev/null https://expired.badssl.com/").status).toBe(60);
  });
  it("the room's clock is the host's (zoneinfo readable): `date +%Z` matches outside the sandbox", () => {
    const { run } = sealedRoom();
    const host = spawnSync("/bin/date", ["+%Z"], { encoding: "utf8" }).stdout.trim();
    expect(run("/bin/date +%Z").stdout.trim()).toBe(host);
  });
```

- [ ] **Step 6: Run live tests** — `npx vitest run tests/omp/cleanroom.test.ts` → PASS (the implementation is already in). If the UDP case prints `UDP-SENT`, the rule text is wrong — do not weaken the test.

- [ ] **Step 7: Commit**
```bash
git add src/omp/seatbelt.ts tests/omp/cleanroom.test.ts
git commit -m "feat(omp): clean-room profile closes P8 — local network, UDP, Unix sockets, bind, Mach; room clock readable"
```

---

### Task 2: Profile — exec allowlist and the regex room write rule

**Files:**
- Modify: `src/omp/seatbelt.ts`
- Test: `tests/omp/cleanroom.test.ts`

**Interfaces:**
- Produces: `export const CLEANROOM_EXEC_ALLOW: readonly string[]` (absolute paths); `export function sbplRegexLiteral(path: string): string` (exact regex body: every char outside `[A-Za-z0-9/_-]` backslash-escaped; a `"` or `\` in the path throws — SBPL has no escape for them inside `#"…"`); the room write rule becomes `(allow file-write* (regex #"^<sbplRegexLiteral(room)>/"))` for each variant of the room path.

- [ ] **Step 1: Failing grammar tests**

```ts
  it("exec allowlist: process-exec* is denied by default and re-allowed only for the named binaries, each of which exists on this Mac", () => {
    const p = renderCleanroom(dirs); const l = lines();
    expect(l.indexOf("(deny process-exec*)")).toBeGreaterThan(l.indexOf('(deny process-exec (literal "/usr/bin/python3"))'));
    const allow = l.find((x) => x.startsWith("(allow process-exec* "))!;
    expect(l.indexOf(allow)).toBeGreaterThan(l.indexOf("(deny process-exec*)"));
    for (const b of CLEANROOM_EXEC_ALLOW) expect(allow, b).toContain(`(literal "${b}")`);
    for (const b of ["/bin/bash", "/usr/bin/env", "/usr/bin/nice", "/usr/bin/curl", "/bin/date", "/bin/test", "/bin/pwd"]) expect(CLEANROOM_EXEC_ALLOW).toContain(b);
    for (const b of ["/usr/bin/perl", "/usr/bin/python3", "/usr/bin/ruby", "/usr/bin/script", "/usr/bin/screen", "/usr/bin/osascript", "/usr/bin/nc", "/usr/bin/openssl"]) expect(allow, b).not.toContain(`"${b}"`); // never in the allow line (python3 appears only in its deny)
    if (process.platform === "darwin") for (const b of CLEANROOM_EXEC_ALLOW) expect(existsSync(b), b).toBe(true); // /usr/bin/test does not exist here; /bin/test does
  });
  it("the room is writable inside but the room path itself is not: an orphan cannot re-create the room after teardown", () => {
    const p = renderCleanroom(dirs);
    expect(p).toContain(`(allow file-write* (regex #"^${dirs.room}/"))`);
    expect(p).not.toContain(`(allow file-write* (subpath "${dirs.room}"))`);
    expect(lastRuleFor(p, "file-write*", `${dirs.room}/cj.txt`)).toBe("allow");
    expect(lastRuleFor(p, "file-write*", dirs.room)).toBe("deny");
    expect(lastRuleFor(p, "file-write*", `${dirs.room}-evil/x`)).toBe("deny");
  });
  it("sbplRegexLiteral is exact: a room path with regex punctuation matches itself and not a sibling that differs only there (regexPath widens on purpose for denies; an allow may not)", () => {
    const room = "/Users/p/Library/Caches/h.d+(1)[a]/cleanroom/room-1";
    const rule = `(allow file-write* (regex #"^${sbplRegexLiteral(room)}/"))`;
    expect(lastRuleFor(rule, "file-write*", `${room}/f`)).toBe("allow");
    expect(lastRuleFor(rule, "file-write*", "/Users/p/Library/Caches/hXd+(1)[a]/cleanroom/room-1/f")).toBeNull();
    expect(lastRuleFor(rule, "file-write*", "/Users/p/Library/Caches/h.dd(1)a/cleanroom/room-1/f")).toBeNull();
    expect(() => sbplRegexLiteral('/x/q"uote')).toThrow(/quote|backslash/);
  });
```
Import `CLEANROOM_EXEC_ALLOW, sbplRegexLiteral` from `../../src/omp/seatbelt.js`.

Three EXISTING tests in this file change with the write rule (they assert the old `subpath` form; verified by running the suite on a copy):
- line ~169 ("renders both spellings…"): replace the write-rule expectation with `expect(p).toContain(\`(allow file-write* (regex #"^${sbplRegexLiteral(\`${v}/room\`)}/"))\`);`
- line ~178 ("denies every write…"): `expect(writes).toEqual([\`(allow file-write* (regex #"^${dirs.room}/"))\`, '(allow file-write* (literal "/dev/null"))']);`
- line ~187 ("is deterministic … escapes quotes"): split in two — a room path containing `"` or `\` now makes `renderCleanroom` throw (`expect(() => renderCleanroom(odd)).toThrow(/quote|backslash/)`; `runCleanroomShell` reports that as `cleanroom_setup` at step `sidecar`), and the read-rule escaping is kept by moving the odd characters into the **home** path only (`home: join(cache, 'h"\\1')`, clean room) with the existing read-allow assertion.

- [ ] **Step 2: Run** → FAIL (exports missing; the three existing tests fail until Step 3 lands).

- [ ] **Step 3: Implement** in `seatbelt.ts`:

```ts
/**
 * Exact SBPL regex body for an ALLOW: every character outside [A-Za-z0-9/_-] is backslash-escaped (regexPath widens
 * punctuation to wildcards, right for a deny, wrong here). SBPL's #"…" has no escape for `"` or `\`: such a path cannot
 * be rendered safely, so it is refused rather than approximated.
 */
export function sbplRegexLiteral(p: string): string {
  if (/["\\]/.test(p)) throw new Error("sbplRegexLiteral: a quote or backslash in a path cannot be rendered");
  return [...p].map((c) => (/^[A-Za-z0-9/_-]$/.test(c) ? c : `\\${c}`)).join("");
}

/**
 * The only binaries a sealed command may exec (spec §Exec allowlist). Everything that can call setsid() — perl, python,
 * ruby, script, screen — is out, so an orphan stays in the wrapper's session and keeps its sandbox; a command that needs
 * another binary is a per-command ruling, never a looser profile. /usr/bin/test does not exist on macOS; /bin/test does.
 */
export const CLEANROOM_EXEC_ALLOW: readonly string[] = [
  "/bin/bash", "/bin/sh", "/usr/bin/env", "/usr/bin/nice", "/usr/bin/curl", "/bin/date", "/bin/pwd", "/usr/bin/grep", "/usr/bin/sed",
  "/usr/bin/awk", "/usr/bin/head", "/usr/bin/tail", "/usr/bin/tr", "/usr/bin/cut", "/usr/bin/sort", "/usr/bin/uniq", "/usr/bin/wc",
  "/bin/cat", "/bin/echo", "/bin/ls", "/bin/mkdir", "/bin/rm", "/usr/bin/basename", "/usr/bin/dirname", "/usr/bin/printf",
  "/usr/bin/tee", "/usr/bin/xargs", "/usr/bin/base64", "/bin/sleep", "/usr/bin/true", "/usr/bin/false", "/bin/test"
];
```
In `renderCleanroom`: replace the room write line with `...variants(dirs.room).map((v) => \`(allow file-write* (regex #"^${sbplRegexLiteral(v)}/"))\`)`; after the python3 deny add `"(deny process-exec*)", \`(allow process-exec* ${CLEANROOM_EXEC_ALLOW.map((b) => \`(literal "${b}")\`).join(" ")})\``. Keep the three literal denies (explicit, comparable with the other profiles).

- [ ] **Step 4: Run** `npx vitest run tests/omp/cleanroom.test.ts` → grammar PASS. The existing live tests exec `/bin/echo /bin/pwd /bin/cat /bin/ls /usr/bin/curl /usr/bin/env /bin/launchctl /usr/bin/security /usr/bin/python3` — all still behave (the last three still `Operation not permitted`).

- [ ] **Step 5: Failing live tests**

```ts
  it("exec allowlist live: perl and script are refused (the setsid() carriers), the allowed pipeline runs", () => {
    const { run } = sealedRoom();
    for (const cmd of ["/usr/bin/perl -e 1", "/usr/bin/script -q /dev/null /usr/bin/true", "/usr/bin/ruby -e 1"]) {
      const r = run(cmd); expect(r.status, cmd).toBe(126); expect(r.stderr, cmd).toMatch(/Operation not permitted/);
    }
    const ok = run("/bin/echo a b | /usr/bin/tr ' ' '\\n' | /usr/bin/wc -l | /usr/bin/tr -d ' '");
    expect(ok.status).toBe(0); expect(ok.stdout.trim()).toBe("2");
  });
  it("write rule live: files and subdirectories inside the room are writable, the room path itself is not re-creatable once removed", () => {
    const { run, dirs } = sealedRoom();
    expect(run("/bin/echo hi > f.txt && /bin/mkdir sub && /bin/echo ok").stdout.trim()).toBe("ok");
    rmSync(dirs.room, { recursive: true, force: true });
    // cwd is gone: run from the home (readable) instead
    const r = spawnSync("/usr/bin/env", ["-i", ...Object.entries(cleanroomEnv(dirs)).map(([k, v]) => `${k}=${v}`), "/usr/bin/sandbox-exec", "-f", join(dirs.home, CLEANROOM_PROFILE_NAME), "/bin/bash", "-c", `/bin/mkdir "${dirs.room}"`], { cwd: dirs.home, encoding: "utf8" });
    expect(r.status).not.toBe(0); expect(r.stderr).toMatch(/Operation not permitted/); expect(existsSync(dirs.room)).toBe(false);
  });
  it("bind live: with the real profile plus exactly one appended exec allow for nc, nc -l cannot bind (the network lines are byte-identical)", () => {
    const { dirs, profile, env } = sealedRoom();
    const real = readFileSync(profile, "utf8");
    const variant = `${real}(allow process-exec* (literal "/usr/bin/nc"))\n`;
    expect(variant.split("\n").filter((l) => l.includes("network"))).toEqual(real.split("\n").filter((l) => l.includes("network")));
    const vp = join(dirs.home, "variant.sb"); writeFileSync(vp, variant);
    const r = spawnSync("/usr/bin/env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/usr/bin/sandbox-exec", "-f", vp, "/usr/bin/nc", "-l", "127.0.0.1", "48999"], { cwd: dirs.room, encoding: "utf8", timeout: 3000 });
    // nc is the first exec here, so the refusal is sandbox-exec's own (rc 1, "nc: Operation not permitted"), not bash's 126
    expect(r.stderr).toMatch(/Operation not permitted/); expect(r.status).not.toBe(0);
  });
```
(`sealedRoom` writes the profile before the test writes `variant.sb` into the home — the home's emptiness was already checked; this test does not claim the home stays empty.)

- [ ] **Step 6: Run** → PASS. **Step 7: Commit**
```bash
git add src/omp/seatbelt.ts tests/omp/cleanroom.test.ts
git commit -m "feat(omp): clean-room exec allowlist and a room write rule that cannot re-create the room"
```

---

### Task 3: Children's TMPDIR → `<cache>/children`; codex excludes `$TMPDIR`; agy permission lock

**Files:**
- Modify: `src/run/daemon-tmp.ts`; `src/llm/providers/omp.ts:65`; `src/llm/providers/agy-models.ts:54`; `src/llm/providers/agy-cli.ts:197`; `src/capabilities/coding-agent.ts:36` and `buildCodexWriteArgs` (~line 104); `src/omp/model-catalog.ts:47`
- Test: `tests/run/daemon-tmp.test.ts`; create `tests/omp/child-tmpdir-sites.test.ts`; modify `tests/llm/providers/omp.test.ts:100-104`, `tests/capabilities/coding-agent-env.test.ts`, `tests/capabilities/coding-agent-write.test.ts:45-`, `tests/llm/providers/agy-cli.test.ts:82-`

**Interfaces:**
- Produces: `export function childTmpRoot(): string` in `daemon-tmp.ts` = `join(daemonTmpRoot(), "children")`, created `0700`.

- [ ] **Step 1: Failing tests**

`tests/run/daemon-tmp.test.ts` (import `childTmpRoot`; import `cleanroomRoot` from `../../src/omp/cleanroom.js`; `statSync` is imported already):
```ts
  it("every other child's TMPDIR is a sibling of the clean rooms, never an ancestor: <cache>/children vs <cache>/cleanroom, by path and by inode", () => {
    const c = childTmpRoot(); const r = cleanroomRoot();
    expect(c).toBe(join(daemonTmpRoot(), "children")); expect(statSync(c).mode & 0o777).toBe(0o700);
    expect(r.startsWith(c + "/")).toBe(false); expect(c.startsWith(r + "/")).toBe(false);
    mkdirSync(r, { recursive: true });
    expect(statSync(c, { bigint: true }).ino).not.toBe(statSync(r, { bigint: true }).ino);
  });
```
`tests/omp/child-tmpdir-sites.test.ts` (new; the grep-style lockstep):
```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../../src", import.meta.url).pathname;
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });

describe("child TMPDIR sites — no Houge child gets the cache root (the rooms' parent) as its temp space", () => {
  it("no src file passes TMPDIR: daemonTmpRoot(); the five CLI spawn sites pass childTmpRoot()", () => {
    const src = files(SRC).map((f) => [relative(SRC, f), readFileSync(f, "utf8")] as const);
    expect(src.filter(([, t]) => /TMPDIR:\s*daemonTmpRoot\(\)/.test(t)).map(([f]) => f)).toEqual([]);
    const sites = src.filter(([, t]) => /TMPDIR:\s*childTmpRoot\(\)/.test(t)).map(([f]) => f).sort();
    expect(sites).toEqual(["capabilities/coding-agent.ts", "llm/providers/agy-cli.ts", "llm/providers/agy-models.ts", "llm/providers/omp.ts", "omp/model-catalog.ts"]);
  });
});
```
`tests/llm/providers/omp.test.ts:100-104`: rename to "runs the one-shot with TMPDIR=<cache>/children — a sibling of the clean rooms, never their parent" and `expect(argvLog()[0].tmpdir).toBe(childTmpRoot());` (import `childTmpRoot`).
`tests/capabilities/coding-agent-write.test.ts` `buildCodexWriteArgs` describe: expected array gains `"-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true"` after `"-C", "/wt"`; add an `it`: "excludes $TMPDIR from codex's writable set: with the default, a sandboxed command wrote into TMPDIR (executed 2026-10-28); with the key it got Operation not permitted" asserting the two strings are adjacent in the array.
`tests/capabilities/coding-agent-env.test.ts`: in the env-dump test add `expect(childEnv.split("\n")).toContain(\`TMPDIR=${childTmpRoot()}\`);` (no regex: a regex-escaped path is easy to get wrong and passes vacuously on a plain path).
`tests/capabilities/coding-agent-write.test.ts`: BOTH `toEqual` arrays in the `buildCodexWriteArgs` describe (the no-model one at line ~47 and the `"gpt-5"` one at line ~70) gain `"-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true"` right after `"-C", "/wt"`.
`tests/llm/providers/agy-models.test.ts` and `tests/omp/model-catalog.test.ts`: in each file's existing spawn-recording test (agy-models line ~38 "caches the resolution"; model-catalog line ~37 "runs `omp --profile …`") add one assertion that the recorded spawn's `env.TMPDIR === childTmpRoot()` — every one of the five sites gets a stubbed-spawn check, not only the grep.
`tests/llm/providers/agy-cli.test.ts` after the args assertion (line ~100) add:
```ts
    // agy is agentic: its only write lock headless is the permission prompt, which print mode auto-denies.
    // Neither flag that removes it may ever appear (a prompt-injected transcript could then plant a file).
    expect(args).not.toContain("--dangerously-skip-permissions"); expect(args).not.toContain("--mode");
    expect(opts.env.TMPDIR).toBe(childTmpRoot()); // opts is SpawnOpts (child-env.ts): env is Record<string, string>
```

- [ ] **Step 2: Run** the five test files → FAIL (no `childTmpRoot`).

- [ ] **Step 3: Implement**

`daemon-tmp.ts` after `daemonTmpRoot`:
```ts
/**
 * TMPDIR for every child that is not a sealed command (agy, codex, omp one-shots, the catalog): a SIBLING of
 * `cleanroom/`, never its parent. codex's workspace-write sandbox grants writes to $TMPDIR (measured: default WROTE,
 * excluded DENIED), so with the root as TMPDIR a prompt-injected codex turn could plant a .curlrc in a fresh home.
 */
export function childTmpRoot(): string {
  const dir = join(daemonTmpRoot(), "children");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // an existing directory with a looser mode is tightened, as the root is
  return dir;
}
```
Five sites: `TMPDIR: childTmpRoot()` (import it; drop the `daemonTmpRoot` import where it becomes unused — `agy-models.ts` keeps it for `cwd`). `buildCodexWriteArgs`: `const args = ["exec", "--json", "--sandbox", "workspace-write", "-C", worktree, "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true"];` with a comment citing the measured default.

- [ ] **Step 4: Run** the five files + `npm run typecheck` → PASS. **Step 5: Commit**
```bash
git add src/run/daemon-tmp.ts src/llm/providers/omp.ts src/llm/providers/agy-models.ts src/llm/providers/agy-cli.ts src/capabilities/coding-agent.ts src/omp/model-catalog.ts tests/run/daemon-tmp.test.ts tests/omp/child-tmpdir-sites.test.ts tests/llm/providers/omp.test.ts tests/capabilities/coding-agent-write.test.ts tests/capabilities/coding-agent-env.test.ts tests/llm/providers/agy-cli.test.ts tests/llm/providers/agy-models.test.ts tests/omp/model-catalog.test.ts
git commit -m "feat(run): children's TMPDIR moves beside the clean rooms; codex excludes \$TMPDIR from its writable set"
```

---

### Task 4: Wrapper clean-room mode

**Files:**
- Modify: `src/omp/shell-wrapper.sh` (branch at lines 16–20), `src/omp/shell-wrapper.ts` (hash)
- Test: `tests/omp/shell-adapter.test.ts` (new describe), `tests/omp/shell-wrapper.test.ts` (hash lockstep already exists)

**Interfaces:**
- Consumes: env `SB`, `HOUGE_SHELL_SANDBOX` (today); new control names `HOUGE_SHELL_CLEANROOM=1`, `CR_HOME`, `CR_ROOM`.
- Produces: in clean-room mode the command runs as `/usr/bin/sandbox-exec -f "$SB" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C.UTF-8 HOME="$CR_HOME" CURL_HOME="$CR_HOME" XDG_CONFIG_HOME="$CR_HOME" TMPDIR="$CR_ROOM" /usr/bin/nice -n 10 /bin/bash -c "$1" 3>&-`; missing `CR_HOME`/`CR_ROOM` → `limits_failed` (exit 97, deliberately reused: three status values only).

- [ ] **Step 1: Failing tests** (new describe in `tests/omp/shell-adapter.test.ts`; uses `input()` and `WRAPPER`; import `cleanroomEnv` from `../../src/omp/cleanroom.js`):

```ts
describe("shell wrapper — clean-room mode", () => {
  /** A permissive profile: this describe tests the wrapper's env/cwd plumbing, not the sandbox (cleanroom.test.ts does). */
  function openProfile(): string { const d = tmp("houge-cr-sb-"); const p = join(d, "open.sb"); writeFileSync(p, "(version 1)\n(allow default)\n"); return p; }
  it("runs the command under env -i with exactly the six fixed names plus bash's own, cwd = room, and ignores HOUGE_SHELL_SANDBOX=0", async () => {
    const room = tmp("houge-cr-room-"); const home = tmp("houge-cr-home-");
    const r = await runShell(input("/usr/bin/env; /bin/pwd", { cwd: room, profilePath: openProfile(), sandbox: true,
      env: { HOUGE_SHELL_CLEANROOM: "1", CR_HOME: home, CR_ROOM: room, HOUGE_SHELL_SANDBOX: "0", HOUGE_LEAK: "no" } }));
    expect(r).toMatchObject({ status: "succeeded", exitCode: 0 });
    const seen = Object.fromEntries(r.output.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    // the wrapper's literals and cleanroomEnv() must say the same thing: this is the drift test the spec asks for
    expect(Object.keys(seen).sort()).toEqual([...Object.keys(cleanroomEnv({ room, home })), "PWD", "SHLVL", "_"].sort());
    expect(seen).toMatchObject(cleanroomEnv({ room, home }));
    expect(r.output.trim().endsWith(room)).toBe(true);
    expect(r.output).not.toContain("HOUGE_LEAK"); expect(r.output).not.toContain("SB=");
  });
  it("takes the clean-room branch even when sandbox is off for the normal path: HOUGE_SHELL_SANDBOX=0 never means unsandboxed here", async () => {
    const room = tmp("houge-cr-room-"); const home = tmp("houge-cr-home-"); const d = tmp("houge-cr-sb-"); const p = join(d, "deny.sb");
    writeFileSync(p, '(version 1)\n(allow default)\n(deny file-read* (literal "/private/etc/hosts"))\n');
    const r = await runShell(input("/bin/cat /etc/hosts", { cwd: room, profilePath: p, sandbox: false, env: { HOUGE_SHELL_CLEANROOM: "1", CR_HOME: home, CR_ROOM: room, HOUGE_SHELL_SANDBOX: "0" } }));
    expect(r.status).toBe("succeeded"); expect(r.exitCode).not.toBe(0); expect(r.output).toMatch(/Operation not permitted/);
  });
  it("fails closed with limits_failed when the control env is incomplete (a daemon bug, not a runtime state — the three status values are kept)", async () => {
    const room = tmp("houge-cr-room-");
    const r = await runShell(input("echo ran", { cwd: room, profilePath: openProfile(), sandbox: true, env: { HOUGE_SHELL_CLEANROOM: "1", CR_ROOM: room } }));
    expect(r).toMatchObject({ status: "failed", reason: "limits_failed", exitCode: 97 }); expect(r.output).not.toContain("ran");
  });
  it("still kills a backgrounded child in the group and reports ok (the cleanup loop runs after the clean-room branch too)", async () => {
    const room = tmp("houge-cr-room-"); const home = tmp("houge-cr-home-"); const tag = `houge-cr-bg-${Date.now()}`;
    const r = await runShell(input(`(exec -a ${tag} /bin/sleep 8) & echo m`, { cwd: room, profilePath: openProfile(), sandbox: true, env: { HOUGE_SHELL_CLEANROOM: "1", CR_HOME: home, CR_ROOM: room } }));
    expect(r).toMatchObject({ status: "succeeded", wrapperStatus: "ok" }); expect(alive(tag)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL (the normal branch runs: env shows PATH from the test env, `HOUGE_LEAK` present).

- [ ] **Step 3: Implement** — replace the `if/else` in `shell-wrapper.sh` with:

```bash
if [ "${HOUGE_SHELL_CLEANROOM:-0}" = "1" ]; then
  # clean room (decision ladder §8.3): always sandboxed, nothing inherited — the six names below are the whole env.
  # SB, CR_* and HOUGE_SHELL_* are consumed here, outside the sandbox, and never reach the command's execve.
  [ -n "$CR_HOME" ] && [ -n "$CR_ROOM" ] || lf
  /usr/bin/sandbox-exec -f "$SB" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C.UTF-8 \
    HOME="$CR_HOME" CURL_HOME="$CR_HOME" XDG_CONFIG_HOME="$CR_HOME" TMPDIR="$CR_ROOM" \
    /usr/bin/nice -n 10 /bin/bash -c "$1" 3>&-; rc=$?
elif [ "${HOUGE_SHELL_SANDBOX:-1}" = "0" ]; then
  PATH=$cmd_path /usr/bin/nice -n 10 /bin/bash -c "$1" 3>&-; rc=$?
else
  PATH=$cmd_path /usr/bin/sandbox-exec -f "$SB" /usr/bin/nice -n 10 /bin/bash -c "$1" 3>&-; rc=$?
fi
```
Update the header comment (env line: add `HOUGE_SHELL_CLEANROOM=1 + CR_HOME/CR_ROOM = clean-room mode`). Then `shasum -a 256 src/omp/shell-wrapper.sh` → paste into `SHELL_WRAPPER_SHA256`.

- [ ] **Step 4: Run** `npx vitest run tests/omp/shell-adapter.test.ts tests/omp/shell-wrapper.test.ts` → PASS (all existing wrapper tests included). **Step 5: Commit**
```bash
git add src/omp/shell-wrapper.sh src/omp/shell-wrapper.ts tests/omp/shell-adapter.test.ts
git commit -m "feat(omp): shell wrapper clean-room mode — env -i with the six fixed names, never unsandboxed"
```

---

### Task 5: `runCleanroomShell` — lifecycle, checks, orphan scan, teardown

**Files:**
- Create: `src/omp/cleanroom-run.ts`
- Test: `tests/omp/cleanroom-run.test.ts` (create)

**Interfaces:**
- Consumes: `validateCleanroomDirs`, `writeCleanroomProfile`, `cleanroomRoot`, `CLEANROOM_PROFILE_NAME`, `CleanroomPathError` (`cleanroom.ts`); `renderCleanroom` (`seatbelt.ts`); `runShell`, `ShellRunResult`, `ShellFailure` (`shell-adapter.ts`); `OmpConfig`.
- Produces:
```ts
export type CleanroomFailure = ShellFailure | "cleanroom_unavailable" | "cleanroom_setup" | "cleanroom_invalid" | "cleanroom_tampered";
/** Total: never throws; every exit is one of these shapes. The COMPLETE declaration — Task 6 and the tests use every field. */
export type CleanroomRunResult = Omit<ShellRunResult, "reason"> & {
  reason?: CleanroomFailure;
  executor: "cleanroom";
  /** The wrapper was spawned (the command may have had an effect). False for every pre-spawn exit, for `spawn`, and for a late abort. */
  ran: boolean;
  /** Absent when the run failed before a room existed. */
  room?: string;
  torn_down: boolean;
  tampered: boolean;
  /** Which check saw the escape: the wrapper's pipe check, the lsof cwd scan, or both. Set whenever `escaped` is. */
  escape_source?: "pipe" | "orphan_scan" | "both";
  orphans?: number[];
  /** Names the sweep removed (pushed as removed, so a sweep that throws midway still reports the ones gone). */
  swept?: string[];
  tamper_names?: string[];
  setup_step?: "root" | "sweep" | "mkdtemp" | "sidecar" | "precheck";
  setup_error?: string;
  invalid_reason?: CleanroomReason;
  teardown_error?: string;
  check_error?: string;
};
export interface CleanroomDeps {
  cfg: Pick<OmpConfig, "sandbox" | "shellTimeoutMs">; distDir: string;
  /** Tests only: clock for the sweep, lsof text, the remover, and two tamper hooks (after the sidecar is written; right after runShell is invoked). */
  now?: () => number; lsof?: (uid: number) => string; rm?: (path: string) => void;
  afterSidecar?: (dirs: RoomPair) => void; afterSpawn?: (dirs: RoomPair) => void;
  /** Tests only: stands in for runShell (a resolved `reason: "spawn"` cannot be produced with the real wrapper — bash itself always spawns). */
  shell?: typeof runShell;
}
export function runCleanroomShell(deps: CleanroomDeps, command: string, signal?: AbortSignal): Promise<CleanroomRunResult>;
export const CLEANROOM_SWEEP_MIN_MS = 60 * 60_000;
```
`deps.lsof` defaults to `execFileSync("/usr/sbin/lsof", ["-a","-d","cwd","-u",String(uid),"-Fpn"], { encoding: "utf8", timeout: 5000 })`; `deps.rm` to `rmSync(p, { recursive: true, force: true, maxRetries: 3 })`; `deps.now` to `Date.now`.

- [ ] **Step 1: Failing tests** — `tests/omp/cleanroom-run.test.ts`. Setup: a per-test cache root in `beforeEach`: `process.env.HOUGE_DAEMON_TMP_DIR = realpathSync(mkdtempSync(join(tmpdir(), "hg-crr-")))` (**realpath**: `r.room` is canonical `/private/var/…`, an unresolved `tmpdir()` root would not prefix it), restored and removed in `afterEach` after asserting `cleanroomRoot()` is empty or absent; `distDir = tmpOmpDist(root())` (copies the real wrapper); `deps = () => ({ cfg: { sandbox: true, shellTimeoutMs: 10_000 }, distDir })`; `root = () => process.env.HOUGE_DAEMON_TMP_DIR!`; `alive` as in `shell-adapter.test.ts`.

```ts
describe.runIf(process.platform === "darwin")("runCleanroomShell — one sealed run, total result, nothing left behind", () => {
  it("runs in a fresh room with the fixed env, reports every seal fact, and removes both directories", async () => {
    const r = await runCleanroomShell(deps(), "/bin/pwd; /usr/bin/env | /usr/bin/sort");
    expect(r).toMatchObject({ status: "succeeded", exitCode: 0, executor: "cleanroom", ran: true, torn_down: true, tampered: false });
    expect(r.escaped).toBeUndefined();
    expect(r.room!.startsWith(join(cleanroomRoot(), "room-"))).toBe(true);
    expect(r.output.split("\n")[0]).toBe(r.room);
    expect(r.output).toMatch(/^HOME=.*\/home-/m); expect(r.output).not.toMatch(/^SB=/m);
    expect(readdirSync(cleanroomRoot())).toEqual([]);
  });
  it("a non-zero exit is still status succeeded with the code (the adapter's contract); teardown still runs", async () => {
    const r = await runCleanroomShell(deps(), "exit 3");
    expect(r).toMatchObject({ status: "succeeded", exitCode: 3, ran: true, torn_down: true }); expect(readdirSync(cleanroomRoot())).toEqual([]);
  });
  it("timeout and abort tear down too", async () => {
    const t = await runCleanroomShell({ ...deps(), cfg: { sandbox: true, shellTimeoutMs: 300 } }, "/bin/sleep 5");
    expect(t).toMatchObject({ status: "failed", reason: "timeout", ran: true, torn_down: true });
    const ac = new AbortController(); ac.abort();
    const a = await runCleanroomShell(deps(), "/bin/echo x", ac.signal);
    expect(a).toMatchObject({ status: "failed", reason: "aborted", ran: false, torn_down: true }); expect(a.room).toBeUndefined();
    expect(readdirSync(cleanroomRoot())).toEqual([]);
  });
  it("sandbox off, or sandbox-exec missing, is cleanroom_unavailable before any directory is made", async () => {
    const r = await runCleanroomShell({ ...deps(), cfg: { sandbox: false, shellTimeoutMs: 1000 } }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "cleanroom_unavailable", ran: false, torn_down: true });
    expect(existsSync(cleanroomRoot())).toBe(false);
  });
  it("a file dropped into the home between validation and spawn is cleanroom_tampered: no spawn", async () => {
    const afterSpawn = vi.fn(); // the only honest "did not spawn" witness: the room denies every write a marker could leave
    const r = await runCleanroomShell({ ...deps(), afterSidecar: (dirs) => writeFileSync(join(dirs.home, ".curlrc"), "planted"), afterSpawn }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "cleanroom_tampered", ran: false, torn_down: true, tamper_names: [".curlrc"] }); expect(afterSpawn).not.toHaveBeenCalled();
  });
  it("a missing sidecar before spawn is tampering too, not a setup error (the state was observed)", async () => {
    const r = await runCleanroomShell({ ...deps(), afterSidecar: (dirs) => rmSync(join(dirs.home, "cleanroom.sb")) }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "cleanroom_tampered", ran: false }); expect(r.tamper_names).toContain("<sidecar missing>");
  });
  it("planted files are unreadable through the lifecycle API: one in the daemon's HOME, one in the room's parent", async () => {
    const plant = join(root(), "cleanroom", "planted.txt"); mkdirSync(join(root(), "cleanroom"), { recursive: true }); writeFileSync(plant, "X");
    const homePlant = join(process.env.HOME!, `.hg-planted-${process.pid}`); writeFileSync(homePlant, "X");
    try {
      for (const f of [plant, homePlant]) { const r = await runCleanroomShell(deps(), `/bin/cat "${f}"`); expect(r.status).toBe("succeeded"); expect(r.exitCode).not.toBe(0); expect(r.output).toMatch(/Operation not permitted/); }
    } finally { rmSync(homePlant, { force: true }); }
  });
  it("a spawn failure is ran:false with reason spawn (seamed: bash itself always spawns, so the real wrapper cannot produce it); a missing wrapper is a post-spawn failure, ran:true; an abort after the availability check is ran:false aborted", async () => {
    const spawnFailed = { status: "failed", exitCode: null, output: "", truncated: false, wrapperStatus: "unknown", reason: "spawn" } as const;
    const r = await runCleanroomShell({ ...deps(), shell: async () => spawnFailed }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "spawn", ran: false, torn_down: true });
    const missing = await runCleanroomShell({ ...deps(), distDir: join(root(), "nowhere") }, "/bin/echo x");
    expect(missing).toMatchObject({ status: "failed", ran: true, torn_down: true }); expect(missing.reason).not.toBe("spawn");
    const ac = new AbortController();
    const late = await runCleanroomShell({ ...deps(), afterSidecar: () => ac.abort() }, "/bin/echo x", ac.signal);
    expect(late).toMatchObject({ status: "failed", reason: "aborted", ran: false, torn_down: true });
  });
  it("a sweep clock failure reports step sweep, and a failure after the first mkdtemp (validation of a pair whose home vanished) tears the first directory down and clears the active set — the next call succeeds", async () => {
    let n = 0; const r = await runCleanroomShell({ ...deps(), now: () => { if (++n === 1) throw new Error("clock"); return Date.now(); } }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "cleanroom_setup", setup_step: "sweep", ran: false, torn_down: true }); expect(r.setup_error).toMatch(/clock/);
    expect(readdirSync(cleanroomRoot())).toEqual([]);
    // partial creation (both directories made, then refused): `<cache>/cleanroom` itself a symlink is refused by the
    // validator's rootIdent (symlink_component) — after both mkdtemps, exactly the "made, then failed" path
    const elsewhere = join(root(), "elsewhere"); mkdirSync(elsewhere); symlinkSync(elsewhere, cleanroomRoot());
    try {
      const v = await runCleanroomShell(deps(), "/bin/echo x");
      expect(v).toMatchObject({ status: "failed", reason: "cleanroom_invalid", ran: false, torn_down: true }); expect(v.invalid_reason).toBe("symlink_component");
      expect(readdirSync(elsewhere)).toEqual([]); // both mkdtemp'd directories were torn down
    } finally { rmSync(cleanroomRoot(), { force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
    expect((await runCleanroomShell(deps(), "/bin/echo y")).status).toBe("succeeded");
  });
  it("a file dropped into the home DURING the run leaves the command's result standing and sets tampered", async () => {
    const r = await runCleanroomShell({ ...deps(), afterSpawn: (dirs) => writeFileSync(join(dirs.home, ".curlrc"), "planted") }, "/bin/sleep 1; /bin/echo done");
    expect(r).toMatchObject({ status: "succeeded", exitCode: 0, ran: true, tampered: true, torn_down: true });
  });
  it("a set -m orphan outlives the wrapper, is found by the lsof cwd scan, killed, and marks the run escaped (source: orphan_scan)", async () => {
    const tag = `houge-cr-orphan-${Date.now()}`;
    const r = await runCleanroomShell(deps(), `set -m; (exec -a ${tag} /bin/sleep 20 >/dev/null 2>&1 </dev/null) & /bin/echo spawned`);
    try {
      expect(r).toMatchObject({ status: "succeeded", escaped: true, escape_source: "orphan_scan", torn_down: true }); expect(r.orphans!.length).toBeGreaterThan(0);
      expect(alive(tag)).toBe(false);
    } finally { spawnSync("pkill", ["-f", tag]); }
  });
  it("orphansIn reads lsof records: an n line counts only after fcwd for the current p record", () => {
    const room = "/private/x/cleanroom/room-1";
    expect(orphansIn(room, "p10\nfcwd\nn/private/x/cleanroom/room-1\np11\nftxt\nn/private/x/cleanroom/room-1/f\np12\nfcwd\nn/private/x/cleanroom/room-1/sub\np13\nfcwd\nn/private/x/cleanroom/room-10\n")).toEqual([10, 12]);
  });
  it("an lsof failure is check_error, not escaped; a teardown failure is torn_down:false with the error, status unchanged", async () => {
    const r = await runCleanroomShell({ ...deps(), lsof: () => { throw new Error("lsof: boom"); } }, "/bin/echo x");
    expect(r).toMatchObject({ status: "succeeded", torn_down: true }); expect(r.escaped).toBeUndefined(); expect(r.check_error).toMatch(/boom/);
    const t = await runCleanroomShell({ ...deps(), rm: () => { throw new Error("EBUSY"); } }, "/bin/echo x");
    expect(t).toMatchObject({ status: "succeeded", torn_down: false }); expect(t.teardown_error).toMatch(/EBUSY/);
    rmSync(cleanroomRoot(), { recursive: true, force: true });
  });
  it("the sweep removes stale room-*/home-* from an earlier process and leaves fresh ones; its age bound exceeds the shell timeout", async () => {
    mkdirSync(join(cleanroomRoot(), "room-old"), { recursive: true }); mkdirSync(join(cleanroomRoot(), "home-fresh"));
    const old = Date.now() - 2 * 60 * 60_000; utimesSync(join(cleanroomRoot(), "room-old"), old / 1000, old / 1000);
    const r = await runCleanroomShell(deps(), "/bin/echo x");
    expect(r.swept).toEqual(["room-old"]); expect(readdirSync(cleanroomRoot())).toEqual(["home-fresh"]);
    expect(CLEANROOM_SWEEP_MIN_MS).toBeGreaterThan(resolveOmpConfig({}).shellTimeoutMs + 5000);
  });
});
```
`orphansIn` is exported for the record-parsing test. All seams and result fields are in the Interfaces block above — nothing is added later.

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `src/omp/cleanroom-run.ts` (keep each function under 50 lines; suggested split):

```ts
import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLEANROOM_PROFILE_NAME, type CleanroomDirs, CleanroomPathError, type CleanroomReason, cleanroomRoot, type RoomPair, validateCleanroomDirs, writeCleanroomProfile } from "./cleanroom.js";
import type { OmpConfig } from "./omp-config.js";
import { renderCleanroom } from "./seatbelt.js";
import { runShell, type ShellFailure, type ShellRunResult } from "./shell-adapter.js";

/* types as in Interfaces */

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const CLEANROOM_SWEEP_MIN_MS = 60 * 60_000;
const active = new Set<string>(); // rooms/homes of runs in flight in this process: never swept

function base(over: Partial<CleanroomRunResult>): CleanroomRunResult {
  return { status: "failed", exitCode: null, output: "", truncated: false, wrapperStatus: "unknown", executor: "cleanroom", ran: false, torn_down: true, tampered: false, ...over };
}

function available(cfg: Pick<OmpConfig, "sandbox">): boolean {
  if (!cfg.sandbox) return false;
  try { accessSync(SANDBOX_EXEC, constants.X_OK); return true; } catch { return false; }
}

/** Stale room- and home- entries from an earlier daemon process (older than the bound, not in flight) are removed by name; `gone` is pushed as it goes so a throw midway still reports what left. */
function sweep(root: string, cfg: Pick<OmpConfig, "shellTimeoutMs">, now: number, rm: (p: string) => void, gone: string[]): void {
  const bound = Math.max(CLEANROOM_SWEEP_MIN_MS, 2 * cfg.shellTimeoutMs);
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (!/^(room|home)-/.test(name) || active.has(p)) continue;
    if (lstatSync(p).mtimeMs < now - bound) { rm(p); gone.push(name); }
  }
}

/**
 * Tamper detection (observed state, never an I/O error): the home holds exactly the sidecar with the rendered bytes, the
 * room is empty before the run, both still have the validated inodes. A missing sidecar is reported, not read.
 */
function intact(dirs: CleanroomDirs, ino: { room: bigint; home: bigint }, afterRun: boolean): string[] {
  const bad: string[] = [];
  const home = readdirSync(dirs.home);
  bad.push(...home.filter((n) => n !== CLEANROOM_PROFILE_NAME));
  if (!home.includes(CLEANROOM_PROFILE_NAME)) bad.push("<sidecar missing>");
  else if (readFileSync(join(dirs.home, CLEANROOM_PROFILE_NAME), "utf8") !== renderCleanroom(dirs)) bad.push("<sidecar bytes>");
  if (!afterRun) bad.push(...readdirSync(dirs.room).map((n) => `room/${n}`));
  if (statSync(dirs.room, { bigint: true }).ino !== ino.room || statSync(dirs.home, { bigint: true }).ino !== ino.home) bad.push("<inode>");
  return bad;
}

/** Processes of this user whose cwd is the room or below it. lsof -Fpn emits records `p<pid>`, `f<fd>`, `n<path>`: an n line counts only under fcwd of the current p. */
export function orphansIn(room: string, lsofOut: string): number[] {
  const pids = new Set<number>(); let pid = 0; let cwd = false;
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); cwd = false; }
    else if (line.startsWith("f")) cwd = line === "fcwd";
    else if (line.startsWith("n") && cwd && pid > 0 && (line.slice(1) === room || line.slice(1).startsWith(room + "/"))) pids.add(pid);
  }
  return [...pids];
}
```
Main function outline (write it fully; this is the shape — keep it under 50 lines by delegating to the helpers above plus `prepare`, `runAndCheck`, `teardown`; `out` is ONE object, assigned before every `return`, and `finally` mutates that same object — JavaScript returns the reference, so the caller sees `torn_down`/`teardown_error` set in `finally`):
```ts
export async function runCleanroomShell(deps: CleanroomDeps, command: string, signal?: AbortSignal): Promise<CleanroomRunResult> {
  if (signal?.aborted) return base({ reason: "aborted" });
  if (!available(deps.cfg)) return base({ reason: "cleanroom_unavailable" });
  const rm = deps.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 3 }));
  const made: string[] = []; let out = base({ swept: [] });
  try {
    let step: NonNullable<CleanroomRunResult["setup_step"]> = "root";
    try {
      const root = cleanroomRoot(); mkdirSync(root, { recursive: true, mode: 0o700 });
      step = "sweep"; sweep(root, deps.cfg, (deps.now ?? Date.now)(), rm, out.swept!);
      step = "mkdtemp"; const room = mkdtempSync(join(root, "room-")); made.push(room); active.add(room);
      const home = mkdtempSync(join(root, "home-")); made.push(home); active.add(home);
      let dirs: CleanroomDirs;
      try { dirs = validateCleanroomDirs({ room, home }); } catch (e) { if (e instanceof CleanroomPathError) return (out = base({ ...out, reason: "cleanroom_invalid", invalid_reason: e.reason })); throw e; }
      const ino = { room: statSync(dirs.room, { bigint: true }).ino, home: statSync(dirs.home, { bigint: true }).ino };
      step = "sidecar"; const profile = writeCleanroomProfile(dirs); deps.afterSidecar?.(dirs);
      step = "precheck"; const pre = intact(dirs, ino, false);
      if (pre.length > 0) return (out = base({ ...out, reason: "cleanroom_tampered", room: dirs.room, tamper_names: pre }));
      if (signal?.aborted) return (out = base({ ...out, reason: "aborted", room: dirs.room })); // the signal flipped during setup: nothing ran
      return (out = await runAndCheck(deps, out, dirs, ino, profile, command, signal));
    } catch (e) { return (out = base({ ...out, reason: "cleanroom_setup", setup_step: step, setup_error: String(e) })); }
  } finally {
    for (const p of made) { try { rm(p); } catch (e) { out.torn_down = false; out.teardown_error = [out.teardown_error, `${p}: ${String(e)}`].filter(Boolean).join("; "); } active.delete(p); }
  }
}

/** Spawn, always await, then the post-run checks; a thrown test hook after the spawn is a check error, never a setup error, because the command is already running. */
async function runAndCheck(deps: CleanroomDeps, prev: CleanroomRunResult, dirs: CleanroomDirs, ino: { room: bigint; home: bigint }, profile: string, command: string, signal?: AbortSignal): Promise<CleanroomRunResult> {
  const pending = (deps.shell ?? runShell)({ command, cwd: dirs.room, profilePath: profile, wrapperPath: join(deps.distDir, "omp", "shell-wrapper.sh"),
    env: { HOUGE_SHELL_CLEANROOM: "1", CR_HOME: dirs.home, CR_ROOM: dirs.room }, timeoutMs: deps.cfg.shellTimeoutMs, outputCapBytes: 32 * 1024, sandbox: true, ...(signal ? { signal } : {}) });
  let hookError: string | undefined; try { deps.afterSpawn?.(dirs); } catch (e) { hookError = String(e); }
  const r = await pending;
  const out: CleanroomRunResult = { ...prev, ...r, executor: "cleanroom", ran: r.reason !== "spawn", room: dirs.room, torn_down: true, tampered: false };
  if (hookError) out.check_error = hookError;
  const addCheckError = (e: unknown) => { out.check_error = [out.check_error, String(e)].filter(Boolean).join("; "); };
  try { const post = intact(dirs, ino, true); if (post.length > 0) { out.tampered = true; out.tamper_names = post; } } catch (e) { addCheckError(e); }
  if (r.escaped) out.escape_source = "pipe"; // the interface promises a source whenever escaped is set, even if the scan below cannot run
  const uid = process.getuid?.();
  if (uid === undefined) addCheckError("getuid unavailable");
  else {
    try {
      const found = orphansIn(dirs.room, (deps.lsof ?? defaultLsof)(uid));
      if (found.length > 0) { out.orphans = found; for (const pid of found) try { process.kill(pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") addCheckError(`kill ${pid}: ${String(e)}`); } }
      if (found.length > 0) { out.escaped = true; out.escape_source = r.escaped ? "both" : "orphan_scan"; }
    } catch (e) { addCheckError(e); }
  }
  return out;
}
const defaultLsof = (uid: number): string => execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-u", String(uid), "-Fpn"], { encoding: "utf8", timeout: 5000 });
```
Under `exactOptionalPropertyTypes` never assign `undefined` to an optional field: build objects with spreads (`...(x ? { k: x } : {})`) or assign only when defined. `base()` returns `{ status: "failed", exitCode: null, output: "", truncated: false, wrapperStatus: "unknown", executor: "cleanroom", ran: false, torn_down: true, tampered: false, ...over }` — required defaults first, so `over` wins.

- [ ] **Step 4: Run** `npx vitest run tests/omp/cleanroom-run.test.ts` + typecheck → PASS. Check `readdirSync(cleanroomRoot())` is empty at the end of every test (the suite's `afterEach` asserts it and removes the root).

- [ ] **Step 5: Commit**
```bash
git add src/omp/cleanroom-run.ts tests/omp/cleanroom-run.test.ts
git commit -m "feat(omp): runCleanroomShell — sealed run lifecycle with tamper checks, orphan scan and teardown in finally"
```

---

### Task 6: The seam — `executor` on the runtime context, adapter selection, incident emitter, tool output

**Files:**
- Modify: `src/tools/tool-registry.ts:8-12`; `src/omp/shell-adapter.ts:77-95`; `src/capabilities/capability-runner.ts:26-34, 226-227`; `src/omp/bridge-handler.ts` (`Finish` + `finish()`, lines ~226-240, and the two call sites that build a `Finish` from a `CapabilityResult`)
- Test: `tests/omp/shell-adapter.test.ts`; `tests/capabilities/capability-runner.test.ts`; `tests/omp/bridge-handler.test.ts`

**Interfaces:**
- Consumes: `runCleanroomShell`, `CleanroomRunResult` (Task 5).
- Produces: `SsrfContext.executor?: "cleanroom"`; `shellToolExecute(deps)` returns `(input, signal?, ctx?: SsrfContext) => Promise<ToolAdapterResult>`; success output in clean-room mode is exactly `{ exit_code, output, truncated, executor: "cleanroom", cleanroom: { room?: basename, ran: true, torn_down, tampered, escaped: boolean, check_error? } }`; failure `{ ok: false, error: "bash <reason>…", output: { ran, reason, executor: "cleanroom", cleanroom: { room?, ran, torn_down, tampered, escaped, check_error? } } }` — **both arms carry the same seal facts** (a failed sealed run can be `ran: true` with `tampered`/`escaped`/`torn_down: false`). `ToolAdapterResult`'s failure arm gains `output?: Record<string, unknown>` (the key is **omitted**, never `undefined`, on every other path — `exactOptionalPropertyTypes`). `CapabilityResult`'s `failed` arm gains `output?: Record<string, unknown>` and the runner copies `adapterResult.output` when present (`capability-runner.ts:226`), so `ran` survives the runner. **The audit trail is the ledger, not the tool body** (the `tool_finished` event stores hashes and code-owned reasons only, `bridge-handler.ts:230`): `finish()` adds, when the result's output carries them, `executor: "cleanroom"` and `cleanroom: { ran, torn_down, tampered, escaped }` (booleans and a code-owned reason — never the body). Stage 4A reads them from the ledger event and its own execution record.

- [ ] **Step 1: Failing tests**

`tests/omp/shell-adapter.test.ts` (new describe; extend the `tool()` helper: a `sandbox` option that sets `HOUGE_OMP_SANDBOX` to `"1"` **and calls `writeSeatbeltProfiles({ home: data, repo: data, data })`** — without `shell.sb` on disk the normal path fails with sandbox-exec rc 65 — and a `cleanroom?: Partial<CleanroomDeps>` option passed through as `cleanroomDeps`; import `realpathSync`, `cleanroomRoot`, `CleanroomDeps`; the describe sets `HOUGE_DAEMON_TMP_DIR` to a realpath'd per-test root like Task 5):
```ts
describe.runIf(process.platform === "darwin")("shellToolExecute — executor: cleanroom (selected only from the runtime context)", () => {
  const ctx = { run_id: "run-1", tool_call_id: "tc-1", executor: "cleanroom" as const };
  it("with the flag the command runs in a room and the output carries every seal fact; without it, today's path in the workspace", async () => {
    const { run, ws, incidents } = tool({ sandbox: true });
    const sealed = await run({ command: "/bin/pwd" }, undefined, ctx);
    expect(sealed.ok).toBe(true);
    const o = (sealed as { output: Record<string, unknown> }).output;
    expect(Object.keys(o).sort()).toEqual(["cleanroom", "executor", "exit_code", "output", "truncated"]);
    expect(o).toMatchObject({ executor: "cleanroom", cleanroom: { ran: true, torn_down: true, tampered: false, escaped: false } });
    expect((o.output as string).trim()).toContain("/cleanroom/room-"); expect((o.cleanroom as { room: string }).room).toMatch(/^room-/);
    const plain = await run({ command: "/bin/pwd" }, undefined, { run_id: "run-1", tool_call_id: "tc-1" });
    expect((plain as { output: { output: string } }).output.output.trim()).toBe(realpathSync(ws));
    expect(incidents).toEqual([]);
  });
  it("refuses an anonymous flag (no run_id / tool_call_id): a direct caller cannot select the room", async () => {
    const { run, incidents } = tool({ sandbox: true });
    const r = await run({ command: "/bin/pwd" }, undefined, { run_id: null, executor: "cleanroom" });
    expect(r).toMatchObject({ ok: false, error: "bash cleanroom_invalid", output: { ran: false, reason: "cleanroom_invalid", executor: "cleanroom", cleanroom: { ran: false, torn_down: true, tampered: false, escaped: false } } });
    expect(incidents.map((i) => i.kind)).toEqual(["cleanroom_invalid"]);
  });
  it("sandbox off: cleanroom_unavailable, no run, one incident", async () => {
    const { run, incidents } = tool({ sandbox: false });
    const r = await run({ command: "/bin/pwd" }, undefined, ctx);
    expect(r).toMatchObject({ ok: false, error: "bash cleanroom_unavailable", output: { ran: false, executor: "cleanroom", cleanroom: { ran: false } } });
    expect(incidents.map((i) => i.kind)).toEqual(["cleanroom_unavailable"]);
  });
  it("emits one incident per fact in cause-before-effect order: shell_escaped then cleanroom_tampered then cleanroom_teardown_failed", async () => {
    const { run, incidents } = tool({ sandbox: true, cleanroom: { afterSpawn: (d) => writeFileSync(join(d.home, ".curlrc"), "x"), rm: () => { throw new Error("EBUSY"); } } });
    const tag = `houge-seam-orphan-${Date.now()}`;
    try {
      const r = await run({ command: `set -m; (exec -a ${tag} /bin/sleep 20 >/dev/null 2>&1 </dev/null) & /bin/sleep 1; /bin/echo x` }, undefined, ctx);
      expect(r.ok).toBe(true);
      expect(incidents.map((i) => i.kind)).toEqual(["shell_escaped", "cleanroom_tampered", "cleanroom_teardown_failed"]);
      expect(incidents[0]!.detail).toMatchObject({ source: "orphan_scan" }); expect(incidents[1]!.detail).toMatchObject({ phase: "post_run" });
      expect(incidents[2]!.detail).toMatchObject({ after: { wrapperStatus: "ok", escaped: true } });
    } finally { spawnSync("pkill", ["-f", tag]); rmSync(cleanroomRoot(), { recursive: true, force: true }); }
  });
});
```
(`tool()` must pass `cleanroom` test seams through to `runCleanroomShell` — add an optional `cleanroomDeps?: Partial<CleanroomDeps>` to `shellToolExecute`'s deps, test-only, documented.) The describe needs `HOUGE_DAEMON_TMP_DIR` pointed at a per-test root (same `beforeEach/afterEach` as Task 5).

`tests/capabilities/capability-runner.test.ts` — the fingerprint is a local in `execute` (`capability-runner.ts:143`) that leaves the runner only through `approvals.requestApproval({ action_fingerprint })` (line ~158), so the test observes it there. Build the input from this file's existing `contract` const and `new BudgetLedger(contract.budget)` exactly as its first test does; `SideEffectLevel` values are the ones in `src/domain/types.ts` (e.g. `"local_write"`, not `"write"`):
```ts
  it("executor on the runtime context never reaches the action fingerprint (a sealed 4th call must equal the first three), and does reach the adapter", async () => {
    const fps: string[] = []; const seen: unknown[] = [];
    const approvals = { requestApproval: (i: { action_fingerprint: string }) => { fps.push(i.action_fingerprint); return { approval_id: "a" }; }, consumeApprovedApproval: () => ({ ok: true as const }) } as unknown as ApprovalRequestSink;
    const registry = new ToolRegistry();
    registry.register({ name: "bash", category: "tool", side_effect_level: "local_write", risk_level: "medium", timeout_ms: 1000, output_limit_bytes: 1024, execute: (_i, _s, ctx) => { seen.push(ctx); return { ok: true, output: {} }; } });
    const runner = new CapabilityRunner(registry, approvals);
    const input = () => ({ /* this file's standard CapabilityExecutionInput for a contract that REQUIRES approval for bash */ capability: "bash", input: { command: "x" } });
    expect((await runner.execute(input(), undefined, { run_id: "r", tool_call_id: "t" })).status).toBe("requires_approval");
    expect((await runner.execute(input(), undefined, { run_id: "r", tool_call_id: "t", executor: "cleanroom" })).status).toBe("requires_approval");
    expect(fps).toHaveLength(2); expect(fps[0]).toMatch(/\w+/); expect(fps[0]).toBe(fps[1]);
    // and on an allowed call the context reaches the adapter intact
    const allowed = /* same input against a contract that allows bash without approval */ input();
    await runner.execute(allowed, undefined, { run_id: "r", tool_call_id: "t", executor: "cleanroom" });
    expect(seen.at(-1)).toMatchObject({ executor: "cleanroom" });
  });
  it("a failed adapter result's structured output survives the runner (Stage 4A needs `ran`)", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "bash", category: "tool", side_effect_level: "local_write", risk_level: "medium", timeout_ms: 1000, output_limit_bytes: 1024, execute: () => ({ ok: false, error: "bash cleanroom_unavailable", output: { ran: false, reason: "cleanroom_unavailable" } }) });
    const r = await new CapabilityRunner(registry).execute(/* allowed-contract input */ { capability: "bash", input: { command: "x" } } as never);
    expect(r).toEqual({ status: "failed", error_ref: "bash cleanroom_unavailable", output: { ran: false, reason: "cleanroom_unavailable" } });
  });
```
Fixtures, exactly: `capability-runner.test.ts`'s own first tests use a **read-only** contract with no approval gate, so copy the `local_project_write` approval contract and the `registry()` helper from `tests/capabilities/capability-runner-approvals.test.ts:7–31` into this test (or import them if they are exported). The approval-requiring input is that contract as-is; the permitted input is the same contract with `approval_gates: []`; the failed-output test uses the permitted input and `new BudgetLedger(contract.budget)`. Replace the two `/* … */` placeholders and the `as never` with those; nothing is left to look up.

`tests/omp/bridge-handler.test.ts` — `executeWithApproval` builds its own `CapabilityRunner` (line ~368), so the runner cannot be stubbed; register a spy **tool** in the turn's registry instead: `execute: (_i, _s, ctx) => { seen.push(ctx); return { ok: true, output: { exit_code: 0, output: "", truncated: false } }; }`, drive one allowed `bash` call and one approval-resume call through the file's existing fixtures, and assert every `seen[i]` lacks `executor`. Name: "the bridge never sets executor on the runtime context — Stage 4A's standing match is the first setter". Add a second test: a spy tool returning the clean-room success output (`executor: "cleanroom"`, `cleanroom: { room: "room-x", torn_down: true, tampered: false, escaped: false }`) → the `tool_finished` ledger event (`store.appendRunLedgerEvent` recorded by the fixture) carries `executor: "cleanroom"` and `cleanroom: { ran: true, torn_down: true, tampered: false, escaped: false }` and still no body; a plain success carries neither key.

- [ ] **Step 2: Run** → FAIL (third param ignored; `executor` not a known field).

- [ ] **Step 3: Implement**

`tool-registry.ts`:
```ts
export interface SsrfContext {
  run_id: string | null;
  tool_call_id?: string | null;
  recorder?: DecisionRecorder;
  /** Set only from a validated standing match (ADR 0030 §8.3, B20) — by Stage 4A, never by model or adapter input. */
  executor?: "cleanroom";
}
export type ToolAdapterResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; error: string; output?: Record<string, unknown> };
```
`shell-adapter.ts` — `shellToolExecute`:
```ts
export function shellToolExecute(deps: {
  cfg: OmpConfig; ctx: PathContext; distDir: string; cwd: string;
  onIncident: (kind: string, detail: Record<string, unknown>) => void;
  /** Tests only: seams handed to runCleanroomShell (tamper hooks, lsof, rm). */
  cleanroomDeps?: Partial<CleanroomDeps>;
}): (input: Record<string, unknown>, signal?: AbortSignal, ctx?: SsrfContext) => Promise<ToolAdapterResult> {
  return async (input, signal, ctx) => {
    const command = typeof input.command === "string" ? input.command : "";
    if (command.trim().length === 0) return { ok: false, error: "bash: command is required" };
    if (ctx?.executor === "cleanroom") return cleanroomCall(deps, command, ctx, signal);
    /* today's body unchanged */
  };
}

/** The flag is a selector, not a proof: an anonymous context (no run/tool-call id) may not select the room. */
async function cleanroomCall(deps: Parameters<typeof shellToolExecute>[0], command: string, ctx: SsrfContext, signal?: AbortSignal): Promise<ToolAdapterResult> {
  if (!ctx.run_id || !ctx.tool_call_id) { deps.onIncident("cleanroom_invalid", { why: "anonymous executor selector" }); return { ok: false, error: "bash cleanroom_invalid", output: { ran: false, reason: "cleanroom_invalid", executor: "cleanroom", cleanroom: { ran: false, torn_down: true, tampered: false, escaped: false } } }; }
  const r = await runCleanroomShell({ cfg: deps.cfg, distDir: deps.distDir, ...deps.cleanroomDeps }, command, signal);
  emitCleanroomIncidents(deps.onIncident, r);
  // both arms carry the same code-owned seal facts: a FAILED sealed run can still have ran:true / tampered / escaped / torn_down:false, and Stage 4A and the ledger must see them
  const cleanroom = { ...(r.room ? { room: basename(r.room) } : {}), ran: r.ran, torn_down: r.torn_down, tampered: r.tampered, escaped: r.escaped === true, ...(r.check_error ? { check_error: r.check_error } : {}) };
  if (r.status === "failed") return { ok: false, error: `bash ${r.reason}${r.output ? `\n${r.output}` : ""}`, output: { ran: r.ran, reason: r.reason, executor: "cleanroom", cleanroom } };
  return { ok: true, output: { exit_code: r.exitCode, output: r.output, truncated: r.truncated, executor: "cleanroom", cleanroom } };
}

/** One incident per fact, cause before effect (spec §One incident emitter table). */
function emitCleanroomIncidents(emit: (kind: string, detail: Record<string, unknown>) => void, r: CleanroomRunResult): void {
  if (r.swept?.length) emit("cleanroom_sweep", { removed: r.swept });
  if (r.reason === "cleanup_failed" || r.reason === "wrapper_unknown") emit(`shell_${r.reason}`, { exit_code: r.exitCode });
  if (r.escaped) emit("shell_escaped", { exit_code: r.exitCode, source: r.escape_source ?? "pipe", orphans: r.orphans ?? [] });
  if (r.reason === "cleanroom_unavailable" || r.reason === "cleanroom_setup" || r.reason === "cleanroom_invalid") emit(r.reason, { step: r.setup_step, error: r.setup_error, invalid_reason: r.invalid_reason });
  if (r.reason === "cleanroom_tampered") emit("cleanroom_tampered", { phase: "pre_spawn", names: r.tamper_names });
  if (r.ran && r.tampered) emit("cleanroom_tampered", { phase: "post_run", names: r.tamper_names });
  if (r.check_error) emit("cleanroom_check_failed", { error: r.check_error });
  if (!r.torn_down) emit("cleanroom_teardown_failed", { error: r.teardown_error, after: { wrapperStatus: r.wrapperStatus, escaped: r.escaped === true } });
}
```
`escape_source` is set by Task 5; the emitter only reads it. Build every detail object with spreads so no key is `undefined` (incident detail is persisted JSON, and `exactOptionalPropertyTypes` forbids it anyway). `shell-adapter.ts` ↔ `cleanroom-run.ts` is an import cycle (adapter calls run; run calls `runShell`): call-time only, harmless — say so in a one-line comment at the import.

`capability-runner.ts:226`: `if (!adapterResult.ok) return { status: "failed", error_ref: adapterResult.error, ...(adapterResult.output ? { output: adapterResult.output } : {}) };` and the `failed` arm of `CapabilityResult` gains `output?: Record<string, unknown>`.

`bridge-handler.ts`: `Finish` gains `cleanroom?: { ran: boolean; torn_down: boolean; tampered: boolean; escaped: boolean }`; a small `cleanroomFacts(result: CapabilityResult): Finish["cleanroom"] | undefined` reads `output.executor === "cleanroom"` and `output.cleanroom` from **either** arm (succeeded `output`, or the failed arm's new `output?`), type-checks the four booleans (anything else → `undefined`, never a throw), and the two `finish()` call sites in `handleCall` pass it; `finish()` spreads `...(f.cleanroom ? { executor: "cleanroom", cleanroom: f.cleanroom } : {})` into the `tool_finished` event. Code-owned booleans only, no body.

- [ ] **Step 4: Run** the three test files + `npm run typecheck` → PASS. Also run `tests/omp/bridge-handler*.test.ts` and `tests/capabilities/*.test.ts` entirely (the widenings add a key only on the clean-room paths; the existing `toEqual` tests at `shell-adapter.test.ts` ~205/212/229 must stay exact).

- [ ] **Step 5: Commit**
```bash
git add src/tools/tool-registry.ts src/omp/shell-adapter.ts src/capabilities/capability-runner.ts src/omp/bridge-handler.ts tests/omp/shell-adapter.test.ts tests/capabilities/capability-runner.test.ts tests/omp/bridge-handler.test.ts
git commit -m "feat(omp): executor: cleanroom on the runtime context selects the sealed run; one incident emitter; seal facts reach the ledger"
```

---

### Task 7: Live gate `scripts/live-gate-cleanroom-runtime.mjs`

**Files:**
- Create: `scripts/live-gate-cleanroom-runtime.mjs`
- Reference: `scripts/live-gate-cleanroom-profile.mjs` (copy its `check`, sweep, SIGINT cleanup, `--keep`, network control/INCONCLUSIVE handling verbatim)

**Interfaces:** imports from `../dist/`: `runCleanroomShell`, `CLEANROOM_SWEEP_MIN_MS` (`omp/cleanroom-run.js`); `cleanroomRoot` (`omp/cleanroom.js`); `childTmpRoot`, `daemonTmpRoot` (`run/daemon-tmp.js`); `renderSeatbelt` (`omp/seatbelt.js`); `secretPaths` (`omp/protected-paths.js`); `resolveOmpConfig` (`omp/omp-config.js`).

- [ ] **Step 1: Write the gate.** Set `process.env.HOUGE_DAEMON_TMP_DIR = mkdtempSync(join(realCacheRoot, "gate-rt-"))` **before** importing dist (so `cleanroomRoot()` derives the gate root; keep the real root's path and the names under the real `cleanroom/` in variables first, for line 19). **Every listener runs in a child process** (`spawn(process.execPath, ["-e", …])`, as the Task 1 tests do): the controls use `spawnSync`, which blocks the gate's own event loop. `SIGINT` **and** `SIGTERM` handlers run `cleanup()` (kill the listener children, remove the gate root). Lines, each `check(...)`:
  1. `HTTPS 200 from a sealed run` — `runCleanroomShell(deps, "/usr/bin/curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com/")` → `output === "200"`, after an unsandboxed control; both failing → INCONCLUSIVE (exit 2, `ok:false`); control OK + sandboxed not 200 → FAIL.
  2. `bad certificate rejected` — `expired.badssl.com` → exitCode 60 (**FAIL if output 200**).
  3. `Alishan shape` — command: `/bin/echo "HTTP=$(/usr/bin/curl -s -m 10 -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post)"; /bin/echo "JAR_BYTES=$(/usr/bin/wc -c < cj.txt | /usr/bin/tr -d ' ')"` → parse the two labelled lines: `HTTP=200` and `JAR_BYTES=` a positive integer (the jar is gone with the room, so the size is measured inside the run); after the run `cleanroomRoot()` has no `room-*`.
  4. `local address forms` — start a node `http` server on `::` ephemeral; for each of `127.0.0.1`, `localhost`, `0.0.0.0`, `[::1]`, `[::ffff:127.0.0.1]`, and every `inet`/`inet6` address `ifconfig` prints (parse `ifconfig` output; `%scope` encoded as `%25`): sealed curl → `exitCode 7`; control unsandboxed → 200 for at least `127.0.0.1`.
  5. `UDP loopback and LAN broadcast` via bash `/dev/udp` → the sandboxed stderr must contain `Operation not permitted` (EPERM — the sandbox). Unsandboxed, the broadcast form already fails with `Permission denied` (EACCES, no `SO_BROADCAST`), so a bare non-zero exit would pass for the wrong reason; assert the text.
  6. `Unix socket` — a node `net` server on `<gate root>/t.sock` → sealed `curl --unix-socket` exit 7.
  7. `bind` — real rendered profile from a validated pair + one appended `(allow process-exec* (literal "/usr/bin/nc"))` line → `nc -l 127.0.0.1 <port>` stderr `Operation not permitted`; assert network lines identical to the real profile.
  8. `127.0.0.2 record` — unsandboxed vs sandboxed codes printed; FAIL only if unsandboxed 200 and sandboxed ≠ 7.
  9. `planted files unreadable` — plant under `<gate root>/children/plant.txt` and `<gate root>/cleanroom/plant.txt`; sealed `cat` → `Operation not permitted`. **Never** write into the real `$HOME`.
  10. `env is the six names + bash's three` — as Slice 0.
  11. `clock` — `date +%Z` equals host.
  12. `perl refused` — exitCode 126 + `Operation not permitted`.
  13. `set -m orphan found and killed` — result `escaped === true`, `orphans.length > 0`, `pgrep -f <tag>` empty afterwards.
  14. `room not re-creatable` — a completed run has removed its sidecar, so this probe renders its own: validate a fresh pair, write the profile, note the room path, `rmSync` the room, then from the home run `sandbox-exec -f <sidecar> /bin/bash -c 'mkdir <room>'` → `Operation not permitted`, room still absent; remove the home.
  15. `teardown after exit 0 / exit 3 / timeout (300 ms) / abort` — `cleanroomRoot()` empty, `torn_down === true` each.
  16. `sandbox off → cleanroom_unavailable, no directory made`.
  17. `child TMPDIR invariant on the REAL cache root` — `childTmpRoot()`/`cleanroomRoot()` (computed with the real root) not nested, both 0700.
  18. `effective shell/planner policy denies the gate root` — as Slice 0 (`secretPaths` / `renderSeatbelt` evaluator).
  19. `nothing left` — gate root removed; the set of names under the **real** `cleanroom/` is identical before and after the gate (snapshot taken before the env override); no `hg-planted-*` in `$HOME`.
  Final line: `{"ok":<fails===0 && https200>,"fails":N,"inconclusive":<bool>,"notes":[...]}`. Exit: 0 when ok; **2 when INCONCLUSIVE** (the unsandboxed HTTPS control itself failed — network down or curl missing → `ok:false`, no FAIL lines counted for network cases); 1 otherwise. Copy the Slice 0 gate's control/INCONCLUSIVE code path.

- [ ] **Step 2: Build and run**
```bash
set -o pipefail; npm run build && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-cleanroom-runtime.mjs
```
Expected: every line PASS, HTTPS 200, exit 0. Also re-run `node scripts/live-gate-cleanroom-profile.mjs` (Slice 0) → still PASS.

- [ ] **Step 3: Commit**
```bash
git add scripts/live-gate-cleanroom-runtime.mjs
git commit -m "test(gate): clean-room runtime live gate — P8 matrix, orphan scan, teardown, child TMPDIR invariant"
```

---

### Task 8: Docs sync (orchestrator, after the whole-branch reviews)

**Files:** `docs/reference/configuration.md`; `docs/decisions/0030-decision-ladder.md` (amendment row, "awaiting Paco's signature"); `docs/decisions/README.md` (index row if the convention adds one per amendment); `AGENTS.md` Commands line on daemon temp files (Paco's hand — listed in the report); `docs/ROADMAP.md` (Stage 4 #6 shipped; Stage 4A next); `tasks/todo.md` state block; `tasks/lessons.md`; `sessions.md`; the spec's Status line.

- [ ] `configuration.md`: under the clean room — fixed six-name env; TCP-only egress (no IPv6, no UDP, no raw DNS); exec allowlist (`CLEANROOM_EXEC_ALLOW`); time-zone read set; known non-file surface (Mach ops other than lookup, `sysctl`); other LAN hosts reachable (P8 covers this host's services); bash job-control orphans: bounded + detected, not prevented (reading A); `<cache>/children` and `<cache>/cleanroom`; incident kinds `cleanroom_*`.
- [ ] ADR 0030 amendment row drafted; `AGENTS.md` line: "`~/Library/Caches/houge-daemon` (`HOUGE_DAEMON_TMP_DIR`): `children/` is every CLI child's TMPDIR, `cleanroom/` holds sealed-run rooms".
- [ ] Commit per concern: `docs(sync): clean-room runtime slice 1 shipped`, `docs(lessons): …`.

---

## Self-review (done while writing)

- **Spec coverage:** P8 block + tz (T1); exec allowlist + regex write rule + `sbplRegexLiteral` (T2); children TMPDIR + codex key + agy lock + grep lockstep (T3); wrapper mode + `limits_failed` reuse (T4); lifecycle, totality, sweep, pre/post checks, orphan scan, teardown, `ran`, result type (T5); `SsrfContext.executor`, anonymous refusal, fingerprint continuity, bridge never sets it, incident table, output shape (T6); gate lines incl. `ifconfig` addresses, 127.0.0.2 record, no real-home plants, INCONCLUSIVE exit 2 (T7); docs (T8). Hand-off to Stage 4A is text, not code — in the spec. "`cleanroom_sweep` incident" → emitted by T6's emitter from `swept`.
- **Placeholders:** none; every test and implementation step has code. T5's main function is given as a full outline with every branch; the implementer fills the two one-line helpers named (`killOrphan`, `defaultLsof`) exactly as specified in Interfaces.
- **Type consistency:** `CleanroomRunResult` fields used in T6 (`ran`, `room`, `torn_down`, `tampered`, `escaped`, `check_error`, `teardown_error`, `orphans`, `swept`, `setup_step`, `setup_error`, `invalid_reason`, `tamper_names`, `escape_source`) are all declared in T5's Interfaces; `escape_source` is declared and set by T5, T6 only reads it. `CleanroomDeps` test seams (`afterSidecar`, `afterSpawn`, `rm`, `lsof`, `now`) are declared in T5 and consumed by T6's `cleanroomDeps`. `childTmpRoot` (T3) used by T7. `CLEANROOM_EXEC_ALLOW`, `sbplRegexLiteral`, `CLEANROOM_NETWORK_RULES` exported in T1/T2, used in tests and T7.
