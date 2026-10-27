#!/usr/bin/env node
// Live gate — clean-room runtime (Slice 1). Drives the real runCleanroomShell (wrapper + sandbox-exec + teardown) from
// dist/ under a gate-owned daemon temp root (<real cache root>/gate-rt-*, set as HOUGE_DAEMON_TMP_DIR before any dist
// import), and probes the P8 network matrix, the exec allowlist, the orphan scan, teardown on every exit path and the
// child-TMPDIR invariant on the REAL cache root. Every listener runs in a child process: the controls use spawnSync,
// which blocks this event loop.
// PASS = every line PASS: positive controls work AND each negative probe fails with the expected code AND
// "Operation not permitted" where the sandbox is the reason (a bare non-zero exit is never enough), AND nothing is left
// behind (gate root gone, the real cleanroom/ names unchanged, no plant in $HOME, no listener alive).
// Network: an unsandboxed curl control runs first; the sealed run failing while the control works is a FAIL, both
// failing is INCONCLUSIVE (exit 2, ok:false — rerun once; ship only with the diagnosis written in the report — standing
// pre-ruling, tasks/todo.md); a control curl that could not run at all is a FAIL.
// Run after npm run build:   node scripts/live-gate-cleanroom-runtime.mjs [--keep]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const keep = process.argv.includes("--keep");
let fails = 0; const notes = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); if (!ok) { fails++; process.exitCode = 1; } };
const EPERM = /Operation not permitted/;
const denied = (r) => r.status !== 0 && EPERM.test(r.stderr);

// The real root and the names under its cleanroom/, captured before the override (line 19 compares them).
const envRoot = process.env.HOUGE_DAEMON_TMP_DIR?.trim();
const realRoot = envRoot && isAbsolute(envRoot) ? envRoot : join(homedir(), "Library", "Caches", "houge-daemon");
const realCr = join(realRoot, "cleanroom");
const names = (d) => (existsSync(d) ? readdirSync(d).sort().join(",") : "<absent>");
const realCrBefore = names(realCr);
const realChildrenExisted = existsSync(join(realRoot, "children"));
mkdirSync(realRoot, { recursive: true, mode: 0o700 });
// Sweep what an interrupted earlier run of this gate left behind: its own gate-rt-* roots only.
for (const d of readdirSync(realRoot)) if (d.startsWith("gate-rt-")) rmSync(join(realRoot, d), { recursive: true, force: true });
const gateRoot = mkdtempSync(join(realRoot, "gate-rt-"));
process.env.HOUGE_DAEMON_TMP_DIR = gateRoot;

const kids = [];
// cleanup exists before any plant or listener: an interrupt between the two must not strand either
const cleanup = () => {
  for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill("SIGKILL");
  if (!realChildrenExisted) try { rmdirSync(join(realRoot, "children")); } catch { /* absent or not empty: left for the report */ }
  if (keep) { console.log(`kept: ${gateRoot}`); return; }
  rmSync(gateRoot, { recursive: true, force: true });
};
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

const { runCleanroomShell } = await import(join(DIST, "omp/cleanroom-run.js"));
const { cleanroomRoot, validateCleanroomDirs, writeCleanroomProfile, cleanroomEnv, CLEANROOM_PROFILE_NAME } = await import(join(DIST, "omp/cleanroom.js"));
const { childTmpRoot, daemonTmpRoot } = await import(join(DIST, "run/daemon-tmp.js"));
const { renderSeatbelt } = await import(join(DIST, "omp/seatbelt.js"));
const { secretPaths } = await import(join(DIST, "omp/protected-paths.js"));
const { resolveOmpConfig } = await import(join(DIST, "omp/omp-config.js"));

const ompCfg = resolveOmpConfig({});
const deps = (over = {}) => ({ cfg: { sandbox: ompCfg.sandbox, shellTimeoutMs: 30_000, ...over }, distDir: DIST });
const sealed = (cmd, over, signal) => runCleanroomShell(deps(over), cmd, signal);
const crRoot = () => cleanroomRoot();
const crEntries = () => (existsSync(crRoot()) ? readdirSync(crRoot()) : []);
const curlCode = (url, extra = []) => spawnSync("/usr/bin/curl", ["-s", "-m", "3", "-g", "-o", "/dev/null", "-w", "%{http_code}", ...extra, url], { encoding: "utf8" });

