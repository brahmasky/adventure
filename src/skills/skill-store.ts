import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The skill store (Phase 2a — ADR 0011 §1/§2): reusable *procedures* for a class of task
 * live as hand-authored markdown files under `<root>/<scope>/<name>.md`, NOT in SQLite
 * (skills are prose that executes no logic — low-risk, instantly revertible). The composer
 * folds the ≤cap in-scope skills into a run via `readScopeBlock`, each prefixed by its
 * `when:` hint so Houge self-applies the relevant ones (ambient, never invoked by name).
 *
 * Frontmatter is the source of truth; `REGISTRY.md` is a generated view.
 *
 * DEFENSIVE: a malformed/oversized skill file must NEVER throw during a turn — a bad file
 * is skipped, never crashes the run. A missing root/scope dir is treated as "no skills".
 */

const DEFAULT_MAX_PER_SCOPE = 4;

/**
 * The parking lot for blocked auto-authored skills (Phase 2c). A still-failing draft is
 * written here — INERT: it lives under the skills root (so containment holds) but is excluded
 * from every active read (`readScopeFiles`/`readScopeBlock`/`list`/`listScopes`), so it is
 * never folded into a prompt and never counts against the ≤cap. `/skills pending` lists it.
 */
export const PENDING_DIR = "_pending";

export type SkillOrigin = "commanded" | "learned" | "refined";

/** Parsed frontmatter of a skill file (the source of truth). */
export interface SkillMeta {
  name: string;
  scope: string;
  when: string;
  anchors: string[];
  version?: number;
  last_verified?: string;
  origin?: string;
  chars: number;
}

export interface SkillStoreOptions {
  root: string;
  maxPerScope?: number;
}

/** Whether the ambient skills layer is enabled (`HOUGE_SKILLS_ENABLED`). Default ON —
 * skills are read-only/low-risk, so only an explicit `0|false|no|off` disables them
 * (the kill switch). Mirrors the `resolveCodexEnabled` idiom, inverted to default-on. */
export function resolveSkillsEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_SKILLS_ENABLED?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/** Max skills folded in per scope (`HOUGE_SKILL_MAX_PER_SCOPE`, default 4). */
export function resolveSkillMaxPerScope(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_SKILL_MAX_PER_SCOPE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PER_SCOPE;
}

/** Max guided-refine passes for a blocked auto-author (`HOUGE_SKILL_REFINE_PASSES`, default 3). */
export function resolveSkillRefinePasses(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_SKILL_REFINE_PASSES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

interface ParsedSkill {
  meta: { name: string; scope: string; when: string; anchors: string[]; version?: number; last_verified?: string; origin?: string };
  body: string;
}

/**
 * Hand-rolled frontmatter parser (zero deps): split the leading `---\n…\n---` fence, parse
 * flat `key: value` lines, with `anchors:` followed by `  - item` lines → string[] and
 * `version` → number. Required: name, scope, when. Missing required / malformed → null.
 */
export function parseSkillFile(input: string): ParsedSkill | null {
  // Normalize CRLF → LF so a hand-authored file saved with Windows line endings still
  // parses (otherwise the `\n`-anchored fence regex silently yields null = skipped).
  const text = input.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const [, frontmatter, body] = match;

  const flat: Record<string, string> = {};
  const anchors: string[] = [];
  let inAnchors = false;
  for (const line of frontmatter!.split("\n")) {
    const anchorItem = /^\s+-\s+(.*)$/.exec(line);
    if (inAnchors && anchorItem) {
      anchors.push(anchorItem[1]!.trim());
      continue;
    }
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "anchors") {
      inAnchors = true;
      continue;
    }
    inAnchors = false;
    flat[key!] = value!.trim();
  }

  const name = flat.name;
  const scope = flat.scope;
  const when = flat.when;
  if (!name || !scope || !when) return null;

  const versionNum = flat.version !== undefined ? Number(flat.version) : undefined;
  return {
    meta: {
      name,
      scope,
      when,
      anchors,
      ...(versionNum !== undefined && Number.isFinite(versionNum) ? { version: versionNum } : {}),
      ...(flat.last_verified ? { last_verified: flat.last_verified } : {}),
      ...(flat.origin ? { origin: flat.origin } : {})
    },
    body: (body ?? "").trim()
  };
}

export class SkillStore {
  private readonly root: string;
  private readonly maxPerScope: number;

  constructor(options: SkillStoreOptions) {
    this.root = options.root;
    this.maxPerScope = options.maxPerScope ?? DEFAULT_MAX_PER_SCOPE;
  }

