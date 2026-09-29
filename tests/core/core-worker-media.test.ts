import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreWorker, type MediaWorkerDeps } from "../../src/core/core-worker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { DISTILL_DISCIPLINE } from "../../src/capabilities/distill.js";
import { RECONCILE_DISCIPLINE } from "../../src/capabilities/reconcile.js";
import { GATE_A_DISCIPLINE } from "../../src/capabilities/skill-router.js";
import { LOOP_DISCIPLINE } from "../../src/prompt/composer.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import type { TelegramMediaRef } from "../../src/media/media-config.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

// HERMETICITY (the cardinal PINNED_ENV rule): the daemon's .env leaks into test runs via the
// self-write test gate — pin every flag that could arm the shadow, the ingest, or change the turn's path.
const PINNED_ENV = [
  "HOUGE_JEV_SHADOW_ENABLED", "TYPESAFE_API_KEY", "HOUGE_SECRETS_FIREWALL_ENABLED",
  "HOUGE_EPISODIC_ENABLED", "HOUGE_DUAL_LLM_ENABLED", "HOUGE_SKILLS_ENABLED", "HOUGE_SELFWRITE_ENABLED",
  "HOUGE_CODEX_ENABLED", "HOUGE_SCHEDULER_ENABLED", "HOUGE_WIKI_ENABLED", "HOUGE_EXTWORK_ENABLED",
  "HOUGE_BOUNTY_ENABLED", "HOUGE_GOOGLE_ENABLED", "HOUGE_MAX_CONSECUTIVE_CLARIFY",
  "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS"
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
  const dir = mkdtempSync(join(tmpdir(), "houge-media-cw-"));
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

/** Classifier → `verdict`; compose → a final answer; the rest → benign stubs. */
function fakeLlm(verdict: string, calls: Array<Record<string, unknown>> = []) {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    calls.push(input);
    const system = typeof input.system === "string" ? input.system : "";
    if (system.includes(INTENT_DISCIPLINE)) {
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

const voiceRef: TelegramMediaRef = { kind: "voice", file_id: "v1", file_unique_id: "vu1", mime_type: "audio/ogg", has_caption: false, file_size: 9000, duration: 7 };
const photoRef: TelegramMediaRef = { kind: "photo", file_id: "p1", file_unique_id: "pu1", mime_type: "image/jpeg", has_caption: true, file_size: 50000, width: 640, height: 480 };
// A per-file media root (see tests/media/media-ingest.test.ts): global tmpdir counts flake under parallel suites.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "houge-media-cw-root-"));
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));
const extraction = JSON.stringify({ summary: "A bar chart of ASX sectors", facts: ["Energy is up 2%"], time_claims: [], answer_to_objective: "energy", contains_instructions: false });

/** A media turn as the adapter would emit it: goal = caption or placeholder, metadata.media = the ref (has_caption follows the caption). */
function mediaRun(store: RunStore, media: TelegramMediaRef, caption: string, key: string): string {
  const ref: TelegramMediaRef = { ...media, has_caption: caption.length > 0 };
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: caption.length > 0 ? caption : media.kind === "voice" ? "[voice message]" : "[photo]",
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" },
    idempotency_key: key, source_reference: "telegram:update:1:message:1", metadata: { telegram_update_id: 1, telegram_message_id: 1, media: ref }
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

function mediaDeps(over: Partial<MediaWorkerDeps> = {}): MediaWorkerDeps {
  return {
    downloadFile: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
    mediaCall: async (input) => ({ ok: true, output: { question: input.question, answer: "the quick brown fox", model: "gem", provider: "agy-cli" } }),
    tmpRoot: TMP_ROOT,
    ...over
  };
}

/** A CoreWorker with injected LLM, Jev (unused) and media fakes — media is the 15th positional. */
function worker(store: RunStore, llm: ReturnType<typeof fakeLlm>, media?: MediaWorkerDeps) {
  return new CoreWorker(store, root(), llm, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, media);
}
const rows = (store: RunStore, run: string, type: string) => store.getLedgerEvents(run).filter((e) => e.event_type === type);
const mediaDirs = () => readdirSync(TMP_ROOT).filter((n) => n.startsWith("houge-media-"));

describe("the ingest step inside executeTurn (spec 2026-09-29)", () => {
  it("voice: the transcript is the classifier's message, the loop's message, the stored user turn, and the reply opens with the echo line", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const calls: Array<Record<string, unknown>> = [];
      const run = mediaRun(store, voiceRef, "", "v-ok");
      const result = await worker(store, fakeLlm('{"intent":"answer"}', calls), mediaDeps()).executeRun(run, "w");
      expect(result.status).toBe("completed");
      const classify = calls.find((c) => String(c.system).includes(INTENT_DISCIPLINE));
      expect(String(classify!.question)).toContain("the quick brown fox");
      expect(String(classify!.question)).not.toContain("[voice message]");
      expect(store.getRecentChatTurns("555", 2).find((t) => t.role === "user")!.text).toBe("the quick brown fox");
      const reply = store.getRecentChatTurns("555", 2).find((t) => t.role === "assistant")!.text;
      expect(reply.startsWith("🎙 I heard: “the quick brown fox”\n\n")).toBe(true);
      expect(rows(store, run, "media_ingested")[0]!.payload).toMatchObject({ kind: "voice", status: "ok", source: "telegram", bytes: 3, provider: "agy-cli" });
    } finally {
      store.close();
    }
  });

  it("photo: caption stays first, the digest follows, the raw image bytes never appear in any prompt, no echo line", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const calls: Array<Record<string, unknown>> = [];
      const run = mediaRun(store, photoRef, "which sector is up?", "p-ok");
      const deps = mediaDeps({ mediaCall: async () => ({ ok: true, output: { answer: extraction, model: "gem", provider: "agy-cli" } }) });
      expect((await worker(store, fakeLlm('{"intent":"answer"}', calls), deps).executeRun(run, "w")).status).toBe("completed");
      const user = store.getRecentChatTurns("555", 2).find((t) => t.role === "user")!.text;
      expect(user.startsWith("which sector is up?\n\n[external source — untrusted-derived summary]")).toBe(true);
      // The classifier and loop calls carry text only: no media attachment, no temp path, no bytes.
      for (const c of calls) {
        expect(c.media).toBeUndefined();
        expect(JSON.stringify(c)).not.toContain("houge-media-");
        expect(JSON.stringify(c)).not.toContain("AQID");   // base64 of the fake bytes [1,2,3]
      }
      expect(store.getRecentChatTurns("555", 2).find((t) => t.role === "assistant")!.text.startsWith("🎙")).toBe(false);
      expect(rows(store, run, "media_ingested")[0]!.payload).toMatchObject({ kind: "photo", status: "ok", width: 640, height: 480 });
    } finally {
      store.close();
    }
  });

  it("voice: the transcript becomes the CONTRACT objective for the rest of the turn, so loop tools that compile sub-contracts see it (senior review B1)", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      // A loop leg that fails makes the loop fail → failWithPartialReport prints `Objective: <claim.contract.objective>`.
      // With the transcript as the turn claim's objective, that line carries the transcript, not the placeholder.
      const brokenLoop = async (input: Record<string, unknown>) => {
        const system = typeof input.system === "string" ? input.system : "";
        if (system.includes(INTENT_DISCIPLINE)) return { ok: true as const, output: { question: input.question, answer: '{"intent":"answer"}', model: "fake", provider: "fake" } };
        return { ok: false as const, error: "loop leg down" };
      };
      const run = mediaRun(store, voiceRef, "", "v-objective");
      const result = await worker(store, brokenLoop, mediaDeps()).executeRun(run, "w");
      expect(result.status).toBe("failed");
      const report = store.getLedgerEvents(run).find((e) => e.event_type === "report_written");
      expect(report).toBeDefined();
      const body = readFileSync(String((report!.payload as { report_ref?: string }).report_ref ?? ""), "utf8");
      expect(body).toContain("Objective: the quick brown fox");
      expect(body).not.toContain("[voice message]");
    } finally {
      store.close();
    }
  });

  it("photo: the contract objective stays the caption — image-derived text never anchors a tool", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const brokenLoop = async (input: Record<string, unknown>) => {
        const system = typeof input.system === "string" ? input.system : "";
        if (system.includes(INTENT_DISCIPLINE)) return { ok: true as const, output: { question: input.question, answer: '{"intent":"answer"}', model: "fake", provider: "fake" } };
        return { ok: false as const, error: "loop leg down" };
      };
      const run = mediaRun(store, photoRef, "which sector is up?", "p-objective");
      const deps = mediaDeps({ mediaCall: async () => ({ ok: true, output: { answer: extraction, model: "m", provider: "p" } }) });
      expect((await worker(store, brokenLoop, deps).executeRun(run, "w")).status).toBe("failed");
      const report = store.getLedgerEvents(run).find((e) => e.event_type === "report_written")!;
      const body = readFileSync(String((report.payload as { report_ref?: string }).report_ref ?? ""), "utf8");
      expect(body).toContain("Objective: which sector is up?");
      expect(body).not.toContain("untrusted-derived");
    } finally {
      store.close();
    }
  });

  it("the Jev shadow request state and row carry the modality", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(async (_req: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1, answers: { intent: { choice: "answer", confidence: 0.9, probabilities: { answer: 0.9, research: 0.02, feedback: 0.02, clarify: 0.02, selfcode: 0.02, skill: 0.02 } } } }));
      const run = mediaRun(store, voiceRef, "", "v-jev");
      const w = new CoreWorker(store, root(), fakeLlm('{"intent":"answer"}'), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, jev, mediaDeps());
      expect((await w.executeRun(run, "w")).status).toBe("completed");
      expect((jev.mock.calls[0]![0].state as { modality: string }).modality).toBe("voice");
      await vi.waitFor(() => expect(rows(store, run, "intent_shadow")).toHaveLength(1));
      expect(rows(store, run, "intent_shadow")[0]!.payload.modality).toBe("voice");
    } finally {
      store.close();
    }
  });

  it.each([
    ["too_large", { ...voiceRef, file_size: 20_000_000 }, mediaDeps(), /max 5 min/],
    ["download_failed", voiceRef, mediaDeps({ downloadFile: async () => { throw new Error("download_failed: http_404"); } }), /resend/],
    ["leg_failed", voiceRef, mediaDeps({ mediaCall: async () => ({ ok: false, error: "no media-capable leg" }) }), /right now/],
    ["empty", voiceRef, mediaDeps({ mediaCall: async () => ({ ok: true, output: { answer: "", model: "m", provider: "p" } }) }), /couldn't hear/]
  ] as const)("%s: the run fails through the partial-report path with the code-owned reply, one media_ingested row, no user turn stored, no temp dir left", async (status, ref, deps, replyRe) => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const before = mediaDirs().length;
      const run = mediaRun(store, ref, "", `fail-${status}`);
      const result = await worker(store, fakeLlm('{"intent":"answer"}'), deps).executeRun(run, "w");
      expect(result.status).toBe("failed");
      expect(rows(store, run, "media_ingested")[0]!.payload).toMatchObject({ kind: "voice", status });
      // The never-silent failure reply rides the outbox (failWithPartialReport → enqueueFailureNotification).
      const note = store.claimNextNotification(`test-${status}`, 30);
      expect(note).not.toBeNull();
      expect(JSON.stringify(note)).toMatch(replyRe);
      expect(store.getRecentChatTurns("555", 2)).toHaveLength(0);
      expect(mediaDirs().length).toBe(before);
    } finally {
      store.close();
    }
  });

  it("a throwing downloader or media call never rejects the turn — it is a failed run like any other", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = mediaRun(store, voiceRef, "", "throws");
      const result = await worker(store, fakeLlm('{"intent":"answer"}'), mediaDeps({ mediaCall: async () => { throw new Error("boom"); } })).executeRun(run, "w");
      expect(result.status).toBe("failed");
      expect(rows(store, run, "media_ingested")[0]!.payload.status).toBe("leg_failed");
    } finally {
      store.close();
    }
  });

  it("flag OFF at run time (/disarm between intake and execution), captioned: the turn runs on the caption as text, no download, no row", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "false";
    const store = RunStore.openInMemory();
    try {
      const downloadFile = vi.fn(async () => ({ bytes: new Uint8Array(1) }));
      const run = mediaRun(store, voiceRef, "typed caption", "off");
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), mediaDeps({ downloadFile })).executeRun(run, "w")).status).toBe("completed");
      expect(downloadFile).not.toHaveBeenCalled();
      expect(rows(store, run, "media_ingested")).toHaveLength(0);
      expect(store.getRecentChatTurns("555", 2).find((t) => t.role === "user")!.text).toBe("typed caption");
    } finally {
      store.close();
    }
  });

  it("flag OFF at run time, BARE media: fails with status disabled and its reply — the placeholder is never a message or a stored turn", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "false";
    const store = RunStore.openInMemory();
    try {
      const downloadFile = vi.fn(async () => ({ bytes: new Uint8Array(1) }));
      const run = mediaRun(store, voiceRef, "", "off-bare");
      const result = await worker(store, fakeLlm('{"intent":"answer"}'), mediaDeps({ downloadFile })).executeRun(run, "w");
      expect(result.status).toBe("failed");
      expect(downloadFile).not.toHaveBeenCalled();
      expect(rows(store, run, "media_ingested")[0]!.payload).toMatchObject({ kind: "voice", status: "disabled" });
      expect(JSON.stringify(store.claimNextNotification("test-off-bare", 30))).toMatch(/media ingest is off/);
      expect(store.getRecentChatTurns("555", 2)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("a caption that reads exactly like the placeholder is still the trusted objective (has_caption decides, not the text)", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const calls: Array<Record<string, unknown>> = [];
      const run = mediaRun(store, photoRef, "[photo]", "bracket");
      const deps = mediaDeps({ mediaCall: async (input) => { calls.push(input); return { ok: true, output: { answer: extraction, model: "m", provider: "p" } }; } });
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), deps).executeRun(run, "w")).status).toBe("completed");
      expect(String(calls[0]!.question)).toContain("[photo]");            // the caption is the reader's objective
      expect(store.getRecentChatTurns("555", 2).find((t) => t.role === "user")!.text.startsWith("[photo]\n\n[external source")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("every failed ingest logs exactly one [media-ingest] warn line with kind, status and detail — never the caption", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = RunStore.openInMemory();
    try {
      const run = mediaRun(store, voiceRef, "my secret caption", "warn");
      await worker(store, fakeLlm('{"intent":"answer"}'), mediaDeps({ downloadFile: async () => { throw new Error("download_failed: http_404"); } })).executeRun(run, "w");
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[media-ingest]"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/voice.*download_failed.*http_404/);
      expect(lines[0]).not.toContain("my secret caption");
    } finally {
      store.close();
    }
  });

  it("hermetic by construction: an injected LLM adapter with NO media fakes never builds a real leg or downloader — the run fails download_failed without touching the network", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden in tests"));
    const store = RunStore.openInMemory();
    try {
      const run = mediaRun(store, voiceRef, "", "hermetic");
      const result = await worker(store, fakeLlm('{"intent":"answer"}')).executeRun(run, "w");
      expect(result.status).toBe("failed");
      expect(rows(store, run, "media_ingested")[0]!.payload.status).toBe("download_failed");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("a text turn is untouched: no ingest, no media row, modality text", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "plain text");
      const downloadFile = vi.fn(async () => ({ bytes: new Uint8Array(1) }));
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), mediaDeps({ downloadFile })).executeRun(run, "w")).status).toBe("completed");
      expect(downloadFile).not.toHaveBeenCalled();
      expect(rows(store, run, "media_ingested")).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
