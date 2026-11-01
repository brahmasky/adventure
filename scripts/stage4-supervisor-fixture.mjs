// A PlannerSupervisor over a dist module object (spec R3 §6): the narrow path of tests/helpers/supervisor-harness.ts without vitest or src/.
// `d` is a loadDist() result (scripts/stage4-diff-lib.mjs). The fake child plays the omp extension against the REAL bridge socket.
// Real timers only. Not a corpus (the CLI loads scripts/stage4-corpora/*.mjs only). Telegram, omp and Jev are stubbed; nothing leaves the process.
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEMORY_ROOT = new URL("../memory", import.meta.url).pathname;
const cleanups = [];
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
    setModel: async (m) => { const k = `${m.provider}/${m.model}`; s.models.push(k); s.log.push(["set_model", k]); }, newSession: async () => ({ cancelled: false }),
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

/** Seeds chat 42's planner session as current, as harness() does, then builds the supervisor. `opts`: { recorder, session, extra (SupervisorDeps overrides), outcome, roles ({ default, fast, thinking } lists; R4) }. */
export function mkSupervisor(d, store, opts = {}) {
  store.recordPlannerSessionReset("42", d.lessonSetFingerprint(store), new Date().toISOString());
  store.claimSessionSeed("42"); store.promotePlannerSession("42");
  const data = mkdtempSync(join(tmpdir(), "hsv-")); // short: the bridge socket path must fit sun_path (104 bytes)
  let sup;
  cleanups.push(async () => { try { await sup?.shutdown(); } finally { rmSync(data, { recursive: true, force: true }); } }); // registered before construction: a constructor throw still removes the dir
  const outcome = opts.outcome ?? sink(store);
  const session = opts.session ?? fakeSession();
  sup = new d.PlannerSupervisor({
    chatId: "42", store, cfg: d.resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0" }), ctx: { home: data, repo: data, data }, distDir: data, decls: [], env: {}, turnEnvelopeActions: ["shell"],
    turnContext: { store, memoryRoot: MEMORY_ROOT, dataDir: data, skillsReader: () => undefined, coreBlock: () => undefined, retrieve: async () => ({ facts: [], pages: [] }), env: {} },
    buildTools: () => ({ registry: new d.ToolRegistry(), quarantine: async () => ({ digest: "", contains_instructions: false, source_meta: { tool: "x", bytes: 0 } }) }),
    posture: () => null, outcome, sessionFactory: (o) => session.bind(o), versionCheck: () => ({ ok: true, version: "18.4.4" }), skipPreflightForTest: true,
    manifestWaitMs: 5_000, roles: fakeRoles(d, opts.roles ?? LISTS), settleClient: () => jev01,
    ...(opts.recorder ? { recorder: opts.recorder } : {}), ...opts.extra });
  return { sup, outcome, session, data };
}

/** Run ids and worker ids are random uuids: rows compared across builds scrub them with scripts/stage4-bind-fixture.mjs scrubIds. Shuts every supervisor down and removes its data dir. */
export async function cleanup() { for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch (e) { console.error(`fixture teardown failed: ${e instanceof Error ? e.message : String(e)}`); } } }

/** One running run through Gateway.intake, as the worker would claim it (telegram, chat 555). `actor` (R4, P20) is `requested_by.id`: the gateway admits 5 Telegram runs per actor per minute, so a line past five uses a second actor. Throws when the gateway refuses. */
export function intakeRun(d, store, goal, key = goal, actor = "paco") {
  const r = new d.Gateway(store).intake(d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal, requested_by: { kind: "user", id: actor },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `k:${key}`, source_reference: "telegram:update:1:message:1" }));
  if (!r.ok) throw new Error(`fixture: intake refused (${r.error?.code ?? "unknown"})`);
  return r.run_id;
}
export const req = (run_id, text = "hi", source = "telegram") => ({ run_id, text, source, requester: { kind: "user", id: "paco" } });
