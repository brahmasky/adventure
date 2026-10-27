#!/usr/bin/env node
// Live gate — clean-room Seatbelt profile (Slice 0). Renders the profile for a real pair under the daemon cache root
// (~/Library/Caches/houge-daemon or HOUGE_DAEMON_TMP_DIR), then runs the probe set from
// docs/superpowers/research/2026-10-12-in-loop-decisions/13-cleanroom-probe.md through the real sandbox-exec.
// PASS = positive controls work AND negative probes fail with the expected code AND "Operation not permitted" where a
// file op is denied (a sandbox that did not apply, or a profile sandbox-exec refused, FAILS). Network: an unsandboxed
// curl control runs first; sandboxed DNS/TLS failing while the control works is a FAIL, both failing is INCONCLUSIVE
// (rerun once; ship only with the diagnosis written in the report — standing pre-ruling, tasks/todo.md).
// Run after npm run build:   node scripts/live-gate-cleanroom-profile.mjs [--keep]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const keep = process.argv.includes("--keep");
let fails = 0; const notes = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); if (!ok) { fails++; process.exitCode = 1; } };
const denied = (r) => r.status !== 0 && /Operation not permitted/.test(r.stderr);

const { validateCleanroomDirs, writeCleanroomProfile, cleanroomEnv } = await import(join(DIST, "omp/cleanroom.js"));
const { renderSeatbelt } = await import(join(DIST, "omp/seatbelt.js"));
const { daemonTmpRoot } = await import(join(DIST, "run/daemon-tmp.js"));

// Sweep what an interrupted earlier run left behind, then make this run's dirs and plants.
const cacheRoot = daemonTmpRoot();
for (const d of readdirSync(cacheRoot)) if (d.startsWith("cleanroom-gate-")) rmSync(join(cacheRoot, d), { recursive: true, force: true });
for (const dir of [tmpdir(), "/private/tmp", homedir()]) for (const f of readdirSync(dir)) if (/^\.?hg-planted-/.test(f)) rmSync(join(dir, f), { force: true });
const base = mkdtempSync(join(cacheRoot, "cleanroom-gate-"));
const room = join(base, "room"); const home = join(base, "home"); mkdirSync(room); mkdirSync(home);
const planted = [join(tmpdir(), `hg-planted-${process.pid}`), `/private/tmp/hg-planted-${process.pid}`, join(homedir(), `.hg-planted-${process.pid}`)];
for (const f of planted) writeFileSync(f, "X-Planted: yes");
const cleanup = () => { if (keep) { console.log(`kept: ${base} and ${planted.join(", ")}`); return; } rmSync(base, { recursive: true, force: true }); for (const f of planted) rmSync(f, { force: true }); };
process.on("SIGINT", () => { cleanup(); process.exit(130); });

