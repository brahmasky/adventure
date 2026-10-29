#!/usr/bin/env node
// Stage 4B differential harness (spec 2026-10-29 §6). From the feature worktree, after `npm run build`:
//   node scripts/check-ladder-stage4-differential.mjs --old-dist-3 <548cb87 worktree>/dist --old-dist-4a <1451a66 worktree>/dist \
//     [--transcripts-dir <dir>] [--live-db <path>] [--only a,b] [--keep]
// Runs each corpus's items through the old builds and this one and proves nothing but the two new decision rows changed.
// Exit: 0 PASS · 1 FAIL · 2 setup error. --transcripts-dir and --live-db are read-only inputs (the live DB only via a VACUUM copy).
// The temp root is deleted on every exit path unless --keep.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { verifyOldDist } from "./old-dist-provenance.mjs";
import { CORPORA, DISTS, cleanupTemp, compare, initTemp, loadDist, mkTemp, redactForPrint, state, strip } from "./stage4-diff-lib.mjs";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const CORPORA_DIR = resolve(new URL("./stage4-corpora", import.meta.url).pathname);

function parseArgs(argv) {
  const a = { old3: null, old4a: null, transcriptsDir: null, liveDb: null, only: null, keep: false };
  const val = (i) => { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist-3") a.old3 = resolve(val(i++));
    else if (argv[i] === "--old-dist-4a") a.old4a = resolve(val(i++));
    else if (argv[i] === "--transcripts-dir") a.transcriptsDir = resolve(val(i++));
    else if (argv[i] === "--live-db") a.liveDb = resolve(val(i++));
    else if (argv[i] === "--only") a.only = val(i++).split(",").filter(Boolean);
    else if (argv[i] === "--keep") a.keep = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const [flag, dir, file] of [["--old-dist-3", a.old3, "decisions/registry.js"], ["--old-dist-4a", a.old4a, "capabilities/capability-runner.js"]]) {
    if (!dir || !existsSync(join(dir, file))) throw new Error(`${flag} <previous build's dist> is required (no ${file} at ${dir ?? "(unset)"})`);
  }
  return a;
}

function verifyProvenance(a) {
  const p3 = verifyOldDist(a.old3, NEW_DIST, "548cb87", "decisions/registry.js");
  const p4 = verifyOldDist(a.old4a, NEW_DIST, "1451a66", "capabilities/capability-runner.js");
  console.log(`s3  old build: worktree HEAD ${p3.head.slice(0, 12)}, registry.js ${p3.oldHash} (new ${p3.newHash})`);
  console.log(`s4a old build: worktree HEAD ${p4.head.slice(0, 12)}, capability-runner.js ${p4.oldHash} (new ${p4.newHash})`);
}

async function loadCorpora(only) {
  for (const f of readdirSync(CORPORA_DIR).filter((n) => n.endsWith(".mjs")).sort()) CORPORA.push((await import(join(CORPORA_DIR, f))).default);
  const picked = only ? CORPORA.filter((c) => only.includes(c.name)) : CORPORA;
  const unknown = (only ?? []).filter((n) => !CORPORA.some((c) => c.name === n));
  if (unknown.length) throw new Error(`--only names no corpus: ${unknown.join(", ")} (have ${CORPORA.map((c) => c.name).join(", ")})`);
  return picked;
}

const pairsOf = (corpus, item) => (typeof corpus.pairs === "function" ? corpus.pairs(item) : corpus.pairs);
const tagCounts = (items) => items.reduce((m, it) => { for (const t of it.tags ?? []) m[t] = (m[t] ?? 0) + 1; return m; }, {});

/** The coverage pin: a short extraction, or a named branch with no item, is a FAIL (never a pass on an empty set). */
function coverage(corpus, items, counts) {
  const problems = [];
  if (items.length < corpus.min.items) problems.push(`${items.length} items < required ${corpus.min.items}`);
  for (const b of corpus.min.branches) if (!counts[b]) problems.push(`branch "${b}" has no item (0)`);
  return problems;
}

