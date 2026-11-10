import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunStore } from "../run/run-store.js";
import { type GrowFields, checkFields, fieldScrub, parseSkillFile } from "./checks.js";
import type { GrowService } from "./service.js";

export const EXEMPLAR_NAME = "option-comparison";
/** The pre-grow-zone skills folder: named here once, so no other file spells the path (ADR 0035 G2 conformance). */
export const legacySkillsDir = (projectRoot: string): string => join(projectRoot, "skills");
const readOrNull = (path: string): string | null => { try { return readFileSync(path, "utf8"); } catch { return null; } };

/** Boot step: publish a missing or changed exemplar after the formal checks, only through `svc.seed`. A failing one is reported, never published. */
export async function seedExemplars(d: { store: RunStore; svc: GrowService; seedDir: string; now: string }): Promise<{ seeded: string[]; failed: string[] }> {
  const root = join(d.seedDir, "skills");
  if (!existsSync(root)) return { seeded: [], failed: ["(seed folder missing)"] };
  const seeded: string[] = []; const failed: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const parsed = parseSkillFile(readOrNull(join(root, name, "SKILL.md")) ?? "");
    const others = d.store.listGrowItems("live").filter((i) => i.name !== name);
    if (!parsed || parsed.name !== name || !checkFields(parsed, others, fieldScrub(d.store)).ok) { failed.push(name); continue; }
    const { origin: _origin, ...f } = parsed;
    const r = await d.svc.seed(f, "exemplar", "seed");
    if (r === "published") seeded.push(name); else if (r === "failed") failed.push(name);
  }
  return { seeded, failed };
}

const unquote = (raw: string): string => { if (!raw.startsWith('"')) return raw; try { const v: unknown = JSON.parse(raw); return typeof v === "string" ? v : raw; } catch { return raw; } };

/** The old layout's frontmatter: `name`, `when`, an optional `anchors` list. */
function parseLegacy(text: string): GrowFields | null {
  const m = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(text);
  if (!m) return null;
  const line = (k: string): string | undefined => new RegExp(`^${k}: (.*)$`, "m").exec(m[1]!)?.[1]?.trim();
  const name = line("name"); const when = line("when");
  if (!name || !when) return null;
  const anchors = [...m[1]!.matchAll(/^ {2}- (.*)$/gm)].map((x) => unquote(x[1]!.trim()));
  return { name, description: when, example: `a request about ${when}`.slice(0, 300), body: m[2]!.trim(), ...(anchors.length > 0 ? { anchors } : {}) };
}

function legacyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const scope of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("_"))) {
    for (const file of readdirSync(join(dir, scope.name)).filter((n) => n.endsWith(".md")).sort()) out.push(join(dir, scope.name, file));
  }
  return out;
}

/**
 * One-shot, idempotent: the skills Paco accepted under the old gate become live clean items after the formal checks, only
 * through `svc.seed` (which skips any name the zone knows, in any state). The folder is renamed only when no file was invalid.
 */
export async function migrateLegacySkills(d: { store: RunStore; svc: GrowService; legacyDir: string; now: string }): Promise<{ migrated: string[]; invalid: string[]; renamed: boolean }> {
  if (!existsSync(d.legacyDir)) return { migrated: [], invalid: [], renamed: false };
  const migrated: string[] = []; const invalid: string[] = [];
  for (const path of legacyFiles(d.legacyDir)) {
    const f = parseLegacy(readOrNull(path) ?? "");
    if (!f || !checkFields(f, d.store.listGrowItems("live"), fieldScrub(d.store)).ok) { invalid.push(path.slice(path.lastIndexOf("/") + 1)); continue; }
    const r = await d.svc.seed(f, "clean", "migrate");
    if (r === "published") migrated.push(f.name); else if (r === "failed") invalid.push(path.slice(path.lastIndexOf("/") + 1));
  }
  if (invalid.length > 0) return { migrated, invalid, renamed: false };
  renameSync(d.legacyDir, join(dirname(d.legacyDir), `skills.migrated-${d.now.slice(0, 7)}`));
  return { migrated, invalid, renamed: true };
}
