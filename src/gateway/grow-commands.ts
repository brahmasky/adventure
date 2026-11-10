import type { TypedTaskEvent } from "../domain/types.js";
import { trustItem } from "../grow/service.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

const DAY_MS = 86_400_000;
const ORIGIN_LABEL = { clean: "written by Houge", untrusted: "from outside content", exemplar: "exemplar" } as const;
/** Houge wrote these lines: shown as plain text, never as a link or a formatted span. */
const plain = (s: string): string => s.replace(/[[\]()*_`]/g, " ").replace(/\s+/g, " ").trim();

/** `/grow` with no arguments: live skills, reviews in flight, recent failures, and repository skills Houge does not know. */
export function formatGrowList(store: RunStore, now: string): string {
  const live = store.listGrowItems("live").map((i) => `**${i.name}** · ${ORIGIN_LABEL[i.origin]} · used ${i.uses}×\n${plain(i.description)}${i.origin === "untrusted" ? `\n/grow trust ${i.name} clears the mark` : ""}`);
  const waiting = store.listGrowStaged().filter((r) => r.state !== "failed").map((r) => `**${r.name}** · waiting for review`);
  const failed = store.listGrowStaged("failed").filter((r) => r.findings_json !== null && Date.parse(now) - Date.parse(r.updated_at) < 14 * DAY_MS).map((r) => `**${r.name}** · failed review (${r.code ?? "review_failed"})`);
  const orphans = store.listGrowItems("orphan").map((i) => `**${i.name}** · in the repository but unknown to me · \`houge grow adopt ${i.name}\``);
  const all = [...live, ...waiting, ...failed, ...orphans];
  return all.length === 0 ? "🌱 **Grow zone**\nNo skills yet." : `🌱 **Grow zone**\n${all.join("\n\n")}\n\nUndo one: /grow undo <name> [reason]`;
}

/** The `/status` lines: nothing when the zone is healthy. */
export function growStatusLines(store: RunStore, now: string): string[] {
  const late = store.listGrowStaged("staged").filter((r) => Date.parse(now) - Date.parse(r.created_at) > DAY_MS).length;
  const orphans = store.countGrowItems("orphan");
  const paused = store.listOpenIncidents().some((i) => i.kind === "grow_zone_unavailable" || i.kind === "grow_publish_failed");
  return [...(paused ? ["Grow zone: writing is paused (the zone could not be written)"] : []),
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
