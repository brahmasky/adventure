// Live end-to-end for Learning v1 — drives the REAL built artifacts (real Gateway,
// real LLM chain pi→kimi, real Tavily web, real lesson store, real composer) exactly
// as the daemon wires them. The only thing simulated is the Telegram transport: we
// feed the same TypedTaskEvents the Telegram normalizer produces, because the harness
// can't type into a Telegram chat. Everything downstream of intake is live.
//
//   /research  →  /teach  →  /research   (the 2nd must visibly apply the taught lesson)
//
// Run:  node scripts/live-learning-v1.mjs
import { rmSync } from "node:fs";
import { loadHougeEnv } from "../dist/config/load-env.js";
import { RunStore } from "../dist/run/run-store.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";
import { memoryRootFor } from "../dist/prompt/composer.js";
import { readLessons } from "../dist/memory/lesson-store.js";

loadHougeEnv();

const projectRoot = process.cwd();
// Start from a clean research-lessons slate so the contrast is honest.
rmSync(`${memoryRootFor(projectRoot)}/skills/research.md`, { force: true });

const store = RunStore.openInMemory();
const gateway = new Gateway(store, undefined, projectRoot); // real projectRoot → real memory/
const worker = new CoreWorker(store, projectRoot); // real LLM + real web adapters (from env)

const TOPIC = "What is the capital of France, and roughly what is its city population?";
const MARKER = "🐒 Houge-confidence:";
const LESSON = `Always end every research answer with a final line that reads exactly "${MARKER} <high|medium|low>".`;

function base(key) {
  return {
    source: "cli",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "local" },
    idempotency_key: key,
    source_reference: "live-learning-v1"
  };
}

async function research(label, key) {
  const intake = gateway.intake(buildTypedTaskEvent({ ...base(key), type: "run", program: "web-research", goal: TOPIC }));
  if (!intake.ok) throw new Error(`${label} intake failed: ${JSON.stringify(intake.error)}`);
  const result = await worker.executeRun(intake.run_id, "live-worker");
  // The delivered answer is the final_report notification's text.
  let text = "(no final_report notification)";
  for (;;) {
    const note = store.claimNextNotification(`live-${label}`, 60);
    if (!note) break;
    if (note.intent_type === "final_report") { text = note.payload.text; break; }
  }
  return { status: result.status, text };
}

function teach(scope, lesson, key) {
  const intake = gateway.intake(buildTypedTaskEvent({ ...base(key), type: "teach", program: scope, lesson }));
  if (!intake.ok) throw new Error(`teach intake failed: ${JSON.stringify(intake.error)}`);
  return intake;
}

function banner(t) { console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`); }

try {
  banner("STEP 1 — /research BEFORE teaching (no research lessons loaded)");
  const before = await research("before", "live:research:before");
  console.log(`status: ${before.status}`);
  console.log(before.text);
  console.log(`\n>>> contains marker "${MARKER}" ? ${before.text.includes(MARKER)}`);

  banner(`STEP 2 — /teach research: ${LESSON}`);
  teach("research", LESSON, "live:teach:1");
  const lessons = readLessons(memoryRootFor(projectRoot), "research");
  console.log("memory/skills/research.md is now (human-readable):\n");
  console.log(lessons);

  banner("STEP 3 — /research AFTER teaching (composer folds the lesson in)");
  const after = await research("after", "live:research:after");
  console.log(`status: ${after.status}`);
  console.log(after.text);
  console.log(`\n>>> contains marker "${MARKER}" ? ${after.text.includes(MARKER)}`);

  banner("VERDICT");
  const pass = !before.text.includes(MARKER) && after.text.includes(MARKER);
  console.log(`before had marker: ${before.text.includes(MARKER)}`);
  console.log(`after  had marker: ${after.text.includes(MARKER)}`);
  console.log(pass
    ? "✅ PASS — the taught lesson visibly changed the next /research, end-to-end through the real LLM + web."
    : "❌ INCONCLUSIVE — the marker contrast did not hold; inspect the answers above.");
  process.exitCode = pass ? 0 : 1;
} finally {
  store.close();
}
