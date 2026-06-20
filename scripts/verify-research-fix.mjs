// Confirms the kimi max_tokens fix resolves the live research-synthesis failure.
// Replays the exact query that failed on real Telegram, through the REAL worker
// (pi→kimi + real Tavily), in-memory DB. Run: node scripts/verify-research-fix.mjs
import { loadHougeEnv } from "../dist/config/load-env.js";
import { RunStore } from "../dist/run/run-store.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";

loadHougeEnv();
const store = RunStore.openInMemory();
const gateway = new Gateway(store, undefined, process.cwd());
const worker = new CoreWorker(store, process.cwd());
let seq = 0;

async function send(text) {
  seq += 1;
  const intake = gateway.intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: text,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "verify" },
    idempotency_key: `verify:${seq}`, source_reference: "verify-fix",
    metadata: { telegram_update_id: seq, telegram_message_id: seq }
  }));
  if (!intake.ok) throw new Error(JSON.stringify(intake.error));
  const result = await worker.executeRun(intake.run_id, "verify");
  const a = store.getRecentChatTurns("verify", 50).find((t) => t.run_id === intake.run_id && t.role === "assistant");
  let answer = "";
  for (;;) { const n = store.claimNextNotification("v", 60); if (!n) break; if (n.intent_type === "final_report") { answer = n.payload.text; break; } }
  return { state: result.status, intent: a?.intent, len: answer.length, head: answer.replace(/\s+/g, " ").slice(0, 200) };
}

try {
  for (const qy of [
    "最近的股票市场怎么样？ 有什么AI产业链的底层股票值得关注",   // the query that FAILED live
    "what's the latest on Tesla's earnings?"
  ]) {
    const r = await send(qy);
    console.log(`\nQ: ${qy}`);
    console.log(`   state=${r.state}  intent=${r.intent}  answer_len=${r.len}`);
    console.log(`   ${r.head}${r.len > 200 ? "…" : ""}`);
    console.log(`   ${r.state === "completed" && r.len > 0 ? "✅ research synthesized" : "❌ still failing"}`);
  }
} finally {
  store.close();
}
