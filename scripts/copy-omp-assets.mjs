// Build step (spec §12): tsc does not copy .sh files.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync(new URL("../dist/omp/", import.meta.url), { recursive: true });
copyFileSync(new URL("../src/omp/shell-wrapper.sh", import.meta.url), new URL("../dist/omp/shell-wrapper.sh", import.meta.url));
console.log("copied dist/omp/shell-wrapper.sh");

// Declarative tool JSON (tsc does not copy .json): Task 5.
import { readdirSync } from "node:fs";
mkdirSync(new URL("../dist/omp/tools/", import.meta.url), { recursive: true });
for (const f of readdirSync(new URL("../src/omp/tools/", import.meta.url)).filter((x) => x.endsWith(".json"))) {
  copyFileSync(new URL(`../src/omp/tools/${f}`, import.meta.url), new URL(`../dist/omp/tools/${f}`, import.meta.url));
}
console.log("copied dist/omp/tools/*.json");
