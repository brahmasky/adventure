// A PlannerSupervisor over a dist module object (spec R3 §6): the narrow path of tests/helpers/supervisor-harness.ts without vitest or src/.
// `d` is a loadDist() result (scripts/stage4-diff-lib.mjs). The fake child plays the omp extension against the REAL bridge socket.
// Real timers only. Not a corpus (the CLI loads scripts/stage4-corpora/*.mjs only). Telegram, omp and Jev are stubbed; nothing leaves the process.
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEMORY_ROOT = new URL("../memory", import.meta.url).pathname;
const cleanups = [];
const dataDirs = new Set(); // every supervisor data dir created (/tmp/hsv-*) and not yet removed

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The extension's load-time handshake (src/omp/extension/bridge-client.ts): hello with the minted token, then one manifest request. */
function openManifestClient(sock, token) {
  return new Promise((resolve, reject) => {
    const s = connect(sock);
    s.once("error", reject);
    s.once("connect", () => {
      s.on("error", () => s.destroy());
      s.write(`${JSON.stringify({ id: "hello", kind: "hello", token })}\n`);
      s.write(`${JSON.stringify({ id: "r1", kind: "manifest" })}\n`);
      resolve(s);
    });
  });
}

/** Polls `fn` every 5 ms on real timers; rejects after `ms` (default 10 s) so a stuck fixture fails loud. */
export async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("fixture: until() timed out"); await wait(5); }
}
export const untilState = (sup, st, ms) => until(() => sup.state() === st, ms).catch(() => { throw new Error(`fixture: supervisor state ${sup.state()}, wanted ${st}`); });

/** An in-memory omp child. `script.holdStart`: a promise start() awaits first (hold-start); `script.onPrompt(text, emit)` replaces the default one-shot answer. */
export function fakeSession(script = {}) {
  const frameCbs = [], exitCbs = [], sockets = [];
  const emit = (f) => frameCbs.forEach((cb) => cb(f));
  const assistant = (text) => emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 2 }, stopReason: "stop" } });
  const s = {
    prompts: [], steers: [], models: [], log: [], options: [], assistant, emit,
    bind: (o) => { s.options.push(o); return s; },
    start: async () => {
      const o = s.options.at(-1);
      if (script.failStart) throw new Error("fixture start failed"); // R4: a plain start rejection is a crash exit (spawnFailed), at once
      if (script.holdStart) await script.holdStart;
      sockets.push(await openManifestClient(o.bridgeSock, o.bridgeToken));
      return { resumed: false, sessionId: "s" };
    },
    prompt: async (t) => { s.prompts.push(t); s.log.push(["prompt", t]); setTimeout(() => (script.onPrompt ?? ((_t, e) => { e({ type: "turn_start" }); assistant("answer"); e({ type: "agent_end" }); }))(t, emit), 5); },
    steer: async (t) => { s.steers.push(t); s.log.push(["steer", t]); },
    getState: async () => ({ todoPhases: [], queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] } }),
    abort: async () => { setTimeout(() => emit({ type: "agent_end", aborted: true }), 5); },
    // R6: `script.setModel(m, k)` runs after the log push and may throw: a refusal is `modelRefusal(d, k)`, a transport failure a plain Error.
    setModel: async (m) => { const k = `${m.provider}/${m.model}`; s.models.push(k); s.log.push(["set_model", k]); if (script.setModel) await script.setModel(m, k); }, newSession: async () => ({ cancelled: false }),
    onFrame: (cb) => { frameCbs.push(cb); }, onExit: (cb) => { exitCbs.push(cb); },
    stop: async () => { for (const k of sockets.splice(0)) k.destroy(); },
    /** R4: the ready child crashes (as tests/helpers/supervisor-harness.ts exit): sockets dropped, every exit callback told. */
    exit: (code) => { for (const k of sockets.splice(0)) k.destroy(); exitCbs.forEach((cb) => cb({ code, signal: null, stopped: false })); }
  };
  return s;
}

/** A child whose turns stay live until `end()`: `live(n, sup)` waits for the n-th prompt's turn_start and, given the supervisor, for its state to be RUNNING (hold-live); `end(text)` finishes the oldest live turn. */
export function heldSession(script = {}) {
  const ends = []; let live = 0;
  const session = fakeSession({ ...script, onPrompt: (_t, e) => {
    live += 1; e({ type: "turn_start" });
    ends.push((text) => { session.assistant(text); e({ type: "agent_end" }); });
  } });
  return { session, live: async (n = 1, sup) => { await until(() => live >= n); if (sup) await untilState(sup, "RUNNING"); }, end: (text = "ok") => { ends.shift()(text); } };
}

