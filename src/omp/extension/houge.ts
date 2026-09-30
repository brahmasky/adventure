// Single omp entry (-e dist/omp/extension/houge.js). Protected (self-write guard). Imports nothing from Houge.
// omp cache-busts every -e import with ?mtime=, so two entries would each get their OWN bridge-client instance
// (and their own `registered` set). One entry = one module graph shared by tools and policy.
import { hougePolicy } from "./houge-policy.js";
import { hougeTools, type PiLike } from "./houge-tools.js";

export default async function houge(pi: PiLike): Promise<void> {
  await hougePolicy(pi); // gate first: a hougeTools failure must never leave built-ins ungated
  try { await hougeTools(pi); } catch (e) {
    // NOT rethrown: omp discards every handler of an extension whose load throws (live-proven), which would
    // remove the gate. With no stubs registered the policy blocks every non-built-in, and gates fail closed.
    process.stderr.write(`houge: tool stubs failed to load: ${(e as Error).message}\n`);
  }
}
