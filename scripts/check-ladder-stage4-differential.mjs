#!/usr/bin/env node
// Stage 4B differential harness (spec 2026-10-29 §6). From the feature worktree, after `npm run build`:
//   node scripts/check-ladder-stage4-differential.mjs --old-dist-3 <548cb87 worktree>/dist --old-dist-4a <1451a66 worktree>/dist \
//     --old-dist-4b <merge-base worktree>/dist (REQUIRED; stamped by node scripts/stamp-dist.mjs <worktree>) \
//     [--old-base <full sha>: the base the 4b build is pinned to; required once the branch is merged] \
//     --old-dist-r1 <merge-base worktree>/dist (REQUIRED, Slice R1; stamped likewise; must contain gateway/gateway.js) \
//     [--old-base-r1 <full sha>: the base the r1 build is pinned to; required once the branch is merged] \
//     --old-dist-r2 <merge-base worktree>/dist (REQUIRED, Slice R2; stamped likewise; must contain gateway/gateway.js) \
//     [--old-base-r2 <full sha>: the base the r2 build is pinned to; required once the branch is merged] \
//     --old-dist-r3 <merge-base worktree>/dist (REQUIRED, Slice R3; stamped likewise; must contain omp/planner-supervisor.js) \
//     [--old-base-r3 <full sha>: the base the r3 build is pinned to; required on the branch (its merge base is a docs commit)] \
//     --old-dist-r4 <merge-base worktree>/dist (REQUIRED, Slice R4; stamped likewise; must contain omp/planner-supervisor.js) \
//     [--old-base-r4 <full sha>: the base the r4 build is pinned to; post-merge only (on the branch merge-base discovery finds it)] \
//     --old-dist-r5 <merge-base worktree>/dist (REQUIRED, Slice R5; stamped likewise; must contain omp/turn-context.js) \
//     [--old-base-r5 <full sha>: the base the r5 build is pinned to; post-merge only (on the branch merge-base discovery finds it)] \
//     --old-dist-r6 <merge-base worktree>/dist (REQUIRED, Slice R6; stamped likewise; must contain core/lanes/lookup-lane.js) \
//     [--old-base-r6 <full sha>: the base the r6 build is pinned to; post-merge only (on the branch merge-base discovery finds it)] \
//     --old-dist-r7 <merge-base worktree>/dist (REQUIRED, Slice R7; stamped likewise; must contain notifications/telegram-notification-adapter.js) \
//     [--old-base-r7 <full sha>: the base the r7 build is pinned to; post-merge only (on the branch merge-base discovery finds it)] \
//     [--transcripts-dir <dir>] [--live-db <path>] [--only a,b] [--keep] [--debug: may print private corpus content; local diagnosis only, never paste its output]
// Full post-merge command: add --old-base c558413c3e248122256c3355b8852d3879aed3f6 --old-base-r1 aec1d4f9377f8fcebf883eaed8a81538b2cf8aef --old-base-r2 ef4d0d10fbcbe3077e10a28979891f0abd256b2f --old-base-r3 6c75b03bbbbb602a9cc4cc42f0bba54d6bfea255 --old-base-r4 c6eae37c620f9f95100579959baebeb5e263b767 --old-base-r5 9c23f084be37adad90cd8030c94430e9bed798c3 --old-base-r6 b0da208a29b82482c93a67e21dbfd469e1092a14 --old-base-r7 <sha, filled in at merge>
//   (each worktree under .worktrees/base-<sha7>/dist, built and stamped with node scripts/stamp-dist.mjs).
// Runs each corpus's items through the old builds and this one and proves nothing but the new decision rows changed, per pair:
//   s3 and s4a (old builds 548cb87, 1451a66): approval.bind and secret.redact; s4b (the stamped merge-base build): memory.lesson_admit, schedule.admit, memory.correct_preflight.
// Exit: 0 PASS · 1 FAIL · 2 setup error. --transcripts-dir and --live-db are read-only inputs (the live DB only via a VACUUM copy).
// The temp root is deleted on every exit path unless --keep (never the copy of the live DB: that is always deleted).
// --debug may print private corpus content; local diagnosis only, never paste its output.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { mergeBaseOf, provenanceText, verifyOldDist, verifyStampedDist } from "./old-dist-provenance.mjs";
import { CORPORA, SetupError, DISTS, NEW_ROW_IDS, STRIP_KEYS, cleanupTemp, compare, runClosers, indexItems, initTemp, itemLabel, isPrivate, loadDist, mkTemp, ownOmit, redactForPrint, state } from "./stage4-diff-lib.mjs";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const CORPORA_DIR = resolve(new URL("./stage4-corpora", import.meta.url).pathname);