/** R6: the refusal omp gives a model it does not know, as THAT dist's PlannerRpcError (the supervisor's isModelRefusal checks instanceof). */
export function modelRefusal(d, key) {
  if (!d.PlannerRpcError) throw new Error(`${d.dir} has no PlannerRpcError`);
  return new d.PlannerRpcError("command_failed:set_model", `Model not found: ${key}`);
}

/** The outcome sink the worker would pass: finishes the run in `store`; lists what it saw. */
export function sink(store) {
  const o = { done: [], failed: [], incidents: [], resetOks: 0, routeEnds: [],
    sessionResetOk: () => { o.resetOks += 1; }, routeEnd: (i) => { o.routeEnds.push(i); },
    complete: (i) => { o.done.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "completed", report_ref: "r", duration_ms: i.duration_ms, tool_calls: i.tool_calls }); },
    fail: (i) => { o.failed.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "failed", error_type: i.error_type, error_ref: i.error_ref }); },
    incident: (k, dd) => { o.incidents.push({ k, d: dd }); } };
  return o;
}

const LISTS = { default: ["anthropic/claude-opus-5-5:medium"], fast: ["anthropic/claude-sonnet-5-5:low"], thinking: ["anthropic/claude-opus-5-5:high"] };
const fakeRoles = (d, lists = LISTS) => ({ requestRefresh() {}, candidates: (role, o = {}) => (lists[role] ?? []).map(d.parseModelString)
  .filter((m) => !(o.refused?.has(d.selectorKey(m)) ?? false)).map((m) => (o.effort ? { ...m, effort: o.effort } : m)) });
/** Every Jev question answered at 0.1, below each per-question bar, so a settle the rules pass settles. */
const jev01 = async (r) => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1, answers: Object.fromEntries(Object.keys(r.questions).map((id) => [id, { type: "noul", noul: 0.1 }])) });

/** Seeds chat 42's planner session as current, as harness() does, then builds the supervisor. `opts`: { recorder (also passed as turnContext.recorder; R5), turnContext (a partial merged over the default turn context; R5), session, extra (SupervisorDeps overrides, incl. versionCheck), outcome, roles/lists ({ default, fast, thinking } lists; R4, R6) }. */
export function mkSupervisor(d, store, opts = {}) {
  store.recordPlannerSessionReset("42", d.lessonSetFingerprint(store), new Date().toISOString());
  store.claimSessionSeed("42"); store.promotePlannerSession("42");
  const data = mkdtempSync(join(tmpdir(), "hsv-")); // short: the bridge socket path must fit sun_path (104 bytes)
  dataDirs.add(data);
  let sup;
  cleanups.push(async () => { try { await sup?.shutdown(); } finally { rmSync(data, { recursive: true, force: true }); dataDirs.delete(data); } }); // registered before construction: a constructor throw still removes the dir
  const outcome = opts.outcome ?? sink(store);
  const session = opts.session ?? fakeSession();
  sup = new d.PlannerSupervisor({
    chatId: "42", store, cfg: d.resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0" }), ctx: { home: data, repo: data, data }, distDir: data, decls: [], env: {}, turnEnvelopeActions: ["shell"],
    turnContext: { store, memoryRoot: MEMORY_ROOT, dataDir: data, skillsReader: () => undefined, coreBlock: () => undefined, retrieve: async () => ({ facts: [], pages: [] }), env: {},
      ...(opts.recorder ? { recorder: opts.recorder } : {}), ...(opts.turnContext ?? {}) }, // R5: the recorder reaches the turn-context entries; a partial turnContext is merged last (as o.turnContext in the TS harness)
    buildTools: () => ({ registry: new d.ToolRegistry(), quarantine: async () => ({ digest: "", contains_instructions: false, source_meta: { tool: "x", bytes: 0 } }) }),
    posture: () => null, outcome, sessionFactory: (o) => session.bind(o), versionCheck: () => ({ ok: true, version: "18.4.4" }), skipPreflightForTest: true,
    manifestWaitMs: 5_000, roles: fakeRoles(d, opts.lists ?? opts.roles ?? LISTS), settleClient: () => jev01,
    ...(opts.recorder ? { recorder: opts.recorder } : {}), ...opts.extra });
  return { sup, outcome, session, data };
}

/** Run ids and worker ids are random uuids: rows compared across builds scrub them with scripts/stage4-bind-fixture.mjs scrubIds. Shuts every supervisor down and removes its data dir. */
let running = Promise.resolve(); // every teardown in flight: a signal arriving inside cleanup() finds the callbacks already spliced off, so it awaits this instead
export async function cleanup() {
  const fns = cleanups.splice(0).reverse();
  const p = (async () => { for (const fn of fns) { try { await fn(); } catch (e) { console.error("fixture teardown failed"); } } })();
  running = Promise.all([running, p]);
  await p;
}
/** cleanup(), then every teardown that was already in flight (a signal handler's exit path). */
export async function cleanupSettled() { await cleanup(); await running; }

