#!/usr/bin/env node
// Live gate — loud degradation Part A, model tiers (spec 2026-11-02 §9 Part A; plan Task 12).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/live-gate-model-tiers.mjs [--live-db <path>] [--only <n>[,<n>]] [--dist <path>] [--debug]
// Six lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all six PASS (1 FAIL, 2 setup error). A catalogued
// non-planted model that answers model_missing prints `INFO model_missing <selector>` (the code working, spec §3), never a FAIL.
// Everything else goes to stderr, prefixed `# `. Only fixed codes, counts, booleans, closed labels and catalog selectors are printed:
// never a model reply, an error text, e.message, or any id of the live DB.
// THIS GATE SPENDS REAL SUBSCRIPTION QUOTA: one catalog read at setup, one in the tick, and about seven one-line probes
// ("Reply with exactly OK.") through the one-shot seat under profile `houge`, plus one tap probe: as the daemon's tick will.
// It never starts a planner child and never talks to Telegram (no client; the outbox of the copy is the only sink, deleted at exit).
// The live DB is opened read-only, once, by VACUUM INTO a temp copy under /tmp/hg-s4d-*, removed on every exit path (finally, SIGINT,
// SIGTERM, SIGHUP). The dist is the worktree's (`--dist` points at a scratch copy under .worktrees/ for the mutation reruns).
// Pins, set before any store opens and restored on exit:
//   HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root (P2), HOUGE_TELEGRAM_CHAT_ID = -1003 (P3, a numeric id that is no real chat),
//   HOUGE_MODEL_ROLES deleted (resolved mode); scheduler / radar / media flags deleted. HOUGE_OMP_BIN is read from the env file if set.
// --only <n>[,<n>]: assert only those lines plus the setup they need (lines 3-6 run the tick; line 6 needs the tick for the empty gemini-pro tier).
// 2026-11-03 (chat-is-for-paco): the real gemini-pro tier now contains gemini-4-argon (spec §6.1), so the live catalog has no EMPTY family tier
// and argon is no longer a card proposal. This gate keeps the card / tap-probe path covered by planting a SYNTHETIC empty family tier: it narrows
// the gemini-pro pattern in the loaded dist module (in memory only) to `-pro` ids, so only the planted gemini-3.1-pro is a member and argon is a
// proposal exactly as before the slice. The copy's card-tap override of judges:2 (Paco's 13:36 tap) is reset on the copy so seat 2 is the empty
// tier's unresolved seat. The real-tier behaviour (argon adopted, override retired) is live-gate-chat-is-for-paco.mjs.
// The tick's clock is P27: the copy's latest model_roles_resolved.resolved_at + 25 h, else the wall clock.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, canon, cleanupTemp, initTemp, redactForPrint } from "./stage4-diff-lib.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const DIST = resolve(arg("--dist") ?? new URL("../dist", import.meta.url).pathname);
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
const DEBUG = argv.includes("--debug");
const ONLY = arg("--only") ? new Set(arg("--only").split(",").map(Number)) : null;
const want = (n) => ONLY === null || ONLY.has(n);
const NEEDS_TICK = [3, 4, 5, 6].some(want);

const STUB_CHAT = "-1003";
const MIGRATION = "2026-11-02-loud-degradation";
const PLANTED = { provider: "google-antigravity", id: "gemini-3.1-pro", thinking: null };
const PLANTED_SELECTOR = `${PLANTED.provider}/${PLANTED.id}`;
const PROPOSAL = "gemini-4-argon";
const SYNTHETIC_PRO = /^gemini-(\d{1,2})(?:\.(\d{1,2}))?-pro$/; // members: the planted gemini-3.1-pro only; argon falls out of the tier and becomes a proposal
/** Spec §4.2 bootstrap, literal (Global Constraints): the heads that matched each tier and ran on 2026-11-01. */
const LITERAL_SEED = { "opus@anthropic": "claude-opus-5-5", "opus@antigravity": "claude-opus-5-5", "sonnet@anthropic": "claude-sonnet-5-5", "sonnet@antigravity": "claude-sonnet-5-5",
  "gemini-flash": "gemini-3.8-flash", "gemini-pro": null, "codex-sol": "gpt-6.1-sol", kimi: "k3" };
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS",
  "HOUGE_RATING_PENDING_MINUTES", "HOUGE_MODEL_ROLES"];
