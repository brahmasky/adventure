// Build step (spec §12): tsc does not copy .sh files.
// Optional argv[2]: the dist directory to write into (default ../dist/); lets a test run against a temp dist.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const dist = process.argv[2] ?? new URL("../dist/", import.meta.url).pathname;
const src = new URL("../src/omp/", import.meta.url).pathname;
mkdirSync(join(dist, "omp"), { recursive: true });
copyFileSync(join(src, "shell-wrapper.sh"), join(dist, "omp/shell-wrapper.sh"));
console.log("copied dist/omp/shell-wrapper.sh");

// Declarative tool JSON (tsc does not copy .json): Task 5. The folder is cleared first so a
// tool declaration deleted from src cannot survive in dist (it would fail tool_decl_invalid).
rmSync(join(dist, "omp/tools"), { recursive: true, force: true });
mkdirSync(join(dist, "omp/tools"), { recursive: true });
for (const f of readdirSync(join(src, "tools")).filter((x) => x.endsWith(".json"))) {
  copyFileSync(join(src, "tools", f), join(dist, "omp/tools", f));
}
console.log("copied dist/omp/tools/*.json");
