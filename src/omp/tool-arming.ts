import { resolveCodexEnabled } from "../capabilities/coding-agent.js";
import { resolveGoogleEnabled } from "../capabilities/google-api.js";
import { resolveSelfWriteEnabled } from "../capabilities/self-write-writer.js";
import { resolveWikiEnabled } from "../capabilities/wiki.js";
import { resolveSkillsEnabled } from "../skills/skill-store.js";
import { resolveHttpFetchEnabled } from "../web/http-fetch.js";
import { resolveTimeToolEnabled } from "../prompt/tz-convert.js";
import { resolveSchedulerEnabled } from "../run/schedule-spec.js";

const ARMED: Record<string, (env: NodeJS.ProcessEnv) => boolean> = {
  http_fetch: resolveHttpFetchEnabled, to_local_time: resolveTimeToolEnabled, schedule_task: resolveSchedulerEnabled,
  wiki_build: resolveWikiEnabled, wiki_refine: resolveWikiEnabled, self_diagnose: resolveCodexEnabled,
  self_write_propose: resolveSelfWriteEnabled, skill_author: resolveSkillsEnabled,
  gmail_read: resolveGoogleEnabled, google_api: resolveGoogleEnabled
};

/** Unlisted names (bash, web_search, lesson_write) are always armed. The dual-LLM couple for Google
 *  (ADR 0025) is satisfied by construction: the wall is always on for read tools under omp (D3). */
export function isToolArmed(name: string, env: NodeJS.ProcessEnv): boolean {
  return ARMED[name]?.(env) ?? true;
}
