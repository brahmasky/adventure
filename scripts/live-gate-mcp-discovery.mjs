#!/usr/bin/env node
// Live gate, ADR 0032 5.1 (k): code the planner can plant (a project MCP config, a project custom tool, or a foreign
// tool's user-level MCP config opted in by a workspace .omp/config.yml) must not run when omp starts.
// Starts the real sandboxed planner (dist argv, planner.sb, houge.js hook, a stub bridge) with no prompt, so no model
// call is made. Two runs over the same eight planted project files, each naming a dummy stdio server that logs its spawn:
// HOME points at a temp dir (its .omp a symlink to the real one, so the profile resolves): nothing is written to the real home.
//   control — Houge's overlay WITHOUT its `mcp:` and `disabledProviders:` blocks: every planted kind must fire (else the
//             gate cannot see a regression in that kind, INCONCLUSIVE);
//   gate    — Houge's overlay as written: no server may spawn (PASS), any spawn is FAIL.
// Part 2, ADR 0032 5.1 (l): omp also loads plugin code from the nearest `.omp` at or above its cwd, which no setting turns
// off, so neither sandbox profile may create one in the workspace or directly in an ancestor below $HOME (sandbox-exec probes).
// Usage: npm run build && node scripts/live-gate-mcp-discovery.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_HOME = homedir();
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const REPO = join(DIST, "..");
const { resolveOmpConfig } = await import(join(DIST, "omp/omp-config.js"));
const { writeSeatbeltProfiles } = await import(join(DIST, "omp/seatbelt.js"));
const { writeHougeConfigFile } = await import(join(DIST, "omp/planner-supervisor.js"));
const { PlannerSession } = await import(join(DIST, "omp/planner-session.js"));
const { BridgeServer } = await import(join(DIST, "omp/bridge-server.js"));

const SERVER = `const { appendFileSync } = require("node:fs");
appendFileSync(process.env.GATE_LOG, process.env.GATE_NAME + "\\n");
process.stdin.on("data", (d) => { for (const line of String(d).split("\\n")) { if (!line.trim()) continue; const m = JSON.parse(line);
  if (m.id === undefined) continue;
  const result = m.method === "initialize" ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "g", version: "0" } }
    : m.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n"); } });`;

const PROJECT_FILES = ["cursor:.cursor/mcp.json", "vscode:.vscode/mcp.json", "claude:.claude/mcp.json", "omp:.omp/mcp.json", "mcp:mcp.json",
  "dotmcp:.mcp.json", "gemini:.gemini/settings.json", "windsurf:.codeium/windsurf/mcp_config.json"];

async function runOnce(label, stripMcp) {
  const root = mkdtempSync(join(tmpdir(), "lg-mcp-"));
  const data = join(root, "data"); const ws = join(data, "omp", "workspace", "chat-gate"); const sess = join(data, "omp", "sessions", "chat-gate");
  for (const d of [ws, sess]) mkdirSync(d, { recursive: true });
  const log = join(ws, "spawned.log"); const server = join(ws, "server.cjs"); writeFileSync(server, SERVER);
  for (const entry of PROJECT_FILES) {
    const [name, rel] = entry.split(":");
    const def = { command: process.execPath, args: [server], env: { GATE_LOG: log, GATE_NAME: name } };
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), JSON.stringify(name === "vscode" ? { servers: { [name]: def } } : { mcpServers: { [name]: def } }));
  }
  const toolCanary = `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, "project_custom_tool\\n"); export default function () {}\n`;
  mkdirSync(join(ws, ".omp", "tools"), { recursive: true }); writeFileSync(join(ws, ".omp", "tools", "canary.ts"), toolCanary);
  writeFileSync(join(ws, ".omp", "config.yml"), "disabledProviders: []\nenabledProviders:\n  - cursor\n");
  const fakeHome = join(root, "home"); mkdirSync(join(fakeHome, ".cursor"), { recursive: true }); symlinkSync(join(REAL_HOME, ".omp"), join(fakeHome, ".omp"));
  const userDef = { command: process.execPath, args: [server], env: { GATE_LOG: log, GATE_NAME: "user_cursor_opted_in" } };
  writeFileSync(join(fakeHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { user_cursor_opted_in: userDef } }));
  const ctx = { home: REAL_HOME, repo: REPO, data };
  const sb = writeSeatbeltProfiles(ctx); const configFile = writeHougeConfigFile(ctx);
  if (stripMcp) writeFileSync(configFile, readFileSync(configFile, "utf8").replace(/^(?:mcp|disabledProviders):\n(?: {2}.*\n)+/gm, ""));
  const sys = join(root, "system.md"); writeFileSync(sys, "Gate session. No prompt is sent.");
  const cfg = resolveOmpConfig(process.env);
  const sock = join(root, "b.sock"); const token = `gate-${process.pid}-${Date.now()}`;
  const bridge = await BridgeServer.listen(sock, token, async (req) => (req.kind === "manifest" ? [] : req.kind === "gate" ? { decision: "deny", reason: "gate" } : {}));
  const s = new PlannerSession({ cfg, sessionDir: sess, cwd: ws, systemPromptFile: sys, extensions: [join(DIST, "omp", "extension", "houge.js")],
    bridgeSock: sock, bridgeToken: token, model: cfg.planner[0], configFile, plannerProfile: sb.planner });
  process.env.HOME = fakeHome; // buildChildEnv passes HOME through to omp
  try {
    await s.start();
    await new Promise((r) => setTimeout(r, 6000)); // omp connects MCP servers at startup; give a slow spawn time to log
  } finally {
    process.env.HOME = REAL_HOME;
    await s.stop().catch(() => undefined); await bridge.close().catch(() => undefined);
  }
  const spawned = existsSync(log) ? [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))] : [];
  rmSync(root, { recursive: true, force: true });
  console.log(`${label}: sandbox=${cfg.sandbox} spawned=[${spawned.join(", ")}]`);
  return spawned;
}

