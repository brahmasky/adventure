import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatContextSince, countTrailingClarifyTurns, resolveChatContextTurns, resolveMaxConsecutiveClarify } from "../capabilities/intent.js";
import { composeSystemPrompt } from "../prompt/composer.js";
import { resolveLocalTimeZone } from "../prompt/tz-convert.js";
import { resolveLessonCapPerScope, type DaemonBoot, type RunStore } from "../run/run-store.js";
import { clipText, localStamp } from "../status/houge-status.js";

export interface TurnContextDeps {
  store: RunStore;
  memoryRoot: string;
  dataDir: string;
  lessonsReader: (scope: string) => string | undefined;
  skillsReader: (scope: string) => string | undefined;
  coreBlock: (chatId: string) => string | undefined;
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
  const stale = boot.head_committed_at && boot.dist_built_at && Date.parse(boot.head_committed_at) > Date.parse(boot.dist_built_at)
    ? " (stale build: HEAD is newer than dist)" : "";
  return `${RESTART_NOTE_PREFIX}Houge restarted ${when} (${why}); now running ${(boot.head_sha ?? "unknown").slice(0, 7)}${stale}.\n`;
}

/** The note for this chat's first prompt since this daemon booted; "" on every later prompt, or outside the daemon. */
function restartNote(d: TurnContextDeps, chatId: string): string {
  const boot = d.store.getLatestDaemonBoot();
  if (!boot || boot.pid !== (d.pid ?? process.pid) || boot.stopped_at !== null) return "";
  if (!d.store.claimRestartNote(boot.boot_id, chatId)) return "";
  return restartNoteLine(boot, resolveLocalTimeZone(d.env), d.now?.() ?? new Date());
}

/** True when this chat's trailing clarify turns have reached the cap. */
export function clarifyCapReached(d: TurnContextDeps, chatId: string): boolean {
  const turns = d.store.getRecentChatTurns(chatId, resolveChatContextTurns(d.env), chatContextSince(d.env, d.now?.() ?? new Date()));
  return countTrailingClarifyTurns(turns) >= resolveMaxConsecutiveClarify(d.env);
}
const SCOPE = "ask";

/** Telegram chat ids are numeric; anything else could escape <data>/omp through join(). */
function assertChatId(chatId: string): void {
  if (!/^-?\d+$/.test(chatId)) throw new Error("invalid chat id");
}

function renderSystemPrompt(d: TurnContextDeps, chatId: string): string {
  assertChatId(chatId);
  // The date line makes the fingerprint flip daily (UTC midnight): intended, it restarts the child at the next turn so the date stays true.
  return composeSystemPrompt(d.memoryRoot, "omp", {
    ...(d.now ? { now: d.now() } : {}),
    lessonsReader: d.lessonsReader,
    lessonsScope: SCOPE,
    skillsReader: d.skillsReader,
    skillsScope: SCOPE,
    coreReader: () => d.coreBlock(chatId)
  });
}

/** sha256 of what writeSystemPromptFile would write; a change means the live session is stale. */
export function systemPromptFingerprint(d: TurnContextDeps, chatId: string): string {
  return createHash("sha256").update(renderSystemPrompt(d, chatId)).digest("hex");
}

/** Atomically write the chat's system prompt file; the path is stable per chat. */
export function writeSystemPromptFile(d: TurnContextDeps, chatId: string): string {
  const dir = join(d.dataDir, "omp");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `system-chat-${chatId}.md`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, renderSystemPrompt(d, chatId), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Record the attribution seed (field names identical to the old inner loop) and touch what applied. */
function recordAttribution(
  d: TurnContextDeps,
  runId: string,
  facts: Array<{ id: number }>,
  pages: Array<{ id: number }>
): void {
  const lessons = d.store.getActiveLessons(SCOPE, resolveLessonCapPerScope(d.env));
  d.store.recordLoopStarted(runId, {
    manifest: [],
    hint: "loop",
    applied_artifacts: {
      lesson_scopes: lessons.length > 0 ? [SCOPE] : [],
      lesson_ids: lessons.map((l) => l.id),
      skill_scopes: d.skillsReader(SCOPE) ? [SCOPE] : [],
      episodic_fact_ids: facts.map((f) => f.id),
      wiki_page_ids: pages.map((p) => p.id)
    }
  });
  if (lessons.length > 0) d.store.touchApplied(lessons.map((l) => l.id));
  if (facts.length > 0) d.store.touchEpisodicApplied(facts.map((f) => f.id));
  if (pages.length > 0) d.store.touchWikiApplied(pages.map((p) => p.id));
}

export async function buildTurnPrompt(d: TurnContextDeps, i: TurnPromptInput): Promise<string> {
  const { facts, pages } = await d.retrieve(i.chat_id, i.message);
  recordAttribution(d, i.run_id, facts, pages);
  const blocks = [...facts, ...pages].map((x) => x.block.replaceAll("[/context]", "[ /context]"));
  const context = blocks.length > 0 ? `[context]\n${blocks.join("\n\n")}\n[/context]\n\n` : "";
  const prefix = i.source === "schedule" ? SCHEDULED_PREFIX(i.goal ?? i.message) : "";
  const cap = clarifyCapReached(d, i.chat_id) ? CLARIFY_CAP_NOTICE : "";
  return `${restartNote(d, i.chat_id)}${prefix}${cap}${context}${i.message}`;
}

/** A tool-less reply ending in a short question is a clarify turn (feeds the consecutive-clarify cap). */
export function assistantIntentFor(text: string, usedTool: boolean): "clarify" | "loop" {
  if (usedTool) return "loop";
  const t = text.trim();
  return /[?？][\s"'”」）)]*$/.test(t) && t.length < 600 ? "clarify" : "loop";
}
