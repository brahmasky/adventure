import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatContextSince, countTrailingClarifyTurns, resolveChatContextTurns, resolveMaxConsecutiveClarify } from "../capabilities/intent.js";
import { composeSystemPrompt } from "../prompt/composer.js";
import { resolveLocalTimeZone } from "../prompt/tz-convert.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import { OMP_LESSON_SCOPES, renderLessonSection, type LessonSection, type LessonSkip } from "../run/lesson-render.js";
import { type DaemonBoot, type RunStore } from "../run/run-store.js";
import { clipText, isBuildStale, localStamp } from "../status/houge-status.js";

export interface TurnContextDeps {
  store: RunStore;
  memoryRoot: string;
  dataDir: string;
  skillsReader: (scope: string) => string | undefined;
  coreBlock: (chatId: string) => { block: string; ids: number[] } | undefined;
  retrieve: (
    chatId: string,
    message: string
  ) => Promise<{ facts: Array<{ id: number; block: string }>; pages: Array<{ id: number; block: string }> }>;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  /** This process's pid: the restart note is written only when the newest boot record is this daemon's (default process.pid). */
  pid?: number;
}

export interface TurnPromptInput {
  run_id: string;
  chat_id: string;
  message: string;
  source: "telegram" | "schedule";
  goal?: string;
  /** The spawn-time snapshot (the supervisor's); absent → what the prompt would render now (one-shot callers, tests). */
  applied?: AppliedSnapshot;
}

export const SCHEDULED_PREFIX = (goal: string): string => `[scheduled: ${goal}]\n`;

/**
 * The consecutive-clarify cap (ADR 0010, spec §6): once Houge has asked `HOUGE_MAX_CONSECUTIVE_CLARIFY`
 * clarifying questions in a row, the next prompt carries this code-owned line so the planner acts on
 * its best reading instead of looping on questions.
 */
export const CLARIFY_CAP_NOTICE =
  "[You have already asked a clarifying question. Do not ask another one: act on your best reading of the request and say what you assumed.]\n";

/** Opens the restart note: code-owned, planner prompt only, never stored as Paco's chat turn. */
export const RESTART_NOTE_PREFIX = "[runtime] ";

const BOOT_REASON_TEXT: Record<string, string> = {
  kickstart: "kickstart", revive_after_kill: "revived after /kill", crash_recovery: "after a crash", restart: "restart", unknown: "reason unknown"
};

/** `[runtime] Houge restarted 07:34 (self-write reload 4431d13 "<subject>"); now running 4431d13.` (houge_status, 2026-10-02) */
export function restartNoteLine(boot: DaemonBoot, tz: string, now: Date): string {
  const at = localStamp(boot.started_at, tz);
  const when = at.slice(0, 10) === localStamp(now.toISOString(), tz).slice(0, 10) ? at.slice(11) : at;
  const why = boot.reason === "self_write_reload"
    ? `self-write reload ${(boot.reload_sha ?? "unknown").slice(0, 7)} "${clipText(boot.reload_subject ?? "", 60)}"`
    : (BOOT_REASON_TEXT[boot.reason] ?? "restart");
  const stale = isBuildStale(boot) ? " (stale build: dist is older than its sources)" : "";
  return `${RESTART_NOTE_PREFIX}Houge restarted ${when} (${why}); now running ${(boot.head_sha ?? "unknown").slice(0, 7)}${stale}.\n`;
}

/** This daemon's live boot record, or null outside the daemon (a one-shot CLI turn, a stopped boot). */
function liveBoot(store: RunStore, pid: number): DaemonBoot | null {
  const boot = store.getLatestDaemonBoot();
  return boot && boot.pid === pid && boot.stopped_at === null ? boot : null;
}

/** The note while this chat has not been sent it since this daemon booted; a peek, never a claim. */
function restartNote(d: TurnContextDeps, chatId: string): string {
  const boot = liveBoot(d.store, d.pid ?? process.pid);
  if (!boot || d.store.hasRestartNote(boot.boot_id, chatId)) return "";
  return restartNoteLine(boot, resolveLocalTimeZone(d.env), d.now?.() ?? new Date());
}

