// Research-convergence soak metric (Phase R soak-watch). Read-only over the live
// houge.sqlite — safe while the daemon runs. Quantifies whether research/answer turns
// CONVERGE (synthesize efficiently) vs SEARCH-LOOP (repeat searches, hit step_cap, or
// forced-fallback). The load-bearing signal is web-searches-per-run: step_cap is a rare
// tail; the everyday degradation is a turn that ends "final" but burned 8-10 searches.
//   Run: node scripts/convergence-soak.mjs [--days N]   (default 7)
import { DatabaseSync } from "node:sqlite";

const daysArg = process.argv.find((a) => /^--days=/.test(a));
const posArg = process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a));
const DAYS = Number(daysArg ? daysArg.split("=")[1] : posArg) || 7;

// Tunables — a research/answer turn is DEGRADED if it exceeds either, or was force-halted.
const SEARCH_CAP = 5; // healthy research runs sit at 2-4; the incidents were 8 and 10
const TOOLCALL_CAP = 8; // contract hard cap is 14; converged research runs use <=5

const db = new DatabaseSync("houge.sqlite", { readOnly: true });
const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return [{ error: e.message }]; } };

// Window boundary from the DB clock's own max, minus N days (no host-clock dependency).
const maxRow = all("SELECT MAX(occurred_at) AS m FROM ledger_events")[0];
const nowMs = Date.parse(maxRow?.m || new Date(0).toISOString());
const since = new Date(nowMs - DAYS * 86_400_000).toISOString();

// Pull every research/answer run's start, halt, completion, and per-run search/dedup counts.
const rows = all(
  `WITH starts AS (
     SELECT run_id, occurred_at,
            json_extract(payload_json,'$.hint') AS hint
     FROM ledger_events WHERE event_type='loop_started' AND occurred_at >= ?
   )
   SELECT s.run_id, s.occurred_at, s.hint,
     (SELECT json_extract(payload_json,'$.reason') FROM ledger_events e
        WHERE e.run_id=s.run_id AND e.event_type='loop_halted' LIMIT 1) AS reason,
     (SELECT json_extract(payload_json,'$.steps') FROM ledger_events e
        WHERE e.run_id=s.run_id AND e.event_type='loop_halted' LIMIT 1) AS steps,
     (SELECT json_extract(payload_json,'$.budget_used.tool_calls') FROM ledger_events e
        WHERE e.run_id=s.run_id AND e.event_type='run_completed' LIMIT 1) AS tool_calls,
     (SELECT COUNT(*) FROM ledger_events e
        WHERE e.run_id=s.run_id AND e.event_type='web_search_performed') AS searches,
     (SELECT COUNT(*) FROM ledger_events e
        WHERE e.run_id=s.run_id AND e.event_type='loop_step'
          AND e.payload_json LIKE '%already took exactly this action%') AS dedups
   FROM starts s
   WHERE s.hint IN ('research','answer')
   ORDER BY s.occurred_at`,
  since
);

if (rows.length && rows[0].error) { console.error("query error:", rows[0].error); process.exit(1); }

// Only these halt reasons are CODE-FORCED fallbacks (degraded). "final" = model
// self-converged, "clarify"/"kickoff" = the model legitimately asking/continuing — not
// failures. (LoopHaltReason, src/core/inner-loop.ts.)
const FORCED_FALLBACK = new Set(["step_cap", "denial", "timeout", "parse_cap", "clarify_cap"]);
const verdict = (r) => {
  if (r.reason && FORCED_FALLBACK.has(r.reason)) return "DEGRADED"; // code forced the fallback
  if ((r.searches || 0) > SEARCH_CAP) return "DEGRADED";            // search-loop
  if ((r.dedups || 0) >= 2) return "DEGRADED";                      // repeated actions (1 = benign noise)
  if ((r.tool_calls || 0) > TOOLCALL_CAP) return "DEGRADED";
  return "converged";
};

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p90 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)] : 0);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "n/a");

console.log(`Research-convergence soak — last ${DAYS} days (since ${since.slice(0, 16)}Z, DB max ${(''+maxRow?.m).slice(0,16)}Z)`);
console.log(`degraded = ended non-final, OR >${SEARCH_CAP} searches, OR any repeated action, OR >${TOOLCALL_CAP} tool calls\n`);

console.log("run          hint      halt      steps  srch  dedup  tc  verdict");
console.log("-----------  --------  --------  -----  ----  -----  --  --------");
for (const r of rows) {
  console.log(
    `${r.run_id.replace("run_", "").slice(0, 11).padEnd(11)}  ${String(r.hint).padEnd(8)}  ` +
    `${String(r.reason || "-").padEnd(8)}  ${String(r.steps ?? "-").padStart(5)}  ` +
    `${String(r.searches ?? 0).padStart(4)}  ${String(r.dedups ?? 0).padStart(5)}  ` +
    `${String(r.tool_calls ?? "-").padStart(2)}  ${verdict(r)}`
  );
}

const report = (label, set) => {
  if (!set.length) { console.log(`\n${label}: (no turns)`); return; }
  const conv = set.filter((r) => verdict(r) === "converged").length;
  const searches = set.map((r) => r.searches || 0);
  const forcedFallback = set.filter((r) => r.reason && FORCED_FALLBACK.has(r.reason)).length;
  const stepCap = set.filter((r) => r.reason === "step_cap").length;
  const loopers = set.filter((r) => (r.searches || 0) > SEARCH_CAP).length;
  const deduped = set.filter((r) => (r.dedups || 0) > 0).length;
  console.log(`\n${label} (${set.length} turns)`);
  console.log(`  convergence rate      ${pct(conv, set.length)}  (${conv}/${set.length})`);
  console.log(`  web-searches / turn   median ${median(searches)}, p90 ${p90(searches)}, max ${Math.max(0, ...searches)}`);
  console.log(`  tool-calls / turn     median ${median(set.map((r) => r.tool_calls || 0))}`);
  console.log(`  search-loop rate      ${pct(loopers, set.length)}  (>${SEARCH_CAP} searches)`);
  console.log(`  forced-fallback rate  ${pct(forcedFallback, set.length)}  (step_cap: ${stepCap})`);
  console.log(`  repeated-action runs  ${pct(deduped, set.length)}`);
};

report("ALL research + answer", rows);
report("research only", rows.filter((r) => r.hint === "research"));
report("answer only", rows.filter((r) => r.hint === "answer"));

const degraded = rows.filter((r) => verdict(r) === "DEGRADED");
if (degraded.length) {
  console.log(`\nDEGRADED runs to inspect (runs/<id>/report.md):`);
  for (const r of degraded) console.log(`  ${r.run_id}  (${r.searches} searches, halt=${r.reason})`);
}
db.close();
