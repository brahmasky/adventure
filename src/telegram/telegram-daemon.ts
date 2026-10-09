import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkMeteredCeiling } from "../budget/metered-ceiling.js";
import { runEpisodicConsolidateTick } from "../capabilities/episodic-consolidate.js";
import { maybeRunEpisodicDistill } from "../capabilities/episodic-extract.js";
import { runIdeaPanelTick } from "../capabilities/idea-panel.js";
import { buildOmpPanelSeats, type PanelSeatBindings } from "../capabilities/idea-panel-seats.js";
import { runIdeaRadarTick } from "../capabilities/idea-radar.js";
import { runLessonConsolidateTick } from "../capabilities/lesson-consolidate.js";
import { runSkillReverifyTick } from "../capabilities/skill-reverify.js";
import { resolveWikiEnabled } from "../capabilities/wiki.js";
import { reportOmpCheck, tickCorrelationId, tickSeat } from "../llm/registry.js";
import { newestMtimeMs } from "../capabilities/self-write-merge.js";
import { maybeAskSessionRating } from "../capabilities/session-rating.js";
import { CoreWorker, type OmpWorkerOptions } from "../core/core-worker.js";
import { resolveOmpConfig, warnRetiredOmpChainVars } from "../omp/omp-config.js";
import { runModelRolesTick } from "../omp/model-roles-tick.js";
import { createOmpProbeRunner, type OmpProbeRunner } from "../omp/omp-probe-runner.js";
import { sharedOmpVersionCache } from "../omp/omp-version-cache.js";
import { stableHash } from "../domain/canonical.js";
import type { RoleResolver } from "../omp/role-resolver.js";
import { errorCode } from "../domain/error-code.js";
import { evolutionLaneSettled, evolutionLaneSnapshot } from "../core/evolution-lane.js";
import type { TelegramAllowlist } from "../domain/types.js";
import { Gateway } from "../gateway/gateway.js";
import { embedText, resolveEmbedConfig } from "../llm/embeddings.js";
import { resolveMediaIngestEnabled } from "../media/media-config.js";
import { LocalNotificationAdapter } from "../notifications/local-notification-adapter.js";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../notifications/notification-outbox.js";
import { resolveBackupEnabled, runDbBackupTick } from "../run/db-backup.js";
import type { LlmCallRole, ReloadMarker, RunStore } from "../run/run-store.js";
import { maybeFireScheduledTasks } from "../run/schedule-tick.js";
import { SkillStore } from "../skills/skill-store.js";
import { runInvariantSweep, type InvariantSweepInput, type InvariantSweepResult } from "../run/invariant-sweep.js";
import { clearParkMarker, readParkMarker } from "../run/tombstone.js";
import { classifyBoot, hostBootedAt, readBootCode, type BootCode } from "../status/houge-status.js";
import type { SecretBroker } from "../config/secret-broker.js";
import { hardenedGitSync } from "../run/git-hardened.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import {
  createTelegramLongPollingAdapter,
  isSelfWriteActionEvent
} from "../triggers/telegram-trigger-adapter.js";
import { handleSelfWriteAction } from "./self-write-action-handler.js";
import { answerApprovalTap, isHandledIntakeDenial, ompOptionsWithOperator, workspaceTelegramAdapter, type TelegramPollClient } from "./telegram-poll-runner.js";

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
  /** Injectable for tests: HEAD sha/subject/commit time and the dist build time read at boot (default: git + stat). */
  resolveBootCode?: () => BootCode;
  /** Injectable for tests: when the host last booted (default: os uptime), to tell a kickstart from a host restart. */
  hostBootedAt?: () => string;
  /**
   * Injectable for tests ONLY: the radar tick's source fetch (Idea Radar R1). Prod never
   * sets it — the tick defaults to the real `fetchUrl` (SSRF floor + pinned request).
   */
  radarFetch?: Parameters<typeof runIdeaRadarTick>[0]["fetch"];
  /**
   * Injectable for tests ONLY: the panel's seat bindings (Idea Radar R2, ADR 0027). Prod
   * never sets it — the daemon builds PINNED single-provider judge adapters (kimi/gemini)
   * plus the contained codex/claude spawn seats via {@link buildPanelSeatBindings}.
   */
  panelSeats?: PanelSeatBindings;
  /** omp planner turns: the data dir (houge.sqlite's directory, default projectRoot) and dist dir. Tests use tmp dirs. */
  omp?: OmpWorkerOptions;
  /** How often detached turns' notifications (approval cards, replies) are flushed between polls (default 1 s). */
  outboxPumpMs?: number;
  /** How often expired planner leases are recovered (default half of HOUGE_OMP_LEASE_TTL_S; B1). Tests shorten it. */
  leaseRecoveryMs?: number;
  /** Injectable for tests ONLY: the contract probe runner (spec §5). Prod omits it and gets the real runner. */
  ompProbeRunner?: (d: Parameters<typeof createOmpProbeRunner>[0]) => Pick<OmpProbeRunner, "maybeProbe">;
}

