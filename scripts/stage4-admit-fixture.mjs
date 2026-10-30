// The Stage 4C admit fixture (spec 2026-10-30 §4.2, §6; plan P6: no bridge). Not a corpus. `adminWorker` is a plain-JS port of
// ompWorker in tests/helpers/omp-worker.ts (constructor argument order confirmed against that file); `scheduleRun` intakes a run (fixed keys: the store is fresh per item, and the keys feed the ledger's goal_hash) through
// the dist's own Gateway, claims it, builds the turn state (buildOmpTools) and hands back a caller for the worker's schedule_task adapter.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkTemp } from "./stage4-diff-lib.mjs";

const NO_OMP_BIN = "/nonexistent/houge-tests/omp"; // the same pin as tests/helpers/omp-env.ts: nothing here can reach a real omp
const STUB_LLM = async () => ({ ok: true, output: { answer: "stub" } });
const FIXED_NOW = "2026-06-01T00:00:00.000Z";

/** A temp dist whose omp/shell-wrapper.sh is copied from THAT dist (else the preflight fails the turn with wrapper_mismatch). */
function tmpDistOf(d, root) {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "omp"), { recursive: true });
  copyFileSync(join(d.dir, "omp", "shell-wrapper.sh"), join(dist, "omp", "shell-wrapper.sh"));
  return dist;
}

/** A CoreWorker on the omp path over `store`, data in `root`, every adapter faked. o: { llm, embed }. */
export function adminWorker(d, root, store, o = {}) {
  if (!d.CoreWorker) throw new Error(`${d.dir} has no CoreWorker`);
  return new d.CoreWorker(store, join(root, "project"), o.llm ?? STUB_LLM, undefined, undefined, undefined, undefined, undefined, undefined,
    o.embed ?? (async () => null), undefined, undefined, { dataDir: root, distDir: tmpDistOf(d, root) });
}

/** Runs `fn` with `new Date()` / `Date.now()` pinned to 2026-06-01T00:00:00Z (other constructor forms untouched); restored in finally. */
export async function withFixedClock(fn) {
  const Real = globalThis.Date;
  class Fixed extends Real {
    constructor(...a) { if (a.length === 0) super(FIXED_NOW); else super(...a); }
    static now() { return new Real(FIXED_NOW).getTime(); }
  }
  globalThis.Date = Fixed;
  try { return await fn(); } finally { globalThis.Date = Real; }
}

const SAVED = ["HOUGE_OMP_BIN", "HOUGE_SCHEDULER_ENABLED", "HOUGE_SCHEDULER_MAX_PER_CHAT", "HOUGE_TOMBSTONE_PATH"];

/**
 * A claimed turn run + a caller for the dist's own schedule_task adapter. kind: "telegram" (chat 555) | "cli" (no chat).
 * o: { cap } sets HOUGE_SCHEDULER_MAX_PER_CHAT; { chat } replaces the default chat 555 (and keys the intake by it, so one store can hold several runs). `close()` restores every env var and is safe to call twice.
 */
export function scheduleRun(d, store, kind, o = {}) {
  if (kind !== "telegram" && kind !== "cli") throw new Error(`scheduleRun: unknown kind ${kind}`);
  const root = mkTemp(`admit-${kind}`);
  const saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  const restore = () => { for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  process.env.HOUGE_OMP_BIN = NO_OMP_BIN;
  process.env.HOUGE_SCHEDULER_ENABLED = "1";
  process.env.HOUGE_TOMBSTONE_PATH = join(root, "houge.kill");
  if (o.cap !== undefined) process.env.HOUGE_SCHEDULER_MAX_PER_CHAT = String(o.cap); else delete process.env.HOUGE_SCHEDULER_MAX_PER_CHAT;
  try {
    const tg = kind === "telegram";
    const intake = new d.Gateway(store).intake(d.buildTypedTaskEvent({
      source: kind, type: "turn", program: "turn", goal: "schedule admit", requested_by: { kind: "user", id: "paco" },
      notify: tg ? { kind: "telegram", chat_id: o.chat ?? "555" } : { kind: "local" },
      idempotency_key: `schedule-admit-${kind}${o.chat ? `:${o.chat}` : ""}`, source_reference: `${kind}:update:1:message:${o.chat ? o.chat.replace(/\D/g, "") || 1 : 1}`
    }));
    if (!intake.ok) throw new Error(`admit fixture intake failed: ${JSON.stringify(intake)}`);
    const worker = adminWorker(d, root, store);
    const claim = store.claimRun(intake.run_id, `planner:admit:${intake.run_id}`, 120);
    if (!claim) throw new Error("admit fixture claim failed");
    worker.buildOmpTools(claim); // ompTurns holds the turn state the adapter reads
    // executeScheduleTask is TS-private only; the compiled method is callable and synchronous
    return { worker, claim, root, run_id: intake.run_id, call: (input) => worker.executeScheduleTask(claim, input), close: restore };
  } catch (e) { restore(); throw e; }
}
