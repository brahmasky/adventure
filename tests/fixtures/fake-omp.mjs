#!/usr/bin/env node
// tests/fixtures/fake-omp.mjs — stands in for omp in hermetic tests. Never used in production.
// Env: FAKE_OMP_SCENARIO = path to a JSON file { "<provider/model>": Behaviour, "*": Behaviour }
//   Behaviour = { frames?: "<fixture file name>", text?: string, exit?: number, stderr?: string,
//                 sleepMs?: number, usage?: {input:number, output:number} }
//   rpc mode also reads: rpcText, rpcEcho (reply carries the prompt), rpcNoManifest (skip the bridge
//   manifest at startup), rpcSteerError (answer a steer success:false with this text), rpcIgnoreAbort (ack an abort but never end the turn), rpcFinishOnSteer (hold the reply until a steer arrives), rpcCall: { tool, args } (one bridge `call` after the prompt; its content is
//   appended to the reply as " CALL:<content>"), rpcHangAfterPrompt, rpcNoReply, rpcExitAfterPrompt, …
// Top-level `rpcBadModelAtStart: ["<provider/model>", …]` (rpc AND -p modes): when --model matches, the fake does what
// omp 18.4.4 does live — writes `Model "<provider/model>" not found` plus a hint line to stderr and exits 1 before
// `ready` (in rpc mode after the extension's bridge hello/manifest, as the real extension loads first).
// Top-level `rpcStderrAtStart: "<text>"` (rpc): writes that text to stderr and exits 1 before `ready` (a crash at start).
// In rpc mode the fake plays the omp extension's load-time side of the bridge (hello + manifest over
// HOUGE_BRIDGE_SOCK with HOUGE_BRIDGE_TOKEN, src/omp/bridge-protocol.ts) so the supervisor's start check passes.
// FAKE_OMP_ARGV_LOG = path; each invocation appends one JSON line with argv, stdin, TMPDIR and the env var NAMES it got
//   (envKeys: names only, so a child-env canary test can prove a daemon secret never reached the child).
import { spawn as spawnChild } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("omp/18.4.4\n"); process.exit(0); }

const modeIdx = argv.indexOf("--mode");
if (modeIdx >= 0 && argv[modeIdx + 1] === "rpc") await runRpc();

async function runRpc() {
  const log = (o) => { if (process.env.FAKE_OMP_ARGV_LOG) appendFileSync(process.env.FAKE_OMP_ARGV_LOG, JSON.stringify(o) + "\n"); };
  log({ argv, stdin: "", pid: process.pid, tmpdir: process.env.TMPDIR ?? null, envKeys: Object.keys(process.env) });
  const scen = process.env.FAKE_OMP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8")) : {};
  const mIdx = argv.indexOf("--model");
  let model = mIdx >= 0 ? argv[mIdx + 1].split(":")[0] : "";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (scen.rpcStderrAtStart) { process.stderr.write(scen.rpcStderrAtStart); process.exit(1); }
  if ((scen.rpcBadModelAtStart ?? []).includes(model)) {
    if (!(scen["*"] ?? {}).rpcNoManifest) await openBridge();
    rejectModel(model);
  }
  let steered = [];
  let held = null; // rpcFinishOnSteer: the prompt that answers once a steer arrives
  const bridge = (scen["*"] ?? {}).rpcNoManifest ? null : await openBridge();
  // Top-level `rpcHelperPidFile`: leave a helper process in our process group (no pipes held) and write its pid.
  if (scen.rpcHelperPidFile) { const h = spawnChild("/bin/sleep", ["60"], { stdio: "ignore" }); h.unref(); writeFileSync(scen.rpcHelperPidFile, String(h.pid)); }
  out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
  const handle = (cmd) => {
    log({ cmd });
    const b = scen[model] ?? scen["*"] ?? {};
    const reply = (data) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data === undefined ? {} : { data }) });
    if (cmd.type === "open_session") return reply({ cancelled: false, resumed: process.env.FAKE_OMP_RESUMED === "1", sessionId: "s1", sessionFile: "/tmp/fake-s1.jsonl" });
    if (cmd.type === "set_model") { model = `${cmd.provider}/${cmd.modelId}`; return reply({ id: cmd.modelId, provider: cmd.provider }); }
    if (cmd.type === "steer" && b.rpcSteerError) {
      return out({ id: cmd.id, type: "response", command: "steer", success: false, error: b.rpcSteerError });
    }
    if (cmd.type === "steer") {
      steered.push(cmd.message); reply();
      if (held) { const h = held; held = null; finish(h.b, h.message, ""); }
      return;
    }
    if (cmd.type === "abort") { reply(); if (b.rpcIgnoreAbort) return; return out({ type: "agent_end", messages: [], aborted: true }); }
    if (cmd.type !== "prompt") return reply();
    if (b.rpcExitAfterPrompt) process.exit(3);
    if (b.rpcNoReply) return;
    if (b.rpcSplitUtf8) {
      reply();
      const buf = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "猴哥" }] } }) + "\n");
      const cut = buf.indexOf(Buffer.from("猴")) + 1; // mid-character
      process.stdout.write(buf.subarray(0, cut));
      return void setTimeout(() => process.stdout.write(buf.subarray(cut)), 50);
    }
    if (b.rpcHuge) { reply(); return void process.stdout.write("x".repeat(200_000)); }
    reply();
    if (b.rpcCall) return void callThenFinish(b, cmd.message);
    if (b.rpcHangAfterPrompt) return;
    if (b.rpcFinishOnSteer) { held = { b, message: cmd.message }; return; }
    finish(b, cmd.message, "");
  };
  const callThenFinish = async (b, message) => {
    out({ type: "turn_start" }); out({ type: "tool_execution_start", toolName: b.rpcCall.tool });
    let content = "no bridge";
    if (bridge) { try { content = (await bridge.request({ kind: "call", tool: b.rpcCall.tool, input: b.rpcCall.args ?? {}, toolCallId: "tc1" })).content; } catch (e) { content = `error ${e.message}`; } }
    if (b.rpcHangAfterPrompt) return;
    finish(b, message, " CALL:" + content);
  };
  const finish = (b, message, suffix) => {
    const [provider, mid] = model.split("/");
    const text = (b.rpcErrorText ? "" : (b.rpcText ?? "RPC OK")) + (b.rpcEcho ? ` ECHO:${message}` : "") + suffix + steered.map((t) => " STEERED:" + t).join("");
    steered = [];
    const msg = { role: "assistant", content: [{ type: "text", text }], provider, model: mid,
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: b.rpcErrorText ? "error" : "stop",
      ...(b.rpcErrorText ? { errorMessage: b.rpcErrorText } : {}) };
    out({ type: "turn_start" }); out({ type: "message_end", message: msg });
    out({ type: "turn_end", message: msg }); out({ type: "agent_end", messages: [msg] });
  };
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
  });
  await new Promise((r) => process.stdin.on("end", r));
  process.exit(0);
}

