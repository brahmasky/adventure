// Live end-to-end for Phase 2a (skills as loadable artifacts) — drives the REAL built
// CoreWorker + pi→kimi chain + real Tavily exactly as the daemon does; only the Telegram
// transport is simulated (same `turn` events the normalizer produces). In-memory DB so the
// live launchd daemon's state is untouched. Writes ONE probe skill into the REAL ./skills/
// dir (read fresh each turn, no reload) and removes it at the end.
//
// Proves the gate: a hand-authored research skill's marker is ABSENT in behavior before the
// file exists and PRESENT after.  Run:  node scripts/live-skills-2a.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHougeEnv } from "../dist/config/load-env.js";
import { RunStore } from "../dist/run/run-store.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";

loadHougeEnv();

const MARKER = "🔬 SKILL-2A-LIVE ✓ 🔬";
const projectRoot = process.cwd();
const scopeDir = join(projectRoot, "skills", "research");
const skillFile = join(scopeDir, "research-marker-probe.md");
const SKILL = `---
name: research-marker-probe
scope: research
when: answering any research question
anchors:
  - the marker line is present at the end
version: 1
origin: commanded
---
At the very END of your research answer, append this exact line on its own, verbatim:
${MARKER}
`;

const store = RunStore.openInMemory();
const gateway = new Gateway(store, undefined, projectRoot); // real projectRoot → SkillStore at ./skills
const worker = new CoreWorker(store, projectRoot);          // real LLM + web adapters (from env)
const CHAT = "live-skills-2a";
let seq = 0;

function turnEvent(text) {
  seq += 1;
  return buildTypedTaskEvent({
    source: "telegram",
    type: "turn",
    program: "turn",
    goal: text,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: `live:turn:${seq}`,
    source_reference: "live-skills-2a",
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

function show(label, r) {
  const oneLine = r.answer.replace(/\s+/g, " ").trim();
  console.log(`\n### ${label}`);
  console.log(`   status=${r.status}  intent=${r.intent}  marker=${r.answer.includes("SKILL-2A-LIVE") ? "PRESENT" : "absent"}  len=${r.answer.length}`);
  console.log(`   …${oneLine.slice(-200)}`);
}

let pass = true;
try {
  console.log("Driving the REAL research path on pi→kimi + Tavily (Telegram transport simulated)…");

  // Phase 1 — baseline: no skill file exists yet.
  const before = await send("what's the latest news on SpaceX Starship?");
  show("1. research BEFORE skill → expect marker ABSENT", before);
  if (before.intent !== "research") console.log("   ! note: intent was not 'research'");
  if (before.answer.includes("SKILL-2A-LIVE")) { pass = false; console.log("   ✗ FAIL: marker present at baseline"); }

  // Author the probe skill into the real ./skills/research/ (picked up next turn, no reload).
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(skillFile, SKILL, "utf8");
  console.log(`\n>>> authored ${skillFile}`);

  // Phase 2 — after: same surface, fresh research question.
  const after = await send("what's the latest on the Artemis moon program?");
  show("2. research AFTER skill → expect marker PRESENT", after);
  if (after.intent !== "research") console.log("   ! note: intent was not 'research'");
  if (!after.answer.includes("SKILL-2A-LIVE")) { pass = false; console.log("   ✗ FAIL: marker absent after authoring"); }

  // /skills viewer over the real gateway.
  const skillsEvent = buildTypedTaskEvent({
    source: "telegram", type: "skills", program: "research",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: "live:skills:1", source_reference: "live-skills-2a",
    metadata: { telegram_update_id: 99, telegram_message_id: 99 }
  });
  gateway.intake(skillsEvent);
  let skillsText = "(none)";
  for (;;) {
    const note = store.claimNextNotification("live", 60);
    if (!note) break;
    if (note.intent_type === "progress") { skillsText = note.payload.text; break; }
  }
  console.log(`\n### 3. /skills research → expect lists research-marker-probe\n   ${skillsText.replace(/\s+/g, " ").slice(0, 240)}`);
  if (!skillsText.includes("research-marker-probe")) { pass = false; console.log("   ✗ FAIL: /skills did not list the probe"); }

  console.log(`\n========== ${pass ? "PASS ✓" : "FAIL ✗"} (absent-before / present-after / /skills) ==========`);
} finally {
  rmSync(skillFile, { force: true });
  rmSync(scopeDir, { recursive: true, force: true });
  rmSync(join(projectRoot, "skills"), { recursive: true, force: true });
  store.close();
  console.log(">>> cleaned up probe skill + ./skills/");
}
process.exit(pass ? 0 : 1);
