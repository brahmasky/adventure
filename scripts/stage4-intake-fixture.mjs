// The Slice R1 intake fixture (spec 2026-10-30 R1 §6; plan P1, P2, P4, P5, P11). Not a corpus; Task 6's live gate reuses these.
// Identity is always explicit: `who = { chat, actor }`. Seeds that must not touch who.chat's rate window intake type-"run" events
// from source "cli" on chat 999 (the limiter's active_runs / pending_approvals SQL keys on the actor only, never the chat).
export const NOW = "2026-07-03T12:00:00.000Z";
export const OTHER_CHAT = "999";
const ACTIVE_RUNS_SQL = "SELECT COUNT(*) AS n FROM runs WHERE state IN ('queued', 'running', 'waiting_for_approval') AND type = 'run' AND json_extract(requested_by_json, '$.id') = ?";
const PINNED_ENV = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_RATING_PENDING_MINUTES"];

/** A typed event for `who` through that dist's own buildTypedTaskEvent. extra: fields merged over the defaults (metadata, program, notify ...). */
export function intakeEvent(d, who, { type = "turn", goal = "synthetic", source = "telegram", key, extra = {} }) {
  if (!key) throw new Error("intakeEvent: key is required");
  return d.buildTypedTaskEvent({ source, type, program: "turn", goal, requested_by: { kind: "user", id: who.actor },
    notify: { kind: "telegram", chat_id: who.chat }, idempotency_key: `t:${key}`, source_reference: `telegram:update:${key}:message:${key}`, ...extra });
}

/** n accepted audit rows for `who` (all at `now`, so all in the 60 s window) through the store's own writer. */
export function saturateWindow(store, who, command, n, now) {
  for (let i = 0; i < n; i += 1) {
    store.recordTelegramCommandAudit({ actor_id: who.actor, chat_id: who.chat, command, source_reference: `sat:${command}:${i}`, decision: "accepted", occurred_at: now });
  }
}

const activeRuns = (store, who) => store.db.prepare(ACTIVE_RUNS_SQL).get(who.actor).n;
const seedRun = (d, store, who, key, now) => {
  const r = new d.Gateway(store).intake(intakeEvent(d, { chat: OTHER_CHAT, actor: who.actor }, { type: "run", source: "cli", key, extra: { program: "research-brief", source_reference: "argv" } }), now);
  if (!r.ok) throw new Error(`intake fixture: seed run refused (${r.error?.code})`);
  return r.run_id;
};

/** P4: n queued type-"run" runs for who.actor on chat 999. Asserts the active_runs count equals n. */
export function seedActiveRuns(d, store, who, n, now) {
  for (let i = 0; i < n; i += 1) seedRun(d, store, who, `seed-run-${i}`, now);
  if (activeRuns(store, who) !== n) throw new Error(`intake fixture: ${activeRuns(store, who)} active runs, wanted ${n}`);
}

/**
 * P4: n pending approvals for who.actor on ONE claimed run (chat 999). createApprovalRequest moves the run to waiting_for_approval, so
 * the run is requeued (store.transition) and re-claimed (store.claimRun) before each next request; at the end store.transition(waiting_for_approval -> cancelled)
 * takes it out of the active states, so active_runs cannot fire before pending_approvals. Asserts that with the limiter's own SQL.
 */
export function seedPendingApprovals(d, store, who, n, now) {
  const run_id = seedRun(d, store, who, "seed-appr-run", now);
  if (!store.claimRun(run_id, "worker-seed", 600)) throw new Error("intake fixture: claim failed");
  for (let i = 0; i < n; i += 1) {
    store.createApprovalRequest({ run_id, approval_type: "capability", capability: "local_project_write", action_fingerprint: `fp_seed_${i}`, adapter_input_hash: `hash_seed_${i}`,
      adapter_input_json: "{}", action_summary: `Synthetic action ${i}`, side_effect_level: "local_write", risk_level: "medium", affected_resources: [`path:seed/${i}`],
      requester: { kind: "user", id: who.actor }, expires_at: "2099-01-01T00:00:00.000Z" });
    // waiting_for_approval only allows -> queued (state-machines.ts), so the run is requeued and claimed again before the next request
    if (i < n - 1 && !(store.transition(run_id, "waiting_for_approval", "queued", "seed") && store.claimRun(run_id, "worker-seed", 600))) throw new Error("intake fixture: re-claim failed");
  }
  if (!store.transition(run_id, "waiting_for_approval", "cancelled", "seed")) throw new Error("intake fixture: cancel failed");
  const pending = store.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE state = 'pending' AND json_extract(requester_json, '$.id') = ?").get(who.actor).n;
  if (pending !== n || activeRuns(store, who) !== 0) throw new Error(`intake fixture: ${pending} pending / ${activeRuns(store, who)} active, wanted ${n} / 0`);
}

/** An ask for who.chat opened `minutesAgo` before `now`; active:false cancels it (the row stays, inactive). */
export function seedAsk(store, who, now, minutesAgo, active) {
  const at = (m) => new Date(Date.parse(now) - m * 60_000).toISOString();
  store.writePendingRating({ chat_id: who.chat, asked_at: at(minutesAgo), window_start: at(minutesAgo + 110) });
  if (!active) store.cancelPendingRating(who.chat);
}

/** Runs fn with the daemon-touching env pinned under `dir` (P1: kill writes a tombstone; HOUGE_TELEGRAM_CHAT_ID must not aim a recorder alert at the real chat). Restored in finally. */
export async function withPinnedEnv(dir, fn) {
  const saved = Object.fromEntries(PINNED_ENV.map((k) => [k, process.env[k]]));
  process.env.HOUGE_TOMBSTONE_PATH = `${dir}/houge.kill`;
  process.env.HOUGE_DISARM_PATH = `${dir}/houge.disarm`;
  delete process.env.HOUGE_TELEGRAM_CHAT_ID;
  delete process.env.HOUGE_RATING_PENDING_MINUTES;
  try { return await fn(); } finally { for (const k of PINNED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

/** P2: `new Date()` / `Date.now()` return now + 1 ms, + 2 ms ... per call (distinct and reproducible); other constructor forms untouched; restored in finally. */
export async function withCountingClock(now, fn) {
  const Real = globalThis.Date;
  const base = Real.parse(now);
  let n = 0;
  class Counting extends Real {
    constructor(...a) { if (a.length === 0) super(base + (n += 1)); else super(...a); }
    static now() { return base + (n += 1); }
  }
  globalThis.Date = Counting;
  try { return await fn(); } finally { globalThis.Date = Real; }
}
