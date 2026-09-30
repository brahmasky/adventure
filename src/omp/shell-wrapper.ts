import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** sha256 of src/omp/shell-wrapper.sh. Both files are protected; a test keeps them in lockstep (R9). */
export const SHELL_WRAPPER_SHA256 = "c6e41426365743d49df384a1d05c9c2b47550b7eb996c8c49cef1eac2097adcd";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyInstalledWrapper(distDir: string): { ok: true } | { ok: false; reason: string } {
  let got: string;
  try { got = sha256File(join(distDir, "omp", "shell-wrapper.sh")); } catch { return { ok: false, reason: "wrapper missing from dist" }; }
  return got === SHELL_WRAPPER_SHA256 ? { ok: true } : { ok: false, reason: `wrapper hash ${got} != ${SHELL_WRAPPER_SHA256}` };
}