export type { PanelSeatBindings } from "../capabilities/idea-panel-seats.js";

export interface RunTelegramDaemonResult {
  cycles: number;
  consecutive_failures: number;
}

/** Spec §3 Boot: one bounded version check, its incident as any check's, and the probe runner as the new-version listener. */
async function startOmpProbe(options: RunTelegramDaemonOptions, worker: CoreWorker): Promise<void> {
  try {
    const { cfg, ctx } = worker.ompProbeContext();
    const cache = sharedOmpVersionCache(cfg);
    const runner = (options.ompProbeRunner ?? createOmpProbeRunner)({ store: options.store, cfg, ctx, roles: worker.modelRoles(),
      currentVersion: () => cache.lastVersion(), signal: options.stopSignal });
    cache.setNewVersionListener((v) => runner.maybeProbe(v));
    reportOmpCheck(options.store, cfg, await cache.current());
  } catch (error) {
    console.error(`[telegram-daemon] omp probe start failed: ${errorCode(error)}`);
  }
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
  const startedAt = now(); // the boot time, recorded once (houge_status)
  const sleep = options.sleep ?? interruptibleSleep;
  const timeout_seconds = options.longPollTimeoutSeconds ?? DEFAULT_LONGPOLL_TIMEOUT_SECONDS;
  const baseMs = options.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxMs = options.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;

  const worker = new CoreWorker(
    options.store,
    options.projectRoot,
    // Pass the RAW optional (undefined in prod): CoreWorker builds its OWN run-scoped, audited
    // adapter per role (`llmAdapterFor`) only when none is injected. Handing it a pre-built
    // adapter would set llmAdapterIsDefault=false and silently disable all conversational
    // telemetry. Tests still inject options.llmAdapter and get it verbatim. The signal-path
    // ticks build their own per-tick adapters (`tickLlm`).
    options.llmAdapter,
    undefined,
    undefined,
    undefined,
    undefined,
    options.broker,
    undefined,
    undefined,
    undefined,
    // Multimodal ingest: the Telegram client is the only thing that can fetch a file. A client
    // without downloadFile (tests) yields no downloader, so every media turn fails loudly.
    options.telegramClient.downloadFile
      ? { downloadFile: options.telegramClient.downloadFile.bind(options.telegramClient) }
      : undefined,
    ompOptionsWithOperator(options.omp, options.allowlist)
  );
  // After the worker: the gateway's /models reads the worker's RoleResolver (one catalog cache per process).
  const gateway = new Gateway(
    options.store,
    undefined,
    options.projectRoot,
    undefined,
    options.requestShutdown ? { requestShutdown: options.requestShutdown } : {},
    { dataDir: options.omp?.dataDir ?? options.projectRoot, roles: worker.modelRoles() }
  );
  // Model roles (spec 2026-10-06 §4): one catalog read before the first turn, bounded by CATALOG_TIMEOUT_MS. A failed
  // read leaves one ledger note and the roles on their lists (Decision 4); the poll loop retries it hourly (F14).
  await worker.modelRoles().refreshCatalog();
  await startOmpProbe(options, worker);
  const recovery = bootPlanners(worker, options, now);
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
    mediaIngestEnabled: () => resolveMediaIngestEnabled(process.env),
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
    telegram: workspaceTelegramAdapter(options.telegramClient, options.omp?.dataDir ?? options.projectRoot)
  });
  // Turns run detached: their approval cards and replies land in the outbox between polls, so a
  // serialized flush runs on a short pump as well as after each poll cycle (a reply never waits
  // out a 30 s long-poll).
  // One sender: the boot flush, the pump, the poll loop and the exit flushes all go through it.
  // Once per poll cycle (not on the 1 s pump, so a failing send is retried per cycle, not per second) the sender
  // first abandons day-old retries and requeues the rest (live gate 2026-10-01: retry_wait rows were never resent).
  const flushOutbox = serialFlusher(dispatcher, () => { options.store.retryUndeliveredNotifications(now()); });
  const reportFlushFailure = throttledIncident(options.store, OUTBOX_INCIDENT_WINDOW_MS);
  const flushLogged = (opts?: { retry?: boolean }) =>
    flushOutbox(opts).catch((error: unknown) => reportFlushFailure("outbox_flush_failed", error));
  const pump = setInterval(() => void flushLogged(), options.outboxPumpMs ?? 1_000);
  pump.unref();

  // ⓪·2c U2: consume the reload marker (exactly once — consumption deletes it) and enqueue
  // the boot confirmation, then flush the outbox so it AND the pre-restart "merged, reloading…"
  // beacon arrive at boot instead of after the first long-poll times out.
  const marker = consumeReloadMarkerAtBoot(options.store);
  notifyReloadOnBoot(options, marker);
  const bootId = recordBoot(options, marker, startedAt);
  // the retry step first: a reply that went stale while the daemon was down is abandoned before this flush can send it
  await flushLogged({ retry: true }); // best-effort: the poll loop re-dispatches queued notifications anyway

  let cycles = 0;
  let failures = 0;
  let parkMarkerCleared = false;

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
        await answerApprovalTap(event, options.telegramClient);
        if (!intake.ok) {
          if (isHandledIntakeDenial(intake.error.code)) return;
          throw new Error(`Gateway intake failed: ${intake.error.code} ${intake.error.message}`);
        }
        // A turn is handed to its chat's planner supervisor and runs detached (a waiting turn
        // never blocks intake); anything else still executes inline so a shutdown cannot cut it.
        if (intake.status === "created" && !worker.submitTurn(intake.run_id)) {
          await worker.executeRun(intake.run_id, "telegram-daemon-worker");
        }
        onPlannerControl(intake.status, worker, options.store);
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
      // F14: a failed omp catalog read is retried hourly; the resolver owns the window and the incident. Never awaited.
      void worker.modelRoles().retryFailedRead();
      // ⓪·3 S2: the signal path rides the poll loop (before the outbox flush, so a
      // rating ask enqueued this cycle is delivered this cycle). B10b threads the
      // gateway + worker in so the scheduler tick fires due tasks down the SAME path.
      await runSignalPathTick(options, gateway, worker, t);
      await flushLogged({ retry: true }); // a failed drain is logged + incident'd, never a poll failure: the next flush retries

      options.store.recordPollHeartbeat({ now: now(), ok: true });
      // The daemon is demonstrably back: retire the park marker so the NEXT gap is reported as a
      // real one. Once per boot — the sweep has already had its chance to read it this cycle.
      if (!parkMarkerCleared) {
        parkMarkerCleared = true;
        try {
          clearParkMarker();
        } catch {
          /* best-effort; a stale marker only softens the next gap report */
        }
      }
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

  // Detached planner turns: stop every child (queued turns fail planner_exit, never left queued), then
  // flush whatever the stop produced.
  clearInterval(pump);
  clearInterval(recovery);
  await worker.shutdownPlanners();
  await flushLogged();

  // ⓪·3g: an evolution pipeline may still be running on the background lane — finish it
  // before exiting (mirroring the in-flight-run guarantee above; bounded by the lane's
  // own wall-clock cap), then flush its completion notification through the outbox.
  const lane = evolutionLaneSnapshot();
  if (lane.busy) {
    console.error(`[telegram-daemon] waiting for in-flight self-write (${lane.current?.tool ?? "unknown"})…`);
    await evolutionLaneSettled();
    await flushLogged(); // best-effort: the durable notification delivers on the next boot anyway
  }
  markCleanStop(options.store, bootId, now());

  return { cycles, consecutive_failures: failures };
}

