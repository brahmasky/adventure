import type { TypedTaskEvent } from "../domain/types.js";
import { GROW_SUBMITS_PER_DAY, GROW_UNTRUSTED_SUBMITS_PER_DAY, growCapReached, NOT_A_FAILURE, trustItem, trustPendingText } from "../grow/service.js";
import type { GrowItemRow, RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

const DAY_MS = 86_400_000;
const MAX_LIST_CHARS = 3800;
const FINDINGS_SHOWN = 3;
const WAITING_LABEL: Readonly<Record<string, string>> = { approved: "approved, waiting to publish", publishing: "publishing" };
/**
 * Houge or a reviewer wrote these lines: one inline-code span, so no link, command or mention in them is tappable. Backticks are stripped, so a span cannot be left early.
 * The shared adapter resends plain text when the rich send fails, and plain text auto-links, so the characters that start a link, command or mention are swapped for look-alikes first.
 */
const defang = (s: string): string => s.replace(/\//g, "\u2215").replace(/@/g, "\uFF20").replace(/#/g, "\uFF03").replace(/\$/g, "\uFF04")
  .replace(/(?<=[\p{L}\p{N}])[.\u3002\uFF0E\uFF61](?=[\p{L}\p{N}])/gu, "\u2024"); // any letter, so IDN domains (\u043F\u0440\u0438\u043C\u0435\u0440.\u0440\u0444) and the CJK / full-width dots too
const code = (s: string): string => {
  const t = defang(s.replace(/[`\r\n]+/g, " ").replace(/\s+/g, " ").trim());
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
  const waiting = store.listGrowStaged().filter((r) => r.state !== "failed")
    .map((r) => `**${r.name}** · ${WAITING_LABEL[r.state] ?? "waiting for review"} · ${store.isGrowMarked(r.name) ? "from outside content" : "written by Houge"}`);
  const failed = store.listGrowStaged("failed")
    .filter((r) => !NOT_A_FAILURE.has(r.code ?? "") && Date.parse(now) - Date.parse(r.updated_at) < 14 * DAY_MS)
    .map((r) => `**${r.name}** · failed (${r.code ?? "review_failed"})${findingsOf(r.findings_json)}`);
  const orphans = store.listGrowItems("orphan").map((i) => `**${i.name}** · in the repository but unknown to me · \`houge grow adopt ${i.name}\``);
  const all = [...failed, ...waiting, ...live, ...orphans]; // what needs a look comes first: the length cut drops live skills before a failure
  if (all.length === 0) return "🌱 **Grow zone**\nNo skills yet.";
  const shown = fitEntries(all);
  const more = all.length - shown.length;
  const tail = more > 0 ? [`… and ${more} more — run houge grow list on the Mac`] : [];
  return `🌱 **Grow zone**\n${[...shown, ...tail].join("\n\n")}\n\nUndo one: /grow undo <name> [reason]`;
}

/** Whole entries only, so a code span is never split; stops before the text would pass the Telegram message bound. */
function fitEntries(all: string[]): string[] {
  const out: string[] = [];
  let len = 0;
  for (const e of all) {
    if (len + e.length + 2 > MAX_LIST_CHARS) break;
    out.push(e);
    len += e.length + 2;
  }
  return out;
}

/** The `/status` lines: nothing when the zone is healthy. Only a latched zone pauses writing; a dropped publish or an unrecorded write does not. A reached submit cap says so. */
export function growStatusLines(store: RunStore, now: string): string[] {
  const late = store.listGrowStaged("staged").filter((r) => Date.parse(now) - Date.parse(r.created_at) > DAY_MS).length;
  const orphans = store.countGrowItems("orphan");
  // a marked live skill is shown by name only in the index until Paco trusts it: say how many, so the hidden ones are seen
  const marked = store.listGrowItems("live").filter((i) => i.origin !== "exemplar" && store.isGrowMarked(i.name)).length;
  const open = store.listOpenIncidents();
  const paused = open.some((i) => i.kind === "grow_zone_unavailable" && i.subject !== "apply");
  const unrecorded = open.some((i) => i.kind === "grow_zone_unavailable" && i.subject === "apply");
  const dropped = open.some((i) => i.kind === "grow_publish_failed");
  return [...(paused ? ["Grow zone: writing is paused (the zone could not be written)"] : []),
    ...(unrecorded ? ["Grow zone: a skill write finished but I could not record it yet; writing continues"] : []),
    ...(dropped ? ["Grow zone: a finished skill was dropped after repeated write failures; writing continues"] : []),
    ...(late > 0 ? [`Grow zone: ${late} review${late === 1 ? "" : "s"} pending over a day · /grow`] : []),
    ...(orphans > 0 ? [`Grow zone: ${orphans} skill${orphans === 1 ? "" : "s"} in the repository unknown to me · /grow`] : []),
    ...(marked > 0 ? [`Grow zone: ${marked} skill${marked === 1 ? "" : "s"} from outside content (shown by name only) · /grow`] : []),
    ...(growCapReached(store, now, false) ? [`Grow zone: ${GROW_SUBMITS_PER_DAY} skills accepted in 24 hours, the cap; new submits wait`] : []),
    ...(growCapReached(store, now, true) ? [`Grow zone: ${GROW_UNTRUSTED_SUBMITS_PER_DAY} skills from outside content accepted in 24 hours, the cap; more from outside content wait`] : [])];
}

function growText(store: RunStore, event: TypedTaskEvent, now: string): string {
  const [action, name] = (event.program ?? "list").split(" ");
  const chat_id = event.notify.kind === "telegram" ? event.notify.chat_id : null;
  if (action === "trust" && name) {
    const r = trustItem(store, name, now);
    if (r === "pending") return trustPendingText(name);
    return r === "trusted" ? `✅ ${name} now reads as Houge's own. Reading it no longer marks the conversation.` : `Nothing to clear: ${name} is not a skill marked as outside content.`;
  }
  if (action === "undo" && name) {
    if (store.getGrowItem(name)?.state !== "live") return "No live skill of that name. /grow lists them.";
    const reason = typeof event.metadata?.grow_reason === "string" ? event.metadata.grow_reason : null;
    store.enqueueGrowRequest({ idempotency_key: event.idempotency_key, kind: "undo", name, reason, chat_id, now });
    return `⏳ Undoing ${name}; I will confirm in a moment.`;
  }
  return formatGrowList(store, now);
}

/** Never touches git: `undo` records a request the daemon's grow request job runs (one git writer), and that job sends the result. */
export function handleGrow(store: RunStore, event: TypedTaskEvent, now: string): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    replyTo(store, event, "grow", growText(store, event, now));
    return { ok: true, status: "grow_returned", run_id: "" };
  });
}
