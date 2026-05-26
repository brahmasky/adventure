#!/usr/bin/env node

import { getHougeVersion } from "./index.js";

const [, , command] = process.argv;

if (!command || command === "--version" || command === "version") {
  console.log(getHougeVersion());
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
