import { type ChoiceQuestion, optionsOf } from "./types.js";

/**
 * improve.route's Jev rung (2b-ii §4.3): ONE fixed question (one criteria hash, one bar; codex D15). Every option is
 * always offered; the state's `applicable` list says which targets Houge can act on today, and the entry masks the answer
 * afterwards. Escape first: jev-1.13 leans to the first option.
 */
export const IMPROVE_TARGET: ChoiceQuestion = {
  id: "improve_target",
  type: "choice",
  instructions: "Houge is Paco's assistant. The state describes one signal about Houge's own behaviour: `signal` (what happened), `value`, `scope`, "
    + "`count` (today) and `count_14d`, `paco_text` (Paco's own words, redacted), `tools` (what Houge used), `last_improvement` (the newest change on this "
    + "scope) and `applicable` (the targets Houge can act on today; prefer one of them). What, if anything, should Houge change so this signal does not recur?",
  criteria: [
    ["nothing", "Nothing durable should change: the signal is noise, a one-off, or already handled."],
    ["lesson", "A rule for how Houge answers or works from now on, saved as a lesson."],
    ["fact", "A fact about Paco or the people, places or things in his life that Houge should remember."],
    ["skill", "A reusable procedure for a request Paco keeps making, authored as a skill."],
    ["schedule", "A scheduled task should run at another time or in another shape."],
    ["knowledge", "A topic Houge keeps looking up and should keep as written knowledge."],
    ["tool_gap", "Houge lacks a tool or capability; only a code change fixes it."],
    ["ladder", "A decision bar, judge or trusted source should change (a ladder move)."]
  ]
};
export const IMPROVE_OPTIONS = optionsOf(IMPROVE_TARGET);
