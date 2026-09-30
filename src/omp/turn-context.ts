import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeSystemPrompt } from "../prompt/composer.js";
import { resolveLessonCapPerScope, type RunStore } from "../run/run-store.js";

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
}

export interface TurnPromptInput {
  run_id: string;
  chat_id: string;
  message: string;
  source: "telegram" | "schedule";
  goal?: string;
}

export const SCHEDULED_PREFIX = (goal: string): string => `[scheduled: ${goal}]\n`;
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
  return `${prefix}${context}${i.message}`;
}

/** A tool-less reply ending in a short question is a clarify turn (feeds the consecutive-clarify cap). */
export function assistantIntentFor(text: string, usedTool: boolean): "clarify" | "loop" {
  if (usedTool) return "loop";
  const t = text.trim();
  return /[?？][\s"'”」）)]*$/.test(t) && t.length < 600 ? "clarify" : "loop";
}
