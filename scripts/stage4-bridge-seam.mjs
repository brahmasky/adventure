// The bridge seam shared by the command and path corpora (spec 2026-10-29 §6 items 1-2): a real bridge handler of one dist over a temp
// store with one running run, driven the way tests/omp/bridge-handler.test.ts drives it. Not a corpus (the CLI loads scripts/stage4-corpora/*.mjs only).
// Nothing here executes a command: the shell capabilities are stubs; an approval card is created by the real runner and denied at once.
import { join } from "node:path";
import { closers, mkStore, mkTemp } from "./stage4-diff-lib.mjs";

// Fixed synthetic roots: the same strings on every dist, so gateTargets output and protected-path answers compare byte for byte.
export const ROOTS = { home: "/houge-s4d/home", repo: "/houge-s4d/repo", data: "/houge-s4d/data", cwd: "/houge-s4d/home/work" };
const ENVELOPE = ["web_search", "fs_read", "fs_write", "shell", "shell_external", "shell_destructive", "write_report"];
const seams = new WeakMap();
const PASS_JUDGE = async (i) => ({ text: i.text, verdict: "pass", withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 0, unanswered: 0,
  skipped: false, blocked: null, decisionId: null, masked: 0 });

const meta = (name, side_effect_level, execute) => ({ name, category: "tool", side_effect_level, risk_level: "low", timeout_ms: 5_000,
  output_limit_bytes: 64_000, ...(execute ? { execute } : {}) });

function buildRegistry(d) {
  const registry = new d.ToolRegistry();
  const stub = async () => ({ ok: true, output: { exit_code: 0, output: "stub", truncated: false } }); // never runs the command
  registry.register(meta("shell", "local_write", stub));
  registry.register(meta("shell_external", "external_write", stub));
  registry.register(meta("shell_destructive", "destructive", stub));
  registry.register(meta("fs_read", "none"));
  registry.register(meta("fs_write", "local_write"));
  return registry;
}

function buildTurn(d, store, run_id, claim) {
  const contract = { ...claim.contract, allowed_actions: ENVELOPE, forbidden_actions: ["coding_agent_cli", "paid_action"],
    approval_gates: ["external_write", "destructive", "paid"], budget: { ...claim.contract.budget, max_tool_calls: 1_000_000 } };
  return { run_id, worker_id: "planner:c:a", chat_id: "555", requester: { kind: "user", id: "1" }, contract, budget: new d.BudgetLedger(contract.budget),
    registry: buildRegistry(d), signal: new AbortController().signal, cwd: ROOTS.cwd, step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: async (tool) => ({ digest: "summary", contains_instructions: false, source_meta: { tool, bytes: 0 } }),
    setAwaitingApproval: () => undefined, postureOk: () => null, judge: PASS_JUDGE };
}

/**
 * Positive evidence that the bridge ran its decision path on a call whose default verdict leaves no row. The bridge builds its own
 * storeRecorder(deps.store) inline (no factory to wrap), and the recorder's only store read before its default-verdict filter is
 * latestDecisionVerdict for tool.policy: so a spy on the store the bridge holds sees every call that reached the runner's (command)
 * or the gate's (path) tool.policy decision, i.e. had already passed summaryFor's classification / the tool.path decision.
 */
function probed(store, seam) {
  return new Proxy(store, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if (k !== "latestDecisionVerdict") return typeof v === "function" ? v.bind(t) : v;
    return (run, call, entry) => { if (call) seam.reached.set(call, new Set([...(seam.reached.get(call) ?? []), entry])); return v.call(t, run, call, entry); };
  } });
}
/** True when the call reached the entry's recorder stage (see probed). */
export const reachedPolicy = (seam, toolCallId) => seam.reached.get(toolCallId)?.has("tool.policy") === true;

/** One seam per dist object (reused across items and corpora; ids never repeat), built on first use. */
export function seamFor(d, name) {
  if (seams.has(d)) return seams.get(d);
  const store = mkStore(d, "bare", join(mkTemp(`seam-${name}`), "seam.sqlite"));
  const intake = new d.Gateway(store).intake(d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "hello",
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "s4d:seam", source_reference: "telegram:update:1:message:1" }));
  if (!intake.ok) throw new Error(`seam intake failed for ${name}`);
  const claim = store.claimRun(intake.run_id, "planner:c:a", 3600);
  if (!claim) throw new Error(`seam claim failed for ${name}`);
  const turn = buildTurn(d, store, intake.run_id, claim);
  const decls = d.loadToolDeclarations(d.TOOL_DECLS_DIR);
  if (!decls.ok) throw new Error(`seam tool declarations: ${decls.error}`);
  const seam = { d, store, run_id: intake.run_id, n: 0, reached: new Map(), hook: null };
  const handle = d.createBridgeHandler({ store: probed(store, seam), cfg: d.resolveOmpConfig({}), ctx: { ...ROOTS }, decls: decls.decls, env: {}, turnEnvelopeActions: ENVELOPE, activeTurn: () => turn });
  seam.handle = handle;
  seams.set(d, seam);
  return seam;
}

