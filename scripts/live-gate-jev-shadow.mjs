// Live gate for the Jev LIVE shadow (spec 2026-09-25 + 2026-09-26 amendments). ONE real turn in an
// IN-MEMORY store with the production adapters: the real classifier chain AND the real Jev client.
// PASS requires a completed turn, exactly one intent_shadow row (ok, pinned model, parsed label, no
// message text), and a classify_shadow llm_attempt row priced by the ceiling. Never opens
// houge.sqlite. Needs TYPESAFE_API_KEY in .env; makes 2+ flat-rate CLI calls and one Jev call.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHougeEnv } from "../dist/config/load-env.js";
import { DISARM_FLAGS } from "../dist/config/disarm-posture.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { JEV_MODEL } from "../dist/jev/jev-client.js";
import { RunStore } from "../dist/run/run-store.js";

loadHougeEnv();
// Hermetic turn: every optional capability off (the disarm set), episodic/dual-LLM off, shadow ON.
for (const flag of DISARM_FLAGS) process.env[flag] = "false";
process.env.HOUGE_EPISODIC_ENABLED = "false";
process.env.HOUGE_DUAL_LLM_ENABLED = "false";
process.env.HOUGE_JEV_SHADOW_ENABLED = "true";

const MESSAGE = "Say hello in one short sentence.";
const root = mkdtempSync(join(tmpdir(), "houge-gate-jev-shadow-"));
const store = RunStore.openInMemory();
const failures = [];
try {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: MESSAGE,
    requested_by: { kind: "user", id: "gate" }, notify: { kind: "telegram", chat_id: "gate" },
    idempotency_key: `gate:jev-shadow:${Date.now()}`, source_reference: "gate"
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  const t0 = Date.now();
  const result = await new CoreWorker(store, root).executeRun(intake.run_id, "gate");
  console.log(`turn: ${result.status} in ${Date.now() - t0}ms`);
  if (result.status !== "completed") failures.push(`turn did not complete: ${result.status}`);

  const deadline = Date.now() + 10_000;
  let shadow = [];
  while (Date.now() < deadline) {
    shadow = store.getLedgerEvents(intake.run_id).filter((e) => e.event_type === "intent_shadow");
    if (shadow.length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const p = shadow[0]?.payload;
  console.log("intent_shadow:", JSON.stringify(p));
  if (shadow.length !== 1) failures.push(`expected 1 intent_shadow row, got ${shadow.length}`);
  if (p && p.status !== "ok") failures.push(`shadow status ${p.status} (${p.jev_error ?? "no detail"})`);
  if (p && p.jev_model !== JEV_MODEL) failures.push(`jev_model ${p.jev_model} ≠ pinned ${JEV_MODEL}`);
  if (p && p.llm_parsed !== true) failures.push("classifier label not parsed");
  if (p && JSON.stringify(p).includes("hello in one short sentence")) failures.push("message text leaked into intent_shadow");

  const attempts = store.getLedgerEvents(intake.run_id).filter((e) => e.event_type === "llm_attempt" && e.payload.role === "classify_shadow");
  console.log("classify_shadow attempts:", attempts.map((a) => JSON.stringify(a.payload)).join(" | "));
  if (attempts.length !== 1) failures.push(`expected 1 classify_shadow llm_attempt, got ${attempts.length}`);
  if (attempts[0] && !(attempts[0].payload.cost_usd > 0)) failures.push("classify_shadow attempt has no cost_usd — the ceiling is blind to it");
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