export const OUTBOX_INCIDENT_WINDOW_MS = 10 * 60_000;

/** Half the planner lease TTL (a lease is recovered within 1.5 TTL of its last renewal); 60 s if the config cannot resolve. */
function leaseRecoveryIntervalMs(): number {
  try { return resolveOmpConfig(process.env).leaseTtlS * 500; } catch { return 60_000; }
}

/**
 * Boot-time planner checks, before the first poll: a malformed omp config pages Paco (B4) and a still-set retired
 * chain variable is named once; what a crash
 * stranded is failed now, its replies riding the boot flush (B1). Expired planner leases are then recovered on a timer
 * of at most half the lease TTL, independent of the poll loop (an inline run can block it). The caller clears it.
 */
function bootPlanners(worker: CoreWorker, options: RunTelegramDaemonOptions, now: () => string): ReturnType<typeof setInterval> {
  warnRetiredOmpChainVars(process.env);
  worker.validateOmpConfig();
  worker.checkDaemonTmp(); // N1: a temp root inside a git repo pages and disables voice ingest
  recoverPlannerRuns(worker, now(), true);
  const timer = setInterval(() => recoverPlannerRuns(worker, now(), false), options.leaseRecoveryMs ?? leaseRecoveryIntervalMs());
  timer.unref();
  return timer;
}

