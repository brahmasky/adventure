/**
 * Bare acknowledgements (ADR 0029 §5.1, slot A). While a turn is AWAITING_APPROVAL such a message is neither
 * steered nor queued: it gets a code-owned nudge and approves nothing. The list is code-owned on purpose — no model
 * decides what counts as consent.
 */
const ACKS: ReadonlySet<string> = new Set([
  "好", "好的", "好啊", "嗯", "嗯嗯", "是", "是的", "对", "对的", "行", "可以", "没问题", "ok", "okay", "k", "yes", "y", "yep", "sure", "👍", "👌"
]);
const TRAILING = /[。！!.~～\s]+$/u;

export function isBareAck(text: string): boolean {
  const t = text.trim().replace(TRAILING, "").toLowerCase();
  return t.length > 0 && t.length <= 4 && ACKS.has(t);
}

export const ACK_NUDGE_TEXT = "⏸ Houge is waiting for your tap on the approval card above — tap Approve or Deny there, or send /approve <id>.";
