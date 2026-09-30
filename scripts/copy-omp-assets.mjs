// Build step (spec §12): tsc does not copy .sh files.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync(new URL("../dist/omp/", import.meta.url), { recursive: true });
copyFileSync(new URL("../src/omp/shell-wrapper.sh", import.meta.url), new URL("../dist/omp/shell-wrapper.sh", import.meta.url));
console.log("copied dist/omp/shell-wrapper.sh");