const out = [];
const G = { d: null, root: null, store: null, saved: null, cfg: null, catalog: null, roles: null, now: null, mark: 0, pre: null, tick: null, fresh: null };
const note = (s) => console.error(`# ${s}`);

function verdict(n, name, ok, detail) {
  out.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${name} — ${redactForPrint(detail)}`);
}
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError"]);
/** A thrown value prints as its standard class name only, never its message (--debug adds only the class name to stderr, never a message or stack). */
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");
async function runLine(n, name, fn) {
  if (!want(n)) return;
  try { const r = await fn(); verdict(n, name, r.ok, r.detail); } catch (e) {
    if (DEBUG) console.error(`# debug line ${n}: threw ${errCode(e)}`);
    verdict(n, name, false, `threw: ${errCode(e)}`);
  }
}

// ---- the live-DB copy ----
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** VACUUM INTO `to` from `from` (read-only source). The daemon writes the live DB: a lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
/** Whether the raw copy already holds this build's migration (read before RunStore.open runs it). */
function migrated(copy) {
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    return t ? db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION) !== undefined : false;
  } finally { db.close(); }
}

// ---- store helpers ----
const rows = (sql, ...a) => G.store.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const seqMark = () => G.store.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS m FROM ledger_events").get().m;
/** model_probe payloads after `mark`, oldest first. */
const probesAfter = (mark) => rows("SELECT payload_json FROM ledger_events WHERE event_type = 'model_probe' AND sequence > ? ORDER BY sequence", mark).map((r) => JSON.parse(r.payload_json));
const tierRows = () => Object.fromEntries(G.store.listModelTiers().map((r) => [r.tier, r]));
const outboxByKey = (like) => rows("SELECT idempotency_key, payload_json FROM notification_outbox WHERE idempotency_key LIKE ? ORDER BY created_at, rowid", like)
  .map((r) => ({ key: r.idempotency_key, payload: JSON.parse(r.payload_json) }));
const TIER_FIELDS = ["adopted", "previous", "adopted_at", "rejected_selector", "rejected_at"];
const sameFields = (a, b) => TIER_FIELDS.every((f) => (a?.[f] ?? null) === (b?.[f] ?? null));
const nullHeads = () => G.roles.resolveAll().filter((r) => r.head === null).map((r) => r.key);

// ---- line 1: the seed resolves every key to a head except judges:2 ----
function expectedHeadOf(key, heads, listed) {
  const m = /^judges:(\d+)$/.exec(key);
  const sel = m ? G.d.roleSelectors("judges", Number(m[1]), "resolved", heads) : G.d.roleSelectors(key, undefined, "resolved", heads);
  const k = (s) => `${s.provider}/${s.model}`;
  return { first: sel[0] ? k(sel[0]) : null, firstListed: sel.map(k).find((s) => listed.has(s)) ?? null, all: new Set(sel.map(k)) };
}
async function line1() {
  // A fresh migration is checked against the literal spec §4.2 seed (Global Constraints), not against the code's own SEED_HEADS.
  const rowsNow = G.store.listModelTiers();
  const seedRowsOk = !G.fresh || (rowsNow.length === Object.keys(LITERAL_SEED).length
    && Object.entries(LITERAL_SEED).every(([t, a]) => { const r = rowsNow.find((x) => x.tier === t); return r !== undefined && r.adopted === a && r.previous === null; }));
  const heads = G.d.tierHeadsOf(G.fresh ? Object.entries(LITERAL_SEED).map(([tier, adopted]) => ({ tier, adopted, previous: null })) : rowsNow);
  const listed = new Set([...G.catalog, PLANTED].map((c) => `${c.provider}/${c.id}`));
  const resolved = G.roles.resolveAll();
  const withoutHead = resolved.filter((r) => r.head === null).map((r) => r.key);
  let fallbacks = 0; let mismatched = 0;
  for (const r of resolved) {
    const e = expectedHeadOf(r.key, heads, listed);
    const headKey = r.head === null ? null : r.head.replace(/:[a-z]+$/, "");
    if (r.source === "override") continue; // a live /models override on the copy is Paco's, not the seed's
    if (headKey !== null && !e.all.has(headKey)) fallbacks += 1;
    if (headKey !== e.firstListed) mismatched += 1;
  }
  const overridden = resolved.filter((r) => r.source === "override").length;
  const ok = canon(withoutHead) === canon(["judges:2"]) && fallbacks === 0 && mismatched === 0 && seedRowsOk;
  return { ok, detail: `null_heads=[${withoutHead}] (want [judges:2]) fallbacks=${fallbacks} (want 0) head_mismatches=${mismatched} (want 0) seed_rows_literal=${seedRowsOk} keys=${resolved.length} overridden_on_copy=${overridden} ${G.fresh ? "fresh_migration (seed)" : "already_migrated (compared against the copy's rows)"}` };
}