/** omp's own start-time refusal of an unknown --model (text as observed live on 18.4.4). */
function rejectModel(model) {
  process.stderr.write(`Model "${model}" not found\n\nRun \`omp models find <pattern>\` to search, or \`omp models\` to list all.\n`);
  process.exit(1);
}

/** hello + manifest over the bridge socket; resolves to a request() once the manifest answered. */
function openBridge() {
  const sock = process.env.HOUGE_BRIDGE_SOCK; const token = process.env.HOUGE_BRIDGE_TOKEN;
  if (!sock || !token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const s = connect(sock); const pending = new Map(); let n = 0; let buf = "";
    s.setEncoding("utf8");
    s.on("error", () => resolve(null));
    s.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const p = pending.get(m.id); if (p) { pending.delete(m.id); m.ok ? p.ok(m.result) : p.err(new Error(String(m.error))); }
      }
    });
    const request = (msg) => new Promise((ok, err) => { const id = `f${++n}`; pending.set(id, { ok, err }); s.write(JSON.stringify({ ...msg, id }) + "\n"); });
    s.on("connect", () => {
      s.write(JSON.stringify({ id: "hello", kind: "hello", token }) + "\n");
      request({ kind: "manifest" }).then(() => resolve({ request }), () => resolve({ request }));
    });
  });
}

const stdin = await new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve("");
  let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => resolve(s));
});
if (process.env.FAKE_OMP_ARGV_LOG) appendFileSync(process.env.FAKE_OMP_ARGV_LOG, JSON.stringify({ argv, stdin, tmpdir: process.env.TMPDIR ?? null, envKeys: Object.keys(process.env) }) + "\n");

const scenario = process.env.FAKE_OMP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8")) : {};
const mi = argv.indexOf("--model");
const modelArg = mi >= 0 ? argv[mi + 1] : "";
const modelKey = modelArg.split(":")[0];
if ((scenario.rpcBadModelAtStart ?? []).includes(modelKey)) rejectModel(modelKey);
const b = scenario[modelKey] ?? scenario["*"] ?? { text: "OK" };
if (b.sleepMs) await new Promise((r) => setTimeout(r, b.sleepMs));
if (b.stderr) process.stderr.write(b.stderr);

if (argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "json") {
  if (b.frames) {
    process.stdout.write(readFileSync(new URL(`./omp-frames/${b.frames}`, import.meta.url), "utf8"));
  } else if (b.text !== undefined) {
    const [provider, model] = modelKey.split("/");
    const u = b.usage ?? { input: 100, output: 10 };
    for (const f of [
      { type: "turn_start" },
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: stdin }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: b.text }], provider, model,
        usage: { input: u.input, output: u.output, cacheRead: 0, cacheWrite: 0 }, stopReason: b.stopReason ?? "stop",
        errorMessage: b.errorMessage, credentialId: 1, ttft: 12, duration: 34 } },
      { type: "agent_end", isTerminal: true }
    ]) process.stdout.write(JSON.stringify(f) + "\n");
  }
  process.exit(b.exit ?? 0);
}
process.exit(b.exit ?? 0);
