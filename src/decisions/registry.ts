import { TURN_GEAR } from "./entries/turn-gear.js";
import { TURN_HANDLER } from "./entries/turn-handler.js";
import type { AnyEntry, EffectKind } from "./types.js";

/** Every decision on one list (spec §6). Stage 1 registers the front door; later stages add their families. Protected surface (spec §6.3). */
export const REGISTRY: readonly AnyEntry[] = [TURN_HANDLER as unknown as AnyEntry, TURN_GEAR as unknown as AnyEntry];
/** Effects a judge may choose over any input (R12): nothing, a tightening, or a proposal for Paco's tap. */
const PASSIVE: ReadonlySet<EffectKind> = new Set(["none", "tighten", "proposal"]);

export function entryById(id: string): AnyEntry | undefined {
  return REGISTRY.find((e) => e.id === id);
}

/** Spec §4.1 as data: what is wrong with an entry (empty = sound). tests/decisions/registry.test.ts asserts it for every entry. */
export function entryProblems(e: AnyEntry): string[] {
  return [...shapeProblems(e), ...effectProblems(e)];
}

function shapeProblems(e: AnyEntry): string[] {
  const p: string[] = [];
  const has = (v: string): boolean => e.verdicts.includes(v);
  if (!has(e.fail)) p.push("fail not in verdicts");
  if (!has(e.defaultVerdict)) p.push("defaultVerdict not in verdicts");
  if (e.ladder.length === 0) p.push("empty ladder");
  if (e.monotone && [...e.monotone.order].sort().join() !== [...e.verdicts].sort().join()) p.push("monotone order is not the verdict set");
  if (Object.values(e.armed).some((m) => m !== "on")) p.push("entry armed other than on (R13: no designed shadow or off state)");
  if (e.locked && e.ladder.some((r) => r.kind !== "rule")) p.push("locked entry with a non-rule rung");
  const provisional = e.ladder.some((r) => r.kind === "system_one" && r.bars.kind === "provisional");
  if (provisional && !e.monotone && e.fail !== e.defaultVerdict) p.push("provisional bar on an entry that is neither monotone nor fail-open");
  return p;
}

/**
 * R12: a verdict a Jev or model rung can choose may, over tool (or mixed) input, only tighten or propose; over Paco's own
 * message it may cause a reply or an effect only when reversible and announced. Code-only entries are not bound.
 * `announced: "reply"` is accepted only until Task 8c, which removes it (Paco's Q1 ruling: announced means a card with Undo).
 */
function effectProblems(e: AnyEntry): string[] {
  const p: string[] = [];
  const judged = e.ladder.some((r) => r.kind === "system_one" || r.kind === "model");
  for (const v of e.verdicts) {
    const fx = e.effects[v];
    if (fx === undefined) { p.push(`no effect declared for ${v}`); continue; }
    if (!judged || PASSIVE.has(fx.kind)) continue;
    if (e.input !== "paco") p.push(`a jev/model rung over ${e.input} input can choose ${v}, which is not tightening`);
    else if (!fx.reversible || fx.announced === "none") p.push(`a jev/model rung can choose ${v}, an unannounced or irreversible effect`);
  }
  return p;
}
