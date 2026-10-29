// Stage 4B differential, policy matrix (spec 2026-10-29 §6 item 3). Each item is projected two ways: the pure decideCapability answer
// ({decision, reason, standing?}) and a real CapabilityRunner.execute run over a temp store with a recorder and a stub approval sink, giving the
// result, the `tool.policy` row (verdict, reason code) after one call and after a repeat of the same call (the dedup), and the row count.
//
// Capability shapes (source): the runtime's omp registry, i.e. what CoreWorker.buildOmpTools registers (core-worker.ts:2476-2494) from
// OMP_SHELL_META (3), OMP_BUILTIN_META (2) and OMP_LOOP_TOOL_META (15) of core/omp-turn-wiring, read from the NEW dist (data, never code under
// test), plus `coding_agent_cli` (category coding_agent_cli, external_read/medium: the self-diagnose registration, core-worker.ts:1287). The
// registry cannot be exported (buildOmpTools is a CoreWorker method needing a claimed run), hence the metas.
//
// Dimensions: capability x contract list {allowed, forbidden, neither} x approval_gates {empty, [its level]} x trust_ask {absent, true} x
// standing {absent, present-but-not-won, present-and-won}. The spec's "coding_agent delegation {allowed, not}" is the list dimension on the
// coding_agent_cli capability (allowed_actions contains it or not); no other capability has that category.
// Pairs: standing absent -> s3 and s4a vs new (548cb87's runner has no recorder and no standing, so only the decision and result are compared there:
// the row keys are __s3Omit); standing present -> s4a only (548cb87 predates standing).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SetupError } from "../stage4-diff-lib.mjs";
import { REPO_ROOT } from "../stage4-sources.mjs";
import { policyRun } from "../stage4-policy-fixture.mjs";

const CODING_AGENT = { name: "coding_agent_cli", category: "coding_agent_cli", side_effect_level: "external_read", risk_level: "medium" };
const LISTS = ["allowed", "forbidden", "neither"];
const STANDING = ["absent", "mismatch", "won"];

function capabilities(d) {
  const tool = (metas) => Object.entries(metas).map(([name, m]) => ({ name, category: "tool", side_effect_level: m.side_effect_level, risk_level: m.risk_level }));
  return [...tool(d.OMP_SHELL_META), ...tool(d.OMP_BUILTIN_META), ...tool(d.OMP_LOOP_TOOL_META), CODING_AGENT];
}

/** The decision input for one cell. `forbidden` also lists the capability as allowed, the harshest contract shape (forbidden must win). */
export function inputFor(cap, cell) {
  const allowed = cell.list === "neither" ? ["other_capability"] : [cap.name];
  return { capability: cap.name, category: cap.category, side_effect_level: cap.side_effect_level, risk_level: cap.risk_level,
    allowed_actions: allowed, forbidden_actions: cell.list === "forbidden" ? [cap.name] : [], approval_gates: cell.gate ? [cap.side_effect_level] : [],
    ...(cell.trust ? { trust_ask: true } : {}), ...(cell.standing !== "absent" ? { standing: { standing_id: "sa_matrix" } } : {}) };
}

/** What the run should record, derived from the pure decision plus the runner's standing rule (CAS won only in the clean room with a winning sink). */
export function expectedRow(d, cap, cell) {
  const dec = d.decideCapability(inputFor(cap, cell));
  const final = dec.standing && cell.standing === "won" ? { decision: "allow", reason: d.STANDING_REASON }
    : dec.standing ? { decision: "requires_approval", reason: d.STANDING_MISMATCH_REASON } : dec;
  const code = REASON_CODES[final.reason];
  return { verdict: final.decision === "allow" ? "allowed" : final.decision === "deny" ? "denied" : "requires_approval", reason_code: code };
}

const REASON_CODES = {};
function loadReasonCodes(d) {
  Object.assign(REASON_CODES, { "Capability forbidden by task contract": "forbidden", "Coding-agent CLI delegation is not allowed by this task contract": "coding_agent_cli_not_allowed",
    "Capability not allowed by task contract": "capability_not_allowed", "Capability has gated side effects": "gated_side_effect", [d.TRUST_ASK_REASON]: "trust_ask",
    [d.STANDING_REASON]: "standing", [d.STANDING_MISMATCH_REASON]: "standing_mismatch", "Capability allowed by task contract": "allowed" });
  const src = readFileSync(join(REPO_ROOT, "src/decisions/entries/tool-policy.ts"), "utf8");
  const block = /const REASON_MAP[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  const keys = block.split("\n").filter((l) => /^\s+("|\[)/.test(l)).length;
  const codes = d.TOOL_POLICY.reasonCodes;
  if (keys !== codes.length || keys !== Object.keys(REASON_CODES).length || !codes.every((c) => Object.values(REASON_CODES).includes(c))) {
    throw new SetupError(`REASON_MAP in tool-policy.ts has ${keys} keys; the dist lists ${codes.length} reason codes and this corpus maps ${Object.keys(REASON_CODES).length}`);
  }
  return codes;
}

const cells = () => LISTS.flatMap((list) => [false, true].flatMap((gate) => [false, true].flatMap((trust) => STANDING.map((standing) => ({ list, gate, trust, standing })))));
const cellName = (c) => `${c.list}|gate_${c.gate ? "on" : "off"}|trust_${c.trust ? "on" : "off"}|st_${c.standing}`;

export default {
  name: "policy",
  pairs: (item) => (item.cell.standing === "absent" ? [["s3", "new"], ["s4a", "new"]] : [["s4a", "new"]]),
  min: { items: 21 * 36, branches: [] },
  async load(ctx) {
    const d = ctx.dists.new;
    const codes = loadReasonCodes(d);
    this.min.branches = [...codes, "list_allowed", "list_forbidden", "list_neither", "st_absent", "st_mismatch", "st_won", "gate_on", "gate_off", "trust_on", "trust_off", "cat_tool", "cat_coding_agent_cli"];
    return capabilities(d).flatMap((cap) => cells().map((cell) => ({ key: `${cap.name}|${cellName(cell)}`, cap, cell,
      tags: [expectedRow(d, cap, cell).reason_code, `list_${cell.list}`, `st_${cell.standing}`, `gate_${cell.gate ? "on" : "off"}`, `trust_${cell.trust ? "on" : "off"}`, `cat_${cap.category}`] })));
  },
  async project(d, item) {
    const input = inputFor(item.cap, item.cell);
    const run = await policyRun(d, item.cap, input, item.cell.standing === "won");
    // rows / rowCount / repeatCount: 548cb87's runner has no recorder, so those keys exist on the s3 pair only as absent data (compared on s4a -> new)
    return { pure: d.decideCapability(input), result: run.result, rows: run.rows, rowCount: run.rowCount, repeatCount: run.repeatCount, __s3Omit: ["rows", "rowCount", "repeatCount"] };
  },
  required(d, item, proj) {
    const want = expectedRow(d, item.cap, item.cell);
    const bad = [];
    if (proj.rowCount !== 1) bad.push(`tool.policy rows after one call: ${proj.rowCount}, need 1`);
    if (proj.repeatCount !== 1) bad.push(`tool.policy rows after the repeat call: ${proj.repeatCount}, need 1 (dedup)`);
    if (proj.rows?.[0]?.verdict !== want.verdict || proj.rows?.[0]?.reason_code !== want.reason_code) bad.push(`row ${JSON.stringify(proj.rows?.[0])}, expected ${JSON.stringify(want)}`);
    if (bad.length) throw new Error(bad.join("; "));
  }
};
