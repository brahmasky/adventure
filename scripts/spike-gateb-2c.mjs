// THROWAWAY SPIKE (Phase 2c, ADR 0011 §3) — NOT shipped, delete after.
// Make-or-break question: can a cheap, walled-off pi→kimi session act as Gate B and
// SEPARATE good skills from deliberately-broken ones? Measures BOTH verify modes (D1):
//   static-grade  — Gate B independently derives {0,1} anchors, judges the PROCEDURE text.
//   run-and-check — generate a test input, RUN the skill (web-less here), check the OUTPUT.
// Gate B never sees the good/bad label nor the author's frontmatter anchors (D2 independent).
// Go-bar: min(good) > max(bad) with a clean margin, on at least one mode.  Run:
//   node scripts/spike-gateb-2c.mjs
import { loadHougeEnv } from "../dist/config/load-env.js";
import { createLlmAnswerAdapter } from "../dist/capabilities/llm-answer.js";

loadHougeEnv();
const llm = createLlmAnswerAdapter();

async function ask(system, question) {
  const r = await llm({ system, question });
  return r.ok ? r.output.answer : `__ERR__:${r.error}`;
}
function firstJson(text) {
  const s = text.indexOf("{");
  if (s === -1) return null;
  let d = 0, instr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (instr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') instr = false; continue; }
    if (c === '"') instr = true; else if (c === "{") d++; else if (c === "}") { d--; if (d === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch { return null; } } }
  }
  return null;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---- Test set: 5 good (sound, reusable methods) + 5 deliberately broken ----
const SKILLS = [
  { name: "fact-check-viral-claim", kind: "good", when: "a viral factual claim needs verifying",
    body: "1. Quote the exact claim verbatim; note who/when/where. 2. Find the PRIMARY source + authoritative coverage. 3. Compare the viral version to the original for altered/removed context. 4. Cross-check one more authoritative source. 5. Rate true/misleading/false with citations." },
  { name: "cross-check-figures", kind: "good", when: "comparing numbers across multiple sources",
    body: "1. List each figure with its source. 2. Verify each against its source. 3. Check unit consistency and that no part exceeds its whole. 4. Flag where sources disagree rather than taking the rosiest. 5. State the cross-checked figure with caveats." },
  { name: "steelman-then-verdict", kind: "good", when: "evaluating a contested claim or decision",
    body: "1. Build the strongest case FOR. 2. Build the strongest case AGAINST. 3. Weigh the evidence on both sides. 4. Give a calibrated verdict with a confidence level that explicitly names the strongest counter-argument." },
  { name: "decision-matrix", kind: "good", when: "choosing between two or more options",
    body: "1. Derive the criteria that actually matter for the user's situation. 2. Research each option against each criterion. 3. Build an aligned comparison. 4. Recommend the option that best fits a STATED priority, and say which." },
  { name: "premortem-a-plan", kind: "good", when: "stress-testing a plan before committing",
    body: "1. Assume the plan failed 12 months from now. 2. Enumerate concrete failure modes. 3. Rank them by likelihood x impact. 4. Propose a mitigation for the top failure modes." },

  { name: "trust-first-result", kind: "bad", when: "answering a factual question",
    body: "1. Run one web search. 2. Take the FIRST result as the truth — no need to check the source or look further. 3. State it confidently as fact." },
  { name: "vacuous-research", kind: "bad", when: "researching any topic",
    body: "1. Research the topic thoroughly. 2. Think about it carefully. 3. Give a great, high-quality answer." },
  { name: "facts-as-procedure", kind: "bad", when: "asked about current leaders or prices",
    body: "1. The current US president is Joe Biden and the latest iPhone is the iPhone 15. 2. When asked, state these directly without checking. 3. Do not look anything up." },
  { name: "unfalsifiable-quality", kind: "bad", when: "writing any answer",
    body: "1. Be insightful. 2. Ensure the answer is helpful and high quality. 3. Make the user happy." },
  { name: "popularity-wins", kind: "bad", when: "numbers conflict across sources",
    body: "1. When sources give different numbers, pick the number from whichever source has the most followers or traffic. 2. Ignore the other sources. 3. Report that number as correct." }
];

// Gate B v2: independently derive PROCEDURE-level quality criteria (matched to what we
// grade), then judge whether FOLLOWING this procedure ensures each. Levels now match.
const GATE_B = [
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

async function gateB(skill) {
  const sk = `Skill trigger (when): ${skill.when}\nProcedure:\n${skill.body}`;
  let crit = [];
  for (let attempt = 0; attempt < 2 && crit.length === 0; attempt++) {
    const j = firstJson(await ask(GATE_B, sk));
    if (j && Array.isArray(j.criteria)) crit = j.criteria;
  }
  const score = mean(crit.map((c) => (c && c.ok ? 1 : 0)));
  return { nAnchors: crit.length, staticScore: score };
}

const K = 3; // ensemble passes per skill — averaging to tame single-pass noise
const rows = [];
for (const skill of SKILLS) {
  const passes = [];
  for (let k = 0; k < K; k++) passes.push((await gateB(skill)).staticScore);
  const staticScore = mean(passes);
  rows.push({ ...skill, staticScore });
  console.log(`${skill.kind === "good" ? "✅" : "❌"} ${skill.name.padEnd(22)} ${K}-pass avg=${staticScore.toFixed(2)} [${passes.map((p) => p.toFixed(2)).join(", ")}]`);
}

const good = rows.filter((r) => r.kind === "good").map((r) => r.staticScore);
const bad = rows.filter((r) => r.kind === "bad").map((r) => r.staticScore);
const minGood = Math.min(...good), maxBad = Math.max(...bad), margin = minGood - maxBad;
console.log("\n========== SEPARATION (static-grade, procedure-level) ==========");
console.log(`good: min ${minGood.toFixed(2)} mean ${mean(good).toFixed(2)} | bad: max ${maxBad.toFixed(2)} mean ${mean(bad).toFixed(2)}`);
const clean = minGood > maxBad;
console.log(`\nVERDICT: ${clean ? "GO" : margin >= -0.05 ? "BORDERLINE" : "NO-GO"} — margin ${margin.toFixed(2)} (good-min minus bad-max). ${clean ? "Cheap Gate B cleanly separates good from bad." : "No clean threshold; inspect per-skill scores."}`);