// ---- line 2: static judge seat 2 stays empty ----
async function line2() {
  const staticLen = G.d.staticRoleChains().judges.length;
  const seat = G.d.judgeSeat(G.d.resolveOmpConfig(process.env, G.roles.chains()), 2);
  const chain2 = G.roles.chains().judges[2];
  const ok = staticLen === 2 && seat.length === 0 && chain2 === undefined;
  return { ok, detail: `static_judges=${staticLen} (want 2) judgeSeat2_len=${seat.length} (want 0) chains_judges2_undefined=${chain2 === undefined} (want true)` };
}

// ---- the tick (run once; lines 3-6 read what it left) ----
async function runTick() {
  const catalog = [...G.catalog, PLANTED];
  G.pre = G.store.listModelTiers().map((r) => ({ ...r }));
  G.plans = G.pre.filter((r) => G.d.isTierId(r.tier)).map((r) => G.d.planTier({ tier: r.tier, adopted: r.adopted, previous: r.previous, adopted_at: r.adopted_at,
    rejected_selector: r.rejected_selector, rejected_at: r.rejected_at }, catalog, G.now));
  G.mark = seqMark();
  const notices = []; const cards = [];
  const result = await G.d.runModelRolesTick({ store: G.store, roles: G.roles, probe: argv.includes("--no-probes") ? undefined : G.d.ompProbe(G.store, G.cfg), now: G.now, // --no-probes: dev only, with --only 5 (no quota)
   
    notify: (t) => notices.push(t), card: (c) => cards.push(c) });
  G.tick = { result, notices, cards, probes: probesAfter(G.mark), after: tierRows() };
  note(`tick ran=${result.ran} probes=${G.tick.probes.length} notices=${notices.length} cards=${cards.length}`);
}

// ---- line 3: the planted gemini-3.1-pro is retired, once, and changes nothing ----
async function line3() {
  const gp = G.tick.probes.filter((p) => p.tier === "gemini-pro");
  const wantRow = { tier: "gemini-pro", selector: PLANTED_SELECTOR, purpose: "head", result: "model_missing", kind: "model_missing" };
  const t = G.tick.after["gemini-pro"];
  const failed = G.tick.notices.filter((n) => n === G.d.failedLine(PLANTED_SELECTOR, null)).length;
  const ok = gp.length === 1 && canon(gp[0]) === canon(wantRow) && t !== undefined && t.adopted === null && t.rejected_selector === PLANTED_SELECTOR && failed === 1;
  return { ok, detail: `gemini_pro_probe_rows=${gp.length} (want 1) row_exact=${gp.length === 1 && canon(gp[0]) === canon(wantRow)} kind=${gp[0]?.kind ?? "none"} adopted_null=${t?.adopted === null} rejected_is_planted=${t?.rejected_selector === PLANTED_SELECTOR} failed_notices=${failed} (want 1)` };
}

