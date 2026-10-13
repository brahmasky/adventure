import type { RunStore } from "../run/run-store.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import { decideSync, message } from "./decide.js";
import { CAUSE_LEVEL, rankOf, TURN_TRUST, type TrustCause, type TrustLevel } from "./entries/turn-trust.js";
import { storeRecorder } from "./record.js";
import { enqueueUrgentCard } from "./urgent.js";

/**
 * The active turn's trust (spec §7.2). Held on ActiveTurn by the supervisor; an input to tool.policy (via trust-ask.ts). The
 * level only rises within a turn; each rise writes `turn_trust` and a turn.trust decision row; `finalize` writes
 * `turn_trust_final` once at every turn end. A turn with no final event counts as not clean (turnTrustFinal → null).
 */
export const HOSTILE_CARD_TEXT = "⚠️ *This turn read text aimed at the assistant.* Until it ends, every shell command that is not plainly read-only, and every write, asks you first.";
export const TRUST_ASK_TTL_DEFAULT_MS = 300_000;
const TRUST_ASK_TTL_MAX_MS = 30 * 60_000;

/** HOUGE_TRUST_ASK_TTL_MS (configuration.md): a trust card's own expiry and the turn's whole trust pause. */
export function resolveTrustAskTtlMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_TRUST_ASK_TTL_MS?.trim());
  return Number.isInteger(n) && n > 0 && n <= TRUST_ASK_TTL_MAX_MS ? n : TRUST_ASK_TTL_DEFAULT_MS;
}

export interface TurnTrustDeps { store: RunStore; run_id: string; chat_id: string; born: "telegram" | "schedule"; env?: NodeJS.ProcessEnv }

export class TurnTrust {
  // ES private fields, not TS `private`: no cast or reflection can reach the level to lower it (monotone, spec §7.2)
  #current: TrustLevel = "clean";
  #ended = false;
  constructor(private readonly d: TurnTrustDeps) {}

  level(): TrustLevel { return this.#current; }

  /** True when the level rose. Locked code decides (turn.trust); the row is recorded through the store recorder. */
  raise(cause: TrustCause, tool_call_id: string | null = null): boolean {
    if (this.#ended || rankOf(CAUSE_LEVEL[cause]) <= rankOf(this.#current)) return false;
    const r = decideSync(TURN_TRUST, { current: this.#current, cause }, { run_id: this.d.run_id, tool_call_id,
      recorder: storeRecorder(this.d.store, this.d.env ? { env: this.d.env } : {}) });
    this.#current = r.verdict;
    this.ledger("turn_trust", { level: this.#current, cause });
    if (this.#current === "hostile") this.onHostile();
    return true;
  }

  finalize(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.ledger("turn_trust_final", { max_level: this.#current });
  }

  private ledger(type: "turn_trust" | "turn_trust_final", payload: Record<string, unknown>): void {
    try { this.d.store.appendRunLedgerEvent(this.d.run_id, type, "core", payload); }
    catch (e) { console.error(`trust: ${type} not written for ${this.d.run_id}: ${message(e)}`); }
  }

  /** Spec §8.2: one urgent card per hostile turn; a schedule-born one (nobody to tap) also pages hostile_schedule_turn once. */
  private onHostile(): void {
    try { enqueueUrgentCard(this.d.store, { chat_id: this.d.chat_id, key: `trust_hostile:${this.d.run_id}`, text: HOSTILE_CARD_TEXT }); }
    catch (e) { console.error(`trust: hostile card not queued: ${message(e)}`); }
    if (this.d.born !== "schedule") return;
    try { openAlertedIncident(this.d.store, { kind: "hostile_schedule_turn", subject: this.d.run_id, detail: { run_id: this.d.run_id }, ...(this.d.env ? { env: this.d.env } : {}) }); }
    catch (e) { console.error(`trust: hostile_schedule_turn not opened: ${message(e)}`); }
  }
}

/** The level a turn ended at, or null when it wrote none (a failed write, or a turn from before stage 2a): never clean. */
export function turnTrustFinal(store: RunStore, run_id: string): TrustLevel | null {
  const e = store.getLedgerEvents(run_id).find((x) => x.event_type === "turn_trust_final");
  const lvl = (e?.payload as { max_level?: unknown } | undefined)?.max_level;
  return lvl === "clean" || lvl === "untrusted" || lvl === "hostile" ? lvl : null;
}
