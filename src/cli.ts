#!/usr/bin/env node

import { loadHougeEnv } from "./config/load-env.js";
import {
  createSecretBroker,
  resolveSecretsFirewallEnabled,
  stripSecretsFromEnv
} from "./config/secret-broker.js";
import { CoreWorker } from "./core/core-worker.js";
import { Gateway } from "./gateway/gateway.js";
import { runEvalSuite } from "./eval/eval-runner.js";
import { getHougeVersion } from "./index.js";
import { RunStore } from "./run/run-store.js";
import {
  formatTombstoneParkedMessage,
  readTombstone,
  writeParkMarker,
  resolveTombstonePath
} from "./run/tombstone.js";
import { parseCliTrigger } from "./triggers/cli-trigger.js";

// Load `.env` (cwd or $HOUGE_ENV_FILE) before any command reads configuration.
// Real environment variables take precedence over the file.
loadHougeEnv();

// Secrets firewall (ADR 0015): when armed, lift the five secrets into the broker, then STRIP them
// (and any credential-shaped var) from process.env — so downstream code holds no ambient credential.
// Default OFF → no broker, no strip, behavior byte-identical to before the firewall existed.
const broker = resolveSecretsFirewallEnabled(process.env)
  ? createSecretBroker(process.env)
  : undefined;
if (broker) stripSecretsFromEnv(process.env);
// The store redactor masks secret VALUES at every write seam; omitted (no-op) when the firewall is OFF.
const storeOptions = broker ? { redact: broker.redact } : {};
const brokerOption = broker ? { broker } : {};

const [, , command, ...rest] = process.argv;

if (!command || command === "--version" || command === "version") {
  console.log(getHougeVersion());
  process.exit(0);
}

