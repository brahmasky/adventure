// Phase 3.5 live gate (positive only): land the 猴哥 fix via the REAL self-write pipeline with
// Writer=Codex(gpt-5.5 high) + Reviewer=kimi (confined no-tools agent). The bare one-liner breaks a
// pinned test (intent.test.ts:122 `prompt.startsWith("Today's date…")`), so we hand the writer the
// backward-compat acceptance criteria (a mini-spec — the spec-driven-self-write hypothesis, applied).
// In-memory DB (live daemon untouched); Telegram simulated; the published branch is the deliverable.
import { execFileSync } from "node:child_process";
import { loadHougeEnv } from "../dist/config/load-env.js";
import { RunStore } from "../dist/run/run-store.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";

loadHougeEnv();
process.env.HOUGE_SELFWRITE_ENABLED = "true";
console.log(`config: WRITER=${process.env.HOUGE_SELFWRITE_WRITER} REVIEWER=${process.env.HOUGE_SELFWRITE_REVIEWER}`);

const projectRoot = process.cwd();
const store = RunStore.openInMemory();
const gateway = new Gateway(store, undefined, projectRoot);
const worker = new CoreWorker(store, projectRoot);

function branches() {
  try {
    return execFileSync("git", ["branch", "--list", "houge/selfwrite/*"], { cwd: projectRoot, encoding: "utf8" })
      .split("\n").map((s) => s.replace(/^[*+ ]+/, "").trim()).filter(Boolean);
  } catch { return []; }
}

const MSG =
  "猴哥, fix your intent classifier so its system prompt actually receives your houge.md identity " +
  "(it currently bypasses the composer and keeps asking which 猴哥). ACCEPTANCE CRITERIA (keep existing " +
  "tests passing UNCHANGED): add identity as an OPTIONAL parameter to buildIntentSystemPrompt — when it is " +
  "omitted the prompt must be byte-identical to today AND must STILL START WITH the 'Today's date is …' " +
  "line; inject the identity only when provided, AFTER the date line. Then pass the loaded identity at the " +
  "core-worker call site so the live classifier receives it. Add a NEW test for the with-identity behavior.";

const before = new Set(branches());
console.log(`pre-existing branches: ${[...before].join(", ") || "(none)"}\n`);
console.log("→ sending spec-enriched 猴哥 fix request…\n");

const intake = gateway.intake(buildTypedTaskEvent({
  source: "telegram", type: "turn", program: "turn", goal: MSG,
  requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id: "live-p35" },
  idempotency_key: `live-p35:${process.pid}`, source_reference: "live-p35",
  metadata: { telegram_update_id: 1, telegram_message_id: 1 }
}));
if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake.error)}`);

const t0 = Date.now();
const result = await worker.executeRun(intake.run_id, "live");
const ms = Date.now() - t0;

const turns = store.getRecentChatTurns("live-p35", 50);
const assistant = turns.find((t) => t.run_id === intake.run_id && t.role === "assistant");
let note = "(none)";
for (;;) { const n = store.claimNextNotification("live", 60); if (!n) break; if (n.intent_type === "final_report") { note = n.payload.text; break; } }

console.log(`status=${result.status} intent=${assistant?.intent ?? "(none)"} (${ms}ms)`);
console.log(`notification: ${note.replace(/\s+/g, " ").trim()}\n`);

console.log("LLM calls (role · provider/model · in/out):");
for (const e of store.getLedgerEvents(intake.run_id).filter((e) => e.event_type === "llm_call")) {
  const p = e.payload || {};
  console.log(`  ${p.role} · ${p.provider}/${p.model} · in=${p.input_tokens} out=${p.output_tokens}${p.cost_usd != null ? ` $${p.cost_usd}` : ""}`);
}

const fresh = branches().filter((b) => !before.has(b));
console.log(`\nnew branch(es): ${fresh.join(", ") || "(none)"}`);
if (fresh.length === 1) {
  const br = fresh[0];
  const stat = execFileSync("git", ["diff", "--stat", `HEAD...${br}`], { cwd: projectRoot, encoding: "utf8" }).trim();
  console.log(`diffstat:\n${stat.split("\n").map((l) => "  " + l).join("\n")}`);
  console.log(`\n✓ PUBLISHED: ${br} — the deliverable (Codex wrote it, kimi reviewed it). Paco merges via [Merge & reload].`);
} else {
  console.log("✗ no single branch — inspect the notification + llm_calls above (test-gate red, or reviewer reject).");
}
store.close();
