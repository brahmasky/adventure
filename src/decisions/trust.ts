import type { RunStore } from "../run/run-store.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import { decideSync, message } from "./decide.js";
import { CARRY_LEVEL, CAUSE_LEVEL, rankOf, TURN_TRUST, type TrustCause, type TrustLevel } from "./entries/turn-trust.js";
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

/** `onRise`: called with the new level after every rise (the supervisor persists the transcript's level at once, re-review 1). */
export interface TurnTrustDeps { store: RunStore; run_id: string; chat_id: string; born: "telegram" | "schedule"; env?: NodeJS.ProcessEnv; onRise?: (level: TrustLevel) => void }

export class TurnTrust {
  // ES private fields, not TS `private`: no cast or reflection can reach the level to lower it (monotone, spec §7.2)
  #current: TrustLevel = "clean";
  #ended = false;
  #causes = new Set<TrustCause>();
  constructor(private readonly d: TurnTrustDeps) {}

  level(): TrustLevel { return this.#current; }

  /** True once finalize() ran: a judgement completing after this is recorded late and raises nothing. */
  ended(): boolean { return this.#ended; }

  /**
   * True when the level rose. Locked code decides (turn.trust); the row is recorded through the store recorder. Every cause
   * asked is kept for the carry (spec 2026-11-02 §6.1, B1), even one that does not raise the level.
   */
  raise(cause: TrustCause, tool_call_id: string | null = null): boolean {
    if (this.#ended) return false;
    this.#causes.add(cause);
    if (rankOf(CAUSE_LEVEL[cause]) <= rankOf(this.#current)) return false;
    const r = decideSync(TURN_TRUST, { current: this.#current, cause }, { run_id: this.d.run_id, tool_call_id,
      recorder: storeRecorder(this.d.store, this.d.env ? { env: this.d.env } : {}) });
    this.#current = r.verdict;
    this.ledger("turn_trust", { level: this.#current, cause });
    try { this.d.onRise?.(this.#current); } catch (e) { console.error(`trust: transcript level not persisted for ${this.d.run_id}: ${message(e)}`); }
    if (this.#current === "hostile") this.onHostile(cause === "carried_hostile");
    return true;
  }

  /** Spec 2026-11-02 §6.1: what the transcript carries after this turn — the highest CARRY_LEVEL over every cause asked. */
  carryLevel(): TrustLevel {
    let best: TrustLevel = "clean";
    for (const c of this.#causes) if (rankOf(CARRY_LEVEL[c]) > rankOf(best)) best = CARRY_LEVEL[c];
    return best;
  }

  /** Security final I-3: start at the level the planner transcript carries (a stored value; anything unknown carries nothing). */
  carry(level: string | null): boolean {
    if (level === "hostile") return this.raise("carried_hostile");
    return level === "untrusted" ? this.raise("carried_untrusted") : false;
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

  /**
   * Spec §8.2: one urgent card per hostile turn; a schedule-born one (nobody to tap) also pages hostile_schedule_turn, an
   * event. A carried level sends no card and, D3-A (spec 2026-11-02 §6.4), no page: the turn that read the text already paged.
   */
  private onHostile(carried: boolean): void {
    if (carried) return;
    if (this.d.born === "schedule") this.page("hostile_schedule_turn");
    try { enqueueUrgentCard(this.d.store, { chat_id: this.d.chat_id, key: `trust_hostile:${this.d.run_id}`, text: HOSTILE_CARD_TEXT }, "urgent"); }
    catch (e) {
      // Paco must still learn the turn is hostile: the card's failure becomes an incident row (and its own page)
      console.error(`trust: hostile card not queued: ${message(e)}`);
      this.page("trust_card_failed");
    }
  }

  private page(kind: "trust_card_failed" | "hostile_schedule_turn"): void {
    // spec 2026-11-02 §5: hostile_schedule_turn is an event, resolved after its page — a carried turn re-paged the same morning twice
    try { openAlertedIncident(this.d.store, { kind, subject: this.d.run_id, detail: { run_id: this.d.run_id }, ...(kind === "hostile_schedule_turn" ? { event: true } : {}), ...(this.d.env ? { env: this.d.env } : {}) }); }
    catch (e) { console.error(`trust: ${kind} not opened: ${message(e)}`); }
  }
}

/** The level a turn ended at, or null when it wrote none (a failed write, or a turn from before stage 2a): never clean. */
export function turnTrustFinal(store: RunStore, run_id: string): TrustLevel | null {
  const e = store.getLedgerEvents(run_id).find((x) => x.event_type === "turn_trust_final");
  const lvl = (e?.payload as { max_level?: unknown } | undefined)?.max_level;
  return lvl === "clean" || lvl === "untrusted" || lvl === "hostile" ? lvl : null;
}

/**
 * The level a running turn has reached so far, from its ledger: the same rows `raise` writes (a carried level is one of
 * them). The fallback when no live level is bound (ADR 0035 G4): a lost ledger write reads lower, so prefer the live turn.
 */
export function turnTrustNow(store: RunStore, run_id: string): TrustLevel {
  let level: TrustLevel = "clean";
  for (const e of store.getLedgerEvents(run_id)) {
    if (e.event_type !== "turn_trust") continue;
    const l = (e.payload as { level?: unknown }).level;
    if ((l === "untrusted" || l === "hostile") && rankOf(l) > rankOf(level)) level = l;
  }
  return level;
}
