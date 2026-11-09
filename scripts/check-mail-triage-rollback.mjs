#!/usr/bin/env node
// Rollback check — SP2 mail triage (spec 2026-11-09 §9 "Unchanged behaviour"; plan Task 12).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/check-mail-triage-rollback.mjs \
//     --old-dist <main checkout>/.worktrees/base-<12-char sha>/dist [--old-base <full sha>] [--live-db <path>]
// --old-base <full sha>: only after the merge (the merge base is then this build's own HEAD); on the branch the merge base is discovered.
// Provenance file: run/run-store.js (the slice added the mail tables and methods there); the old dist must have no mail/ module.
// The slice adds five additive tables (mail_items, mail_sender_rules, mail_labels, mail_senders, mail_state), one schema_migrations row and
// decisions rows at the new stage `inbound` (entry mail.triage). One VACUUM copy F of the live DB: this build opens it (its migration
// runs) and seeds it through its real paths — two mails through triageOne (a fake Jev answer: one `ping` with its mail_card outbox row, one
// `inbox`), a third item stored `inbox`/`folded` directly (the real fold needs six pings in an hour), one `never` rule through
// applySenderRule (with its /changes line), one label, and the mail_state switch. The old build then opens F: it must run no migration,
// render /status (its mail.triage count line equals the line built from SQL) and /status decisions, list every decision, and leave every
// tracked row byte-identical. This build then reopens F and reads the mail rows back.
// Exit 0 PASS · 1 FAIL · 2 setup error. The live DB is read only by VACUUM INTO; every write goes to the copy under /tmp/hg-s4d-*, removed
// on every exit path. Pins set before any store opens and restored on exit: HOUGE_DAEMON_TMP_DIR / HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH /
// HOUGE_PARK_MARKER_PATH under the temp root, HOUGE_TELEGRAM_CHAT_ID = -1003; the Telegram token and user id deleted. No network, no omp, no
// Telegram client: the card row is written, never dispatched. Only line names, counts, lanes, reason codes and error codes from closed sets
// are printed; synthetic example.com mail only, and no mail text is ever printed.
import { existsSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyStampedDist } from "./old-dist-provenance.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const MT = "mail.triage";
const STUB_CHAT = "-1003"; // numeric, not a real chat
const TABLES = ["mail_items", "mail_sender_rules", "mail_labels", "mail_senders", "mail_state", "decisions", "notification_outbox", "change_log", "incidents"];
const SET_PINS = ["HOUGE_DAEMON_TMP_DIR", "HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_PARK_MARKER_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID", "HOUGE_MAIL_ENABLED", "HOUGE_MAIL_QUIET"];
/** The env the seeding deps see: the flag on, the stub chat; never process.env. */
const SEED_ENV = { HOUGE_MAIL_ENABLED: "1", HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT };
const failures = [];
const saved = {};
const J = (o) => JSON.stringify(o);
const same = (a, b) => J(a) === J(b);
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const handles = [];
const yieldLoop = () => new Promise((r) => setImmediate(r)); // lets a SIGINT/SIGTERM handler run during an otherwise synchronous run

const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError", "AbortError", "DecisionRejected", "DecisionFlushFailed"]);
const SYSTEM_CODES = new Set(["ERR_SQLITE_ERROR", "ERR_MODULE_NOT_FOUND", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_STATE", "ERR_ASSERTION",
  "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CONSTRAINT", "SQLITE_CORRUPT", "SQLITE_FULL", "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_CANTOPEN",
  "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOSPC", "EBUSY", "EISDIR", "ENOTDIR", "EMFILE", "ETIMEDOUT", "ECONNREFUSED", "ESRCH"]);
/** A thrown value prints as a standard class name and a system code from a closed set, never its message. */
function errCode(e) {
  const name = e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error";
  const code = typeof e?.code === "string" ? (SYSTEM_CODES.has(e.code) ? ` ${e.code}` : " <other>") : "";
  return `${name}${code}`;
}

