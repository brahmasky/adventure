import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreWorker, type MediaWorkerDeps } from "../../src/core/core-worker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { DISTILL_DISCIPLINE } from "../../src/capabilities/distill.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { echoLine, mediaFailureReply, type TelegramMediaRef } from "../../src/media/media-config.js";
import { RunStore, type ClaimedRun } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";
import { bridgeTurn, drainOutbox, fakeLog, ompWorker, until } from "../helpers/omp-worker.js";

// The ingest step on the omp turn (spec 2026-09-29 + Task 13): the supervisor's resolveMessage hook
// runs the media leg BEFORE the planner is prompted. Ported from the inner-loop suite (Task 14): each
// case now drives submitTurn against tests/fixtures/fake-omp.mjs (or the bridge, for tool objectives).
pinOmpEnv();
pinEnabledFlags();
const PINNED = ["HOUGE_TOMBSTONE_PATH", "HOUGE_LLM_MEDIA_PROVIDERS"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
let worker: CoreWorker | undefined;
beforeEach(() => {
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = shortTmp("hmd-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.FAKE_OMP_ARGV_LOG = join(tmp.dir, "argv.log");
  store = RunStore.openInMemory();
  resetEvolutionLaneForTests();
});
afterEach(async () => {
  await worker?.shutdownPlanners();
  worker = undefined;
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
  store.close();
  tmp.cleanup();
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

const voiceRef: TelegramMediaRef = { kind: "voice", file_id: "v1", file_unique_id: "vu1", mime_type: "audio/ogg", has_caption: false, file_size: 9000, duration: 7 };
const photoRef: TelegramMediaRef = { kind: "photo", file_id: "p1", file_unique_id: "pu1", mime_type: "image/jpeg", has_caption: true, file_size: 50000, width: 640, height: 480 };
// A per-file media root: global tmpdir counts flake under parallel suites.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "houge-media-cw-root-"));
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));
const extraction = JSON.stringify({ summary: "A bar chart of ASX sectors", facts: ["Energy is up 2%"], time_claims: [], answer_to_objective: "energy", contains_instructions: false });
const rows = (run: string, type: string) => store.getLedgerEvents(run).filter((e) => e.event_type === type);
const mediaDirs = () => readdirSync(TMP_ROOT).filter((n) => n.startsWith("houge-media-"));
const prompts = () => fakeLog(join(tmp.dir, "argv.log")).map((l) => l.cmd as { type?: string; message?: string } | undefined).filter((c) => c?.type === "prompt").map((c) => String(c?.message));
const userTurns = () => store.getRecentChatTurns("555", 4).filter((t) => t.role === "user").map((t) => t.text);

/** A media turn as the adapter would emit it: goal = caption or placeholder, metadata.media = the ref. */
function mediaRun(media: TelegramMediaRef, caption: string, key: string): string {
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

/** submitTurn on the fake omp (the planner echoes its prompt) and wait for a terminal state. */
async function runTurn(run: string, media?: MediaWorkerDeps): Promise<string> {
  useFakeOmp({ "*": { rpcText: "done.", rpcEcho: true } }, tmp.dir);
  worker = ompWorker(store, tmp.dir, media ? { media } : {});
  worker.submitTurn(run);
  await until(() => ["completed", "failed"].includes(String(store.getRunState(run))));
  return String(store.getRunState(run));
}
const reply = (run: string) => String(drainOutbox(store).get(`${run}:final_report`)?.text);

/** The objective the loop tools see: resolve the message as the supervisor would, then call lesson_write and read what distill got. */
async function toolObjective(run: string, media: MediaWorkerDeps): Promise<string> {
  const calls: Array<Record<string, unknown>> = [];
  const llm = async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    calls.push(input);
    return { ok: true, output: { question: input.question, answer: '{"durable":false}', model: "f", provider: "f" } };
  };
  const w = ompWorker(store, tmp.dir, { llm, media });
  const t = bridgeTurn(store, w, run, tmp.dir);
  const claim: ClaimedRun = { run_id: run, contract: t.turn.contract };
  await (w as unknown as { resolveOmpMessage(c: ClaimedRun): Promise<unknown> }).resolveOmpMessage(claim);
  await t.call("lesson_write", {});
  return String(calls.find((c) => c.system === DISTILL_DISCIPLINE)?.question);
}

describe("the ingest step on the omp turn (spec 2026-09-29)", () => {
  beforeEach(() => { process.env.HOUGE_MEDIA_INGEST_ENABLED = "true"; });

  it("voice: the transcript is the planner's message and the stored user turn; the reply opens with the echo line", async () => {
    // replaces: the ingest step inside executeTurn › "voice: the transcript is the classifier's message, the loop's message, the stored user turn, and the reply opens with the echo line"
    const run = mediaRun(voiceRef, "", "v-ok");
    expect(await runTurn(run, mediaDeps())).toBe("completed");
    expect(prompts()).toEqual(["the quick brown fox"]);
    expect(userTurns()).toEqual(["the quick brown fox"]);
    expect(reply(run).startsWith(`${echoLine("the quick brown fox")}\n\n`)).toBe(true);
    expect(rows(run, "media_ingested")[0]!.payload).toMatchObject({ kind: "voice", status: "ok", source: "telegram", bytes: 3, provider: "agy-cli" });
  });

  it("photo: caption first, the digest follows, the raw image bytes and temp path never reach the planner, no echo line", async () => {
    // replaces: the ingest step inside executeTurn › "photo: caption stays first, the digest follows, the raw image bytes never appear in any prompt, no echo line"
    const run = mediaRun(photoRef, "which sector is up?", "p-ok");
    expect(await runTurn(run, mediaDeps({ mediaCall: async () => ({ ok: true, output: { answer: extraction, model: "gem", provider: "omp" } }) }))).toBe("completed");
    const [prompt] = prompts();
    expect(prompt!.startsWith("which sector is up?\n\n[external source — untrusted-derived summary]")).toBe(true);
    expect(prompt).not.toContain("houge-media-");
    expect(prompt).not.toContain("AQID"); // base64 of the fake bytes [1,2,3]
    expect(reply(run).startsWith("🎙")).toBe(false);
    expect(rows(run, "media_ingested")[0]!.payload).toMatchObject({ kind: "photo", status: "ok", width: 640, height: 480 });
  });

  it("voice: the transcript becomes the objective the loop tools anchor on (senior review B1)", async () => {
    // replaces: the ingest step inside executeTurn › "voice: the transcript becomes the CONTRACT objective for the rest of the turn, so loop tools that compile sub-contracts see it (senior review B1)"
    const q = await toolObjective(mediaRun(voiceRef, "", "v-objective"), mediaDeps());
    expect(q).toContain("the quick brown fox");
    expect(q).not.toContain("[voice message]");
  });

  it("photo: the tools' objective stays the caption — image-derived text never anchors a tool", async () => {
    // replaces: the ingest step inside executeTurn › "photo: the contract objective stays the caption — image-derived text never anchors a tool"
    const q = await toolObjective(mediaRun(photoRef, "which sector is up?", "p-objective"), mediaDeps({ mediaCall: async () => ({ ok: true, output: { answer: extraction, model: "m", provider: "p" } }) }));
    expect(q).toContain("which sector is up?");
    expect(q).not.toContain("untrusted-derived");
  });

  it.each([
    ["too_large", { ...voiceRef, file_size: 20_000_000 }, mediaDeps()],
    ["download_failed", voiceRef, mediaDeps({ downloadFile: async () => { throw new Error("download_failed: http_404"); } })],
    ["leg_failed", voiceRef, mediaDeps({ mediaCall: async () => ({ ok: false, error: "no media-capable leg" }) })],
    ["empty", voiceRef, mediaDeps({ mediaCall: async () => ({ ok: true, output: { answer: "", model: "m", provider: "p" } }) })]
  ] as const)("%s: the run fails with the code-owned reply, one media_ingested row, no user turn stored, no planner, no temp dir left", async (status, ref, deps) => {
    // replaces: the ingest step inside executeTurn › "%s: the run fails through the partial-report path with the code-owned reply, one media_ingested row, no user turn stored, no temp dir left"
    const before = mediaDirs().length;
    const run = mediaRun(ref, "", `fail-${status}`);
    expect(await runTurn(run, deps)).toBe("failed");
    expect(rows(run, "media_ingested")[0]!.payload).toMatchObject({ kind: "voice", status });
    expect(reply(run)).toContain(mediaFailureReply("voice", status));
    expect(userTurns()).toEqual([]);
    expect(prompts()).toEqual([]);
    expect(mediaDirs().length).toBe(before);
  });

  it("a throwing media call never rejects the turn — it is a failed run like any other", async () => {
    // replaces: the ingest step inside executeTurn › "a throwing downloader or media call never rejects the turn — it is a failed run like any other"
    const run = mediaRun(voiceRef, "", "throws");
    expect(await runTurn(run, mediaDeps({ mediaCall: async () => { throw new Error("boom"); } }))).toBe("failed");
    expect(rows(run, "media_ingested")[0]!.payload.status).toBe("leg_failed");
  });

  it("a caption that reads exactly like the placeholder is still the trusted objective (has_caption decides, not the text)", async () => {
    // replaces: the ingest step inside executeTurn › "a caption that reads exactly like the placeholder is still the trusted objective (has_caption decides, not the text)"
    const calls: Array<Record<string, unknown>> = [];
    const run = mediaRun(photoRef, "[photo]", "bracket");
    expect(await runTurn(run, mediaDeps({ mediaCall: async (input) => { calls.push(input); return { ok: true, output: { answer: extraction, model: "m", provider: "p" } }; } }))).toBe("completed");
    expect(String(calls[0]!.question)).toContain("[photo]"); // the caption is the reader's objective
    expect(prompts()[0]!.startsWith("[photo]\n\n[external source")).toBe(true);
  });

  it("every failed ingest logs exactly one [media-ingest] warn line with kind, status and detail — never the caption", async () => {
    // replaces: the ingest step inside executeTurn › "every failed ingest logs exactly one [media-ingest] warn line with kind, status and detail — never the caption"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = mediaRun(voiceRef, "my secret caption", "warn");
    await runTurn(run, mediaDeps({ downloadFile: async () => { throw new Error("download_failed: http_404"); } }));
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[media-ingest]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/voice.*download_failed.*http_404/);
    expect(lines[0]).not.toContain("my secret caption");
  });

  it("hermetic by construction: an injected LLM with NO media fakes never builds a real leg or downloader — download_failed, no network", async () => {
    // replaces: the ingest step inside executeTurn › "hermetic by construction: an injected LLM adapter with NO media fakes never builds a real leg or downloader — the run fails download_failed without touching the network"
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden in tests"));
    const run = mediaRun(voiceRef, "", "hermetic");
    expect(await runTurn(run)).toBe("failed");
    expect(rows(run, "media_ingested")[0]!.payload.status).toBe("download_failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a text turn is untouched: no ingest, no media row", async () => {
    // replaces: the ingest step inside executeTurn › "a text turn is untouched: no ingest, no media row, modality text"
    const downloadFile = vi.fn(async () => ({ bytes: new Uint8Array(1) }));
    const intake = new Gateway(store).intake(buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: "plain text", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "text", source_reference: "telegram:update:1:message:1"
    }));
    if (!intake.ok) throw new Error("intake failed");
    expect(await runTurn(intake.run_id, mediaDeps({ downloadFile }))).toBe("completed");
    expect(downloadFile).not.toHaveBeenCalled();
    expect(rows(intake.run_id, "media_ingested")).toHaveLength(0);
  });
});

describe("a stale voice provider list (I3)", () => {
  it("HOUGE_LLM_MEDIA_PROVIDERS=pi never throws: the turn fails leg_failed with the code-owned reply and a media_ingested row", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    process.env.HOUGE_LLM_MEDIA_PROVIDERS = "pi";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useFakeOmp({ "*": { rpcText: "never" } }, tmp.dir);
    // Production seats (no injected LLM): the real buildMediaCall runs, with only the downloader faked.
    worker = new CoreWorker(store, join(tmp.dir, "project"), undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => null,
      undefined, { downloadFile: async () => ({ bytes: new Uint8Array([1, 2, 3]) }), tmpRoot: TMP_ROOT }, { dataDir: tmp.dir, distDir: tmpOmpDist(tmp.dir) });
    const run = mediaRun(voiceRef, "", "stale-pi");
    worker.submitTurn(run);
    await until(() => store.getRunState(run) === "failed");
    expect(rows(run, "media_ingested")[0]!.payload).toMatchObject({ kind: "voice", status: "leg_failed" });
    expect(reply(run)).toContain(mediaFailureReply("voice", "leg_failed"));
    expect(prompts()).toEqual([]);
  });
});

