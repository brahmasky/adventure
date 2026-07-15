// LIVE GATE for Phase M (conversational-episodic memory, B1–B4).
// Drives the REAL stack — Gateway→CoreWorker with the real planner chain, the real LLM
// chain for the distill/reconcile calls, and REAL local Ollama embeddings — over an
// in-memory RunStore (like scripts/live-gate-b5b6.mjs). Scenarios:
//   S1 "remember":  seed 2 user turns stating durable facts in Chinese (6h ago, so they
//      fall OUT of the thread window) → run the distill pass DIRECTLY → expect ≥1 stored
//      atomic, pronoun-resolved fact; report embedding presence (null = Ollama down).
//   S2 "recall":    a NEW turn asks a related question → print the retrieved episodic
//      section + the final answer → PASS = the answer uses a stored fact (mentions the
//      seeded life details) without re-asking. Memory, not thread: the seeds are outside
//      the chat-context window, so only B3 retrieval can carry them.
//   S3 "supersede": the user states a correction (moved cities) → distill → expect the
//      old location fact superseded (chain intact) and retrieval returning only the new.
// Run: node scripts/live-gate-episodic.mjs [s1|s2|s3]   (default: all; s2/s3 auto-seed)
import { loadHougeEnv } from "../dist/config/load-env.js";
import { RunStore } from "../dist/run/run-store.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";
import { createLlmAnswerAdapter } from "../dist/capabilities/llm-answer.js";
import { runEpisodicDistillPass } from "../dist/capabilities/episodic-extract.js";
import { renderEpisodicFactsBlock, retrieveEpisodicFacts } from "../dist/run/episodic-retrieval.js";
import { embedText, resolveEmbedConfig } from "../dist/llm/embeddings.js";

loadHougeEnv();
// Force the feature (and the loop it rides) ON in-process only — the daemon's env is untouched.
process.env.HOUGE_EPISODIC_ENABLED = "1";
process.env.HOUGE_INNER_LOOP_ENABLED = "1";

const CHAT = "gate-episodic";
const store = RunStore.openInMemory();
const gateway = new Gateway(store, undefined, process.cwd());
const worker = new CoreWorker(store, process.cwd());
let seq = 0;

const answerAdapter = createLlmAnswerAdapter({});
const llm = async ({ question, system }) => {
  const r = await answerAdapter({ question, system });
  return r.ok && typeof r.output.answer === "string" ? { ok: true, answer: r.output.answer } : { ok: false };
};
const embed = (text) => embedText(text, resolveEmbedConfig(process.env));

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function printFacts(facts) {
  for (const f of facts) {
    const dims = f.embedding ? `${Math.floor(f.embedding.byteLength / 4)}-dim` : "no embedding";
    console.log(`  #${f.id} [${f.status}] salience=${f.salience} reuse=${f.reuse_value} (${dims})\n     ${f.fact}`);
  }
}

let seeded = false;
async function ensureSeeded(verbose) {
  if (seeded) return { distilled: -1 };
  seeded = true;
  // 6h old: OUTSIDE the chat-context session window — S2 can only recall via memory.
  const turns = [
    ["user", "我住在悉尼，周末一般会去海边骑车放松。", 6],
    ["assistant", "悉尼周末骑车很棒！海边的路线风景特别好。", 5.9],
    ["user", "对了，我太太叫小芸，她周末喜欢跟我一起去。", 5.8],
    ["assistant", "记住啦，祝你们周末骑行愉快！", 5.7]
  ];
  for (const [role, text, h] of turns) {
    store.recordChatTurn({ chat_id: CHAT, run_id: `seed-${h}`, role, text, created_at: hoursAgo(h) });
  }
  const result = await runEpisodicDistillPass({
    store,
    llm,
    embed,
    chatId: CHAT,
    userName: "Paco",
    now: new Date().toISOString()
  });
  if (verbose) console.log(`distill pass: ${JSON.stringify(result)}`);
  return result;
}

async function sendTurn(text) {
  seq += 1;
  const intake = gateway.intake(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: text,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: CHAT },
      idempotency_key: `gate-episodic:${seq}`,
      source_reference: "live-gate-episodic",
      metadata: { telegram_update_id: seq, telegram_message_id: seq }
    })
  );
  if (!intake.ok) throw new Error(JSON.stringify(intake.error));
  const result = await worker.executeRun(intake.run_id, "gate");
  let answer = "";
  for (;;) {
    const n = store.claimNextNotification("gate", 60);
    if (!n) break;
    if (n.intent_type === "final_report") answer = n.payload.text;
  }
  return { state: result.status, run_id: intake.run_id, answer };
}

