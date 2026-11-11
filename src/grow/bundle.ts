import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_FILE_PATTERN, bundlePathFor } from "../run/db-backup.js";
import type { GrowZone } from "./zone.js";

export { bundlePathFor };

/**
 * Pair the newest DB snapshot with a bundle of the zone (spec §5.1). Run every poll: a crash or a failure between the
 * snapshot and the bundle is repaired by the next call, and the DB backup itself never waits for it. Newest only, on
 * purpose: a bundle is the zone as it is now, so pairing it with an older snapshot would mislabel it.
 */
export async function ensureGrowBundle(d: { zone: GrowZone; backupDir: string }): Promise<"none" | "exists" | "written" | "failed"> {
  const newest = existsSync(d.backupDir) ? readdirSync(d.backupDir).filter((n) => BACKUP_FILE_PATTERN.test(n)).sort().at(-1) : undefined;
  if (!newest) return "none";
  const target = bundlePathFor(join(d.backupDir, newest));
  if (existsSync(target)) return "exists";
  try { await d.zone.bundle(target); return "written"; } catch { return "failed"; }
}
