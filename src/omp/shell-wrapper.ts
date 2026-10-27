import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** sha256 of src/omp/shell-wrapper.sh. Both files are protected; a test keeps them in lockstep (R9). */
export const SHELL_WRAPPER_SHA256 = "dde4a0c3e34eda6ef82e799a89573cc870185c5c992469850bfd6d134e96d0b4";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyInstalledWrapper(distDir: string): { ok: true } | { ok: false; reason: string } {
  let got: string;
  try { got = sha256File(join(distDir, "omp", "shell-wrapper.sh")); } catch { return { ok: false, reason: "wrapper missing from dist" }; }
  return got === SHELL_WRAPPER_SHA256 ? { ok: true } : { ok: false, reason: `wrapper hash ${got} != ${SHELL_WRAPPER_SHA256}` };
}