/** VACUUM INTO `to` from `from` (read-only source); a daemon write lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt_ = 1; ; attempt_++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { if (attempt_ >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
function openStore(d, path) {
  const store = d.RunStore.open(path, d.storeOptionsFor ? d.storeOptionsFor(undefined, {}) : {});
  handles.push(store);
  return store;
}
const closeStore = (s) => { try { s.close(); } catch { /* a closed handle is not a finding */ } };
const ro = (path, fn) => { const db = new DatabaseSync(path, { readOnly: true }); try { return fn(db); } finally { db.close(); } };
const hasTable = (db, t) => db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
const counts = (path) => ro(path, (db) => Object.fromEntries(TABLES.map((t) => [t, hasTable(db, t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : -1])));
/** The schema as a hash (every object's type, name, sql) plus user_version and every schema_migrations row: a migration changes it. */
const schemaOf = (path) => ro(path, (db) => ({
  uv: db.prepare("PRAGMA user_version").get().user_version,
  hash: createHash("sha256").update(J(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all())).digest("hex").slice(0, 12),
  mig: createHash("sha256").update(J(db.prepare("SELECT * FROM schema_migrations ORDER BY rowid").all())).digest("hex").slice(0, 12)
}));
const canonRow = (r) => J(Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]])));
/** Every tracked table's rows, whole, as one hash per table (rowid order): a changed byte in any row changes it. */
const contentOf = (path) => ro(path, (db) => Object.fromEntries(TABLES.map((t) => [t, hasTable(db, t)
  ? createHash("sha256").update(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(canonRow).join("\n")).digest("hex").slice(0, 12) : "absent"])));
/** The mail.triage decision rows, the exact fields the old build must read back. */
const mtRows = (path) => ro(path, (db) => db.prepare("SELECT decision_id, tool_call_id, stage, rung, verdict, reason_code, p, run_id, entry_version FROM decisions WHERE entry_id = ? ORDER BY rowid").all(MT));
const mailItems = (path) => ro(path, (db) => db.prepare("SELECT item_id, gmail_message_id, from_address, lane, reason_code, decision_id, notification_id FROM mail_items ORDER BY rowid").all());
/** The outbox has no topic column: a mail card is the chat row keyed `mail:<gmail message id>` (triage.ts enqueueCard); `mail:inbox:` replies and `mail:fold:` cards are other keys. */
const CARD_KEYS = "idempotency_key LIKE 'mail:%' AND idempotency_key NOT LIKE 'mail:inbox:%' AND idempotency_key NOT LIKE 'mail:fold:%'";
const cardRowsOf = (db) => (hasTable(db, "notification_outbox") ? db.prepare(`SELECT notification_id, correlation_id, idempotency_key FROM notification_outbox WHERE ${CARD_KEYS}`).all() : []);

// ---- the /status count line for mail.triage, straight from SQL (digest.ts countLines format) ----
const WINDOW_MS = 24 * 60 * 60 * 1000;
const RUNG_ORDER = ["rule", "system_one", "model", "paco", "fail"]; const RUNG_LABEL = { rule: "code", system_one: "Jev", model: "model", paco: "you", fail: "fallback" };
const windowRows = (path, now) => {
  const since = new Date(Date.parse(now) - WINDOW_MS).toISOString();
  return ro(path, (db) => db.prepare("SELECT rung FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ?").all(MT, since, now));
};
function rungLine(rows) {
  const m = new Map(); for (const r of rows) m.set(r.rung, (m.get(r.rung) ?? 0) + 1);
  const known = RUNG_ORDER.filter((k) => m.has(k)).map((k) => `${RUNG_LABEL[k]} ${m.get(k)}`);
  const other = [...m.keys()].filter((k) => !RUNG_ORDER.includes(k)).sort().map((k) => `${k} ${m.get(k)}`);
  return `· ${MT} ${rows.length} — ${[...known, ...other].join(" · ")}`;
}
const mtLines = (lines) => lines.filter((l) => l.startsWith(`· ${MT} `));
const norm = (l) => l.replace(/\b\d\d-\d\d \d\d:\d\d\b/g, "<ts>");
/** The recent-list line for a seeded row, as the old build renders it (status-view.ts recentLine; run-less rows show "–"). */
const listLine = (r, label) => `<ts> · ${MT} · ${label(r.rung)} → ${r.verdict} · p ${r.p === null ? "–" : r.p.toFixed(2)} · run –`;

