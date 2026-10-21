import type { NotificationButton } from "../notifications/notification-types.js";
import type { ImprovementJobRow, RunStore } from "../run/run-store.js";
import type { SkillStore } from "./skill-store.js";

/**
 * The promotion step of a skill-authoring job (2b-ii §5.2), shared by Paco's tap (gateway/improvement-commands.ts) and the
 * tick's retry of a `promoting` job (core/skill-job.ts). Lives here so neither imports the other.
 */
export const SK_PREFIX = "dec:sk:";
/** A tap acts within this many days of its offer (gateway/improvement-commands.ts); an unreviewed drafted skill expires after it (core/skill-job.ts). */
export const TAP_STALE_DAYS = 14;

function button(text: string, data: string): NotificationButton {
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("improvement callback_data exceeds 64 bytes");
  return { text, data };
}
export function skillButtons(job_id: string, kind: "review" | "collision"): NotificationButton[] {
  const b = (text: string, action: string) => button(text, `${SK_PREFIX}${job_id}:${action}`);
  return kind === "review" ? [b("✅ Accept", "accept"), b("🗑 Dismiss", "dismiss")] : [b("🔁 Replace", "replace"), b("➕ Keep both", "keep"), b("🗑 Dismiss", "dismiss")];
}
export const jobCollisionCard = (name: string): string => `🛠 A skill named ${name} is already active. Replace it (the old one retires with lineage), keep both (the new one becomes ${name}-2), or dismiss the draft.`;

/**
 * Steps (1)-(5) of the promotion protocol. A crash leaves `promoting` + promote_mode for the tick's retry; `origin` lets the
 * retry find a file the crashed attempt already promoted. Returns the text for Paco.
 */
export function promote(store: RunStore, skills: SkillStore, job: ImprovementJobRow, chat_id: string | null, now: string): string {
  const mode = job.promote_mode as "refuse" | "replace" | "keep_both";
  const r = skills.promotePending(job.pending_scope!, job.pending_name!, { onCollision: mode, now: now.slice(0, 10), origin: `improve_job:${job.job_id}` });
  if (!r.ok && r.error === "collision") {
    const chat = job.chat_id ?? chat_id;   // the job's own chat (ruling 19); the caller's as the fallback for a pre-stamp row
    store.inTransaction(() => {
      if (!store.transitionJob({ job_id: job.job_id, from: ["promoting"], to: "collision", now })) return;
      if (chat) store.enqueueNotification({ target: { kind: "telegram", chat_id: chat }, intent_type: "progress", idempotency_key: `improve_job:${job.job_id}:${job.attempt}:collision`, correlation_id: `improve_job:${job.job_id}`,
        payload: { text: jobCollisionCard(job.pending_name!), buttons: skillButtons(job.job_id, "collision") } });
      store.markJobsOffered([job.job_id], now);
    });
    return `A skill named ${job.pending_name} is already active: Replace, Keep both or Dismiss on the card.`;
  }
  if (!r.ok) {
    store.transitionJob({ job_id: job.job_id, from: ["promoting"], to: "failed", now, patch: { result_code: "promote_failed" } });
    return `Promotion failed (${r.error}).`;
  }
  store.transitionJob({ job_id: job.job_id, from: ["promoting"], to: "promoted", now, patch: { pending_name: r.name } });
  return `✅ Skill ${r.name} is active. /skills to view.`;
}
