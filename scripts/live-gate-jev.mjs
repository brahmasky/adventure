// Live gate for the Jev replay slice (spec 2026-09-25 §Testing). Three fixed messages go to the REAL
// TypeSafe API through the real client into an IN-MEMORY store. PASS requires the right shape,
// a reported versioned jev- model id (the request names the alias `jev-latest`), an llm_attempt row with cost_usd > 0 — AND the two unambiguous messages labelled
// correctly at confidence ≥ 0.7, so a shape-only pass cannot hide a broken question.
// Never opens houge.sqlite — safe beside the live daemon. Needs TYPESAFE_API_KEY in .env.
import { loadHougeEnv } from "../dist/config/load-env.js";
import { createJevClient, JEV_REQUEST_MODEL } from "../dist/jev/jev-client.js";
import { buildJevIntentRequest } from "../dist/jev/intent-question.js";
import { RunStore } from "../dist/run/run-store.js";

loadHougeEnv();
const store = RunStore.openInMemory();
const failures = [];
const jev = createJevClient({
  apiKey: process.env.TYPESAFE_API_KEY,
  audit: store.llmAuditSink({ correlation_id: "gate:jev", role: "classify_replay" }),
  meteredBreached: () => false,
  retries: 1,
  timeoutMs: 15_000
});

const cases = [
  { label: "research", message: "What did the RBA decide at today's rate meeting?", want: "research" },
  { label: "selfcode", message: "Go read your intent classifier source and tell me why it keeps choosing research.", want: "selfcode" },
  { label: "chinese", message: "帮我解释一下什么是复利", want: null }
];

for (const c of cases) {
  const built = buildJevIntentRequest(c.message, [], 500, 0);
  if (!built.ok) { failures.push(`${c.label}: request skipped`); continue; }
  const r = await jev(built.request);
  if (!r.ok) { failures.push(`${c.label}: ${r.reason} ${r.detail}`); continue; }
  const a = r.answers.intent;
  console.log(`${c.label}: ${a.choice} @ ${a.confidence.toFixed(2)} (${r.model}, ${r.latency_ms}ms, ${r.input_tokens} tok)`);
  // The client already rejects a malformed id (JEV_MODEL_ID); here it must be a jev- id, and the versioned one, not the alias echoed.
  if (!/^jev-[A-Za-z0-9._:-]+$/.test(r.model) || r.model === JEV_REQUEST_MODEL) failures.push(`${c.label}: reported model ${r.model} is not a versioned jev- id`);
  if (c.want && (a.choice !== c.want || a.confidence < 0.7)) failures.push(`${c.label}: got ${a.choice}@${a.confidence}, want ${c.want}@≥0.7`);
}

const rows = store.getLedgerEvents().filter((e) => e.event_type === "llm_attempt");
if (rows.length !== cases.length) failures.push(`expected ${cases.length} llm_attempt rows, got ${rows.length}`);
if (!rows.every((r) => r.payload.provider === "jev" && r.payload.role === "classify_replay")) failures.push("attempt rows carry the wrong provider/role");
if (!rows.every((r) => r.payload.outcome !== "ok" || r.payload.cost_usd > 0)) failures.push("an ok jev attempt has no cost_usd — the ceiling is blind to it");
store.close();

console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