/**
 * Called just before the prompt goes to the child: claims the chat's note for this boot, or strips the note line
 * when another dispatch already claimed it. A turn that ends before dispatch never claims, so the next turn gets it.
 */
export function claimRestartNoteAtDispatch(store: RunStore, chatId: string, built: TurnPrompt, pid: number = process.pid): string {
  // Only the flag buildTurnPrompt set says a note is there: never the prompt text, which may be Paco's own "[runtime] …"
  if (built.restartNote === "") return built.prompt;
  const boot = liveBoot(store, pid);
  if (boot && store.claimRestartNote(boot.boot_id, chatId)) return built.prompt;
  return built.prompt.slice(built.restartNote.length);
}

/** True when this chat's trailing clarify turns have reached the cap. */
export function clarifyCapReached(d: TurnContextDeps, chatId: string): boolean {
  const turns = d.store.getRecentChatTurns(chatId, resolveChatContextTurns(d.env), chatContextSince(d.env, d.now?.() ?? new Date()));
  return countTrailingClarifyTurns(turns) >= resolveMaxConsecutiveClarify(d.env);
}

/** Telegram chat ids are numeric; anything else could escape <data>/omp through join(). */
function assertChatId(chatId: string): void {
  if (!/^-?\d+$/.test(chatId)) throw new Error("invalid chat id");
}

/** What the spawned session's prompt holds (memory A1 §1): the text and the ids attribution may credit. */
export interface PromptSnapshot {
  text: string;
  lessonIds: number[];
  lessonScopes: string[];
  skillScopes: string[];
  coreFactIds: number[];
  skipped: LessonSkip[];
}

/** The ids a turn credits: what the spawned session's prompt holds (spec §1-2). */
export type AppliedSnapshot = Pick<PromptSnapshot, "lessonIds" | "lessonScopes" | "skillScopes" | "coreFactIds">;

export function appliedOf(s: PromptSnapshot): AppliedSnapshot {
  return { lessonIds: s.lessonIds, lessonScopes: s.lessonScopes, skillScopes: s.skillScopes, coreFactIds: s.coreFactIds };
}

export function promptTextFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const NO_LESSONS: LessonSection = { block: undefined, ids: [], scopes: [], skipped: [] };

/** Rendering never throws into a turn: a store failure renders no lessons and is logged. */
function safeLessonSection(d: TurnContextDeps): LessonSection {
  try {
    return renderLessonSection(d.store, OMP_LESSON_SCOPES, d.env);
  } catch (e) {
    console.error(`[turn-context] lesson render failed: ${e instanceof Error ? e.message : String(e)}`);
    return NO_LESSONS;
  }
}

/** Both scopes' skills, concatenated (the composer's skillsScope is a single string, composer.ts:320). */
function ompSkills(d: TurnContextDeps): { block: string | undefined; scopes: string[] } {
  const parts = OMP_LESSON_SCOPES.flatMap((scope) => {
    const block = d.skillsReader(scope);
    return block ? [{ scope, block }] : [];
  });
  return { block: parts.length > 0 ? parts.map((p) => p.block).join("\n") : undefined, scopes: parts.map((p) => p.scope) };
}

export function buildSystemPrompt(d: TurnContextDeps, chatId: string): PromptSnapshot {
  assertChatId(chatId);
  const lessons = safeLessonSection(d);
  const skills = ompSkills(d);
  const core = d.coreBlock(chatId);
  // The date line makes the fingerprint flip daily (UTC midnight): intended, it restarts the child at the next turn so the date stays true.
  const text = composeSystemPrompt(d.memoryRoot, "omp", {
    ...(d.now ? { now: d.now() } : {}),
    lessonsReader: () => lessons.block,
    skillsReader: () => skills.block,
    coreReader: () => core?.block
  });
  return {
    text, lessonIds: lessons.ids, lessonScopes: lessons.scopes, skillScopes: skills.scopes,
    coreFactIds: core?.ids ?? [], skipped: lessons.skipped
  };
}

/** sha256 of what writeSystemPromptFile would write; a change means the live session is stale. */
export function systemPromptFingerprint(d: TurnContextDeps, chatId: string): string {
  return promptTextFingerprint(buildSystemPrompt(d, chatId).text);
}

