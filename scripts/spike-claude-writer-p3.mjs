#!/usr/bin/env node
// Phase 3.1 spike — can the daemon use CLAUDE as a WRITER (headless, file-editing) in a worktree?
//
// Today the self-write WRITER is hardcoded to Codex (codex --sandbox workspace-write). Paco wants a
// per-role writer/checker flag (HOUGE_SELFWRITE_WRITER / _REVIEWER, each codex|claude) so the heavy
// writer load can sit on whichever subscription is bigger (e.g. Claude Max 5x writer + Codex Plus
// reviewer). The reviewer-as-Claude is proven (spike-claude-reviewer). The UNKNOWN: can `claude -p`
// EDIT files headlessly (tools + permission bypass) in a throwaway worktree and produce a clean diff,
// while reporting token usage?  GO → build the writer abstraction + flags + telemetry. NO-GO → keep
// Codex-only writer.
//
// Containment: runs in a throwaway tmp git repo (isolated; never touches the real project). The real
// pipeline confines the writer to a worktree-of-HEAD; the deterministic guard checks the DIFF (not the
// writer), so this changes who writes, never what's allowed to land. Permission bypass is scoped by cwd.
//
// Run: node scripts/spike-claude-writer-p3.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAEMON_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const CLAUDE_BIN = process.env.HOUGE_CLAUDE_BIN || "/Users/pluo/.local/bin/claude";
const MODEL = process.env.SPIKE_CLAUDE_WRITER_MODEL || "sonnet";
const TIMEOUT_MS = 180_000;

// ── throwaway git repo with a small, deterministic file to edit ─────────────────────────────
const repo = mkdtempSync(join(tmpdir(), "houge-claudewriter-"));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "spike@houge.dev");
git("config", "user.name", "Spike");
git("config", "commit.gpgsign", "false");
const target = "greet.ts";
writeFileSync(join(repo, target),
  `export function greet(name: string): string {\n  return "hello";\n}\n`);
git("add", "-A");
git("commit", "-q", "-m", "initial");

const TASK =
  `In ${target}, change the greet function so it returns the string "hello, " followed by the name ` +
  `argument (e.g. greet("Paco") === "hello, Paco"). Make ONLY that minimal change. Do not touch any other file.`;

console.log("=".repeat(78));
console.log("Phase 3.1 spike — Claude as headless WRITER (file edit in a worktree)");
console.log("=".repeat(78));
console.log(`claude bin: ${CLAUDE_BIN}`);
console.log(`model:      ${MODEL}`);
console.log(`repo:       ${repo}`);
console.log(`task:       ${TASK}\n`);

let ok = true;
const t0 = Date.now();
let envelope = null;
let rawErr = "";
try {
  // Headless agentic edit: print mode + permission bypass (scoped to cwd) + JSON output for usage.
  // bypassPermissions lets the built-in Edit/Write/Bash tools run without an interactive prompt.
  const out = execFileSync(
    CLAUDE_BIN,
    ["-p", "--model", MODEL, "--permission-mode", "bypassPermissions", "--output-format", "json"],
    {
      input: TASK,
      cwd: repo,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PATH: DAEMON_PATH }
    }
  );
  envelope = JSON.parse(out);
} catch (e) {
  ok = false;
  rawErr = `${e.code || ""} ${e.message}`.trim();
  // Some claude versions still print the JSON envelope to stdout on a non-zero exit.
  try { envelope = JSON.parse(e.stdout?.toString() || ""); ok = true; } catch {}
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// ── did it actually edit the file? ──────────────────────────────────────────────────────────
const after = (() => { try { return readFileSync(join(repo, target), "utf8"); } catch { return ""; } })();
const diff = (() => { try { return git("diff"); } catch { return ""; } })();
const edited = diff.trim().length > 0;
const correct = /hello, \s*"?\s*\+\s*name|`hello, \$\{name\}`|"hello, " \+ name/.test(after) ||
  /return\s+`hello, \$\{name\}`/.test(after) || /hello,/.test(after) && after.includes("name");

console.log("── RESULT ───────────────────────────────────────────────────────────────────");
console.log(`elapsed:            ${elapsed}s`);
console.log(`edited the file:    ${edited}`);
console.log(`change looks right: ${correct}`);
if (envelope) {
  const u = envelope.usage || {};
  console.log(`is_error:           ${envelope.is_error}`);
  console.log(`num_turns:          ${envelope.num_turns}`);
  console.log(`tokens:             input=${u.input_tokens} output=${u.output_tokens} ` +
    `cache_read=${u.cache_read_input_tokens} cache_creation=${u.cache_creation_input_tokens}`);
  console.log(`total_cost_usd:     ${envelope.total_cost_usd}`);
} else {
  console.log(`NO JSON envelope. error: ${rawErr}`);
}
console.log("\n── resulting file ──");
console.log(after.split("\n").map((l) => "  " + l).join("\n"));
console.log("\n── git diff ──");
console.log(diff.split("\n").map((l) => "  " + l).join("\n"));

rmSync(repo, { recursive: true, force: true });

console.log("\n" + "=".repeat(78));
if (edited && correct && envelope && !envelope.is_error) {
  console.log("➤ GO. Claude can write headlessly in a worktree, produce a clean diff, and report usage.");
  console.log("  Build: HOUGE_SELFWRITE_WRITER flag (codex|claude) + writer abstraction + llm_call telemetry.");
} else if (edited) {
  console.log("➤ PARTIAL. It edited the file but the change/usage capture needs inspection (see above).");
} else {
  console.log("➤ NO-GO. Claude did not edit the file headlessly. Keep Codex-only writer; add reviewer flag + telemetry.");
}
console.log("=".repeat(78));
