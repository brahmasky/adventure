/**
 * The per-kind incident route table (spec 2026-11-03 §5.1-5.3): where each incident goes (chat page, card the caller
 * sends, or the change log), in plain words, with the subject masked. Pure; openers and the sweep read it.
 */
export type IncidentRoute = "page" | "card" | "log";
export interface IncidentRule { route: IncidentRoute; says: string; act?: string }

const page = (says: string, act?: string): IncidentRule => (act === undefined ? { route: "page", says } : { route: "page", says, act });
const card = (says: string): IncidentRule => ({ route: "card", says });
const log = (says: string): IncidentRule => ({ route: "log", says });
const JEV_DOWN = "Jev is unavailable; decisions fall back to a model.";
const CARD_FAILED = "A card you should have seen failed to send.";

export const INCIDENT_ROUTE = {
  stuck_run: page("A request got stuck and may not be answered.", "resend it if it matters"),
  undelivered_notification: page("Some of my messages failed to reach you."),
  duplicate_schedule: page("Two schedules do the same thing; you may get double messages.", "`/schedule` to remove one"),
  overdue_schedule: page("A schedule didn't run on time."),
  failed_schedule: page("A schedule keeps failing.", "`/schedule`"),
  llm_leg_failing: page("One of my models keeps failing; answers use a fallback."),
  disk_free_low: page("The Mac mini is low on disk space.", "free some space"),
  wall_collapsed: page("Web pages are being read without my usual safety split between models."),
  lane_fallthrough_rate: page("A quick-answer lane keeps failing; those messages go the slow way."),
  lesson_dropped: page("A saved lesson no longer fits and isn't being applied.", "`/lessons`"),
  lesson_render_failed: page("My saved lessons failed to load; answers run without them."),
  embeddings_unavailable: page("Memory search is down; answers recall less."),
  omp_unavailable: page("My planner can't start; I can't answer messages."),
  omp_config_invalid: page("My planner config is invalid; I can't answer messages."),
  planner_crash_loop: page("My planner keeps crashing."),
  planner_start_failed: page("My planner failed to start."),
  wrapper_mismatch: page("My planner wrapper changed; every answer fails until a restart.", "restart the daemon"),
  sandbox_unavailable: page("My sandbox is unavailable; planner turns are refused."),
  planner_session_reset_failed: page("I'm resuming an old conversation with outdated lessons.", "send `/fresh`"),
  planner_submit_failed: page("One request failed to reach my planner.", "resend it"),
  turn_outside_planner: page("A turn tried to run outside the planner and was refused."),
  daemon_tmp_in_git_repo: page("Voice messages are off: my temp folder is inside a git repo."),
  role_unresolved: page("A model seat has no model.", "tap the card, or `/models set <seat> <model>`"),
  jev_auth: page(JEV_DOWN),
  jev_rate_limited: page(JEV_DOWN),
  jev_overloaded: page(JEV_DOWN),
  jev_question_invalid: page(JEV_DOWN),
  jev_no_key: page(JEV_DOWN),
  jev_skip_rate: page("Jev keeps skipping decisions."),
  trust_card_failed: page(CARD_FAILED),
  standing_card_failed: page(CARD_FAILED),
  jev_model_drifted: card("Jev's new model answers differently; you got an Accept card."),
  jev_model_insufficient: card("Jev's new model couldn't be checked; you got an Accept card."),
  jev_model_check_stalled: card("The Jev version check stalled; lanes stay on the planner."),
  decision_health: card("Replies are going out unsettled; you got a card."),
  heartbeat_gap: log("I was offline for a while and came back."),
  core_overflow: log("A chat holds more core facts than the cap; the oldest are left out."),
  trust_tap_budget: log("Today's limit on trust questions was reached; the rest were decided without asking."),
  decision_record_failed: log("A decision record failed to save; the decision itself ran."),
  decision_fallback: log("A decider kept falling back to its backup this hour."),
  decision_fallback_streak: page("A once-a-day decider failed three runs in a row; it decides nothing until it answers again."),
  improve_tick_degraded: page("My nightly improvement check failed, or came up empty on three nights in a row; your corrections may not be learned.", "check `/status` (the Improvement line) and the daemon log's [improve] lines"),
  decision_golden_drift: log("A decider's answers drifted from its test set; it keeps running."),
  omp_read_format_drift: log("omp's read output changed shape; reads use the last known format."),
  omp_contract_drift: log("omp's behaviour drifted from what I expect; I keep running."),
  jev_anchor_missing: log("The Jev anchor import found no anchor model."),
  jev_anchor_mixed_models: log("The Jev anchor import found answers from more than one model."),
  jev_anchor_insufficient: log("The Jev anchor import had too few turns."),
  standing_sweep_failed: log("The standing-approval sweep failed this round."),
  standing_settle_failed: log("Settling a standing approval failed."),
  standing_evidence_failed: log("A standing-approval evidence check failed."),
  todo_reminder_seen: log("My planner got stuck in a todo-reminder loop."),
  static_list_stale: log("A model in my fallback list left the catalog."),
  model_catalog_unavailable: log("I couldn't read omp's model list; using the last good one."),
  triage_overrides: log("You asked to dig deeper three times on one lane this week."),
  hostile_schedule_turn: log("A scheduled task read hostile content; you got a card."),
  mail_auth_lost: page("My access to Paco's Gmail was lost; mail triage is paused.", "run `npm run houge -- mail auth`, then restart the daemon"),
  mail_poll_failing: page("Mail polling has been failing for over two hours; new mail isn't being triaged."),
  mail_jev_failing: page("Jev keeps failing on your mail; every mail is pinging you.")
} as const satisfies Record<string, IncidentRule>;