/** The planted divergence: one byte appended to the first string field that survives strip; compare must report exactly that item. */
function selfTest(corpus, item, proj, pair) {
  const base = strip(proj, pair);
  const mutated = structuredClone(base);
  let done = false;
  const walk = (v) => {
    for (const k of Object.keys(v)) {
      if (done) return;
      if (typeof v[k] === "string") { v[k] += "!"; done = true; } else if (v[k] && typeof v[k] === "object") walk(v[k]);
    }
  };
  walk(mutated);
  if (!done) return false;
  const hit = compare(corpus, item, base, mutated, pair);
  return hit !== null && hit.key === item.key && compare(corpus, item, base, structuredClone(base), pair) === null;
}

async function runItem(corpus, item, ctx, res) {
  let firstNew = null;
  for (const pair of pairsOf(corpus, item)) {
    try {
      const [a, b] = [await corpus.project(ctx.dists[pair[0]], item, ctx), await corpus.project(ctx.dists.new, item, ctx)];
      firstNew ??= { b, a, pair };
      const diff = compare(corpus, item, a, b, pair);
      if (diff) { res.diffs += 1; console.log(`FAIL [${corpus.name}] ${redactForPrint(diff.key)} ${diff.pair.join("→")} — ${diff.diff}`); }
    } catch (e) {
      res.diffs += 1;
      console.log(`FAIL [${corpus.name}] ${redactForPrint(item.key)} ${pair.join("→")} — projection threw: ${redactForPrint(e instanceof Error ? e.message : String(e))}`);
    }
    res.compared += 1;
  }
  if (firstNew && corpus.required) {
    try { corpus.required(ctx.dists.new, item, firstNew.b, ctx); } catch (e) {
      res.required += 1; state.requiredFailures.push(`${corpus.name}/${item.key}`);
      console.log(`FAIL required [${corpus.name}] ${redactForPrint(item.key)} — ${redactForPrint(e instanceof Error ? e.message : String(e))}`);
    }
  }
  return firstNew;
}

async function runCorpus(corpus, ctx) {
  const res = { diffs: 0, required: 0, compared: 0, selfTest: true, coverage: [] };
  const items = await corpus.load(ctx);
  const counts = tagCounts(items);
  res.coverage = coverage(corpus, items, counts);
  if (res.coverage.length) console.log(`FAIL coverage [${corpus.name}]: ${res.coverage.join("; ")}`);
  let first = null;
  for (const item of items) { const r = await runItem(corpus, item, ctx, res); if (r && !first) first = { item, ...r }; }
  if (first) res.selfTest = selfTest(corpus, first.item, first.b, first.pair);
  else res.selfTest = false;
  if (!res.selfTest) console.log(`FAIL comparator self-test [${corpus.name}]: a planted one-byte divergence was not reported as exactly its own key`);
  const ok = !res.coverage.length && !res.diffs && !res.required && res.selfTest;
  console.log(`${ok ? "PASS" : "FAIL"} ${corpus.name}: ${items.length} items (${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(", ")}); pairs ${res.compared}; ` +
    `differences ${res.diffs}; required failures ${res.required}; self-test ${res.selfTest ? "ok" : "FAILED"}`);
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  verifyProvenance(args);
  Object.assign(DISTS, { new: NEW_DIST, s3: args.old3, s4a: args.old4a });
  const corpora = await loadCorpora(args.only);
  initTemp(args.keep);
  const ctx = { dists: { new: await loadDist(NEW_DIST), s3: await loadDist(args.old3), s4a: await loadDist(args.old4a) },
    transcriptsDir: args.transcriptsDir, liveDb: args.liveDb, mkTemp };
  let allOk = true;
  for (const corpus of corpora) allOk = (await runCorpus(corpus, ctx)) && allOk;
  console.log(allOk ? "\nSTAGE 4 DIFFERENTIAL: PASS" : "\nSTAGE 4 DIFFERENTIAL: FAIL");
  return allOk ? 0 : 1;
}

process.on("SIGINT", () => { cleanupTemp(); process.exit(130); });
main().then((c) => { cleanupTemp(); process.exit(c); },
  (e) => { console.error(`differential setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); cleanupTemp(); process.exit(2); });
