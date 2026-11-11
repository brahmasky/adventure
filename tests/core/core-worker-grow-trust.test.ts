import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TurnTrust } from "../../src/decisions/trust.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

// ADR 0035 G4 at the worker: a hostile turn's grow_submit is refused `turn_hostile` by the worker's own preflight, before
// any trust ask, so no tap can put a hostile turn's skill live; an untrusted turn submits with no card (the service marks
// the skill born untrusted, unit 8c). The level comes from the live turn first (amendment 2: TurnTrust swallows a failed
// ledger write, so a ledger-only read could fail open), the ledger otherwise.

pinOmpEnv();
pinEnabledFlags();
const PINNED = ["HOUGE_TOMBSTONE_PATH", "HOUGE_PARK_MARKER_PATH", "HOUGE_DISARM_PATH", "HOUGE_TRUST_ASK_TTL_MS"] as const;
const SUBMIT = { name: "web-notes", description: "notes on a page", example: "summarise this page", body: "1. Read the page." };
const saved: Record<string, string | undefined> = {};
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => {
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = shortTmp("hgt-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.HOUGE_PARK_MARKER_PATH = join(tmp.dir, "houge.parked");
  process.env.HOUGE_DISARM_PATH = join(tmp.dir, "houge.disarm");
  process.env.HOUGE_TRUST_ASK_TTL_MS = "50"; // a card that does open (a regression) expires at once instead of hanging the test
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
  tmp.cleanup();
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

let seq = 0;
function intake(): string {
  const r = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "remember how to summarise this page", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `t:grow:${++seq}`, source_reference: `telegram:update:${seq}:message:1`
  }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}
const trustFor = (run_id: string) => new TurnTrust({ store, run_id, chat_id: "555", born: "telegram", env: process.env });

/** A bridge turn holding a real TurnTrust, set up by `prime` (a raise or a carry) before any call. */
function turnWith(prime: (t: TurnTrust) => void) {
  const run_id = intake();
  const t = bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }), run_id, tmp.dir);
  const trust = trustFor(run_id);
  Object.assign(t.turn, { trust }); // ActiveTurn.trust is readonly; the supervisor sets it when it builds the turn
  prime(trust);
  const cards = () => store.getLedgerEvents(run_id).filter((e) => e.event_type === "approval_requested");
  return { ...t, run_id, cards };
}

describe("grow_submit under the trust rule, through the worker's preflight (ADR 0035 G4)", () => {
  it("a hostile turn is refused turn_hostile and opens no card", async () => {
    const t = turnWith((tr) => tr.raise("injection_withheld"));
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("REFUSED turn_hostile");
    expect(t.cards()).toEqual([]);
  });
  it("an untrusted turn reaches the executor with no card", async () => {
    const t = turnWith((tr) => tr.raise("wall_read"));
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.isError).toBe(false);
    expect(r.content).not.toContain("turn_hostile");
    expect(t.cards()).toEqual([]);
  });
  it("a turn that only carries hostile text from the last turn is refused (the text is still in the planner's context)", async () => {
    const t = turnWith((tr) => tr.carry("hostile"));
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.content).toContain("turn_hostile");
    expect(t.cards()).toEqual([]);
  });
  it("a turn that carries untrusted text is not carded", async () => {
    const t = turnWith((tr) => tr.carry("untrusted"));
    const r = await t.call("grow_submit", SUBMIT);
    expect(r.content).not.toContain("turn_hostile");
    expect(t.cards()).toEqual([]);
  });
  it("grow_read is never refused or carded, even on a hostile turn", async () => {
    const t = turnWith((tr) => tr.raise("injection_withheld"));
    const r = await t.call("grow_read", { name: "web-notes" });
    expect(r.content).not.toContain("turn_hostile");
    expect(t.cards()).toEqual([]);
  });
});

describe("the preflight's level source: the live turn first, the ledger otherwise (amendment 2)", () => {
  const tools = () => {
    const run_id = intake();
    const claim = store.claimRun(run_id, `planner:test:${run_id}`, 120);
    if (!claim) throw new Error("claim failed");
    return { run_id, tools: ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }).buildOmpTools(claim) };
  };
  it("a bound getter answering hostile refuses even when the ledger holds no turn_trust row (a lost ledger write cannot fail open)", () => {
    const { run_id, tools: x } = tools();
    x.bindTrust(() => "hostile");
    expect(store.getLedgerEvents(run_id).filter((e) => e.event_type === "turn_trust")).toEqual([]);
    expect(x.preflight("grow_submit", SUBMIT)).toMatchObject({ refused: { reason: "turn_hostile" } });
  });
  it("a bound getter answering untrusted lets the call through", () => {
    const { tools: x } = tools();
    x.bindTrust(() => "untrusted");
    expect(x.preflight("grow_submit", SUBMIT)).toBeNull();
  });
  it("unbound, the ledger decides: clean passes, a hostile row refuses", () => {
    const { run_id, tools: x } = tools();
    expect(x.preflight("grow_submit", SUBMIT)).toBeNull();
    trustFor(run_id).raise("injection_withheld");
    expect(x.preflight("grow_submit", SUBMIT)).toMatchObject({ refused: { reason: "turn_hostile" } });
  });
});
