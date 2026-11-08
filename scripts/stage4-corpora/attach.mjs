// Slice R7 differential, attach corpus (spec 2026-11-08 R7 §6; plan Task 7). Pair: r7 (the merge-base build a3d7fa04) -> new. Two seams, one corpus:
//   parse items drive the dist's own PlannerSupervisor (scripts/stage4-supervisor-fixture.mjs, a final text per item, files seeded in chat 42's workspace AFTER mkSupervisor),
//   send items drive the dist's own NotificationOutbox + NotificationDispatcher + Telegram adapter (scripts/stage4-delivery-fixture.mjs, one shared event log).
// Each item runs on a fresh temp-file store under a pinned env (no tombstone in the cwd, no chat id for a recorder alert) and a counting clock. BOTH builds get a store recorder
// (the old supervisor records R1-R6 rows; the old dispatcher has no `recorder` option and records nothing); the new side's is counting. Compared (old vs new, ids scrubbed, clocks
// relabelled by order): parse = the session's ordered call log, the sink's done/failed/incidents, the whole-DB dump minus the attach.path rows; send = the shared event log minus the
// recorder entries, the outbox rows, the dispatch statuses, the dump minus the attach.path rows. `attach.path` changes no behaviour. REQUIRED on the new side: the exact rows
// [entry, rung, verdict, reason, run, tool_call] in write order, the exact per-entry recorder call count (P6 tally), and the behaviour facts, so a scenario that silently stopped
// reaching its branch fails too. The old build must hold no attach.path row. Faults (P20) plant on d.ATTACH_PATH (the new dist's module object; null on the old dist, where the
// item runs unplanted).
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DISTS, NEW_ROW_IDS, canon, compare, dumpDb, mkStore, mkTemp, regularTables, extraDropFilter, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { NOW, withCountingClock, withPinnedEnv } from "../stage4-intake-fixture.mjs";
import { countingRecorder } from "../stage4-sender-fixture.mjs";
import { deliver, removeDeliveryDirs } from "../stage4-delivery-fixture.mjs";
import { cleanup, fakeSession, heldSession, intakeRun, mkSupervisor, req, seedWorkspace, until } from "../stage4-supervisor-fixture.mjs";

const AP = "attach.path";
const MIB = 1024 * 1024;
/** One expected attach.path row: [entry, rung, verdict, reason, run, tool_call]. */
const R = (verdict, reason, rung = "rule", run = "a") => [AP, rung, verdict, reason, run, null];
const THREW = "threw"; // a rule that threw: the recorder stores no reason_code for it (rowOf: not a known code) — pinned below by the exact rows
const NO_STATE = { todoPhases: [], queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] } };
const routed = () => ({ triage: async () => ({ kind: "fallthrough", route: { role: "default", effort: null, verdict_id: "jv_1" } }) });

