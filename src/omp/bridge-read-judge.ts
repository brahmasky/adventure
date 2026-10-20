import { relative, isAbsolute, sep } from "node:path";
import { resolveDaemonTmpDir } from "../run/daemon-tmp.js";
import { realpathOrSelf } from "./protected-paths.js";
import type { BridgeRequest, JudgeReadReply } from "./bridge-protocol.js";
import type { ActiveTurn, BridgeHandlerDeps } from "./bridge-handler.js"; // types only: no runtime cycle
import { capResponse } from "./response-cap.js";

/** 2b-i §4: one built-in read's judgement, keyed from the judge_read ARRIVAL (senior S3), never from the gate. */
export interface JudgePending { since: number; replied: boolean; outside: boolean; raised: boolean }
export const JUDGE_DRAIN_MS = 3_000;
export const PENDING_STALE_MS = 5_000;
/** The trailing line of a local read whose judgement mirrored masks (2b-R8, ruling 4): the planner learns why an edit will ask. */
export const MASKED_NOTE = (n: number): string => `⟦Houge masked ${n} value${n === 1 ? "" : "s"} in this file; an edit or write to it will ask Paco⟧`;
export type JudgeReq = Extract<BridgeRequest, { kind: "judge_read" }>;
/** What the handler needs from bridge-handler.ts: the shared judge path with its outcome (not only the text). */
export type JudgedOutcome = (deps: BridgeHandlerDeps, turn: ActiveTurn, toolCallId: string, text: string, o: { outside: boolean; paths: string[]; late: () => boolean }) => Promise<{ text: string; masked: number }>;
/** What the path side needs (codex plan r2): the env and the path context only, so flushUnreported's callers can pass a Pick. */
export type PathDeps = Pick<BridgeHandlerDeps, "env" | "ctx">;

