import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { checkMeteredCeiling } from "../budget/metered-ceiling.js";
import { runEpisodicConsolidateTick } from "../capabilities/episodic-consolidate.js";
import { maybeRunEpisodicDistill } from "../capabilities/episodic-extract.js";
import { resolveWikiEnabled } from "../capabilities/wiki.js";
import { createLlmAnswerAdapter } from "../capabilities/llm-answer.js";
import { newestMtimeMs } from "../capabilities/self-write-merge.js";
import { maybeAskSessionRating } from "../capabilities/session-rating.js";
import { CoreWorker } from "../core/core-worker.js";
import { evolutionLaneSettled, evolutionLaneSnapshot } from "../core/evolution-lane.js";
import type { TelegramAllowlist } from "../domain/types.js";
import { Gateway } from "../gateway/gateway.js";
import { embedText, resolveEmbedConfig } from "../llm/embeddings.js";
import { LocalNotificationAdapter } from "../notifications/local-notification-adapter.js";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../notifications/notification-outbox.js";
import { TelegramNotificationAdapter } from "../notifications/telegram-notification-adapter.js";
import { resolveBackupEnabled, runDbBackupTick } from "../run/db-backup.js";
import type { RunStore } from "../run/run-store.js";
import { maybeFireScheduledTasks } from "../run/schedule-tick.js";
import { runInvariantSweep } from "../run/invariant-sweep.js";
import type { SecretBroker } from "../config/secret-broker.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import {
  createTelegramLongPollingAdapter,
  isSelfWriteActionEvent
} from "../triggers/telegram-trigger-adapter.js";
import { handleSelfWriteAction } from "./self-write-action-handler.js";
import { isHandledIntakeDenial, type TelegramPollClient } from "./telegram-poll-runner.js";

export const DEFAULT_LONGPOLL_TIMEOUT_SECONDS = 30;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;

export interface DaemonBackoff {
  baseMs: number;
  maxMs: number;
}

export interface RunTelegramDaemonOptions {
  store: RunStore;
  projectRoot: string;
  allowlist: TelegramAllowlist;
  telegramClient: TelegramPollClient;
  /** Abort to stop the loop AND cancel an idle long-poll for a prompt shutdown. */
  stopSignal: AbortSignal;
  /**
   * ADR 0018: threaded into the Gateway so `/kill` can stop the loop AFTER its ack is
   * enqueued (the in-loop outbox flush delivers it before exit). The CLI wires this to
   * the boot AbortController; absent in tests/one-shot contexts.
   */
  requestShutdown?: () => void;
  llmAdapter?: (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
  /** Secrets firewall broker (ADR 0015) — passed at boot when armed; else undefined (firewall OFF). */
  broker?: SecretBroker;
  longPollTimeoutSeconds?: number;
  backoff?: DaemonBackoff;
  /** Injectable for tests; default sleeps but resolves early if stopSignal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable clock for deterministic heartbeats in tests. */
  now?: () => string;
  /** Injectable for tests: current HEAD sha (reload-marker match, ⓪·2c U2). Default shells git. */
  resolveHead?: () => string;
  /**
   * Injectable for tests: whether the running dist/ looks STALE relative to src/ (newest
   * src .ts mtime > newest dist .js mtime). Real default probes the filesystem. Used by the
   * boot reload confirmation to warn instead of silently confirming a possibly-stale reload.
   */
  resolveDistStale?: () => boolean;
}

export interface RunTelegramDaemonResult {
  cycles: number;
  consecutive_failures: number;
}

/** Sleep that resolves early when the signal aborts (so shutdown isn't delayed). */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * The always-on daemon: a continuous long-poll loop that holds a Telegram
 * connection and answers commands in near-real-time. Resilient by construction —
 * the durable offset means a restart resumes (no message lost or double-consumed),
 * Telegram errors back off exponentially, and a heartbeat records liveness. Stops
 * cleanly when `stopSignal` aborts: an idle long-poll is cancelled immediately,
 * while a run already executing finishes (and its notification is flushed) before
 * the loop exits.
 */
export async function runTelegramDaemon(
  options: RunTelegramDaemonOptions
): Promise<RunTelegramDaemonResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? interruptibleSleep;
  const timeout_seconds = options.longPollTimeoutSeconds ?? DEFAULT_LONGPOLL_TIMEOUT_SECONDS;
  const baseMs = options.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxMs = options.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;