function parseArgs(argv) {
  const a = { old3: null, old4a: null, old4b: null, oldBase: null, oldR1: null, oldBaseR1: null, oldR2: null, oldBaseR2: null, oldR3: null, oldBaseR3: null, oldR4: null, oldBaseR4: null, oldR5: null, oldBaseR5: null, oldR6: null, oldBaseR6: null, oldR7: null, oldBaseR7: null, transcriptsDir: null, liveDb: null, only: null, keep: false, debug: false };
  const val = (i) => { if (argv[i + 1] === undefined) throw new SetupError(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist-3") a.old3 = resolve(val(i++));
    else if (argv[i] === "--old-dist-4a") a.old4a = resolve(val(i++));
    else if (argv[i] === "--old-dist-4b") a.old4b = resolve(val(i++));
    else if (argv[i] === "--old-base") a.oldBase = val(i++);
    else if (argv[i] === "--old-dist-r1") a.oldR1 = resolve(val(i++));
    else if (argv[i] === "--old-base-r1") a.oldBaseR1 = val(i++);
    else if (argv[i] === "--old-dist-r2") a.oldR2 = resolve(val(i++));
    else if (argv[i] === "--old-base-r2") a.oldBaseR2 = val(i++);
    else if (argv[i] === "--old-dist-r3") a.oldR3 = resolve(val(i++));
    else if (argv[i] === "--old-base-r3") a.oldBaseR3 = val(i++);
    else if (argv[i] === "--old-dist-r4") a.oldR4 = resolve(val(i++));
    else if (argv[i] === "--old-base-r4") a.oldBaseR4 = val(i++);
    else if (argv[i] === "--old-dist-r5") a.oldR5 = resolve(val(i++));
    else if (argv[i] === "--old-base-r5") a.oldBaseR5 = val(i++);
    else if (argv[i] === "--old-dist-r6") a.oldR6 = resolve(val(i++));
    else if (argv[i] === "--old-base-r6") a.oldBaseR6 = val(i++);
    else if (argv[i] === "--old-dist-r7") a.oldR7 = resolve(val(i++));
    else if (argv[i] === "--old-base-r7") a.oldBaseR7 = val(i++);
    else if (argv[i] === "--transcripts-dir") a.transcriptsDir = resolve(val(i++));
    else if (argv[i] === "--live-db") a.liveDb = resolve(val(i++));
    else if (argv[i] === "--only") a.only = val(i++).split(",").filter(Boolean);
    else if (argv[i] === "--keep") a.keep = true;
    else if (argv[i] === "--debug") a.debug = true;
    else throw new SetupError(`unknown argument ${argv[i]}`);
  }
  for (const [flag, dir, file] of [["--old-dist-3", a.old3, "decisions/registry.js"], ["--old-dist-4a", a.old4a, "capabilities/capability-runner.js"], ["--old-dist-4b", a.old4b, "capabilities/lesson-write.js"], ["--old-dist-r1", a.oldR1, "gateway/gateway.js"], ["--old-dist-r2", a.oldR2, "gateway/gateway.js"], ["--old-dist-r3", a.oldR3, "omp/planner-supervisor.js"], ["--old-dist-r4", a.oldR4, "omp/planner-supervisor.js"], ["--old-dist-r5", a.oldR5, "omp/turn-context.js"], ["--old-dist-r6", a.oldR6, "core/lanes/lookup-lane.js"], ["--old-dist-r7", a.oldR7, "notifications/telegram-notification-adapter.js"]]) {
    if (!dir || !existsSync(join(dir, file))) throw new SetupError(`${flag} <previous build's dist> is required (no ${file} at ${dir ?? "(unset)"})`);
  }
  return a;
}

function verifyProvenance(a) {
  let p3, p4, p5, p6, p7, p8, p9, p10, p11, p12;
  try {
    p3 = verifyOldDist(a.old3, NEW_DIST, "548cb87", "decisions/registry.js");
    p4 = verifyOldDist(a.old4a, NEW_DIST, "1451a66", "capabilities/capability-runner.js");
    p5 = verifyStampedDist(a.old4b, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBase ?? undefined));
    p6 = verifyStampedDist(a.oldR1, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR1 ?? undefined), "gateway/gateway.js");
    p7 = verifyStampedDist(a.oldR2, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR2 ?? undefined), "gateway/gateway.js");
    p8 = verifyStampedDist(a.oldR3, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR3 ?? undefined), "omp/planner-supervisor.js");
    p9 = verifyStampedDist(a.oldR4, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR4 ?? undefined), "omp/planner-supervisor.js");
    p10 = verifyStampedDist(a.oldR5, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR5 ?? undefined), "omp/turn-context.js");
    p11 = verifyStampedDist(a.oldR6, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR6 ?? undefined), "core/lanes/lookup-lane.js");
    p12 = verifyStampedDist(a.oldR7, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR7 ?? undefined), "notifications/telegram-notification-adapter.js");
  } catch (e) { throw new SetupError(e?.kind ? provenanceText(e) : "provenance: s3/s4a old build check failed"); }
  console.log(`s3  old build: worktree HEAD ${p3.head.slice(0, 12)}, registry.js ${p3.oldHash} (new ${p3.newHash})`);
  console.log(`s4a old build: worktree HEAD ${p4.head.slice(0, 12)}, capability-runner.js ${p4.oldHash} (new ${p4.newHash})`);
  console.log(`s4b old build pinned to merge base: worktree HEAD ${p5.head.slice(0, 12)}, dist stamp ${p5.hash.slice(0, 12)}`);
  console.log(`r1  old build pinned to merge base: worktree HEAD ${p6.head.slice(0, 12)}, dist stamp ${p6.hash.slice(0, 12)}`);
  console.log(`r2  old build pinned to merge base: worktree HEAD ${p7.head.slice(0, 12)}, dist stamp ${p7.hash.slice(0, 12)}`);
  console.log(`r3  old build pinned to merge base: worktree HEAD ${p8.head.slice(0, 12)}, dist stamp ${p8.hash.slice(0, 12)}`);
  console.log(`r4  old build pinned to merge base: worktree HEAD ${p9.head.slice(0, 12)}, dist stamp ${p9.hash.slice(0, 12)}`);
  console.log(`r5  old build pinned to merge base: worktree HEAD ${p10.head.slice(0, 12)}, dist stamp ${p10.hash.slice(0, 12)}`);
  console.log(`r6  old build pinned to merge base: worktree HEAD ${p11.head.slice(0, 12)}, dist stamp ${p11.hash.slice(0, 12)}`);
  console.log(`r7  old build pinned to merge base: worktree HEAD ${p12.head.slice(0, 12)}, dist stamp ${p12.hash.slice(0, 12)}`);
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
function firstSurvivingString(v, pair, path = [], omit = []) {
  if (typeof v === "string") return survives(path) && !/\b(tool|op)_[0-9A-Za-z]/.test(v) ? path : null;
  if (!v || typeof v !== "object" || (!Array.isArray(v) && NEW_ROW_IDS[pair[0]].has(v.entry_id))) return null;
  for (const k of Object.keys(v).sort()) {
    if (omit.includes(k) || !survives([k])) continue;
    const r = firstSurvivingString(v[k], pair, [...path, k], omit);
    if (r) return r;
  }
  return null;
}

