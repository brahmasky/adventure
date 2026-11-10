import type { TypedTaskEvent } from "../domain/types.js";
import { trustItem } from "../grow/service.js";
import type { GrowItemRow, RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

const DAY_MS = 86_400_000;
const NOT_A_FAILURE: ReadonlySet<string> = new Set(["superseded", "undone"]);
const FINDINGS_SHOWN = 3;
/** Houge or a reviewer wrote these lines: one inline-code span, so no link, command or mention in them is tappable. Backticks are stripped, so a span cannot be left early. */
const code = (s: string): string => {
  const t = s.replace(/[`\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return t === "" ? "" : `\`${t}\``;
};

function liveLabel(store: RunStore, i: GrowItemRow): string {
  if (i.origin === "exemplar") return "exemplar";
  return store.isGrowMarked(i.name) ? "from outside content" : "written by Houge";
}

function findingsOf(json: string | null): string {
  let v: unknown;
  try { v = json ? JSON.parse(json) : []; } catch { return ""; }
  if (!Array.isArray(v)) return "";
  const lines = v.filter((x): x is { step: string; problem: string } => typeof x?.step === "string" && typeof x?.problem === "string")
    .slice(0, FINDINGS_SHOWN).map((x) => code(`step ${x.step}: ${x.problem}`)).filter((l) => l !== "");
  return lines.length === 0 ? "" : `\n${lines.join("\n")}`;
}

/** `/grow` with no arguments: live skills, reviews in flight, recent failures, and repository skills Houge does not know. */
export function formatGrowList(store: RunStore, now: string): string {
  const live = store.listGrowItems("live").map((i) => {
    const hint = store.isGrowMarked(i.name) ? `\n/grow trust ${i.name} clears the mark` : "";
    return `**${i.name}** · ${liveLabel(store, i)} · used ${i.uses}×\n${code(i.description)}${hint}`;
  });
  const waiting = store.listGrowStaged().filter((r) => r.state !== "failed").map((r) => `**${r.name}** · waiting for review`);
  const failed = store.listGrowStaged("failed")
    .filter((r) => !NOT_A_FAILURE.has(r.code ?? "") && Date.parse(now) - Date.parse(r.updated_at) < 14 * DAY_MS)
    .map((r) => `**${r.name}** · failed (${r.code ?? "review_failed"})${findingsOf(r.findings_json)}`);
  const orphans = store.listGrowItems("orphan").map((i) => `**${i.name}** · in the repository but unknown to me · \`houge grow adopt ${i.name}\``);
  const all = [...live, ...waiting, ...failed, ...orphans];
  return all.length === 0 ? "🌱 **Grow zone**\nNo skills yet." : `🌱 **Grow zone**\n${all.join("\n\n")}\n\nUndo one: /grow undo <name> [reason]`;
}

/** The `/status` lines: nothing when the zone is healthy. Only a latched zone pauses writing; a dropped publish or an unrecorded write does not. */
export function growStatusLines(store: RunStore, now: string): string[] {
  const late = store.listGrowStaged("staged").filter((r) => Date.parse(now) - Date.parse(r.created_at) > DAY_MS).length;
  const orphans = store.countGrowItems("orphan");
  const open = store.listOpenIncidents();
  const paused = open.some((i) => i.kind === "grow_zone_unavailable" && i.subject !== "apply");
  const unrecorded = open.some((i) => i.kind === "grow_zone_unavailable" && i.subject === "apply");
  const dropped = open.some((i) => i.kind === "grow_publish_failed");
  return [...(paused ? ["Grow zone: writing is paused (the zone could not be written)"] : []),
    ...(unrecorded ? ["Grow zone: a skill write finished but I could not record it yet; writing continues"] : []),
    ...(dropped ? ["Grow zone: a finished skill was dropped after repeated write failures; writing continues"] : []),
    ...(late > 0 ? [`Grow zone: ${late} review${late === 1 ? "" : "s"} pending over a day · /grow`] : []),
    ...(orphans > 0 ? [`Grow zone: ${orphans} skill${orphans === 1 ? "" : "s"} in the repository unknown to me · /grow`] : [])];
}

function growText(store: RunStore, event: TypedTaskEvent, now: string): string {
  const [action, name] = (event.program ?? "list").split(" ");
  const chat_id = event.notify.kind === "telegram" ? event.notify.chat_id : null;
  if (action === "trust" && name) {
    return trustItem(store, name, now) ? `✅ ${name} now reads as Houge's own. Reading it no longer marks the conversation.` : `Nothing to clear: ${name} is not a skill marked as outside content.`;
  }
  if (action === "undo" && name) {
    if (store.getGrowItem(name)?.state !== "live") return "No live skill of that name. /grow lists them.";
    const reason = typeof event.metadata?.grow_reason === "string" ? event.metadata.grow_reason : null;
    store.enqueueGrowRequest({ idempotency_key: event.idempotency_key, kind: "undo", name, reason, chat_id, now });
    return `⏳ Undoing ${name}; I will confirm in a moment.`;
  }
  return formatGrowList(store, now);
}

/** Never touches git: `undo` records a request the daemon's grow tick runs (one git writer), and the tick sends the result. */
export function handleGrow(store: RunStore, event: TypedTaskEvent, now: string): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    replyTo(store, event, "grow", growText(store, event, now));
    return { ok: true, status: "grow_returned", run_id: "" };
  });
}
