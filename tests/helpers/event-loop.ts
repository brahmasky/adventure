import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fake omp whose `--version` takes `ms` to answer (a real omp boot on the Mac mini took 0.7–0.8 s), then prints one. */
export function slowVersionBin(ms: number): string {
  const file = join(mkdtempSync(join(tmpdir(), "houge-slow-omp-")), "omp");
  writeFileSync(file, `#!/bin/sh\nsleep ${ms / 1000}\necho omp/18.7.0\n`);
  chmodSync(file, 0o755);
  return file;
}

/** Runs `fn` while a 10 ms interval samples the event loop; returns the longest gap between ticks (ms) and fn's result. */
export async function maxLoopGap<T>(fn: () => Promise<T>): Promise<{ gap: number; result: T }> {
  let last = performance.now(); let gap = 0;
  const iv = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 10);
  try {
    const result = await fn();
    return { gap: Math.max(gap, performance.now() - last), result };
  } finally { clearInterval(iv); }
}
