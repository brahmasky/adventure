/**
 * Gate B — the OPENSKILL anchor verifier (Phase 2c, ADR 0011 §1/§2). A SEPARATE, walled-off
 * model session independently derives PROCEDURE-LEVEL quality criteria from its OWN world
 * knowledge of how the task should be done, then judges whether FOLLOWING the skill's
 * procedure satisfies each criterion. Validated by `scripts/spike-gateb-2c.mjs`: this exact
 * static-grade, independent-criteria, 3-pass-ensemble approach cleanly separated good skills
 * (0.28–0.89) from deliberately-broken ones (≤0.06).
 *
 * Key invariants:
 *  - INDEPENDENCE (D2): Gate B is fed ONLY the `when` + procedure `body` — NEVER the author's
 *    own frontmatter `anchors:` (an author must not grade its own homework).
 *  - 3-PASS ENSEMBLE: the score is the mean of K independent passes (default 3). `passed` is
 *    `score >= threshold` (default 0.15 — the spike's good/bad gap; a SEPARATION bar, not a
 *    high-quality bar). Good skills score modestly; the gate works on the good/bad margin.
 *  - DEFENSIVE: a parse failure / LLM error must NEVER throw. A pass that won't parse (after
 *    one retry) contributes nothing and is skipped; if EVERY pass fails, the result is marked
 *    `unscored` so the caller falls back to advisory-write rather than blocking on an error.
 *
 * Pure of I/O except the injected `llm` (so tests mock it). The procedure-level prompt is
 * ported verbatim-in-spirit from the spike's `GATE_B`.
 */

const DEFAULT_PASSES = 3;
const DEFAULT_THRESHOLD = 0.15;

/** The independent criterion a Gate B pass emits ({0,1} judgement of the procedure). */
export interface AnchorCriterion {
  text: string;
  ok: 0 | 1;
}

export interface VerifyResult {
  /** Mean of the per-pass scores (each pass score = mean of its criteria oks). */
  score: number;
  /** `true` when `score >= threshold` (only meaningful when not `unscored`). */
  passed: boolean;
  /** The last successful pass's criteria (for the report). */
  criteria: AnchorCriterion[];
  /** Failing criteria (ok=0), DEDUPED across passes — fed back into guided-refine. */
  failing: string[];
  /** How many passes parsed successfully (out of `passes`). */
  scoredPasses: number;
  /** True when NO pass parsed — an error state, not a real low score; caller falls back to advisory. */
  unscored: boolean;
  threshold: number;
}

export interface VerifyOptions {
  /** K independent passes to average (default 3). */
  passes?: number;
  /** Pass threshold on the mean score (default 0.15). */
  threshold?: number;
}

/** The injected LLM call (walled-off pi→kimi): `(system, question) => answer | undefined` on failure. */
export type AnchorLlm = (system: string, question: string) => Promise<string | undefined>;

/**
 * Gate B system prompt — independent, procedure-level quality criteria (ported from the
 * validated spike). The auditor derives 4-6 falsifiable criteria from its OWN knowledge of
 * the task class, then scores whether following the procedure ensures each. STRICT JSON.
 */
export const GATE_B_DISCIPLINE = [
  "You are an INDEPENDENT skill auditor, walled off from the author — do NOT trust the skill's own claims.",
  "You are given a SKILL: its trigger ('when') and numbered procedure.",
  "Step 1 — From your OWN knowledge of how this CLASS of task should be done well (documented standards,",
  "methodological best practice, world-facts), independently derive 4-6 falsifiable QUALITY CRITERIA that",
  "separate a SOUND procedure for this task from an unsound one. Each is a property a good PROCEDURE must have",
  "(e.g. 'requires checking the claim against a primary or independent source', 'does not rely on a single",
  "unverified source', 'yields a falsifiable, evidence-tied conclusion', 'does not hard-code perishable facts').",
  "Step 2 — For EACH criterion decide: does THIS procedure, as written, satisfy it? 1 = following the procedure",
  "clearly ensures this property; 0 = it does not, is vague/circular, or violates it. Be STRICT and concrete.",
  'Output STRICT JSON ONLY (no prose, no code fences): {"criteria":[{"text":"...","ok":1}]}.'
].join(" ");