/** B1: boot fails the turns still queued from a dead process, and every tick fails expired planner leases. Never throws. */
function recoverPlannerRuns(worker: CoreWorker, now: string, boot: boolean): void {
  try {
    const stranded = boot ? worker.failStrandedTurns(now) : 0;
    const expired = worker.recoverPlannerLeases(now);
    if (stranded + expired > 0) console.error(`[telegram-daemon] planner recovery: ${stranded} stranded, ${expired} expired`);
  } catch (error) {
    console.error(`[telegram-daemon] planner recovery failed: ${errorCode(error)}`);
  }
}

/**
 * One dispatcher drain at a time: the pump and the poll loop share it, never overlap. A drain that
 * throws rejects only its own caller; the chain itself stays alive, so the next flush still sends.
 */
export function serialFlusher(
  dispatcher: Pick<NotificationDispatcher, "dispatchOnce">,
  retry?: () => void
): (opts?: { retry?: boolean }) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  const drain = async (withRetry: boolean) => {
    // The retry step runs INSIDE the chain: no send of this sender is in flight, so a `sending` row it recovers is
    // truly orphaned (a crash mid-send), never one being sent right now.
    if (withRetry) retry?.();
    for (;;) {
      const result = await dispatcher.dispatchOnce("telegram-daemon-dispatcher");
      if (result.status === "idle") break;
    }
  };
  return (opts = {}) => {
    const run = chain.then(() => drain(opts.retry === true));
    chain = run.catch(() => undefined);
    return run;
  };
}

/**
 * A persistent failure (the pump retries every second) is reported, log line and incident together,
 * only when its code changes or once per window per code — never a line a second.
 */
export function throttledIncident(store: Pick<RunStore, "openIncident">, windowMs: number, now: () => number = Date.now):
  (kind: string, error: unknown) => void {
  const last = new Map<string, { code: string; at: number }>();
  return (kind, error) => {
    const code = errorCode(error);
    const t = now();
    const prev = last.get(kind);
    if (prev && prev.code === code && t - prev.at < windowMs) return;
    last.set(kind, { code, at: t });
    console.error(`[telegram-daemon] ${kind}: ${code}`);
    try { store.openIncident({ kind, subject: "daemon", detail: { code } }); } catch { /* the store itself may be the failure */ }
  };
}

/**
 * `/kill` stops every live planner turn without blocking the poll loop (the tombstone is already
 * written, the ack queued); `/rearm` clears the planners' crash-loop latch (spec §7).
 */
function onPlannerControl(status: string, worker: CoreWorker, store: RunStore): void {
  if (status === "rearmed") {
    for (const s of worker.plannerSupervisors()) s.resetCrashGuard();
    return;
  }
  if (status !== "killed") return;
  void Promise.allSettled(worker.plannerSupervisors().map((s) => s.abortAll("killed"))).then((results) => {
    for (const r of results) {
      if (r.status === "fulfilled") continue;
      const code = errorCode(r.reason);
      console.error(`[telegram-daemon] /kill could not abort a planner: ${code}`);
      store.openIncident({ kind: "planner_kill_failed", subject: "daemon", detail: { code } });
    }
  });
}

