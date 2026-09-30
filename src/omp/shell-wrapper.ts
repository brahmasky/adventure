import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** sha256 of src/omp/shell-wrapper.sh. Both files are protected; a test keeps them in lockstep (R9). */
export const SHELL_WRAPPER_SHA256 = "a7b8fd1ece653c19a872f32ad4bc4227d325b9d5c5668ca0cb0070f4b5647e67";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyInstalledWrapper(distDir: string): { ok: true } | { ok: false; reason: string } {
  let got: string;
  try { got = sha256File(join(distDir, "omp", "shell-wrapper.sh")); } catch { return { ok: false, reason: "wrapper missing from dist" }; }
  return got === SHELL_WRAPPER_SHA256 ? { ok: true } : { ok: false, reason: `wrapper hash ${got} != ${SHELL_WRAPPER_SHA256}` };
}