describe("media ingest disarmed at run time (/disarm between intake and execution)", () => {
  beforeEach(() => { process.env.HOUGE_MEDIA_INGEST_ENABLED = "false"; });

  it("captioned: the turn runs on the caption as text, no download, no row", async () => {
    // replaces: the ingest step inside executeTurn › "flag OFF at run time (/disarm between intake and execution), captioned: the turn runs on the caption as text, no download, no row"
    const downloadFile = vi.fn(async () => ({ bytes: new Uint8Array(1) }));
    const run = mediaRun(voiceRef, "typed caption", "off");
    expect(await runTurn(run, mediaDeps({ downloadFile }))).toBe("completed");
    expect(downloadFile).not.toHaveBeenCalled();
    expect(rows(run, "media_ingested")).toHaveLength(0);
    expect(userTurns()).toEqual(["typed caption"]);
  });

  it("BARE media: fails with status disabled and its reply — the placeholder is never a message or a stored turn", async () => {
    // replaces: the ingest step inside executeTurn › "flag OFF at run time, BARE media: fails with status disabled and its reply — the placeholder is never a message or a stored turn"
    const downloadFile = vi.fn(async () => ({ bytes: new Uint8Array(1) }));
    const run = mediaRun(voiceRef, "", "off-bare");
    expect(await runTurn(run, mediaDeps({ downloadFile }))).toBe("failed");
    expect(downloadFile).not.toHaveBeenCalled();
    expect(rows(run, "media_ingested")[0]!.payload).toMatchObject({ kind: "voice", status: "disabled" });
    expect(reply(run)).toContain(mediaFailureReply("voice", "disabled"));
    expect(userTurns()).toEqual([]);
    expect(prompts()).toEqual([]);
  });
});