function verdict(name, pass, detail) {
  console.log(`${pass ? "✅ PASS" : "❌ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

async function s1() {
  console.log("\n═══ S1 remember: seed Chinese turns → direct distill pass ═══");
  await ensureSeeded(true);
  const facts = store.getActiveEpisodicFacts(CHAT);
  printFacts(facts);
  const embedded = facts.filter((f) => f.embedding !== null).length;
  verdict("S1 ≥1 atomic fact stored", facts.length >= 1, `${facts.length} active facts`);
  verdict(
    "S1 embeddings present (needs local Ollama up)",
    embedded === facts.length && facts.length > 0,
    `${embedded}/${facts.length} embedded — null means Ollama was down (degradation, not a distill bug)`
  );
  const pronouns = facts.filter((f) => /^(他|她|我)/.test(f.fact));
  verdict("S1 pronoun-resolved (no fact starts with 他/她/我)", pronouns.length === 0, pronouns.map((f) => f.fact).join(" | "));
}

async function s2() {
  console.log("\n═══ S2 recall: new turn asks a related question (seeds are OUT of the thread window) ═══");
  await ensureSeeded(false);
  const query = "明天周末我该干嘛？给点建议。";
  const queryEmbedding = await embed(query);
  const retrieved = retrieveEpisodicFacts({
    store,
    chat_id: CHAT,
    queryText: query,
    queryEmbedding,
    now: new Date().toISOString()
  });
  console.log("--- retrieved episodic section (what the composer folds in) ---");
  console.log(renderEpisodicFactsBlock(retrieved) || "(empty)");
  const r = await sendTurn(query);
  console.log(`state=${r.state}`);
  console.log(`--- answer (${r.answer.length} chars) ---\n${r.answer}\n`);
  verdict("S2 retrieval surfaced ≥1 fact", retrieved.length >= 1);
  verdict(
    "S2 answer uses a stored fact without re-asking (骑车/悉尼/海边 grounded the suggestion)",
    /骑车|骑行|悉尼|海边/.test(r.answer),
    "judge the transcript above too — the bar is unprompted use, not keyword parroting"
  );
}

async function s3() {
  console.log("\n═══ S3 supersede: correction turn → distill → old location fact retired ═══");
  await ensureSeeded(false);
  store.recordChatTurn({
    chat_id: CHAT,
    run_id: "seed-correction",
    role: "user",
    text: "跟你说一下，我搬家了，现在住在墨尔本，不住悉尼了。",
    created_at: new Date().toISOString()
  });
  const pass = await runEpisodicDistillPass({
    store,
    llm,
    embed,
    chatId: CHAT,
    userName: "Paco",
    now: new Date().toISOString()
  });
  console.log(`distill pass: ${JSON.stringify(pass)}`);
  const active = store.getActiveEpisodicFacts(CHAT);
  console.log("--- active facts after correction ---");
  printFacts(active);

  const melbourneActive = active.filter((f) => f.fact.includes("墨尔本"));
  const sydneyLivingActive = active.filter((f) => f.fact.includes("悉尼") && /住|居住|lives/.test(f.fact));
  verdict("S3 new location fact (墨尔本) active", melbourneActive.length >= 1);
  verdict("S3 no active 住在悉尼 fact remains", sydneyLivingActive.length === 0, sydneyLivingActive.map((f) => f.fact).join(" | "));

  const superseded = melbourneActive
    .map((f) => f.supersedes)
    .filter((id) => id !== null)
    .map((id) => store.getEpisodicFact(id));
  if (superseded.length > 0) {
    console.log("--- supersede chain ---");
    printFacts(superseded);
  }
  verdict(
    "S3 supersede chain links new → old (superseded row keeps valid_until)",
    superseded.some((f) => f && f.status === "superseded" && f.valid_until !== null),
    superseded.length === 0 ? "reconcile verdict was ADD, not SUPERSEDE — inspect facts above" : undefined
  );

  const query = "我现在住在哪个城市？";
  const retrieved = retrieveEpisodicFacts({
    store,
    chat_id: CHAT,
    queryText: query,
    queryEmbedding: await embed(query),
    now: new Date().toISOString()
  });
  console.log("--- retrieval for 「我现在住在哪个城市？」 ---");
  printFacts(retrieved);
  verdict(
    "S3 retrieval returns the NEW location only",
    retrieved.some((f) => f.fact.includes("墨尔本")) && !retrieved.some((f) => f.fact.includes("悉尼") && /住|居住/.test(f.fact))
  );
}

const SCENARIOS = { s1, s2, s3 };
const pick = process.argv[2] ? [process.argv[2]] : ["s1", "s2", "s3"];
try {
  for (const key of pick) {
    const run = SCENARIOS[key];
    if (!run) throw new Error(`unknown scenario ${key}`);
    await run();
  }
} finally {
  store.close();
}
