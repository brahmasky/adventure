/**
 * Every registered entry id (registry.ts holds the entries; tests/decisions/registry.test.ts keeps the two equal). A leaf
 * module with no imports, because the store imports it (outcome values, ladder-move refusals).
 */
export const ENTRY_IDS = ["turn.handler", "turn.gear", "tool.injection"] as const;

/** The front-door entries (R12/R13): the one definition; migrated callers and the recorder import it. */
export const FRONT_DOOR_ENTRIES: ReadonlySet<string> = new Set(["turn.handler", "turn.gear"]);

/**
 * Spec §6.1's locked entries (L): no rung added, no ladder move, no off switch. `insertLadderMove` refuses them from
 * stage 1 on, before stages 3 and 4 register them.
 */
export const LOCKED_ENTRY_IDS = ["intake.sender", "intake.budget_fuse", "intake.bare_ack", "posture.kill", "approval.bind", "tool.path",
  "fetch.ssrf", "selfwrite.guard", "tool.wall", "attach.path", "secret.redact", "turn.trust"] as const;