  /**
   * Render the ≤cap in-scope skills as a "## Skills" block payload: each skill as
   * `### <name> — when: <when>\n<body>`, joined by blank lines. Filenames sort
   * alphabetically (deterministic). Malformed files are skipped. None → undefined so
   * the composer omits the section entirely.
   */
  readScopeBlock(scope: string): string | undefined {
    const parsed = this.readScopeFiles(scope).slice(0, this.maxPerScope);
    if (parsed.length === 0) return undefined;
    return parsed
      .map((p) => `### ${p.meta.name} — when: ${p.meta.when}\n${p.body}`)
      .join("\n\n");
  }

  /** Metadata for every skill (or one scope's) — for the registry and `/skills`. */
  list(scope?: string): SkillMeta[] {
    const scopes = scope ? [scope] : this.listScopes();
    const out: SkillMeta[] = [];
    for (const s of scopes) {
      for (const p of this.readScopeFiles(s)) {
        out.push({ ...p.meta, scope: s, chars: p.body.length });
      }
    }
    return out;
  }

  /** Auto-regenerate `<root>/REGISTRY.md`: a generated view of every skill's frontmatter. */
  regenerateRegistry(): void {
    const metas = this.list();
    const header =
      "<!-- AUTO-GENERATED by SkillStore.regenerateRegistry — do not hand-edit. " +
      "Frontmatter in skills/<scope>/<name>.md is the source of truth. -->\n\n# Skill registry\n";
    const lines = metas.map(
      (m) =>
        `- ${m.name} · ${m.scope} · when: ${m.when} · ${m.anchors.length} anchors · ` +
        `v${m.version ?? 1} · ${m.last_verified ?? "unverified"} · ${m.origin ?? "unknown"}`
    );
    const body = lines.length > 0 ? lines.join("\n") : "_No skills yet._";
    this.writeSafe(join(this.root, "REGISTRY.md"), `${header}\n${body}\n`);
  }

  /**
   * Write a skill file under `<root>/<scope>/<name>.md` (Phase 2b authoring). The `name`
   * is sanitized to a filename-safe slug ([a-z0-9_-]); `scope` likewise. HARD containment:
   * the resolved real path MUST stay inside `<root>` — a name/scope that escapes (`..`,
   * absolute, symlink) is REJECTED, never written. Regenerates REGISTRY.md on success.
   * Skills are low-risk prose, so this is a direct write (report-not-approve), bounded to
   * `skills/`. Defensive: any fs error → a structured failure, never a throw.
   */
  writeSkill(scope: string, name: string, body: string): { ok: true; path: string } | { ok: false; error: string } {
    const written = this.writeContained([sanitizeSlug(scope)], sanitizeSlug(name), body);
    if (written.ok) this.regenerateRegistry();
    return written;
  }

  /**
   * Write a BLOCKED auto-authored draft to `<root>/_pending/<scope>/<name>.md` (Phase 2c).
   * Same slug + real-path containment as `writeSkill` (`_pending` is under the root, so it
   * passes), but the parking lot is inert: NOT folded into a prompt, excluded from active
   * reads, and it does NOT regenerate the registry (the registry is the active view).
   */
  writePending(scope: string, name: string, body: string): { ok: true; path: string } | { ok: false; error: string } {
    return this.writeContained([PENDING_DIR, sanitizeSlug(scope)], sanitizeSlug(name), body);
  }

