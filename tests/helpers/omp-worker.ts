import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import type { GoogleApiDeps } from "../../src/capabilities/google-api.js";
import { TURN_ACTIONS } from "../../src/contracts/task-contract.js";
import { CoreWorker, type MediaWorkerDeps } from "../../src/core/core-worker.js";
import { createBridgeHandler, type ActiveTurn, type CallResult } from "../../src/omp/bridge-handler.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { loadToolDeclarations, TOOL_DECLS_DIR } from "../../src/omp/tool-decls.js";
import { chatWorkspace } from "../../src/omp/workspace.js";
import type { Identity } from "../../src/domain/types.js";
import type { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { tmpOmpDist } from "./omp-env.js";

type Adapter = (input: Record<string, unknown>) => Promise<ToolAdapterResult>;

/** A CoreWorker on the omp path: data + dist in `root` (real preflight against the copied wrapper), all adapters faked. Tests only. */
export function ompWorker(
  store: RunStore, root: string,
  o: {
    llm?: Adapter; web?: Adapter; http?: Adapter; media?: MediaWorkerDeps; project?: string; google?: GoogleApiDeps;
    codex?: (input: Record<string, unknown>) => ToolAdapterResult | Promise<ToolAdapterResult>; time?: Adapter;
    embed?: (text: string) => Promise<Float32Array | null>; operator?: Identity;
  } = {}
): CoreWorker {
  const llm: Adapter = o.llm ?? (async () => ({ ok: true, output: { answer: "stub" } }));
  return new CoreWorker(
    store, o.project ?? join(root, "project"), llm, o.web, o.codex, undefined, o.http, undefined, o.time, o.embed ?? (async () => null),
    o.google, o.media, { dataDir: root, distDir: tmpOmpDist(root), ...(o.operator ? { operator: o.operator } : {}) }
  );
}

/** Poll until `check` holds (real timers: the fake omp is a real child). */
export async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every queued outbox notification's payload by idempotency key (drains the outbox). */
export function drainOutbox(store: RunStore): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let n = store.claimNextNotification("test", 30); n; n = store.claimNextNotification("test", 30)) {
    out.set(n.idempotency_key, n.payload);
    store.markNotificationDelivered(n.notification_id, `test:${n.notification_id}`);
  }
  return out;
}

/** Lines the fake omp logged (FAKE_OMP_ARGV_LOG). */
export function fakeLog(file: string): Array<Record<string, unknown>> {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

/**
 * Drive the omp tool path in-process: claim the run, build the turn's registry with
 * `worker.buildOmpTools(claim)`, and answer bridge `call` requests through the real bridge
 * handler (policy → budget → approval → `loopToolExecute`). No child, no socket. Tests only.
 */
export function bridgeTurn(store: RunStore, worker: CoreWorker, run_id: string, dataDir: string): {
  call: (tool: string, input: Record<string, unknown>) => Promise<CallResult>; turn: ActiveTurn;
} {
  const worker_id = `planner:test:${run_id}`;
  const claim = store.claimRun(run_id, worker_id, 120);
  if (!claim) throw new Error(`claim failed: ${run_id}`);
  const tools = worker.buildOmpTools(claim);
  const target = store.getRunNotifyTarget(run_id);
  const chat_id = target.kind === "telegram" ? target.chat_id : "";
  const turn: ActiveTurn = {
    run_id, worker_id, chat_id, requester: store.getRunRequester(run_id), contract: claim.contract,
    budget: new BudgetLedger(claim.contract.budget), registry: tools.registry, signal: new AbortController().signal,
    cwd: chatWorkspace(dataDir, chat_id), step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: tools.quarantine, setAwaitingApproval: () => undefined, postureOk: () => null
  };
  const decls = loadToolDeclarations(TOOL_DECLS_DIR);
  if (!decls.ok) throw new Error(decls.error);
  const handle = createBridgeHandler({
    store, cfg: resolveOmpConfig(process.env), ctx: { home: dataDir, repo: join(dataDir, "project"), data: dataDir },
    decls: decls.decls, env: process.env, turnEnvelopeActions: [...TURN_ACTIONS], activeTurn: () => turn
  });
  let n = 0;
  const call = async (tool: string, input: Record<string, unknown>) =>
    (await handle({ id: `r${++n}`, kind: "call", tool, input, toolCallId: `tc${n}` })) as CallResult;
  return { call, turn };
}
