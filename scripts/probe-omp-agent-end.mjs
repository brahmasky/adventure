#!/usr/bin/env node
// P7 probe (decision ladder spec §7.3, §12): does omp emit a non-terminal agent_end, and in what frame order?
// Runs the installed omp in RPC mode (profile `houge`, no tools, no session) on the Fast leg. Case A, a late steer: after
// the first assistant message_end, wait d ms and send a steer, for each d, until one agent_end carries isTerminal:false.
// Writes the first such sequence (types, terminal flags and short texts only) to
// tests/fixtures/omp-frames/agent-end-late-steer.jsonl. The other cases (omp's own retry, compaction, empty-stop and
// async-work continuations) cannot be forced from outside; their fixtures are written from the omp source and say so.
// Exit: 0 captured · 3 INCONCLUSIVE (the race was never hit) · 2 setup error. Never runs in CI.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeHougeConfigFile } from "../dist/omp/planner-supervisor.js";

const OUT = new URL("../tests/fixtures/omp-frames/agent-end-late-steer.jsonl", import.meta.url);
const MODEL = process.env.PROBE_MODEL ?? "google-antigravity/gemini-3.8-flash:low";
const DELAYS_MS = [0, 1, 2, 5, 10, 20, 40, 80, 160];
const TIMEOUT_MS = 60_000;
const DATA = mkdtempSync("/tmp/hg-p7-");
mkdirSync(join(DATA, "omp")); // writeHougeConfigFile writes <data>/omp/houge-config.yml and creates no directory
const CONFIG = writeHougeConfigFile({ data: DATA }); // build the worktree first: this imports its dist

/** Only what a test needs: type, the terminal flags, the assistant text and stop reason. Never a prompt. */
function slim(f) {
  if (f.type === "agent_end") return { type: f.type, isTerminal: f.isTerminal, yielded: f.yielded, awaitingAsyncWork: f.awaitingAsyncWork, aborted: f.aborted };
  if (f.type === "message_end" && f.message?.role === "assistant") {
    const text = (f.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 40);
    return { type: f.type, message: { role: "assistant", content: [{ type: "text", text }], stopReason: f.message.stopReason } };
  }
  return { type: f.type };
}

function attempt(delayMs) {
  return new Promise((resolve) => {
    // the production omp config (no telemetry or update checks, S2b's retry block), from this build's dist (senior suggestion)
    const p = spawn("omp", ["--profile", "houge", "--config", CONFIG, "--no-skills", "--no-rules", "--no-extensions", "--mode", "rpc", "--no-session", "--no-tools", "--model", MODEL]);
    const frames = []; let buf = ""; let steered = false; let ends = 0;
    const done = (r) => { clearTimeout(timer); p.kill("SIGTERM"); resolve(r); };
    const timer = setTimeout(() => done({ frames, timedOut: true }), TIMEOUT_MS);
    p.on("error", (e) => done({ frames, error: e.message }));
    p.stdout.on("data", (d) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (!["turn_start", "message_end", "agent_end"].includes(f.type)) continue;
        frames.push(slim(f));
        if (f.type === "message_end" && f.message?.role === "assistant" && !steered) {
          steered = true;
          setTimeout(() => p.stdin.write(`${JSON.stringify({ id: "s1", type: "steer", message: "Now reply with exactly: TWO" })}\n`), delayMs);
        }
        if (f.type === "agent_end" && f.isTerminal !== false && ++ends >= 1 && steered) setTimeout(() => done({ frames }), 3_000);
      }
    });
    setTimeout(() => p.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "Reply with exactly: ONE" })}\n`), 1_500);
  });
}

async function main() {
  for (const d of DELAYS_MS) {
    const r = await attempt(d);
    if (r.error) { console.error(`setup error: ${r.error}`); return 2; }
    const nonTerminal = r.frames.some((f) => f.type === "agent_end" && f.isTerminal === false);
    console.log(`delay ${d} ms: ${r.frames.map((f) => (f.type === "agent_end" ? `agent_end(${f.isTerminal === false ? "non-terminal" : "terminal"})` : f.type)).join(" → ")}`);
    if (!nonTerminal) continue;
    mkdirSync(new URL(".", OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify({ _source: `probe omp RPC, late steer after ${d} ms, ${new Date().toISOString()}` })}\n${r.frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
    console.log(`P7 PROBE: captured a non-terminal agent_end at delay ${d} ms → ${OUT.pathname}`);
    return 0;
  }
  console.log("P7 PROBE: INCONCLUSIVE — no delay produced a non-terminal agent_end (the source-derived fixtures still stand)");
  return 3;
}

main().then((c) => process.exit(c), (e) => { console.error(`probe setup error: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); });
