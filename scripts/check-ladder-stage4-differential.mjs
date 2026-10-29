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
import { CORPORA, SetupError, DISTS, STRIP_KEYS, cleanupTemp, compare, runClosers, indexItems, initTemp, itemLabel, isPrivate, loadDist, mkTemp, ownOmit, redactForPrint, state } from "./stage4-diff-lib.mjs";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const CORPORA_DIR = resolve(new URL("./stage4-corpora", import.meta.url).pathname);

function parseArgs(argv) {
  const a = { old3: null, old4a: null, transcriptsDir: null, liveDb: null, only: null, keep: false, debug: false };
  const val = (i) => { if (argv[i + 1] === undefined) throw new SetupError(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist-3") a.old3 = resolve(val(i++));
    else if (argv[i] === "--old-dist-4a") a.old4a = resolve(val(i++));
    else if (argv[i] === "--transcripts-dir") a.transcriptsDir = resolve(val(i++));
    else if (argv[i] === "--live-db") a.liveDb = resolve(val(i++));
    else if (argv[i] === "--only") a.only = val(i++).split(",").filter(Boolean);
    else if (argv[i] === "--keep") a.keep = true;
    else if (argv[i] === "--debug") a.debug = true;
    else throw new SetupError(`unknown argument ${argv[i]}`);
  }
  for (const [flag, dir, file] of [["--old-dist-3", a.old3, "decisions/registry.js"], ["--old-dist-4a", a.old4a, "capabilities/capability-runner.js"]]) {
    if (!dir || !existsSync(join(dir, file))) throw new SetupError(`${flag} <previous build's dist> is required (no ${file} at ${dir ?? "(unset)"})`);
  }
  return a;
}

function verifyProvenance(a) {
  let p3, p4;
  try {
    p3 = verifyOldDist(a.old3, NEW_DIST, "548cb87", "decisions/registry.js");
    p4 = verifyOldDist(a.old4a, NEW_DIST, "1451a66", "capabilities/capability-runner.js");
  } catch (e) { throw new SetupError(`provenance: ${e instanceof Error ? e.message : String(e)}`); }
  console.log(`s3  old build: worktree HEAD ${p3.head.slice(0, 12)}, registry.js ${p3.oldHash} (new ${p3.newHash})`);
  console.log(`s4a old build: worktree HEAD ${p4.head.slice(0, 12)}, capability-runner.js ${p4.oldHash} (new ${p4.newHash})`);
}

async function loadCorpora(only) {
  for (const f of readdirSync(CORPORA_DIR).filter((n) => n.endsWith(".mjs")).sort()) CORPORA.push((await import(join(CORPORA_DIR, f))).default);
  const picked = only ? CORPORA.filter((c) => only.includes(c.name)) : CORPORA;
  const unknown = (only ?? []).filter((n) => !CORPORA.some((c) => c.name === n));
  if (unknown.length) throw new SetupError(`--only names no corpus: ${unknown.join(", ")} (have ${CORPORA.map((c) => c.name).join(", ")})`);
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

/** True when no key on the path is a stripped one (so a change there must reach compare). */
const survives = (path) => !path.some((k) => STRIP_KEYS.has(k) || k.startsWith("__"));

/** First string leaf of the RAW projection whose path survives strip (ids are skipped: they are renamed, not compared). */
function firstSurvivingString(v, path = [], omit = []) {
  if (typeof v === "string") return survives(path) && !/\b(tool|op)_[0-9A-Za-z]/.test(v) ? path : null;
  if (!v || typeof v !== "object" || (!Array.isArray(v) && ["approval.bind", "secret.redact"].includes(v.entry_id))) return null;
  for (const k of Object.keys(v).sort()) {
    if (omit.includes(k) || !survives([k])) continue;
    const r = firstSurvivingString(v[k], [...path, k], omit);
    if (r) return r;
  }
  return null;
}

/**
 * The planted divergence, checked on the new side alone (a real old/new difference can neither satisfy nor hide it): the raw
 * new projection must equal itself, and with one byte appended to its first surviving string leaf compare must report exactly one path.
 */
function selfTest(corpus, item, rawNew, pair) {
  const path = firstSurvivingString(rawNew, [], ownOmit(rawNew, pair));
  if (!path) return false;
  const mutated = structuredClone(rawNew);
  const parent = path.slice(0, -1).reduce((x, k) => x[k], mutated);
  parent[path.at(-1)] += "!";
  const hit = compare(corpus, item, rawNew, mutated, pair);
  return compare(corpus, item, rawNew, structuredClone(rawNew), pair) === null && hit !== null && hit.paths.length === 1 && hit.key === item.key;
}

async function runItem(corpus, item, ctx, res) {
  state.where = `${corpus.name} ${itemLabel(item)}`;
  let first = null;
  for (const pair of pairsOf(corpus, item)) {
    try {
      const [a, b] = [await corpus.project(ctx.dists[pair[0]], item, ctx), await corpus.project(ctx.dists.new, item, ctx)];
      first ??= { a, b, pair };
      const diff = compare(corpus, item, a, b, pair);
      if (diff) { res.diffs += 1; console.log(`FAIL [${corpus.name}] ${itemLabel(item)} ${diff.pair.join("→")} — ${diff.diff}`); }
    } catch (e) {
      res.diffs += 1;
      const why = isPrivate(item) ? "" : `: ${redactForPrint(e instanceof Error ? e.message : String(e))}`;
      console.log(`FAIL [${corpus.name}] ${itemLabel(item)} ${pair.join("→")} — projection threw${why}`);
    }
    res.compared += 1;
  }
  if (first && corpus.required) {
    try { corpus.required(ctx.dists.new, item, first.b, ctx); } catch (e) {
      const why = isPrivate(item) ? "" : `: ${redactForPrint(e instanceof Error ? e.message : String(e))}`;
      state.requiredFailures.push(`${corpus.name}/${itemLabel(item)}`);
      console.log(`FAIL required [${corpus.name}] ${itemLabel(item)} — required() threw${why}`);
    }
  }
  return first;
}

async function runCorpus(corpus, ctx) {
  state.where = `${corpus.name} (load)`;
  const reqBefore = state.requiredFailures.length;
  const res = { diffs: 0, compared: 0, selfTest: true, coverage: [] };
  const items = await corpus.load(ctx);
  indexItems(corpus, items);
  const counts = tagCounts(items);
  res.coverage = coverage(corpus, items, counts);
  if (res.coverage.length) console.log(`FAIL coverage [${corpus.name}]: ${res.coverage.join("; ")}`);
  let first = null;
  for (const item of items) { const r = await runItem(corpus, item, ctx, res); if (r && !first) first = { item, ...r }; }
  if (first) res.selfTest = selfTest(corpus, first.item, first.b, first.pair);
  else res.selfTest = false;
  if (!res.selfTest) console.log(`FAIL comparator self-test [${corpus.name}]: a planted one-byte divergence was not reported as exactly its own key`);
  res.required = state.requiredFailures.length - reqBefore;
  const ok = !res.coverage.length && !res.diffs && res.required === 0 && res.selfTest;
  console.log(`${ok ? "PASS" : "FAIL"} ${corpus.name}: ${items.length} items (${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(", ")}); pairs ${res.compared}; ` +
    `differences ${res.diffs}; required failures ${res.required}; self-test ${res.selfTest ? "ok" : "FAILED"}`);
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  state.debug = args.debug;
  verifyProvenance(args);
  Object.assign(DISTS, { new: NEW_DIST, s3: args.old3, s4a: args.old4a });
  const corpora = await loadCorpora(args.only);
  try { initTemp(args.keep); } catch (e) { throw new SetupError(`temp root: ${e instanceof Error ? e.message : String(e)}`); }
  const ctx = { dists: { new: await loadDist(NEW_DIST), s3: await loadDist(args.old3), s4a: await loadDist(args.old4a) },
    transcriptsDir: args.transcriptsDir, liveDb: args.liveDb, mkTemp };
  let allOk = true;
  try { for (const corpus of corpora) allOk = (await runCorpus(corpus, ctx)) && allOk; } finally { await runClosers(); }
  console.log(allOk ? "\nSTAGE 4 DIFFERENTIAL: PASS" : "\nSTAGE 4 DIFFERENTIAL: FAIL");
  return allOk ? 0 : 1;
}

process.on("SIGINT", () => { cleanupTemp(); process.exit(130); });
process.on("SIGTERM", () => { cleanupTemp(); process.exit(143); });
const DEBUG = process.argv.includes("--debug");
function report(e) {
  if (e instanceof SetupError) return `differential setup error: ${e.message}`;
  if (DEBUG) return `differential unexpected error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
  return `unexpected error in ${state.where ?? "setup"} (detail withheld; rerun with --debug)`;
}
main().then((c) => { cleanupTemp(); process.exit(c); },
  (e) => { console.error(report(e)); cleanupTemp(); process.exit(2); });