/**
 * The planted divergence, checked on the new side alone (a real old/new difference can neither satisfy nor hide it): the raw
 * new projection must equal itself, and with one byte appended to its first surviving string leaf compare must report exactly one path.
 */
function selfTest(corpus, item, rawNew, pair) {
  const path = firstSurvivingString(rawNew, pair, [], ownOmit(rawNew, pair));
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
  if (corpus.finish) await corpus.finish(ctx, items); // an optional corpus-wide pin; it reports through requireNew
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
  Object.assign(DISTS, { new: NEW_DIST, s3: args.old3, s4a: args.old4a, s4b: args.old4b, r1: args.oldR1, r2: args.oldR2, r3: args.oldR3, r4: args.oldR4, r5: args.oldR5, r6: args.oldR6, r7: args.oldR7 });
  const corpora = await loadCorpora(args.only);
  try { initTemp(args.keep); } catch (e) { throw new SetupError(`temp root: ${e instanceof Error ? e.message : String(e)}`); }
  const ctx = { dists: { new: await loadDist(NEW_DIST), s3: await loadDist(args.old3), s4a: await loadDist(args.old4a), s4b: await loadDist(args.old4b), r1: await loadDist(args.oldR1), r2: await loadDist(args.oldR2), r3: await loadDist(args.oldR3), r4: await loadDist(args.oldR4), r5: await loadDist(args.oldR5), r6: await loadDist(args.oldR6), r7: await loadDist(args.oldR7) },
    transcriptsDir: args.transcriptsDir, liveDb: args.liveDb, mkTemp };
  let allOk = true;
  try { for (const corpus of corpora) allOk = (await runCorpus(corpus, ctx)) && allOk; } finally { await runClosers(); }
  console.log(allOk ? "\nSTAGE 4 DIFFERENTIAL: PASS" : "\nSTAGE 4 DIFFERENTIAL: FAIL");
  return allOk ? 0 : 1;
}

process.on("SIGINT", () => { cleanupTemp(); process.exit(130); });
process.on("SIGTERM", () => { cleanupTemp(); process.exit(143); });
process.on("SIGHUP", () => { cleanupTemp(); process.exit(129); });
const DEBUG = process.argv.includes("--debug");
function report(e) {
  if (e instanceof SetupError) return `differential setup error: ${e.message}`;
  if (DEBUG) return `differential unexpected error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
  return `unexpected error in ${state.where ?? "setup"} (detail withheld; rerun with --debug)`;
}
main().then((c) => { cleanupTemp(); process.exit(c); },
  (e) => { console.error(report(e)); cleanupTemp(); process.exit(2); });
