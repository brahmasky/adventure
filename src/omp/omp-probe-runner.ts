import { errorCode } from "../domain/error-code.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import type { ModelString } from "./model-string.js";
import { runOmpContractProbe, type ProbeCheckOutcome, type ProbeInput, type ProbeResult } from "./omp-contract-probe.js";
import type { OmpConfig } from "./omp-config.js";
import type { PathContext } from "./protected-paths.js";
import type { RoleResolver } from "./role-resolver.js";

/**
 * The contract probe's runner (spec §5): probes each omp version once per process, off every turn's path, one probe at a
 * time (latest version wins). A version with a PASS row is never probed again. A fail on the current binary pages
 * `omp_contract_drift` once; a pass clears it; a stale binary's answer only records its row. Never blocks a spawn (D2).
 */
export const OMP_CONTRACT_DRIFT = "omp_contract_drift";
const DRIFT_KINDS: ReadonlySet<string> = new Set([OMP_CONTRACT_DRIFT]);

/** The probe model: Tiny's head at low effort, else Fast's, else none (the probe then runs its model-free checks only). */
export function pickProbeModel(roles: Pick<RoleResolver, "candidates">): ModelString | null {
  return roles.candidates("tiny", { effort: "low" })[0] ?? roles.candidates("fast", { effort: "low" })[0] ?? null;
}

/** Record the row and sync the drift incident in one transaction: a page is never sent without its row, nor a row lost after it. */
export function settleProbe(store: RunStore, r: ProbeResult, currentVersion: string | null, now: string): void {
  store.inTransaction(() => {
    store.recordOmpProbe(r);
    if (r.version !== currentVersion) return;
    if (r.result === "fail") {
      const failed = Object.fromEntries(Object.entries(r.checks).filter(([, o]) => (o as ProbeCheckOutcome).startsWith("fail:")));
      openAlertedIncident(store, { kind: OMP_CONTRACT_DRIFT, subject: `omp:${r.version}`, detail: { version: r.version, failed }, chat_id: null, now });
    } else if (r.result === "pass") {
      resolveOpenIncidents(store, DRIFT_KINDS, undefined, now);
    }
  });
}

export interface OmpProbeRunner {
  /** Queue a probe of `version` unless it already passed or was tried this process. Never throws. */
  maybeProbe(version: string): void;
  /** Probe now, skip rule ignored (the CLI). */
  probeNow(version: string): Promise<ProbeResult>;
}
export interface OmpProbeRunnerDeps {
  store: RunStore; cfg: OmpConfig; ctx: PathContext; roles: Pick<RoleResolver, "candidates">;
  currentVersion: () => string | null; signal: AbortSignal;
  probe?: (i: ProbeInput) => Promise<ProbeResult>; now?: () => string;
}

/** Thrown when the stop signal cut a probe: its partial verdict is discarded, nothing recorded. */
class ProbeAborted extends Error { constructor() { super("probe_aborted"); this.name = "ProbeAborted"; } }

const logFailure = (e: unknown): void => { console.error(`[omp-probe] failed: ${errorCode(e)}`); };

export function createOmpProbeRunner(d: OmpProbeRunnerDeps): OmpProbeRunner {
  const probe = d.probe ?? runOmpContractProbe;
  const now = d.now ?? (() => new Date().toISOString());
  let running = false;
  let pending: string | null = null;
  const attempted = new Set<string>();

  const execute = async (v: string): Promise<ProbeResult> => {
    const r = await probe({ cfg: d.cfg, ctx: d.ctx, version: v, model: pickProbeModel(d.roles), signal: d.signal });
    if (d.signal.aborted) throw new ProbeAborted();
    settleProbe(d.store, r, d.currentVersion(), now());
    return r;
  };

  const drain = (): void => {
    try {
      const v = pending;
      pending = null;
      if (v === null || d.signal.aborted || attempted.has(v) || d.store.latestOmpProbe(v, { result: "pass" })) return;
      running = true;
      attempted.add(v);
      // Off the caller's stack (the cache listener fires inside a turn's version check). execute() is async, so a
      // synchronous setup throw arrives here as a rejection too.
      setImmediate(() => {
        void execute(v)
          .catch((e: unknown) => { if (!d.signal.aborted) logFailure(e); })
          .finally(() => { running = false; drain(); });
      });
    } catch (e) { logFailure(e); }
  };

  return {
    maybeProbe: (version) => {
      try {
        pending = version;
        if (!running) drain();
      } catch (e) { logFailure(e); }
    },
    probeNow: (version) => execute(version)
  };
}