  const gateway = new Gateway(
    options.store,
    undefined,
    options.projectRoot,
    undefined,
    options.requestShutdown ? { requestShutdown: options.requestShutdown } : {}
  );
  const llmAdapter =
    options.llmAdapter ??
    createLlmAnswerAdapter({
      ...(options.broker ? { broker: options.broker } : {}),
      // Metered-$ ceiling (ADR 0019): a latched fuse drops the metered legs (cheap latch read).
      meteredBreached: () => options.store.meteredFuseLatched()
    });
  const worker = new CoreWorker(
    options.store,
    options.projectRoot,
    // Pass the RAW optional (undefined in prod), NOT the built `llmAdapter` above: CoreWorker
    // instruments its OWN default cheap-chain adapter per role (answer/classify/… usage →
    // recordLlmCall) only when none is injected. Handing it the pre-built adapter set
    // llmAdapterIsDefault=false and silently disabled all conversational telemetry. Tests still
    // inject options.llmAdapter and get it verbatim. The local `llmAdapter` above stays for the tick.
    options.llmAdapter,
    undefined,
    undefined,
    undefined,
    undefined,
    options.broker
  );
  const adapter = createTelegramLongPollingAdapter({
    allowlist: options.allowlist,
    client: options.telegramClient,
    timeout_seconds,
    offsetStore: {
      getOffset: (source) => options.store.getOffset(source),
      setOffset: (source, offset) => options.store.setOffset(source, offset)
    },
    skippedUpdateStore: {
      recordSkippedTelegramUpdate: (input) => options.store.recordSkippedTelegramUpdate(input)
    },
    // No-ghost reply for a text-less message: enqueue on the existing outbox; the
    // in-loop dispatch flush delivers it. Deterministic key → idempotent across restarts.
    acknowledgeSink: (ack) => {
      new NotificationOutbox(options.store).enqueue({
        target: { kind: "telegram", chat_id: ack.chat_id },
        intent_type: "progress",
        idempotency_key: ack.idempotency_key,
        correlation_id: ack.idempotency_key,
        payload: { text: ack.text }
      });
    }
  });
  const dispatcher = new NotificationDispatcher(new NotificationOutbox(options.store), {
    local: new LocalNotificationAdapter(),
    telegram: new TelegramNotificationAdapter(options.telegramClient)
  });

  // ⓪·2c U2: consume the reload marker (exactly once — consumption deletes it) and enqueue
  // the boot confirmation, then flush the outbox so it AND the pre-restart "merged, reloading…"
  // beacon arrive at boot instead of after the first long-poll times out.
  notifyReloadOnBoot(options);
  try {
    for (;;) {
      const result = await dispatcher.dispatchOnce("telegram-daemon-dispatcher");
      if (result.status === "idle") break;
    }
  } catch {
    // Best-effort boot flush — the poll loop re-dispatches queued notifications anyway.
  }

  let cycles = 0;
  let failures = 0;

