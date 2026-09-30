import { NO_OMP_BIN } from "./omp-env.js";

// Every test file starts with omp pointed at a path that is never an executable. A real omp may be
// on the developer's PATH, and a suite (or a CLI it spawns, which inherits process.env) that forgets
// pinOmpEnv() would otherwise run it with the houge profile. Suites that want a fake set it themselves.
process.env.HOUGE_OMP_BIN = NO_OMP_BIN;
