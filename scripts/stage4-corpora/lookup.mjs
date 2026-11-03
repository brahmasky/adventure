// Slice R6 differential, lookup corpus (spec 2026-11-03 R6 §6). Pair: r6 (the merge-base build b0da208a) -> new. Every item drives the dist's own runLookupLane
// (scripts/stage4-lane-fixture.mjs: scripted rewrite/search/read/fetch/previousTelegramTurns, a fixed clock, nothing leaves the process), each item fresh on both sides.
// Both sides get the same recording recorder (the old lane already consults tool.wall / reader.family through it). Compared: the scripted deps' ordered call log
// (rewrite prompts, search queries, read objectives and outputs, fetch URLs, ledger calls, compose prompts, the non-R6 recorder calls in order), the lane's result
// object, and the recorder's calls minus R6_IDS. REQUIRED on the new side: the exact R6 calls [entry, rung, verdict, reason, run, tool_call], every recorder call's
// entry id in order (so the per-entry counts and the position of the R6 rows are exact), that the R6 rows are a SUFFIX of the ordered log (written at the lane's
// end, after every dep call: spec §4.0), and the behaviour facts (queries searched, fetches, rewrite and read counts, the result). The old build must record no R6 row.
import { DISTS, R6_IDS, canon, compare, requireNew } from "../stage4-diff-lib.mjs";
import { LANE_HIT, LANE_T0, laneRead, laneSearchOk, laneTurn, runLane } from "../stage4-lane-fixture.mjs";
import { join } from "node:path";

const R6 = new Set(R6_IDS);
const RESERVE = 15_000; // COMPOSE_RESERVE_MS
const RW = "lookup.rewrite"; const TH = "lookup.thin"; const WALL = "tool.wall"; const FAM = "reader.family";
const BARE = "what is the weather in Sydney tomorrow?"; // the lane fixture's default userText
const row = (entry, verdict, reason, rung = "rule") => [entry, rung, verdict, reason, "run_1", null];
const recent = (text = "look it up") => ({ previousTelegramTurns: () => [laneTurn(text, 5)] });
const answers = (text) => async () => ({ ok: true, provider: "kimi-code", model: "k3", answer: text });
const AGAIN = { userText: "check again" }; // short: the filter wants a rewrite once a recent line exists
/** The first read comes back thin (no answer_to_objective), the second answers. */
const thinThenAnswer = () => { let n = 0; return async () => (n++ === 0 ? laneRead(null) : laneRead("Sunny, 22C")); };
const fetches = [LANE_HIT.url];

/** The real entry's rule replaced for the drive, restored in the drive's own finally (the entry object is process-global; R5 P14). */
async function planted(d, file, name, drive) {
  let mod = null;
  try { mod = await import(join(d.dir, "decisions", "entries", file)); } catch (e) { if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e; }
  const rung = mod?.[name]?.ladder[0];
  if (d.dir === DISTS.new && !rung) throw new Error(`fault item: ${name} missing from the new dist`);
  const orig = rung?.decide;
  if (rung) rung.decide = () => { throw new Error("planted"); };
  try { return await drive(); } finally { if (rung) rung.decide = orig; }
}

