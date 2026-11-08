// The Slice R7 delivery fixture (spec R7 §6). Not a corpus. Drives a dist's real NotificationOutbox + NotificationDispatcher + Telegram adapter over a fresh store,
// a fake TelegramSendClient and a temp data dir in the verified layout (<data>/omp/workspace/chat-555). ONE shared event log records, in order, every client call
// (sendMessage: text sha + parse_mode; sendDocument: name, byte length, sha), every recorder call (entry, verdict, reason) and markDelivered. Nothing reads the live DB.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakeRun } from "./stage4-supervisor-fixture.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
export const CHAT = "555";
const dataDirs = new Set();
export function removeDeliveryDirs() { for (const d of [...dataDirs]) { try { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } dataDirs.delete(d); } }

/** A data dir whose chat-555 workspace is a real directory chain (verifiedWorkspace passes). */
export function mkData(d) {
  const data = mkdtempSync(join(tmpdir(), "hdl-")); dataDirs.add(data);
  const ws = d.chatWorkspace(data, CHAT); mkdirSync(ws, { recursive: true });
  return { data, ws };
}

/** files: Array<[name, kind, arg?]> — kind file | sparse (bytes) | dir | fifo | hardlink (outside target) | symlink_out | missing | mode000. Returns absolute paths in order. */
export function makeFiles(data, ws, files) {
  return files.map(([name, kind, arg]) => {
    const p = join(ws, name);
    if (kind === "file") writeFileSync(p, `bytes of ${name}`);
    else if (kind === "sparse") { writeFileSync(p, ""); truncateSync(p, arg); }
    else if (kind === "dir") mkdirSync(p);
    else if (kind === "fifo") execFileSync("mkfifo", [p]);
    else if (kind === "hardlink") { const out = join(data, `${name}.out`); writeFileSync(out, "outside"); linkSync(out, p); }
    else if (kind === "symlink_out") { const out = join(data, `${name}.out`); writeFileSync(out, "outside"); symlinkSync(out, p); }
    else if (kind === "mode000") { writeFileSync(p, "locked"); chmodSync(p, 0o000); }
    else if (kind !== "missing") throw new Error(`makeFiles: unknown kind ${kind}`);
    return p;
  });
}

/** The fake Telegram client: logs every call; `opts.noDocument` omits sendDocument; `opts.documentThrows`; `opts.textFails` (attempt numbers whose text fails both tries). */
function client(log, opts, attempt) {
  const c = {
    sendMessage: async (m) => { if (opts.textFails?.includes(attempt.n)) { log.push(["sendMessage_failed", m.parse_mode ?? "plain"]); throw new Error("HTTP 502"); }
      log.push(["sendMessage", sha(m.text), m.parse_mode ?? "plain", m.text.startsWith("⚠") ? m.text : null]); return { message_id: log.length }; }
  };
  if (!opts.noDocument) c.sendDocument = async (doc) => { log.push(["sendDocument", doc.filename, doc.content.length, sha(Buffer.from(doc.content))]); if (opts.documentThrows) throw new Error("HTTP 400"); };
  return c;
}

/**
 * One delivery. spec: { files, intent ("final_report" | "progress_runless"), recorder (the new side's store recorder or null), swap (rel name → renamed and replaced
 * between open and re-check), wsSwap (the workspace replaced by a symlink before dispatch), opts (client options), attempts (dispatchOnce calls, default 1),
 * insideRecorder (fn(store) run inside the first recorder call, P10) }. Both sides run the same spec; the old dispatcher ignores `recorder`.
 */
export async function deliver(d, store, spec) {
  const { data, ws } = mkData(d); const log = []; const attempt = { n: 0 }; const calls = [];
  const paths = makeFiles(data, ws, spec.files);
  const mark = store.markNotificationDelivered.bind(store);
  store.markNotificationDelivered = (id, p) => { log.push(["markDelivered"]); return mark(id, p); };
  const record = spec.recorder ? { record: (e, r, c) => { if (calls.length === 0 && spec.insideRecorder) log.push(["inside", ...spec.insideRecorder(store)]);
    calls.push([e.id, r.verdict, r.reason]); log.push(["record", e.id, r.verdict, r.reason]); return spec.recorder.record(e, r, c); } } : null;
  const run = spec.intent === "progress_runless" ? null : intakeRun(d, store, "deliver", `deliver:${paths.length}`);
  const outbox = new d.NotificationOutbox(store);
  if (run) store.enqueueFinalReportNotification(run, { text: "here you go", report_path: "r.md", attachments: paths });
  else outbox.enqueue({ topic: "reply", target: { kind: "telegram", chat_id: CHAT }, intent_type: "progress", idempotency_key: "p:1", correlation_id: "p:1", payload: { text: "here you go", attachments: paths } });
  if (spec.wsSwap) { renameSync(ws, `${ws}.real`); symlinkSync(`${ws}.real`, ws); }
  const tg = client(log, spec.opts ?? {}, attempt);
  const hook = spec.swap ? (p) => { if (p.endsWith(spec.swap)) { renameSync(p, `${p}.moved`); writeFileSync(p, "swapped in"); } } : undefined;
  const adapter = hook ? new d.TelegramNotificationAdapter(tg, { workspaceFor: (c) => d.chatWorkspace(data, c), beforeRecheckForTest: hook }) : d.workspaceTelegramAdapter(tg, data);
  const dispatcher = new d.NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "local" }) }, telegram: adapter },
    record ? { recorder: record } : {});
  const results = [];
  for (let i = 0; i < (spec.attempts ?? 1); i += 1) {
    attempt.n = i + 1; results.push((await dispatcher.dispatchOnce("fixture")).status);
    if (spec.attempts) { // Rev 1.2: a future requeue time leaves the row unclaimable (run-store.ts:7888, :7700)
      store.db.prepare("UPDATE notification_outbox SET next_attempt_at = ? WHERE state = 'retry_wait'").run(new Date(Date.now() - 60_000).toISOString());
      store.requeueRetryWaitNotifications(new Date().toISOString());
    }
  }
  const rows = store.db.prepare("SELECT state, attempt_count, provider_message_id FROM notification_outbox ORDER BY rowid").all();
  return { log, calls, results, outbox: rows, run, paths };
}