if (command === "run") {
  // Kill-switch boot gate (ADR 0018): a tombstone refuses run execution. Interactive
  // invocation → clear message + exit 1 (only the DAEMON parks). Read-only commands
  // (status/send-outbox/…) stay usable — inspection must survive a kill.
  if (readTombstone()) {
    console.error(formatTombstoneParkedMessage(resolveTombstonePath(process.env)));
    process.exit(1);
  }
  const trigger = parseCliTrigger([command, ...rest]);
  if (!trigger.ok) {
    console.error(JSON.stringify(trigger));
    process.exit(1);
  }

  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const gateway = new Gateway(store, undefined, process.cwd());
    const intake = gateway.intake(trigger.event);
    if (!intake.ok) {
      console.log(JSON.stringify({ intake, result: { status: "idle" } }, null, 2));
      process.exitCode = 1;
    } else if (intake.status === "duplicate") {
      console.log(JSON.stringify({ intake, result: { status: "duplicate" } }, null, 2));
      process.exitCode = 0;
    } else {
      const worker = new CoreWorker(
        store,
        process.cwd(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        broker
      );
      const result = await worker.executeRun(intake.run_id, "local-worker");

      console.log(JSON.stringify({ intake, result }, null, 2));
      process.exitCode = result.status === "completed" ? 0 : 1;
    }
  } finally {
    store.close();
  }
} else if (command === "status") {
  if (rest.length > 1) {
    console.log(JSON.stringify({
      ok: false,
      error: { code: "CLI_USAGE", message: "Usage: houge status [run_id]" }
    }, null, 2));
    process.exit(1);
  }

  const { queryStatus } = await import("./status/status-query.js");
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const result = queryStatus(store, rest[0]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    store.close();
  }
} else if (command === "usage") {
  const { formatUsageTable, resolveUsageSince } = await import("./status/usage-report.js");
  const since = resolveUsageSince(rest, new Date().toISOString());
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    console.log(formatUsageTable(store.usageByModel(since)));
    process.exitCode = 0;
  } finally {
    store.close();
  }
} else if (command === "eval") {
  const suite = rest[0] ?? "milestone-0";
  const result = await runEvalSuite(process.cwd(), suite);
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    store.recordEvalCompleted(result.suite, result.passed, result.failed);
  } finally {
    store.close();
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
} else if (command === "send-outbox") {
  const { NotificationOutbox } = await import("./notifications/notification-outbox.js");
  const { NotificationDispatcher } = await import("./notifications/notification-dispatcher.js");
  const { LocalNotificationAdapter } = await import("./notifications/local-notification-adapter.js");
  const { workspaceTelegramAdapter } = await import("./telegram/telegram-poll-runner.js");
  const { TelegramClient } = await import("./telegram/telegram-client.js");
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    // houge.sqlite is opened from the cwd, so the cwd is the omp data dir its attachments live under (M6)
    const dispatcher = new NotificationDispatcher(new NotificationOutbox(store), {
      local: new LocalNotificationAdapter(),
      telegram: workspaceTelegramAdapter(new TelegramClient({ token: (broker ? broker.telegramToken() : process.env.HOUGE_TELEGRAM_BOT_TOKEN) ?? "" }), process.cwd())
    });
    console.log(JSON.stringify(await dispatcher.dispatchOnce("cli-send-outbox"), null, 2));
  } finally {
    store.close();
  }
} else if (command === "telegram-poll") {
  const once = rest.includes("--once");

  // Kill-switch boot gate (ADR 0018). launchd's KeepAlive is UNCONDITIONAL (plist
  // template), so a killed daemon must not exit — it would be relaunched every 10s
  // (ThrottleInterval) forever. Instead the daemon PARKS ALIVE: log one line, construct
  // nothing (no gateway/store/poll), and hold the process idle while still honoring
  // SIGTERM/SIGINT so `launchctl unload` stays clean. `--once` is an interactive
  // invocation → message + exit 1. Revival is manual: delete the file, restart.
  const tombstone = readTombstone();
  if (tombstone) {
    const parked = formatTombstoneParkedMessage(resolveTombstonePath(process.env));
    if (once) {
      console.error(parked);
      process.exit(1);
    }
    console.error(`[${new Date().toISOString()}] [daemon] ${parked}`);
    // Leave the park marker so the post-revival invariant sweep can tell a deliberate park from a
    // crash (else every revival opens a false heartbeat_gap incident). File-only — the park path
    // still constructs no store. Best-effort: a marker write must never stop the park itself.
    try {
      writeParkMarker({ parked_at: new Date().toISOString(), ...tombstone });
    } catch (error) {
      console.error(`[daemon] park marker not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => resolve());
      process.once("SIGINT", () => resolve());
      // Signal listeners alone do NOT keep Node's event loop alive — without an active
      // handle the process would exit immediately and KeepAlive would relaunch it every
      // 10s (the exact crash loop park-alive exists to avoid). A long no-op interval
      // holds the loop open; ~24.8 days is setInterval's max delay, and re-arming is free.
      setInterval(() => {}, 2 ** 31 - 1);
    });
    process.exit(0);
  }

  const { TelegramClient } = await import("./telegram/telegram-client.js");

  // Firewall ON: the token lives in the broker (env was stripped). OFF: read env as before.
  const token = broker ? broker.telegramToken() : process.env.HOUGE_TELEGRAM_BOT_TOKEN;
  const userId = process.env.HOUGE_TELEGRAM_USER_ID;
  const chatId = process.env.HOUGE_TELEGRAM_CHAT_ID;

  const missing = [
    ["HOUGE_TELEGRAM_BOT_TOKEN", token],
    ["HOUGE_TELEGRAM_USER_ID", userId],
    ["HOUGE_TELEGRAM_CHAT_ID", chatId]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    console.error(`Missing required Telegram environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const allowlist = {
    users: [{ telegram_user_id: Number(userId), identity_id: "paco" }],
    chats: [{ telegram_chat_id: Number(chatId), label: "paco-private", allowed_identity_ids: ["paco"] }]
  };

  const client = new TelegramClient({ token: token! });

  if (once) {
    const { runTelegramPollOnce } = await import("./telegram/telegram-poll-runner.js");
    const store = RunStore.open("houge.sqlite", storeOptions);
    try {
      const result = await runTelegramPollOnce({
        store,
        projectRoot: process.cwd(),
        allowlist,
        telegramClient: client,
        ...brokerOption
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Telegram poll failed: ${message}`);
      if (/HTTP 40[0134]/.test(message)) {
        console.error("Check that HOUGE_TELEGRAM_BOT_TOKEN is a valid @BotFather token.");
      }
      process.exitCode = 1;
    } finally {
      store.close();
    }
  } else {
    // Always-on daemon mode (continuous long-poll loop).
    const { runTelegramDaemon } = await import("./telegram/telegram-daemon.js");
    const { acquireSingleInstanceLock } = await import("./telegram/single-instance-lock.js");

    const numEnv = (name: string, fallback: number): number => {
      const n = Number(process.env[name]);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const longPollTimeoutSeconds = numEnv("HOUGE_TELEGRAM_LONGPOLL_TIMEOUT_S", 30);
    const backoff = {
      baseMs: numEnv("HOUGE_DAEMON_BACKOFF_BASE_MS", 1_000),
      maxMs: numEnv("HOUGE_DAEMON_BACKOFF_MAX_MS", 60_000)
    };
    const lockPath = process.env.HOUGE_DAEMON_LOCK_PATH ?? "houge.daemon.lock";

    const lock = acquireSingleInstanceLock(lockPath);
    if (!lock.ok) {
      console.error(
        `Another houge daemon is already running (pid ${lock.held_by_pid}); refusing to start a second.`
      );
      process.exit(1);
    }

    const log = (msg: string): void =>
      console.error(`[${new Date().toISOString()}] [daemon] ${msg}`);

    const controller = new AbortController();
    const onStop = (signal: string): void => {
      log(`${signal} received — finishing in-flight work and shutting down…`);
      controller.abort();
    };
    process.once("SIGTERM", () => onStop("SIGTERM"));
    process.once("SIGINT", () => onStop("SIGINT"));

    const store = RunStore.open("houge.sqlite", storeOptions);
    try {
      log(`starting long-poll loop (timeout ${longPollTimeoutSeconds}s)`);
      const result = await runTelegramDaemon({
        store,
        projectRoot: process.cwd(),
        allowlist,
        telegramClient: client,
        stopSignal: controller.signal,
        // ADR 0018: lets /kill stop the loop after its ack is enqueued (same abort as SIGTERM).
        requestShutdown: () => onStop("/kill"),
        ...brokerOption,
        longPollTimeoutSeconds,
        backoff
      });
      log(`stopped cleanly after ${result.cycles} cycles`);
      process.exitCode = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`fatal: ${message}`);
      process.exitCode = 1;
    } finally {
      lock.lock.release();
      store.close();
    }
  }
} else if (command === "telegram-parser-smoke") {
  const { parseTelegramCommand } = await import("./triggers/telegram-command-parser.js");
  const text = rest.join(" ");
  const parsed = parseTelegramCommand(text);
  console.log(JSON.stringify(parsed.ok ? parsed.command : parsed, null, 2));
  process.exit(parsed.ok ? 0 : 1);
} else if (command === "outbox-smoke") {
  const { NotificationOutbox } = await import("./notifications/notification-outbox.js");
  const store = RunStore.openInMemory();
  try {
    const outbox = new NotificationOutbox(store);
    const record = outbox.enqueue({
      target: { kind: "local" },
      intent_type: "progress",
      idempotency_key: "smoke:progress",
      correlation_id: "smoke:progress",
      payload: { text: "outbox smoke" }
    });
    console.log(JSON.stringify({ ok: true, notification_id: record.notification_id }, null, 2));
  } finally {
    store.close();
  }
} else if (command === "omp") {
  // Contract probe by hand (spec 2026-10-09 §5 Manual): exit 0 pass, 1 fail, 2 inconclusive, 3 omp unavailable.
  if (rest[0] !== "probe") {
    console.error("Usage: houge omp probe");
    process.exit(1);
  }
  if (readTombstone()) {
    console.error(formatTombstoneParkedMessage(resolveTombstonePath(process.env)));
    process.exit(1);
  }
  const { runOmpProbeCli } = await import("./omp/omp-probe-cli.js");
  // Ctrl-C stops the probe's omp children and removes its dirs (the runner's stop signal), then exits 2.
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  // The store opens inside, only after the houge.sqlite check, and closes there before this exit.
  const code = await runOmpProbeCli({ openStore: () => RunStore.open("houge.sqlite", storeOptions), env: process.env,
    cwd: process.cwd(), out: (l) => console.log(l), signal: interrupt.signal });
  process.exit(code);
} else if (command === `jev`) { // backticks: panel-judge-providers.test greps src for the double-quoted provider name; this is the subcommand, not a provider
  // Decision-tree calibration (spec 2026-10-06 §7): replay the six tree questions over history, label by hand, report the evidence.
  const sub = rest[0];
  if (rest[1] !== "triage" || !["replay", "label", "report"].includes(sub ?? "")) {
    console.error("Usage: houge jev replay triage [--dry-run] [--max-usd N] [--limit N] [--permute] | houge jev label triage [--sample=N] | houge jev report triage");
    process.exit(1);
  }
  if (readTombstone()) {
    console.error(formatTombstoneParkedMessage(resolveTombstonePath(process.env)));
    process.exit(1);
  }
  const { parseJevCliFlags } = await import("./jev/triage-label.js");
  const { parseReplayArgs } = await import("./jev/replay.js");
  let flags: ReturnType<typeof parseJevCliFlags>;
  try { flags = parseJevCliFlags(rest.slice(2)); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
  const args = parseReplayArgs(flags.rest);
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }
  const T = await import("./jev/triage-replay.js");
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    if (sub === "label") {
      const { labelInteractively, selectForLabelling } = await import("./jev/triage-label.js");
      const picked = selectForLabelling(T.readReplayFile(T.TREE_REPLAY_OUT), T.loadLabels(T.TREE_LABELS_PATH), flags.sample ?? 40);
      const n = await labelInteractively({ rows: picked, store, labelsPath: T.TREE_LABELS_PATH, input: process.stdin, output: process.stdout });
      console.error(`labelled ${n} of ${picked.length}`);
    } else {
      const { formatTreeReport } = await import("./jev/triage-report.js");
      const { TREE_BAR_DEFAULTS } = await import("./jev/tree-policy.js");
      const universe = T.treeUniverse(store);
      console.error(`replay universe: ${universe} Telegram turns since ${T.TREE_LABEL_SINCE} (the spec counted 305 runs on 2026-10-06; a different number is information, not an error)`);
      let outcome: import("./jev/triage-report.js").TreeReportOutcome = { spentUsd: 0, estimatedUsd: 0, universe, ...(args.limit !== undefined ? { limited: true } : {}) };
      let rows: import("./jev/triage-replay.js").TreeReplayRow[];
      if (sub === "replay") {
        const { createJevClient } = await import("./jev/jev-client.js");
        const jev = createJevClient({
          apiKey: broker ? broker.typesafeKey() : process.env.TYPESAFE_API_KEY,
          audit: store.llmAuditSink({ correlation_id: "cli:jev-tree-replay", role: "triage" }),
          meteredBreached: () => store.meteredFuseLatched(),
          retries: 3,
          timeoutMs: 15_000
        });
        const run = await T.runTreeReplay({ store, env: process.env, jev, outPath: flags.permute ? T.TREE_PERMUTED_OUT : T.TREE_REPLAY_OUT, maxUsd: args.maxUsd,
          dryRun: args.dryRun, permute: flags.permute, ...(args.limit !== undefined ? { limit: args.limit } : {}), log: (l) => console.error(l) });
        // One row per key, latest wins (the file), never this run's raw rows; a dry run writes nothing, so its own rows speak.
        rows = args.dryRun ? run.rows : T.readReplayFile(T.TREE_REPLAY_OUT);
        outcome = { ...outcome, spentUsd: run.spentUsd, estimatedUsd: run.estimatedUsd, wouldDispatch: run.wouldDispatch, alreadyDone: run.alreadyDone, skipped: run.skipped,
          ...(run.stopped ? { stopped: run.stopped } : {}) };
        process.exitCode = run.stopped ? 1 : 0;
      } else {
        rows = T.readReplayFile(T.TREE_REPLAY_OUT);
      }
      const permuted = T.readReplayFile(T.TREE_PERMUTED_OUT); // no file = "NOT RUN", not "covers nothing"
      console.log(formatTreeReport(rows, T.loadLabels(T.TREE_LABELS_PATH), outcome, TREE_BAR_DEFAULTS, permuted.length > 0 ? permuted : undefined));
    }
  } finally {
    store.close();
  }
} else if (command === "jev-shadow") {
  // Jev intent-shadow replay (spec 2026-09-25): both classifiers on each historical turn's rebuilt
  // thread → JSONL + GO/STOP report. Makes external calls, so the kill switch refuses it like `run`.
  if (rest[0] !== "replay") {
    console.error("Usage: houge jev-shadow replay [--since ISO] [--limit N] [--max-usd USD] [--dry-run]");
    process.exit(1);
  }
  if (readTombstone()) {
    console.error(formatTombstoneParkedMessage(resolveTombstonePath(process.env)));
    process.exit(1);
  }
  const { parseReplayArgs, runReplay, REPLAY_OUT_PATH } = await import("./jev/replay.js");
  const { formatReplayReport } = await import("./jev/replay-report.js");
  const { createJevClient } = await import("./jev/jev-client.js");
  const { oneShotAdapter } = await import("./llm/registry.js");
  const { resolveOmpConfig } = await import("./omp/omp-config.js");
  const args = parseReplayArgs(rest.slice(1));
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const jev = createJevClient({
      apiKey: broker ? broker.typesafeKey() : process.env.TYPESAFE_API_KEY,
      audit: store.llmAuditSink({ correlation_id: "cli:jev-replay", role: "classify_replay" }),
      meteredBreached: () => store.meteredFuseLatched(),
      retries: 3,
      timeoutMs: 15_000
    });
    const llm = oneShotAdapter(store, resolveOmpConfig(process.env), { correlation_id: "cli:jev-replay", role: "classify_replay_llm" });
    const outcome = await runReplay({
      store,
      env: process.env,
      jev,
      classifyLlm: async (question, system) => {
        const r = await llm.answer({ question, system });
        return r.ok ? { ok: true as const, raw: r.answer } : { ok: false as const, error: r.error };
      },
      outPath: REPLAY_OUT_PATH,
      maxUsd: args.maxUsd,
      dryRun: args.dryRun,
      ...(args.sinceIso !== undefined ? { sinceIso: args.sinceIso } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      log: (line) => console.error(line)
    });
    console.log(formatReplayReport(outcome.rows, outcome));
    process.exitCode = outcome.stopped ? 1 : 0;
  } finally {
    store.close();
  }
} else if (command === "lessons-consolidate") {
  // Preserve-all lesson consolidation (design 2026-07-23). `--dry-run` is the pre-arm safety net:
  // it makes the REAL cluster+merge LLM calls but takes NO write path, rendering every member text
  // → the proposed merge so a dropped directive is visible before anything is armed. A non-dry
  // invocation runs one pass immediately (flag-gated + interval-latched like the daemon tick).
  const dryRun = rest.includes("--dry-run");
  const { runLessonConsolidateTick } = await import("./capabilities/lesson-consolidate.js");
  const { oneShotAdapter } = await import("./llm/registry.js");
  const { resolveOmpConfig } = await import("./omp/omp-config.js");

  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const seat = oneShotAdapter(store, resolveOmpConfig(process.env), { correlation_id: "cli:lessons-consolidate", role: "consolidate" });
    const llmAnswer = async (input: { question: string; system: string }) => {
      const read = await seat.answer(input);
      return read.ok ? ({ ok: true, answer: read.answer } as const) : ({ ok: false } as const);
    };

    const result = await runLessonConsolidateTick({
      store,
      llmAnswer,
      env: process.env,
      now: new Date().toISOString(),
      dryRun
    });
    if (dryRun) {
      const proposals = result.proposals ?? [];
      if (proposals.length === 0) {
        console.log("No consolidation proposed (no near-duplicate clusters, or the flag path was empty).");
      } else {
        console.log(`Proposed ${proposals.length} merge(s) across ${result.scopes_processed} scope(s):\n`);
        for (const p of proposals) {
          console.log(`── scope "${p.scope}" — merge #${p.superseded_ids.join(", #")} ──`);
          for (const text of p.member_texts) console.log(`  • ${text}`);
          console.log(`  ⇒ ${p.merged_text}`);
          if (p.merged_avoid) console.log(`     AVOID: ${p.merged_avoid}`);
          if (p.rejected) console.log(`  ⚠ REJECTED (${p.rejected}) — an armed tick would SKIP this`);
          console.log("");
        }
        console.log("(dry run — nothing was written.)");
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(`lessons-consolidate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
} else if (command === "radar") {
  // Idea Radar R1 (spec 2026-07-24). `--dry-run` is the §7 pre-arm gate: REAL fetches +
  // the REAL extract LLM call, ZERO writes — renders every proposed card (member item
  // titles → proposed title/summary) for Paco's eyeball while the flag is still unset.
  // A non-dry invocation runs one pass immediately (flag-gated + interval-latched like
  // the daemon tick).
  const dryRun = rest.includes("--dry-run");
  const { renderRadarProposals, runIdeaRadarTick } = await import("./capabilities/idea-radar.js");
  const { oneShotAdapter } = await import("./llm/registry.js");
  const { resolveOmpConfig } = await import("./omp/omp-config.js");

  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const seat = oneShotAdapter(store, resolveOmpConfig(process.env), { correlation_id: "cli:radar", role: "extract" });
    const llmAnswer = async (input: { question: string; system: string }) => {
      const read = await seat.answer(input);
      return read.ok ? ({ ok: true, answer: read.answer } as const) : ({ ok: false } as const);
    };

    const result = await runIdeaRadarTick({
      store,
      llmAnswer,
      env: process.env,
      now: new Date().toISOString(),
      dryRun
    });
    if (dryRun) {
      // Rendering lives in renderRadarProposals so tests can hold the terminal surface
      // to the sanitized floor (no control/bidi char can reach the terminal).
      for (const line of renderRadarProposals(result.proposals ?? [])) console.log(line);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(`radar failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
} else if (command === "radar-panel") {
  // Idea Radar R2 (spec 2026-07-25 §13.1). `--dry-run` is the pre-arm gate: the REAL seats
  // (pinned kimi/gemini judges, contained codex + claude spawns), ZERO write paths — no
  // scores, no statuses, no snapshot, no brief, no push — rendering the would-be shortlist
  // for Paco's eyeball while the flag is still unset (bypasses flag + latch by design).
  // A non-dry invocation runs one flag-gated + latched pass: brief written (real repo
  // root), but chatId null → no push (the daemon owns the weekly digest).
  const dryRun = rest.includes("--dry-run");
  const { renderPanelProposals, runIdeaPanelTick } = await import("./capabilities/idea-panel.js");
  const { buildOmpPanelSeats } = await import("./capabilities/idea-panel-seats.js");

  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    // The SAME seat builder the daemon uses (idea-panel-seats), so the two panel sites cannot drift.
    const seats = buildOmpPanelSeats({ store, correlation_id: "cli:radar-panel", env: process.env });

    if (dryRun) {
      // §13.1: say the cost out loud — run this deliberately, not in a loop.
      console.log("dry-run cost: 4 omp subscription one-shots (3 judges + chair)");
    }
    const result = await runIdeaPanelTick({
      store,
      ...seats,
      env: process.env,
      now: new Date().toISOString(),
      chatId: null,
      projectRoot: dryRun ? null : process.cwd(),
      dryRun
    });
    if (dryRun) {
      // Rendering lives in renderPanelProposals so tests can hold the terminal surface
      // to the sanitized floor (no control/bidi char can reach the terminal).
      for (const line of renderPanelProposals(result)) console.log(line);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(`radar-panel failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
