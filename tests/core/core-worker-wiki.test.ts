import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVOLUTION_NOTICE_HEADER } from "../../src/core/core-worker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import {
  buildWikiContradictionNotice,
  buildWikiNeedSourcesError,
  buildWikiSavedDigest,
  WIKI_SYNTH_DISCIPLINE,
  WIKI_VERIFY_DISCIPLINE
} from "../../src/capabilities/wiki.js";
import { WIKI_CONTRADICTIONS_SECTION_HEADER } from "../../src/report/wiki-writer.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import { READER_DISCIPLINE } from "../../src/prompt/composer.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, drainOutbox, ompWorker } from "../helpers/omp-worker.js";

// wiki_build / wiki_refine on the omp path (Phase W, ADR 0020): the planner calls the tool over the
// bridge; the synthesis material is the turn's RECORDED post-wall reader digests. Ported from the
// inner-loop suite (Task 14); the happy path and the auto-route refine live in core-worker-omp-tools.test.ts.
pinOmpEnv();
pinEnabledFlags();
const PINNED = ["HOUGE_WIKI_MIN_SOURCES", "HOUGE_WIKI_VERIFY_PASSES", "HOUGE_WIKI_MAX_PAGES", "HOUGE_EMBED_URL", "HOUGE_EMBED_MODEL", "HOUGE_TOMBSTONE_PATH"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => {
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.HOUGE_WIKI_ENABLED = "1";
  tmp = shortTmp("hwk-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  store = RunStore.openInMemory();
  resetEvolutionLaneForTests();
});
afterEach(async () => {
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
  store.close();
  tmp.cleanup();
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

type Llm = (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
const SLUG = "asml-q2-2026-earnings";
const SYNTH_PAGE = '{"title":"ASML Q2 2026","summary":"Beat expectations.","key_facts":["EPS €4.9"],"body_md":"## Results\\nGood quarter."}';
const EXTRACTION = JSON.stringify({ summary: "ASML beat estimates", facts: ["EPS up"], time_claims: [], answer_to_objective: null, contains_instructions: false });
const project = () => join(tmp.dir, "project");
const answer = (content: string) => (JSON.parse(content) as { answer: string }).answer;
const events = (run_id: string, type: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === type);

/** The reader answers the quarantine; synth returns `synth`; verify shifts `verify` (the last repeats). */
function wikiLlm(synth: string, verify: string[] = ['{"supported":[],"unsupported":[],"contradictions":[],"confidence":0.9}']): Llm {
  let v = 0;
  return async (input) => {
    const system = typeof input.system === "string" ? input.system : "";
    let out = `ANSWER: ${String(input.question)}`;
    if (system.includes(READER_DISCIPLINE)) out = EXTRACTION;
    else if (system === WIKI_SYNTH_DISCIPLINE) out = synth;
    else if (system === WIKI_VERIFY_DISCIPLINE) out = verify[Math.min(v++, verify.length - 1)] ?? "";
    return { ok: true, output: { question: input.question, answer: out, model: "fake", provider: "fake" } };
  };
}

/** web_search stub: each call returns the next scripted batch of urls. */
function web(batches: string[][]): Llm {
  let i = 0;
  return async () => ({ ok: true, output: { provider: "fake", results: (batches[Math.min(i++, batches.length - 1)] ?? []).map((url, n) => ({ title: `r${n}`, url, snippet: "s" })) } });
}

function turn(message: string, llm: Llm, batches: string[][], root = project()) {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: message, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `t:${message}`, source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error("intake failed");
  const worker = ompWorker(store, tmp.dir, { llm, web: web(batches), project: root });
  return { run_id: intake.run_id, worker, ...bridgeTurn(store, worker, intake.run_id, tmp.dir) };
}

/** Two recorded reads, then wiki_build on the ASML topic. */
async function buildAfterTwoReads(t: ReturnType<typeof turn>) {
  await t.call("web_search", { query: "ASML Q2 2026 earnings" });
  await t.call("web_search", { query: "ASML analyst views" });
  return t.call("wiki_build", { topic: "ASML Q2 2026 earnings" });
}

describe("wiki_build over the bridge (Phase W, ADR 0020)", () => {
  it("C3 floor: fewer distinct sources than the minimum refuses with the steering digest — nothing stored", async () => {
    // replaces: wiki_build on the loop › "C3 floor: fewer distinct sources than the minimum refuses with the steering digest — nothing stored"
    // One page under two query/fragment variants of the SAME URL: ONE source.
    const t = turn("只查了一个来源", wikiLlm(SYNTH_PAGE), [["https://a.com/earnings?x=1", "https://a.com/earnings#y"]]);
    await t.call("web_search", { query: "one source" });
    const r = await t.call("wiki_build", { topic: "ASML" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(buildWikiNeedSourcesError(2));
    expect(store.getActiveWikiPages()).toEqual([]);
    expect(events(t.run_id, "wiki_page_saved")).toEqual([]);
    expect(existsSync(join(project(), "memory", "wiki"))).toBe(false);
  });

  it("disarmed (default OFF): a scripted call is refused without executing", async () => {
    // replaces: wiki_build on the loop › "disarmed (default OFF): unlisted in the manifest and a scripted call is denied without executing"
    delete process.env.HOUGE_WIKI_ENABLED;
    const t = turn("帮我调研 ASML", wikiLlm(SYNTH_PAGE), []);
    expect((await t.call("wiki_build", { topic: "ASML" })).isError).toBe(true);
    expect(store.getActiveWikiPages()).toEqual([]);
  });

  it("verify-fail (all passes garbage): the page saves UNVERIFIED — confidence null, never blocked", async () => {
    // replaces: wiki_build on the loop › "verify-fail (all passes garbage): the page saves UNVERIFIED — confidence null, never blocked"
    const t = turn("来源都在但验证挂了", wikiLlm(SYNTH_PAGE, ["not json at all"]), [["https://a.com/x"], ["https://b.com/y"]]);
    const r = await buildAfterTwoReads(t);
    const page = store.getActiveWikiPages()[0]!;
    expect([page.confidence, page.verified_passes, page.last_verified]).toEqual([null, 0, null]);
    expect(answer(r.content)).toBe(buildWikiSavedDigest("add", SLUG, 2, null, 0));
    expect(events(t.run_id, "wiki_page_saved")[0]!.payload.confidence).toBeNull();
  });

  it("contradiction: stored verbatim, rendered into the .md, and surfaced CODE-OWNED in the final reply", async () => {
    // replaces: wiki_build on the loop › "contradiction: stored verbatim, rendered into the .md, and surfaced CODE-OWNED in the reply"
    const contradiction = { claim: "target price", a: "source 1: $1100", b: "source 2: $950" };
    const t = turn("分析师目标价有分歧", wikiLlm(SYNTH_PAGE, [JSON.stringify({ supported: [], unsupported: [], contradictions: [contradiction], confidence: 0.6 })]), [["https://a.com/x"], ["https://b.com/y"]]);
    const r = await buildAfterTwoReads(t);
    expect(JSON.parse(store.getActiveWikiPages()[0]!.contradictions)).toEqual([contradiction]);
    expect(answer(r.content)).toBe(buildWikiSavedDigest("add", SLUG, 2, 0.6, 1));
    expect(events(t.run_id, "wiki_page_saved")[0]!.payload.contradiction_count).toBe(1);
    const md = readFileSync(join(project(), "memory", "wiki", `${SLUG}.md`), "utf8");
    expect(md).toContain(WIKI_CONTRADICTIONS_SECTION_HEADER);
    expect(md).toContain("source 1: $1100");
    // The planner's final text alone can never hide the notice: the outcome sink appends it.
    const sink = (t.worker as unknown as { ompOutcomeSink(chat: string): TurnOutcomeSink }).ompOutcomeSink("555");
    sink.complete({ run_id: t.run_id, worker_id: t.turn.worker_id, text: "调研完成。", attachments: [], duration_ms: 1, tool_calls: 3 });
    const reply = [...drainOutbox(store).values()].map((p) => String(p.text)).find((x) => x.startsWith("调研完成。"));
    expect(reply).toContain(EVOLUTION_NOTICE_HEADER);
    expect(reply).toContain(buildWikiContradictionNotice(SLUG, [contradiction]));
  });

  it('refine with {"unchanged":true}: touches last_verified only — no new row, verb unchanged', async () => {
    // replaces: wiki_build on the loop › 'refine with {"unchanged":true}: touches last_verified only — no new row, verb unchanged'
    const priorId = store.addWikiPage({ topic_slug: SLUG, title: "ASML Q2 2026", summary: "Summary.", last_verified: "2026-07-10T00:00:00.000Z", created_at: "2026-07-10T00:00:00.000Z" });
    const r = await buildAfterTwoReads(turn("复查 ASML", wikiLlm('{"unchanged":true}'), [["https://a.com/x"], ["https://b.com/y"]]));
    const active = store.getActiveWikiPages();
    expect(active.map((p) => p.id)).toEqual([priorId]);
    expect(Date.parse(active[0]!.last_verified!)).toBeGreaterThan(Date.parse("2026-07-10T00:00:00.000Z"));
    expect(answer(r.content)).toBe(buildWikiSavedDigest("unchanged", SLUG, 2, null, 0));
  });

  it("render write failure is NON-FATAL: the sqlite save + digest survive a broken memory/wiki path", async () => {
    // replaces: wiki_build on the loop › "render write failure is NON-FATAL: the sqlite save + digest survive a broken memory/wiki path"
    mkdirSync(join(project(), "memory"), { recursive: true });
    writeFileSync(join(project(), "memory", "wiki"), "not a directory"); // a FILE where the wiki DIR must go
    const t = turn("渲染坏了也要保存", wikiLlm(SYNTH_PAGE), [["https://a.com/x"], ["https://b.com/y"]]);
    const r = await buildAfterTwoReads(t);
    expect(r.isError).toBe(false);
    expect(store.getActiveWikiPages()).toHaveLength(1);
    expect(answer(r.content)).toBe(buildWikiSavedDigest("add", SLUG, 2, 0.9, 0));
    expect(events(t.run_id, "wiki_page_saved")).toHaveLength(1);
  });
});
