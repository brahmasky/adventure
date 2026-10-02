import { LESSON_AVOID_MAX_CHARS, LESSON_MAX_CHARS } from "../capabilities/distill.js";
import { isLessonTheme, type LessonTheme } from "./lesson-themes.js";
import type { RunStore } from "./run-store.js";

/**
 * The one-off memory A1 migration (spec §8). The plan file (untracked) carries the approved texts; this module only
 * validates and applies it. Apply and revert each run in ONE transaction through transaction-free store helpers,
 * and every step leaves a `memory_migration {step, old_ids, new_ids}` row (ids only).
 */
export interface PlannedLesson { scope: "ask" | "research"; theme: LessonTheme; text: string; avoid: string | null }

export interface MigrationPlan {
  replacements: Array<{ old_id: number; lessons: PlannedLesson[] }>;
  themes: Array<{ id: number; theme: LessonTheme }>;
  retire_facts: number[];
  restore_core: { fact: string; evidence_from_fact_ids: number[] } | null;
}

export interface MigrationStepPayload { step: string; old_ids: number[]; new_ids: number[]; change_id?: string; prev_themes?: Record<string, string> }

export const MIGRATION_CORRELATION = "memory-a1-migration";

function fail(what: string): never {
  throw new Error(`plan: ${what}`);
}
const record = (v: unknown, at: string): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(at);
const list = (v: unknown, at: string): unknown[] => (Array.isArray(v) ? v : fail(at));
const id = (v: unknown, at: string): number => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fail(at));

function parseLesson(v: unknown, at: string): PlannedLesson {
  const r = record(v, at);
  if (r.scope !== "ask" && r.scope !== "research") fail(`${at}.scope`);
  if (!isLessonTheme(r.theme)) fail(`${at}.theme`);
  if (typeof r.text !== "string" || r.text.trim() === "" || r.text.trim().length > LESSON_MAX_CHARS) fail(`${at}.text`);
  if (typeof r.avoid !== "string" && r.avoid !== null) fail(`${at}.avoid`);
  const avoid = typeof r.avoid === "string" && r.avoid.trim() !== "" ? r.avoid.trim() : null;
  if (avoid !== null && avoid.length > LESSON_AVOID_MAX_CHARS) fail(`${at}.avoid`);
  return { scope: r.scope as PlannedLesson["scope"], theme: r.theme as LessonTheme, text: (r.text as string).trim(), avoid };
}

const PLAN_KEYS = new Set(["_note", "themes", "retire_facts", "restore_core"]);

export function parseMigrationPlan(raw: unknown): MigrationPlan {
  const o = record(raw, "root");
  for (const k of Object.keys(o)) if (!/^replace_\d+$/.test(k) && !PLAN_KEYS.has(k)) fail(`unknown key ${k}`);
  const replacements = Object.keys(o).filter((k) => /^replace_\d+$/.test(k)).map((k) => ({
    old_id: id(Number(k.slice("replace_".length)), k),
    lessons: nonEmpty(list(o[k], k), k).map((l, i) => parseLesson(l, `${k}[${i}]`))
  }));
  const themes = Object.entries(record(o.themes ?? {}, "themes")).map(([key, theme]) => {
    if (!/^\d+$/.test(key) || !isLessonTheme(theme)) fail(`themes.${key}`);
    return { id: Number(key), theme: theme as LessonTheme };
  });
  const retire_facts = list(o.retire_facts ?? [], "retire_facts").map((v) => id(v, "retire_facts"));
  return { replacements, themes, retire_facts, restore_core: o.restore_core === undefined ? null : parseCore(o.restore_core) };
}

const nonEmpty = (a: unknown[], at: string): unknown[] => (a.length > 0 ? a : fail(`${at} is empty`));

function parseCore(v: unknown): NonNullable<MigrationPlan["restore_core"]> {
  const r = record(v, "restore_core");
  if (typeof r.fact !== "string" || r.fact.trim() === "") fail("restore_core.fact");
  return { fact: (r.fact as string).trim(), evidence_from_fact_ids: nonEmpty(list(r.evidence_from_fact_ids, "restore_core.evidence_from_fact_ids"), "restore_core.evidence_from_fact_ids").map((x) => id(x, "restore_core")) };
}

