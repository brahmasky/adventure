#!/usr/bin/env node
// Noise-band measurement (decision ladder stage 2a, Addition B). Sends each request k times, byte-identical, and prints the
// per-question spread and candidate NOISE_BANDS rows for Paco to review. It writes nothing into the repo: the output is a
// reviewed artifact (stdout), and only Paco commits rows into src/decisions/noise-band.ts. Never writes the live DB: the
// tree mode reads a VACUUM INTO copy in a temp root, deleted on every exit (including SIGINT).
//
//   Run from the worktree after `npm run build` THERE:
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/measure-jev-noise.mjs --injection [--k 5]
//   HOUGE_ENV_FILE=… node scripts/measure-jev-noise.mjs --tree --approved "<Paco's words and date>" [--limit 40] [--k 5]
//
// --injection re-sends the planted corpus (src/decisions/injection-corpus.ts, Task 18) masked then split, in batches of 16.
// --tree re-sends Paco's last Telegram texts with their stored context (shape-only redaction, the P6 gate's states). The
// standing approval named ONE replay, so this mode refuses to run without --approved (plan Q1: "yes, 40 × 5").
// Every request state also passes through the egress redactor (redactStrings) before it leaves.
// Exit: 0 complete · 3 INCOMPLETE (a call failed or the model moved) · 2 setup error.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const PACE_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let root = null;
const cleanup = () => { root?.remove(); root = null; };

async function load() {
  const paths = ["config/load-env.js", "run/run-store.js", "jev/jev-client.js", "jev/questions/tree.js", "jev/questions/types.js", "jev/triage-replay.js",
    "jev/noise-measure.js", "decisions/entries/tool-injection.js", "decisions/egress.js", "llm/metered-pricing.js", "core/turn-handler-ladder.js"];
  return Object.assign({}, ...(await Promise.all(paths.map((p) => import(join(DIST, p))))));
}

/** category's confidence and top-two gap are read by the lane rules too, so they get bands of their own (senior W7). */
const derivedOf = (m) => (id, ans) => (id === "category" && ans.type === "choice" ? { [m.CATEGORY_CONFIDENCE]: ans.confidence, [m.CATEGORY_GAP]: m.gapOf(ans) } : {});

function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

async function treeRequests(m, limit) {
  const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env")));
  const live = join(repo, "houge.sqlite");
  if (!existsSync(live)) throw new Error(`no DB at ${live}`);
  root = m.createTempRoot("hg-noise-", "/tmp");
  const copy = join(root.path, "copy.sqlite"); copyDb(live, copy);
  const store = m.RunStore.open(copy);
  try {
    const turns = store.listReplayTurns({ sinceIso: m.TREE_LABEL_SINCE }).filter((t) => store.runSource(t.run_id) === "telegram").slice(-limit);
    const wire = Object.fromEntries(m.TREE_QUESTIONS.map((q) => [q.id, m.toJevQuestion(q)]));
    return turns.map((t) => m.treeContextFor(store, process.env, t).built).filter((b) => b.ok)
      .map((b) => ({ req: { state: m.redactStrings(b.state), questions: wire }, questions: m.TREE_QUESTIONS }));
  } finally { store.close(); }
}

async function injectionRequests(m) {
  const { plantedCorpus } = await import(join(DIST, "decisions/injection-corpus.js")); // Task 18; a missing build fails loud here
  const passages = plantedCorpus().flatMap((it) => (m.splitEgress(it.text, m.PASSAGE_CHARS) ?? []).map((p) => p.out)); // mask, then split
  const out = [];
  for (let k = 0; k < passages.length; k += m.BATCH_SIZE) {
    const batch = passages.slice(k, k + m.BATCH_SIZE);
    const questions = batch.map((_, j) => m.injectionQuestion(`p${j + 1}`, `i${j + 1}`));
    const state = { source: "a fetched web page", ...Object.fromEntries(batch.map((p, j) => [`p${j + 1}`, p])) };
    out.push({ req: { state: m.redactStrings(state), questions: Object.fromEntries(questions.map((q) => [q.id, m.toJevQuestion(q)])) }, questions, template: true });
  }
  return out;
}

/** The samples one request yields: injection items share the one template key; tree questions key on their own hash. */
function samplesOf(m, r, got, model) {
  return r.questions.flatMap((q) => {
    const key = r.template ? { question: "injected", criteriaHash: m.INJECTION_TEMPLATE_HASH } : { question: q.id, criteriaHash: m.criteriaHash(q) };
    const own = [{ ...key, model, values: got.values[q.id] ?? [] }];
    const derived = !r.template && q.id === "category" ? [m.CATEGORY_CONFIDENCE, m.CATEGORY_GAP].map((d) => ({ question: d, criteriaHash: m.criteriaHash(q), model, values: got.values[d] ?? [] })) : [];
    return [...own, ...derived];
  });
}

async function main() {
  const a = (await load()).parseNoiseArgs(process.argv.slice(2));
  if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
  const m = await load();
  m.loadHougeEnv();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (HOUGE_ENV_FILE?)");
  const client = m.createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, audit: { record: () => undefined }, meteredBreached: () => false, retries: 0, timeoutMs: 15_000 });
  const requests = a.tree ? await treeRequests(m, a.limit) : await injectionRequests(m);
  const samples = []; let failed = 0; let tokens = 0; const models = new Set();
  for (const r of requests) {
    const got = await m.repeatCalls(client, r.req, a.k, r.questions.map((q) => q.id), derivedOf(m), () => sleep(PACE_MS));
    failed += got.failed; tokens += got.tokens; for (const x of got.models) models.add(x);
    samples.push(...samplesOf(m, r, got, [...got.models][0] ?? "unknown"));
  }
  const spentUsd = m.computeCostUsd(m.JEV_PROVIDER, m.JEV_REQUEST_MODEL, { input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0 }, process.env) ?? 0;
  const date = new Date().toISOString().slice(0, 10);
  console.log(m.formatNoiseReport(m.spreadStats(samples), { requests: requests.length, k: a.k, failed, models: [...models], spentUsd, date }));
  return failed > 0 || models.size > 1 ? 3 : 0;
}

process.on("SIGINT", () => { cleanup(); process.exit(130); });
main().then((c) => { cleanup(); process.exit(c); }, (e) => { console.error(`noise measure setup error: ${e instanceof Error ? e.message : String(e)}`); cleanup(); process.exit(2); });
