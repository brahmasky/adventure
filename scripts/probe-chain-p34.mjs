// Focused probe for Phase 3.4: exercise the SYNTHESIS step (answerWithChain) directly — the step that
// failed this morning — under controlled chains, to PROVE the fall-through. Prints which provider
// served the answer. Real providers, no web/DB. Synthesis-style prompt (long, prose).
import { loadHougeEnv } from "../dist/config/load-env.js";
import { buildLlmChain, answerWithChain } from "../dist/llm/registry.js";

loadHougeEnv();

const SYSTEM = "You are a concise assistant. Synthesize a short answer from the notes. Answer in English.";
const QUESTION =
  "Notes: Beijing Fri ~32C sunny; Sat ~34C chance of thunderstorms; Sun ~32C scattered showers. " +
  "Question: is this weekend good for cycling? Give a 3-sentence verdict.";

const chain = buildLlmChain(process.env);
console.log("chain:", chain.map((p) => p.name).join(" → "));

const t0 = Date.now();
const result = await answerWithChain(chain, { question: QUESTION, system: SYSTEM });
const ms = Date.now() - t0;

if (result.ok) {
  console.log(`\n✓ served by: ${result.provider} · ${result.model}  (${ms}ms)`);
  console.log("answer:", result.answer.slice(0, 300).replace(/\n+/g, " "));
  process.exitCode = 0;
} else {
  console.log(`\n✗ chain failed (${ms}ms): ${result.error}`);
  process.exitCode = 1;
}