// ---- line 4: every other real probe has applyProbe's exact effect; no silent loss ----
async function line4() {
  const planned = G.plans.filter((p) => p.probe !== null);
  const probes = G.tick.probes; const bad = [];
  const results = { pass: 0, inconclusive: 0, model_missing: 0 };
  for (const p of probes) {
    if (!(p.result in results)) bad.push("result_outside_set"); else results[p.result] += 1;
    if (p.result === "model_missing" && p.selector !== PLANTED_SELECTOR) console.log(`INFO model_missing ${p.selector}`);
  }
  const probedTiers = probes.map((p) => p.tier).sort();
  if (canon(probedTiers) !== canon(planned.map((p) => p.state.tier).sort())) bad.push("probe_count");
  for (const plan of G.plans) {
    const row = probes.find((p) => p.tier === plan.state.tier);
    const o = row ? { result: row.result, kind: row.kind } : null;
    const exp = G.d.applyProbe(plan, o, G.now);
    if (!sameFields(G.tick.after[plan.state.tier], exp)) bad.push("effect");
    if (row && !explicitEffect(plan, row, G.tick.after[plan.state.tier])) bad.push("explicit");
  }
  const heads = nullHeads();
  const ok = bad.length === 0 && canon(heads) === canon(["judges:2"]);
  return { ok, detail: `probes=${probes.length} (want ${planned.length}) pass=${results.pass} inconclusive=${results.inconclusive} model_missing=${results.model_missing} effect_violations=${bad.length} (want 0) null_heads=[${heads}] (want [judges:2])` };
}
/** The spec's per-result reading of applyProbe, stated independently of the dist's own function. */
function explicitEffect(plan, row, after) {
  const before = plan.state;
  if (row.result === "pass") {
    return plan.probe.purpose === "head"
      ? after.adopted === plan.probe.id && after.previous === (before.adopted ?? before.previous)
      : after.previous === plan.probe.id && after.adopted === before.adopted;
  }
  if (row.result === "model_missing") return after.adopted === before.adopted && after.previous === before.previous && after.rejected_selector === row.selector;
  return sameFields(after, before);
}

// ---- line 5: exactly one card, and it renders ----
async function line5() {
  const cards = G.tick.cards;
  const c = cards[0];
  const one = cards.length === 1 && c.tier === "gemini-pro" && canon(c.keys) === canon(["judges:2"]) && c.proposals[0] === PROPOSAL;
  let rowOk = false; let total = -1; let added = -1;
  if (one) {
    const date = G.d.formatInstantInZone(G.now, G.d.resolveDisplayZone(process.env)).slice(0, 10);
    const target = `model_tier_card:gemini-pro:${date}`;
    // Dev seams, off by default: a card the daemon already sent today (pre-existing in the copy) and a duplicate under another key.
    if (argv.includes("--sim-existing-card")) G.d.enqueueTierCard(G.store, STUB_CHAT, G.now, c);
    const before = outboxByKey(`${target}%`).length; // the copy may already hold today's card; the key is idempotent
    G.d.enqueueTierCard(G.store, STUB_CHAT, G.now, c);
    if (argv.includes("--sim-duplicate-card")) {
      G.store.enqueueNotification({ topic: "model_card", target: { kind: "telegram", chat_id: STUB_CHAT }, intent_type: "progress", idempotency_key: `${target}-dup`, correlation_id: "model-roles", payload: { text: G.d.tierCardText(c) } });
    }
    const found = outboxByKey(`${target}%`);
    total = found.length; added = total - before;
    const r = found.find((x) => x.key === target);
    rowOk = total === 1 && added <= 1 && r !== undefined && r.payload.text === G.d.tierCardText(c)
      && r.payload.button_rows?.[0]?.[0]?.data === G.d.tierCallbackData("gemini-pro", PROPOSAL);
  }
  return { ok: one && rowOk, detail: `cards=${cards.length} (want 1) tier=${c?.tier ?? "none"} keys=[${c?.keys ?? ""}] first_proposal_is_${PROPOSAL}=${c?.proposals?.[0] === PROPOSAL} card_rows_for_key=${total} (want 1, pre-existing or new) added_by_run=${added} (want <=1) row_exact=${rowOk}` };
}

