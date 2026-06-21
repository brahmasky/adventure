import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
