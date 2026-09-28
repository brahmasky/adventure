import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { DISTILL_DISCIPLINE } from "../../src/capabilities/distill.js";
import { RECONCILE_DISCIPLINE } from "../../src/capabilities/reconcile.js";
import { GATE_A_DISCIPLINE } from "../../src/capabilities/skill-router.js";
import { LOOP_DISCIPLINE } from "../../src/prompt/composer.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

// HERMETICITY (the cardinal PINNED_ENV rule): the daemon's .env leaks into test runs via the
// self-write test gate — pin every flag that could arm the shadow or change the turn's path.
const PINNED_ENV = [
  "HOUGE_JEV_SHADOW_ENABLED", "TYPESAFE_API_KEY", "HOUGE_SECRETS_FIREWALL_ENABLED",
  "HOUGE_EPISODIC_ENABLED", "HOUGE_DUAL_LLM_ENABLED", "HOUGE_SKILLS_ENABLED", "HOUGE_SELFWRITE_ENABLED",
  "HOUGE_CODEX_ENABLED", "HOUGE_SCHEDULER_ENABLED", "HOUGE_WIKI_ENABLED", "HOUGE_EXTWORK_ENABLED",
  "HOUGE_BOUNTY_ENABLED", "HOUGE_GOOGLE_ENABLED", "HOUGE_MAX_CONSECUTIVE_CLARIFY"
] as const;
let savedEnv: Record<string, string | undefined> = {};
let dirs: string[] = [];
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
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
  vi.restoreAllMocks();
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-jev-shadow-"));
  dirs.push(dir);
  return dir;
}

function turnRun(store: RunStore, message: string, key = `t:${message}`): string {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: message,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" },
    idempotency_key: key, source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

/** Classifier → `verdict` (after `beforeVerdict` settles); compose → a final answer; the rest → benign stubs. */
function fakeLlm(verdict: string, calls: Array<Record<string, unknown>> = [], beforeVerdict?: Promise<unknown>, classifierFails = false) {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    calls.push(input);
    const system = typeof input.system === "string" ? input.system : "";
    if (system.includes(INTENT_DISCIPLINE)) {
      if (beforeVerdict) await beforeVerdict;
      if (classifierFails) return { ok: false, error: "classifier down" };
      return { ok: true, output: { question: input.question, answer: verdict, model: "fake", provider: "fake" } };
    }
    let answer = `ANSWER: ${String(input.question)}`;
    if (system.includes(LOOP_DISCIPLINE)) answer = '{"action":"final","answer":"done."}';
    else if (system === DISTILL_DISCIPLINE) answer = '{"durable":false}';
    else if (system === RECONCILE_DISCIPLINE) answer = '{"verdict":"ADD"}';
    else if (system === GATE_A_DISCIPLINE) answer = '{"verdict":"unsure","reason":"stub"}';
    return { ok: true, output: { question: input.question, answer, model: "fake", provider: "fake" } };
  };
}

const jevOk = (choice = "research", confidence = 0.9): JevResult => ({
  ok: true, model: "jev-1.13.0", input_tokens: 700, latency_ms: 250,
  answers: { intent: { choice, confidence, probabilities: { answer: 0.02, research: 0.9, feedback: 0.02, clarify: 0.02, selfcode: 0.02, skill: 0.02 } } }
});

/** A CoreWorker with injected LLM + Jev fakes (the Jev fake is the 14th positional). */
function worker(store: RunStore, llm: ReturnType<typeof fakeLlm>, jev?: (req: JevRequest) => Promise<JevResult>) {
  return new CoreWorker(store, root(), llm, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, jev);
}

const shadowRows = (store: RunStore, run_id: string) =>
  store.getLedgerEvents(run_id).filter((e) => e.event_type === "intent_shadow");