/**
 * "applied" = the ledger holds an un-reverted migration; "pending" = every target is fully in its pre-state; anything
 * in between (a row changed by hand, a half state) throws: the migration never runs over a state it did not expect.
 */
export function migrationStatus(store: RunStore, plan: MigrationPlan, chat_id?: string): "pending" | "applied" {
  if (appliedSteps(store).length > 0) return "applied";
  const bad: string[] = [];
  for (const r of plan.replacements) if (store.getLesson(r.old_id)?.status !== "active") bad.push(`lesson ${r.old_id}`);
  for (const t of plan.themes) if (store.getLesson(t.id)?.status !== "active") bad.push(`lesson ${t.id}`);
  for (const f of plan.retire_facts) if (store.getEpisodicFact(f)?.status !== "active") bad.push(`fact ${f}`);
  if (plan.restore_core && chat_id && store.getCoreEpisodicFacts(chat_id).some((f) => f.fact === plan.restore_core!.fact)) bad.push("restored core row");
  if (bad.length > 0) throw new Error(`partial state, refusing: ${bad.join(", ")} not in pre-migration state and no migration is recorded`);
  return "pending";
}

/** Every before/after row, for the operator's eye (local console only; never written anywhere). */
export function describeMigration(store: RunStore, plan: MigrationPlan): string[] {
  const out: string[] = [];
  for (const r of plan.replacements) {
    const old = store.getLesson(r.old_id);
    out.push(`replace lesson #${r.old_id} [${old?.status ?? "missing"}, ${old?.text.length ?? 0} chars]: ${old?.text ?? ""}`);
    r.lessons.forEach((l, i) => out.push(`  + ${i + 1}. [${l.scope}/${l.theme}] ${l.text}${l.avoid ? ` | AVOID: ${l.avoid}` : ""}`));
  }
  for (const t of plan.themes) out.push(`theme lesson #${t.id}: ${store.getLesson(t.id)?.theme ?? "missing"} → ${t.theme}`);
  for (const f of plan.retire_facts) out.push(`retire fact #${f} [${store.getEpisodicFact(f)?.status ?? "missing"}]`);
  if (plan.restore_core) out.push(`restore core fact (evidence #${plan.restore_core.evidence_from_fact_ids.join(", #")}): ${plan.restore_core.fact}`);
  return out;
}

type Ctx = { store: RunStore; plan: MigrationPlan; chat_id: string; now: string };

function step(ctx: Pick<Ctx, "store">, payload: MigrationStepPayload): MigrationStepPayload {
  ctx.store.recordMemoryEvent("memory_migration", { ...payload }, MIGRATION_CORRELATION);
  return payload;
}

/** Each new row's `supersedes` = old; the old row's `superseded_by` = the FIRST new row (reverse order), so lineage finds all. */
function replaceLesson(ctx: Ctx, r: MigrationPlan["replacements"][number]): MigrationStepPayload {
  if (ctx.store.getLesson(r.old_id)?.status !== "active") throw new Error(`lesson ${r.old_id} is not active`);
  const ids = r.lessons.map((l) => ctx.store.addLesson({
    scope: l.scope, text: l.text, ...(l.avoid ? { avoid: l.avoid } : {}), theme: l.theme, source: "migration", created_at: ctx.now
  }));
  for (const newId of [...ids].reverse()) ctx.store.supersedeLesson(r.old_id, newId);
  return step(ctx, { step: `replace_${r.old_id}`, old_ids: [r.old_id], new_ids: ids });
}

function setThemes(ctx: Ctx): MigrationStepPayload {
  const prev_themes: Record<string, string> = {};
  for (const t of ctx.plan.themes) {
    prev_themes[String(t.id)] = ctx.store.getLesson(t.id)?.theme ?? "unthemed";
    if (!ctx.store.setLessonTheme(t.id, t.theme)) throw new Error(`lesson ${t.id} is not active`);
  }
  return step(ctx, { step: "themes", old_ids: ctx.plan.themes.map((t) => t.id), new_ids: [], prev_themes });
}

