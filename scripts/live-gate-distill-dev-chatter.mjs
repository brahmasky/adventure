// Live gate for the distill dev-chatter fix (2026-10-02): episodic distill must not store talk about Houge
// itself (its code, fixes, reviews, memory edits, task progress) as facts about Paco, and must still store
// facts about Paco's world. Runs on the REAL ticks seat (omp, profile `houge`) against a TEMP COPY of the
// live DB (VACUUM INTO); the live DB is only read.
//
//   HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-distill-dev-chatter.mjs [--db <path>] [--keep]
//
// Three checks, all on Paco's real turns:
//   A  prompt alone: the 2026-10-01/02 dev window (it minted facts #158–#174) fed straight to the extractor,
//      no backstop — no extracted fact may match the dev-talk pattern.
//      (First live run, 2026-10-02: prompt alone still kept one memory-edit request — "Paco wants the old
//      memory about … removed" — which the pattern misses; the backstop drops those runs, and B shows it.)
//   B  the full pass on the temp copy (backstop + prompt + reconcile), from just before that window to now —
//      no new fact may match the dev-talk pattern.
//   C  control (silent degradation): the 2026-09-28 rental chat must still yield a fact about it.
// Exit: 0 PASS · 1 FAIL · 2 setup error. Every extracted fact is printed so the operator can judge the
// pattern's misses by eye.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEV_WINDOW = { from: "2026-10-01T21:27:00.000Z", to: "2026-10-02T01:20:00.000Z" };
const CONTROL_WINDOW = { from: "2026-09-28T10:00:00.000Z", to: "2026-09-29T02:00:00.000Z" };
/** Words of Houge's own build talk: a match FAILs. Broad on purpose — a false FAIL is read by eye, a miss is not. */
const DEV_TALK = /lesson[_ ]?write|code-owned|regate|aggregate|grep|commit|提交|修复|\bfix|审查|review|\bbug|误判|记忆(提取|机制)|memory (extraction|mechanism)|self-write|提案|distill|Houge's (code|bug|fix)|定时任务.{0,12}(指令|不是|说话)/i;
const CONTROL_TOPIC = /租|rent/i;
const MAX_PASSES = 6;

function parseArgs(argv) {
  const args = { db: undefined, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db") args.db = argv[++i];
    else if (argv[i] === "--keep") args.keep = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

function turnsIn(store, chat, window) {
  return store.getChatTurnsAfter(chat, window.from, 500).filter((t) => t.created_at <= window.to);
}

/** The extractor alone, 24 turns per call (the pass's own window cap). */
async function extractOnly(mod, llm, turns) {
  const facts = [];
  for (let i = 0; i < turns.length; i += mod.EPISODIC_EXTRACT_TURN_CAP) {
    const question = mod.buildEpisodicExtractQuestion({ turns: turns.slice(i, i + mod.EPISODIC_EXTRACT_TURN_CAP), userName: "Paco", now: new Date().toISOString() });
    const read = await llm({ question, system: mod.EPISODIC_EXTRACT_DISCIPLINE });
    if (!read.ok) throw new Error("extract seat failed (no answer on any leg)");
    facts.push(...mod.parseEpisodicExtractResult(read.answer).facts.map((f) => f.fact));
  }
  return facts;
}

/** The real pass on the temp copy, from just before the dev window until the watermark reaches now. */
async function fullPasses(mod, store, llm, chat) {
  store.setEpisodicDistillWatermark({ chat_id: chat, last_turn_created_at: DEV_WINDOW.from, last_distilled_at: new Date().toISOString() });
  for (let n = 0; n < MAX_PASSES; n += 1) {
    const before = store.getEpisodicDistillWatermark(chat)?.last_turn_created_at;
    const r = await mod.runEpisodicDistillPass({ store, llm, embed: async () => null, chatId: chat, userName: "Paco", now: new Date().toISOString() });
    console.log(`  pass ${n + 1}: ${JSON.stringify(r)}`);
    if (store.getEpisodicDistillWatermark(chat)?.last_turn_created_at === before) break;
  }
}

function report(label, facts, bad) {
  console.log(`\n${label}: ${facts.length} fact(s)`);
  for (const f of facts) console.log(`  ${bad(f) ? "✗" : "·"} ${f}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [{ loadHougeEnv }, { tickSeat }, mod, { RunStore }] = await Promise.all([
    import("../dist/config/load-env.js"), import("../dist/llm/registry.js"),
    import("../dist/capabilities/episodic-extract.js"), import("../dist/run/run-store.js")
  ]);
  loadHougeEnv();
  const chat = process.env.HOUGE_TELEGRAM_CHAT_ID?.trim();
  if (!chat) throw new Error("HOUGE_TELEGRAM_CHAT_ID is not set (point HOUGE_ENV_FILE at the daemon's .env)");
  const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env")));
  const root = mkdtempSync(join(tmpdir(), "houge-gate-distill-"));
  copyDb(resolve(args.db ?? join(repo, "houge.sqlite")), join(root, "houge.sqlite"));
  const store = RunStore.open(join(root, "houge.sqlite"));
  const llm = tickSeat(store, "episodic_distill", "distill");
  const isDev = (f) => DEV_TALK.test(f);
  const fails = [];
  try {
    const dev = turnsIn(store, chat, DEV_WINDOW);
    const control = turnsIn(store, chat, CONTROL_WINDOW);
    if (dev.length === 0 || control.length === 0) throw new Error(`windows empty (dev ${dev.length}, control ${control.length} turns)`);

    const a = await extractOnly(mod, llm, dev);
    report(`A  prompt alone, dev window (${dev.length} turns)`, a, isDev);
    if (a.some(isDev)) fails.push("A: the extractor kept dev talk");

    const since = new Date().toISOString();
    await fullPasses(mod, store, llm, chat);
    const b = store.getActiveEpisodicFacts(chat).filter((f) => f.created_at >= since).map((f) => f.fact);
    report("B  full pass on the temp copy, dev window → now (new active facts)", b, isDev);
    if (b.some(isDev)) fails.push("B: the full pass stored dev talk");

    const c = await extractOnly(mod, llm, control.slice(0, mod.EPISODIC_EXTRACT_TURN_CAP));
    report(`C  control, rental chat (${Math.min(control.length, mod.EPISODIC_EXTRACT_TURN_CAP)} turns)`, c, (f) => !CONTROL_TOPIC.test(f));
    if (!c.some((f) => CONTROL_TOPIC.test(f))) fails.push("C: the control chat yielded no fact about the rental (silent degradation)");
  } finally {
    store.close();
    if (args.keep) console.log(`\ntemp DB kept: ${join(root, "houge.sqlite")}`);
    else rmSync(root, { recursive: true, force: true });
  }
  console.log(fails.length === 0 ? "\nPASS" : `\nFAIL\n  ${fails.join("\n  ")}`);
  return fails.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`setup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