// ---- step 1: this build seeds F through its real paths ----
const answer = (choice, p) => ({ urgency: { type: "choice", choice, probabilities: { [choice]: p, [choice === "now" ? "later" : "now"]: 1 - p }, confidence: p }, kind: { type: "choice", choice: "action", probabilities: { action: 0.7 }, confidence: 0.7 }, model: "jev-rollback-fake" });
/** Synthetic Gmail metadata (example.com only); `internalDate` is now, so the item sits in every 24 h window. */
const meta = (id, from, subject) => ({ id, threadId: `t-${id}`, snippet: "synthetic snippet", labelIds: ["INBOX"], internalDate: String(Date.now()),
  payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }] } });
const seedDeps = (store, ask) => ({ store, chatId: STUB_CHAT, pacoAddress: "paco@example.com", env: SEED_ENV, now: () => new Date(), brokerRedact: (s) => s, ask: async () => ask });

async function seedF(ctx, path) {
  const s = openStore(ctx.dNew, path); // this build's migration runs here
  try {
    s.mailState(); // the switch row is write-on-read: created now, so the reopen below writes nothing
    const ping = await ctx.mail.triageOne(seedDeps(s, answer("now", 0.9)), meta("rb-mail-ping", "Ann Example <ann@example.com>", "Synthetic ping subject"), { known_sender: false, backfill: false });
    const inbox = await ctx.mail.triageOne(seedDeps(s, answer("later", 0.9)), meta("rb-mail-inbox", "News Example <news@example.com>", "Synthetic newsletter subject"), { known_sender: false, backfill: false });
    const nowIso = new Date().toISOString();
    s.insertMailItem({ item_id: `mi_${randomUUID()}`, gmail_message_id: "rb-mail-folded", gmail_thread_id: "t-rb-mail-folded", from_address: "fold@example.com", from_name: "Fold Example",
      known_sender: false, labels: ["INBOX"], important: false, received_at: nowIso, subject: "Synthetic folded subject", snippet: "synthetic snippet",
      lane: "inbox", kind: "action", reason_code: "folded", thread_followup: false, decision_id: null, notification_id: null, created_at: nowIso });
    const items = mailItemsOpen(s);
    const inboxItem = items.find((i) => i.gmail_message_id === "rb-mail-inbox"); const pingItem = items.find((i) => i.gmail_message_id === "rb-mail-ping");
    const rule = inboxItem ? ctx.mail.applySenderRule(s, inboxItem.item_id, "never", new Date()) : { ok: false, why: "no_item" };
    if (pingItem) s.insertMailLabel({ label_id: `ml_${randomUUID()}`, item_id: pingItem.item_id, label: "wrong_urgency", created_at: nowIso });
    s.setMailState({ enabled: true, enabled_at: nowIso, history_id: "4242", last_ok_at: nowIso });
    return { ping, inbox, rule, items };
  } finally { closeStore(s); }
}
const mailItemsOpen = (s) => s.db.prepare("SELECT item_id, gmail_message_id, lane, reason_code, decision_id, notification_id FROM mail_items ORDER BY rowid").all().map((r) => ({ ...r }));

