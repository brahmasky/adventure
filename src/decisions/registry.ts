import { IMPROVE_ROUTE } from "./entries/improve-route.js";
import { TOOL_SHELL_CLASS } from "./entries/tool-shell-class.js";
import { MEMORY_KIND } from "./entries/memory-kind.js";
import { TOOL_SHELL_NETREAD } from "./entries/shell-netread.js";
import { TOOL_INJECTION } from "./entries/tool-injection.js";
import { TURN_SETTLE } from "./entries/turn-settle.js";
import { TURN_TRUST } from "./entries/turn-trust.js";
import { TURN_GEAR } from "./entries/turn-gear.js";
import { TURN_HANDLER } from "./entries/turn-handler.js";
import { LOCKED_ENTRY_IDS } from "./entry-ids.js";
import type { Announce, AnyEntry, EffectKind } from "./types.js";

/** Every decision on one list (spec §6). Stage 1 registers the front door; later stages add their families. Protected surface (spec §6.3). */
export const REGISTRY: readonly AnyEntry[] = [TURN_HANDLER as unknown as AnyEntry, TURN_GEAR as unknown as AnyEntry, TOOL_INJECTION as unknown as AnyEntry,
  TOOL_SHELL_NETREAD as unknown as AnyEntry, TURN_TRUST as unknown as AnyEntry, MEMORY_KIND as unknown as AnyEntry,
  TURN_SETTLE as unknown as AnyEntry, IMPROVE_ROUTE as unknown as AnyEntry, TOOL_SHELL_CLASS as unknown as AnyEntry];
/** Effects a judge may choose over any input (R12): nothing, a tightening, or a proposal for Paco's tap. */
const PASSIVE: ReadonlySet<EffectKind> = new Set(["none", "tighten", "proposal"]);
/** How a judge's effect over Paco's message must be announced (Paco 2026-10-12): an allowlist, so a missing or unknown value fails. */
const ANNOUNCED: ReadonlySet<Announce> = new Set(["card"]);
const LOCKED_IDS: ReadonlySet<string> = new Set(LOCKED_ENTRY_IDS);

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
  if (LOCKED_IDS.has(e.id) && e.locked !== true) p.push("id is in LOCKED_ENTRY_IDS but the entry is not locked");
  if (e.locked && !LOCKED_IDS.has(e.id)) p.push("locked entry whose id is not in LOCKED_ENTRY_IDS");
  const provisional = e.ladder.some((r) => r.kind === "system_one" && r.bars.kind === "provisional");
  const failOpen = e.fail === e.defaultVerdict && noDirectEffect(e);
  if (provisional && !e.monotone && !failOpen && !reversibleOverPaco(e)) {
    p.push("provisional bar on an entry that is not monotone, not fail-open without direct effects, and not over Paco's words with every effect reversible and announced");
  }
  return p;
}

/** Fail-open counts only when no verdict causes a direct effect: each is passive (none, tighten, or a proposal for Paco's tap; ruling 2, 2b-ii). */
function noDirectEffect(e: AnyEntry): boolean {
  return e.verdicts.every((v) => { const k = e.effects[v]?.kind; return k !== undefined && PASSIVE.has(k); });
}

/** ADR 0030 decision 9 as amended 2026-10-17: Paco's own message is the input and every verdict's effect is passive or reversible on a card. */
function reversibleOverPaco(e: AnyEntry): boolean {
  return e.input === "paco" && e.verdicts.every((v) => {
    const fx = e.effects[v];
    return fx !== undefined && (PASSIVE.has(fx.kind) || (fx.reversible && ANNOUNCED.has(fx.announced)));
  });
}

/**
 * R12: a verdict a Jev or model rung can choose may, over tool (or mixed) input, only tighten or propose; over Paco's own
 * message it may cause a reply or an effect only when reversible and announced. Code-only entries are not bound.
 * Announced means a code-built card with Undo (Paco 2026-10-12): "reply" is not accepted.
 */
function effectProblems(e: AnyEntry): string[] {
  const p: string[] = Object.keys(e.effects).filter((v) => !e.verdicts.includes(v)).map((v) => `effect declared for ${v}, which is not a verdict`);
  const judged = e.ladder.some((r) => r.kind === "system_one" || r.kind === "model");
  for (const v of e.verdicts) {
    const fx = e.effects[v];
    if (fx === undefined) { p.push(`no effect declared for ${v}`); continue; }
    if (!judged || PASSIVE.has(fx.kind)) continue;
    if (e.input !== "paco") p.push(`a jev/model rung over ${e.input} input can choose ${v}, which is not tightening`);
    else if (!fx.reversible || !ANNOUNCED.has(fx.announced)) p.push(`a jev/model rung can choose ${v}, an effect not reversible or not announced on a card`);
  }
  return p;
}
