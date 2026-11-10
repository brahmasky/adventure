import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  for (const name of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort()) {
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

/** The old layout's frontmatter: `name`, `when`, an optional `anchors` list (only the `  - ` lines under the `anchors:` key). */
function parseLegacy(raw: string): GrowFields | null {
  const m = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
  if (!m) return null;
  const line = (k: string): string | undefined => new RegExp(`^${k}: (.*)$`, "m").exec(m[1]!)?.[1]?.trim();
  const name = line("name"); const when = line("when");
  if (!name || !when) return null;
  const block = /^anchors:[ \t]*\n((?: {2}- .*(?:\n|$))*)/m.exec(m[1]!)?.[1] ?? "";
  const anchors = [...block.matchAll(/^ {2}- (.*)$/gm)].map((x) => unquote(x[1]!.trim()));
  return { name, description: when, example: `a request about ${when}`.slice(0, 300), body: m[2]!.trim(), ...(anchors.length > 0 ? { anchors } : {}) };
}

/** Real `.md` files of real scope folders; a symlink (scope or file) is never followed, it is returned as `bad` so the folder stays. */
function legacyFiles(dir: string): { files: Array<{ path: string; label: string }>; bad: string[] } {
  const files: Array<{ path: string; label: string }> = []; const bad: string[] = [];
  const skip = (n: string): boolean => n.startsWith("_") || n.startsWith(".");
  for (const scope of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip(scope.name)) continue;
    if (scope.isSymbolicLink()) { bad.push(scope.name); continue; }
    if (!scope.isDirectory()) continue;
    for (const e of readdirSync(join(dir, scope.name), { withFileTypes: true }).filter((x) => x.name.endsWith(".md") && !skip(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const label = join(scope.name, e.name);
      if (e.isFile()) files.push({ path: join(dir, label), label }); else bad.push(label);
    }
  }
  return { files, bad };
}

/** The first free `skills.migrated-<YYYY-MM>[-n]` beside the old folder. */
function migratedTarget(dir: string, month: string): string {
  const base = join(dirname(dir), `skills.migrated-${month}`);
  let target = base;
  for (let n = 2; existsSync(target); n += 1) target = `${base}-${n}`;
  return target;
}

/**
 * One-shot, idempotent: the skills Paco accepted under the old gate become live clean items after the formal checks, only
 * through `svc.seed` (which skips any name the zone knows, in any state; dot- and _-named entries are never read). The folder is renamed only when no file was invalid:
 * a repeated name, the exemplar's name, a symlink, a failed publish all keep it.
 */
export async function migrateLegacySkills(d: { store: RunStore; svc: GrowService; legacyDir: string; now: string }): Promise<{ migrated: string[]; invalid: string[]; renamed: boolean }> {
  if (!existsSync(d.legacyDir)) return { migrated: [], invalid: [], renamed: false };
  const migrated: string[] = []; const seen = new Set<string>();
  const { files, bad } = legacyFiles(d.legacyDir);
  const invalid: string[] = [...bad];
  for (const { path, label } of files) {
    const f = parseLegacy(readOrNull(path) ?? "");
    if (!f || f.name !== basename(path, ".md") || seen.has(f.name) || f.name === EXEMPLAR_NAME) { invalid.push(label); continue; }
    seen.add(f.name);
    const known = d.store.getGrowItem(f.name);
    if (known) continue;   // a name the zone knows, in any state or with any content (migrated earlier, undone, improved since), stays in neither list
    if (!checkFields(f, d.store.listGrowItems("live"), fieldScrub(d.store)).ok) { invalid.push(label); continue; }
    const r = await d.svc.seed(f, "clean", "migrate");
    if (r === "published") migrated.push(f.name); else if (r === "failed") invalid.push(label);
  }
  if (invalid.length > 0) return { migrated, invalid, renamed: false };
  renameSync(d.legacyDir, migratedTarget(d.legacyDir, d.now.slice(0, 7)));
  return { migrated, invalid, renamed: true };
}