/** Part 2: each profile must refuse every planted `.omp` and still allow an ordinary workspace write. */
function writeDenyProbe() {
  const root = mkdtempSync(join(tmpdir(), "lg-omp-")); const data = join(root, "data"); const wsRoot = join(data, "omp", "workspace"); const ws = join(wsRoot, "chat-gate");
  mkdirSync(join(ws, "stage", "plugins"), { recursive: true });
  const sb = writeSeatbeltProfiles({ home: REAL_HOME, repo: REPO, data });
  const cases = [[`mkdir ${ws}/.omp`, false], [`mkdir -p ${ws}/x/.OMP/plugins`, false], [`ln -s /tmp ${ws}/.omp`, false], [`mv ${ws}/stage ${ws}/.omp`, false],
    [`mkdir ${wsRoot}/.omp`, false], [`mkdir ${root}/.omp`, false], [`echo ok > ${ws}/notes.txt`, true]];
  const wrong = [];
  for (const kind of ["planner", "shell"]) for (const [cmd, allowed] of cases) {
    const ok = spawnSync("/usr/bin/sandbox-exec", ["-f", sb[kind], "/bin/bash", "-c", cmd]).status === 0;
    if (ok !== allowed) wrong.push(`${kind}: ${cmd.replace(root, "<tmp>")} ${ok ? "allowed" : "denied"}`);
    spawnSync("/bin/bash", ["-c", `rm -rf ${ws}/.omp ${ws}/x ${wsRoot}/.omp ${root}/.omp; mkdir -p ${ws}/stage/plugins`]);
  }
  rmSync(root, { recursive: true, force: true });
  console.log(`write deny: ${cases.length * 2} probes, ${wrong.length} wrong${wrong.length ? `: ${wrong.join("; ")}` : ""}`);
  return wrong;
}

const control = await runOnce("control (overlay without its mcp and disabledProviders blocks)", true);
const gate = await runOnce("gate (Houge's overlay)", false);
// every item omp 18.19.0 loads without the overlay (the .vscode and windsurf project files never load, overlay or not)
const EXPECTED = ["cursor", "claude", "omp", "mcp", "dotmcp", "gemini", "project_custom_tool", "user_cursor_opted_in"];
const blind = EXPECTED.filter((n) => !control.includes(n));
const denyWrong = writeDenyProbe();
if (gate.length > 0) { console.log(`FAIL: planted code ran under Houge's overlay: ${gate.join(", ")}`); process.exit(1); }
if (denyWrong.length > 0) { console.log("FAIL: a sandbox profile let a .omp project root be planted, or blocked an ordinary write"); process.exit(1); }
if (blind.length > 0) { console.log(`INCONCLUSIVE: the control did not fire ${blind.join(", ")}, so this gate cannot see a regression there`); process.exit(2); }
console.log(`PASS: the control fired every kind (${control.length} items); Houge's overlay fired none; both profiles refuse every planted .omp`);
