#!/usr/bin/env node
// Live probe — memory_kind's own Jev request (spec 2026-10-15 Rev 3 §3; plan Task 11 Step 8). Twenty or more real requests on
// realistic states rebuilt from a VACUUM copy of the live DB (Paco's last telegram turns with their threads). PASS: every
// call answered with a valid memory_kind choice, and p95 latency < 1000 ms. Prints ids, options, p and ms — never text.
//   npm run build && HOUGE_ENV_FILE=/abs/.env node scripts/probe-memory-kind.mjs [--db <path>] [--n 20]
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

const load = async (ps) => Object.assign({}, ...(await Promise.all(ps.map((p) => import(`../dist/${p}`)))));

async function main() {
  const args = { db: null, n: 20 };
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--db") args.db = process.argv[++i]; else if (process.argv[i] === "--n") args.n = Number(process.argv[++i]); else throw new Error(`unknown argument ${process.argv[i]}`);
  }
  const m = await load(["config/load-env.js", "run/run-store.js", "jev/jev-client.js", "jev/memory-kind-ask.js", "jev/questions/tree.js"]);
  m.loadHougeEnv();
  const live = resolve(args.db ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? ".env")), "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live}`);
  const root = mkdtempSync("/tmp/hg-mkp-"); const copy = join(root, "copy.sqlite");
  const src = new DatabaseSync(live, { readOnly: true }); src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`); src.close();
  const store = m.RunStore.open(copy);
  try {
    const db = new DatabaseSync(copy, { readOnly: true });
    const turns = db.prepare(`SELECT c.turn_id, c.chat_id, c.run_id, c.text, c.created_at FROM chat_turns c JOIN runs r ON r.run_id = c.run_id
      WHERE c.role = 'user' AND r.source = 'telegram' ORDER BY c.created_at DESC LIMIT ?`).all(args.n);
    db.close();
    if (turns.length < 20) throw new Error(`only ${turns.length} telegram user turns in the copy; need 20`);
    const client = m.createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, audit: store.llmAuditSink({ correlation_id: "probe:memory_kind", role: "memory_kind" }),
      meteredBreached: () => false, retries: 0, timeoutMs: 5_000 });
    const ms = []; let bad = 0;
    for (const t of turns) {
      const recent = store.getChatTurnsBefore(t.chat_id, 6, "1970-01-01T00:00:00.000Z", t.created_at, t.run_id);
      const t0 = Date.now();
      const r = await m.askMemoryKind({ run_id: t.run_id, lang: /[一-鿿]/.test(t.text) ? "zh" : "en", client, store,
        state: { userText: t.text, recentTurns: recent, turnChars: 400, modality: "text", lastHougeTurn: m.lastHougeTurnOf(recent, Date.parse(t.created_at)), quotedTurn: null } });
      ms.push(Date.now() - t0);
      const a = r.answer;
      const top = a?.type === "choice" ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0] : undefined;
      const valid = top !== undefined && m.MEMORY_KIND_OPTIONS.includes(top[0]);
      if (!valid) bad += 1;
      console.log(`${t.turn_id.slice(0, 13)} ${valid ? `${top[0]} p=${top[1].toFixed(2)}` : `INVALID ${r.failed ?? "shape"}`} ${ms.at(-1)} ms`);
    }
    const p95 = [...ms].sort((x, y) => x - y)[Math.ceil(0.95 * ms.length) - 1];
    console.log(`\n${turns.length} requests, ${bad} invalid, p95 ${p95} ms`);
    const pass = bad === 0 && p95 < 1000;
    console.log(pass ? "PROBE: PASS" : "PROBE: FAIL");
    return pass ? 0 : 1;
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

main().then((c) => process.exit(c), (e) => { console.error(`probe setup error: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); });
