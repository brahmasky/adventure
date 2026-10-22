import type { JevAnswer } from "../../src/jev/jev-client.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { treeQuestions } from "../../src/jev/triage-replay.js";
import type { JevAnchorRow, RunStore } from "../../src/run/run-store.js";
import { treeAnswers } from "./jev-tree-answers.js";

/**
 * An imported anchor of `n` zh turns under the live criteria hashes (A canonical, B permuted), its model seeded trusted;
 * each turn's stored state is `msg <i>`. Tests only (the version check's daemon wiring).
 */
export function seedJevAnchor(store: RunStore, model: string, n = 100, answers: (i: number) => Record<string, JevAnswer> = () => treeAnswers({ category: "research" })): void {
  const hash = (run: "A" | "B", id: string): string => criteriaHash(treeQuestions(run === "B").find((q) => q.id === id)!);
  const rows: JevAnchorRow[] = [];
  const states = Array.from({ length: n }, (_, i) => ({ turn_id: `t${i}`, lang: "zh", state_json: JSON.stringify({ latest_message: `msg ${i}`, last_houge_turn: null, quoted_turn: null }), state_hash: `h${i}` }));
  for (let i = 0; i < n; i += 1) for (const run of ["A", "B"] as const) {
    for (const [question_id, a] of Object.entries(answers(i))) rows.push({ turn_id: `t${i}`, lang: "zh", question_id, criteria_hash: hash(run, question_id), run, answer_json: JSON.stringify(a), model });
  }
  store.importAnchor({ rows, states, labels: [], meta: { baseline: "{}" }, trustedModel: model, now: "2026-10-22T00:00:00.000Z" });
}