  /** List the parked (blocked) skills under `<root>/_pending/<scope>/` — for `/skills pending`. */
  listPending(): SkillMeta[] {
    const pendingRoot = join(this.root, PENDING_DIR);
    const out: SkillMeta[] = [];
    let scopes: string[];
    try {
      scopes = readdirSync(pendingRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    for (const s of scopes) {
      const dir = join(pendingRoot, s);
      for (const file of this.listMarkdown(dir)) {
        const text = this.readSafe(join(dir, file));
        if (text === undefined) continue;
        const parsed = parseSkillFile(text);
        if (parsed) out.push({ ...parsed.meta, scope: s, chars: parsed.body.length });
      }
    }
    return out;
  }

  /** Shared write core: join the slugged path parts under the real root, containment-check, write. */
  private writeContained(parts: string[], safeName: string, body: string): { ok: true; path: string } | { ok: false; error: string } {
    if (parts.some((p) => !p) || !safeName) {
      return { ok: false, error: "scope and name must contain at least one [a-z0-9_-] character" };
    }
    const rootReal = this.realRoot();
    const dir = join(rootReal, ...parts);
    const path = join(dir, `${safeName}.md`);
    // Containment: the resolved target must live under the real skills root.
    if (!isInside(rootReal, resolve(path))) {
      return { ok: false, error: "refusing to write a skill outside the skills root" };
    }
    try {
      mkdirSync(dir, { recursive: true });
      // Re-check after mkdir in case a symlink in a path part redirects elsewhere. Compare
      // real path to real path (both now exist) so a symlinked tmp root is not a false escape.
      const realRootNow = realRootOf(rootReal, rootReal);
      if (!isInside(realRootNow, realRootOf(dir, dir))) {
        return { ok: false, error: "refusing to write a skill outside the skills root" };
      }
      writeFileSync(path, body, "utf8");
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, path };
  }

  /** Read a named skill (for the refine path): parse → {meta, body}, or null if absent/malformed. */
  readSkill(scope: string, name: string): { meta: SkillMeta; body: string } | null {
    const safeScope = sanitizeSlug(scope);
    const safeName = sanitizeSlug(name);
    if (!safeScope || !safeName) return null;
    const text = this.readSafe(join(this.root, safeScope, `${safeName}.md`));
    if (text === undefined) return null;
    const parsed = parseSkillFile(text);
    if (!parsed) return null;
    return { meta: { ...parsed.meta, scope: safeScope, chars: parsed.body.length }, body: parsed.body };
  }

  /** Resolve the real skills root (following symlinks); fall back to the configured root if it does not exist yet. */
  private realRoot(): string {
    try {
      return realpathSync(this.root);
    } catch {
      return resolve(this.root);
    }
  }

  /** Parse every file in a scope dir, sorted alphabetically, skipping malformed/null. */
  private readScopeFiles(scope: string): ParsedSkill[] {
    const dir = join(this.root, scope);
    const files = this.listMarkdown(dir);
    const parsed: ParsedSkill[] = [];
    for (const file of files) {
      const text = this.readSafe(join(dir, file));
      if (text === undefined) continue;
      const p = parseSkillFile(text);
      if (p) parsed.push(p);
    }
    return parsed;
  }

  private listScopes(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        // EXCLUDE the parking lot: a pending skill is inert — never an active scope.
        .filter((name) => name !== PENDING_DIR)
        .sort();
    } catch {
      return [];
    }
  }

  private listMarkdown(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      return [];
    }
  }

  private readSafe(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }

  private writeSafe(path: string, content: string): void {
    try {
      writeFileSync(path, content, "utf8");
    } catch {
      // A failed registry write must never break a turn or a /skills view.
    }
  }
}

/**
 * Stamp/update frontmatter fields on a skill file (Phase 2c). Operates ONLY on the leading
 * `---\n…\n---` block: for each given field, replace an existing `key: …` line or inject a new
 * one before the closing fence. Generic (used for `score` + `last_verified`); `Date.now`-free
 * — the caller passes the ISO `last_verified` (no clock in the store). Unknown/undefined fields
 * are skipped. Returns the file unchanged if no frontmatter fence is found.
 */
export function setFrontmatterFields(
  file: string,
  fields: { score?: number; last_verified?: string }
): string {
  const m = /^(---\n[\s\S]*?\n)(---\n[\s\S]*)$/.exec(file.replace(/\r\n/g, "\n"));
  if (!m) return file;
  let frontmatter = m[1]!;
  const set = (key: string, value: string): void => {
    const line = `${key}: ${value}`;
    const re = new RegExp(`^${key}:.*$`, "m");
    frontmatter = re.test(frontmatter)
      ? frontmatter.replace(re, line)
      : frontmatter.replace(/\n$/, `\n${line}\n`);
  };
  if (typeof fields.score === "number") set("score", fields.score.toFixed(2));
  if (fields.last_verified) set("last_verified", fields.last_verified);
  return frontmatter + m[2]!;
}

/** Sanitize a scope/name to a filename-safe slug: lowercase, [a-z0-9_-] only, no path parts. */
function sanitizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Whether `target` (an absolute path) is the root itself or nested inside it. */
function isInside(root: string, target: string): boolean {
  const r = resolve(root);
  return target === r || target.startsWith(`${r}/`);
}

/** Resolve a dir's real path (symlinks followed); fall back to `fallback` if it cannot resolve. */
function realRootOf(dir: string, fallback: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return fallback;
  }
}