/** A listener in a child process; resolves once it prints its first line (the port, or "up"). */
async function listener(code) {
  const c = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  kids.push(c);
  return new Promise((r, j) => { c.once("exit", () => j(new Error("listener exited early"))); c.stdout.once("data", (d) => r(String(d).trim())); });
}

/** A validated pair under the gate's clean-room root with its sidecar written, for the raw sandbox-exec probes (7, 14). */
function probePair() {
  mkdirSync(crRoot(), { recursive: true, mode: 0o700 });
  const dirs = validateCleanroomDirs({ room: mkdtempSync(join(crRoot(), "probe-room-")), home: mkdtempSync(join(crRoot(), "probe-home-")) });
  const profile = writeCleanroomProfile(dirs);
  const envArgs = Object.entries(cleanroomEnv(dirs)).map(([k, v]) => `${k}=${v}`);
  const drop = () => { rmSync(dirs.room, { recursive: true, force: true }); rmSync(dirs.home, { recursive: true, force: true }); };
  return { dirs, profile, envArgs, drop };
}

// 1-3: network. The unsandboxed control decides between a verdict and INCONCLUSIVE.
let inconclusive = false; let https200 = false;
const inconclusiveNote = (what, r) => { inconclusive = true; notes.push(`INCONCLUSIVE network: unsandboxed ${what} control exit ${r.status} (offline?) — rerun once; ship only with the diagnosis in the report`); console.log(notes.at(-1)); };
async function networkProbes() {
  const control = spawnSync("/usr/bin/curl", ["-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com/"], { encoding: "utf8" });
  if (control.status === null || control.error) return check("network: unsandboxed control curl runs", false, `curl unavailable: ${control.error?.message ?? control.signal}`);
  if (control.status !== 0) return inconclusiveNote("example.com", control);
  const r = await sealed("/usr/bin/curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com/");
  https200 = r.output === "200";
  check("1 HTTPS 200 from a sealed run", https200, `control ${control.stdout} sealed exit ${r.exitCode} output ${JSON.stringify(r.output)}`);
  const bad = await sealed("/usr/bin/curl -s -m 10 -o /dev/null -w '%{http_code}' https://expired.badssl.com/");
  check("2 bad certificate rejected", bad.exitCode === 60 && bad.output !== "200", `exit ${bad.exitCode} output ${JSON.stringify(bad.output)}`);
  await alishanProbe();
}

async function alishanProbe() {
  const ctl = spawnSync("/usr/bin/curl", ["-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-d", "a=1", "https://httpbin.org/post"], { encoding: "utf8" });
  if (ctl.status !== 0 || ctl.stdout !== "200") return inconclusiveNote(`httpbin.org (http ${ctl.stdout})`, ctl);
  const r = await sealed(`/bin/echo "HTTP=$(/usr/bin/curl -s -m 10 -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post)"; /bin/echo "JAR_BYTES=$(/usr/bin/wc -c < cj.txt | /usr/bin/tr -d ' ')"`);
  const http = /^HTTP=(.*)$/m.exec(r.output)?.[1]; const jar = Number(/^JAR_BYTES=(\d+)$/m.exec(r.output)?.[1] ?? 0);
  const rooms = crEntries().filter((n) => n.startsWith("room-"));
  check("3 Alishan shape (POST + cookie jar in the room, room gone after)", http === "200" && jar > 0 && rooms.length === 0, `HTTP=${http} JAR_BYTES=${jar} rooms left ${rooms.length}`);
}

/** Every inet/inet6 address ifconfig prints, as a URL host (zone `%` encoded as `%25`). */
function hostAddresses() {
  const out = spawnSync("/sbin/ifconfig", { encoding: "utf8" }).stdout;
  return [...out.matchAll(/^\s+inet(6?) (\S+)/gm)].map(([, v6, a]) => (v6 ? `[${a.replace("%", "%25")}]` : a));
}

