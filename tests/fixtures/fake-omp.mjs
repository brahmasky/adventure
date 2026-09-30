#!/usr/bin/env node
// tests/fixtures/fake-omp.mjs — stands in for omp in hermetic tests. Never used in production.
// Env: FAKE_OMP_SCENARIO = path to a JSON file { "<provider/model>": Behaviour, "*": Behaviour }
//   Behaviour = { frames?: "<fixture file name>", text?: string, exit?: number, stderr?: string,
//                 sleepMs?: number, usage?: {input:number, output:number} }
// FAKE_OMP_ARGV_LOG = path; each invocation appends one JSON line with argv and stdin.
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("omp/18.4.4\n"); process.exit(0); }

const modeIdx = argv.indexOf("--mode");
if (modeIdx >= 0 && argv[modeIdx + 1] === "rpc") await runRpc();

async function runRpc() {
  const log = (o) => { if (process.env.FAKE_OMP_ARGV_LOG) appendFileSync(process.env.FAKE_OMP_ARGV_LOG, JSON.stringify(o) + "\n"); };
  log({ argv, stdin: "" });
  const scen = process.env.FAKE_OMP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8")) : {};
  const mIdx = argv.indexOf("--model");
  let model = mIdx >= 0 ? argv[mIdx + 1].split(":")[0] : "";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  let steered = [];
  out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
  const handle = (cmd) => {
    log({ cmd });
    const b = scen[model] ?? scen["*"] ?? {};
    const reply = (data) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data === undefined ? {} : { data }) });
    if (cmd.type === "open_session") return reply({ cancelled: false, resumed: process.env.FAKE_OMP_RESUMED === "1", sessionId: "s1", sessionFile: "/tmp/fake-s1.jsonl" });
    if (cmd.type === "set_model") { model = `${cmd.provider}/${cmd.modelId}`; return reply({ id: cmd.modelId, provider: cmd.provider }); }
    if (cmd.type === "steer") { steered.push(cmd.message); return reply(); }
    if (cmd.type === "abort") { reply(); return out({ type: "agent_end", messages: [], aborted: true }); }
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
    if (b.rpcHangAfterPrompt) return;
    const [provider, mid] = model.split("/");
    const text = (b.rpcErrorText ? "" : (b.rpcText ?? "RPC OK")) + steered.map((t) => " STEERED:" + t).join("");
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

const stdin = await new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve("");
  let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => resolve(s));
});
if (process.env.FAKE_OMP_ARGV_LOG) appendFileSync(process.env.FAKE_OMP_ARGV_LOG, JSON.stringify({ argv, stdin }) + "\n");

const scenario = process.env.FAKE_OMP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8")) : {};
const mi = argv.indexOf("--model");
const modelArg = mi >= 0 ? argv[mi + 1] : "";
const modelKey = modelArg.split(":")[0];
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
