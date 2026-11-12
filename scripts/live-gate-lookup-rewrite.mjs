// Live gate for the lookup lane's query (Paco 2026-11-12: the lane rewrites every lookup). Real Tiny-role calls through
// the real omp one-shot seat (profile `houge`), each on the lane's own prompt (`rewritePrompt`, the dist's
// REWRITE_INSTRUCTION) and judged by the lane's own code (`queryCheckOf`, `validateQuery`, `stripAddress`, `finalQuery`).
// No search runs: the gate checks the QUERY the lane would search.
//   1. the message that failed on 2026-11-06 ("猴哥, 帮忙找找…", no earlier line): the query keeps the subject, drops the name
//   2. the name at the end, in a short follow-up with a recent line: the query drops the name
//   3. the name as the SUBJECT of the question: the query keeps it
//   4. an English message addressed to Houge: the query drops the address
//   5. a message that is already a query: SAME or an equivalent query, never a longer sentence
//   6. no model at all (the rewrite failed): the bare message is searched without the address
// PASS = every line passes. A line whose call fails or runs past the lane's 12 s bound is INCONCLUSIVE, and then there
// is no PASS: the lane would fall back to line 6's path, which is checked without a model.
// In-memory store; never opens houge.sqlite. Five subscription calls on the Tiny role. Build first.
import { loadHougeEnv } from "../dist/config/load-env.js";

loadHougeEnv();
const { RunStore } = await import("../dist/run/run-store.js");
const { oneShotAdapter } = await import("../dist/llm/registry.js");
const { resolveOmpConfig } = await import("../dist/omp/omp-config.js");
const { resolveRole } = await import("../dist/omp/model-roles.js");
const { readOmpCatalog } = await import("../dist/omp/model-catalog.js");
const { tierHeadsOf } = await import("../dist/omp/model-tiers.js");
const { formatModelString } = await import("../dist/omp/model-string.js");
const { finalQuery, rewritePrompt, validateQuery } = await import("../dist/core/lanes/lane-compose.js");
const { queryCheckOf, stripAddress } = await import("../dist/core/lanes/lookup-predicates.js");
const { REWRITE_MS } = await import("../dist/core/lanes/lookup-lane.js");

const NAME = /猴哥|houge/i;
const paco = (text) => ({ role: "user", text });
const CASES = [
  { n: 1, msg: "猴哥, 帮忙找找爱的代价 钢琴典谱", prev: [], want: (q) => !NAME.test(q) && q.includes("爱的代价") && /钢琴/.test(q), why: "keeps 爱的代价 and 钢琴, drops the name" },
  { n: 2, msg: "墨尔本呢，猴哥", prev: [paco("悉尼明天天气怎么样")], want: (q) => !NAME.test(q) && /墨尔本|Melbourne/i.test(q), why: "keeps 墨尔本, drops the name" },
  { n: 3, msg: "猴哥这个称呼在西游记里是怎么来的", prev: [], want: (q) => /猴哥/.test(q), why: "keeps 猴哥: it is the subject" },
  { n: 4, msg: "Houge, please find the release date of Node 26", prev: [], want: (q) => !NAME.test(q) && /node\s*26/i.test(q), why: "keeps Node 26, drops the address" },
  { n: 5, msg: "Sydney weather tomorrow", prev: [], want: (q) => /sydney/i.test(q) && /weather/i.test(q) && q.length <= 60, why: "stays a short query about Sydney weather" }
];

const store = RunStore.openInMemory();
const results = [];
try {
  const base = resolveOmpConfig(process.env);
  const catalog = await readOmpCatalog(base);
  if (catalog === null) throw new Error("omp's catalog could not be read");
  // the Tiny role as the daemon resolves it: the code's legs over the tier heads the live rows held on 2026-11-12
  const tiers = tierHeadsOf([{ tier: "kimi", adopted: "k3.1-pro", previous: "k3" }, { tier: "gemini-flash", adopted: "gemini-3.8-flash", previous: "gemini-2.5-flash" }]);
  const tiny = resolveRole({ role: "tiny", catalog, override: null, refused: new Set(), mode: "resolved", tiers });
  if (tiny.length === 0) throw new Error("the Tiny role resolves to nothing against the live catalog");
  console.log(`tiny chain: ${tiny.map(formatModelString).join(" -> ")}`);
  for (const c of CASES) {
    const t0 = Date.now();
    const seat = oneShotAdapter(store, base, { run_id: `run_gate_rewrite_${c.n}`, role: "lane" }, undefined, { deadlineMs: REWRITE_MS, chain: [...tiny] });
    const r = await seat.answer({ question: rewritePrompt(c.prev, null, c.msg), signal: new AbortController().signal });
    const ms = Date.now() - t0;
    if (!r.ok) { results.push({ n: c.n, state: "INCONCLUSIVE", detail: `the call failed (${ms} ms)` }); continue; }
    if (ms > REWRITE_MS) { results.push({ n: c.n, state: "INCONCLUSIVE", detail: `${ms} ms, past the lane's ${REWRITE_MS} ms bound` }); continue; }
    const query = finalQuery(validateQuery(r.answer, stripAddress(c.msg)));
    const ok = c.want(query);
    results.push({ n: c.n, state: ok ? "PASS" : "FAIL", detail: `${queryCheckOf(r.answer).kind} in ${ms} ms on ${r.provider}/${r.model}: ${JSON.stringify(query)} (want: ${c.why})` });
  }
  const bare = finalQuery(validateQuery("SAME", stripAddress(CASES[0].msg)));
  results.push({ n: 6, state: !NAME.test(bare) && bare.includes("爱的代价") ? "PASS" : "FAIL", detail: `no model: ${JSON.stringify(bare)}` });
} catch (e) {
  results.push({ n: 0, state: "FAIL", detail: `gate error: ${e instanceof Error ? e.message : String(e)}` });
} finally {
  store.close();
}

for (const r of results) console.log(`${r.state.padEnd(12)} ${r.n}  ${r.detail}`);
const bad = results.filter((r) => r.state === "FAIL").length;
const unsure = results.filter((r) => r.state === "INCONCLUSIVE").length;
console.log(bad > 0 ? "LIVE GATE: FAIL" : unsure > 0 ? "LIVE GATE: INCONCLUSIVE" : "LIVE GATE: PASS");
process.exit(bad > 0 ? 1 : unsure > 0 ? 2 : 0);
