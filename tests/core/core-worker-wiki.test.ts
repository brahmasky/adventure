import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreWorker, defaultSelfWriteDeps, EVOLUTION_NOTICE_HEADER } from "../../src/core/core-worker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { LOOP_DISCIPLINE } from "../../src/prompt/composer.js";
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
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-wiki-turn-"));
  dirs.push(dir);
  return dir;
}

// HERMETICITY (PINNED_ENV cardinal rule): the daemon env leaks into the self-write test
// gate, so every flag these turns depend on is pinned (delete = code default) and
// restored after. The wiki flags + the embed sidecar env are pinned so an armed daemon
// .env can never flip a default assertion or point a test at a real Ollama.
const PINNED_ENV = [
  "HOUGE_INNER_LOOP_ENABLED",
  "HOUGE_MAX_CONSECUTIVE_CLARIFY",
  "HOUGE_SELFWRITE_ENABLED",
  "HOUGE_CODEX_ENABLED",
  "HOUGE_SKILLS_ENABLED",
  "HOUGE_HTTPFETCH_ENABLED",
  "HOUGE_TIME_TOOL_ENABLED",
  "HOUGE_SCHEDULER_ENABLED",
  "HOUGE_ASK_SYSTEM_PROMPT",
  "HOUGE_LESSON_CAP_PER_SCOPE",
  "HOUGE_SECRETS_FIREWALL_ENABLED",
  "HOUGE_DUAL_LLM_ENABLED",
  "HOUGE_LLM_READER_PROVIDERS",
  "HOUGE_EPISODIC_ENABLED",
  "HOUGE_WIKI_ENABLED",
  "HOUGE_WIKI_MIN_SOURCES",
  "HOUGE_WIKI_VERIFY_PASSES",
  "HOUGE_WIKI_MAX_PAGES",
  "HOUGE_EMBED_URL",
  "HOUGE_EMBED_MODEL"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOUGE_INNER_LOOP_ENABLED = "1";
  process.env.HOUGE_WIKI_ENABLED = "1";
  resetEvolutionLaneForTests();
});
afterEach(async () => {
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
  for (const key of PINNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function turnRun(store: RunStore, message: string, key = `t:${message}`): string {
  const intake = new Gateway(store).intake(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: message,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: key,
      source_reference: "telegram:update:1:message:1"
    })
  );
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

/**
 * Loop LLM stub: intent classifier → answer; LOOP_DISCIPLINE composes shift the script;
 * WIKI_SYNTH_DISCIPLINE returns `synth`; WIKI_VERIFY_DISCIPLINE shifts `verify` (last
 * entry repeats, covering retries); everything else echoes.
 */
function wikiLoopLlm(
  composeScript: string[],
  synth: string,
  verify: string[] = ['{"supported":[],"unsupported":[],"contradictions":[],"confidence":0.9}'],
  calls: Array<Record<string, unknown>> = []
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  let composeIndex = 0;
  let verifyIndex = 0;
  return async (input) => {
    calls.push(input);
    const system = typeof input.system === "string" ? input.system : "";
    let answer = `ANSWER: ${input.question}`;
    if (system.includes(INTENT_DISCIPLINE)) answer = '{"intent":"answer"}';
    else if (system.includes(LOOP_DISCIPLINE)) {
      answer = composeScript[Math.min(composeIndex, composeScript.length - 1)] ?? "";
      composeIndex += 1;
    } else if (system === WIKI_SYNTH_DISCIPLINE) answer = synth;
    else if (system === WIKI_VERIFY_DISCIPLINE) {
      answer = verify[Math.min(verifyIndex, verify.length - 1)] ?? "";
      verifyIndex += 1;
    }
    return { ok: true, output: { question: input.question, answer, model: "fake", provider: "fake" } };
  };
}

/** web_search stub: each call returns the next scripted result batch (url + snippet). */
function fakeWebSearch(batches: Array<Array<{ url: string; snippet: string }>>) {
  let i = 0;
  return async (_input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const results = batches[Math.min(i, batches.length - 1)] ?? [];
    i += 1;
    return {
      ok: true,
      output: {
        provider: "fake",
        results: results.map((r, n) => ({ title: `result ${n}`, url: r.url, snippet: r.snippet }))
      }
    };
  };
}

function makeWorker(
  store: RunStore,
  root: string,
  llm: (input: Record<string, unknown>) => Promise<ToolAdapterResult>,
  webSearch: (input: Record<string, unknown>) => Promise<ToolAdapterResult>
): CoreWorker {
  return new CoreWorker(
    store,
    root,
    llm,
    webSearch,
    undefined,
    defaultSelfWriteDeps(),
    undefined,
    undefined,
    undefined,
    async () => null // embed stub: Ollama "down" — every leg must degrade gracefully
  );
}

function loopEvents(store: RunStore, run_id: string, type: string) {
  return store.getLedgerEvents(run_id).filter((e) => e.event_type === type);
}

const TWO_SEARCHES_THEN_BUILD = [
  '{"action":"web_search","input":{"query":"ASML Q2 2026 earnings"},"why":"research"}',
  '{"action":"web_search","input":{"query":"ASML analyst views"},"why":"more sources"}',
  '{"action":"wiki_build","input":{"topic":"ASML Q2 2026 earnings","body_md":"EVIL-INJECTED-BODY","content":"EVIL-INJECTED-CONTENT"},"why":"save the research"}',
  '{"action":"final","answer":"调研完成。"}'
];
const SYNTH_PAGE =
  '{"title":"ASML Q2 2026","summary":"Beat expectations.","key_facts":["EPS €4.9"],"body_md":"## Results\\nGood quarter."}';
const SLUG = "asml-q2-2026-earnings";

describe("wiki_build on the loop (Phase W, ADR 0020)", () => {
  it("happy path: ≥2 sources → synthesized page stored + rendered; digest, ledger event, trust anchor", async () => {
    const store = RunStore.openInMemory();
    const calls: Array<Record<string, unknown>> = [];
    try {
      const root = projectRoot();
      const run_id = turnRun(store, "帮我调研一下 ASML 最近的财报");
      const worker = makeWorker(
        store,
        root,
        wikiLoopLlm(TWO_SEARCHES_THEN_BUILD, SYNTH_PAGE, undefined, calls),
        fakeWebSearch([
          [{ url: "https://a.com/earnings", snippet: "ASML beats estimates" }],
          [{ url: "https://b.com/analysis", snippet: "analysts raise targets" }]
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // Armed → both names listed in the manifest.
      const manifest = loopEvents(store, run_id, "loop_started")[0]!.payload.manifest as string[];
      expect(manifest).toContain("wiki_build");
      expect(manifest).toContain("wiki_refine");

      // The page row: synthesized content, NEVER the model's injected input fields.
      const pages = store.getActiveWikiPages();
      expect(pages.length).toBe(1);
      const page = pages[0]!;
      expect(page.topic_slug).toBe(SLUG);
      expect(page.title).toBe("ASML Q2 2026");
      expect(page.body_md).toBe("## Results\nGood quarter.");
      expect(page.body_md).not.toContain("EVIL-INJECTED");
      expect(JSON.parse(page.sources)).toEqual(["https://a.com/earnings", "https://b.com/analysis"]);
      expect(page.confidence).toBe(0.9);
      expect(page.verified_passes).toBe(2);

      // TRUST ANCHOR: synthesis reads the turn's RECORDED step digests — the model's
      // content/body fields never reach any LLM question.
      const synthCall = calls.find((c) => c.system === WIKI_SYNTH_DISCIPLINE)!;
      expect(synthCall).toBeDefined();
      // The question carries the RECORDED step digests of both reads, labelled per source.
      expect(String(synthCall.question)).toContain("[source 1]");
      expect(String(synthCall.question)).toContain("https://a.com/earnings");
      expect(String(synthCall.question)).toContain("https://b.com/analysis");
      // The model's injected content/body fields never reach the wiki pipeline's calls
      // (the loop's own compose transcript echoing its OWN action line is expected).
      const wikiCalls = calls.filter((c) => c.system === WIKI_SYNTH_DISCIPLINE || c.system === WIKI_VERIFY_DISCIPLINE);
      expect(wikiCalls.some((c) => String(c.question).includes("EVIL-INJECTED"))).toBe(false);

      // Verification ran on the walled verifier discipline (2 default passes).
      expect(calls.filter((c) => c.system === WIKI_VERIFY_DISCIPLINE).length).toBe(2);

      // The step digest IS the exported code-rendered saved digest.
      const steps = loopEvents(store, run_id, "loop_step").filter((e) => e.payload.action === "wiki_build");
      expect(steps[0]!.payload.ok).toBe(true);
      expect(String(steps[0]!.payload.result_digest)).toBe(buildWikiSavedDigest("add", SLUG, 2, 0.9, 0));

      // wiki_page_saved hit the ledger with the audit payload.
      const saved = loopEvents(store, run_id, "wiki_page_saved");
      expect(saved.length).toBe(1);
      expect(saved[0]!.payload).toMatchObject({
        verb: "add",
        id: page.id,
        topic_slug: SLUG,
        source_count: 2,
        confidence: 0.9,
        contradiction_count: 0
      });

      // The markdown render exists with frontmatter (sqlite stays truth).
      const mdPath = join(root, "memory", "wiki", `${SLUG}.md`);
      expect(existsSync(mdPath)).toBe(true);
      expect(readFileSync(mdPath, "utf8")).toContain(`topic: ${SLUG}`);
    } finally {
      store.close();
    }
  });

  it("C3 floor: fewer distinct sources than the minimum refuses with the steering digest — nothing stored", async () => {
    const store = RunStore.openInMemory();
    try {
      const root = projectRoot();
      const run_id = turnRun(store, "只查了一个来源");
      const worker = makeWorker(
        store,
        root,
        wikiLoopLlm(
          [
            '{"action":"web_search","input":{"query":"one source"},"why":"research"}',
            '{"action":"wiki_build","input":{"topic":"ASML"},"why":"save"}',
            '{"action":"final","answer":"好的。"}'
          ],
          SYNTH_PAGE
        ),
        // One page under two host+path keys? No — a query variant of the SAME page: ONE source.
        fakeWebSearch([[{ url: "https://a.com/earnings?x=1", snippet: "s1" }, { url: "https://a.com/earnings#y", snippet: "s2" }]])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      const steps = loopEvents(store, run_id, "loop_step").filter((e) => e.payload.action === "wiki_build");
      expect(steps[0]!.payload.ok).toBe(false);
      expect(String(steps[0]!.payload.result_digest)).toContain(buildWikiNeedSourcesError(2));
      expect(store.getActiveWikiPages()).toEqual([]);
      expect(loopEvents(store, run_id, "wiki_page_saved")).toEqual([]);
      expect(existsSync(join(root, "memory", "wiki"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("disarmed (default OFF): unlisted in the manifest and a scripted call is denied without executing", async () => {
    delete process.env.HOUGE_WIKI_ENABLED;
    const store = RunStore.openInMemory();
    try {
      const run_id = turnRun(store, "帮我调研 ASML");
      const worker = makeWorker(
        store,
        projectRoot(),
        wikiLoopLlm(
          [
            '{"action":"wiki_build","input":{"topic":"ASML"},"why":"save"}',
            '{"action":"final","answer":"我现在还没有 wiki 能力。"}'
          ],
          SYNTH_PAGE
        ),
        fakeWebSearch([])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      const manifest = loopEvents(store, run_id, "loop_started")[0]!.payload.manifest as string[];
      expect(manifest).not.toContain("wiki_build");
      expect(manifest).not.toContain("wiki_refine");
      const steps = loopEvents(store, run_id, "loop_step").filter((e) => e.payload.action === "wiki_build");
      expect(steps[0]!.payload.ok).toBe(false); // unknown-capability denial
      expect(store.getActiveWikiPages()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("verify-fail (all passes garbage): the page saves UNVERIFIED — confidence null, never blocked", async () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = turnRun(store, "来源都在但验证挂了");
      const worker = makeWorker(
        store,
        projectRoot(),
        wikiLoopLlm(TWO_SEARCHES_THEN_BUILD, SYNTH_PAGE, ["not json at all"]),
        fakeWebSearch([
          [{ url: "https://a.com/x", snippet: "s1" }],
          [{ url: "https://b.com/y", snippet: "s2" }]
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      const page = store.getActiveWikiPages()[0]!;
      expect(page.confidence).toBeNull();
      expect(page.verified_passes).toBe(0);
      expect(page.last_verified).toBeNull();

      const steps = loopEvents(store, run_id, "loop_step").filter((e) => e.payload.action === "wiki_build");
      expect(String(steps[0]!.payload.result_digest)).toBe(buildWikiSavedDigest("add", SLUG, 2, null, 0));
      expect(loopEvents(store, run_id, "wiki_page_saved")[0]!.payload.confidence).toBeNull();
    } finally {
      store.close();
    }
  });

  it("contradiction: stored verbatim, rendered into the .md, and surfaced CODE-OWNED in the reply", async () => {
    const store = RunStore.openInMemory();
    try {
      const root = projectRoot();
      const run_id = turnRun(store, "分析师目标价有分歧");
      const contradiction = { claim: "target price", a: "source 1: $1100", b: "source 2: $950" };
      const worker = makeWorker(
        store,
        root,
        wikiLoopLlm(TWO_SEARCHES_THEN_BUILD, SYNTH_PAGE, [
          JSON.stringify({ supported: [], unsupported: [], contradictions: [contradiction], confidence: 0.6 })
        ]),
        fakeWebSearch([
          [{ url: "https://a.com/x", snippet: "s1" }],
          [{ url: "https://b.com/y", snippet: "s2" }]
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // Stored on the row, both sides verbatim.
      const page = store.getActiveWikiPages()[0]!;
      expect(JSON.parse(page.contradictions)).toEqual([contradiction]);

      // The notice rides the outgoing reply CODE-OWNED (evolutionNotices, ADR 0001) —
      // the model's final answer alone can never hide it.
      const turns = store.getRecentChatTurns("555", 6);
      const reply = turns.find((t) => t.role === "assistant")!.text;
      expect(reply).toContain(EVOLUTION_NOTICE_HEADER);
      expect(reply).toContain(buildWikiContradictionNotice(SLUG, [contradiction]));

      // The render carries the unresolved-contradictions section.
      const md = readFileSync(join(root, "memory", "wiki", `${SLUG}.md`), "utf8");
      expect(md).toContain(WIKI_CONTRADICTIONS_SECTION_HEADER);
      expect(md).toContain("source 1: $1100");

      // And the digest + event count it.
      const steps = loopEvents(store, run_id, "loop_step").filter((e) => e.payload.action === "wiki_build");
      expect(String(steps[0]!.payload.result_digest)).toBe(buildWikiSavedDigest("add", SLUG, 2, 0.6, 1));
      expect(loopEvents(store, run_id, "wiki_page_saved")[0]!.payload.contradiction_count).toBe(1);
    } finally {
      store.close();
    }
  });

  it("auto-route: wiki_build on an EXISTING topic refines — supersede lineage, never a duplicate", async () => {
    const store = RunStore.openInMemory();
    const calls: Array<Record<string, unknown>> = [];
    try {
      const priorId = store.addWikiPage({
        topic_slug: SLUG,
        title: "ASML Q2 2026 (old)",
        summary: "Old summary.",
        key_facts: ["old fact"],
        body_md: "old body",
        sources: ["https://old.com/x"],
        created_at: "2026-07-10T00:00:00.000Z"
      });
      const run_id = turnRun(store, "再查一次 ASML 财报");
      const worker = makeWorker(
        store,
        projectRoot(),
        wikiLoopLlm(TWO_SEARCHES_THEN_BUILD, SYNTH_PAGE, undefined, calls),
        fakeWebSearch([
          [{ url: "https://a.com/x", snippet: "s1" }],
          [{ url: "https://b.com/y", snippet: "s2" }]
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // The prior page rode the synthesis DATA channel (reconcile instruction).
      const synthCall = calls.find((c) => c.system === WIKI_SYNTH_DISCIPLINE)!;
      expect(String(synthCall.question)).toContain("Prior page");
      expect(String(synthCall.question)).toContain("ASML Q2 2026 (old)");

      // One active page (the refine), lineage bidirectional, never a duplicate.
      const active = store.getActiveWikiPages();
      expect(active.length).toBe(1);
      expect(active[0]!.supersedes).toBe(priorId);
      const old = store.getWikiPage(priorId)!;
      expect(old.status).toBe("superseded");
      expect(old.superseded_by).toBe(active[0]!.id);

      const steps = loopEvents(store, run_id, "loop_step").filter((e) => e.payload.action === "wiki_build");
      expect(String(steps[0]!.payload.result_digest)).toBe(buildWikiSavedDigest("refine", SLUG, 2, 0.9, 0));
      expect(loopEvents(store, run_id, "wiki_page_saved")[0]!.payload).toMatchObject({
        verb: "refine",
        superseded_id: priorId
      });
    } finally {
      store.close();
    }
  });

  it('refine with {"unchanged":true}: touches last_verified only — no new row, verb unchanged', async () => {
    const store = RunStore.openInMemory();
    try {
      const priorId = store.addWikiPage({
        topic_slug: SLUG,
        title: "ASML Q2 2026",
        summary: "Summary.",
        last_verified: "2026-07-10T00:00:00.000Z",
        created_at: "2026-07-10T00:00:00.000Z"
      });
      const run_id = turnRun(store, "复查 ASML");
      const worker = makeWorker(
        store,
        projectRoot(),
        wikiLoopLlm(TWO_SEARCHES_THEN_BUILD, '{"unchanged":true}'),
        fakeWebSearch([
          [{ url: "https://a.com/x", snippet: "s1" }],
          [{ url: "https://b.com/y", snippet: "s2" }]
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      const active = store.getActiveWikiPages();
      expect(active.length).toBe(1);
      expect(active[0]!.id).toBe(priorId);
      expect(Date.parse(active[0]!.last_verified!)).toBeGreaterThan(Date.parse("2026-07-10T00:00:00.000Z"));

      const steps = loopEvents(store, run_id, "loop_step").filter((e) => e.payload.action === "wiki_build");
      expect(String(steps[0]!.payload.result_digest)).toBe(buildWikiSavedDigest("unchanged", SLUG, 2, null, 0));
    } finally {
      store.close();
    }
  });

  it("render write failure is NON-FATAL: the sqlite save + digest survive a broken memory/wiki path", async () => {
    const store = RunStore.openInMemory();
    try {
      const root = projectRoot();
      // A regular FILE where the wiki DIR must go — mkdirSync will throw on every render.
      mkdirSync(join(root, "memory"), { recursive: true });
      writeFileSync(join(root, "memory", "wiki"), "not a directory");

      const run_id = turnRun(store, "渲染坏了也要保存");
      const worker = makeWorker(
        store,
        root,
        wikiLoopLlm(TWO_SEARCHES_THEN_BUILD, SYNTH_PAGE),
        fakeWebSearch([
          [{ url: "https://a.com/x", snippet: "s1" }],
          [{ url: "https://b.com/y", snippet: "s2" }]
        ])
      );
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // SQLite is truth: the row landed and the step succeeded despite the render failure.
      expect(store.getActiveWikiPages().length).toBe(1);
      const steps = loopEvents(store, run_id, "loop_step").filter((e) => e.payload.action === "wiki_build");
      expect(steps[0]!.payload.ok).toBe(true);
      expect(String(steps[0]!.payload.result_digest)).toBe(buildWikiSavedDigest("add", SLUG, 2, 0.9, 0));
      expect(loopEvents(store, run_id, "wiki_page_saved").length).toBe(1);
    } finally {
      store.close();
    }
  });
});