/**
 * ⓪·3 S2 — the signal path's per-cycle tick: the daily lesson decay+prune pass (the
 * store makes it idempotent per 24h), the daily wiki decay pass (W2 — flag-gated OFF,
 * same 24h idempotency), the session-rating ask trigger (substance +
 * lull + cooldown — cheap sqlite checks), the model-backed ticks ({@link runModelTicks}),
 * the metered-$ ceiling check and the invariant sweep. NEVER throws (like
 * notifyReloadOnBoot): a signal-path error must not stop the daemon.
 */
async function runSignalPathTick(
  options: RunTelegramDaemonOptions,
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
    const chatId = chat ? String(chat.telegram_chat_id) : null;
    if (chatId) maybeAskSessionRating({ store: options.store, chatId, now });
    await runModelTicks(options, gateway, worker, now, chatId);
    // ADR 0019: the metered-$ ceiling check — drives the alert-dedupe latch (the chain
    // builder's cheap enforcement read) once per cycle; the 0→1 transition enqueues ONE
    // alert, delivered by the outbox flush right after this tick.
    checkMeteredCeiling({ store: options.store, ...(chatId ? { chatId } : {}), now });
    // ADR 0024: the deterministic self-sensing sweep. Runs LAST among the state-changing
    // ticks so it observes this cycle's work, self-throttles to 5 min, and alerts at most
    // once per incident transition. Flag-gated OFF; pure reads + incident bookkeeping —
    // it can never act on what it finds.
    sweepAndRearm(invariantSweepInput(options, now), worker);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-daemon] signal-path tick failed: ${message}`);
  }
}

/** A tick's model seat: `{question, system}` in, `{ok, answer}` out. */
type TickLlm = (input: { question: string; system: string }) => Promise<{ ok: true; answer: string } | { ok: false }>;

/**
 * Slice 2 (review B2): ONE seat per tick, each with its own run-less audit scope, so every
 * omp leg a tick tries lands in the ledger under `tick:<name>:<uuid>` (spec §8: one-shot seats). The
 * role picks the chain (`seatChain`: memory ticks on the Tiny role) from the worker's RoleResolver, read per call.
 * A test-injected `options.llmAdapter` is used verbatim (it brings its own fakes, no omp). The daemon's stop
 * aborts the in-flight omp call, and every later call fails at once without spawning.
 */
function tickLlm(options: RunTelegramDaemonOptions, name: string, role: LlmCallRole, roles: Pick<RoleResolver, "chains">): TickLlm {
  const injected = options.llmAdapter;
  const stop = options.stopSignal;
  return async (input) => {
    if (stop.aborted) return { ok: false };
    if (injected) {
      const read = await injected({ question: input.question, system: input.system });
      return read.ok && typeof read.output.answer === "string" ? { ok: true, answer: read.output.answer } : { ok: false };
    }
    return tickSeat(options.store, name, role, process.env, () => roles.chains())({ ...input, signal: stop });
  };
}

/**
 * The ticks that call a model, in order. Each takes the daemon's stop signal and returns early
 * once it aborts, checking between model calls and never committing half a unit of work (live
 * 2026-10-02: the loop awaited a 7–13 s/call distill through a kickstart and launchd's 40 s
 * ExitTimeOut SIGKILLed the daemon). Each is flag-gated and never throws into the daemon.
 */
async function runModelTicks(
  options: RunTelegramDaemonOptions, gateway: Gateway, worker: CoreWorker, now: string, chatId: string | null
): Promise<void> {
  const signal = options.stopSignal;
  // First: the memory and council ticks below then resolve their seats against today's catalog.
  await runRolesTick(options, worker, now, chatId, signal);
  if (signal.aborted) return;
  await runMemoryTicks(options, now, signal, worker.modelRoles());
  if (signal.aborted) return;
  await runIdeaTicks(options, now, chatId, signal, worker.modelRoles());
  if (signal.aborted) return;
  // B10b: fire due schedules through the normal gateway→worker path (breaker,
  // contracts, and policy all apply). Flag-gated OFF; ≤3 fires per tick; the fired
  // run's final report is enqueued during executeRun, so the outbox flush right
  // after this tick delivers it the same cycle.
  await maybeFireScheduledTasks({ store: options.store, gateway, worker, now, signal });
}

/**
 * The daily model-roles tick (spec §4.1): change notices go to the operator chat (the rating ask's chat), through the outbox
 * and the rich renderer; `role_unresolved` pages through openAlertedIncident. Its own catch: a failed tick never skips the
 * memory, idea and schedule ticks after it.
 */
async function runRolesTick(
  options: RunTelegramDaemonOptions, worker: CoreWorker, now: string, chatId: string | null, signal: AbortSignal
): Promise<void> {
  const notify = (text: string): void => {
    if (!chatId) return;
    options.store.enqueueNotification({
      target: { kind: "telegram", chat_id: chatId }, intent_type: "progress",
      idempotency_key: `model_roles:notice:${now}:${stableHash(text)}`, correlation_id: "model-roles", payload: { text }
    });
  };
  try {
    await runModelRolesTick({ store: options.store, roles: worker.modelRoles(), now, signal, notify });
  } catch (error) {
    console.error(`[telegram-daemon] model roles tick failed: ${errorCode(error)}`);
  }
}

/**
 * Episodic distill (Phase M B2: per-chat lull, at most one chat per tick), the daily episodic
 * consolidate (B4: decay → merge → promote), and the preserve-all lesson-merge tick (2026-07-23).
 * Embeddings stay best-effort local Ollama (null on any failure — the store degrades).
 */
async function runMemoryTicks(options: RunTelegramDaemonOptions, now: string, signal: AbortSignal, roles: Pick<RoleResolver, "chains">): Promise<void> {
  const embed = (text: string) => embedText(text, resolveEmbedConfig(process.env));
  await maybeRunEpisodicDistill({
    store: options.store, llm: tickLlm(options, "episodic_distill", "distill", roles), embed,
    userName: options.allowlist.users[0]?.identity_id ?? "the user", now, signal
  });
  if (signal.aborted) return;
  await runEpisodicConsolidateTick({ store: options.store, llm: tickLlm(options, "episodic_consolidate", "consolidate", roles), embed, now, signal });
  if (signal.aborted) return;
  await runLessonConsolidateTick({
    store: options.store, llmAnswer: tickLlm(options, "lesson_consolidate", "consolidate", roles), env: process.env, now, signal
  });
}

/**
 * Idea Radar R1 (daily sensing: fetch + ONE extract call), the R2 weekly panel (ADR 0027: seats
 * pinned per provider, NEVER a chain — a healthy-leg fallback would void the quorum), and the
 * weekly suggest-only skill re-verify. Each stamps its latch before its first model call.
 */
async function runIdeaTicks(options: RunTelegramDaemonOptions, now: string, chatId: string | null, signal: AbortSignal, roles: Pick<RoleResolver, "chains">): Promise<void> {
  await runIdeaRadarTick({
    store: options.store, llmAnswer: tickLlm(options, "idea_radar", "extract", roles),
    ...(options.radarFetch ? { fetch: options.radarFetch } : {}), env: process.env, now, signal
  });
  if (signal.aborted) return;
  await runIdeaPanelTick({
    store: options.store, ...(options.panelSeats ?? buildPanelSeatBindings(options, roles)),
    env: process.env, now, chatId, projectRoot: options.projectRoot, signal
  });
  if (signal.aborted) return;
  const reverifyLlm = tickLlm(options, "skill_reverify", "verify", roles);
  await runSkillReverifyTick({
    store: options.store,
    skills: new SkillStore({ root: join(options.projectRoot, "skills") }),
    anchorLlm: async (system, question) => {
      const read = await reverifyLlm({ question, system });
      return read.ok ? read.answer : undefined;
    },
    env: process.env, now, chatId, signal
  });
}

/**
 * The sweep's input: the operator chat, and the DATA volume for disk_free_low — houge.sqlite's
 * directory (the omp data dir), falling back to the project root when none is configured.
 */
export function invariantSweepInput(
  options: Pick<RunTelegramDaemonOptions, "store" | "omp" | "projectRoot" | "allowlist">, now: string
): InvariantSweepInput {
  const chat = options.allowlist.chats[0];
  return { store: options.store, dataDir: options.omp?.dataDir ?? options.projectRoot, ...(chat ? { chat_id: String(chat.telegram_chat_id) } : {}), now };
}

/**
 * One sweep; when it actually ran (not throttled, not disarmed) every planner's crash latch is cleared, so a
 * latched chat stays down only "until the next sweep or /rearm" (spec §7, B3). A still-broken child re-latches.
 */
export function sweepAndRearm(input: InvariantSweepInput, worker: { plannerSupervisors(): Array<{ resetCrashGuard(): void }> }): InvariantSweepResult {
  const result = runInvariantSweep(input);
  if (result.swept) for (const s of worker.plannerSupervisors()) s.resetCrashGuard();
  return result;
}

/** The panel's real seats: the omp judge/chair seats (idea-panel-seats) on the roles' chains, audited under one `tick:idea_panel:<uuid>` per panel run. */
function buildPanelSeatBindings(options: RunTelegramDaemonOptions, roles: Pick<RoleResolver, "chains">): PanelSeatBindings {
  return buildOmpPanelSeats({ store: options.store, correlation_id: tickCorrelationId("idea_panel"), env: process.env, chains: roles.chains(), signal: options.stopSignal });
}

/**
 * Given the self-write reload marker consumed at boot (⓪·2c U2, stage 1 of ADR 0012 D4), enqueue the
 * boot confirmation `✅ 重启成功 — 现在运行 <shortSha>「<subject>」` through the durable outbox.
 * Exactly-once by construction: consumption deletes the marker, so the next restart stays
 * silent. A HEAD that no longer matches the marker (e.g. a reset after the merge) still
 * notifies, with a mismatch note. NEVER throws — a marker error must not stop the daemon.
 */
function notifyReloadOnBoot(options: RunTelegramDaemonOptions, marker: ReloadMarker | null): void {
  try {
    if (!marker) return;
    const chat = options.allowlist.chats[0];
    if (!chat) return;

    let head = "";
    try {
      head = options.resolveHead
        ? options.resolveHead()
        : hardenedGitSync(["-C", options.projectRoot, "rev-parse", "HEAD"]).trim();
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

/** Consume the reload marker once at boot: the confirmation and the boot record both read it. NEVER throws. */
function consumeReloadMarkerAtBoot(store: RunStore): ReloadMarker | null {
  try {
    return store.consumeReloadMarker();
  } catch (error) {
    console.error(`[telegram-daemon] reload-marker boot check failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Record this boot (houge_status, 2026-10-02): when, why and which code. The reason comes only from
 * what the daemon knows here: the consumed reload marker, the park marker (cleared after the first
 * good cycle, so read before it), and whether the previous boot recorded a clean stop. NEVER throws.
 */