const tick = () => new Promise((r) => setImmediate(r));
/** The decision rows one entry wrote for one call, as {verdict, reason_code}; null when this build records none for the entry. */
export function rowsFor(seam, entryId, toolCallId) {
  if (typeof seam.store.listDecisionsForRun !== "function") return null;
  const rows = seam.store.listDecisionsForRun(seam.run_id).filter((r) => r.entry_id === entryId && r.tool_call_id === toolCallId);
  return rows.length ? rows.map((r) => ({ verdict: r.verdict, reason_code: r.reason_code })) : null;
}

/** The card's `Action:` line, read from the approval prompt the real runner queued for this approval. */
function cardAction(seam, approvalId) {
  for (let i = 0; i < 1000; i += 1) {
    const rec = seam.store.claimNextNotification("s4d", 60);
    if (!rec) return null;
    if (rec.approval_id === approvalId) return /^Action: (.*)$/m.exec(String(rec.payload?.text ?? ""))?.[1] ?? null;
  }
  return null;
}

/** A bash call through the bridge: asked (a card was created), the card's Action label, the call's outcome, and the tool.shell_class rows. */
export async function bashCall(d, name, command) {
  const seam = seamFor(d, name);
  const id = `s4d-${++seam.n}`;
  let settled = null;
  const done = seam.handle({ id: `r${seam.n}`, kind: "call", tool: "bash", input: { command }, toolCallId: id }).then((r) => { settled = { r }; return settled; }, (e) => { settled = { e }; return settled; });
  let approvalId = null;
  for (let i = 0; i < 20_000 && !settled && !approvalId; i += 1) { await tick(); approvalId = seam.store.listPendingApprovalIds()[0] ?? null; }
  if (!settled && !approvalId) throw new Error("bridge call neither settled nor asked");
  const label = approvalId ? cardAction(seam, approvalId) : null;
  if (approvalId) { seam.store.resolveToolApprovalForTest(approvalId, "denied"); d.toolApprovalWaiters.resolve(approvalId, "denied"); }
  const out = await done;
  return { asked: approvalId !== null, label, outcome: out.e ? "threw" : out.r.isError ? "error" : "ok", result: out.e ? null : out.r.isError ? out.r.content : "ok",
    row: rowsFor(seam, "tool.shell_class", id), reached: reachedPolicy(seam, id) };
}

/** A built-in read/write gate through the bridge: the handler's answer (decision + reason) and the tool.path rows. */
export async function gateCall(d, name, tool, input) {
  const seam = seamFor(d, name);
  const id = `s4d-${++seam.n}`;
  const answer = await seam.handle({ id: `r${seam.n}`, kind: "gate", tool, input, toolCallId: id });
  return { answer, row: rowsFor(seam, "tool.path", id), reached: reachedPolicy(seam, id) };
}

/** Starts (once per dist) a real bridge socket on the seam's handler and installs the dist's real policy hook on a fake pi. */
async function hookFor(seam, name) {
  if (seam.hook) return seam.hook;
  const d = seam.d;
  const sock = join(mkTemp(`sock-${name}`), "b.sock");
  const token = `s4d-${name}`;
  const hook = { sock, token, sent: null, handlers: new Map() };
  const server = await d.BridgeServer.listen(sock, token, (req) => { if (req.kind === "gate") hook.sent = req.input; return seam.handle(req); });
  closers.push(() => server.close()); // closed by the CLI's finally (runClosers), not by process.exit
  await d.hougePolicy({ on: (ev, fn) => hook.handlers.set(ev, fn) });
  seam.hook = hook;
  return hook;
}

/**
 * A built-in tool call through the dist's REAL policy hook (extension houge-policy: pathsRefusal, gateInput, editTargets), over a
 * real bridge socket into the real handler. Returns what the hook sent to the bridge (the derived targets), the hook's verdict, and the rows.
 */
export async function hookCall(d, name, tool, input) {
  const seam = seamFor(d, name);
  const hook = await hookFor(seam, name);
  Object.assign(process.env, { HOUGE_BRIDGE_SOCK: hook.sock, HOUGE_BRIDGE_TOKEN: hook.token });
  const id = `s4d-${++seam.n}`;
  hook.sent = null;
  const verdict = await hook.handlers.get("tool_call")({ toolName: tool, toolCallId: id, input });
  return { sent: hook.sent, verdict: verdict ?? { allow: true }, row: rowsFor(seam, "tool.path", id), reached: reachedPolicy(seam, id) };
}
