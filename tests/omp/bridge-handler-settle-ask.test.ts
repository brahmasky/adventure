import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { KEY_MASK, SECRET_MASK } from "../../src/decisions/egress.js";
import { MASKED_READ_REASON, SETTLE_REASON } from "../../src/decisions/trust-ask.js";
import { TurnTrust } from "../../src/decisions/trust.js";
import type { CompiledTaskContract, SideEffectLevel } from "../../src/domain/types.js";
import { createBridgeHandler, MASKED_REDIRECT_CODE, MASKED_WRITE_REDIRECT, SETTLE_REDIRECT_CODE, SETTLE_WRITE_REDIRECT, type ActiveTurn, type BridgeHandlerDeps } from "../../src/omp/bridge-handler.js";
import { maskedKey } from "../../src/omp/bridge-read-judge.js";
import type { BridgeRequest } from "../../src/omp/bridge-protocol.js";
import type { ExternalReadResult } from "../../src/omp/external-read.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { toolApprovalWaiters } from "../../src/omp/tool-approval-sink.js";
import { loadToolDeclarations, TOOL_DECLS_DIR } from "../../src/omp/tool-decls.js";
import { RunStore } from "../../src/run/run-store.js";
import { ToolRegistry, type ToolMetadata } from "../../src/tools/tool-registry.js";
import { drainOutbox } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// 2b-i §3.3 / §4: after a Jev-rung send-back every Houge effect asks as a hostile turn would; a write to a file whose read
// masked values asks (bash) or is redirected to bash (built-in edit/write), so a masked value is never written back.
const DECLS = (() => { const r = loadToolDeclarations(TOOL_DECLS_DIR); if (!r.ok) throw new Error(r.error); return r.decls; })();
const ENVELOPE = ["lesson_write", "memory_correct", "memory_correct_write", "fs_read", "fs_write", "shell"];
type Exec = NonNullable<ToolMetadata["execute"]>;
const meta = (name: string, side_effect_level: SideEffectLevel, execute?: Exec): ToolMetadata => ({ name, category: "tool", side_effect_level, risk_level: "low",
  timeout_ms: 5_000, output_limit_bytes: 64_000, ...(execute ? { execute } : {}) });

function setup(o: { env?: NodeJS.ProcessEnv; cwd?: "home"; settle?: BridgeHandlerDeps["settle"] } = {}) {
  const store = RunStore.openInMemory(); const run_id = createQueuedTurnRun(store);
  const claim = store.claimRun(run_id, "planner:c:a", 120)!;
  const contract: CompiledTaskContract = { ...claim.contract, allowed_actions: ENVELOPE, forbidden_actions: ["coding_agent_cli", "paid_action"],
    approval_gates: ["external_write", "destructive", "paid"], budget: { ...claim.contract.budget, max_tool_calls: 40 } };
  const ok: Exec = async (i) => ({ ok: true, output: { exit_code: 0, output: `ran ${String(i.command ?? "")}`, truncated: false, answer: "done", saved: true } });
  const registry = new ToolRegistry();
  registry.register(meta("lesson_write", "none", ok)); registry.register(meta("memory_correct", "none", ok)); registry.register(meta("memory_correct_write", "none", ok));
  registry.register(meta("shell", "local_write", ok)); registry.register(meta("fs_read", "none")); registry.register(meta("fs_write", "local_write"));
  const quarantine = vi.fn(async (tool: string): Promise<ExternalReadResult> => ({ digest: "s", contains_instructions: false, source_meta: { tool, bytes: 1 } }));
  const dir = mkdtempSync(join(tmpdir(), "hsa-")); const home = join(dir, "home"); mkdirSync(home, { recursive: true });
  const env = { HOUGE_TRUST_ASK_TTL_MS: "60", ...(o.env ?? {}) };
  const turn: ActiveTurn = { run_id, worker_id: "planner:c:a", chat_id: "555", requester: { kind: "user", id: "1" }, contract, budget: new BudgetLedger(contract.budget),
    registry, signal: new AbortController().signal, cwd: o.cwd === "home" ? home : dir, step: { n: 0 }, cache: new Map(), unreported: new Map(), quarantine,
    setAwaitingApproval: () => undefined, postureOk: () => null, trust: new TurnTrust({ store, run_id, chat_id: "555", born: "telegram", env }) };
  const handle = createBridgeHandler({ store, cfg: resolveOmpConfig({}), ctx: { home, repo: join(dir, "repo"), data: join(dir, "data") },
    decls: DECLS, env, turnEnvelopeActions: ENVELOPE, activeTurn: () => turn, ...(o.settle ? { settle: o.settle } : {}) });
  const events = (t: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === t).map((e) => e.payload);
  return { store, run_id, turn, handle, home, events };
}
let seq = 0;
const call = (tool: string, input: Record<string, unknown>): BridgeRequest => ({ id: `r${++seq}`, kind: "call", tool, input, toolCallId: `tc${seq}` });
const gate = (tool: "write" | "edit" | "read", path: string): BridgeRequest => ({ id: `r${++seq}`, kind: "gate", tool, input: { path }, toolCallId: `g${seq}` });
/** The "Why:" lines of the approval cards queued since the last drain (the reason lives on the card, not the ledger row). */
const cardTexts = (store: RunStore): string[] => [...drainOutbox(store).entries()].filter(([k]) => k.startsWith("approval:")).map(([, v]) => String(v.text));
type CallResult = { content: string; isError: boolean };
async function answerNth(store: RunStore, run_id: string, decision: "approved" | "denied", nth = 1): Promise<string> {
  const asked = () => store.getLedgerEvents(run_id).filter((e) => e.event_type === "approval_requested");
  await vi.waitFor(() => { expect(asked().length).toBeGreaterThanOrEqual(nth); });
  const id = (asked()[nth - 1]!.payload as { approval_id: string }).approval_id;
  toolApprovalWaiters.resolve(id, decision);
  return id;
}

