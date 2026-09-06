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
  const { TelegramNotificationAdapter } = await import("./notifications/telegram-notification-adapter.js");
  const { TelegramClient } = await import("./telegram/telegram-client.js");
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const dispatcher = new NotificationDispatcher(new NotificationOutbox(store), {
      local: new LocalNotificationAdapter(),
      telegram: new TelegramNotificationAdapter(new TelegramClient({ token: (broker ? broker.telegramToken() : process.env.HOUGE_TELEGRAM_BOT_TOKEN) ?? "" }))
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
} else if (command === "lessons-consolidate") {
  // Preserve-all lesson consolidation (design 2026-07-23). `--dry-run` is the pre-arm safety net:
  // it makes the REAL cluster+merge LLM calls but takes NO write path, rendering every member text
  // → the proposed merge so a dropped directive is visible before anything is armed. A non-dry
  // invocation runs one pass immediately (flag-gated + interval-latched like the daemon tick).
  const dryRun = rest.includes("--dry-run");
  const { runLessonConsolidateTick } = await import("./capabilities/lesson-consolidate.js");
  const { createLlmAnswerAdapter } = await import("./capabilities/llm-answer.js");

  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const llmAdapter = createLlmAnswerAdapter({
      ...brokerOption,
      audit: store.llmAuditSink({ correlation_id: "cli:lessons-consolidate", role: "consolidate" })
    });
    const llmAnswer = async (input: { question: string; system: string }) => {
      const read = await llmAdapter({ question: input.question, system: input.system });
      return read.ok && typeof read.output.answer === "string"
        ? ({ ok: true, answer: read.output.answer } as const)
        : ({ ok: false } as const);
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
  const { createLlmAnswerAdapter } = await import("./capabilities/llm-answer.js");

  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const llmAdapter = createLlmAnswerAdapter({
      ...brokerOption,
      audit: store.llmAuditSink({ correlation_id: "cli:radar", role: "extract" })
    });
    const llmAnswer = async (input: { question: string; system: string }) => {
      const read = await llmAdapter({ question: input.question, system: input.system });
      return read.ok && typeof read.output.answer === "string"
        ? ({ ok: true, answer: read.output.answer } as const)
        : ({ ok: false } as const);
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
  const { PANEL_JUDGE_PROVIDERS, renderPanelProposals, runIdeaPanelTick } = await import(
    "./capabilities/idea-panel.js"
  );
  const { spawnCodexJudge, spawnPanelChair } = await import("./capabilities/idea-panel-seats.js");
  const { createLlmAnswerAdapter } = await import("./capabilities/llm-answer.js");

  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    // PINNED single-provider judges (spec §1: never a chain — a healthy-leg fallback would
    // silently void model diversity and the quorum semantics). Same wrapper the daemon uses.
    const pinnedJudge = (providers: string) => {
      const adapter = createLlmAnswerAdapter({
        ...brokerOption,
        providers,
        audit: store.llmAuditSink({ correlation_id: "cli:radar-panel", role: "judge" })
      });
      return async (input: { question: string; system: string }) => {
        const read = await adapter({ question: input.question, system: input.system });
        return read.ok && typeof read.output.answer === "string"
          ? ({ ok: true, answer: read.output.answer } as const)
          : ({ ok: false } as const);
      };
    };
    const chairBroker = broker;
    const seats = {
      // Same pinning the daemon uses — imported, never re-typed, so the two panel seat sites
      // cannot drift apart again (this one was missed in the CLI-only migration and kept firing
      // the metered APIs, including on the `--dry-run` pre-arm gate).
      judges: {
        kimi: pinnedJudge(PANEL_JUDGE_PROVIDERS.kimi),
        gemini: pinnedJudge(PANEL_JUDGE_PROVIDERS.gemini)
      },
      codexJudge: (input: { digest: string; system: string }) =>
        spawnCodexJudge({
          digest: input.digest,
          system: input.system,
          env: process.env,
          audit: store.llmAuditSink({ correlation_id: "cli:radar-panel", role: "judge" })
        }),
      // The chair's OAuth token is broker-held (spec §§2–3) — firewall OFF ⇒ chair
      // unavailable ⇒ the tick's deterministic mean-score fallback (self-describing output).
      chair: chairBroker
        ? (input: { digest: string; system: string }) =>
            spawnPanelChair({
              digest: input.digest,
              system: input.system,
              broker: chairBroker,
              env: process.env,
              audit: store.llmAuditSink({ correlation_id: "cli:radar-panel", role: "chair" })
            })
        : async () => ({ ok: false as const, unavailable: true })
    };

    if (dryRun) {
      // §13.1: say the cost out loud — run this deliberately, not in a loop.
      console.log("dry-run cost: 2 metered calls + 2 subscription spawns");
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