const LESSON_DROPPED: ReadonlySet<string> = new Set(["lesson_dropped"]);

/**
 * Spec §1: each skipped lesson is a `lesson_dropped` row and an alerted incident (once while open); a lesson that
 * rendered closes its own. Raised here (the prompt the child will hold) and by the sweep. Never throws.
 */
function raiseLessonDrops(d: TurnContextDeps, s: PromptSnapshot): void {
  try {
    for (const skip of s.skipped) {
      d.store.recordMemoryEvent("lesson_dropped", { ...skip });
      openAlertedIncident(d.store, { kind: "lesson_dropped", subject: `lesson:${skip.lesson_id}`, detail: { ...skip }, env: d.env });
    }
    for (const id of s.lessonIds) resolveOpenIncidents(d.store, LESSON_DROPPED, `lesson:${id}`);
  } catch (e) {
    console.error(`[turn-context] lesson_dropped bookkeeping failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Atomically write the chat's system prompt file (stable path per chat); returns the path and what it holds. */
export function writeSystemPromptFile(d: TurnContextDeps, chatId: string): { path: string; snapshot: PromptSnapshot } {
  const snapshot = buildSystemPrompt(d, chatId);
  const dir = join(d.dataDir, "omp");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `system-chat-${chatId}.md`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, snapshot.text, { mode: 0o600 });
  renameSync(tmp, path);
  raiseLessonDrops(d, snapshot);
  return { path, snapshot };
}

type Hits = { facts: Array<{ id: number }>; pages: Array<{ id: number }> };

/** Record the attribution seed (field names unchanged) and touch only what the prompt holds (spec §1-2). */
function recordAttribution(d: TurnContextDeps, runId: string, applied: AppliedSnapshot, hits: Hits): void {
  d.store.recordLoopStarted(runId, {
    manifest: [],
    hint: "loop",
    applied_artifacts: {
      lesson_scopes: applied.lessonScopes,
      lesson_ids: applied.lessonIds,
      skill_scopes: applied.skillScopes,
      episodic_fact_ids: hits.facts.map((f) => f.id),
      wiki_page_ids: hits.pages.map((p) => p.id)
    }
  });
  if (applied.lessonIds.length > 0) d.store.touchApplied(applied.lessonIds);
  const factIds = [...applied.coreFactIds, ...hits.facts.map((f) => f.id)];
  if (factIds.length > 0) d.store.touchEpisodicApplied(factIds);
  if (hits.pages.length > 0) d.store.touchWikiApplied(hits.pages.map((p) => p.id));
}

/** The planner prompt, and the exact restart note it opens with ("" when none) for the claim at dispatch. */
export interface TurnPrompt { prompt: string; restartNote: string }

export async function buildTurnPrompt(d: TurnContextDeps, i: TurnPromptInput): Promise<TurnPrompt> {
  const { facts, pages } = await d.retrieve(i.chat_id, i.message);
  recordAttribution(d, i.run_id, i.applied ?? appliedOf(buildSystemPrompt(d, i.chat_id)), { facts, pages });
  const blocks = [...facts, ...pages].map((x) => x.block.replaceAll("[/context]", "[ /context]"));
  const context = blocks.length > 0 ? `[context]\n${blocks.join("\n\n")}\n[/context]\n\n` : "";
  const prefix = i.source === "schedule" ? SCHEDULED_PREFIX(i.goal ?? i.message) : "";
  const cap = clarifyCapReached(d, i.chat_id) ? CLARIFY_CAP_NOTICE : "";
  // a schedule fire is not Paco talking: it neither shows nor uses the note, so his first real turn gets it
  const note = i.source === "schedule" ? "" : restartNote(d, i.chat_id);
  return { prompt: `${note}${prefix}${cap}${context}${i.message}`, restartNote: note };
}

/** A tool-less reply ending in a short question is a clarify turn (feeds the consecutive-clarify cap). */
export function assistantIntentFor(text: string, usedTool: boolean): "clarify" | "loop" {
  if (usedTool) return "loop";
  const t = text.trim();
  return /[?？][\s"'”」）)]*$/.test(t) && t.length < 600 ? "clarify" : "loop";
}
