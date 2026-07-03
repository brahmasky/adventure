// Live end-to-end for the conversational interaction model (ADR 0010) — drives the REAL
// built artifacts (Gateway, CoreWorker, the pi→kimi LLM chain, real Tavily web, the intent
// classifier, chat_turns memory, lesson_blocks, the feedback distiller) exactly as the daemon
// does. The only simulated leg is the Telegram transport (we feed the same `turn` events the
// normalizer produces). In-memory DB so the live launchd daemon's state is untouched.
//
// Purpose: de-risk the interactive Telegram test — especially "does the cheap model reliably
// classify intent?" — before the human runs it.  Run:  node scripts/live-conversational.mjs
import { loadHougeEnv } from "../dist/config/load-env.js";
import { RunStore } from "../dist/run/run-store.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";

loadHougeEnv();

const projectRoot = process.cwd();
const store = RunStore.openInMemory();
const gateway = new Gateway(store, undefined, projectRoot); // real projectRoot
const worker = new CoreWorker(store, projectRoot);          // real LLM + web adapters (from env)
const CHAT = "live-conv";
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
    source_reference: "live-conversational",
    metadata: { telegram_update_id: seq, telegram_message_id: seq }
  });
}

async function send(text) {
  const intake = gateway.intake(turnEvent(text));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake.error)}`);
  const result = await worker.executeRun(intake.run_id, "live-conv");
  // The classified intent is recorded on the assistant chat_turn for this run.
  const turns = store.getRecentChatTurns(CHAT, 100);
  const assistant = turns.find((t) => t.run_id === intake.run_id && t.role === "assistant");
  // The delivered answer is the final_report notification text.
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
  console.log(`   status=${r.status}  intent=${r.intent}  answer_len=${r.answer.length}`);
  console.log(`   ${oneLine.slice(0, 280)}${oneLine.length > 280 ? "…" : ""}`);
}

try {
  console.log("Driving the real turn path on the pi→kimi chain + real Tavily…");

  show("1. plain question  → expect intent=answer", await send("what's the capital of France?"));
  show("2. follow-up       → expect answer, uses thread (Paris)", await send("and roughly its city population?"));
  const r3 = await send("what's the latest news on SpaceX this week?");
  show("3. research        → expect intent=research, has Sources", r3);
  const r4 = await send("too long");
  show("4. feedback        → expect intent=feedback, tighter re-answer", r4);

  const research3 = store.readLessonBlock("research");
  console.log(`\n### 5. /lessons research after feedback\n${research3 ? research3 : "(empty — nothing learned)"}`);

  const r6 = await send("what's the latest on Tesla's earnings?");
  show("6. fresh research  → expect tighter than #3 (lesson applied)", r6);
  console.log(`   [len #3=${r3.answer.length}  vs  len #6=${r6.answer.length}]`);

  show("7. vague           → expect intent=clarify (a question back)", await send("can you help me with that thing?"));

  console.log("\n========== SUMMARY ==========");
  const lessonScopes = [...new Set(store.listLessons().map((l) => l.scope))];
  console.log(`lessons: ${lessonScopes.map((s) => `${s}(${store.readLessonBlock(s)?.length ?? 0}ch)`).join(", ") || "(none)"}`);
  console.log("research lesson block:\n" + (store.readLessonBlock("research") ?? "(none)"));
} finally {
  store.close();
}