/** Resolve the Gate B pass count (`HOUGE_GATE_B_PASSES`, default 3). */
export function resolveGateBPasses(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_GATE_B_PASSES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PASSES;
}

/** Resolve the Gate B pass threshold (`HOUGE_GATE_B_THRESHOLD`, default 0.15). */
export function resolveGateBThreshold(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_GATE_B_THRESHOLD);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
}

/**
 * Whether Gate B is enabled (`HOUGE_GATE_B_ENABLED`). Default ON; only an explicit
 * `0|false|no|off` disables it. When off, the caller treats every skill as advisory.
 */
export function resolveGateBEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_GATE_B_ENABLED?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/** Build the Gate B *question* (DATA channel): ONLY the `when` + procedure — NEVER the anchors (D2). */
export function buildGateBQuestion(skill: { when: string; body: string }): string {
  return `Skill trigger (when): ${skill.when}\nProcedure:\n${skill.body}`;
}

/**
 * Verify a skill via the 3-pass ensemble. Runs `opts.passes` independent Gate B calls; each
 * pass tolerantly parses its criteria (one retry on parse failure) and scores mean(ok). The
 * final score is the mean of the scored passes; `passed = score >= threshold`. Never throws.
 */
export async function verifySkill(
  skill: { when: string; body: string },
  opts: VerifyOptions,
  llm: AnchorLlm
): Promise<VerifyResult> {
  const passes = opts.passes ?? DEFAULT_PASSES;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const question = buildGateBQuestion(skill);

  const passScores: number[] = [];
  let lastCriteria: AnchorCriterion[] = [];
  const failingSet = new Set<string>();

  for (let p = 0; p < passes; p += 1) {
    const criteria = await runOnePass(question, llm);
    if (criteria === undefined) continue; // unparseable after retry → contributes nothing
    passScores.push(mean(criteria.map((c) => (c.ok ? 1 : 0))));
    lastCriteria = criteria;
    for (const c of criteria) if (!c.ok) failingSet.add(c.text);
  }

  const unscored = passScores.length === 0;
  const score = unscored ? 0 : mean(passScores);
  return {
    score,
    passed: !unscored && score >= threshold,
    criteria: lastCriteria,
    failing: [...failingSet],
    scoredPasses: passScores.length,
    unscored,
    threshold
  };
}

/** One Gate B pass: call the llm (one retry on a parse miss), tolerant-parse the criteria. */
async function runOnePass(question: string, llm: AnchorLlm): Promise<AnchorCriterion[] | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string | undefined;
    try {
      raw = await llm(GATE_B_DISCIPLINE, question);
    } catch {
      raw = undefined; // an LLM error is tolerated, never thrown — just retry/skip.
    }
    if (raw === undefined) continue;
    const criteria = parseCriteria(raw);
    if (criteria) return criteria;
  }
  return undefined;
}

/** Tolerant parse of a Gate B reply → criteria[], or undefined if no usable {criteria:[...]}. */
function parseCriteria(text: string): AnchorCriterion[] | undefined {
  const json = firstJson(text);
  if (!json || typeof json !== "object") return undefined;
  const arr = (json as { criteria?: unknown }).criteria;
  if (!Array.isArray(arr)) return undefined;
  const criteria: AnchorCriterion[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as { text?: unknown; ok?: unknown };
    const t = typeof rec.text === "string" ? rec.text.trim() : "";
    if (t.length === 0) continue;
    criteria.push({ text: t, ok: rec.ok ? 1 : 0 });
  }
  return criteria.length > 0 ? criteria : undefined;
}

/** Extract the first balanced {...} object (tolerates surrounding prose/fences). */
function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function mean(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}