try {
  const dirs = validateCleanroomDirs({ room, home, cacheRoot });
  const profile = writeCleanroomProfile(dirs);
  const env = cleanroomEnv(dirs);
  const run = (script) => spawnSync("/usr/bin/env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    "/usr/bin/sandbox-exec", "-f", profile, "/bin/bash", "-c", script], { cwd: dirs.room, encoding: "utf8", timeout: 20_000 });

  check("profile written as sidecar in the home", existsSync(profile), profile);
  const ctl = run("/bin/echo ok && /bin/pwd && /bin/echo x > f && /bin/cat f");
  check("positive: binary starts, getcwd clean, room writable", ctl.status === 0 && !/getcwd/.test(ctl.stderr) && ctl.stdout.includes(dirs.room), ctl.stderr.trim());
  const seen = Object.fromEntries(run("/usr/bin/env").stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const wantKeys = [...Object.keys(env), "PWD", "SHLVL", "_"].sort().join(",");
  check("positive: child env is the six fixed names plus bash's PWD/SHLVL/_ with known values", Object.keys(seen).sort().join(",") === wantKeys && seen.PWD === dirs.room && seen.SHLVL === "1" && seen.HOME === dirs.home, Object.keys(seen).sort().join(","));

  for (const f of ["/private/etc/hosts", ...planted]) check(`negative: ${f} unreadable (exists: ${existsSync(f)})`, existsSync(f) && denied(run(`/bin/cat "${f}"`)));
  check("negative: /private/tmp unlistable", denied(run("/bin/ls /private/tmp")));
  const okh = run("/bin/echo 'X-Ok: 1' > ok.txt && /usr/bin/curl -sS --max-time 2 -H @ok.txt http://127.0.0.1:1/");
  check("control: curl -H @<room file> reads it and reaches the connect (exit 7)", okh.status === 7, `exit ${okh.status}`);
  for (const f of ["/private/etc/hosts", ...planted]) {
    const h = run(`/usr/bin/curl -sS --max-time 2 -H @"${f}" http://127.0.0.1:1/`);
    check(`negative: curl -H @${f} fails at file read (exit 26, not 7)`, h.status === 26, `exit ${h.status}`);
    const d = run(`/usr/bin/curl -sS --max-time 2 --data-binary @"${f}" http://127.0.0.1:1/`);
    check(`negative: curl -d @${f} cannot read the body file (exit 26)`, d.status === 26, `exit ${d.status}`);
  }
  check("negative: a .curlrc planted in the room (cwd) is ignored (exit 2, no URL)", run("/bin/echo 'url = \"http://127.0.0.1:1/\"' > .curlrc && /usr/bin/curl -sS --max-time 2").status === 2);
  writeFileSync(join(base, "outside.txt"), "secret"); symlinkSync(join(base, "outside.txt"), join(dirs.room, "link"));
  check("negative: symlink out of the room unreadable", denied(run("/bin/cat link")));
  check("negative: home unwritable (no planted .curlrc)", denied(run(`/bin/echo p > "${dirs.home}/.curlrc"`)) && !existsSync(join(dirs.home, ".curlrc")));
  for (const cmd of ["/bin/launchctl list", "/usr/bin/security help", "/usr/bin/python3 -c 1"]) check(`negative: ${cmd.split(" ")[0]} cannot exec`, denied(run(cmd)));

  // The Alishan property: HTTPS still works from the sealed room (DNS over IPC, TLS roots from /System).
  const URL = "https://www.apple.com/library/test/success.html";
  const curlArgs = `-sS --max-time 10 -o /dev/null -w '%{http_code}' ${URL}`;
  const control = spawnSync("/usr/bin/curl", curlArgs.replace(/'/g, "").split(" ").filter(Boolean), { encoding: "utf8" });
  const net = run(`/usr/bin/curl ${curlArgs}`);
  if (control.status !== 0) { notes.push(`INCONCLUSIVE network: unsandboxed control curl exit ${control.status} (offline?) — rerun once; ship only with the diagnosis in the report`); console.log(notes.at(-1)); }
  else check("network: HTTPS from the room (DNS + TLS) while the unsandboxed control works", net.status === 0 && net.stdout.trim() === "200", `sandboxed exit ${net.status} http ${net.stdout.trim()}`);

  // Effective policy, live: the shell profile can write $HOME but not the room, and cannot list the home.
  const { shell } = renderSeatbelt({ home: homedir(), repo: REPO, data: process.cwd() });
  const shellProfile = join(base, "shell.sb"); writeFileSync(shellProfile, shell);
  const sh = (script) => spawnSync("/usr/bin/sandbox-exec", ["-f", shellProfile, "/bin/sh", "-c", script], { encoding: "utf8" });
  const shellOk = sh(`echo x > "${join(homedir(), `.hg-planted-${process.pid}`)}"`); // $HOME is a shell write root: positive control
  check("effective control: the shell profile parses and can write a $HOME file", shellOk.status === 0, shellOk.stderr.trim());
  check("effective: the shell profile can neither write the room nor list the home", denied(sh(`echo x > "${dirs.room}/from-shell"`)) && denied(sh(`/bin/ls "${dirs.home}"`)) && !existsSync(join(dirs.room, "from-shell")));

  console.log(JSON.stringify({ ok: fails === 0, fails, notes }));
} finally { cleanup(); }
