#!/usr/bin/env node
// Pre-merge sanity — improve.route on 30 days of rebuilt signal groups plus ten planted groups (2b-ii spec §9.3). From the worktree after
// `npm run build` there:  HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/improve-sanity.mjs [--db <path>] [--days 30] [--keep]
// On a VACUUM copy of the live DB: backfill the inbox from the window's run_failed events, denied/expired approvals and decision outcomes,
// compute recurrence (14-day windows stepped back over the span) and abandonment (daily) with the real embedder, group, build each group's
// ImproveState, and ask decideImprove (rule, real Jev role `improve`, the Tiny pick on the ticks chain) with a capturing recorder (no decision rows).
// PASS needs ALL: every planted group got its intended target, real groups would yield <= 5 proposals a day, no decision fell back.
// Prints the target distribution, the top-p histogram, rule-rung reasons, 20 redacted samples, IMPROVE_BAR and a suggested bar (Paco's sign-off sets it).
// Exit: 0 PASS · 1 FAIL (incl. the planted-token egress self-check) · 2 setup · 3 INCONCLUSIVE (a fallback, embedder down, a failed Tiny pick on a planted miss, no groups).
// Never opens the live DB for writing; every printed excerpt is redacted (redactForImprove) and capped, and the buffer is checked for a planted token first.
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const PROPOSALS_PER_DAY_MAX = 5; const SAMPLES = 20; const EXCERPT = 80; const PACE_MS = 150; const DAY_MS = 86_400_000;
const TOKEN = `sk-${"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"}`; // sk- + 40 letters
const temp = { root: null, keep: false };
const cleanup = () => { if (temp.root && !temp.keep) rmSync(temp.root, { recursive: true, force: true }); else if (temp.root) console.error(`temp dir kept (holds a live-DB copy): ${temp.root}`); temp.root = null; };
const coded = (code) => Object.assign(new Error(code), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = []; const say = (l) => out.push(l);
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const fmt = (m) => [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

function parseArgs(argv) {
  const a = { db: null, days: 30, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") a.db = resolve(argv[++i]); else if (argv[i] === "--days") a.days = Number(argv[++i]);
    else if (argv[i] === "--keep") a.keep = true; else throw coded("BAD_ARGUMENT");
  }
  if (!Number.isFinite(a.days) || a.days <= 0) throw coded("BAD_DAYS");
  if (!DIST.includes("/.worktrees/")) throw coded("NOT_IN_WORKTREE"); // run from the worktree; never build in the main checkout
  return a;
}

async function load() {
  const paths = ["config/load-env.js", "domain/error-code.js", "run/run-store.js", "run/schedule-spec.js", "jev/jev-client.js", "llm/embeddings.js", "llm/registry.js", "skills/skill-store.js",
    "capabilities/wiki.js", "decisions/egress.js", "decisions/outcomes.js", "decisions/entries/improve-route.js", "improve/groups.js", "improve/decide-improve.js", "improve/recurrence.js",
    "improve/abandonment.js", "improve/proposals.js", "improve/schedule-shift.js", "improve/tick.js"];
  return Object.assign({}, ...(await Promise.all(paths.map((p) => import(join(DIST, p))))));
}

function copyDb(from, to) {
  if (resolve(to) === resolve(from) || !resolve(to).startsWith(`${temp.root}/`)) throw coded("COPY_OUTSIDE_TEMP_ROOT");
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/** The copy's store (never the live DB), the redactor and the two model seats, each wrapped so a planted token in a request is counted. */
async function prepare(args) {
  const m = await load(); m.loadHougeEnv();
  if (!(m.IMPROVE_JEV_MS > 0)) throw coded("DIST_STALE_REBUILD");
  if (!process.env.TYPESAFE_API_KEY) throw coded("NO_TYPESAFE_API_KEY");
  const live = args.db ?? resolve(new URL("../houge.sqlite", import.meta.url).pathname);
  temp.root = mkdtempSync("/tmp/hg-improve-sanity-"); const copy = join(temp.root, "houge.sqlite"); copyDb(live, copy);
  const store = m.RunStore.open(copy);
  const redact = (x) => m.redactForImprove(store, x);
  const leaks = { n: 0 };
  const jev = m.createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, audit: store.llmAuditSink({ correlation_id: "improve-sanity", role: "improve" }),
    meteredBreached: () => store.meteredFuseLatched(), retries: 0, timeoutMs: m.IMPROVE_JEV_MS });
  const client = (r) => { if (JSON.stringify(r).includes(TOKEN)) leaks.n++; return jev(r); };
  const tiny = m.tickSeat(store, "improve_pick", "improve_pick", process.env);
  const pickStat = { calls: 0, failed: 0 };
  const pick = async (i) => { if (`${i.question}${i.system}`.includes(TOKEN)) leaks.n++; pickStat.calls++; const r = await tiny(i); if (!r.ok) pickStat.failed++; return r; };
  const cfg = m.resolveEmbedConfig(process.env);
  const embed = (t) => m.embedText(t, cfg);
  const skills = new m.SkillStore({ root: join(dirname(live), "skills") });
  return { m, store, copy, redact, client, pick, pickStat, leaks, embed, cfg, skills, live };
}

/** Inbox backfill on the copy from what the window holds: planner failures and approvals (no producer ran live before this build) and every decision outcome. */
function backfill(c, sinceIso) {
  const { m, store } = c; const n = { planner_failed: 0, approval_denied: 0, approval_expired: 0, mirrored: 0 };
  const ro = new DatabaseSync(c.copy, { readOnly: true });
  try {
    const fails = ro.prepare(`SELECT e.run_id, e.occurred_at, json_extract(e.payload_json, '$.error_type') AS et, json_extract(r.notify_json, '$.chat_id') AS chat_id
      FROM ledger_events e JOIN runs r ON r.run_id = e.run_id WHERE e.event_type = 'run_failed' AND r.source = 'telegram' AND e.occurred_at > ?
      AND EXISTS (SELECT 1 FROM ledger_events w WHERE w.run_id = e.run_id AND w.event_type = 'worker_lease_acquired' AND json_extract(w.payload_json, '$.worker_id') LIKE 'planner:%')`).all(sinceIso);
    for (const f of fails) {
      const value = m.PLANNER_FAILED_VALUES.includes(f.et) ? f.et : "other";
      n.planner_failed += store.insertImproveSignal({ signal: "planner_failed", value, run_id: f.run_id, chat_id: f.chat_id, about_run_id: f.run_id, source_outcome_id: `pf:${f.run_id}`, created_at: f.occurred_at }) > 0 ? 1 : 0;
    }
    const appr = ro.prepare(`SELECT a.approval_id, a.run_id, a.capability, a.state, a.resolved_at, r.source, json_extract(r.notify_json, '$.chat_id') AS chat_id
      FROM tool_approvals a JOIN runs r ON r.run_id = a.run_id WHERE a.state IN ('denied', 'expired') AND a.resolved_at > ?`).all(sinceIso);
    for (const a of appr) {
      if (!m.APPROVAL_CAPABILITY.test(a.capability) || (a.state === "denied" && a.source === "schedule")) continue;
      const signal = a.state === "denied" ? "approval_denied" : "approval_expired";
      n[signal] += store.insertImproveSignal({ signal, value: a.capability, run_id: a.run_id, chat_id: a.chat_id, about_run_id: a.run_id,
        source_outcome_id: `${a.state === "denied" ? "deny" : "exp"}:${a.approval_id}`, created_at: a.resolved_at }) > 0 ? 1 : 0;
    }
  } finally { ro.close(); }
  store.setImproveCursorForTest({ outcome_created_at: "", outcome_rowid: 0 }); // the copy only: re-mirror every outcome
  for (let r = store.mirrorOutcomesIntoInbox(1000); r.read > 0; r = store.mirrorOutcomesIntoInbox(1000)) n.mirrored += r.copied;
  return n;
}

/** Recurrence over disjoint 14-day windows back across the span; abandonment day by day; both with the real embedder (rows land in the copy only). */
async function produce(c, args, now0) {
  const { m, store } = c; const ac = new AbortController(); const clusters = new Map(); let embedUnavailable = 0; let abandoned = 0; let recorded = 0;
  for (let k = 0; k * 14 < args.days; k++) {
    const now = new Date(now0 - k * 14 * DAY_MS).toISOString();
    const rec = await m.computeRecurrence({ store, env: process.env, now, embed: c.embed, embedModel: c.cfg.model, signal: ac.signal });
    embedUnavailable += rec.embedUnavailable;
    for (const [key, v] of rec.clusters) clusters.set(key, v);
    recorded += m.recordRecurrenceSignals(store, rec.clusters, now);
  }
  for (let d = Math.ceil(args.days) - 1; d >= 0 && embedUnavailable === 0; d--) {
    abandoned += await m.computeAbandonment({ store, now: new Date(now0 - d * DAY_MS).toISOString(), gate: m.resolveRecurrenceGate(process.env), embed: c.embed, embedModel: c.cfg.model, signal: ac.signal });
  }
  return { clusters, embedUnavailable, abandoned, recorded };
}

/** Ten synthetic groups, each with its intended target (every text is invented; the first carries a planted token that the redactor must remove). */
function plantedGroups(c) {
  const { m, redact } = c; const cap = (t) => Array.from(redact(t)).slice(0, m.PACO_TEXT_CAP).join("");
  const mk = (over, text) => { const pacoText = cap(text); return { signal: "correction", value: "answer", scope: "answer", count: 1, count14d: 1, category: "answer", lane: "answer", capability: null, pacoText,
    toolSummary: "none", lastImprovement: null, recurrence: null, alreadyAuthored: false, skillExists: false, wikiArmed: m.resolveWikiEnabled(process.env), scheduleHint: null,
    stale: false, statedRuleSaved: false, ...over, redacted: { pacoText } }; };
  const rec = (name, text, extra = {}) => mk({ signal: "recurrence", value: "3", scope: `rec:rec_planted_${name}`, category: "machine_task", lane: null, ...extra,
    recurrence: { clusterId: `rec_planted_${name}`, turnIds: ["t1", "t2", "t3"], idempotencyKey: `machine_task:${name}`, spanDays: 6 } }, text);
  return [
    ["lesson", "lesson", mk({}, `Stop opening your replies with an apology, start with the answer. (key ${TOKEN})`)],
    ["fact", "fact", mk({ category: "memory", lane: "memory", scope: "memory", value: "memory" }, "No, my daughter's school is Maple Grove Elementary and pickup is at 3:15, not 4.")],
    ["recurrence cluster", "skill", rec("a", "Summarise the pull requests closed this week into a short changelog, same format as last Friday.")],
    ["expiry pattern", "schedule", mk({ signal: "approval_expired", value: "shell_exec", scope: "shell_exec", count: 2, count14d: 3, category: null, lane: "planner", capability: "shell_exec", scheduleHint: { schedule_id: "sched_planted", hour: 9 } }, "The morning digest run asked to approve a command and nobody answered in time.")],
    ["tool gap", "tool_gap", mk({ signal: "planner_failed", value: "planner_exit", scope: "planner_exit", count: 3, count14d: 3, category: "machine_task", lane: "planner", toolSummary: "none" }, "Pull the attached PDF's tables into a spreadsheet and email it to me.")],
    ["review_bad x3 on turn.settle", "ladder", mk({ signal: "review_bad", value: "turn.settle", scope: "turn.settle", count: 3, count14d: 3, category: null, lane: null }, "That reply claimed it was done and it was not.")],
    ["stated rule saved", "nothing", mk({ statedRuleSaved: true }, "From now on always answer in British English.")],
    ["stale row", "nothing", mk({ stale: true }, "Please keep the replies shorter.")],
    ["inapplicable-top bait", "nothing", mk({ category: "schedule", lane: "planner", scope: "schedule", value: "schedule" }, "Move my morning briefing to 8am instead of 7.")],
    // a leak probe, not a target check (intended null): vague on purpose so it tends to fall below the bar and reach the Tiny pick with the planted token in its text
    ["below-bar probe (token)", null, mk({}, `Something about that answer was a bit off, or maybe fine, not sure it needs a change. (ref ${TOKEN})`)],
    ["recurrence naming a skill", "nothing", rec("b", "Run the weekly-report skill again for this week's numbers.", { skillExists: true })]
  ];
}

/** One decision, no write (the capturing recorder), with the Tiny pick's failure noted per decision. */
async function decideOne(c, s, run_id) {
  const rec = c.m.deferredRecorder(); const before = c.pickStat.failed; const calls = c.pickStat.calls;
  const r = await c.m.decideImprove({ store: c.store, env: process.env, client: c.client, pick: c.pick, now: () => new Date().toISOString() }, s, rec.recorder, run_id);
  await sleep(PACE_MS);
  return { r, pickFailed: c.pickStat.failed > before, pickCalled: c.pickStat.calls > calls };
}

async function scorePlanted(c) {
  const res = [];
  for (const [name, intended, s] of plantedGroups(c)) { const { r, pickFailed, pickCalled } = await decideOne(c, s, null); res.push({ name, intended, r, pickFailed, pickCalled, text: s.redacted.pacoText }); }
  return res;
}

/** Evidence and a draft preview, redacted and capped; distill is stubbed (a lesson/fact draft is a subscription call at proposal time, so the preview is Paco's redacted words). */
async function previewOf(c, g, s, r, tz) {
  const evidence = c.m.evidenceOf(g, s, tz);
  const none = async () => ({ ok: false });
  const d = await c.m.draftFor(r.verdict, g, s, { store: c.store, env: process.env, now: new Date().toISOString(), tz, distill: none, redact: c.redact, scheduleHints: new Map() });
  const raw = d ? d.draft_json : s.redacted.pacoText.trim() ? `(distill) ${s.redacted.pacoText}` : "";
  return { evidence, draft: Array.from(c.redact(raw).replace(/\s+/g, " ")).slice(0, EXCERPT).join(""), hasDraft: d !== null || s.redacted.pacoText.trim().length > 0 };
}

async function scoreReal(c, args, now0, produced) {
  const { m, store } = c; const tz = m.resolveDisplayZone(process.env); const nowIso = new Date(now0).toISOString();
  const since = new Date(now0 - args.days * DAY_MS - 1000).toISOString();
  const staleBefore = new Date(now0 - m.IMPROVE_STALE_DAYS * DAY_MS).toISOString();
  const rows = store.listImproveSignalsSince(since);
  const groups = m.groupSignals(rows, (id) => store.getJevVerdictForRun(id), produced.clusters, staleBefore);
  const hints = m.scheduleHints(store, nowIso, tz);
  const since14 = store.listImproveSignalsSince(new Date(now0 - 14 * DAY_MS).toISOString());
  const r = { rows: rows.length, groups: groups.length, byTarget: new Map(), byRule: new Map(), byRung: new Map(), byFb: new Map(), hist: new Array(10).fill(0), withP: 0, proposals: [], lost: 0, byFamily: new Map(), pickFailed: 0, failRung: 0, jobs: 0 };
  for (const g of groups) {
    const s = m.buildImproveState(g, { store, env: process.env, now: nowIso, skills: c.skills, redact: c.redact, scheduleHints: hints, since14 });
    const { r: d, pickFailed } = await decideOne(c, s, g.newest.about_run_id ?? g.newest.run_id);
    if (pickFailed) r.pickFailed++;
    if (d.rung === "fail") r.failRung++;
    bump(r.byFamily, g.signal); bump(r.byTarget, d.verdict); bump(r.byRung, `${d.rung}/${d.reason ?? "-"}`);
    if (d.rung === "rule") bump(r.byRule, d.reason ?? "-");
    if (d.fallbackReason) { bump(r.byFb, d.fallbackReason); r.lost++; }
    if (d.detail?.p !== undefined) { r.hist[Math.min(9, Math.floor(d.detail.p * 10))]++; r.withP++; }
    if (d.rung === "rule" && d.verdict === "skill") r.jobs++; // a rule-rung skill starts a job, not a proposal
    else if (d.verdict !== "nothing" && d.verdict !== "knowledge") {
      const p = await previewOf(c, g, s, d, tz);
      if (p.hasDraft) r.proposals.push({ verdict: d.verdict, scope: s.scope, rung: d.rung, ...p });
    }
  }
  return r;
}

function printReal(c, r, args) {
  say(`window ${args.days}d: ${r.rows} inbox rows -> ${r.groups} groups; by signal: ${fmt(r.byFamily)}`);
  say(`target distribution (real groups): ${fmt(r.byTarget)}`);
  say(`by rung/reason: ${fmt(r.byRung)}`);
  say(`rule-rung counts by reason: ${fmt(r.byRule)}`);
  say(`top-p histogram (${r.withP} groups that reached Jev):`);
  r.hist.forEach((n, i) => say(`  ${(i / 10).toFixed(1)}-${i === 9 ? "1.0" : ((i + 1) / 10).toFixed(1)} ${"#".repeat(n)} ${n}`));
  const perDay = r.proposals.length / args.days;
  say(`proposals it would have made: ${r.proposals.length} (${perDay.toFixed(2)}/day, bar <= ${PROPOSALS_PER_DAY_MAX}/day; an upper bound: a lesson/fact draft that distill rejects is not made; ${r.jobs} rule-rung skill job(s) not counted)`);
  say(`real groups: ${r.failRung} decided on rung fail (all rungs abstained), ${r.pickFailed} failed Tiny pick(s)`);
  const step = Math.max(1, Math.floor(r.proposals.length / SAMPLES));
  say(`${Math.min(SAMPLES, r.proposals.length)} sampled proposals (target · scope · evidence · draft<=${EXCERPT}, redacted):`);
  r.proposals.filter((_, i) => i % step === 0).slice(0, SAMPLES).forEach((p) => say(`  ${p.verdict} (${p.rung}) · ${c.redact(p.scope)} · ${c.redact(p.evidence)} · ${p.draft}`));
  say(`fallbacks (real groups): ${fmt(r.byFb)}`);
  return perDay;
}

function printPlanted(c, planted) {
  let miss = 0; let unsure = 0; let winP = [];
  say(`planted groups: intended target vs got`);
  for (const p of planted) {
    if (p.intended === null) { say(`  probe  ${p.name}: got ${p.r.verdict} (${p.r.rung}/${p.r.reason ?? "-"}); reached the Tiny pick: ${p.r.reason === "tiny_pick" || p.pickCalled ? "yes" : "no"}`); continue; }
    const ok = p.r.verdict === p.intended; if (!ok) miss++;
    if (ok && (p.r.rung === "fail" || p.pickFailed)) { unsure++; }
    const pp = p.r.detail?.p ?? p.r.p;
    if (ok && p.r.reason === "jev_choice" && pp !== undefined) winP.push(pp);
    say(`  ${ok ? "ok    " : "MISSED"} ${p.name}: want ${p.intended}, got ${p.r.verdict} (${p.r.rung}/${p.r.reason ?? "-"}) p=${pp === undefined ? "n/a" : pp.toFixed(3)}${p.r.fallbackReason ? ` fallback=${p.r.fallbackReason}` : ""}${p.pickFailed ? " tiny_pick_failed" : ""}`);
  }
  const suggested = winP.length ? Math.max(0.5, Math.round((Math.min(...winP) - 0.05) * 100) / 100) : null;
  say(`IMPROVE_BAR p=${c.m.IMPROVE_BAR.p}; suggested bar: ${suggested === null ? "none (no planted answer was a jev_choice win; keep the provisional bar)" : `${suggested} (lowest planted jev_choice p ${Math.min(...winP).toFixed(3)} - 0.05, floored at 0.5)`}. Paco's sign-off sets it (R8).`);
  return { miss, unsure };
}

async function main() {
  const args = parseArgs(process.argv.slice(2)); temp.keep = args.keep;
  const c = await prepare(args); const now0 = Date.now();
  const bf = backfill(c, new Date(now0 - args.days * DAY_MS).toISOString());
  say(`backfill on the copy: planner_failed ${bf.planner_failed}, approval_denied ${bf.approval_denied}, approval_expired ${bf.approval_expired}, mirrored outcomes ${bf.mirrored}`);
  const produced = await produce(c, args, now0);
  say(`producers: recurrence rows ${produced.recorded} (${produced.clusters.size} clusters), abandonment rows ${produced.abandoned}, embedder unavailable ${produced.embedUnavailable} turn(s)`);
  const real = await scoreReal(c, args, now0, produced); const perDay = printReal(c, real, args);
  const planted = await scorePlanted(c); const { miss, unsure } = printPlanted(c, planted);
  say(`tiny pick calls ${c.pickStat.calls}, failed ${c.pickStat.failed}`);
  const plantedFb = planted.filter((p) => p.r.fallbackReason).length;
  if (planted.some((p) => p.intended === null && p.r.rung === "fail")) say("probe decided on rung fail");
  const missWithPickFailure = planted.some((p) => p.intended !== null && p.r.verdict !== p.intended && p.pickFailed);
  const reasons = [];
  if (produced.embedUnavailable > 0) reasons.push(`embedder unavailable for ${produced.embedUnavailable} turn(s) (recurrence and abandonment skipped)`);
  if (real.lost + plantedFb > 0) reasons.push(`${real.lost + plantedFb} decision(s) fell back (any fallbackReason)`);
  if (unsure > 0) reasons.push(`${unsure} planted hit(s) decided on rung fail or after a failed Tiny pick (not a real hit)`);
  if (real.failRung + real.pickFailed > 0) reasons.push(`real groups: ${real.failRung} on rung fail, ${real.pickFailed} failed Tiny pick(s)`);
  if (missWithPickFailure) reasons.push("a planted miss coincides with a failed Tiny pick");
  if (real.groups === 0) reasons.push("no real groups in the window");
  const rateOver = perDay > PROPOSALS_PER_DAY_MAX;
  const verdict = c.leaks.n > 0 ? "FAIL" : reasons.length ? "INCONCLUSIVE" : miss === 0 && !rateOver ? "PASS" : "FAIL";
  say(`${verdict}${verdict === "INCONCLUSIVE" ? ` — ${reasons.join("; ")}` : verdict === "FAIL" ? ` — ${[miss ? `${miss} planted missed` : "", rateOver ? "proposal rate over the bar" : "", c.leaks.n ? "planted token reached a request" : ""].filter(Boolean).join("; ")}` : ""}`);
  c.store.close?.();
  if (c.leaks.n > 0 || out.join("\n").includes(TOKEN)) { console.error("FAIL: the planted token reached a Jev/Tiny request or the output buffer; nothing printed"); return 1; }
  console.log(out.join("\n"));
  return verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 3;
}

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(sig, () => { cleanup(); process.exit(code); });
main().then((code) => { cleanup(); process.exit(code); }, async (e) => { const code = await import(join(DIST, "domain/error-code.js")).then((m) => m.errorCode(e), () => "unknown"); console.error(`setup error: ${code}`); cleanup(); process.exit(2); });