describe("settleAsk at the bridge (spec §3.3, 2b-R7)", () => {
  it("every Houge effect asks with SETTLE_REASON on a clean turn: lesson_write, a shell write, memory_correct with a write action; reads and read-only shell run tap-free", async () => {
    const { handle, turn, run_id, store, events } = setup({ env: { HOUGE_TRUST_ASK_TTL_MS: "60000" } });
    turn.settleAsk = true;
    const asks: Array<Promise<CallResult>> = [handle(call("lesson_write", { scope: "ask" })) as Promise<CallResult>, handle(call("bash", { command: "touch /tmp/x" })) as Promise<CallResult>,
      handle(call("memory_correct", { action: "retire", kind: "fact", ids: [1] })) as Promise<CallResult>];
    for (let k = 1; k <= 3; k++) await answerNth(store, run_id, "denied", k);
    for (const p of asks) expect((await p).isError).toBe(true);
    const cards = cardTexts(store);
    expect(cards).toHaveLength(3);
    for (const c of cards) expect(c).toContain(`Why: ${SETTLE_REASON}`);
    expect(store.bumpTrustTapBudget("2026-10-20", "2026-10-20T00:00:00.000Z")).toBeGreaterThanOrEqual(4); // three taps counted before this bump
    expect(((await handle(call("bash", { command: "ls -la" }))) as CallResult).isError).toBe(false);
    expect(await handle(gate("read", "/tmp/a"))).toEqual({ decision: "allow" });
  });
  it("a built-in edit/write under settleAsk takes the bash redirect with its own text; the gate row names settle_redirect", async () => {
    const { handle, turn, events } = setup();
    turn.settleAsk = true;
    expect(await handle(gate("write", "/tmp/a"))).toEqual({ decision: "deny", reason: SETTLE_WRITE_REDIRECT });
    expect(events("tool_finished").at(-1)).toMatchObject({ status: "denied", reason: SETTLE_REDIRECT_CODE });
  });
});

describe("masked paths at the bridge (spec §4, 2b-R8)", () => {
  it("an edit through a symlink to a masked file takes the redirect; a bash command naming the file asks with MASKED_READ_REASON; an unrelated file does neither", async () => {
    // fixtures under HOME (a write root; os.tmpdir() is denied protected_path before the masked check runs); cwd = home for the bare-name case
    const { handle, turn, home, store, run_id, events } = setup({ env: { HOUGE_TRUST_ASK_TTL_MS: "60000" }, cwd: "home" });
    const real = join(home, "cfg.yml"); writeFileSync(real, "k: v\n"); symlinkSync(real, join(home, "link.yml"));
    turn.maskedPaths = new Set([maskedKey(real)]);
    expect(await handle(gate("edit", join(home, "link.yml")))).toEqual({ decision: "deny", reason: MASKED_WRITE_REDIRECT });
    expect(events("tool_finished").at(-1)).toMatchObject({ status: "denied", reason: MASKED_REDIRECT_CODE });
    expect(await handle(gate("edit", join(home, "CFG.yml")))).toEqual({ decision: "deny", reason: MASKED_WRITE_REDIRECT }); // case-folded
    expect(await handle(gate("edit", join(home, "other.yml")))).toEqual({ decision: "allow" });
    const p = handle(call("bash", { command: `sed -i '' 's/k/j/' ${join(home, "link.yml")}` })) as Promise<CallResult>;
    await answerNth(store, run_id, "denied");
    expect((await p).isError).toBe(true);
    expect(cardTexts(store).join("\n")).toContain(`Why: ${MASKED_READ_REASON}`);
    const bare = handle(call("bash", { command: "sed -i '' 's/k/j/' cfg.yml" })) as Promise<CallResult>; // a bare name in the cwd
    await answerNth(store, run_id, "denied", 2);
    expect((await bare).isError).toBe(true);
    expect(cardTexts(store).join("\n")).toContain(`Why: ${MASKED_READ_REASON}`);
    expect(((await handle(call("bash", { command: "cat other.yml" }))) as CallResult).isError).toBe(false);
  });
  it("a new file whose parent directory holds a masked file is not masked (only the file itself)", async () => {
    const { handle, turn, home } = setup();
    turn.maskedPaths = new Set([maskedKey(join(home, "cfg.yml"))]);
    expect(await handle(gate("write", join(home, "new.yml")))).toEqual({ decision: "allow" });
  });
});

