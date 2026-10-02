// Live gate for memory A1 (spec docs/superpowers/specs/2026-10-02-memory-a1-fixes-design.md, "Live gate").
// Runs on a TEMP COPY of the live DB (VACUUM INTO, under resolveDaemonTmpDir()/memory-a1) with the migration applied to
// the copy, the real ticks seat (omp, profile `houge`) and the real Ollama embedder. The live DB is only read.
//
//   HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-memory-a1.mjs [--db <path>] [--plan <path>] [--probes <path>] [--keep]
//   HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-memory-a1.mjs --post --since <ISO> [--forbidden-ending <regex>] [--data-dir <dir>]
//     (the --post run is after the live --apply and Paco's kickstart + one real turn; it opens the live DB read-only)
//
// Files (both untracked, local only: the repo is PUBLIC, probes are personal text):
//   plan   default <dir of HOUGE_ENV_FILE>/.superpowers/memory-a1/plan.json   (the migration plan, Task 9 schema)
//   probes default <dir of HOUGE_ENV_FILE>/.superpowers/memory-a1/probes.json
// probes.json schema:
//   { "probes": [ { "message": string, "expect_facts": number[], "expect_pages": number[] }, ... ],   // >= 12 entries
//     "window_149":       { "from": ISO, "to": ISO, "forbidden"?: string },  // window that minted fact #149 (user only ASKED);
//                                                                            // `forbidden` = regex source of the asked-only attribute
//     "assertion_window": { "from": ISO, "to": ISO } }                       // window holding a real first-person assertion
//   An entry with empty expect_facts AND empty expect_pages is a NEGATIVE probe: it must get zero fact rows and zero page
//   rows. Positive expect ids must not be core facts (the gate drops core ids like the live path). Needs >= 1 negative,
//   >= 1 positive and >= 2 positive facts that are not among the chat's newest 50 active facts.
//
// Checks (PASS only if all hold):
//   1 the rendered omp prompt holds every active ask + research lesson, themed, under the cap, with no lesson_dropped row;
//   2 every negative probe gets zero facts and pages (Ollama up AND down); every positive gets its expected ids (Ollama up;
//     positives are only printed in the down run); the down run must report fts_only and no embedding; an all-empty
//     retrieval run (no probe returned any row) FAILs; each probe's best admitted / best rejected cosine is printed;
//   3 per ticks leg, 3 runs: window_149 yields no fact matching `forbidden` (no regex: printed for the eye), the assertion
//     window yields at least one fact whose evidence passes; a leg that never answers FAILs, as does zero facts overall;
//     the evidence rejection rate is printed (it decides shadow -> enforce);
//   4 an UPDATE whose merge exceeds 240 chars is refused and the prior lesson is untouched;
//   5 (--post) a planner_session_reset row since the kickstart, the chat's system prompt lists the themed lessons, and the
//     last reply does not end with the old sign-off (--forbidden-ending; absent: printed for the eye). Whether the reply
//     carries the thread is printed and judged by eye.
// Prompts and facts are printed to this console only (they are personal): never paste them into a committed file.
// Exit: 0 PASS · 1 FAIL · 2 setup error. Build first (imports ../dist).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const FLAGS = { "--db": "db", "--plan": "plan", "--probes": "probes", "--since": "since", "--forbidden-ending": "forbiddenEnding", "--data-dir": "dataDir" };