// parse drives -------------------------------------------------------------------------------------------------------------------------------------------------
const seedAndRun = async (x, files, name = "a") => { const id = x.run(name); x.seed(files); x.rig.sup.submit(req(id)); await x.rig.sup.whenIdle(); return id; };
/** One turn whose child answers `final` at once. */
const plain = (item) => async (x) => { x.mk({ session: fakeSession({ final: item.final }), ...(item.extra ?? {}) }); await seedAndRun(x, item.files ?? []); };
/** A child whose pass 0 and pass 1 are the given texts, with a rule send-back between them (the continuation is the second agent_start). `hold`: getState parks after the send-back. */
function sendBackSession(x, texts, hold = null) {
  let armed = false; let release = () => undefined; let held = false;
  const s = fakeSession({
    getState: () => (armed && hold ? new Promise((r) => { held = true; release = () => r(NO_STATE); }) : Promise.resolve(NO_STATE)),
    onPrompt: (_t, emit) => {
      emit({ type: "turn_start" }); emit({ type: "agent_start" }); s.assistant(texts[0]);
      x.rig.sup.activeTurnForTest().onSendBack("rule", ""); armed = true;
      emit({ type: "agent_start" }); s.assistant(texts[1]); emit({ type: "agent_end" });
    }
  });
  return { s, isHeld: () => held, release: () => release() };
}
const twoPasses = (texts) => async (x) => { const { s } = sendBackSession(x, texts); x.mk({ session: s }); await seedAndRun(x, []); };
/** A turn whose text is emitted and then /killed (no end signal from the child): the failure arm. */
const failedTurn = async (x) => {
  const s = fakeSession({ onPrompt: (_t, emit) => { emit({ type: "turn_start" }); s.assistant("ok\n[[attach: ../x]]"); void x.rig.sup.abortAll("killed"); } });
  x.mk({ session: s }); await seedAndRun(x, []);
};
/** /kill while the todo snapshot (the send-back flow's bounded getState) is parked: the turn then takes finishFailure. */
const killInSnapshot = async (x) => {
  const sb = sendBackSession(x, ["ok\n[[attach: ../x]]", "ok\n[[attach: ../x]]"], true); x.mk({ session: sb.s });
  const id = x.run("a"); x.seed([]); x.rig.sup.submit(req(id));
  await until(() => sb.isHeld()); x.note("snapshot_held", true);
  const killed = x.rig.sup.abortAll("killed"); sb.release(); await killed; await x.rig.sup.whenIdle();
};
/** A second run steered into the live turn: the parent's final text carries the refused marker; the merged run is completed by the parent. */
const merged = async (x) => {
  const h = heldSession(); x.mk({ session: h.session }); x.seed([]);
  const a = x.run("a", "u"); const b = x.run("b", "steer me");
  x.rig.sup.submit(req(a, "u")); await h.live(1, x.rig.sup); x.rig.sup.submit(req(b, "steer me")); h.end("r\n[[attach: ../x]]"); await x.rig.sup.whenIdle();
};
/** store.recordChatTurn throws for the assistant role (the parse row precedes it, spec §4.0). */
const chatTurnThrows = async (x) => {
  const orig = x.store.recordChatTurn.bind(x.store);
  x.store.recordChatTurn = (t) => { if (t.role === "assistant") throw new Error("planted recordChatTurn"); return orig(t); };
  x.mk({ session: fakeSession({ final: "ok\n[[attach: ../x]]" }) }); await seedAndRun(x, []);
};
/** P20: a registry mistake — the entry's ladder holds a non-rule rung, so decideSync throws before any recorder. */
const MISTAKE = [{ kind: "system_one", name: "x", questions: [], bars: { kind: "provisional", question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "t" }, timeoutMs: 1 }];

// send drives --------------------------------------------------------------------------------------------------------------------------------------------------
/** The new side's recorder for a send item: `throws` makes record() throw past itself; the old side's is the plain store recorder (its dispatcher ignores it). */
const sendOf = (spec) => async (x) => { await x.deliver(spec); };
const names = (n, kind = "file") => Array.from({ length: n }, (_, i) => [`f${i + 1}.txt`, kind]);
/** P22: accepted at parse (supervisor, chat 42), swapped for a symlink out before the delivery; the adapter's workspace is the supervisor's chat-42 one. */
async function parseOkSendSwapped(x) {
  x.mk({ session: fakeSession({ final: "ok\n[[attach: r.txt]]" }) });
  const id = await seedAndRun(x, [["r.txt", "file"]]);
  const accepted = x.rig.outcome.done[0].attachments; const data = x.rig.data; const ws = x.d.chatWorkspace(data, "42");
  const out = join(data, "outside.txt"); writeFileSync(out, "outside"); rmSync(join(ws, "r.txt")); symlinkSync(out, join(ws, "r.txt"));
  x.store.enqueueFinalReportNotification(id, { text: "here you go", report_path: "r.md", attachments: accepted });
  const log = [];
  const tg = { sendMessage: async (m) => { log.push(["sendMessage", "-", "HTML", m.text.startsWith("⚠") ? m.text : null]); return { message_id: log.length }; },
    sendDocument: async (doc) => { log.push(["sendDocument", doc.filename, doc.content.length]); } };
  const adapter = new x.d.TelegramNotificationAdapter(tg, { workspaceFor: () => x.d.chatWorkspace(data, "42") });
  const outbox = new x.d.NotificationOutbox(x.store);
  const dispatcher = new x.d.NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "local" }) }, telegram: adapter }, { recorder: x.recorder });
  const results = [(await dispatcher.dispatchOnce("fixture")).status];
  x.sends.push({ log, calls: [], results, outbox: x.store.db.prepare("SELECT state, attempt_count, provider_message_id FROM notification_outbox ORDER BY rowid").all(), run: id, paths: accepted });
}

