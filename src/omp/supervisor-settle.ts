// turn.settle's supervisor-side glue (2b-i §3.5–3.6), as functions over a narrow context (senior plan S: beside the
// supervisor, not inside its 1 400 lines).
import { parseAttachments } from "./attachments.js"; // a leaf module (Task 9 moved it out of the supervisor): no runtime cycle
import type { Pass, PlannerSessionLike } from "./planner-supervisor.js"; // types only: no runtime cycle
import { finalAuditReasons, reaskAfterDelivery, settleNote, type SettleDeps } from "./settle-judge.js";
import { redactForJudge } from "../decisions/egress.js";
import { SETTLE_JEV_MS, type SettleReason } from "../decisions/entries/turn-settle.js";
import type { TrustLevel } from "../decisions/entries/turn-trust.js";
import { lastCallDenied } from "../decisions/settle-checks.js";
import { buildSettleState, type RawSettleState, type SettleState, type TodoSnapshot } from "../decisions/settle-state.js";
import type { DecisionSignal } from "../decisions/types.js";
import { enqueueUrgentCard } from "../decisions/urgent.js";
import { safeReason } from "../domain/error-code.js";
import type { RunStore } from "../run/run-store.js";

export const UNVERIFIED_CARD = (reasonLine: string): string => `⚠️ Settled unverified: ${reasonLine}`;
/** What the glue reads from the supervisor; the live parts are getters, so a replaced child or a moved queue is read live. */
export interface SettleCtx {
  store: RunStore; chatId: string; workspace: string;
  session: () => PlannerSessionLike | undefined; queueHasTelegram: () => boolean; bridgeToken: () => string | undefined;
  settleDeps: (run_id: string) => SettleDeps;
}
/** The Turn fields the glue reads and writes (the supervisor's Turn satisfies it structurally). */
export interface SettleTurn {
  run_id: string; passes: Pass[]; sentBack: boolean; continuationSeen: boolean; continuationFailed?: boolean; aborting: boolean;
  deadline: ReturnType<typeof setTimeout> | undefined; deadlineLeft: number; deadlineAt: number; trustLevel: () => TrustLevel;
  userText: string; todoBefore: TodoSnapshot | null; settleDecisionId: string | null; settleReason?: SettleReason;
  /** This turn's code-extracted codes and links (bridge-handler `turnExtracted`), read live: masked by value in every settle state. */
  extracted: () => readonly string[];
}
export interface Snapshot { todo: TodoSnapshot; queued: number }

/** omp's get_state through the live child (its own 1 s bound); null on any failure: the todo check is then off for the turn. */
export async function todoSnapshot(ctx: SettleCtx): Promise<Snapshot | null> {
  const s = ctx.session();
  if (!s) return null;
  try {
    const st = await s.getState();
    // queuedMessageCount also counts liveSteered on omp 18.12.3 (a plain live turn reads 1): the queues are the reading.
    return { todo: { phases: st.todoPhases }, queued: st.queuedMessages.steering.length + st.queuedMessages.followUp.length };
  } catch (e) {
    console.error(`settle: get_state failed (${safeReason(e)}): the todo check is off for this turn`);
    return null;
  }
}

/** `attachments`: the delivered count (the audit's text has its markers parsed out already); absent, parsed from `text`. */
export function settleStateFor(ctx: SettleCtx, t: SettleTurn, text: string, now: number, snap: Snapshot | null, attachments?: number): SettleState {
  const evidence = ctx.store.getLedgerEvents(t.run_id);
  const raw: RawSettleState = {
    run_id: t.run_id, text, pass: t.passes.length - 1, sentBack: t.sentBack, trust: t.trustLevel(), lastCallDenied: lastCallDenied(evidence),
    steerQueued: (snap?.queued ?? 0) > 0 || ctx.queueHasTelegram(),
    msLeft: t.deadline ? t.deadlineLeft - (now - t.deadlineAt) : t.deadlineLeft, aborting: t.aborting, evidence, todoBefore: t.todoBefore,
    todoNow: snap?.todo ?? null, pacoMessage: t.userText, attachmentsAccepted: attachments ?? parseAttachments(text, ctx.workspace).attachments.length
  };
  const token = ctx.bridgeToken();
  // 2b-i final review A1: the turn's extracted codes and links are masked as on the injection path (injection-judge stateOf);
  // finalAudit builds its state here too, so the re-ask after delivery carries the same masks
  const opts = { brokerRedact: (x: string) => ctx.store.redactSecretValues(x), known: token ? [token] : [], extracted: t.extracted(), linkTokens: true };
  return buildSettleState(raw, (s) => redactForJudge(s, opts));
}

export function writeOutcome(ctx: SettleCtx, t: SettleTurn, signal: DecisionSignal, value: string): void {
  if (!t.settleDecisionId) return;
  try { ctx.store.insertDecisionOutcome({ decision_id: t.settleDecisionId, signal, value, source: "code" }); }
  catch (e) { console.error(`settle: ${signal} not written for ${t.run_id}: ${safeReason(e)}`); }
}

/** 2b-R17: the row is never rewritten; what followed the send-back is an outcome (spec §3.5). */
export function writeSettleOutcomes(ctx: SettleCtx, t: SettleTurn): void {
  if (!t.sentBack) return;
  if (t.continuationFailed) { writeOutcome(ctx, t, "settle_discarded", "continuation_failed"); return; }
  if (!t.continuationSeen) { writeOutcome(ctx, t, "settle_discarded", t.aborting ? "signal" : "extension_timeout"); return; }
  writeOutcome(ctx, t, "settle_sent_back", t.settleReason ?? "settled");
}

/** What Paco received: the reply text after attachment parsing, and the attachments sent with it. */
export interface Delivered { text: string; attachments: readonly string[] }

/**
 * The final-pass audit (2b-R10): the code checks on the DELIVERED reply (2b-i final review A6: an empty pass 1 delivers pass 0,
 * a short one pass 0 + marker + pass 1) with the todo snapshot taken BEFORE the reply was delivered (senior plan W: a later
 * get_state could belong to the next turn), then Jev re-asked after delivery; one card per turn.
 */
export async function finalAudit(ctx: SettleCtx, t: SettleTurn, snap: Snapshot | null, delivered: Delivered): Promise<void> {
  const state = settleStateFor(ctx, t, delivered.text, Date.now(), snap, delivered.attachments.length);
  let carded = false;
  const card = (reason: SettleReason) => {
    if (carded) return;
    carded = true;
    enqueueUrgentCard(ctx.store, { chat_id: ctx.chatId, key: `settle_unverified:${t.run_id}`, text: UNVERIFIED_CARD(settleNote(reason, state).split("\n")[0] ?? reason) });
  };
  for (const r of finalAuditReasons(state)) { writeOutcome(ctx, t, "settle_unverified", r); card(r); }
  const jev = await reaskAfterDelivery(ctx.settleDeps(t.run_id), state, SETTLE_JEV_MS);
  if (jev) { writeOutcome(ctx, t, "settle_unverified", jev); card(jev); }
}