describe("the live Jev intent shadow inside classifyIntent", () => {
  it("flag OFF: Jev is never called and no intent_shadow row exists", async () => {
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(async () => jevOk());
      const run = turnRun(store, "what is 2+2?");
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), jev).executeRun(run, "w")).status).toBe("completed");
      expect(jev).not.toHaveBeenCalled();
      expect(shadowRows(store, run)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("flag ON: one row pairing Jev's label with the classifier's RAW label, from the same inputs", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(async (_req: JevRequest) => jevOk("research", 0.93));
      const run = turnRun(store, "what did the RBA decide today?");
      expect((await worker(store, fakeLlm('{"intent":"research","query":"rba decision"}'), jev).executeRun(run, "w")).status).toBe("completed");
      await vi.waitFor(() => expect(shadowRows(store, run)).toHaveLength(1));
      expect(shadowRows(store, run)[0]!.payload).toMatchObject({
        status: "ok", llm_intent: "research", llm_parsed: true, lang: "en", modality: "text",
        jev_intent: "research", jev_confidence: 0.93, jev_model: "jev-1.13.0", jev_latency_ms: 250
      });
      expect((jev.mock.calls[0]![0].state as { latest_message: string }).latest_message).toBe("what did the RBA decide today?");
    } finally {
      store.close();
    }
  });

  it("Jev starts BEFORE the classifier returns (concurrent, not after): a classifier that waits for Jev still completes", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      let markJevStarted!: () => void;
      const jevStarted = new Promise<void>((r) => { markJevStarted = r; });
      const jev = vi.fn(async () => { markJevStarted(); return jevOk(); });
      const run = turnRun(store, "latest ASX close?");
      const result = await worker(store, fakeLlm('{"intent":"research"}', [], jevStarted), jev).executeRun(run, "w");
      expect(result.status).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("the turn NEVER waits: a Jev call that never settles leaves the turn unaffected — its timeout row lands at the outer deadline (shadow.test.ts)", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(() => new Promise<JevResult>(() => {}));
      const run = turnRun(store, "hello there");
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), jev).executeRun(run, "w")).status).toBe("completed");
      expect(jev).toHaveBeenCalledTimes(1);
      expect(shadowRows(store, run)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("a Jev call that throws cannot fail the turn — it is recorded as status error", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "hello again");
      const jev = vi.fn(async (): Promise<JevResult> => { throw new Error("socket hang up"); });
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), jev).executeRun(run, "w")).status).toBe("completed");
      await vi.waitFor(() => expect(shadowRows(store, run)).toHaveLength(1));
      expect(shadowRows(store, run)[0]!.payload).toMatchObject({ status: "error", jev_error: "shadow call threw", llm_intent: "answer" });
    } finally {
      store.close();
    }
  });

  it("records the classifier's clarify BEFORE the recordedIntent rewrite turns it into answer", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "can you check it?");
      await worker(store, fakeLlm('{"intent":"clarify","clarifying_question":"check what?"}'), async () => jevOk("clarify", 0.8)).executeRun(run, "w");
      expect(store.getRecentChatTurns("555", 2).find((t) => t.role === "assistant")!.intent).toBe("answer");
      await vi.waitFor(() => expect(shadowRows(store, run)).toHaveLength(1));
      expect(shadowRows(store, run)[0]!.payload.llm_intent).toBe("clarify");
    } finally {
      store.close();
    }
  });

  it("an unparseable classifier reply is recorded as answer with llm_parsed=false", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "tell me something");
      await worker(store, fakeLlm("I think this is research"), async () => jevOk()).executeRun(run, "w");
      await vi.waitFor(() => expect(shadowRows(store, run)).toHaveLength(1));
      expect(shadowRows(store, run)[0]!.payload).toMatchObject({ llm_intent: "answer", llm_parsed: false });
    } finally {
      store.close();
    }
  });

  it("classifier failure: the turn fails as before and NO intent_shadow row is written (no label to pair)", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "anything");
      const result = await worker(store, fakeLlm('{"intent":"answer"}', [], undefined, true), async () => jevOk()).executeRun(run, "w");
      expect(result.status).not.toBe("completed");
      await new Promise((r) => setTimeout(r, 20));
      expect(shadowRows(store, run)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("runner admission comes FIRST: a classifier the runner denies never sends the message to Jev (Codex B1)", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    const original = CapabilityRunner.prototype.execute;
    vi.spyOn(CapabilityRunner.prototype, "execute").mockImplementation(async function (this: CapabilityRunner, input) {
      const system = typeof input.input.system === "string" ? input.input.system : "";
      if (input.capability === "llm_answer" && system.includes(INTENT_DISCIPLINE)) {
        return { status: "denied", reason: "budget exhausted (test)", recovery_hint: "Write a partial report" };
      }
      return original.call(this, input);
    });
    try {
      const jev = vi.fn(async () => jevOk());
      const run = turnRun(store, "a denied turn");
      const result = await worker(store, fakeLlm('{"intent":"answer"}'), jev).executeRun(run, "w");
      expect(result.status).not.toBe("completed");
      await new Promise((r) => setTimeout(r, 20));
      expect(jev).not.toHaveBeenCalled();
      expect(shadowRows(store, run)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("Jev's label never reaches a prompt: the loop's hint is the classifier's, even when Jev disagrees confidently", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const calls: Array<Record<string, unknown>> = [];
      const run = turnRun(store, "what's new with the RBA?");
      await worker(store, fakeLlm('{"intent":"research"}', calls), async () => jevOk("skill", 0.99)).executeRun(run, "w");
      const compose = calls.filter((c) => String(c.system).includes(LOOP_DISCIPLINE));
      expect(compose.length).toBeGreaterThan(0);
      for (const c of compose) {
        expect(String(c.question)).toContain("A first-pass classifier suggests: research");
        expect(String(c.question)).not.toContain("suggests: skill");
      }
    } finally {
      store.close();
    }
  });

  it("the flag is read LIVE per turn (/disarm flips process.env): turning it off stops the next shadow", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(async () => jevOk());
      const w = worker(store, fakeLlm('{"intent":"answer"}'), jev);
      await w.executeRun(turnRun(store, "first", "k1"), "w");
      process.env.HOUGE_JEV_SHADOW_ENABLED = "false";
      await w.executeRun(turnRun(store, "second", "k2"), "w");
      expect(jev).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("hermetic by construction: an injected LLM + a real key in env + no Jev fake → no network, no row", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    process.env.TYPESAFE_API_KEY = "ts-live-looking-key-0000000000";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden in tests"));
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "is this hermetic?");
      await worker(store, fakeLlm('{"intent":"answer"}')).executeRun(run, "w");
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(shadowRows(store, run)).toHaveLength(0);
      expect(store.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt" && e.payload.role === "classify_shadow")).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("boot warning: flag on + no key + production adapters → exactly one warning; key present or flag off → none", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = RunStore.openInMemory();
    try {
      const jevWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes("[jev-shadow]")).length;
      process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
      new CoreWorker(store, root());
      expect(jevWarnings()).toBe(1);
      process.env.TYPESAFE_API_KEY = "ts-live-looking-key-0000000000";
      new CoreWorker(store, root());
      process.env.HOUGE_JEV_SHADOW_ENABLED = "false";
      delete process.env.TYPESAFE_API_KEY;
      new CoreWorker(store, root());
      expect(jevWarnings()).toBe(1);
      expect(warn.mock.calls.flat().join(" ")).not.toContain("ts-live-looking-key");
    } finally {
      store.close();
    }
  });
});
