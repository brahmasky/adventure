#!/usr/bin/env node

import { CoreWorker } from "./core/core-worker.js";
import { Gateway } from "./gateway/gateway.js";
import { getHougeVersion } from "./index.js";
import { RunStore } from "./run/run-store.js";
import { parseCliTrigger } from "./triggers/cli-trigger.js";

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
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