// 4-8: local network (P8).
async function localAddressProbe(port) {
  const hosts = [...new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "[::ffff:127.0.0.1]", ...hostAddresses()])];
  const ctl = curlCode(`http://127.0.0.1:${port}/`).stdout;
  const loop = hosts.map((h) => `/usr/bin/curl -s -m 3 -g -o /dev/null "http://${h}:${port}/"; /bin/echo "${h} rc=$?"`).join("; ");
  const r = await sealed(loop);
  const rcs = Object.fromEntries([...r.output.matchAll(/^(\S+) rc=(\d+)$/gm)].map(([, h, rc]) => [h, Number(rc)]));
  const bad = hosts.filter((h) => rcs[h] !== 7);
  check(`4 local address forms (${hosts.length}) unreachable sealed (exit 7), control reaches 127.0.0.1`, ctl === "200" && bad.length === 0, `control ${ctl}; not 7: ${bad.map((h) => `${h}=${rcs[h]}`).join(" ") || "none"}`);
}

async function udpProbe() {
  const bcast = /broadcast (\d+\.\d+\.\d+\.\d+)/.exec(spawnSync("/sbin/ifconfig", { encoding: "utf8" }).stdout)?.[1] ?? "255.255.255.255";
  const send = (ip) => `exec 3<>/dev/udp/${ip}/9 && /bin/echo sent >&3 && /bin/echo UDP-SENT`;
  const ctlLo = spawnSync("/bin/bash", ["-c", send("127.0.0.1")], { encoding: "utf8" });
  const ctlB = spawnSync("/bin/bash", ["-c", send(bcast)], { encoding: "utf8" });
  const lo = await sealed(send("127.0.0.1")); const b = await sealed(send(bcast));
  const ok = (r) => !r.output.includes("UDP-SENT") && EPERM.test(r.output);
  const flat = (t) => t.trim().replace(/\s*\n\s*/g, " | ");
  check(`5 UDP loopback and LAN broadcast ${bcast} refused with EPERM`, ctlLo.stdout.includes("UDP-SENT") && ok(lo) && ok(b),
    `control lo ${ctlLo.stdout.includes("UDP-SENT") ? "sent" : flat(ctlLo.stderr)}; control bcast ${flat(ctlB.stderr) || "sent"}; sealed lo ${flat(lo.output)}; sealed bcast ${flat(b.output)}`);
}

async function unixSocketProbe() {
  const sock = join(gateRoot, "t.sock");
  await listener(`require("http").createServer((q,r)=>r.end("u")).listen(${JSON.stringify(sock)},()=>console.log("up"))`);
  const ctl = spawnSync("/usr/bin/curl", ["-s", "-m", "3", "--unix-socket", sock, "http://x/"], { encoding: "utf8" }).stdout;
  const r = await sealed(`/usr/bin/curl -s -m 3 --unix-socket "${sock}" http://x/`);
  check("6 Unix socket unreachable sealed (exit 7), control reaches it", ctl === "u" && r.exitCode === 7, `control ${JSON.stringify(ctl)} sealed exit ${r.exitCode}`);
}

function bindProbe() {
  const { dirs, profile, envArgs, drop } = probePair();
  try {
    const real = readFileSync(profile, "utf8");
    const variant = `${real}(allow process-exec* (literal "/usr/bin/nc"))\n`;
    const net = (t) => t.split("\n").filter((l) => l.includes("network")).join("\n");
    const vp = join(gateRoot, "variant.sb"); writeFileSync(vp, variant);
    const r = spawnSync("/usr/bin/env", ["-i", ...envArgs, "/usr/bin/sandbox-exec", "-f", vp, "/usr/bin/nc", "-l", "127.0.0.1", "48999"], { cwd: dirs.room, encoding: "utf8", timeout: 3000 });
    check("7 bind refused (nc -l with one appended exec allow, network lines identical)", net(variant) === net(real) && denied(r), `exit ${r.status} ${r.stderr.trim()}`);
  } finally { drop(); }
}

async function loopback2Probe(port) {
  const ctl = curlCode(`http://127.0.0.2:${port}/`);
  const r = await sealed(`/usr/bin/curl -s -m 3 -o /dev/null http://127.0.0.2:${port}/`);
  check("8 127.0.0.2 record", !(ctl.stdout === "200" && r.exitCode !== 7), `unsandboxed exit ${ctl.status} http ${ctl.stdout}; sealed exit ${r.exitCode}`);
}