/** Step 1 check: exactly the seeded shape, through the real paths where they exist. */
function checkSeeded(ctx, st) {
  const { F } = ctx; const { seed, before } = st;
  const items = mailItems(F); const rows = mtRows(F);
  const lanes = items.map((i) => `${i.lane}/${i.reason_code}`);
  const c = counts(F);
  const cardRows = ro(F, cardRowsOf);
  const pingItem = items.find((i) => i.gmail_message_id === "rb-mail-ping"); const inboxItem = items.find((i) => i.gmail_message_id === "rb-mail-inbox");
  const decisionsLinked = pingItem && inboxItem && rows.length === 2 && rows.every((r) => r.stage === "inbound" && r.rung === "system_one" && r.run_id === null)
    && same(rows.map((r) => r.decision_id), [pingItem.decision_id, inboxItem.decision_id]) && same(rows.map((r) => r.tool_call_id), [pingItem.item_id, inboxItem.item_id])
    && same(rows.map((r) => `${r.verdict}/${r.reason_code}`), ["ping/jev_now", "inbox/jev_later"]);
  const card = cardRows.length === before.cards + 1 && pingItem?.notification_id !== null
    && cardRows.some((r) => r.notification_id === pingItem?.notification_id && r.correlation_id === pingItem?.item_id && r.idempotency_key === "mail:rb-mail-ping");
  const rule = seed.rule.ok && ro(F, (db) => db.prepare("SELECT action FROM mail_sender_rules WHERE address = 'news@example.com'").get()?.action) === "never";
  const ok = seed.ping.stored && seed.ping.lane === "ping" && seed.inbox.stored && seed.inbox.lane === "inbox" && same(lanes, ["ping/jev_now", "inbox/jev_later", "inbox/folded"])
    && decisionsLinked && card && rule && c.mail_labels === 1 && c.mail_sender_rules === 1 && c.change_log === before.counts.change_log + 1 && c.decisions === before.counts.decisions + 2;
  check("this build seeded F through its real paths: triageOne stored one ping (jev_now, rung system_one, stage inbound, its mail_card outbox row) and one inbox (jev_later), a third item inbox/folded, applySenderRule wrote one never rule and one /changes line, one label, the switch on",
    ok, `items [${lanes.join(" ")}] · decisions +${c.decisions - before.counts.decisions} (want 2) linked ${Boolean(decisionsLinked)} · mail_card rows +${cardRows.length - before.cards} (want 1) · rules ${c.mail_sender_rules} labels ${c.mail_labels} · change_log +${c.change_log - before.counts.change_log} (want 1)`);
}

// ---- step 2: the merge base on F ----
async function oldSteps(ctx, path, now) {
  const { dOld, mOld } = ctx;
  const s = openStore(dOld, path); // the old build opens the copy; its migrations ran
  const r = { schemaAfterOpen: schemaOf(path) };
  await yieldLoop();
  r.status = mOld.decisionStatusLines(s, now);
  r.listText = mOld.decisionListText(s, process.env).split("\n");
  const all = s.listRecentDecisions(100_000);
  r.listedAll = all.length;
  r.readRows = all.map((x) => ({ ...x }));
  closeStore(s);
  return r;
}

