#!/usr/bin/env node
// tests/fixtures/fake-omp.mjs — stands in for omp in hermetic tests. Never used in production.
// Env: FAKE_OMP_SCENARIO = path to a JSON file { "<provider/model>": Behaviour, "*": Behaviour }
//   Behaviour = { frames?: "<fixture file name>", text?: string, exit?: number, stderr?: string,
//                 sleepMs?: number, usage?: {input:number, output:number} }
// FAKE_OMP_ARGV_LOG = path; each invocation appends one JSON line with argv and stdin.
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("omp/18.4.4\n"); process.exit(0); }

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