const inside = (root: string, p: string): boolean => { const r = relative(root, p); return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
/**
 * The key two names of one file share (spec §4, codex r3; senior plan W): the real path with every missing tail kept
 * lexical (`realpathOrSelf`, protected-paths.ts:164), lower-cased as `protected-paths.under` does, since APFS folds case.
 */
export const maskedKey = (p: string): string => realpathOrSelf(p).toLowerCase();
export const pendingOf = (turn: ActiveTurn): Map<string, JudgePending> => (turn.judgePending ??= new Map());
const inFlightOf = (turn: ActiveTurn): Map<string, Promise<void>> => (turn.judgeInFlight ??= new Map());

/** 2b-R15 (ruling 13: defence in depth): a read under the daemon temp dir is outside text; any target decides (codex r3). Both sides real and case-folded (macOS /var → /private/var). */
function isOutside(deps: PathDeps, targets: readonly string[]): boolean {
  const root = maskedKey(resolveDaemonTmpDir(deps.env, deps.ctx.home));
  return targets.some((t) => inside(root, maskedKey(t)));
}

export async function handleJudgeRead(deps: BridgeHandlerDeps, turn: ActiveTurn, req: JudgeReq, judged: JudgedOutcome, holdMs = 0): Promise<JudgeReadReply> {
  const targets = turn.readTargets?.get(req.toolCallId);
  if (!targets) { console.error(`bridge: judge_read refused unknown_call (${req.toolCallId})`); throw new Error("unknown_call"); }
  const outside = isOutside(deps, targets);
  const pending: JudgePending = { since: Date.now(), replied: false, outside, raised: false };
  pendingOf(turn).set(req.toolCallId, pending);
  const text = capResponse(req.text);
  // the hold is part of the in-flight promise (the live gate's `gateHold.judgeReadMs`), so drainJudges waits for a held read too
  const run = (async () => {
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
    return judged(deps, turn, req.toolCallId, text, { outside, paths: [...targets], late: () => turn.trust?.ended() === true });
  })();
  inFlightOf(turn).set(req.toolCallId, run.then(() => undefined, () => undefined));
  try {
    const out = await run;
    // 2b-R5 (codex plan B3): after finalize() the judgement was recorded `late`; the turn is not touched and no note is added
    if (turn.trust?.ended()) return replyFor(req.text, out.text);
    if (!outside && out.masked > 0) {
      const masked = (turn.maskedPaths ??= new Set<string>());
      for (const t of targets) masked.add(maskedKey(t));
      out.text = `${out.text}\n${MASKED_NOTE(out.masked)}`;
    }
    return replyFor(req.text, out.text);
  } finally { pending.replied = true; inFlightOf(turn).delete(req.toolCallId); }
}

/** `unchanged` only when the judged text is exactly what the extension sent (an over-cap request is always rewritten). */
const replyFor = (sent: string, judgedText: string): JudgeReadReply => (judgedText === sent ? { verdict: "unchanged" } : { verdict: "rewritten", text: judgedText });

/** Any later bridge request from the turn: a read pending past the stale bound (and not yet raised) raises judge_timeout once. */
export function raiseStalePending(turn: ActiveTurn, now: number): void {
  for (const [id, p] of pendingOf(turn)) if (!p.replied && !p.raised && now - p.since > PENDING_STALE_MS) { p.raised = true; turn.trust?.raise("judge_timeout", id); }
}

/**
 * A report for a gated read (codex plan B2: every gated read is reconciled, whether or not a judge_read ever arrived):
 * `applied: true` after Houge's own reply clears it; anything else — applied: false, applied: true with no Houge reply
 * (an extension that lies cannot clear a read), or no judge_read at all — raises judge_timeout once. Cost (ruling 11):
 * a read whose result had no text block (images only) is reported applied: true with no judge_read and so raises
 * untrusted; images are unjudged today (spec §2.2 residual), and untrusted is the honest level for them.
 */
export function noteReportApplied(deps: PathDeps, turn: ActiveTurn, toolCallId: string, applied: boolean): void {
  if (!turn.readTargets?.has(toolCallId)) return;
  const p = pendingOf(turn).get(toolCallId);
  if (p && applied && p.replied) { pendingOf(turn).delete(toolCallId); turn.readTargets.delete(toolCallId); return; }
  if (p) { if (!p.raised) { p.raised = true; turn.trust?.raise("judge_timeout", toolCallId); } return; }
  const outside = isOutside(deps, turn.readTargets.get(toolCallId) ?? []);
  pendingOf(turn).set(toolCallId, { since: Date.now(), replied: false, outside, raised: true }); // never judged: raised now, R16 at flush
  turn.trust?.raise("judge_timeout", toolCallId);
}

/** 2b-R5: the turn's in-flight judgements, bounded in total (the judge's own budget). */
export async function drainJudges(turn: ActiveTurn, ms: number): Promise<void> {
  const all = [...inFlightOf(turn).values()];
  if (all.length === 0) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.allSettled(all), new Promise<void>((r) => { t = setTimeout(r, ms); })]); } finally { clearTimeout(t); }
}

/**
 * At flush (2b-R16): a read still unjudged raises hostile when outside, untrusted when local; a judged read whose report
 * never came raises judge_timeout; a gated read that never got a judge_read (codex plan B2) is raised like an unjudged one.
 */
export function raisePendingAtFlush(deps: PathDeps, turn: ActiveTurn): void {
  for (const [id, targets] of turn.readTargets ?? []) if (!pendingOf(turn).has(id)) pendingOf(turn).set(id, { since: 0, replied: false, outside: isOutside(deps, targets), raised: false });
  for (const [id, p] of pendingOf(turn)) {
    if (!p.replied) turn.trust?.raise(p.outside ? "judge_lost_outside" : "judge_timeout", id);
    else if (!p.raised) turn.trust?.raise("judge_timeout", id);
  }
  pendingOf(turn).clear(); turn.readTargets?.clear();
}