// `make` builds a fresh script per run (abort controllers, counters). `settle`: ms to wait after the lane returned, so a late answer has its chance to be (wrongly) used.
const killer = () => new AbortController();
const ITEMS = [
  { key: "rewrite_no_recent_line", tags: ["no_recent_line"], make: () => ({ script: {} }),
    rows: [row(RW, "bare", "no_recent_line"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 0, searches: [BARE], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_long_message", tags: ["long_message"], make: () => ({ script: { ...recent(), input: { userText: "a".repeat(41) } } }),
    rows: [row(RW, "bare", "long_message"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 0, searches: ["a".repeat(41)], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_quoted_rewritten", tags: ["rewritten"], make: () => ({ script: { ...recent(), rewrite: answers("Sydney weather tomorrow"),
      input: { userText: "a".repeat(41), quoted: { role: "houge", kind: "answer", age_s: 300, text: "earlier" } } } }),
    rows: [row(RW, "rewrite", "rewritten"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["Sydney weather tomorrow"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_same", tags: ["same"], make: () => ({ script: { ...recent(), rewrite: answers("SAME"), input: AGAIN } }),
    rows: [row(RW, "bare", "same"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["check again"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_same_cjk_stop", tags: ["same_cjk"], make: () => ({ script: { ...recent(), rewrite: answers("same。"), input: AGAIN } }),
    rows: [row(RW, "bare", "same"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["check again"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_two_lines", tags: ["invalid"], make: () => ({ script: { ...recent(), rewrite: answers("a\nb"), input: AGAIN } }),
    rows: [row(RW, "bare", "invalid"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["check again"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_url", tags: ["invalid_url"], make: () => ({ script: { ...recent(), rewrite: answers("https://example.test/forecast"), input: AGAIN } }),
    rows: [row(RW, "bare", "invalid"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["check again"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  // the bound is 40 ms of real time (the clock is fixed, so the deadline minus the reserve stays 40); the late answer lands at 120 ms and must never be searched
  { key: "rewrite_late", tags: ["late"], settle: 250, make: () => ({ script: { ...recent(), input: { ...AGAIN, deadlineAt: LANE_T0 + RESERVE + 40 },
      rewrite: () => new Promise((r) => { setTimeout(() => r({ ok: true, provider: "kimi-code", model: "k3", answer: "late query" }), 120); }) } }),
    rows: [row(RW, "bare", "late"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["check again"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_throws", tags: ["failed"], make: () => ({ script: { ...recent(), input: AGAIN, rewrite: async () => { throw new Error("tiny down"); } } }),
    rows: [row(RW, "bare", "failed"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["check again"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_not_ok", tags: ["failed_ok_false"], make: () => ({ script: { ...recent(), input: AGAIN, rewrite: async () => ({ ok: false, provider: "omp", error: "all lane legs failed" }) } }),
    rows: [row(RW, "bare", "failed"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["check again"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "rewrite_reserve_reached", tags: ["no_time"], make: () => ({ script: { ...recent(), input: { ...AGAIN, deadlineAt: LANE_T0 + RESERVE } } }),
    rows: [row(RW, "bare", "no_time")], ids: [RW],
    facts: { rewrites: 0, searches: [], reads: 0, fetches: [], result: "fallthrough:lane_timeout", laneThrew: 0 } },
  { key: "rewrite_killed_while_held", tags: ["kill_rewrite"], make: () => { const ctl = killer();
      return { script: { ...recent(), signal: ctl.signal, input: AGAIN, rewrite: async () => { ctl.abort(); return new Promise(() => undefined); } } }; },
    rows: [], ids: [],
    facts: { rewrites: 1, searches: [], reads: 0, fetches: [], result: "fallthrough:aborted", laneThrew: 0 } },
  { key: "thin_answered_no_fetch", tags: ["answered"], make: () => ({ script: { ...recent(), rewrite: answers("SAME"), input: AGAIN, read: async () => laneRead("Sunny, 22C") } }),
    rows: [row(RW, "bare", "same"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["check again"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "thin_fetches", tags: ["thin"], make: () => ({ script: { read: thinThenAnswer() } }),
    rows: [row(RW, "bare", "no_recent_line"), row(TH, "fetch", "thin")], ids: [WALL, FAM, WALL, FAM, RW, TH],
    facts: { rewrites: 0, searches: [BARE], reads: 2, fetches, result: "reply", laneThrew: 0 } },
  { key: "thin_no_listable_url", tags: ["no_url"], make: () => ({ script: { read: async () => laneRead(null), search: async () => laneSearchOk([{ ...LANE_HIT, url: "ftp://example.test/x" }]) } }),
    rows: [row(RW, "bare", "no_recent_line"), row(TH, "none", "no_url")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 0, searches: [BARE], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  // the first (thin) read moves the fixed clock to 1 s past the fetch's last start (deadline − reserve): the row is still `fetch/thin` (the decision), the fetch is not made (execution)
  { key: "thin_no_time_for_fetch", tags: ["thin_no_time"], make: () => ({ script: { read: async () => laneRead(null), advance: (clock, v) => { if (v?.ok && v.extraction?.answer_to_objective === null) clock.t += 61_000; } } }),
    rows: [row(RW, "bare", "no_recent_line"), row(TH, "fetch", "thin")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 0, searches: [BARE], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "thin_first_read_failed", tags: ["read_failed"], make: () => ({ script: { read: async () => ({ ok: false, why: "unreadable" }) } }),
    rows: [row(RW, "bare", "no_recent_line")], ids: [WALL, FAM, RW],
    facts: { rewrites: 0, searches: [BARE], reads: 1, fetches: [], result: "fallthrough:reader_failed", laneThrew: 0 } },
  { key: "thin_killed_during_first_read", tags: ["kill_read"], make: () => { const ctl = killer();
      return { script: { signal: ctl.signal, read: async () => { ctl.abort(); return laneRead("Sunny, 22C"); } } }; },
    rows: [], ids: [],
    facts: { rewrites: 0, searches: [BARE], reads: 1, fetches: [], result: "fallthrough:aborted", laneThrew: 0 } },
  // spec §4.0: a recorder that moves the clock past the reserve ONLY on R6 calls, over a path whose fetch starts 1 s inside the reserve: the fetch happens, the rows come after the compose
  { key: "write_timing_r6_calls_slow", tags: ["timing"], slow: true, make: () => ({ script: { read: thinThenAnswer(), input: { deadlineAt: LANE_T0 + RESERVE + 1_000 } } }),
    rows: [row(RW, "bare", "no_recent_line"), row(TH, "fetch", "thin")], ids: [WALL, FAM, WALL, FAM, RW, TH],
    facts: { rewrites: 0, searches: [BARE], reads: 2, fetches, result: "reply", laneThrew: 0 } },
  { key: "step_after_rewrite_throws", tags: ["threw"], make: () => ({ script: { search: async () => { throw new Error("boom"); } } }),
    rows: [row(RW, "bare", "no_recent_line")], ids: [RW],
    facts: { rewrites: 0, searches: [BARE], reads: 0, fetches: [], result: "fallthrough:lane_threw", laneThrew: 1 } },
  { key: "fault_rewrite_rule", tags: ["fault_rewrite"], plant: ["lookup-rewrite.js", "LOOKUP_REWRITE"], make: () => ({ script: { ...recent(), input: AGAIN, rewrite: answers("Sydney weather tomorrow") } }),
    rows: [row(RW, "bare", null, "fail"), row(TH, "none", "answered")], ids: [WALL, FAM, RW, TH],
    facts: { rewrites: 1, searches: ["Sydney weather tomorrow"], reads: 1, fetches: [], result: "reply", laneThrew: 0 } },
  { key: "fault_thin_rule", tags: ["fault_thin"], plant: ["lookup-thin.js", "LOOKUP_THIN"], make: () => ({ script: { read: thinThenAnswer() } }),
    rows: [row(RW, "bare", "no_recent_line"), row(TH, "none", null, "fail")], ids: [WALL, FAM, WALL, FAM, RW, TH],
    facts: { rewrites: 0, searches: [BARE], reads: 2, fetches, result: "reply", laneThrew: 0 } }
];
const BRANCHES = ITEMS.map((i) => i.tags[0]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const orderOf = (log) => log.map((e) => (e[0] === "record" ? e[1] : e[0]));

async function project(d, item) {
  const calls = []; const errs = []; const realErr = console.error;
  console.error = (...a) => { errs.push(a.join(" ")); }; // the lane logs lane_threw and a planted rule's throw; neither is output of the corpus
  try {
    const { script } = item.make();
    const slow = item.slow === true;
    const recorder = (clock, log) => ({ record: (entry, r, ctx) => {
      calls.push([entry.id, r.rung, r.verdict, r.reason ?? null, ctx.run_id, ctx.tool_call_id ?? null]); log.push(["record", entry.id]);
      if (slow && R6.has(entry.id)) clock.t += RESERVE + 1; // only the R6 entries' calls are slow
      return null;
    } });
    const run = () => runLane(d, { ...script, recorder });
    const { result, log } = await (item.plant ? planted(d, item.plant[0], item.plant[1], run) : run());
    if (item.settle) await wait(item.settle);
    const isR6 = (e) => e[0] === "record" && R6.has(e[1]);
    const r6calls = calls.filter((c) => R6.has(c[0]));
    const first = log.findIndex(isR6);
    const suffix = first === -1 ? r6calls.length === 0 : log.slice(first).every(isR6) && log.slice(first).length === r6calls.length;
    const facts = { rewrites: log.filter((e) => e[0] === "rewrite").length, searches: log.filter((e) => e[0] === "search").map((e) => e[1]), reads: log.filter((e) => e[0] === "read").length,
      fetches: log.filter((e) => e[0] === "fetch").map((e) => e[1]), result: result.kind === "reply" ? "reply" : `fallthrough:${result.why}`,
      laneThrew: errs.filter((m) => m.startsWith("lookup lane: threw")).length };
    return { log: log.filter((e) => !isR6(e)), result, calls: calls.filter((c) => !R6.has(c[0])), r6: r6calls, ids: calls.map((c) => c[0]), suffix, order: orderOf(log), facts, __strip: ["r6", "ids", "suffix", "order", "facts"] };
  } finally { console.error = realErr; }
}

function required(d, item, proj) {
  requireNew(corpus, item, "R6 calls (exact: entry, rung, verdict, reason, run, tool_call)", canon(proj.r6) === canon(item.rows), `got ${canon(proj.r6)}, want ${canon(item.rows)}`);
  requireNew(corpus, item, "every recorder call's entry id, in order (exact per-entry counts and the R6 position)", canon(proj.ids) === canon(item.ids), `got ${canon(proj.ids)}, want ${canon(item.ids)}`);
  requireNew(corpus, item, "the R6 rows are the log's suffix (written at the lane's end, after every dep call: spec §4.0)", proj.suffix === true, `order ${canon(proj.order)}`);
  requireNew(corpus, item, "behaviour facts (queries searched, rewrite and read counts, fetches, result: exact)", canon(proj.facts) === canon(item.facts), `got ${canon(proj.facts)}, want ${canon(item.facts)}`);
}

// the old build must record no R6 row: its calls are the compared non-R6 ones, so a stray R6 id there would already differ; this guards the projection's own split
function controlOld(d, proj) { if (d.dir !== DISTS.new && proj.r6.length) throw new Error("control failed: the old build recorded an R6 lookup row"); }

async function projectChecked(d, item) { const p = await project(d, item); controlOld(d, p); return p; }

// Determinism self-test: the same item twice on the new build must project identically, or the old/new comparison would flag its own noise.
async function load(ctx) {
  const first = ITEMS.find((i) => i.key === "thin_fetches");
  const [a, b] = [await projectChecked(ctx.dists.new, first), await projectChecked(ctx.dists.new, first)];
  const diff = compare(corpus, first, a, b, corpus.pairs[0]);
  if (diff) throw new Error(`determinism self-test: two runs of one item project differently: ${diff.diff}`);
  return ITEMS;
}

const corpus = { name: "lookup", pairs: [["r6", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project: projectChecked, required };
export default corpus;
