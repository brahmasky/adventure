// LIVE GATE for B5 (F3: fallbackFinal honors conversions / hedges) + B6 (to_local_time label).
// Drives the REAL worker (Gateway→CoreWorker, real planner chain + real Tavily), in-memory DB,
// like scripts/verify-research-fix.mjs. Forces the fallback path deterministically by lowering
// the run's contract budget AFTER intake (maxSteps = contract.budget.max_tool_calls; no hash
// check at claim). Scenarios:
//   S1 budget=3  relative-day query → expect step_cap → HEDGE (no relative-day assertions,
//      no invented matches; bilingual hedge survives even if restatement fails).
//   S2 budget=9  same query → if fallback fires WITH conversions present, answer must lead
//      with/quote the labeled converted rows; a clean final is also a pass (guard path, B1).
//   S3 full budget (no override) normal-path regression: correct converted, labeled answer.
// Run: node scripts/live-gate-b5b6.mjs [s1|s2|s3]   (default: all)
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

function overrideToolBudget(run_id, maxToolCalls) {
  // Test-script-only surgery on the in-memory DB: `db` is a TS-private parameter property
  // (plain JS field at runtime); bypasses attachContract's created-state guard (run is queued).
  const db = store.db;
  const row = db.prepare("SELECT contract_json FROM runs WHERE run_id = ?").get(run_id);
  if (!row?.contract_json) throw new Error(`no contract on ${run_id}`);
  const contract = JSON.parse(row.contract_json);
  contract.budget.max_tool_calls = maxToolCalls;
  db.prepare("UPDATE runs SET contract_json = ?, updated_at = ? WHERE run_id = ?")
    .run(JSON.stringify(contract), new Date().toISOString(), run_id);
}

async function send(text, { maxToolCalls } = {}) {
  seq += 1;
  const intake = gateway.intake(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: text,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "gate-b5b6" },
      idempotency_key: `gate-b5b6:${seq}`,
      source_reference: "live-gate-b5b6",
      metadata: { telegram_update_id: seq, telegram_message_id: seq }
    })
  );
  if (!intake.ok) throw new Error(JSON.stringify(intake.error));
  if (maxToolCalls) overrideToolBudget(intake.run_id, maxToolCalls);
  const result = await worker.executeRun(intake.run_id, "gate");
  const events = store.getLedgerEvents(intake.run_id);
  const halted = events.find((e) => e.event_type === "loop_halted");
  const loopSteps = events.filter((e) => e.event_type === "loop_step").map((e) => e.payload);
  const tools = loopSteps.map((p) => `${p.action}${p.ok ? "" : "✗"}`);
  const convertSteps = loopSteps.filter((p) => p.action === "to_local_time");
  let answer = "";
  for (;;) {
    const n = store.claimNextNotification("gate", 60);
    if (!n) break;
    if (n.intent_type === "final_report") answer = n.payload.text;
  }
  return { state: result.status, halted: halted?.payload ?? null, tools, convertSteps, answer };
}

const QUERY = "明天有哪几场世界杯比赛？分别是几点开始？";
const SCENARIOS = {
  s1: { label: "S1 forced step_cap, zero-conversion HEDGE", budget: 3, query: QUERY },
  s2: { label: "S2 forced-low budget, conversions may land", budget: 9, query: QUERY },
  s3: { label: "S3 normal-path regression (full budget)", budget: undefined, query: "世界杯现在到哪个阶段了，明天有哪几场比赛？" }
};

const pick = process.argv[2] ? [process.argv[2]] : ["s1", "s2", "s3"];
try {
  for (const key of pick) {
    const s = SCENARIOS[key];
    if (!s) throw new Error(`unknown scenario ${key}`);
    console.log(`\n═══ ${s.label} — budget=${s.budget ?? "(contract default)"} ═══`);
    const r = await send(s.query, { maxToolCalls: s.budget });
    console.log(`state=${r.state}  halted=${JSON.stringify(r.halted)}`);
    console.log(`tools: ${r.tools.join(" → ") || "(none)"}`);
    for (const c of r.convertSteps) console.log(`to_local_time (ok=${c.ok}): ${String(c.result_digest).slice(0, 400)}`);
    console.log(`--- answer (${r.answer.length} chars) ---\n${r.answer}\n`);
  }
} finally {
  store.close();
}
