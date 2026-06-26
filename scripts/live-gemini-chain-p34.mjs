// Live gate for Phase 3.4 (Gemini chain legs). Drives the REAL CoreWorker on a REAL research turn —
// classify → research → REAL web_search (Tavily) → synthesis on the REAL 4-leg chain
// (pi → agy-cli → kimi-api → gemini-api) — exactly the path that FAILED this morning (run_8672b6fb:
// pi over-cap + kimi empty → silent failure). In-memory DB so the live daemon's data is untouched;
// no Telegram delivery (notify target is local). Proves: (a) the run COMPLETES with a synthesized
// answer, and (b) WHICH leg served the synthesis when pi over-produces.
//
// Run: node scripts/live-gemini-chain-p34.mjs
import { loadHougeEnv } from "../dist/config/load-env.js";
import { RunStore } from "../dist/run/run-store.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";

loadHougeEnv();
console.log("chain:", process.env.HOUGE_LLM_PROVIDERS ?? "(default pi,kimi-api)");
console.log("agy bin:", process.env.HOUGE_AGY_BIN ?? "(PATH)");

const QUERY = "今天和周末的天气如何，适合骑车吗";
const store = RunStore.openInMemory();
try {
  const intake = new Gateway(store).intake(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: QUERY,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: `live-p34:${Date.now()}`,
      source_reference: "live:p34:1"
    })
  );
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);

  console.log(`\n→ running turn: "${QUERY}"\n`);
  const worker = new CoreWorker(store, process.cwd());
  const t0 = Date.now();
  const result = await worker.executeRun(intake.run_id, "live-worker");
  const ms = Date.now() - t0;

  console.log(`status: ${result.status}  (${ms}ms)`);

  // Which provider served each LLM call (classify / synthesis)?
  const events = store.getLedgerEvents(intake.run_id);
  const llmCalls = events.filter((e) => e.event_type === "llm_call");
  console.log("\nLLM calls (provider · model · role):");
  for (const e of llmCalls) {
    const p = e.payload ?? {};
    console.log(`  - ${p.provider ?? "?"} · ${p.model ?? "?"} · ${p.role ?? "?"}`);
  }

  // The synthesized answer that WOULD be delivered to Telegram.
  const note = store.claimNextNotification("live", 30);
  console.log("\nreply that would go to Telegram:");
  console.log("────────────────────────────────────────");
  console.log((note?.payload?.text ?? "(none)").slice(0, 1200));
  console.log("────────────────────────────────────────");

  process.exitCode = result.status === "completed" ? 0 : 1;
} finally {
  store.close();
}