describe("a mask is never written back (2b-i final review A10)", () => {
  // the transcript keeps the masked copy of a read; a later write/edit or shell command carrying it would save the mask over real values
  it("a built-in write whose content, or an edit whose new_string, holds the mask takes the masked redirect (no masked path needed)", async () => {
    const { handle, home, events } = setup();
    const write: BridgeRequest = { id: `r${++seq}`, kind: "gate", tool: "write", input: { path: join(home, "cfg.yml"), content: `api_key: ${SECRET_MASK}\n` }, toolCallId: `g${seq}` };
    expect(await handle(write)).toEqual({ decision: "deny", reason: MASKED_WRITE_REDIRECT });
    expect(events("tool_finished").at(-1)).toMatchObject({ status: "denied", reason: MASKED_REDIRECT_CODE });
    const edit: BridgeRequest = { id: `r${++seq}`, kind: "gate", tool: "edit", input: { path: join(home, "cfg.yml"), old_string: "k: v", new_string: `k: ${SECRET_MASK}` }, toolCallId: `g${seq}` };
    expect(await handle(edit)).toEqual({ decision: "deny", reason: MASKED_WRITE_REDIRECT });
    const key: BridgeRequest = { id: `r${++seq}`, kind: "gate", tool: "write", input: { path: join(home, "id"), content: KEY_MASK }, toolCallId: `g${seq}` };
    expect(await handle(key)).toEqual({ decision: "deny", reason: MASKED_WRITE_REDIRECT });
  });
  it("a bash command holding the mask asks with MASKED_READ_REASON", async () => {
    const { handle, store, run_id } = setup({ env: { HOUGE_TRUST_ASK_TTL_MS: "60000" } });
    const p = handle(call("bash", { command: `printf '${SECRET_MASK}' > x` })) as Promise<CallResult>;
    await answerNth(store, run_id, "denied");
    expect((await p).isError).toBe(true);
    expect(cardTexts(store).join("\n")).toContain(`Why: ${MASKED_READ_REASON}`);
  });
  it("accepted residual: a mask-free write to a file masked in an EARLIER turn is not asked (maskedPaths lives one turn)", async () => {
    const { handle, home } = setup();
    const write: BridgeRequest = { id: `r${++seq}`, kind: "gate", tool: "write", input: { path: join(home, "cfg.yml"), content: "api_key: rotated\n" }, toolCallId: `g${seq}` };
    expect(await handle(write)).toEqual({ decision: "allow" });
  });
});

describe("report applied and the todo row (spec §2.5)", () => {
  it("a report for an ungated todo writes a counts-only tool_finished builtin:todo with a loop_step; its content never reaches the ledger", async () => {
    const { handle, events } = setup();
    await handle({ id: "p1", kind: "report", toolCallId: "t1", tool: "todo", outcome: "succeeded", bytes_out: 6, duration_ms: 3 });
    expect(events("tool_finished").at(-1)).toMatchObject({ tool_call_id: "t1", tool: "builtin:todo", status: "succeeded", bytes_out: 6 });
    expect(events("loop_step").at(-1)).toMatchObject({ action: "builtin:todo", capability: "todo", ok: true });
  });
  it("a report with an unknown id and no tool is still a no-op", async () => {
    const { handle, events } = setup();
    await handle({ id: "p2", kind: "report", toolCallId: "zz", outcome: "succeeded", bytes_out: 1, duration_ms: 1 });
    expect(events("tool_finished")).toEqual([]);
  });
});

describe("settle dispatch", () => {
  it("memoises per run and fire; calls onSendBack before answering; with no settle dep answers sendBack: false", async () => {
    const calls: string[] = [];
    const { handle, turn } = setup({ settle: async (_t, r) => { calls.push(`settle:${r.stop_hook_active}`); return r.stop_hook_active ? { sendBack: false } : { sendBack: true, note: "N", kind: "jev" }; } });
    turn.onSendBack = (kind, text) => { calls.push(`onSendBack:${kind}:${text}`); };
    const first = { id: "s1", kind: "settle" as const, stop_hook_active: false, text: "done" };
    expect(await handle(first)).toEqual({ sendBack: true, note: "N" });
    expect(await handle({ ...first, id: "s2" })).toEqual({ sendBack: true, note: "N" });
    expect(await handle({ id: "s3", kind: "settle", stop_hook_active: true, text: "" })).toEqual({ sendBack: false });
    expect(calls).toEqual(["settle:false", "onSendBack:jev:done", "settle:true"]);
    const bare = setup();
    expect(await bare.handle(first)).toEqual({ sendBack: false });
  });
});