function retireFacts(ctx: Ctx): MigrationStepPayload {
  const change = ctx.store.retireMemoryRowsTx({ kind: "fact", ids: ctx.plan.retire_facts, chat_id: ctx.chat_id, run_id: null, now: ctx.now });
  return step(ctx, { step: "retire_facts", old_ids: [...ctx.plan.retire_facts], new_ids: [], change_id: change.change_id });
}

/** A new core row whose provenance is the superseded core rows' turns. */
function restoreCore(ctx: Ctx, core: NonNullable<MigrationPlan["restore_core"]>): MigrationStepPayload {
  const sources = core.evidence_from_fact_ids.map((f) => ctx.store.getEpisodicFact(f));
  if (sources.some((f) => !f || f.chat_id !== ctx.chat_id || f.is_core !== 1)) throw new Error("restore_core: evidence must be this chat's core rows");
  const turns = [...new Set(sources.flatMap((f) => turnIds(f!.source_turn_ids)))];
  const newId = ctx.store.addEpisodicFact({ chat_id: ctx.chat_id, fact: core.fact, is_core: true, source_turn_ids: turns, created_at: ctx.now });
  return step(ctx, { step: "restore_core", old_ids: [...core.evidence_from_fact_ids], new_ids: [newId] });
}

function turnIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function applyMigration(ctx: Ctx): MigrationStepPayload[] {
  return ctx.store.inTransaction(() => {
    const steps = ctx.plan.replacements.map((r) => replaceLesson(ctx, r));
    if (ctx.plan.themes.length > 0) steps.push(setThemes(ctx));
    if (ctx.plan.retire_facts.length > 0) steps.push(retireFacts(ctx));
    if (ctx.plan.restore_core) steps.push(restoreCore(ctx, ctx.plan.restore_core));
    return steps;
  });
}

/** The steps since the last revert, read back from the ledger (ids only). */
function appliedSteps(store: RunStore): MigrationStepPayload[] {
  const rows = store.getLedgerEventsByCorrelation(MIGRATION_CORRELATION).filter((e) => e.event_type === "memory_migration");
  const lastRevert = rows.map((e) => e.payload.step).lastIndexOf("revert");
  return rows.slice(lastRevert + 1).map((e) => e.payload as unknown as MigrationStepPayload);
}

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(`revert refused: ${what} is not in the state the migration left`);
}

function revertStep(store: RunStore, s: MigrationStepPayload, now: string): void {
  if (s.step.startsWith("replace_")) {
    for (const newId of s.new_ids) must(store.forgetLesson(newId), `lesson ${newId}`);
    for (const oldId of s.old_ids) must(store.reactivateLesson(oldId), `lesson ${oldId}`);
  } else if (s.step === "themes") {
    for (const [lessonId, theme] of Object.entries(s.prev_themes ?? {})) must(store.setLessonTheme(Number(lessonId), theme), `lesson ${lessonId}`);
  } else if (s.step === "retire_facts") {
    const undo = s.change_id ? store.undoMemoryChangeTx(s.change_id, now) : null;
    must(undo?.status === "undone" && undo.restored.length === s.old_ids.length, "the fact retire");
  } else if (s.step === "restore_core") {
    for (const newId of s.new_ids) must(store.retireEpisodicFactById(newId), `fact ${newId}`);
  }
}

/** `--revert`: reactivate the replaced lessons, retire the new rows, restore themes, undo the fact retire, retire the restored core. One transaction; any row not as the migration left it throws and nothing is written. */
export function revertMigration(ctx: { store: RunStore; now: string }): number {
  const steps = appliedSteps(ctx.store);
  if (steps.length === 0) throw new Error("nothing to revert: no memory_migration rows since the last revert");
  return ctx.store.inTransaction(() => {
    for (const s of steps) revertStep(ctx.store, s, ctx.now);
    step(ctx, { step: "revert", old_ids: [], new_ids: [] });
    return steps.length;
  });
}