  while (!options.stopSignal.aborted) {
    try {
      await adapter.pollOnce(async (event) => {
        if (isSelfWriteActionEvent(event)) {
          // M4: execute the authorized self-write action via the SHARED handler (identical to
          // the poll runner). Auth was enforced upstream (M2); this never re-derives it.
          await handleSelfWriteAction({
            event,
            telegramClient: options.telegramClient,
            projectRoot: options.projectRoot,
            store: options.store
          });
          return;
        }
        const intake = gateway.intake(event);
        if (!intake.ok) {
          if (isHandledIntakeDenial(intake.error.code)) return;
          throw new Error(`Gateway intake failed: ${intake.error.code} ${intake.error.message}`);
        }
        // Execute synchronously so a shutdown signal can't interrupt a run
        // mid-flight: the await completes the in-flight run before the loop exits.
        if (intake.status === "created") {
          await worker.executeRun(intake.run_id, "telegram-daemon-worker");
        }
        // ⓪·3 S2a: the async follow-up on a captured rating (the low-rating attribution
        // pass). A bare digit arrives as `rating_captured`; a digit+comment ran as the
        // turn above with the signal riding `rating_signal`. The capture itself (store,
        // ack) already happened in the gateway; a follow-up error never crashes the loop.
        const signal =
          intake.status === "rating_captured"
            ? { chat_id: intake.chat_id, rating: intake.rating, applied_lesson_ids: intake.applied_lesson_ids }
            : intake.status === "created" || intake.status === "duplicate"
              ? intake.rating_signal
              : undefined;
        if (signal) {
          try {
            await worker.processRatingSignal(signal);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[telegram-daemon] rating follow-up failed: ${message}`);
          }
        }
      }, { signal: options.stopSignal });

      const t = now();
      options.store.expirePendingApprovals(t);
      options.store.expireUndeliveredApprovalPrompts(t);
      // ⓪·3 S2: the signal path rides the poll loop (before the outbox flush, so a
      // rating ask enqueued this cycle is delivered this cycle). B10b threads the
      // gateway + worker in so the scheduler tick fires due tasks down the SAME path.
      await runSignalPathTick(options, llmAdapter, gateway, worker, t);
      for (;;) {
        const result = await dispatcher.dispatchOnce("telegram-daemon-dispatcher");
        if (result.status === "idle") break;
      }

      options.store.recordPollHeartbeat({ now: now(), ok: true });
      failures = 0;
      cycles += 1;
    } catch (err) {
      // A shutdown that cancels the in-flight long-poll surfaces as an abort —
      // that's a clean stop, not an error.
      if (options.stopSignal.aborted || isAbortError(err)) break;

      const message = err instanceof Error ? err.message : String(err);
      options.store.recordPollHeartbeat({ now: now(), ok: false, error: message });
      failures += 1;
      const delay = Math.min(maxMs, baseMs * 2 ** (failures - 1));
      await sleep(delay, options.stopSignal);
    }
  }

  // ⓪·3g: an evolution pipeline may still be running on the background lane — finish it
  // before exiting (mirroring the in-flight-run guarantee above; bounded by the lane's
  // own wall-clock cap), then flush its completion notification through the outbox.
  const lane = evolutionLaneSnapshot();
  if (lane.busy) {
    console.error(`[telegram-daemon] waiting for in-flight self-write (${lane.current?.tool ?? "unknown"})…`);
    await evolutionLaneSettled();
    try {
      for (;;) {
        const result = await dispatcher.dispatchOnce("telegram-daemon-dispatcher");
        if (result.status === "idle") break;
      }
    } catch {
      // Best-effort flush — the durable notification delivers on the next boot anyway.
    }
  }

  return { cycles, consecutive_failures: failures };
}

/**
 * ⓪·3 S2 — the signal path's per-cycle tick: the daily lesson decay+prune pass (the
 * store makes it idempotent per 24h), the daily wiki decay pass (W2 — flag-gated OFF,
 * same 24h idempotency), the session-rating ask trigger (substance +
 * lull + cooldown — cheap sqlite checks), the episodic fast-path distill (Phase M
 * B2 — flag-gated OFF by default, per-chat lull, at most one chat per tick), and the
 * scheduler fire tick (B10b — flag-gated OFF, capped fires, same gateway→worker path
 * as a message). NEVER throws (like notifyReloadOnBoot): a signal-path error must not
 * stop the daemon.
 */
async function runSignalPathTick(
  options: RunTelegramDaemonOptions,
  llmAdapter: (input: Record<string, unknown>) => Promise<ToolAdapterResult>,
  gateway: Gateway,
  worker: CoreWorker,
  now: string
): Promise<void> {
  try {
    options.store.runLessonDecayTick(now);
    // Phase W W2: the daily wiki decay+prune pass (the lesson tick's twin) — gated on
    // the wiki master flag (disarmed ⇒ zero behavior), idempotent per 24h via its
    // single-row wiki_decay_state latch.
    if (resolveWikiEnabled(process.env)) {
      options.store.runWikiDecayTick(now);
    }
    // Backlog #3 (ADR 0021): the periodic WAL-safe DB snapshot (VACUUM INTO) — flag-gated
    // OFF, interval-latched in the store, and internally fail-open (a failed snapshot
    // logs + records db_backup_failed without advancing the latch; never throws).
    if (resolveBackupEnabled(process.env)) {
      runDbBackupTick({ store: options.store, projectRoot: options.projectRoot, now });
    }
    const chat = options.allowlist.chats[0];
    if (chat) {
      maybeAskSessionRating({
        store: options.store,
        chatId: String(chat.telegram_chat_id),
        now
      });
    }
    // Phase M B2: the distill's LLM reads ride the same adapter processRatingSignal
    // uses (the unreserved chain — no run, no turn budget); embeddings are best-effort
    // local Ollama (null on any failure — the store degrades gracefully).
    const episodicLlm = async (input: { question: string; system: string }) => {
      const read = await llmAdapter({ question: input.question, system: input.system });
      return read.ok && typeof read.output.answer === "string"
        ? ({ ok: true, answer: read.output.answer } as const)
        : ({ ok: false } as const);
    };
    const episodicEmbed = (text: string) => embedText(text, resolveEmbedConfig(process.env));
    await maybeRunEpisodicDistill({
      store: options.store,
      llm: episodicLlm,
      embed: episodicEmbed,
      userName: options.allowlist.users[0]?.identity_id ?? "the user",
      now
    });
    // Phase M B4: the daily consolidate tick (decay → merge → promote) — same master
    // flag, idempotent per 24h via its single-row state marker, all steps bounded.
    await runEpisodicConsolidateTick({
      store: options.store,
      llm: episodicLlm,
      embed: episodicEmbed,
      now
    });
    // B10b: fire due schedules through the normal gateway→worker path (breaker,
    // contracts, and policy all apply). Flag-gated OFF; ≤3 fires per tick; the fired
    // run's final report is enqueued during executeRun, so the outbox flush right
    // after this tick delivers it the same cycle.
    await maybeFireScheduledTasks({ store: options.store, gateway, worker, now });
    // ADR 0019: the metered-$ ceiling check — drives the alert-dedupe latch (the chain
    // builder's cheap enforcement read) once per cycle; the 0→1 transition enqueues ONE
    // alert, delivered by the outbox flush right after this tick.
    checkMeteredCeiling({
      store: options.store,
      ...(chat ? { chatId: String(chat.telegram_chat_id) } : {}),
      now
    });
    // ADR 0024: the deterministic self-sensing sweep. Runs LAST among the state-changing
    // ticks so it observes this cycle's work, self-throttles to 5 min, and alerts at most
    // once per incident transition. Flag-gated OFF; pure reads + incident bookkeeping —
    // it can never act on what it finds.
    runInvariantSweep({
      store: options.store,
      ...(chat ? { chat_id: String(chat.telegram_chat_id) } : {}),
      now
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-daemon] signal-path tick failed: ${message}`);
  }
}

/**
 * Consume the self-write reload marker (⓪·2c U2, stage 1 of ADR 0012 D4) and enqueue the
 * boot confirmation `✅ 重启成功 — 现在运行 <shortSha>「<subject>」` through the durable outbox.
 * Exactly-once by construction: consumption deletes the marker, so the next restart stays
 * silent. A HEAD that no longer matches the marker (e.g. a reset after the merge) still
 * notifies, with a mismatch note. NEVER throws — a marker error must not stop the daemon.
 */
function notifyReloadOnBoot(options: RunTelegramDaemonOptions): void {
  try {
    const marker = options.store.consumeReloadMarker();
    if (!marker) return;
    const chat = options.allowlist.chats[0];
    if (!chat) return;

    let head = "";
    try {
      head = options.resolveHead
        ? options.resolveHead()
        : execFileSync("git", ["-C", options.projectRoot, "rev-parse", "HEAD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"]
          }).trim();
    } catch {
      // Unknown HEAD → skip the mismatch check, still confirm the reload.
    }

    const mismatch = head && head !== marker.sha ? "（当前 HEAD 与合并记录不一致）" : "";
    // Verified-artifact check (07-07): a confirmation that the reload happened is only honest
    // if the code we booted on is at least as new as the source — src newer than dist means
    // this process is running a stale build (e.g. a backend commit without a rebuild, or a
    // gate that never wrote the artifact). Warn loudly instead of silently confirming.
    let staleNote = "";
    try {
      const stale = options.resolveDistStale ? options.resolveDistStale() : distLooksStale(options.projectRoot);
      if (stale) staleNote = "\n⚠️ 运行中的代码可能是旧的（src 比 dist 新）— 请重新 build 并重启 daemon";
    } catch {
      // The staleness probe is best-effort; never block the confirmation on it.
    }
    new NotificationOutbox(options.store).enqueue({
      target: { kind: "telegram", chat_id: String(chat.telegram_chat_id) },
      intent_type: "final_report",
      idempotency_key: `selfwrite:reloaded:${marker.sha}:${marker.merged_at}`,
      correlation_id: `selfwrite:reload:${marker.sha}`,
      payload: { text: `✅ 重启成功 — 现在运行 ${marker.sha.slice(0, 7)}「${marker.subject}」${mismatch}${staleNote}` }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-daemon] reload-marker boot check failed: ${message}`);
  }
}

/**
 * Whether the running build looks stale: newest src/**.ts mtime strictly newer than newest
 * dist/**.js mtime (or dist absent while src exists). Conservative — equal/unknown → not stale.
 */
function distLooksStale(projectRoot: string): boolean {
  const srcNewest = newestMtimeMs(join(projectRoot, "src"), ".ts");
  if (srcNewest === undefined) return false; // no src to compare against — nothing to claim
  const distNewest = newestMtimeMs(join(projectRoot, "dist"), ".js");
  if (distNewest === undefined) return true; // src exists, no artifact at all
  return srcNewest > distNewest;
}
