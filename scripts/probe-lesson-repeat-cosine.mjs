#!/usr/bin/env node
// Probe — LESSON_REPEAT_COSINE (spec 2026-11-07 addendum Rev 2.3.1 A, threshold probe). Embeds pairs written for this probe
// (no personal text, no DB): English and Chinese near-copies (one rule reworded) and distinct rules of the same category,
// with the live embedder (HOUGE_EMBED_URL / HOUGE_EMBED_MODEL through resolveEmbedConfig), and prints each cosine.
//   npm run build && HOUGE_ENV_FILE=/abs/.env node scripts/probe-lesson-repeat-cosine.mjs
// Exit: 0 the current constant separates the groups · 1 it does not (the line names a midpoint) · 3 an embed failed (Ollama down).
const load = async (ps) => Object.assign({}, ...(await Promise.all(ps.map((p) => import(`../dist/${p}`)))));

const NEAR = [
  ["Keep every answer to three sentences or fewer.", "Answer in at most three sentences."],
  ["Give the year first when a question is about a date.", "Whenever a question is about a date, start with the year."],
  ["When you give opening hours, also list the days it is open.", "Include the opening days along with the opening hours."],
  ["Name the source for every number you quote.", "Cite where each figure you quote comes from."],
  ["每个回答不超过三句话。", "回答最多用三句话。"],
  ["回答日期问题时先说年份。", "涉及日期的时候，先给出年份。"],
  ["给出营业时间时也写上营业的日子。", "说营业时间的时候，一并列出哪几天开门。"],
  ["引用数字时注明来源。", "每个数据都要说明出处。"]
];
const DISTINCT = [
  ["Keep every answer to three sentences or fewer.", "Name the source for every number you quote."],
  ["Give the year first when a question is about a date.", "Use metric units, never imperial ones."],
  ["Keep every answer to three sentences or fewer.", "Spell out every abbreviation the first time you use it."], // the live gate's case 4 pair
  ["Answer in at most three sentences.", "Put the most important point in the first sentence."],
  ["每个回答不超过三句话。", "用公制单位，不要用英制。"],
  ["回答日期问题时先说年份。", "引用数字时注明来源。"],
  ["给出营业时间时也写上营业的日子。", "第一次用缩写时要写出全称。"],
  ["回答最多用三句话。", "把最重要的结论放在第一句。"]
];

async function main() {
  const m = await load(["config/load-env.js", "llm/embeddings.js", "improve/repeat.js"]);
  m.loadHougeEnv();
  const cfg = m.resolveEmbedConfig(process.env);
  const cos = async ([a, b]) => { const [x, y] = [await m.embedText(a, cfg), await m.embedText(b, cfg)]; return x && y ? m.cosineSimilarity(x, y) : null; };
  const run = async (pairs) => { const out = []; for (const p of pairs) out.push(await cos(p)); return out; };
  const near = await run(NEAR); const distinct = await run(DISTINCT);
  if ([...near, ...distinct].some((v) => v === null)) { console.log(`embedder ${cfg.model} at ${cfg.url}: an embed failed (Ollama down?)`); return 3; }
  near.forEach((v, i) => console.log(`near     ${v.toFixed(3)}  ${i < 4 ? "en" : "zh"} pair ${i + 1}`));
  distinct.forEach((v, i) => console.log(`distinct ${v.toFixed(3)}  ${i < 4 ? "en" : "zh"} pair ${i + 1}`));
  const minNear = Math.min(...near); const maxDistinct = Math.max(...distinct); const at = m.LESSON_REPEAT_COSINE;
  console.log(`model ${cfg.model}: min near ${minNear.toFixed(3)}, max distinct ${maxDistinct.toFixed(3)}, LESSON_REPEAT_COSINE ${at}`);
  if (minNear >= at && maxDistinct < at) { console.log(`separates: yes (${at} sits between the groups)`); return 0; }
  console.log(minNear > maxDistinct ? `separates: no at ${at}; a constant between the groups: ${((minNear + maxDistinct) / 2).toFixed(2)}` : "separates: no — the groups overlap; no single constant separates them");
  return 1;
}
main().then((code) => process.exit(code), () => { console.error("probe setup error"); process.exit(2); });
