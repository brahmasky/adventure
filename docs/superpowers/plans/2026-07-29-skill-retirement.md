# Skill Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the skill lifecycle a death verb — commanded retire/restore (slash + natural language), rename-refine auto-retire, and a weekly suggest-only re-verify advisor.

**Architecture:** Mirror the `_pending/` idiom with a `_retired/` dir (inert, containment-checked, excluded from all active reads). Slash commands and Gate A natural-language verdicts call the same `SkillStore` methods. The advisor is a weekly daemon tick (lesson-consolidate idiom: flag-gated, single-row latch, ledger counts, quiet Telegram note only when it flags).

**Tech Stack:** TypeScript (ESM, strict), vitest, node:fs, node:sqlite (via existing RunStore), no new deps.

**Spec:** `docs/superpowers/specs/2026-07-29-skill-retirement-design.md`

**Repo conventions that bind every task:** existing tests are immutable; `##` never renders in Telegram (use `**bold**`); ledger events carry counts only; ticks never throw; run `npx tsc --noEmit` + `npx vitest run` before every commit. Work directly on `main` (repo convention — daemon deploys from this checkout); deploy at the end is `npm run build && launchctl kickstart -k gui/$UID/com.houge.daemon`.

**Spec §3 mechanism, made real (spec-review-senior BLOCKER fix):** the spec assumed the refine path feeds the old skill file to the writer — today it never does (`buildSkillAuthorQuestion(message)` is called without its `existingSkill` param; "refine" is detected post-hoc by name match). Task 3 closes that gap FIRST: when the request names exactly ONE active skill X, X's raw file is fed to the writer as `existingSkill` (a true refine — also fixes the writer authoring blind, which is how the SOC-ops skill happened). Auto-retire then fires ONLY on that fed-refine when the authored name Y ≠ X. Bare name-mention without the fed-refine NEVER retires (a request "like X but for podcasts" must not kill X); multiple mentioned skills → no feed, no auto-retire, a suggestion line instead.

**Accepted (with rationale):** retiring a name that already has a graveyard copy overwrites it — same name = same skill lineage; the graveyard holds the latest retired version. Documented in the store docstring.

---

## File structure

| File | Change |
|---|---|
| `src/skills/skill-store.ts` | `RETIRED_DIR`, retire/restore/listRetired/stampVerification, frontmatter strip helper, extended `SkillMeta` + `parseSkillFile`, pure `resolveSkillName` |
| `src/triggers/telegram-command-parser.ts` | `/skills retire\|restore <name>` (+ `retired` via existing scope arg) |
| `src/triggers/telegram-trigger-adapter.ts` | pass action+name through `program` (only if adapter maps `/skills` scope → program; verify at task start) |
| `src/gateway/gateway.ts` | `handleSkills` dispatch for retire/restore/retired, renders, HELP_TEXT, 系统任务 footer line |
| `src/core/core-worker.ts` | rename-refine auto-retire; Gate A retire/restore dispatch |
| `src/capabilities/skill-router.ts` | Gate A verdicts `retire`/`restore` + `target` field |
| `src/capabilities/skill-reverify.ts` | NEW — weekly advisor tick |
| `src/run/run-store.ts` | `skill_reverify_state` table + getters + `recordSkillReverifyTick` |
| `src/run/run-ledger.ts` | `skill_reverify_tick` event type + payload keys |
| `src/telegram/telegram-daemon.ts` | wire the tick after `runIdeaPanelTick` |
| `src/config/disarm-posture.ts` | add `HOUGE_SKILL_REVERIFY_ENABLED` to `DISARM_FLAGS` |
| Tests | `tests/skills/skill-store.test.ts` (extend), `tests/triggers/…parser` (extend), `tests/gateway/gateway-telegram.test.ts` (extend), `tests/capabilities/skill-reverify.test.ts` (NEW), core-worker skill tests (extend) |

---

### Task 1: Store — retire / restore / listRetired / stampVerification

**Files:**
- Modify: `src/skills/skill-store.ts`
- Test: `tests/skills/skill-store.test.ts` (extend; find the existing `SkillStore` describe block and its tmp-root helper — reuse it)

- [ ] **Step 1: Write the failing tests**