// items ---------------------------------------------------------------------------------------------------------------------------------------------------------
const OKD = (text, attachments = []) => ({ text, attachments });
const parse = (key, drive, rows, calls, facts) => ({ key, seam: "parse", drive, rows, calls: { [AP]: calls }, facts: { failed: [], incidents: [], ...facts } });
const send = (key, spec, rows, calls, facts = {}, extra = {}) => ({ key, seam: "send", drive: sendOf(spec), rows, calls: { [AP]: calls }, facts: { states: ["delivered"], ...facts }, ...extra });
const MARKER_OUT = (text, files = []) => ({ final: `${text}\n[[attach: ../x]]`, files });
const P = (key, o, rows, calls, facts) => parse(key, plain(o), rows, calls, facts);
const refuse1 = [R("refuse", "marker_outside")];
const OVER = "more than 5 files"; const OUTSIDE = "outside my workspace"; const UNREAD = "could not be read";
const BIG = ["big.bin", "sparse", 21 * MIB];
const lineOf = (why, name) => `⚠ Not attached: ${name} (${why})`;

const ITEMS = [
  // parse (supervisor) ------------------------------------------------------------------------------------------------------------------------------------------
  P("inside_one", { final: "ok\n[[attach: in.txt]]", files: [["in.txt", "file"]] }, [], 1, { done: [OKD("ok", ["ws/in.txt"])] }),
  P("dotdot", MARKER_OUT("ok"), refuse1, 1, { done: [OKD("ok")] }),
  P("absolute_out", { final: "ok\n[[attach: /etc/hosts]]" }, refuse1, 1, { done: [OKD("ok")] }),
  P("symlink_out", { final: "ok\n[[attach: out.lnk]]", files: [["out.lnk", "symlink", "/etc/hosts"]] }, refuse1, 1, { done: [OKD("ok")] }),
  P("not_yet", { final: "ok\n[[attach: later.txt]]" }, [], 1, { done: [OKD("ok", ["ws/later.txt"])] }),
  parse("two_passes_same", twoPasses(["first\n[[attach: ../x]]", "second\n[[attach: ../x]]"]), refuse1, 1, { done: [OKD("second")] }),
  P("one_each", { final: "ok\n[[attach: in.txt]]\n[[attach: ../x]]", files: [["in.txt", "file"]] }, refuse1, 2, { done: [OKD("ok", ["ws/in.txt"])] }),
  parse("failed_turn", failedTurn, [], 0, { done: [], failed: ["killed"] }),
  parse("kill_in_snapshot", killInSnapshot, [], 0, { done: [], failed: ["killed"], notes: { snapshot_held: true } }),
  parse("merged", merged, refuse1, 1, { done: [OKD("r"), OKD("r")] }),
  { ...P("lane_reply", { final: "unused", extra: { extra: { triage: async () => ({ kind: "lane_reply", text: "lane\n[[attach: ../x]]", buttons: [] }) } } }, [], 0, { done: [OKD("lane")] }) },
  parse("chat_turn_throws", chatTurnThrows, refuse1, 1, { done: [OKD("ok")], chat: [], incidents: ["planner_turn_crashed"] }),
  { ...P("registry_mistake", { final: "ok\n[[attach: ../x]]", extra: { extra: routed() } }, [], 0, { done: [OKD("ok")], chat: ["ok"], routeEnds: ["planner_done"], logged: ["planner supervisor: attach_path_record_failed (Error)"] }), plant: { ladder: MISTAKE } },
  // send (delivery fixture) -------------------------------------------------------------------------------------------------------------------------------------
  send("one_regular", { files: [["a.txt", "file"]] }, [], 1, { uploads: ["a.txt"], lines: [] }),
  send("six_files", { files: names(6) }, [R("refuse", "over_count")], 6, { uploads: ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"], lines: [OVER] }),
  send("nine_files", { files: names(9) }, [R("refuse", "over_count")], 6, { uploads: ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"], lines: [OVER, OVER, OVER, OVER] }),
  send("too_large", { files: [BIG] }, [R("refuse", "too_large")], 1, { uploads: [], lines: ["over 20 MB"] }),
  send("directory", { files: [["d1", "dir"]] }, [R("refuse", "not_a_file")], 1, { uploads: [], lines: ["not a regular file"] }),
  send("fifo", { files: [["p1", "fifo"]] }, [R("refuse", "not_a_file")], 1, { uploads: [], lines: ["not a regular file"] }, { boundMs: 2000 }),
  send("hard_link", { files: [["h1.txt", "hardlink"]] }, [R("refuse", "linked")], 1, { uploads: [], lines: ["a hard-linked file"] }),
  send("send_symlink_out", { files: [["s1.txt", "symlink_out"]] }, [R("refuse", "outside_workspace")], 1, { uploads: [], lines: [OUTSIDE] }),
  send("ws_swapped", { files: names(2), wsSwap: true }, [R("refuse", "workspace_unverified"), R("refuse", "workspace_unverified")], 2, { uploads: [], lines: [OUTSIDE, OUTSIDE] }),
  send("missing", { files: [["gone.txt", "missing"]] }, [R("refuse", "not_found")], 1, { uploads: [], lines: [UNREAD] }),
  send("mode000", { files: [["locked.txt", "mode000"]] }, [R("refuse", "unreadable")], 1, { uploads: [], lines: [UNREAD] }),
  send("swapped", { files: [["a.txt", "file"]], swap: "a.txt" }, [R("refuse", "changed")], 1, { uploads: [], lines: ["it changed while I was sending it"] }),
  send("no_send_document", { files: [["a.txt", "file"]], opts: { noDocument: true } }, [R("refuse", "unsupported")], 1, { uploads: [], lines: ["this chat cannot take files"] }),
  send("document_throws", { files: [["a.txt", "file"]], opts: { documentThrows: true } }, [], 1, { uploads: ["a.txt"], lines: ["Telegram refused the upload"] }),
  send("text_fails_then_ok", { files: [["a.txt", "file"], ["gone.txt", "missing"]], opts: { textFails: [1] }, attempts: 2 }, [R("refuse", "not_found")], 2,
    { results: ["failed", "delivered"], states: ["delivered"], markCount: 1, timing: { afterUploads: true, afterFollowUp: true, afterMark: true } }),
  send("runless_progress", { files: [["gone.txt", "missing"]], intent: "progress_runless" }, [R("refuse", "not_found", "rule", null)], 1, { uploads: [], lines: [UNREAD] }),
  { key: "parse_ok_send_swapped", seam: "both", drive: parseOkSendSwapped, rows: [R("refuse", "outside_workspace")], calls: { [AP]: 2 }, facts: { done: [OKD("ok", ["ws/r.txt"])], states: ["delivered"], uploads: [], lines: [OUTSIDE] } },
  // timing, lease and faults ------------------------------------------------------------------------------------------------------------------------------------
  send("write_timing", { files: [["a.txt", "file"], ["gone.txt", "missing"], ["c.txt", "file"]] }, [R("refuse", "not_found")], 3,
    { uploads: ["a.txt", "c.txt"], lines: [UNREAD], timing: { afterUploads: true, afterFollowUp: true, afterMark: true } }),
  send("lease", (d) => ({ files: [["a.txt", "file"]], insideRecorder: (store) => [
    store.recoverStaleSendingNotifications(new Date(Date.now() + 31_000).toISOString()).length, new d.NotificationOutbox(store).claimNext("second", 30) === null] }), [], 1,
    { inside: [["inside", 0, true]], texts: 1, uploads: ["a.txt"], lines: [] }),
  { ...parse("rule_throws_parse", plain({ final: "ok\n[[attach: in.txt]]\n[[attach: ../x]]", files: [["in.txt", "file"]] }), [R("refuse", null, "fail"), R("refuse", null, "fail")], 2, { done: [OKD("ok", ["ws/in.txt"])] }), plant: { decide: true } },
  { ...send("rule_throws_send", { files: [BIG, ["a.txt", "file"]] }, [R("refuse", null, "fail"), R("refuse", null, "fail")], 2, { uploads: ["a.txt"], lines: ["over 20 MB"] }), plant: { decide: true } },
  { ...send("insert_fault_send", { files: [BIG] }, [], 1, { uploads: [], lines: ["over 20 MB"], logged: ["decisions: attach.path record failed: planted insert fault"] }), insertFault: true },
  { ...send("recorder_throws", { files: [BIG, ["a.txt", "file"]] }, [], 2, { uploads: ["a.txt"], lines: ["over 20 MB"], logged: Array(2).fill("decisions: attach.path record threw past the recorder: planted recorder") }), recorderThrows: true }
];
for (const it of ITEMS) it.tags = [it.key];
const BRANCHES = ITEMS.map((i) => i.tags[0]);
/** D11: an insert fault writes THREE rows — the incident, its incident_opened ledger event and the incident_log change_log row. Exact shape; the item's dump excludes only these. */
const INSERT_FAULT_SHAPE = {
  counts: { incidents: 1, ledger: 1, change: 1 },
  incident: { kind: "decision_record_failed", subject: AP, detail: { entry: AP }, state: "open" },
  ledger: { event_type: "incident_opened", payload: { incident_id: "<incident>", kind: "decision_record_failed", subject: AP } },
  change: { topic: "incident_log", correlation_id: "<incident>" }
};

// projection ----------------------------------------------------------------------------------------------------------------------------------------------------
const isClockKey = (k) => /(_at|_since|^since|^now)$/.test(k);
const dropIds = [...NEW_ROW_IDS.r7];
const dropList = dropIds.map((i) => `'${i}'`).join(",");
const BARE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const TEMP_ROOT = /(?:\/[^/"\\\s]+)*\/(?:hsv|hdl)-[A-Za-z0-9]+/g;
/** Worker ids (`planner:<chat>:<uuid>`) carry a bare uuid scrubIds leaves alone; the supervisor/delivery temp roots are random. */
function scrubTemp(v) {
  const seen = new Map();
  return JSON.parse(JSON.stringify(v).replace(TEMP_ROOT, "<root>").replace(BARE_UUID, (m) => { if (!seen.has(m)) seen.set(m, `uuid#${seen.size + 1}`); return seen.get(m); }));
}
const durationClass = (n) => (n === 0 ? 0 : "+");
const classDurations = (db) => JSON.parse(JSON.stringify(db).replace(/\\"duration_ms\\":(\d+)/g, (_m, n) => `\\"duration_ms\\":\\"${durationClass(Number(n))}\\"`));
function labelRunOwners(v, ownerLabel) {
  if (Array.isArray(v)) return v.map((e) => labelRunOwners(e, ownerLabel));
  if (v === null || typeof v !== "object") return v;
  const out = {};
  for (const [k, e] of Object.entries(v)) { out[k] = labelRunOwners(e, ownerLabel); if (k === "run_id") out.run_label = typeof e === "string" ? ownerLabel(e) : e; }
  return out;
}
const all = (store, sql) => store.db.prepare(sql).all().map((r) => ({ ...r }));

// Coverage self-test: the dump must hold, per table, exactly the rows the DB holds (minus the attach.path decision rows dropped on purpose).
function tableCounts(store) {
  const counts = {};
  for (const { name } of regularTables(store)) {
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${name === "decisions" ? ` WHERE entry_id NOT IN (${dropList})` : extraDropFilter(name)}`).get().n;
    if (n > 0) counts[name] = n;
  }
  return counts;
}
const dumpCounts = (db) => Object.fromEntries(Object.entries(db).map(([t, rows]) => [t, rows.length]));
function checkCoverage(db, want) {
  const got = dumpCounts(db);
  if (canon(got) !== canon(want)) throw new Error(`coverage self-test: dump holds ${canon(got)}, the DB holds ${canon(want)}`);
}
/** The check must itself catch a dump that lost one row of a still-populated table (or a whole table). */
function omittedRowSelfTest(db, want) {
  const t = Object.keys(db).find((k) => db[k].length > 1) ?? Object.keys(db)[0];
  if (!t) return;
  const mutated = { ...db, [t]: db[t].slice(1) };
  if (!mutated[t].length) delete mutated[t];
  try { checkCoverage(mutated, want); } catch { return; }
  throw new Error(`coverage self-test is blind: a dump missing one row of ${t} passed`);
}

/** The three rows an insert fault writes, found by shape in the raw dump (null parts when absent); `drop` lists them for the item's exclusion (table + id). */
function insertFaultRows(raw) {
  const incs = (raw.incidents ?? []).filter((r) => r.kind === "decision_record_failed" && r.subject === AP);
  const id = incs[0]?.incident_id;
  const evs = (raw.ledger_events ?? []).filter((r) => r.event_type === "incident_opened" && JSON.parse(r.payload_json).incident_id === id);
  const logs = (raw.change_log ?? []).filter((r) => r.topic === "incident_log" && r.correlation_id === id);
  const sub = (v) => (v === id ? "<incident>" : v);
  const shape = { counts: { incidents: incs.length, ledger: evs.length, change: logs.length },
    incident: incs[0] ? { kind: incs[0].kind, subject: incs[0].subject, detail: JSON.parse(incs[0].detail_json), state: incs[0].state } : null,
    ledger: evs[0] ? { event_type: evs[0].event_type, payload: Object.fromEntries(Object.entries(JSON.parse(evs[0].payload_json)).map(([k, v]) => [k, sub(v)])) } : null,
    change: logs[0] ? { topic: logs[0].topic, correlation_id: sub(logs[0].correlation_id) } : null };
  const exclude = [...incs.map((r) => ({ table: "incidents", id: r.incident_id })), ...evs.map((r) => ({ table: "ledger_events", id: r.event_id })), ...logs.map((r) => ({ table: "change_log", id: r.change_id }))];
  return { shape, exclude };
}
const PK = { incidents: "incident_id", ledger_events: "event_id", change_log: "change_id" };
function without(db, exclude) {
  const out = { ...db };
  for (const { table, id } of exclude) { out[table] = out[table].filter((r) => r[PK[table]] !== id); if (!out[table].length) delete out[table]; }
  return out;
}

/** Runs the drive with the item's planted rule/ladder on the NEW dist's entry (P20); on the old dist (ATTACH_PATH null) it runs unplanted. */
async function withPlant(d, item, fn) {
  const e = d.ATTACH_PATH;
  if (item.plant && !e && d.dir === DISTS.new) throw new Error("fault item: ATTACH_PATH missing from the new dist");
  if (!item.plant || !e) return fn();
  const rung = e.ladder[0]; const origDecide = rung.decide; const origLadder = e.ladder;
  if (item.plant.decide) rung.decide = () => { throw new Error("planted"); };
  if (item.plant.ladder) e.ladder = item.plant.ladder;
  try { return await fn(); } finally { rung.decide = origDecide; e.ladder = origLadder; }
}
const bound = (p, ms, key) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error(`item ${key} exceeded its ${ms} ms bound`)), ms))]);

/** Send-side facts of one delivery, from its FULL event log (the recorder entries still in it). */
function sendFacts(s) {
  const at = (pred) => s.log.findIndex(pred); const lastAt = (pred) => s.log.findLastIndex(pred);
  const firstRec = at((e) => e[0] === "record"); const followUp = (e) => e[0] === "sendMessage" && typeof e[3] === "string";
  const lines = s.log.filter(followUp).flatMap((e) => e[3].split("\n")).map((l) => /\(([^)]*)\)$/.exec(l)?.[1] ?? l);
  return { uploads: s.log.filter((e) => e[0] === "sendDocument").map((e) => e[1]), lines, texts: s.log.filter((e) => e[0] === "sendMessage" && !followUp(e)).length,
    states: s.outbox.map((o) => o.state), results: s.results, markCount: s.log.filter((e) => e[0] === "markDelivered").length,
    inside: s.log.filter((e) => e[0] === "inside"),
    timing: firstRec < 0 ? null : { afterUploads: firstRec > lastAt((e) => e[0] === "sendDocument"), afterFollowUp: firstRec > lastAt(followUp), afterMark: firstRec > at((e) => e[0] === "markDelivered") } };
}
const produced = new Set(); // the reasons the new build actually wrote across this run's items (finish() pins it)

async function project(d, item) {
  const dir = mkTemp(`attach-${item.key}`);
  const isNew = d.dir === DISTS.new; const errs = []; const realErr = console.error;
  let store = null;
  console.error = (...a) => { const line = a.map(String).join(" "); errs.push(line); if (/teardown failed/.test(line)) realErr(line); };
  try {
    return await withPinnedEnv(join(dir, "pin"), () => withCountingClock(NOW, async () => {
      store = mkStore(d, "bare", join(dir, "attach.sqlite"));
      const inner = item.recorderThrows && isNew ? { record: () => { throw new Error("planted recorder"); } } : d.storeRecorder(store);
      const counting = isNew ? countingRecorder(inner) : null;
      const recorder = counting ? counting.recorder : inner;
      if (item.insertFault) { const orig = store.insertDecision.bind(store); store.insertDecision = (row) => { if (row.entry_id === AP) throw new Error("planted insert fault"); return orig(row); }; }
      const named = new Map(); const sends = []; const notes = {}; let rig = null;
      const x = { d, store, recorder, sends, note: (k, v) => { notes[k] = v; }, get rig() { return rig; },
        run: (name, text = "hi") => { const id = intakeRun(d, store, text, name); named.set(id, name); return id; },
        mk: (opts = {}) => { rig = mkSupervisor(d, store, { ...opts, recorder }); return rig; },
        seed: (files) => seedWorkspace(d, rig.data, files),
        deliver: async (spec) => { const r = await bound(deliver(d, store, { ...(typeof spec === "function" ? spec(d) : spec), recorder }), item.boundMs ?? 20_000, item.key); if (r.run) named.set(r.run, "a"); sends.push(r); return r; } };
      try { await withPlant(d, item, () => item.drive(x)); } finally { await cleanup(); }
      const label = (id) => named.get(id) ?? id;
      const order = [...named.keys()]; const foreign = new Map();
      const ownerLabel = (id) => (order.includes(id) ? `r${order.indexOf(id) + 1}` : foreign.has(id) ? foreign.get(id) : (foreign.set(id, `other#${foreign.size + 1}`), foreign.get(id)));
      const newRows = all(store, `SELECT entry_id, rung, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id = '${AP}' ORDER BY rowid`).map((r) => [r.entry_id, r.rung, r.verdict, r.reason_code, label(r.run_id), r.tool_call_id]);
      if (!isNew && newRows.length) throw new Error("control failed: the old build wrote an attach.path decision row");
      if (isNew) for (const r of newRows) if (r[3]) produced.add(r[3]);
      if (existsSync(join(process.cwd(), "houge.kill"))) throw new Error("P2 failed: a houge.kill appeared in the cwd");
      const raw = dumpDb(store, { dropDecisionIds: dropIds }); const want = tableCounts(store);
      checkCoverage(raw, want); omittedRowSelfTest(raw, want);
      const fault = item.insertFault ? insertFaultRows(raw) : { shape: null, exclude: [] };
      const db = without(raw, fault.exclude);
      return finishProjection({ d, item, store, rig, sends, notes, errs, db, newRows, counting, label, ownerLabel, fault });
    }));
  } finally { console.error = realErr; removeDeliveryDirs(); try { store?.close(); } catch { /* closed */ } }
}

function finishProjection(c) {
  const { item, rig, sends, db, newRows, counting, label, ownerLabel, fault } = c;
  const seen = (list) => list.map(({ run_id, ...rest }) => ({ ...rest, ...("duration_ms" in rest ? { duration_ms: durationClass(rest.duration_ms) } : {}), run_id: label(run_id), run_label: ownerLabel(run_id) }));
  const ws = rig ? c.d.chatWorkspace(rig.data, "42") : null;
  const rel = (p) => { const r = ws ? relative(ws, p) : ""; return r && !r.startsWith("..") ? `ws/${r}` : p; };
  const observed = { sends: sends.map((s) => ({ log: s.log.filter((e) => e[0] !== "record" && e[0] !== "inside"), results: s.results, outbox: s.outbox })), db: classDurations(labelRunOwners(db, ownerLabel)) };
  const facts = { notes: c.notes, logged: c.errs.filter((l) => /attach_path_record_failed|record failed|threw past the recorder/.test(l)).map((l) => l.replace(/for \S+:/, "for <id>:")) };
  if (rig) {
    const { outcome } = rig;
    Object.assign(observed, { log: rig.session.log, done: seen(outcome.done), failed: seen(outcome.failed), incidents: outcome.incidents });
    Object.assign(facts, { done: outcome.done.map((o) => ({ text: o.text, attachments: (o.attachments ?? []).map(rel) })), failed: outcome.failed.map((o) => o.error_type), incidents: outcome.incidents.map((i) => i.k),
      routeEnds: outcome.routeEnds.map((r) => r.handler_outcome), chat: c.store.getChatTurnsAfter("42", undefined, 10).filter((t) => t.role === "assistant").map((t) => t.text) });
  }
  if (sends.length) Object.assign(facts, sendFacts(sends.at(-1)));
  if (item.insertFault) facts.shape = fault.shape;
  return { ...scrubTemp(scrubIds(relabelClocks(observed, isClockKey))), newRows, calls: { [AP]: counting?.calls[AP] ?? 0 }, facts, __strip: ["newRows", "calls", "facts", "payload_hash"] };
}

function required(d, item, proj) {
  requireNew(corpus, item, "attach.path rows (exact: entry, rung, verdict, reason, the consulting run, tool_call null, in write order)", canon(proj.newRows) === canon(item.rows), `got ${canon(proj.newRows)}, want ${canon(item.rows)}`);
  requireNew(corpus, item, "attach.path recorder calls (exact; P6 tally)", canon(proj.calls) === canon(item.calls), `got ${canon(proj.calls)}, want ${canon(item.calls)}`);
  for (const [k, want] of Object.entries(item.facts)) requireNew(corpus, item, `behaviour fact ${k} (exact)`, canon(proj.facts[k]) === canon(want), `got ${canon(proj.facts[k])}, want ${canon(want)}`);
  if (item.insertFault) requireNew(corpus, item, "insert fault: exactly the incident, the incident_opened ledger event and the incident_log change_log row (D11)", canon(proj.facts.shape) === canon(INSERT_FAULT_SHAPE), `got ${canon(proj.facts.shape)}, want ${canon(INSERT_FAULT_SHAPE)}`);
}

// Self-tests: determinism (the same item twice on the new build projects identically), the old build holds no attach.path row (project throws on one), and every
// reason the entry can refuse with is named by at least one item's expected rows (the run-time half is finish()).
async function load(ctx) {
  const reasons = ctx.dists.new.ATTACH_PATH.reasonCodes.filter((r) => r !== "parsed" && r !== "checked");
  const named = new Set(ITEMS.flatMap((i) => i.rows.map((r) => r[3])));
  const missing = reasons.filter((r) => !named.has(r));
  if (missing.length) throw new Error(`coverage self-test: no item names the reason(s) ${missing.join(", ")}`);
  for (const key of ["nine_files", "one_each"]) {
    const item = ITEMS.find((i) => i.key === key);
    const [a, b] = [await project(ctx.dists.new, item), await project(ctx.dists.new, item)];
    const diff = compare(corpus, item, a, b, corpus.pairs[0]);
    if (diff) throw new Error(`determinism self-test: two runs of ${key} project differently: ${diff.diff}`);
    await project(ctx.dists.r7, item); // control: throws if the old build wrote an attach.path row
  }
  produced.clear();
  return ITEMS;
}
async function finish(ctx) {
  const reasons = ctx.dists.new.ATTACH_PATH.reasonCodes.filter((r) => r !== "parsed" && r !== "checked");
  const gone = reasons.filter((r) => !produced.has(r));
  requireNew(corpus, { key: "(corpus)" }, "every refusal reason was produced by some item on the new build", gone.length === 0, `never produced: ${gone.join(", ")}`);
}

const corpus = { name: "attach", pairs: [["r7", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required, finish };
export default corpus;
