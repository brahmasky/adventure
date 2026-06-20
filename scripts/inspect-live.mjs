// Read-only inspection of the LIVE daemon's houge.sqlite — confirms the real Telegram
// turn path: classified intents, conversation memory, learned lessons, provider lines.
// Safe to run while the daemon is active (read-only open). Run: node scripts/inspect-live.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const db = new DatabaseSync("houge.sqlite", { readOnly: true });
const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ error: e.message }]; } };

console.log("===== TURN RUNS (recent, oldest→newest) =====");
const turns = q("SELECT run_id, substr(goal,1,72) AS g, state, created_at FROM runs WHERE type='turn' OR program='turn' ORDER BY created_at DESC LIMIT 25");
for (const r of [...turns].reverse()) console.log(`${(r.created_at||'').slice(11,19)}  ${(r.state||'').padEnd(10)} ${JSON.stringify(r.g)}`);

console.log("\n===== CHAT_TURNS (thread: classified intents) =====");
const ct = q("SELECT role, intent, substr(text,1,68) AS t, created_at FROM chat_turns ORDER BY created_at DESC LIMIT 30");
for (const t of [...ct].reverse()) console.log(`${(t.created_at||'').slice(11,19)}  ${String(t.role).padEnd(9)} ${String(t.intent||'-').padEnd(9)} ${JSON.stringify(t.t)}`);

console.log("\n===== LESSON_BLOCKS (what was learned) =====");
const lb = q("SELECT scope, block, char_cap, updated_at FROM lesson_blocks");
if (!lb.length) console.log("(none yet)");
for (const b of lb) console.log(`[${b.scope}] (${b.block.length}/${b.char_cap} chars, ${b.updated_at})\n${b.block}`);

console.log("\n===== PROVIDER SOURCE LINES (from turn reports) =====");
const seen = new Set();
for (const r of turns) {
  try { for (const m of (readFileSync(join("runs", r.run_id, "report.md"), "utf8").match(/llm:\S+/g) || [])) seen.add(m); } catch {}
}
console.log([...seen].join("\n") || "(no report source lines found)");
db.close();