Add to `tests/skills/skill-store.test.ts` (reuse the file's existing tmp-root fixture helper; if it builds stores with `new SkillStore({ root })`, do the same):

```ts
describe("retire / restore lifecycle", () => {
  const file = (name: string, scope = "research") =>
    `---\nname: ${name}\nscope: ${scope}\nwhen: testing retirement\nanchors:\n  - a1\nversion: 1\norigin: commanded\nscore: 0.27\nlast_verified: 2026-07-28\n---\n\n1. Do the thing.`;

  it("retireSkill moves the file to _retired/<scope>/, stamps frontmatter, and excludes it from active reads", () => {
    const root = tmpRoot(); // the file's existing helper
    const store = new SkillStore({ root });
    store.writeSkill("research", "old-skill", file("old-skill"));

    const r = store.retireSkill("research", "old-skill", { date: "2026-07-29", by: "paco" });
    expect(r.ok).toBe(true);

    expect(store.list().map((m) => m.name)).not.toContain("old-skill");
    expect(store.readScopeBlock("research")).toBeUndefined();
    const retired = store.listRetired();
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({ name: "old-skill", scope: "research", retired: "2026-07-29", retired_by: "paco" });
  });

  it("retireSkill with supersededBy stamps the successor", () => {
    const root = tmpRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "old-skill", file("old-skill"));
    store.retireSkill("research", "old-skill", { date: "2026-07-29", by: "refine", supersededBy: "new-skill" });
    expect(store.listRetired()[0]).toMatchObject({ retired_by: "refine", superseded_by: "new-skill" });
  });

  it("retireSkill: not found vs already retired are distinct errors", () => {
    const root = tmpRoot();
    const store = new SkillStore({ root });
    expect(store.retireSkill("research", "ghost", { date: "2026-07-29", by: "paco" })).toEqual({ ok: false, error: "not found" });
    store.writeSkill("research", "old-skill", file("old-skill"));
    store.retireSkill("research", "old-skill", { date: "2026-07-29", by: "paco" });
    expect(store.retireSkill("research", "old-skill", { date: "2026-07-29", by: "paco" })).toEqual({ ok: false, error: "already retired" });
  });

  it("restoreSkill moves back, strips the retire stamps, keeps version/score/last_verified", () => {
    const root = tmpRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "old-skill", file("old-skill"));
    store.retireSkill("research", "old-skill", { date: "2026-07-29", by: "paco" });

    const r = store.restoreSkill("research", "old-skill");
    expect(r.ok).toBe(true);
    expect(store.listRetired()).toHaveLength(0);
    const back = store.readSkill("research", "old-skill");
    expect(back).not.toBeNull();
    expect(back!.meta).toMatchObject({ name: "old-skill", version: 1, last_verified: "2026-07-28" });
    expect(back!.meta.retired).toBeUndefined();
    expect(back!.meta.retired_by).toBeUndefined();
  });

  it("restoreSkill refuses to overwrite an active skill with the same name", () => {
    const root = tmpRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "x", file("x"));
    store.retireSkill("research", "x", { date: "2026-07-29", by: "paco" });
    store.writeSkill("research", "x", file("x")); // a NEW active x appears
    const r = store.restoreSkill("research", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("active skill");
  });

  it("_retired is not an active scope and a malformed retired file is skipped", () => {
    const root = tmpRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "keep", file("keep"));
    store.writeSkill("research", "bad", file("bad"));
    store.retireSkill("research", "bad", { date: "2026-07-29", by: "paco" });
    writeFileSync(join(root, "_retired", "research", "garbage.md"), "no frontmatter here");
    expect(store.list().map((m) => m.name)).toEqual(["keep"]);
    expect(store.listRetired().map((m) => m.name)).toEqual(["bad"]);
  });

  it("readRawSkill returns the full file text for an active skill, null for a missing one", () => {
    const root = tmpRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "s", file("s"));
    expect(store.readRawSkill("research", "s")).toContain("name: s");
    expect(store.readRawSkill("research", "ghost")).toBeNull();
  });

  it("stampVerification updates score + last_verified in place (no version bump)", () => {
    const root = tmpRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "s", file("s"));
    expect(store.stampVerification("research", "s", { score: 0.42, last_verified: "2026-08-02" })).toBe(true);
    const after = store.readSkill("research", "s");
    expect(after!.meta.last_verified).toBe("2026-08-02");
    expect(after!.meta.version).toBe(1);
  });
});

describe("resolveSkillName", () => {
  const metas = [
    { name: "periodic-news-newsletter", scope: "research", when: "w", anchors: [], chars: 1 },
    { name: "news-triage", scope: "ask", when: "w", anchors: [], chars: 1 }
  ] as SkillMeta[];

  it("exact name wins; scope/name form disambiguates; unambiguous substring matches", () => {
    expect(resolveSkillName(metas, "news-triage")).toMatchObject({ status: "one", meta: { name: "news-triage" } });
    expect(resolveSkillName(metas, "ask/news-triage")).toMatchObject({ status: "one" });
    expect(resolveSkillName(metas, "periodic")).toMatchObject({ status: "one", meta: { name: "periodic-news-newsletter" } });
  });

  it("ambiguous substring → many; unknown → none", () => {
    expect(resolveSkillName(metas, "news")).toMatchObject({ status: "many" });
    expect(resolveSkillName(metas, "zzz")).toEqual({ status: "none" });
  });
});
```

Also import `resolveSkillName` and `SkillMeta` from `../../src/skills/skill-store.js`, and `writeFileSync`/`join` at the top if not present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skills/skill-store.test.ts`
Expected: FAIL — `retireSkill is not a function`, `resolveSkillName` not exported.

- [ ] **Step 3: Implement in `src/skills/skill-store.ts`**

3a. Add `unlinkSync` to the fs import. Below `PENDING_DIR`:

```ts
/**
 * The graveyard (spec 2026-07-29): retired skills move to `<root>/_retired/<scope>/<name>.md`
 * — INERT exactly like `_pending` (under containment, excluded from every active read, never
 * folded, never counted against the cap). Retire-never-delete: the only removal verb moves a
 * file here; restore moves it back. Nothing in the skill lifecycle ever unlinks content
 * except as the second half of a move whose copy has already been written.
 */
export const RETIRED_DIR = "_retired";
```

3b. Extend `SkillMeta` with retire stamps:

```ts
export interface SkillMeta {
  name: string;
  scope: string;
  when: string;
  anchors: string[];
  version?: number;
  last_verified?: string;
  origin?: string;
  chars: number;
  /** Retire stamps — present only on metas parsed out of `_retired/`. */
  retired?: string;
  retired_by?: string;
  superseded_by?: string;
}
```

3c. In `parseSkillFile`, extend the returned `meta` spread (after the `origin` line):

```ts
      ...(flat.retired ? { retired: flat.retired } : {}),
      ...(flat.retired_by ? { retired_by: flat.retired_by } : {}),
      ...(flat.superseded_by ? { superseded_by: flat.superseded_by } : {})
```

and widen `ParsedSkill.meta`'s inline type with the same three optional string fields.

3d. Extend `setFrontmatterFields`'s `fields` parameter type to
`{ score?: number; last_verified?: string; retired?: string; retired_by?: string; superseded_by?: string }`
and add after the existing two `set(...)` calls:

```ts
  if (fields.retired) set("retired", fields.retired);
  if (fields.retired_by) set("retired_by", fields.retired_by);
  if (fields.superseded_by) set("superseded_by", fields.superseded_by);
```

3e. Add the strip helper next to `setFrontmatterFields`:

```ts
/** Remove the named `key: …` lines from the leading frontmatter block (restore un-stamps). */
export function stripFrontmatterFields(file: string, keys: string[]): string {
  const m = /^(---\n[\s\S]*?\n)(---\n[\s\S]*)$/.exec(file.replace(/\r\n/g, "\n"));
  if (!m) return file;
  let frontmatter = m[1]!;
  for (const key of keys) {
    frontmatter = frontmatter.replace(new RegExp(`^${key}:.*\\n`, "m"), "");
  }
  return frontmatter + m[2]!;
}
```

3f. Add the pure resolver (bottom of file, near the other exported helpers):

```ts
/**
 * Resolve a user-supplied skill reference against a meta list: exact `name` (optionally
 * `scope/name`) wins; else a substring match on the name; ambiguous → the candidates, so the
 * caller ASKS instead of guessing. The resolver is CODE — an LLM only ever supplies `query`.
 */
export function resolveSkillName(
  metas: SkillMeta[],
  query: string
): { status: "one"; meta: SkillMeta } | { status: "none" } | { status: "many"; metas: SkillMeta[] } {
  const raw = query.trim().toLowerCase();
  const slash = raw.indexOf("/");
  const scope = slash > 0 ? raw.slice(0, slash) : undefined;
  const name = slash > 0 ? raw.slice(slash + 1) : raw;
  const pool = scope ? metas.filter((m) => m.scope === scope) : metas;
  const exact = pool.filter((m) => m.name === name);
  if (exact.length === 1) return { status: "one", meta: exact[0]! };
  if (exact.length > 1) return { status: "many", metas: exact };
  const partial = pool.filter((m) => m.name.includes(name));
  if (partial.length === 1) return { status: "one", meta: partial[0]! };
  if (partial.length > 1) return { status: "many", metas: partial };
  return { status: "none" };
}
```

3g. Add the four `SkillStore` methods (place after `listPending`):

```ts
  /**
   * Retire an active skill: stamp `retired`/`retired_by`(/`superseded_by`) and MOVE the file to
   * `_retired/<scope>/` (write-then-unlink, so a failed write never loses the skill). Inert
   * afterwards. `"not found"` vs `"already retired"` are distinct so commands can answer cleanly.
   */
  retireSkill(
    scope: string,
    name: string,
    opts: { date: string; by: "paco" | "refine"; supersededBy?: string }
  ): { ok: true; path: string } | { ok: false; error: string } {
    const safeScope = sanitizeSlug(scope);
    const safeName = sanitizeSlug(name);
    if (!safeScope || !safeName) {
      return { ok: false, error: "scope and name must contain at least one [a-z0-9_-] character" };
    }
    const activePath = join(this.root, safeScope, `${safeName}.md`);
    const text = this.readSafe(activePath);
    if (text === undefined) {
      const parked = this.readSafe(join(this.root, RETIRED_DIR, safeScope, `${safeName}.md`));
      return { ok: false, error: parked !== undefined ? "already retired" : "not found" };
    }
    const stamped = setFrontmatterFields(text, {
      retired: opts.date,
      retired_by: opts.by,
      ...(opts.supersededBy ? { superseded_by: opts.supersededBy } : {})
    });
    const written = this.writeContained([RETIRED_DIR, safeScope], safeName, stamped);
    if (!written.ok) return written;
    try {
      unlinkSync(activePath);
    } catch (error) {
      return { ok: false, error: `retired copy written but active file not removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.regenerateRegistry();
    return written;
  }

  /** Restore a retired skill: strip the retire stamps and MOVE back. Never overwrites an active name. */
  restoreSkill(scope: string, name: string): { ok: true; path: string } | { ok: false; error: string } {
    const safeScope = sanitizeSlug(scope);
    const safeName = sanitizeSlug(name);
    if (!safeScope || !safeName) {
      return { ok: false, error: "scope and name must contain at least one [a-z0-9_-] character" };
    }
    const retiredPath = join(this.root, RETIRED_DIR, safeScope, `${safeName}.md`);
    const text = this.readSafe(retiredPath);
    if (text === undefined) return { ok: false, error: "not found in _retired" };
    if (this.readSafe(join(this.root, safeScope, `${safeName}.md`)) !== undefined) {
      return { ok: false, error: `an active skill named "${safeName}" already exists in "${safeScope}" — refusing to overwrite` };
    }
    const stripped = stripFrontmatterFields(text, ["retired", "retired_by", "superseded_by"]);
    const written = this.writeContained([safeScope], safeName, stripped);
    if (!written.ok) return written;
    try {
      unlinkSync(retiredPath);
    } catch (error) {
      return { ok: false, error: `restored copy written but retired file not removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.regenerateRegistry();
    return written;
  }

  /** The graveyard view — parsed metas (incl. retire stamps) under `_retired/**`. */
  listRetired(): SkillMeta[] {
    const retiredRoot = join(this.root, RETIRED_DIR);
    const out: SkillMeta[] = [];
    let scopes: string[];
    try {
      scopes = readdirSync(retiredRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    for (const s of scopes) {
      const dir = join(retiredRoot, s);
      for (const file of this.listMarkdown(dir)) {
        const text = this.readSafe(join(dir, file));
        if (text === undefined) continue;
        const parsed = parseSkillFile(text);
        if (parsed) out.push({ ...parsed.meta, scope: s, chars: parsed.body.length });
      }
    }
    return out;
  }

  /** Raw file text of an active skill (frontmatter + body) — the refine feed. Null if absent. */
  readRawSkill(scope: string, name: string): string | null {
    const safeScope = sanitizeSlug(scope);
    const safeName = sanitizeSlug(name);
    if (!safeScope || !safeName) return null;
    return this.readSafe(join(this.root, safeScope, `${safeName}.md`)) ?? null;
  }

  /** Re-verify stamp (weekly advisor): update score + last_verified in place — no version bump. */
  stampVerification(scope: string, name: string, fields: { score: number; last_verified: string }): boolean {
    const safeScope = sanitizeSlug(scope);
    const safeName = sanitizeSlug(name);
    if (!safeScope || !safeName) return false;
    const path = join(this.root, safeScope, `${safeName}.md`);
    const text = this.readSafe(path);
    if (text === undefined) return false;
    try {
      writeFileSync(path, setFrontmatterFields(text, fields), "utf8");
    } catch {
      return false;
    }
    this.regenerateRegistry();
    return true;
  }
```

3h. In `listScopes()`, extend the parking-lot exclusion:

```ts
        .filter((name) => name !== PENDING_DIR && name !== RETIRED_DIR)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skills/skill-store.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean / all green.

```bash
git add src/skills/skill-store.ts tests/skills/skill-store.test.ts
git commit -m "feat(skills): retire/restore lifecycle in the store — _retired graveyard, stamps, resolveSkillName

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Slash commands — `/skills retire|restore <name>` + `/skills retired`

**Files:**
- Modify: `src/triggers/telegram-command-parser.ts` (the `parseSkills` fn + the `{ type: "skills" … }` union member)
- Modify: `src/triggers/telegram-trigger-adapter.ts` — **first CHECK** how the existing `/skills <scope>` maps `scope` into the event's `program`; extend the same mapping so `action`+`name` ride `program` as `"<action> <name>"` (no `TypedTaskEvent` shape change)
- Modify: `src/gateway/gateway.ts` (`handleSkills`, new renders, `HELP_TEXT`)
- Test: extend the parser test file next to `telegram-command-parser.ts`'s existing tests, and `tests/gateway/gateway-telegram.test.ts`

- [ ] **Step 1: Write the failing parser tests** (same file/describe style as existing `/skills` cases)

```ts
it("parses /skills retire <name> and /skills restore <name>", () => {
  expect(parseTelegramCommand("/skills retire old-skill")).toEqual({
    ok: true,
    command: { type: "skills", action: "retire", name: "old-skill" }
  });
  expect(parseTelegramCommand("/skills restore research/old-skill")).toEqual({
    ok: true,
    command: { type: "skills", action: "restore", name: "research/old-skill" }
  });
});

it("rejects retire/restore without exactly one name", () => {
  expect(parseTelegramCommand("/skills retire").ok).toBe(false);
  expect(parseTelegramCommand("/skills retire a b").ok).toBe(false);
});

it("/skills retired still parses as the scope-arg form (graveyard list)", () => {
  expect(parseTelegramCommand("/skills retired")).toEqual({ ok: true, command: { type: "skills", scope: "retired" } });
});
```

(Adjust the entry-point name to the file's actual exported parse function if different — check its existing tests.)

- [ ] **Step 2: Run to fail** — `npx vitest run tests/triggers/` → FAIL.

- [ ] **Step 3: Implement parser**

Union member becomes:

```ts
  | { type: "skills"; scope?: string; action?: "retire" | "restore"; name?: string }
```

`parseSkills` becomes:

```ts
function parseSkills(words: string[]): TelegramCommandParseResult {
  if (words.length === 0) return { ok: true, command: { type: "skills" } };
  const first = words[0]!.toLowerCase();
  if (first === "retire" || first === "restore") {
    if (words.length !== 2) return invalid(`/skills ${first} requires exactly one skill name`);
    return { ok: true, command: { type: "skills", action: first, name: words[1]! } };
  }
  if (words.length > 1) return invalid("/skills requires at most one scope");
  return { ok: true, command: { type: "skills", scope: words[0]! } };
}
```

- [ ] **Step 4: Adapter pass-through**

In `telegram-trigger-adapter.ts`, find where `command.type === "skills"` builds the event (it currently forwards `scope` as `program`). Extend:

```ts
program: command.action ? `${command.action} ${command.name}` : command.scope
```

(match the surrounding style — if it uses a conditional spread for `program`, keep that idiom).

- [ ] **Step 5: Write the failing gateway tests** (in `tests/gateway/gateway-telegram.test.ts`, alongside the existing `/skills` tests — reuse that block's gateway/store fixtures; seed skills through the fixture's `SkillStore`):

```ts
it("/skills retire <name> moves the skill to the graveyard and confirms", () => {
  // fixture: seed one active skill named "old-skill" in scope "research" via the test SkillStore
  const result = gateway.intake(skillsEvent("retire old-skill"));
  expect(result).toMatchObject({ ok: true, status: "skills_returned" });
  const text = lastOutboxText(); // the block's existing outbox helper
  expect(text).toContain("Retired");
  expect(text).toContain("old-skill");
  expect(text).toContain("/skills restore");
});

it("/skills retire unknown-name lists the available names instead of guessing", () => {
  const text = intakeAndReadOutbox(skillsEvent("retire nope"));
  expect(text).toContain('No active skill matches "nope"');
});

it("/skills retired renders the graveyard with stamps, bold not ##", () => {
  // fixture: retire one seeded skill first
  const text = intakeAndReadOutbox(skillsEvent("retired"));
  expect(text).toContain("**old-skill**");
  expect(text).toContain("retired 2026-");
  expect(text).not.toContain("##");
});

it("/skills restore round-trips", () => {
  const text = intakeAndReadOutbox(skillsEvent("restore old-skill"));
  expect(text).toContain("Restored");
});
```

(`skillsEvent(program)` = the block's existing event-builder with `program` set; follow its idempotency-key conventions — each call needs a fresh key.)

- [ ] **Step 6: Implement `handleSkills` dispatch + renders in `gateway.ts`**

At the top of `handleSkills`, after the replay/conflict guards, replace the current scope/pending block with:

```ts
    const program = typeof event.program === "string" ? event.program.trim() : "";
    const [first, ...restWords] = program.split(/\s+/).filter(Boolean);
    const action = first === "retire" || first === "restore" ? first : undefined;

    let text: string;
    if (action) {
      text = this.executeSkillLifecycle(action, restWords.join(" "), now);
    } else {
      const scope = program;
      const isPending = scope.toLowerCase() === "pending";
      const isRetired = scope.toLowerCase() === "retired";
      this.skillStore.regenerateRegistry();
      text = isPending
        ? formatPendingText(this.skillStore.listPending())
        : isRetired
          ? formatRetiredText(this.skillStore.listRetired())
          : formatSkillsText(scope || undefined, this.skillStore.list(scope || undefined));
    }
```

then keep the existing result/enqueue/record tail, with `payload: { text }`.

Add the executor method:

```ts
  /** `/skills retire|restore <name>` — deterministic lifecycle verbs on the skill store. */
  private executeSkillLifecycle(action: "retire" | "restore", name: string, now: string): string {
    const pool = action === "retire" ? this.skillStore.list() : this.skillStore.listRetired();
    const resolved = resolveSkillName(pool, name);
    if (resolved.status === "none") {
      const names = pool.map((m) => `${m.scope}/${m.name}`).join(" · ") || "(none)";
      const where = action === "retire" ? "active" : "retired";
      return `No ${where} skill matches "${name}". Available: ${names}`;
    }
    if (resolved.status === "many") {
      const names = resolved.metas.map((m) => `${m.scope}/${m.name}`).join(" · ");
      return `"${name}" is ambiguous — use /skills ${action} <scope>/<name>. Matches: ${names}`;
    }
    const { scope, name: skillName } = resolved.meta;
    if (action === "retire") {
      const r = this.skillStore.retireSkill(scope, skillName, { date: now.slice(0, 10), by: "paco" });
      return r.ok
        ? `Retired **${skillName}** (${scope}) → skills/_retired/. Inert — restore with /skills restore ${skillName}.`
        : `Could not retire "${skillName}": ${r.error}`;
    }
    const r = this.skillStore.restoreSkill(scope, skillName);
    return r.ok
      ? `Restored **${skillName}** (${scope}) — active again, folds on the next matching run.`
      : `Could not restore "${skillName}": ${r.error}`;
  }
```

Add the render (near `formatPendingText`):

```ts
/** Render `/skills retired`: the graveyard — inert, restorable, with lineage stamps. */
function formatRetiredText(metas: SkillMeta[]): string {
  if (metas.length === 0) return "No retired skills. Retire one with /skills retire <name>.";
  return [
    "Retired skills — inert (never folded). /skills restore <name> to bring one back:",
    "",
    ...metas.map(
      (m) =>
        `**${m.name}** (${m.scope}) · retired ${m.retired ?? "?"} · by ${m.retired_by ?? "?"}` +
        (m.superseded_by ? ` · superseded by ${m.superseded_by}` : "")
    )
  ].join("\n");
}
```

Import `resolveSkillName` from `../skills/skill-store.js`. Update `HELP_TEXT`'s skills line:

```ts
  "/skills — 可用技能（/skills <scope> · retire/restore <name> · retired · pending）",
```

- [ ] **Step 7: Run to pass** — `npx vitest run tests/triggers/ tests/gateway/` → PASS.

- [ ] **Step 8: Typecheck + full suite + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/triggers src/gateway tests/triggers tests/gateway
git commit -m "feat(skills): /skills retire|restore <name> + /skills retired graveyard view

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: True refine feed + rename auto-retire (core-worker)

**Files:**
- Modify: `src/core/core-worker.ts` (`authorAndWriteSkill` authoring loop + `writeActiveSkill` + new helper)
- Test: extend the existing core-worker skill-author tests (find the file testing `runSkill`/`writeActiveSkill` behavior — `grep -rln "authorAndWriteSkill\|runSkill" tests/`); reuse its fake-store/LLM fixtures

Mechanism (BLOCKER fix from spec review): a true refine is DETECTED when the request names
exactly ONE active skill; that skill's raw file is fed to the writer (`buildSkillAuthorQuestion`'s
existing-but-unused `existingSkill` param). Auto-retire fires ONLY when a fed-refine's authored
name differs from the fed skill's name. No fed-refine → no auto-retire, ever.

- [ ] **Step 1: Failing tests**

```ts
it("a request naming ONE active skill feeds its file to the writer (true refine)", async () => {
  // fixture: active "siem-soar-ueba-weekly-report" (research); capture the author LLM's question.
  await runSkillViaFixture("改进 siem-soar-ueba-weekly-report 技能：改成通用的新闻周报方法");
  const authorQuestion = capturedAuthorQuestion(); // fixture helper over the stubbed runLlm calls
  expect(authorQuestion).toContain("This skill ALREADY EXISTS");
  expect(authorQuestion).toContain("name: siem-soar-ueba-weekly-report");
});

it("a fed-refine whose authored name DIFFERS auto-retires the predecessor as superseded", async () => {
  // author stub returns a valid file named "periodic-news-newsletter"
  const report = await runSkillViaFixture("改进 siem-soar-ueba-weekly-report 技能：改成通用的新闻周报方法");
  expect(report).toContain("Retired predecessor");
  expect(store.list().map((m) => m.name)).not.toContain("siem-soar-ueba-weekly-report");
  expect(store.listRetired()[0]).toMatchObject({
    name: "siem-soar-ueba-weekly-report",
    retired_by: "refine",
    superseded_by: "periodic-news-newsletter"
  });
});

it("same-name fed-refine does NOT touch the graveyard", async () => {
  const report = await runSkillViaFixture("改进 periodic-news-newsletter 技能：补充引用要求");
  expect(report).not.toContain("Retired predecessor");
  expect(store.listRetired()).toHaveLength(0);
});

it("mentioning a skill WITHOUT a fed-refine never retires it", async () => {
  // fixture: two active skills → mention both → no unambiguous feed → no retire
  const report = await runSkillViaFixture("参考 periodic-news-newsletter 和 news-triage 写个播客技能");
  expect(store.listRetired()).toHaveLength(0);
  expect(report).not.toContain("Retired predecessor");
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

3a. In `authorAndWriteSkill`, before the authoring loop, resolve the refine feed:

```ts
    // True-refine detection: the request names exactly ONE active skill → feed its file to the
    // writer (the writer must see what it is improving — spec §3). Zero or many mentions → author
    // fresh; auto-retire is gated on this feed, so a passing mention can never kill a skill.
    const mentioned = this.skillStore.list().filter((m) => message.includes(m.name));
    const fed = mentioned.length === 1 ? mentioned[0]! : undefined;
    const fedFile = fed ? this.skillStore.readRawSkill(fed.scope, fed.name) ?? undefined : undefined;
```

and change the author call to `buildSkillAuthorQuestion(message, fedFile)`. (The guided-refine
loop's `buildGuidedRefineQuestion(message, parsed.file, gate.failing)` stays as is — it already
feeds the draft.)

3b. `writeActiveSkill` gains a parameter `fed: { scope: string; name: string } | undefined`
(last param); all three call sites in `authorAndWriteSkill` pass `fedFile ? fed : undefined`
(a feed that failed to read is NOT a fed-refine).

3c. After the successful `writeSkill` call in `writeActiveSkill`:

```ts
    const retiredLines = fed && fed.name !== parsed.name ? this.retireSuperseded(fed, parsed.name) : [];
```

append `...retiredLines` to the `skillReport` lines array (after the `→ ${action} skills/…` line).

```ts
  /** Fed-refine rename: the predecessor moves to the graveyard with lineage (spec §3). */
  private retireSuperseded(fed: { scope: string; name: string }, successor: string): string[] {
    const r = this.skillStore.retireSkill(fed.scope, fed.name, {
      date: new Date().toISOString().slice(0, 10),
      by: "refine",
      supersededBy: successor
    });
    return [
      r.ok
        ? `→ Retired predecessor skills/${fed.scope}/${fed.name}.md (superseded by ${successor}). /skills retired to view.`
        : `→ Could not retire predecessor "${fed.name}": ${r.error}`
    ];
  }
```

- [ ] **Step 4: Run to pass; typecheck + full suite.**

- [ ] **Step 5: Commit**

```bash
git add src/core/core-worker.ts tests/
git commit -m "feat(skills): rename-refine auto-retires the named predecessor (superseded_by lineage)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Natural-language retire/restore (Gate A)

**Operability note (accepted):** NL retire only reaches Gate A when the UPSTREAM intent
classifier routes the turn to the skill branch — untouched here, unverifiable in unit tests.
The slash command (Task 2) is the deterministic fallback; NL is exercised at the live gate.

**Files:**
- Modify: `src/capabilities/skill-router.ts` (verdicts + discipline + parse)
- Modify: `src/core/core-worker.ts` (`runSkill` dispatch)
- Test: extend the skill-router tests (same dir as its existing tests) + one core-worker dispatch test

- [ ] **Step 1: Failing router tests**

```ts
it("parses retire/restore verdicts with a target", () => {
  expect(parseGateAVerdict('{"verdict":"retire","target":"siem-soar-ueba-weekly-report","reason":"user asked to retire"}'))
    .toEqual({ verdict: "retire", target: "siem-soar-ueba-weekly-report", reason: "user asked to retire" });
  expect(parseGateAVerdict('{"verdict":"restore","target":"x","reason":"r"}')).toMatchObject({ verdict: "restore", target: "x" });
});

it("a retire verdict without a target degrades to unsure", () => {
  expect(parseGateAVerdict('{"verdict":"retire","reason":"r"}')).toMatchObject({ verdict: "unsure" });
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement router**

```ts
export type GateAVerdict = "skill" | "lesson" | "code" | "unsure" | "retire" | "restore";
```

`GateAResult` gains `target?: string`. In `GATE_A_DISCIPLINE`, extend the JSON shape doc to
`{"verdict":"skill"|"lesson"|"code"|"unsure"|"retire"|"restore","scope"?:string,"lesson"?:string,"target"?:string,"reason":string}`
and append (before the final DATA-wall sentence):

```
"If the request asks to RETIRE/remove/deactivate (退役/停用/删除) an EXISTING skill, choose \"retire\" and set \"target\" to the skill name as the user wrote it. If it asks to RESTORE/re-enable (恢复/启用) a retired skill, choose \"restore\" with \"target\". "
```

In `parseGateAVerdict`: accept the two new raw verdicts; capture `target` like `lesson`; and after building `result`, guard:

```ts
  if ((result.verdict === "retire" || result.verdict === "restore") && !((typeof record.target === "string") && record.target.trim().length > 0)) {
    return { verdict: "unsure", reason: "retire/restore verdict without a target" };
  }
  if (typeof record.target === "string" && record.target.trim().length > 0) {
    result.target = record.target.trim();
  }
```

- [ ] **Step 4: Implement `runSkill` dispatch** (in the branch ladder after the Gate A verdict, before the `"skill"` branch):

```ts
    if (verdict.verdict === "retire" || verdict.verdict === "restore") {
      return this.skillLifecycleFromGateA(verdict);
    }
```

```ts
  /** NL retire/restore: Gate A extracted the user's words; resolution + action are code. */
  private skillLifecycleFromGateA(verdict: GateAResult): HelperResult {
    const action = verdict.verdict as "retire" | "restore";
    const target = verdict.target ?? "";
    const pool = action === "retire" ? this.skillStore.list() : this.skillStore.listRetired();
    const resolved = resolveSkillName(pool, target);
    if (resolved.status === "none") {
      const names = pool.map((m) => `${m.scope}/${m.name}`).join(" · ") || "(none)";
      return this.skillReport(`${action}: no match for "${target}"`, [
        "Origin: you asked",
        `Gate A qualify: → ${action.toUpperCase()} (${verdict.reason})`,
        `→ No ${action === "retire" ? "active" : "retired"} skill matches "${target}". Available: ${names}`
      ]);
    }
    if (resolved.status === "many") {
      const names = resolved.metas.map((m) => `${m.scope}/${m.name}`).join(" · ");
      return this.skillReport(`${action}: "${target}" is ambiguous`, [
        "Origin: you asked",
        `Gate A qualify: → ${action.toUpperCase()} (${verdict.reason})`,
        `→ Which one? ${names} — reply with /skills ${action} <scope>/<name>.`
      ]);
    }
    const { scope, name } = resolved.meta;
    const r =
      action === "retire"
        ? this.skillStore.retireSkill(scope, name, { date: new Date().toISOString().slice(0, 10), by: "paco" })
        : this.skillStore.restoreSkill(scope, name);
    return this.skillReport(`${r.ok ? `${action}d` : `${action} failed for`} "${name}" (${scope})`, [
      "Origin: you asked",
      `Gate A qualify: → ${action.toUpperCase()} (${verdict.reason})`,
      r.ok
        ? action === "retire"
          ? `→ Retired skills/${scope}/${name}.md — inert. /skills restore ${name} to undo.`
          : `→ Restored skills/${scope}/${name}.md — active again.`
        : `→ ${r.error}`
    ]);
  }
```

Import `resolveSkillName` in core-worker. Add one dispatch test in the core-worker skill tests (stub the Gate A LLM to return a retire verdict; assert the store moved the file and the report contains "Retired").

- [ ] **Step 5: Run to pass; typecheck + full suite; commit**

```bash
git add src/capabilities/skill-router.ts src/core/core-worker.ts tests/
git commit -m "feat(skills): natural-language retire/restore via Gate A target extraction, code-side resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Weekly re-verify advisor tick

**Files:**
- Create: `src/capabilities/skill-reverify.ts`
- Modify: `src/run/run-store.ts` (state table + getters + record method — mirror `radar_panel_state` at ~5363-5380 and `recordLessonConsolidateTick` at ~2613)
- Modify: `src/run/run-ledger.ts` (event union ~line 53 area + payload-keys map ~line 185 area)
- Modify: `src/telegram/telegram-daemon.ts` (wire after `runIdeaPanelTick`, ~line 400)
- Modify: `src/config/disarm-posture.ts` (`DISARM_FLAGS` + a comment line, matching neighbors)
- Modify: `src/gateway/gateway.ts` (`formatSystemScheduleSection` — reverify line)
- Test: create `tests/capabilities/skill-reverify.test.ts`; extend the gateway footer tests

- [ ] **Step 1: run-store + run-ledger plumbing** (mechanical, mirror the named patterns exactly)

run-ledger union: add `| "skill_reverify_tick"`. Payload keys map:

```ts
  // Skill retirement spec (2026-07-29): one summary per weekly re-verify tick — counts only,
  // no skill text (bodies-out-of-the-ledger invariant).
  skill_reverify_tick: ["checked", "passed", "flagged"],
```

run-store migration block (append in the same migration section that created `radar_panel_state`, as a NEW guarded block following the file's established `CREATE TABLE IF NOT EXISTS` idiom):

```sql
CREATE TABLE IF NOT EXISTS skill_reverify_state (id INTEGER PRIMARY KEY, last_run_at TEXT);
INSERT OR IGNORE INTO skill_reverify_state (id) VALUES (1);
```

Methods (next to the radar-panel pair at ~2831):

```ts
  getSkillReverifyLastRun(): string | null {
    const row = this.db
      .prepare(`SELECT last_run_at FROM skill_reverify_state WHERE id = 1`)
      .get() as { last_run_at: string | null } | undefined;
    return row?.last_run_at ?? null;
  }

  setSkillReverifyLastRun(now: string): void {
    this.db.prepare(`UPDATE skill_reverify_state SET last_run_at = ? WHERE id = 1`).run(now);
  }

  recordSkillReverifyTick(payload: { checked: number; passed: number; flagged: number }): void {
    // mirror recordLessonConsolidateTick's appendLedgerEvent call shape exactly
  }
```

(Fill `recordSkillReverifyTick`'s body by copying `recordLessonConsolidateTick` (~2613) and swapping event type + payload.)

- [ ] **Step 2: Failing capability tests** — `tests/capabilities/skill-reverify.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../../src/skills/skill-store.js";
import { runSkillReverifyTick, resolveSkillReverifyAt, resolveSkillReverifyAgeDays } from "../../src/capabilities/skill-reverify.js";

const skillFile = (name: string, lastVerified?: string) =>
  `---\nname: ${name}\nscope: research\nwhen: testing\nanchors:\n  - a\nversion: 1\n${lastVerified ? `last_verified: ${lastVerified}\n` : ""}---\n\n1. Step.`;

function fixture(overrides: Partial<Parameters<typeof runSkillReverifyTick>[0]> = {}) {
  const skills = new SkillStore({ root: mkdtempSync(join(tmpdir(), "houge-reverify-")) });
  const store = {
    getSkillReverifyLastRun: vi.fn(() => null as string | null),
    setSkillReverifyLastRun: vi.fn(),
    recordSkillReverifyTick: vi.fn(),
    enqueueNotification: vi.fn()
  };
  const env = { HOUGE_SKILL_REVERIFY_ENABLED: "1" };
  // Gate B stub: every pass judges one criterion, ok=0 → score 0 (fail) unless overridden.
  const anchorLlm = vi.fn(async () => '{"criteria":[{"text":"c","ok":0}]}');
  return { skills, store, env, anchorLlm, ...overrides };
}

describe("runSkillReverifyTick", () => {
  const NOW = "2026-08-30T00:30:00.000Z"; // Sunday 10:30 Sydney

  it("does nothing when the flag is off", async () => {
    const f = fixture();
    await runSkillReverifyTick({ ...f, env: {}, now: NOW, chatId: "1" });
    expect(f.store.setSkillReverifyLastRun).not.toHaveBeenCalled();
  });

  it("stamps the latch BEFORE verifying, flags a failing stale skill, records counts, notifies", async () => {
    const f = fixture();
    f.skills.writeSkill("research", "stale-bad", skillFile("stale-bad", "2026-07-01"));
    await runSkillReverifyTick({ ...f, now: NOW, chatId: "42" });
    expect(f.store.setSkillReverifyLastRun).toHaveBeenCalledWith(NOW);
    expect(f.store.recordSkillReverifyTick).toHaveBeenCalledWith({ checked: 1, passed: 0, flagged: 1 });
    const note = f.store.enqueueNotification.mock.calls[0]![0];
    expect(note.payload.text).toContain("stale-bad");
    expect(note.payload.text).toContain("/skills retire stale-bad");
  });

  it("a passing stale skill gets last_verified refreshed and NO message (quiet when healthy)", async () => {
    const f = fixture({ anchorLlm: vi.fn(async () => '{"criteria":[{"text":"c","ok":1}]}') });
    f.skills.writeSkill("research", "stale-good", skillFile("stale-good", "2026-07-01"));
    await runSkillReverifyTick({ ...f, now: NOW, chatId: "42" });
    expect(f.skills.readSkill("research", "stale-good")!.meta.last_verified).toBe("2026-08-30");
    expect(f.store.enqueueNotification).not.toHaveBeenCalled();
    expect(f.store.recordSkillReverifyTick).toHaveBeenCalledWith({ checked: 1, passed: 1, flagged: 0 });
  });

  it("fresh skills are not candidates; an unscored Gate B neither stamps nor flags", async () => {
    const f = fixture({ anchorLlm: vi.fn(async () => undefined) }); // every pass errors → unscored
    f.skills.writeSkill("research", "fresh", skillFile("fresh", "2026-08-29"));
    f.skills.writeSkill("research", "stale", skillFile("stale", "2026-07-01"));
    await runSkillReverifyTick({ ...f, now: NOW, chatId: "42" });
    expect(f.skills.readSkill("research", "stale")!.meta.last_verified).toBe("2026-07-01"); // untouched
    expect(f.store.recordSkillReverifyTick).toHaveBeenCalledWith({ checked: 1, passed: 0, flagged: 0 });
    expect(f.store.enqueueNotification).not.toHaveBeenCalled();
  });

  it("not due (fired earlier this week) → no work", async () => {
    const f = fixture();
    f.store.getSkillReverifyLastRun.mockReturnValue("2026-08-30T00:05:00.000Z");
    f.skills.writeSkill("research", "stale", skillFile("stale", "2026-07-01"));
    await runSkillReverifyTick({ ...f, now: NOW, chatId: "42" });
    expect(f.store.setSkillReverifyLastRun).not.toHaveBeenCalled();
  });
});

describe("resolvers", () => {
  it("AT defaults to sun 10:00, honors overrides, off disables", () => {
    expect(resolveSkillReverifyAt({})).toEqual({ day: "sun", at: "10:00" });
    expect(resolveSkillReverifyAt({ HOUGE_SKILL_REVERIFY_AT: "mon 08:30" })).toEqual({ day: "mon", at: "08:30" });
    expect(resolveSkillReverifyAt({ HOUGE_SKILL_REVERIFY_AT: "off" })).toBeNull();
    expect(resolveSkillReverifyAt({ HOUGE_SKILL_REVERIFY_AT: "garbage" })).toEqual({ day: "sun", at: "10:00" });
  });
  it("age days default 28, positive override wins", () => {
    expect(resolveSkillReverifyAgeDays({})).toBe(28);
    expect(resolveSkillReverifyAgeDays({ HOUGE_SKILL_REVERIFY_AGE_DAYS: "7" })).toBe(7);
  });
});
```

- [ ] **Step 3: Run to fail.**

- [ ] **Step 4: Implement `src/capabilities/skill-reverify.ts`**

```ts
import { verifySkill, resolveGateBPasses, resolveGateBThreshold, type AnchorLlm } from "./anchor-verify.js";
import { resolveRadarTz } from "./idea-radar.js";
import { resolveSkillsEnabled, type SkillStore } from "../skills/skill-store.js";
import { computeNextRunAt, type ScheduleWeekday } from "../run/schedule-spec.js";

/**
 * Weekly skill re-verify advisor (spec 2026-07-29 §4). SUGGEST-ONLY: re-runs Gate B on stale
 * skills; passers get `last_verified` refreshed, failers are FLAGGED to Paco with the failing
 * criteria and the exact retire command. NEVER moves a file. Quiet when healthy. Latch is
 * stamped before any LLM call (panel idiom). Closes the deferred Phase-2c re-verification item.
 */

export const REVERIFY_DEFAULT_SCHEDULE: { day: ScheduleWeekday; at: string } = { day: "sun", at: "10:00" };
const REVERIFY_WEEKDAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const REVERIFY_AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_AGE_DAYS = 28;
const DAY_MS = 86_400_000;

/** Default OFF (`HOUGE_SKILL_REVERIFY_ENABLED=1` arms; in DISARM_FLAGS). */
export function resolveSkillReverifyEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.HOUGE_SKILL_REVERIFY_ENABLED ?? "").trim() === "1";
}

/** `HOUGE_SKILL_REVERIFY_AT` — "sun 10:00" default · "off" disables · malformed → default (resolvePanelAt idiom). */
export function resolveSkillReverifyAt(env: NodeJS.ProcessEnv): { day: ScheduleWeekday; at: string } | null {
  const raw = env.HOUGE_SKILL_REVERIFY_AT;
  if (raw === undefined) return { ...REVERIFY_DEFAULT_SCHEDULE };
  const folded = raw.trim().toLowerCase();
  if (folded === "off") return null;
  const tokens = folded.split(/\s+/);
  if (tokens.length !== 2) return { ...REVERIFY_DEFAULT_SCHEDULE };
  const [day, at] = tokens as [string, string];
  if (!REVERIFY_WEEKDAYS.has(day) || !REVERIFY_AT_PATTERN.test(at)) return { ...REVERIFY_DEFAULT_SCHEDULE };
  return { day: day as ScheduleWeekday, at };
}

/** `HOUGE_SKILL_REVERIFY_AGE_DAYS` — a skill is stale when last_verified is older (default 28). */
export function resolveSkillReverifyAgeDays(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_SKILL_REVERIFY_AGE_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AGE_DAYS;
}

export interface SkillReverifyStateStore {
  getSkillReverifyLastRun(): string | null;
  setSkillReverifyLastRun(now: string): void;
  recordSkillReverifyTick(payload: { checked: number; passed: number; flagged: number }): void;
  enqueueNotification(input: {
    target: { kind: "telegram"; chat_id: string };
    intent_type: string;
    idempotency_key: string;
    correlation_id: string;
    payload: { text: string };
  }): void;
}

export interface SkillReverifyTickInput {
  store: SkillReverifyStateStore;
  skills: SkillStore;
  anchorLlm: AnchorLlm;
  env: NodeJS.ProcessEnv;
  now: string;
  chatId: string | null;
}

interface Flagged {
  name: string;
  scope: string;
  score: number;
  threshold: number;
  failing: string[];
}

/**
 * One flagged skill per block; **bold** only (no ## — the converter has no heading support).
 * Failing criteria are Gate B LLM OUTPUT — escape them with the repo's Telegram escape helper
 * (grep `escapeForTelegram`'s export — the scoped /lessons render is the reference usage) so
 * model-authored markup never lands raw in the HTML converter.
 */
export function formatReverifyReport(flags: Flagged[]): string {
  const blocks = flags.map((f) => {
    const failing =
      f.failing.length > 0
        ? f.failing.slice(0, 3).map((c) => `   • ${escapeForTelegram(c)}`).join("\n")
        : "   • (no criteria captured)";
    return `**${f.name}** (${f.scope}) · score ${f.score.toFixed(2)} < ${f.threshold.toFixed(2)}\n${failing}\n→ retire: /skills retire ${f.name} · keep: do nothing (re-checked next tick)`;
  });
  return [`🐒 Skill re-verify — ${flags.length} flagged`, "", ...blocks].join("\n\n");
}

/**
 * The weekly tick. Never throws; every early-out is silent. Latch BEFORE LLM work so a crashed
 * pass cannot re-fire in a loop. Unscored (Gate B error) → skip: neither stamped (staleness is
 * not laundered) nor flagged (an error never condemns).
 */
export async function runSkillReverifyTick(input: SkillReverifyTickInput): Promise<{ ran: boolean }> {
  try {
    if (!resolveSkillsEnabled(input.env) || !resolveSkillReverifyEnabled(input.env)) return { ran: false };
    const at = resolveSkillReverifyAt(input.env);
    if (at === null) return { ran: false };
    const tz = resolveRadarTz(input.env);
    const spec = { kind: "weekly", day: at.day, at: at.at } as const;
    const anchor = input.store.getSkillReverifyLastRun() ?? new Date(0).toISOString();
    const next = computeNextRunAt(spec, tz, anchor);
    if (next === null || next > input.now) return { ran: false };

    input.store.setSkillReverifyLastRun(input.now);

    const ageDays = resolveSkillReverifyAgeDays(input.env);
    const nowMs = Date.parse(input.now);
    const stale = input.skills.list().filter((m) => {
      if (!m.last_verified) return true;
      const then = Date.parse(m.last_verified);
      return !Number.isFinite(then) || nowMs - then > ageDays * DAY_MS;
    });

    let passed = 0;
    const flags: Flagged[] = [];
    for (const m of stale) {
      const skill = input.skills.readSkill(m.scope, m.name);
      if (!skill) continue;
      const gate = await verifySkill(
        { when: skill.meta.when, body: skill.body },
        { passes: resolveGateBPasses(input.env), threshold: resolveGateBThreshold(input.env) },
        input.anchorLlm
      );
      if (gate.unscored) continue;
      if (gate.passed) {
        passed += 1;
        input.skills.stampVerification(m.scope, m.name, { score: gate.score, last_verified: input.now.slice(0, 10) });
      } else {
        flags.push({ name: m.name, scope: m.scope, score: gate.score, threshold: gate.threshold, failing: gate.failing });
      }
    }

    input.store.recordSkillReverifyTick({ checked: stale.length, passed, flagged: flags.length });
    if (flags.length > 0 && input.chatId) {
      input.store.enqueueNotification({
        target: { kind: "telegram", chat_id: input.chatId },
        intent_type: "progress",
        idempotency_key: `skill_reverify:${input.now.slice(0, 10)}`,
        correlation_id: "skill_reverify_tick",
        payload: { text: formatReverifyReport(flags) }
      });
    }
    return { ran: true };
  } catch {
    return { ran: false }; // a tick must never take the daemon loop down
  }
}
```

**Check before coding:** confirm `verifySkill`'s exact export name/signature in `anchor-verify.ts` (the core-worker call at `verifyAuthored` is the reference) and `computeNextRunAt`'s signature in `run/schedule-spec.ts` (the gateway 系统任务 footer is the reference); adjust imports to match. Confirm `enqueueNotification`'s exact input type on RunStore (the gateway `handleSkills` call is the reference) and align the interface.

- [ ] **Step 5: Wire the daemon** — in `telegram-daemon.ts` directly after the `runIdeaPanelTick` call:

```ts
    // Skill retirement spec (2026-07-29): the weekly suggest-only re-verify advisor — stale
    // skills get a fresh Gate B pass; failures are flagged to Paco, passers re-stamped. Flag-
    // gated OFF (DISARM_FLAGS), weekly latch stamped before any seat call, never throws.
    await runSkillReverifyTick({
      store: options.store,
      skills: new SkillStore({ root: join(options.projectRoot, "skills") }),
      anchorLlm: async (system, question) => {
        const r = await episodicLlm({ question, system });
        return r.ok ? r.answer : undefined;
      },
      env: process.env,
      now,
      chatId: chat ? String(chat.telegram_chat_id) : null
    });
```

(Match `episodicLlm`'s actual call shape defined earlier in this file — same adapter idiom as the lesson tick; add the `SkillStore`/`join`/`runSkillReverifyTick` imports.)

- [ ] **Step 6: DISARM + footer**

`disarm-posture.ts` `DISARM_FLAGS`, after the lesson-consolidate entry:

```ts
  // Skill retirement spec (2026-07-29): the re-verify advisor re-scores Houge's OWN procedures
  // weekly — evolution surface, covered by the STOP switch like lesson consolidation.
  "HOUGE_SKILL_REVERIFY_ENABLED",
```

`gateway.ts` `formatSystemScheduleSection`, after the panel block (imports: `resolveSkillReverifyEnabled`, `resolveSkillReverifyAt` from `../capabilities/skill-reverify.js`):

```ts
  if (resolveSkillReverifyEnabled(env)) {
    const reverifyAt = resolveSkillReverifyAt(env);
    if (reverifyAt !== null) {
      const spec = { kind: "weekly", day: reverifyAt.day, at: reverifyAt.at } as const;
      lines.push(
        `· skill re-verify · ${describeScheduleSpec(spec)} (${city})${nextSuffix(computeNextRunAt(spec, tz, now))}`
      );
    }
  }
```

Extend the existing 系统任务 footer test in `tests/gateway/gateway-telegram.test.ts` with one case: env `{ HOUGE_SKILL_REVERIFY_ENABLED: "1" }` → footer contains `skill re-verify`.

- [ ] **Step 7: Run to pass; typecheck + full suite; commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/capabilities/skill-reverify.ts src/run src/telegram src/config src/gateway tests/
git commit -m "feat(skills): weekly re-verify advisor tick — suggest-only Gate B re-score of stale skills

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, state, deploy, live gate

**Files:**
- Modify: `docs/reference/configuration.md` (three new env rows: `HOUGE_SKILL_REVERIFY_ENABLED` / `_AT` / `_AGE_DAYS`, in the skills section, matching the table format there)
- Modify: `tasks/todo.md` (state header: retirement shipped; live-gate checklist)
- Modify: `README.md` ONLY if it documents `/skills` subcommands today (grep `"/skills"` — extend in place if so)

- [ ] **Step 1: Write the doc rows + todo update** (content per spec §7).

- [ ] **Step 2: Deploy**

```bash
npm run build && launchctl kickstart -k gui/$UID/com.houge.daemon
```

- [ ] **Step 3: Live gate (with Paco, per spec §7)**

1. `/skills retire siem-soar-ueba-weekly-report` → file lands in `skills/_retired/research/` with stamps; `/skills` omits it; `/skills retired` shows it. (This is the real cleanup the feature exists for — the wrong SOC-ops skill stops folding into Friday's SIEM fire.)
2. `/skills restore` + re-retire round-trip.
3. NL: "退役 xx 技能" happy path; an ambiguous name asks.
4. Reverify: `HOUGE_SKILL_REVERIFY_AGE_DAYS=0` temporarily + arm `HOUGE_SKILL_REVERIFY_ENABLED=1`, kickstart, confirm the tick fires (ledger `skill_reverify_tick`), then restore age default. Quiet/flag behavior per what Gate B says about `periodic-news-newsletter`.

- [ ] **Step 4: Final commit + push**

```bash
git add -A && git commit -m "docs(skills): retirement config reference + state update

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" && git push
```