function recordBoot(options: RunTelegramDaemonOptions, marker: ReloadMarker | null, startedAt: string): string | null {
  try {
    const reason = classifyBoot({
      marker: marker !== null, parked: readParkMarker() !== null, previous: options.store.getLatestDaemonBoot(),
      hostBootedAt: options.hostBootedAt ? options.hostBootedAt() : hostBootedAt()
    });
    const code = options.resolveBootCode
      ? options.resolveBootCode()
      : readBootCode(options.projectRoot, options.omp?.distDir ?? join(options.projectRoot, "dist"));
    const boot_id = `boot_${randomUUID()}`;
    options.store.recordDaemonBoot({
      boot_id, started_at: startedAt, pid: process.pid, reason, reload_sha: marker?.sha ?? null, reload_subject: marker?.subject ?? null,
      reload_branch: marker?.branch ?? null, reload_merged_at: marker?.merged_at ?? null, ...code
    });
    return boot_id;
  } catch (error) {
    console.error(`[telegram-daemon] boot record failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The loop exited cleanly: the next boot reads this to tell a restart from a crash. NEVER throws. */
function markCleanStop(store: RunStore, bootId: string | null, at: string): void {
  if (!bootId) return;
  try {
    store.markDaemonBootStopped(bootId, at);
  } catch (error) {
    console.error(`[telegram-daemon] clean-stop record failed: ${error instanceof Error ? error.message : String(error)}`);
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
