import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorCode } from "../domain/error-code.js";
import type { RunStore } from "../run/run-store.js";
import { bundlePathFor } from "./bundle.js";
import { checkFields, fieldScrub, parseSkillFile } from "./checks.js";
import { resolveGrowDir } from "./flags.js";
import { trustItem } from "./service.js";
import { GrowZone, GrowZoneError } from "./zone.js";

export const GROW_CLI_USAGE = "Usage: houge grow list | show <name> | check [name] | log | undo <name> [reason] | trust <name> | adopt <name>";
const QUEUED = "queued: the daemon runs it within a minute";

/**
 * Read-only against the zone repository: anything that writes it goes through the daemon's request queue (one git
 * writer). The zone is the checkout's sibling data, so the CLI avoids its own cwd the way the daemon avoids the data dir.
 */
export async function runGrowCli(store: RunStore, sub: string, name: string, rest: string, env: NodeJS.ProcessEnv, now: string, backupDir: string): Promise<string> {
  const zone = new GrowZone(resolveGrowDir(env, homedir(), [process.cwd()]));
  if (sub === "list") return store.listGrowItems().map((i) => `${i.name}  ${i.state}  ${i.origin}  ${i.uses}`).join("\n") || "(empty)";
  if (sub === "show") return show(zone, name);
  if (sub === "log") return log(store, backupDir);
  if (sub === "trust") return trustItem(store, name, now) ? `trusted ${name}` : `nothing to clear for ${name}`;
  if (sub === "undo" || sub === "adopt") {
    const fresh = store.enqueueGrowRequest({ idempotency_key: `cli:${sub}:${name}:${now}`, kind: sub, name, reason: sub === "undo" && rest ? rest : null, chat_id: null, now });
    return fresh ? QUEUED : "already queued";
  }
  return check(store, zone, name);
}

async function show(zone: GrowZone, name: string): Promise<string> {
  try { return (await zone.readHead(name)) ?? `no skill named ${name} at HEAD`; }
  catch (error) { return `cannot read ${name}: ${error instanceof GrowZoneError ? error.code : errorCode(error)}`; }
}

function log(store: RunStore, backupDir: string): string {
  const events = store.listGrowEvents({ limit: 30, newest: true }).map((e) => `${e.at} ${e.action} ${e.name} ${e.result}`);
  return [...(events.length > 0 ? events : ["(no events)"]), ...backups(backupDir)].join("\n");
}

/** One line per database snapshot: does it have its zone bundle beside it? */
function backups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^houge-.*\.sqlite$/.test(f)).sort()
    .map((f) => `${f}  bundle: ${existsSync(bundlePathFor(join(dir, f))) ? "yes" : "no"}`);
}

async function check(store: RunStore, zone: GrowZone, only: string): Promise<string> {
  const live = store.listGrowItems("live");
  const lines: string[] = [];
  for (const item of live.filter((i) => !only || i.name === only)) {
    const others = live.filter((x) => x.name !== item.name);
    let text: string | null = null;
    try { text = await zone.readHead(item.name); } catch { /* unreadable below */ }
    const f = text === null ? null : parseSkillFile(text);
    const r = f ? checkFields(f, others, fieldScrub(store)) : ({ ok: false, code: "unreadable" } as const);
    lines.push(r.ok ? `PASS ${item.name}` : `FAIL ${item.name}: ${r.code}`);
  }
  return lines.join("\n") || "(nothing to check)";
}