// ---- line 6: a simulated tap probes the proposal, writes the override, and judges:2 gets a head ----
async function line6() {
  const gw = new G.d.Gateway(G.store, undefined, undefined, undefined, { roles: G.roles, modelProbe: G.d.ompProbe(G.store, G.cfg) });
  const mark = seqMark(); const key = "gate-model-tiers:tap:1";
  const r = gw.intake(G.d.buildTypedTaskEvent({ source: "telegram", type: "model_tier_tap", requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: STUB_CHAT },
    idempotency_key: key, source_reference: `${key}:ref`, metadata: { tier: "gemini-pro", model_hash: G.d.tierModelHash(PROPOSAL) } }));
  await gw.whenTierTapsSettled();
  const probes = probesAfter(mark); const last = probes[probes.length - 1];
  const wantRow = { tier: "gemini-pro", selector: `google-antigravity/${PROPOSAL}`, purpose: "tap", result: "pass", kind: "ok" };
  const override = G.store.latestModelRoleOverrides().get("judges:2");
  const head = G.roles.resolveAll().find((x) => x.key === "judges:2")?.head;
  const replies = outboxByKey(`${key}:%`).map((x) => x.payload.text);
  const wantReplies = [`🔎 Checking \`${PROPOSAL}\` with one short prompt…`,
    `✅ \`${PROPOSAL}\` passed its check; judges:2 now uses it (an override: /models reset judges 2 undoes it).`];
  const okReplies = replies.length === 2 && canon([...replies].sort()) === canon([...wantReplies].sort());
  const ok = r.ok && probes.length === 1 && canon(last) === canon(wantRow) && override === PROPOSAL && head === `google-antigravity/${PROPOSAL}` && okReplies;
  return { ok, detail: `intake_ok=${r.ok} tap_probe_rows=${probes.length} (want 1) row_exact=${canon(last) === canon(wantRow)} kind=${last?.kind ?? "none"} override_written=${override === PROPOSAL} judges2_head_is_proposal=${head === `google-antigravity/${PROPOSAL}`} reply_rows=${replies.length} (want 2) replies_exact=${okReplies}` };
}

