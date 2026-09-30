// Single omp entry (-e dist/omp/extension/houge.js). Protected (self-write guard). Imports nothing from Houge.
// omp cache-busts every -e import with ?mtime=, so two entries would each get their OWN bridge-client instance
// (and their own `registered` set). One entry = one module graph shared by tools and policy.
import { hougePolicy } from "./houge-policy.js";
import { hougeTools, type PiLike } from "./houge-tools.js";

export default async function houge(pi: PiLike): Promise<void> {
  await hougeTools(pi);
  await hougePolicy(pi);
}