// 9-12: files, env, clock, exec allowlist.
async function plantProbe() {
  const plants = [join(gateRoot, "children", "plant.txt"), join(crRoot(), "plant.txt")];
  for (const p of plants) { mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 }); writeFileSync(p, "X-Planted: yes"); }
  try {
    for (const p of plants) {
      const r = await sealed(`/bin/cat "${p}"`);
      check(`9 planted file unreadable: ${p.slice(gateRoot.length)}`, r.exitCode !== 0 && EPERM.test(r.output) && !r.output.includes("X-Planted"), r.output.trim());
    }
  } finally { for (const p of plants) rmSync(p, { force: true }); }
}

async function envProbe() {
  const r = await sealed("/usr/bin/env");
  const seen = Object.fromEntries(r.output.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const want = ["CURL_HOME", "HOME", "LANG", "PATH", "PWD", "SHLVL", "TMPDIR", "XDG_CONFIG_HOME", "_"].join(",");
  const homeOk = seen.HOME?.startsWith(join(crRoot(), "home-")) && seen.CURL_HOME === seen.HOME && seen.XDG_CONFIG_HOME === seen.HOME;
  const ok = Object.keys(seen).sort().join(",") === want && seen.PWD === r.room && seen.TMPDIR === r.room && seen.SHLVL === "1" && seen.PATH === "/usr/bin:/bin:/usr/sbin:/sbin" && homeOk;
  check("10 env is the six names + bash's three", ok, Object.keys(seen).sort().join(","));
}

async function clockProbe() {
  const host = spawnSync("/bin/date", ["+%Z"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout.trim();
  const r = await sealed("/bin/date +%Z");
  check("11 clock: date +%Z equals the host", host !== "" && r.output.trim() === host, `host ${host} sealed ${r.output.trim()}`);
}

async function perlProbe() {
  const r = await sealed("/usr/bin/perl -e 1");
  check("12 perl refused (126 + EPERM)", r.exitCode === 126 && EPERM.test(r.output), `exit ${r.exitCode} ${r.output.trim()}`);
}

// 13-16: orphan scan, room re-creation, teardown, sandbox off.
const pgrep = (pat) => spawnSync("/usr/bin/pgrep", ["-f", pat], { encoding: "utf8" }).stdout.trim();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function orphanProbe() {
  const tag = `300.${process.pid}`;
  const r = await sealed(`set -m; /bin/sleep ${tag} >/dev/null 2>&1 & /bin/echo bg`);
  let left = pgrep(`sleep ${tag}`);
  for (let i = 0; i < 10 && left; i++) { await pause(100); left = pgrep(`sleep ${tag}`); }
  check("13 set -m orphan found and killed", r.escaped === true && (r.orphans?.length ?? 0) > 0 && left === "", `escaped ${r.escaped} source ${r.escape_source} orphans ${JSON.stringify(r.orphans)} pgrep "${left}"`);
}

function recreateProbe() {
  const { dirs, profile, envArgs, drop } = probePair();
  try {
    rmSync(dirs.room, { recursive: true, force: true });
    const r = spawnSync("/usr/bin/env", ["-i", ...envArgs, "/usr/bin/sandbox-exec", "-f", profile, "/bin/bash", "-c", `/bin/mkdir "${dirs.room}"`], { cwd: dirs.home, encoding: "utf8" });
    check("14 room not re-creatable", denied(r) && !existsSync(dirs.room) && profile.endsWith(CLEANROOM_PROFILE_NAME), `exit ${r.status} ${r.stderr.trim()}`);
  } finally { drop(); }
}

async function teardownProbe() {
  const abortAfter = (ms) => { const ac = new AbortController(); setTimeout(() => ac.abort(), ms); return ac.signal; };
  const cases = [
    ["exit 0", await sealed("exit 0"), (r) => r.exitCode === 0 && r.status === "succeeded"],
    ["exit 3", await sealed("exit 3"), (r) => r.exitCode === 3],
    ["timeout (300 ms)", await sealed("/bin/sleep 5", { shellTimeoutMs: 300 }), (r) => r.reason === "timeout"],
    ["abort", await sealed("/bin/sleep 5", {}, abortAfter(300)), (r) => r.reason === "aborted"]
  ];
  for (const [name, r, shape] of cases) {
    const left = crEntries();
    check(`15 teardown after ${name}`, shape(r) && r.torn_down === true && left.length === 0, `exit ${r.exitCode} reason ${r.reason ?? "-"} torn_down ${r.torn_down} left [${left.join(",")}]${r.teardown_error ? " " + r.teardown_error : ""}`);
  }
}

async function sandboxOffProbe() {
  rmSync(crRoot(), { recursive: true, force: true }); // empty after 15: its absence afterwards proves nothing was made
  const r = await sealed("/bin/echo hi", { sandbox: false });
  check("16 sandbox off → cleanroom_unavailable, no directory made", r.reason === "cleanroom_unavailable" && r.ran === false && !existsSync(crRoot()), `reason ${r.reason} ran ${r.ran} root exists ${existsSync(crRoot())}`);
}

// 17-18: invariants on the real root and the effective policy.
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
function childTmpInvariant() {
  process.env.HOUGE_DAEMON_TMP_DIR = realRoot;
  try {
    const root = daemonTmpRoot(); const child = childTmpRoot(); const cr = cleanroomRoot();
    const nested = child === cr || child.startsWith(cr + "/") || cr.startsWith(child + "/");
    check("17 child TMPDIR invariant on the REAL cache root", root === realRoot && !nested && existsSync(cr) && mode(child) === "700" && mode(cr) === "700", `children ${child} (${mode(child)}) cleanroom ${cr} (${existsSync(cr) ? mode(cr) : "absent"})`);
  } finally { process.env.HOUGE_DAEMON_TMP_DIR = gateRoot; }
}

function effectivePolicyProbe() {
  const ctx = { home: homedir(), repo: REPO, data: process.cwd() };
  const plant = join(gateRoot, "children", "p18.txt"); mkdirSync(join(plant, ".."), { recursive: true }); writeFileSync(plant, "X-Planted: yes");
  const listed = secretPaths(ctx).includes(gateRoot);
  const profiles = renderSeatbelt(ctx);
  const results = Object.entries(profiles).map(([name, text]) => {
    const p = join(gateRoot, `${name}.sb`); writeFileSync(p, text);
    const sh = (s) => spawnSync("/usr/bin/sandbox-exec", ["-f", p, "/bin/sh", "-c", s], { encoding: "utf8" });
    return { name, ok: sh("/bin/echo ok").status === 0 && denied(sh(`/bin/ls "${gateRoot}"`)) && denied(sh(`/bin/cat "${plant}"`)) };
  });
  check("18 effective shell/planner policy denies the gate root", listed && results.every((x) => x.ok), `secretPaths lists it ${listed}; ${results.map((x) => `${x.name} ${x.ok ? "denies" : "DOES NOT deny (or did not run)"}`).join(", ")}`);
}

// 19: nothing left. Runs after cleanup().
async function nothingLeft() {
  await Promise.all(kids.map((k) => (k.exitCode !== null || k.signalCode !== null ? null : new Promise((r) => { k.once("exit", r); setTimeout(r, 2000); }))));
  const alive = kids.filter((k) => k.exitCode === null && k.signalCode === null).length;
  const planted = readdirSync(homedir()).filter((f) => /^\.?hg-planted-/.test(f));
  const after = names(realCr);
  const ok = !existsSync(gateRoot) && after === realCrBefore && planted.length === 0 && alive === 0 && existsSync(join(realRoot, "children")) === realChildrenExisted;
  check("19 nothing left", ok, `gate root exists ${existsSync(gateRoot)}; real cleanroom/ before [${realCrBefore}] after [${after}]; $HOME plants ${planted.length}; listeners alive ${alive}`);
}

try {
  await networkProbes();
  const port = Number(await listener('const s=require("http").createServer((q,r)=>r.end("local"));s.listen(0,"::",()=>console.log(s.address().port))'));
  await localAddressProbe(port);
  await udpProbe();
  await unixSocketProbe();
  bindProbe();
  await loopback2Probe(port);
  await plantProbe();
  await envProbe();
  await clockProbe();
  await perlProbe();
  await orphanProbe();
  recreateProbe();
  await teardownProbe();
  await sandboxOffProbe();
  childTmpInvariant();
  effectivePolicyProbe();
} catch (e) { check("gate ran to the end", false, String(e?.stack ?? e)); }
finally { cleanup(); }
if (!keep) await nothingLeft();
if (inconclusive && fails === 0) process.exitCode = 2;
console.log(JSON.stringify({ ok: fails === 0 && https200 && !inconclusive, fails, inconclusive, notes }));