export type RoutedIncidentKind = keyof typeof INCIDENT_ROUTE;
const TABLE: Readonly<Record<string, IncidentRule>> = INCIDENT_ROUTE;
const UNKNOWN: IncidentRule = { route: "page", says: "Something needs a look." };

/** Silent membership (no stderr): is this kind in the table? */
export function isRoutedKind(k: string): k is RoutedIncidentKind {
  return Object.prototype.hasOwnProperty.call(TABLE, k);
}

const warned = new Set<string>();
function ruleOf(kind: string): IncidentRule {
  if (isRoutedKind(kind)) return TABLE[kind]!;
  if (!warned.has(kind)) { warned.add(kind); process.stderr.write(`incident-route: kind "${kind}" has no route; paging with the generic text\n`); }
  return UNKNOWN;
}

/** An unknown kind (an old row) pages: a missing route must never silence an incident. */
export function routeOf(kind: string): IncidentRoute { return ruleOf(kind).route; }

const CHAT_ID = /^-?\d{6,}$/;
/** Chat and run ids and approval ids become words; code-owned ids (standing:, lesson:, role keys) stay. */
export function maskSubject(s: string): string {
  if (/^-?\d+$/.test(s)) return "a chat"; // a bare id of any length is a chat (todo_reminder_seen); `judges:2` keeps its seat
  const segs = s.split(":");
  if (segs[0] === "chat") return "a chat";
  if (segs[0] === "run") return "a run";
  for (const seg of segs) {
    if (CHAT_ID.test(seg)) return "a chat";
    if (seg.startsWith("run_")) return "a run";
    if (seg.startsWith("appr_")) return "an approval";
  }
  return s;
}

type Notice = { topic: "incident_page" | "incident_log"; text: string };

/** What an opened incident says and where; null for a card kind (its caller sends the card). */
export function incidentNotice(kind: string, subject: string): Notice | null {
  const rule = ruleOf(kind);
  if (rule.route === "card") return null;
  const tag = `\`${kind}\` · ${maskSubject(subject)}`;
  if (rule.route === "log") return { topic: "incident_log", text: `${rule.says} (${tag})` };
  return { topic: "incident_page", text: [`⚠️ ${rule.says}`, ...(rule.act ? [`What to do: ${rule.act}`] : []), tag].join("\n") };
}

/** The fixed notice: same words, page kinds to chat, log kinds to the log; null for a card kind. */
export function incidentResolvedNotice(kind: string, subject: string, open_minutes: number): Notice | null {
  const rule = ruleOf(kind);
  if (rule.route === "card") return null;
  void subject;
  return { topic: rule.route === "log" ? "incident_log" : "incident_page", text: `✅ Fixed: ${rule.says} — open ${open_minutes} min` };
}

/** P4: the chat a card goes to: the working chat, else the operator chat from the env; null when neither is set. */
export function operatorChat(chatId: string | null | undefined, env: NodeJS.ProcessEnv): string | null {
  return chatId?.trim() || env.HOUGE_TELEGRAM_CHAT_ID?.trim() || null;
}