function parseArgs(argv) {
  const args = { keep: false, post: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--post") args.post = true;
    else if (FLAGS[argv[i]]) {
      args[FLAGS[argv[i]]] = argv[++i];
      if (args[FLAGS[argv[i - 1]]] === undefined) throw new Error(`${argv[i - 1]} needs a value`);
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

async function loadModules() {
  const [env, mig, turn, render, ret, wiki, ev, ex, reg, cfg, ms, emb, rs, tmp, arm] = await Promise.all([
    import("../dist/config/load-env.js"), import("../dist/run/memory-a1-migration.js"), import("../dist/omp/turn-context.js"),
    import("../dist/run/lesson-render.js"), import("../dist/run/episodic-retrieval.js"), import("../dist/run/wiki-retrieval.js"),
    import("../dist/capabilities/episodic-evidence.js"), import("../dist/capabilities/episodic-extract.js"),
    import("../dist/llm/registry.js"), import("../dist/omp/omp-config.js"), import("../dist/omp/model-string.js"),
    import("../dist/llm/embeddings.js"), import("../dist/run/run-store.js"), import("../dist/run/daemon-tmp.js"),
    import("../dist/capabilities/wiki.js")
  ]);
  return { env, mig, turn, render, ret, wiki, ev, ex, reg, cfg, ms, emb, rs, tmp, arm };
}

const ids = (v) => Array.isArray(v) && v.every((x) => Number.isInteger(x) && x > 0);
const isoWindow = (w) => typeof w?.from === "string" && typeof w?.to === "string" && !Number.isNaN(Date.parse(w.from)) && !Number.isNaN(Date.parse(w.to));

/** Setup validation: a malformed probe file is exit 2, never a quiet pass. */
function validateProbes(raw) {
  const r = raw?.probes;
  if (!Array.isArray(r) || r.length < 12) throw new Error("probes: need at least 12 entries");
  if (!r.every((x) => typeof x?.message === "string" && x.message.trim() !== "" && ids(x.expect_facts) && ids(x.expect_pages))) {
    throw new Error("probes: each entry is { message: string, expect_facts: number[], expect_pages: number[] }");
  }
  const neg = (x) => x.expect_facts.length === 0 && x.expect_pages.length === 0;
  if (!r.some(neg) || !r.some((x) => !neg(x))) throw new Error("probes: need at least one negative and one positive");
  if (!isoWindow(raw.window_149) || !isoWindow(raw.assertion_window)) throw new Error("window_149 / assertion_window: { from, to } ISO strings");
  if (raw.window_149.forbidden !== undefined) new RegExp(raw.window_149.forbidden, "i"); // throws on a bad regex
  return raw;
}

function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.prepare("VACUUM INTO ?").run(to); } finally { src.close(); }
}

/** 1 — the omp prompt from the migrated copy holds every active ask + research lesson. */
function checkRender(m, store, ctx, fails) {
  const dropped = () => store.getLedgerEvents().filter((e) => e.event_type === "lesson_dropped").length;
  const before = dropped();
  const d = { store, memoryRoot: join(ctx.repo, "memory"), dataDir: ctx.root, skillsReader: () => undefined,
    coreBlock: () => undefined, retrieve: async () => ({ facts: [], pages: [] }), env: process.env };
  const { path, snapshot } = m.turn.writeSystemPromptFile(d, ctx.chat);
  const active = m.render.OMP_LESSON_SCOPES.flatMap((s) => store.getActiveLessons(s)).map((l) => l.id).sort((a, b) => a - b);
  const rendered = [...snapshot.lessonIds].sort((a, b) => a - b);
  const section = readFileSync(path, "utf8").split("## What you've learned — apply these\n")[1]?.split("\n\n")[0] ?? "";
  const cap = m.render.resolveLessonCharCap(process.env);
  console.log(`1  render: ${rendered.length}/${active.length} active ask+research lessons, section ${section.length}/${cap} chars`);
  if (active.length === 0) fails.push("1: no active lessons after the migration (silent degradation)");
  if (JSON.stringify(rendered) !== JSON.stringify(active)) fails.push(`1: rendered ${JSON.stringify(rendered)} != active ${JSON.stringify(active)}`);
  if (section.length > cap) fails.push("1: the lesson section is over the cap");
  if (/^- \[unthemed\] /m.test(section)) fails.push("1: an active lesson is still unthemed after the migration");
  if (dropped() - before > 0) fails.push(`1: ${dropped() - before} lesson_dropped row(s)`);
}

const fmt = (x) => (x === null ? "-" : x.toFixed(3));
const has = (got, want) => want.every((id) => got.includes(id));

/** One probe through both retrievers; core facts are dropped from the scored facts exactly as the live path does. */
function runProbe(m, store, ctx, p, q) {
  const now = new Date().toISOString();
  const f = m.ret.retrieveEpisodicFacts({ store, chat_id: ctx.chat, queryText: p.message, queryEmbedding: q, now });
  const w = m.wiki.retrieveWikiPages({ store, queryText: p.message, queryEmbedding: q, now });
  return { f, w, facts: f.rows.map((x) => x.id).filter((id) => !ctx.core.has(id)), pages: w.rows.map((x) => x.id) };
}

function judgeProbe(i, p, r, up, fails) {
  const neg = p.expect_facts.length === 0 && p.expect_pages.length === 0;
  const mode = up ? "up" : "down";
  if (!up && (r.f.fts_only !== true || r.f.embedding !== false)) fails.push(`2: probe ${i} (down) ran with fts_only ${r.f.fts_only}, embedding ${r.f.embedding}`);
  if (up && (r.f.embedding !== true || r.f.fts_only === true)) fails.push(`2: probe ${i} (up) ran without the embedding (fts_only ${r.f.fts_only})`);
  if (neg && (r.facts.length > 0 || r.pages.length > 0)) fails.push(`2: probe ${i} (negative, ${mode}) admitted facts ${JSON.stringify(r.facts)} pages ${JSON.stringify(r.pages)}`);
  if (!neg && up && !(has(r.facts, p.expect_facts) && has(r.pages, p.expect_pages))) fails.push(`2: probe ${i} (positive) missed facts ${JSON.stringify(p.expect_facts)} / pages ${JSON.stringify(p.expect_pages)}`);
  console.log(`  probe ${i} ${neg ? "neg" : "pos"}: facts ${JSON.stringify(r.facts)} want ${JSON.stringify(p.expect_facts)}; pages ${JSON.stringify(r.pages)} want ${JSON.stringify(p.expect_pages)}; `
    + `facts best_admitted ${fmt(r.f.best_admitted)} best_rejected ${fmt(r.f.best_rejected)}; pages best_admitted ${fmt(r.w.best_admitted)} best_rejected ${fmt(r.w.best_rejected)}`);
}

/** 2 — the gate over the labelled probes, Ollama up then down. */
async function checkRetrieval(m, store, ctx, probes, fails) {
  if (!m.ex.resolveEpisodicEnabled(process.env) || !m.arm.resolveWikiEnabled(process.env)) throw new Error("episodic or wiki memory is disarmed in this env: retrieval would be empty by construction");
  ctx.core = new Set(store.getCoreEpisodicFacts(ctx.chat, m.rs.resolveEpisodicCoreCap(process.env)).map((f) => f.id));
  const newest = new Set(store.getActiveEpisodicFacts(ctx.chat, 50).map((f) => f.id));
  const wanted = probes.probes.flatMap((p) => p.expect_facts);
  const core = wanted.filter((id) => ctx.core.has(id));
  if (core.length > 0) throw new Error(`probes: expected fact ids ${JSON.stringify(core)} are core facts (the live path drops them from retrieval)`);
  const older = probes.probes.filter((p) => p.expect_facts.some((id) => !newest.has(id))).length;
  if (older < 2) throw new Error(`probes: need >= 2 positives whose fact is older than the newest 50 (have ${older})`);
  const embedCfg = m.emb.resolveEmbedConfig(process.env);
  for (const up of [true, false]) {
    console.log(`\n2  retrieval - ${up ? "Ollama up" : "Ollama down (FTS only)"}`);
    let nonEmpty = 0;
    for (const [i, p] of probes.probes.entries()) {
      const q = up ? await m.emb.embedText(p.message, embedCfg) : null;
      if (up && !q) throw new Error("Ollama returned no embedding: start it (the Ollama-up run needs it)");
      const r = runProbe(m, store, ctx, p, q);
      if (r.facts.length + r.pages.length > 0) nonEmpty += 1;
      judgeProbe(i, p, r, up, fails);
    }
    if (up && nonEmpty === 0) fails.push("2: the Ollama-up run returned nothing for any probe (silent degradation)");
  }
}

function windowTurns(store, chat, w) {
  return store.getChatTurnsAfter(chat, w.from, 500).filter((t) => t.created_at <= w.to && store.runSource(t.run_id) !== "schedule");
}

/** One extract call over a window; each fact with whether its evidence passes. null when the seat gave no answer. */
async function extractJudged(m, store, llm, turns) {
  const lines = m.ev.transcriptLines(turns, m.ex.EPISODIC_EXTRACT_TURN_CAP);
  const question = m.ex.buildEpisodicExtractQuestion({ turns, userName: "Paco", now: new Date().toISOString(), numbered: true });
  const read = await llm({ question, system: m.ex.EPISODIC_EXTRACT_DISCIPLINE });
  if (!read.ok) return null;
  return m.ex.parseEpisodicExtractResult(read.answer).facts
    .map((f) => ({ fact: f.fact, ok: m.ev.checkEvidence(f.evidence, lines, (r) => store.runSource(r)).ok }));
}

/** One leg: 3 runs over both windows; returns the tally, pushing FAILs. */
async function runLeg(m, store, name, llm, win, fails) {
  const tally = { runs: 0, facts: 0, rejected: 0 };
  for (let run = 1; run <= 3; run += 1) {
    const q = await extractJudged(m, store, llm, win.q);
    const a = q && (await extractJudged(m, store, llm, win.a));
    if (!q || !a) { fails.push(`3: ${name} run ${run}: the seat gave no answer`); break; }
    tally.runs += 1;
    for (const f of [...q, ...a]) { tally.facts += 1; if (!f.ok) tally.rejected += 1; console.log(`    ${f.ok ? "ok" : "REJ"} ${f.fact}`); }
    if (win.forbidden && q.some((f) => win.forbidden.test(f.fact))) fails.push(`3: ${name} run ${run} stored the asked-only attribute`);
    if (!a.some((f) => f.ok)) fails.push(`3: ${name} run ${run}: no evidenced fact from the assertion window`);
  }
  console.log(`3  ${name}: ${tally.runs}/3 run(s), evidence rejected ${tally.rejected}/${tally.facts}`);
  return tally;
}

/** 3 — per ticks leg, 3 runs over both windows. */
async function checkExtract(m, store, ctx, probes, fails) {
  const win = { q: windowTurns(store, ctx.chat, probes.window_149), a: windowTurns(store, ctx.chat, probes.assertion_window),
    forbidden: probes.window_149.forbidden ? new RegExp(probes.window_149.forbidden, "i") : null };
  if (win.q.length === 0 || win.a.length === 0) throw new Error(`windows empty (window_149 ${win.q.length}, assertion ${win.a.length} turns)`);
  if (!win.forbidden) console.log("3  window_149 has no `forbidden` regex: judge its facts by eye (printed below)");
  const legs = m.cfg.resolveOmpConfig(process.env).ticks;
  if (legs.length === 0) throw new Error("no ticks legs configured (HOUGE_OMP_TICKS)");
  let facts = 0;
  for (const leg of legs) {
    const name = m.ms.formatModelString(leg);
    const llm = m.reg.tickSeat(store, "episodic_distill", "distill", { ...process.env, HOUGE_OMP_TICKS: name });
    facts += (await runLeg(m, store, name, llm, win, fails)).facts;
  }
  if (facts === 0) fails.push("3: no leg produced any fact (seat failure or silent degradation)");
}

/** 4 — an over-cap UPDATE is refused and the prior lesson is untouched. */
function checkLessonCap(store, fails) {
  const target = store.getActiveLessons("ask")[0];
  if (!target) throw new Error("check 4: no active ask lesson in the copy");
  const before = JSON.stringify(store.getLesson(target.id));
  const r = store.saveReconciledLesson({ scope: target.scope, text: "gate probe candidate", theme: target.theme },
    { verdict: "UPDATE", id: target.id, text: `${target.text} ${"x".repeat(241)}` }, "loop", new Date().toISOString());
  console.log(`\n4  over-cap UPDATE of lesson #${target.id}: verb ${r.verb}`);
  if (r.verb !== "capped") fails.push(`4: verb ${r.verb}, expected capped`);
  if (JSON.stringify(store.getLesson(target.id)) !== before) fails.push("4: the prior lesson changed");
}

/** 5 — after the live --apply and Paco's kickstart + one real turn; the live DB is opened read-only. */
function checkPost(ctx, args, fails) {
  if (typeof args.since !== "string" || Number.isNaN(Date.parse(args.since))) throw new Error("--post needs --since <ISO just before the kickstart>");
  const ending = args.forbiddenEnding ? new RegExp(args.forbiddenEnding, "i") : null;
  const db = new DatabaseSync(resolve(args.db ?? join(ctx.repo, "houge.sqlite")), { readOnly: true });
  try {
    const since = args.since;
    const resets = db.prepare(`SELECT COUNT(*) AS n FROM ledger_events WHERE event_type = 'planner_session_reset' AND correlation_id = ? AND occurred_at >= ?`).get(`planner:${ctx.chat}`, since).n;
    const reply = db.prepare(`SELECT run_id, text FROM chat_turns WHERE chat_id = ? AND role = 'assistant' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(ctx.chat, since);
    const active = db.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE status = 'active' AND scope IN ('ask', 'research')`).get().n;
    const prompt = readFileSync(join(args.dataDir ?? ctx.repo, "omp", `system-chat-${ctx.chat}.md`), "utf8");
    const themed = (prompt.match(/^- \[(format|time|honesty|hygiene|sources|tasks|self)\] /gm) ?? []).length;
    console.log(`5  planner_session_reset since ${since}: ${resets}; themed lessons in the prompt ${themed}/${active}`);
    if (resets < 1) fails.push("5: no planner_session_reset row since the kickstart");
    if (active === 0 || themed !== active) fails.push(`5: the prompt lists ${themed} themed lessons, ${active} are active`);
    if (!reply) { fails.push("5: no assistant reply since the kickstart (send one real turn first)"); return; }
    const tail = reply.text.trim().split("\n").slice(-2).join("\n");
    if (ending?.test(tail)) fails.push("5: the reply still ends with the old sign-off");
    if (!ending) console.log("5  no --forbidden-ending given: judge the reply ending by eye");
    const prev = db.prepare(`SELECT text FROM chat_turns WHERE chat_id = ? AND role = 'user' AND run_id <> ? AND created_at < (SELECT MIN(created_at) FROM chat_turns WHERE run_id = ?) ORDER BY created_at DESC LIMIT 1`).get(ctx.chat, reply.run_id, reply.run_id);
    console.log(`\nMANUAL - does the reply carry the thread (refer to the previous message)?\n  previous user message: ${prev?.text ?? "(none)"}\n  reply: ${reply.text}`);
  } finally { db.close(); }
}

async function gate(m, ctx, probes, plan) {
  const store = m.rs.RunStore.open(join(ctx.root, "houge.sqlite"));
  const fails = [];
  try {
    if (m.mig.migrationStatus(store, plan) === "pending") m.mig.applyMigration({ store, plan, chat_id: ctx.chat, now: new Date().toISOString() });
    checkRender(m, store, ctx, fails);
    await checkRetrieval(m, store, ctx, probes, fails);
    await checkExtract(m, store, ctx, probes, fails);
    checkLessonCap(store, fails);
  } finally { store.close(); }
  return fails;
}

async function runCopy(m, ctx, args, probes, planRaw) {
  const base = join(m.tmp.resolveDaemonTmpDir(process.env), "memory-a1"); // never os.tmpdir() (AGENTS.md)
  mkdirSync(base, { recursive: true, mode: 0o700 });
  ctx.root = mkdtempSync(join(base, "gate-"));
  try {
    copyDb(resolve(args.db ?? join(ctx.repo, "houge.sqlite")), join(ctx.root, "houge.sqlite"));
    return await gate(m, ctx, probes, m.mig.parseMigrationPlan(planRaw));
  } finally {
    if (args.keep) console.log(`\ntemp DB kept: ${join(ctx.root, "houge.sqlite")}`);
    else rmSync(ctx.root, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const m = await loadModules();
  m.env.loadHougeEnv();
  const chat = process.env.HOUGE_TELEGRAM_CHAT_ID?.trim();
  if (!chat) throw new Error("HOUGE_TELEGRAM_CHAT_ID is not set (point HOUGE_ENV_FILE at the daemon's .env)");
  const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env")));
  const local = join(repo, ".superpowers", "memory-a1");
  const ctx = { chat, repo, root: "", core: new Set() };
  const fails = [];
  if (args.post) checkPost(ctx, args, fails);
  else {
    const probes = validateProbes(JSON.parse(readFileSync(resolve(args.probes ?? join(local, "probes.json")), "utf8")));
    const planRaw = JSON.parse(readFileSync(resolve(args.plan ?? join(local, "plan.json")), "utf8"));
    fails.push(...(await runCopy(m, ctx, args, probes, planRaw)));
  }
  console.log(fails.length === 0 ? "\nPASS" : `\nFAIL\n  ${fails.join("\n  ")}`);
  return fails.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`setup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