// ---- main ----
function pinEnv(root) {
  G.saved = Object.fromEntries([...SET_PINS, ...DELETE_PINS].map((k) => [k, process.env[k]]));
  for (const k of DELETE_PINS) delete process.env[k];
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT });
}
function restoreEnv() {
  if (!G.saved) return;
  for (const [k, v] of Object.entries(G.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  G.saved = null;
}
/** HOUGE_OMP_BIN only, from the env file (the daemon's omp); nothing else of the file is read or printed. */
function ompBinFromEnvFile(envFile) {
  try { return /^HOUGE_OMP_BIN=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null; } catch { return null; }
}
const killFiles = () => [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
const load = async (rel) => import(join(DIST, rel));
async function loadDistModules() {
  const [store, roles, tiers, mroles, step, probe, tick, cmds, gw, ocfg, reg, cat, sched, rr] = await Promise.all([
    load("run/run-store.js"), load("omp/role-resolver.js"), load("omp/model-tiers.js"), load("omp/model-roles.js"), load("omp/tier-step.js"), load("omp/model-probe.js"),
    load("omp/model-roles-tick.js"), load("gateway/model-tier-commands.js"), load("gateway/gateway.js"), load("omp/omp-config.js"), load("llm/registry.js"),
    load("omp/model-catalog.js"), load("run/schedule-spec.js"), load("domain/types.js")]);
  const proDef = tiers.TIERS.find((t) => t.id === "gemini-pro");
  if (!proDef) throw new SetupError("gemini-pro tier missing from dist: rebuild");
  proDef.pattern = SYNTHETIC_PRO; // the synthetic empty family tier (see the header)
  const d = { RunStore: store.RunStore, storeOptionsFor: (await load("run/store-options.js")).storeOptionsFor, RoleResolver: roles.RoleResolver, tierHeadsOf: tiers.tierHeadsOf,
    isTierId: tiers.isTierId, roleSelectors: mroles.roleSelectors, staticRoleChains: mroles.staticRoleChains, planTier: step.planTier, applyProbe: step.applyProbe,
    ompProbe: probe.ompProbe, runModelRolesTick: tick.runModelRolesTick, failedLine: tick.failedLine, enqueueTierCard: cmds.enqueueTierCard, tierCardText: cmds.tierCardText,
    tierCallbackData: cmds.tierCallbackData, tierModelHash: cmds.tierModelHash, Gateway: gw.Gateway, resolveOmpConfig: ocfg.resolveOmpConfig,
    resolveOmpCatalogConfig: ocfg.resolveOmpCatalogConfig, judgeSeat: reg.judgeSeat, readOmpCatalog: cat.readOmpCatalog, formatInstantInZone: sched.formatInstantInZone,
    resolveDisplayZone: sched.resolveDisplayZone, buildTypedTaskEvent: rr.buildTypedTaskEvent };
  for (const [k, v] of Object.entries(d)) if (!v) throw new SetupError(`${k} missing from dist: rebuild`);
  return d;
}
async function setup() {
  const envFile = resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(envFile), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  if (killFiles() !== 0) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  const bin = ompBinFromEnvFile(envFile);
  const root = initTemp(false); G.root = root;
  pinEnv(root);
  if (bin && !process.env.HOUGE_OMP_BIN) process.env.HOUGE_OMP_BIN = bin;
  const copy = join(root, "houge.sqlite");
  vacuumInto(liveDb, copy);
  G.fresh = !migrated(copy);
  note(G.fresh ? "fresh_migration" : "already_migrated");
  G.d = await loadDistModules();
  G.store = G.d.RunStore.open(copy, G.d.storeOptionsFor(undefined, {}));
  G.cfg = G.d.resolveOmpConfig(process.env);
  if (G.store.latestModelRoleOverrides().has("judges:2")) { G.store.recordModelRoleOverride({ key: "judges:2", pattern: "", actor: "gate:model-tiers" }); note("judges:2 override reset on the copy (the card-tap override would hide the empty tier)"); }
  // Once the live daemon adopts gemini-4-argon, the copy's gemini-pro row is adopted and no card is owed: put it back to unadopted on the copy (mirrors the chat-is-for-paco gate).
  const pro = G.store.listModelTiers().find((t) => t.tier === "gemini-pro");
  if (pro && (pro.adopted !== null || pro.previous !== null || pro.rejected_selector !== null)) {
    G.store.writeModelTier({ tier: "gemini-pro", adopted: null, previous: null, adopted_at: null, rejected_selector: null, rejected_at: null }, new Date().toISOString());
    note("gemini-pro tier put back to unadopted on the copy");
  }
  G.catalog = await G.d.readOmpCatalog(G.d.resolveOmpCatalogConfig(process.env));
  if (!G.catalog || G.catalog.length === 0) throw new SetupError("catalog unavailable");
  G.roles = new G.d.RoleResolver({ store: G.store, env: () => process.env, readCatalog: async () => [...G.catalog, PLANTED] });
  if (!(await G.roles.refreshCatalog())) throw new SetupError("catalog refresh failed");
  const last = G.store.latestModelRolesResolved();
  G.now = last ? new Date(Date.parse(last.resolved_at) + 25 * 3_600_000).toISOString() : new Date().toISOString();
  note(`catalog models=${G.catalog.length} tick_clock=${last ? "latest+25h" : "wall"}`);
}
function closeAll() { try { G.store?.close(); } catch { /* a closed handle is not a finding */ } G.store = null; }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });

try {
  await setup();
  const lines = [[1, "seed_resolution", line1], [2, "static_seat_2", line2], [3, "planted_retired", line3], [4, "real_tick_no_silent_loss", line4],
    [5, "one_card", line5], [6, "tap_probe_then_override", line6]];
  await runLine(1, lines[0][1], line1);
  await runLine(2, lines[1][1], line2);
  if (NEEDS_TICK) {
    try { await runTick(); } catch (e) {
      if (DEBUG) console.error(`# debug tick: threw ${errCode(e)}`);
      note(`tick threw: ${errCode(e)}`); G.tick = null;
    }
  }
  const tickLines = new Set([3, 4, 5]);
  for (const [n, name, fn] of lines.slice(2)) {
    if (G.tick === null && (tickLines.has(n) || n === 6) && want(n)) { verdict(n, name, false, "the tick did not run"); continue; }
    await runLine(n, name, fn);
  }
  const tomb = killFiles();
  if (tomb !== 0) { out.push(false); console.log(`FAIL post houge.kill — found ${tomb} (want 0)`); }
  const expected = ONLY ? ONLY.size : 6;
  const passed = out.filter(Boolean).length;
  note(`${passed}/${out.length} PASS (${expected} expected) · houge.kill in cwd/main checkout ${tomb} (want 0)`);
  process.exitCode = out.length === expected && passed === expected ? 0 : 1;
  console.log(`${process.exitCode === 0 ? "PASS" : "FAIL"} gate — ${passed}/${expected} checks`);
} catch (e) {
  console.error(`setup_failed${e instanceof SetupError ? `: ${e.message}` : ""}`);
  if (DEBUG) console.error(`# debug: setup threw ${errCode(e)}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
