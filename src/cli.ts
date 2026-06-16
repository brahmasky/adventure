#!/usr/bin/env node

import { loadHougeEnv } from "./config/load-env.js";
import { CoreWorker } from "./core/core-worker.js";
import { Gateway } from "./gateway/gateway.js";
import { runEvalSuite } from "./eval/eval-runner.js";
import { getHougeVersion } from "./index.js";
import { RunStore } from "./run/run-store.js";
import { parseCliTrigger } from "./triggers/cli-trigger.js";

// Load `.env` (cwd or $HOUGE_ENV_FILE) before any command reads configuration.
// Real environment variables take precedence over the file.
loadHougeEnv();

const [, , command, ...rest] = process.argv;

if (!command || command === "--version" || command === "version") {
  console.log(getHougeVersion());
  process.exit(0);
}

if (command === "run") {
  const trigger = parseCliTrigger([command, ...rest]);
  if (!trigger.ok) {
    console.error(JSON.stringify(trigger));
    process.exit(1);
  }

  const store = RunStore.open("houge.sqlite");
  try {
    const gateway = new Gateway(store);
    const intake = gateway.intake(trigger.event);
    if (!intake.ok) {
      console.log(JSON.stringify({ intake, result: { status: "idle" } }, null, 2));
      process.exitCode = 1;
    } else if (intake.status === "duplicate") {
      console.log(JSON.stringify({ intake, result: { status: "duplicate" } }, null, 2));
      process.exitCode = 0;
    } else {
      const worker = new CoreWorker(store, process.cwd());
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
  const store = RunStore.open("houge.sqlite");
  try {
    const result = queryStatus(store, rest[0]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    store.close();
  }
} else if (command === "eval") {
  const suite = rest[0] ?? "milestone-0";
  const result = await runEvalSuite(process.cwd(), suite);
  const store = RunStore.open("houge.sqlite");
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
  const store = RunStore.open("houge.sqlite");
  try {
    const dispatcher = new NotificationDispatcher(new NotificationOutbox(store), {
      local: new LocalNotificationAdapter(),
      telegram: new TelegramNotificationAdapter(new TelegramClient({ token: process.env.HOUGE_TELEGRAM_BOT_TOKEN ?? "" }))
    });
    console.log(JSON.stringify(await dispatcher.dispatchOnce("cli-send-outbox"), null, 2));
  } finally {
    store.close();
  }
} else if (command === "telegram-poll") {
  if (!rest.includes("--once")) {
    console.error("Only --once is supported in Milestone 2");
    process.exit(1);
  }

  const { TelegramClient } = await import("./telegram/telegram-client.js");
  const { runTelegramPollOnce } = await import("./telegram/telegram-poll-runner.js");

  const token = process.env.HOUGE_TELEGRAM_BOT_TOKEN;
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

  const store = RunStore.open("houge.sqlite");
  try {
    const result = await runTelegramPollOnce({
      store,
      projectRoot: process.cwd(),
      allowlist,
      telegramClient: new TelegramClient({ token: token! })
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } finally {
    store.close();
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
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
