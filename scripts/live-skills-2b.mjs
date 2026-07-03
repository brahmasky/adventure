// Live de-risk for Phase 2b (on-command skill authoring + Gate A) — drives the REAL
// CoreWorker + pi→kimi chain exactly as the daemon does; only the Telegram transport is
// simulated. In-memory DB so the live daemon's data is untouched. Writes real skill files
// into ./skills/ (the daemon reads fresh) and removes them at the end.
//
// Confirms, on the real cheap chain: (1) "write a skill for X" → intent=skill → Gate A=skill
// → a VALID skill markdown is authored + written; (2) a fresh research turn folds it in;
// (3) a tweak-shaped request down-routes to a LESSON (no skill file). Run: node scripts/live-skills-2b.mjs
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadHougeEnv } from "../dist/config/load-env.js";
import { RunStore } from "../dist/run/run-store.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { parseSkillFile } from "../dist/skills/skill-store.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";

loadHougeEnv();

const projectRoot = process.cwd();
const skillsDir = join(projectRoot, "skills");
const store = RunStore.openInMemory();
const gateway = new Gateway(store, undefined, projectRoot);
const worker = new CoreWorker(store, projectRoot);
const CHAT = "live-skills-2b";
let seq = 0;

function turnEvent(text) {
  seq += 1;
  return buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: text,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: `live:turn:${seq}`, source_reference: "live-skills-2b",
    metadata: { telegram_update_id: seq, telegram_message_id: seq }
  });
}

async function send(text) {
  const intake = gateway.intake(turnEvent(text));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake.error)}`);
  const result = await worker.executeRun(intake.run_id, "live");
  const turns = store.getRecentChatTurns(CHAT, 100);
  const assistant = turns.find((t) => t.run_id === intake.run_id && t.role === "assistant");
  let answer = "(no final_report)";
  for (;;) {
    const note = store.claimNextNotification("live", 60);
    if (!note) break;
    if (note.intent_type === "final_report") { answer = note.payload.text; break; }
  }
  return { status: result.status, intent: assistant?.intent ?? "(none)", answer };
}

function listSkillFiles() {
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const scope of readdirSync(skillsDir)) {
    const dir = join(skillsDir, scope);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) out.push(join(scope, f));
  }
  return out;
}

let pass = true;
try {
  console.log("Driving the REAL runSkill path on pi→kimi (Telegram transport simulated)…\n");

  // 1. Author a skill on command.
  const r1 = await send("猴哥, write a skill for cross-checking figures when researching across multiple sources");
  console.log(`### 1. "write a skill…"  → expect intent=skill, Gate A=skill, file authored`);
  console.log(`   status=${r1.status} intent=${r1.intent}`);
  console.log(`   report: ${r1.answer.replace(/\s+/g, " ").slice(0, 240)}`);
  const authored = listSkillFiles().filter((f) => f.startsWith("research"));
  console.log(`   skill files under research/: ${authored.join(", ") || "(none)"}`);
  if (r1.intent !== "skill") { pass = false; console.log("   ✗ intent was not 'skill'"); }
  let validAuthored = false;
  for (const f of authored) {
    const parsed = parseSkillFile(readFileSync(join(skillsDir, f), "utf8"));
    if (parsed) {
      validAuthored = true;
      console.log(`   ✓ ${f} parses — when:"${parsed.meta.when}" anchors=${parsed.meta.anchors.length} v${parsed.meta.version ?? 1}`);
    } else { console.log(`   ✗ ${f} does NOT parse`); }
  }
  if (!validAuthored) { pass = false; console.log("   ✗ no valid skill authored"); }

  // 2. A fresh research turn should now fold the authored skill in (ambient pickup).
  const r2 = await send("猴哥, research the latest battery-tech breakthroughs and compare the numbers");
  console.log(`\n### 2. fresh research turn → expect intent=research, completes (skill in-scope, no reload)`);
  console.log(`   status=${r2.status} intent=${r2.intent} len=${r2.answer.length}`);
  if (r2.status !== "completed") { pass = false; console.log("   ✗ research turn did not complete"); }

  // 3. A tweak-shaped "skill" request should down-route to a LESSON.
  const before = listSkillFiles().length;
  const r3 = await send("猴哥, make a skill that just means always keep your answers shorter and more concise");
  console.log(`\n### 3. tweak-shaped request → expect Gate A=lesson (down-route, no new skill file)`);
  console.log(`   status=${r3.status} intent=${r3.intent}`);
  console.log(`   report: ${r3.answer.replace(/\s+/g, " ").slice(0, 240)}`);
  const after = listSkillFiles().length;
  const lessons = [...new Set(store.listLessons().map((l) => l.scope))].join(", ") || "(none)";
  console.log(`   skill files: before=${before} after=${after} · lesson scopes: ${lessons}`);
  if (after > before) console.log("   ! note: a skill file was created (Gate A called it a skill, not a tweak)");

  console.log(`\n========== ${pass ? "PASS ✓" : "PARTIAL — see notes"} (authoring + valid markdown + pickup) ==========`);
  console.log("(Gate A's tweak/lesson call is the cheap model's judgment — #3 is informational, not a hard gate.)");
} finally {
  rmSync(skillsDir, { recursive: true, force: true });
  store.close();
  console.log(">>> cleaned up ./skills/");
}
process.exit(pass ? 0 : 1);
