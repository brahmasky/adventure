// scripts/capture-omp-frames.mjs — captures real omp frames (whatever version is installed) into tests/fixtures/omp-frames/.
// Run manually on the mini (needs the `houge` profile logged in). Never run in CI.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("../tests/fixtures/omp-frames/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const base = ["--profile", "houge", "--no-skills", "--no-rules", "--no-extensions"];
const model = "google-antigravity/gemini-3.8-flash:low";

function json(name, extra, prompt) {
  const r = spawnSync("omp", [...base, "-p", "--mode", "json", "--no-session", ...extra], {
    input: prompt, encoding: "utf8", timeout: 120_000
  });
  // omp exits non-zero with stderr only on a bad model: keep it as a single stderr frame.
  const body = r.stdout || JSON.stringify({ type: "stderr", text: r.stderr }) + "\n";
  writeFileSync(new URL(name, OUT), body);
  console.log(name, "exit", r.status, "bytes", body.length);
}

json("json-ok.jsonl", ["--no-tools", "--model", model], "Reply with exactly: OK");
json("json-tool.jsonl", ["--tools", "read", "--model", model], "Read the file /etc/hosts and reply with its first word.");
json("json-error-bad-model.jsonl", ["--no-tools", "--model", "google-antigravity/no-such-model"], "hi");

function rpc(name, commands, { persist = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn("omp", [...base, "--mode", "rpc", ...(persist ? [] : ["--no-session"]), "--no-tools", "--model", model]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    let i = 0;
    const next = () => { if (i < commands.length) p.stdin.write(JSON.stringify(commands[i++]) + "\n"); };
    p.stdout.on("data", (d) => { if (String(d).includes('"agent_end"') || String(d).includes('"response"')) next(); });
    setTimeout(next, 1500);
    setTimeout(() => { p.kill("SIGTERM"); writeFileSync(new URL(name, OUT), out); console.log(name, out.length); resolve(); }, 60_000);
  });
}

await rpc("rpc-prompt.jsonl", [{ id: "p1", type: "prompt", message: "Reply with exactly: RPC OK" }]);
await rpc("rpc-set-model.jsonl", [
  { id: "m1", type: "set_model", provider: "kimi-code", modelId: "k3" },
  { id: "t1", type: "set_thinking_level", level: "low" },
  { id: "s1", type: "get_state" }
]);
await rpc("rpc-open-session.jsonl", [{ id: "o1", type: "open_session", sessionDir: "/tmp/houge-omp-capture-sess" }], { persist: true });
