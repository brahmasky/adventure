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
    const worker = new CoreWorker(store, process.cwd());
    const result = await worker.executeOnce("local-worker");

    console.log(JSON.stringify({ intake, result }, null, 2));
    process.exit(intake.ok && result.status === "completed" ? 0 : 1);
  } finally {
    store.close();
  }
}

console.error(`Unknown command: ${command}`);
process.exit(1);