async function setup() {
  if (!DIST.includes("/.worktrees/")) throw new SetupError("run from the worktree; never build in the main checkout");
  if (!arg("--old-dist")) throw new SetupError("usage: --old-dist <merge-base dist> [--old-base <full sha>] [--live-db <path>]");
  const oldDist = resolve(arg("--old-dist"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  let prov, base;
  try { base = mergeBaseOf(DIST, arg("--old-base")); prov = verifyStampedDist(oldDist, DIST, base, "run/run-store.js"); } catch (e) { throw new SetupError(provenanceText(e)); }
  if (existsSync(join(oldDist, "mail/poller.js"))) throw new SetupError("old dist has the mail module: not a pre-slice build");
  console.log(`old build pinned to base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, stamped dist ${prov.hash.slice(0, 12)}`);
  const root = initTemp(false);
  for (const k of [...SET_PINS, ...DELETE_PINS]) saved[k] = process.env[k];
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  for (const k of DELETE_PINS) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT });
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  for (const k of ["storeOptionsFor", "RunStore"]) if (!dNew[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  if (!dOld.RunStore) throw new SetupError("RunStore missing from the old dist");
  const mail = { ...(await import(join(DIST, "mail/triage.js"))), ...(await import(join(DIST, "mail/inbox.js"))) };
  for (const k of ["triageOne", "applySenderRule"]) if (!mail[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  const mods = async (dist) => ({ ...(await import(join(dist, "decisions/status-lines.js"))), ...(await import(join(dist, "decisions/status-view.js"))) });
  const [mNew, mOld] = [await mods(DIST), await mods(oldDist)];
  const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, F);
  return { dNew, dOld, mNew, mOld, mail, F, root };
}

/** Step 1: the pre-slice state of F, this build's migration and seeding, the snapshot the old build must leave intact. */
async function seedPhase(ctx, st) {
  const { F } = ctx;
  phase = "snapshot"; const before = { schema: schemaOf(F), counts: counts(F), cards: ro(F, cardRowsOf).length };
  check("the live copy has none of the five mail tables before this build opens it (the daemon runs the pre-slice build)", TABLES.slice(0, 5).every((t) => before.counts[t] === -1), `present ${TABLES.slice(0, 5).filter((t) => before.counts[t] !== -1).length} (want 0)`);
  phase = "seed F"; const seed = await seedF(ctx, F);
  st.before = before; st.seed = seed;
  const afterNew = schemaOf(F);
  check("this build's open migrated F: the five mail tables exist and exactly one schema_migrations row was added", !same(before.schema, afterNew) && TABLES.slice(0, 5).every((t) => counts(F)[t] >= 0)
    && ro(F, (db) => db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '2026-11-09-mail-triage'").get().n) === 1,
    `schema ${before.schema.hash} -> ${afterNew.hash} · migrations ${before.schema.mig} -> ${afterNew.mig}`);
  checkSeeded(ctx, st);
  st.snapF = { counts: counts(F), schema: afterNew, content: contentOf(F), rows: mtRows(F), items: mailItems(F) };
}
/** Step 2: the old build on F, and the no-migration and intact-rows checks. */
async function oldPhase(ctx, st) {
  const { F, mOld } = ctx; const { snapF } = st;
  await yieldLoop();
  const now = new Date(Date.now() + 60_000).toISOString();
  phase = "old build on F"; const of = await oldSteps(ctx, F, now);
  check("the old build opened F (its migrations ran) and every step (/status, /status decisions, list) completed without throwing", true);
  phase = "compare";
  const schF = schemaOf(F);
  check("the old build ran no migration: the schema (every object's sql, user_version, every schema_migrations row) is identical before and after its open",
    same(snapF.schema, of.schemaAfterOpen) && same(snapF.schema, schF), `${snapF.schema.hash} migrations ${snapF.schema.mig} uv ${snapF.schema.uv} -> ${schF.hash} / ${schF.mig}`);
  const lineF = mtLines(of.status); const want = rungLine(windowRows(F, now));
  const [head, ...listRows] = of.listText.map(norm);
  const wantTop = [...snapF.rows].reverse().map((r) => listLine(r, mOld.deciderLabel));
  const listOk = head.startsWith("🪜 ") && same(listRows.slice(0, 2), wantTop);
  check("the old build's /status renders exactly one mail.triage count line equal to the rung-count line built from SQL, and its /status decisions list has the two seeded rows on top",
    same(lineF, [want]) && listOk && of.listedAll === snapF.counts.decisions, `line [${lineF.join(" | ")}] = SQL-built ${same(lineF, [want])} · list top matches ${listOk} · listed ${of.listedAll}/${snapF.counts.decisions}`);
  const readBack = snapF.rows.map((r) => of.readRows.find((x) => x.decision_id === r.decision_id));
  const exact = snapF.rows.every((r, i) => readBack[i] && readBack[i].rung === r.rung && readBack[i].verdict === r.verdict && readBack[i].reason_code === r.reason_code && readBack[i].stage === r.stage && readBack[i].tool_call_id === r.tool_call_id);
  const after = { counts: counts(F), content: contentOf(F) };
  check("every tracked row is intact after the old build: counts the same, every table's full content hash equal, each seeded mail.triage row read back unchanged (stage inbound, rung, verdict, reason_code, tool_call_id)",
    same(after.counts, snapF.counts) && same(after.content, snapF.content) && exact && readBack.every(Boolean),
    `${TABLES.map((t) => `${t} ${snapF.counts[t]}->${after.counts[t]}`).join(" · ")} · content equal ${same(after.content, snapF.content)} · rows read ${readBack.filter(Boolean).length}/${snapF.rows.length} exact ${exact}`);
}
/** Step 3: this build reopens F and reads the mail rows. */
function reopenPhase(ctx, st) {
  const { F, mNew } = ctx; const { snapF } = st;
  phase = "reopen F"; const s = openStore(ctx.dNew, F);
  const now = new Date(Date.now() + 60_000).toISOString();
  const items = snapF.items.map((i) => s.getMailItem(i.item_id));
  const unseen = s.listUnseenInbox(30).map((i) => i.gmail_message_id);
  const rule = s.senderRule("news@example.com"); const state = s.mailState();
  const rungs = s.countMailDecisionRungs(new Date(Date.now() - 3_600_000).toISOString());
  const line = mtLines(mNew.decisionStatusLines(s, now));
  closeStore(s);
  const ok = items.every((i, k) => i && i.lane === snapF.items[k].lane && i.reason_code === snapF.items[k].reason_code && i.decision_id === snapF.items[k].decision_id && i.notification_id === snapF.items[k].notification_id)
    && same(unseen, ["rb-mail-inbox", "rb-mail-folded"]) && rule?.action === "never" && state.enabled === true && state.history_id === "4242" && rungs.system_one === 2 && rungs.fail === 0
    && same(line, [rungLine(windowRows(F, now))]) && same(contentOf(F), snapF.content);
  check("this build reopens F: the three items read back (lane, reason, decision and card links), /inbox lists the inbox and folded items, the never rule and the switch state are read, the Jev rung count is 2, its /status line equals SQL, and the reopen wrote nothing",
    ok, `items read ${items.filter(Boolean).length}/3 · unseen inbox ${unseen.length} (want 2) · rule ${rule?.action ?? "none"} · switch ${state.enabled} cursor set ${state.history_id !== null} · rungs Jev ${rungs.system_one} fail ${rungs.fail} · content equal ${same(contentOf(F), snapF.content)}`);
  const tomb = [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
  check("no houge.kill tombstone appeared in the cwd or the main checkout", tomb === 0, `found ${tomb} (want 0)`);
}
async function run(ctx) {
  const st = {};
  await seedPhase(ctx, st); await oldPhase(ctx, st); reopenPhase(ctx, st);
}

function restoreEnv() { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
/** Every exit path: handles closed, the copy removed, env restored. */
function onSignal(code) {
  for (const h of handles.splice(0)) closeStore(h);
  cleanupTemp(); restoreEnv(); process.exit(code);
}
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]]) process.on(sig, () => onSignal(code));
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.error(`${ev}: ${errCode(e)}`); onSignal(2); });

export async function main() {
  let root;
  try {
    const ctx = await setup(); root = ctx.root;
    try { await run(ctx); } catch (e) { check(`run — unexpected error at ${phase}: ${errCode(e)}`, false); }
    console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(e instanceof SetupError ? `setup_failed: ${e.message}` : `setup_failed: ${errCode(e)}`);
    process.exitCode = 2;
  } finally {
    for (const h of handles.splice(0)) closeStore(h);
    await runClosers();
    cleanupTemp();
    restoreEnv();
    if (root) console.error(`# temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