/** One running run through Gateway.intake, as the worker would claim it (telegram, chat 555). `actor` (R4, P20) is `requested_by.id`: the gateway admits 5 Telegram runs per actor per minute, so a line past five uses a second actor. Throws when the gateway refuses. */
export function intakeRun(d, store, goal, key = goal, actor = "paco") {
  const r = new d.Gateway(store).intake(d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal, requested_by: { kind: "user", id: actor },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `k:${key}`, source_reference: "telegram:update:1:message:1" }));
  if (!r.ok) throw new Error(`fixture: intake refused (${r.error?.code ?? "unknown"})`);
  return r.run_id;
}
export const req = (run_id, text = "hi", source = "telegram") => ({ run_id, text, source, requester: { kind: "user", id: "paco" } });

// R5 seed helpers (ported from tests/omp/turn-context.test.ts and tests/omp/context-decisions.test.ts). They write through the RunStore API (seedLaneRows reads store.db for its self-check).
/** `n` active "ask" lessons of `chars` characters each (the renderer's HOUGE_LESSON_CHAR_CAP, read from turnContext.env, caps their sum). Returns the lesson ids. */
export function seedLessons(store, n, chars) {
  return Array.from({ length: n }, (_, i) => store.addLesson({ scope: "ask", text: `${String.fromCharCode(97 + (i % 26))}`.repeat(chars), source: "user_feedback" }));
}
/** One clarifying assistant turn in `chatId` (a user question, then the assistant's `clarify` answer): the next turn's trailing-clarify count is 1. */
export function seedClarify(store, chatId) {
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  store.recordChatTurn({ chat_id: chatId, run_id: "r0", role: "user", text: "fix the file", created_at: at(30) });
  store.recordChatTurn({ chat_id: chatId, run_id: "r0", role: "assistant", text: "Which file do you mean?", intent: "clarify", created_at: at(20) });
}
/**
 * Lane replies after a planner answer in `chatId`. Writes, oldest first: one lane row older than the answer (never "since"), a Telegram run with an
 * assistant chat_turn (what plannerLastAnsweredAt reads), then one delivered lane reply per text (verdict_id null: laneTurnsSince's LEFT JOIN keeps it).
 * ADDS ONE RUN (the planner answer's, label "seed-answer"): intaken under the synthetic actor "seed-answer" (so paco's 5-per-minute intake budget is untouched), claimed and
 * finished "completed" the way the outcome path does, so it holds no active-run slot; corpus run labels by submission order stay predictable only if the caller counts it.
 * Self-checks that the seed run is terminal and that laneTurnsSince(chat, plannerLastAnsweredAt(chat)) returns exactly `texts`, in order; throws otherwise. Returns the answer's timestamp.
 */
export function seedLaneRows(d, store, chatId, texts) {
  const now = Date.now(); const iso = (ms) => new Date(ms).toISOString();
  const lane = (run_id, catch_up, ms) => store.recordLaneReply({ run_id, chat_id: chatId, lane: "answer", verdict_id: null, catch_up, created_at: iso(ms) });
  lane("lane-old", "older than the planner answer", now - 20 * 60_000);
  const answered = iso(now - 10 * 60_000);
  const run = intakeRun(d, store, "seed planner answer", `seed-answer:${chatId}`, "seed-answer");
  if (!store.claimRun(run, "seed-answer", 120) || !store.finishRun({ run_id: run, expected_worker_id: "seed-answer", next: "completed", report_ref: "seed", duration_ms: 0, tool_calls: 0 })) throw new Error("fixture: seed run did not complete");
  store.recordChatTurn({ chat_id: chatId, run_id: run, role: "assistant", text: "planner answer", created_at: answered });
  texts.forEach((t, k) => lane(`lane-${k}`, t, now - (texts.length - k) * 30_000));
  const got = store.laneTurnsSince(chatId, store.plannerLastAnsweredAt(chatId)).map((r) => r.catch_up);
  if (store.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(run)?.state !== "completed") throw new Error("fixture: seed run is not terminal");
  if (store.plannerLastAnsweredAt(chatId) !== answered || JSON.stringify(got) !== JSON.stringify(texts)) throw new Error("fixture: seedLaneRows boundary check failed");
  return answered;
}

/** Synchronously removes every fixture data dir still present: the last resort of an exit path whose bounded wait for cleanupSettled() expired. */
export function removeDataDirsSync() { for (const d of [...dataDirs]) { try { rmSync(d, { recursive: true, force: true }); dataDirs.delete(d); } catch { /* best effort at exit */ } } }
