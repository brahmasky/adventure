import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { GrowFields } from "../../src/grow/checks.js";
import { GrowService, type ReviewRecord, type SubmitCtx } from "../../src/grow/service.js";
import { GrowZone } from "../../src/grow/zone.js";
import { RunStore } from "../../src/run/run-store.js";

const dirs: string[] = []; const stores: RunStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });   // git may still be finishing auto-maintenance
export const mkTmp = (): string => { const d = mkdtempSync(join(tmpdir(), "grow-")); dirs.push(d); return d; };
export const growBody = (n: number, tag = ""): string => Array.from({ length: n }, (_, i) => `${i + 1}. Step ${i + 1} of the procedure, written out in full${tag}.`).join("\n");
export const growFields = (over: Partial<GrowFields> = {}): GrowFields => ({ name: "unit-convert", description: "converting recipe amounts between metric and US cups", example: "convert 2 cups of flour to grams", body: growBody(40), ...over });
export const PASS: ReviewRecord = { pass: true, findings: [], reviewer_model: "kimi-code/k3", input_hash: "a".repeat(64), author_families: ["claude"], undo_reasons_n: 0, code: "review_passed" };
export const CLEAN: SubmitCtx = { run_id: "run_1", chat_id: "555", level: "clean" };
export async function growSetup(env: NodeJS.ProcessEnv = {}) {
  const dir = mkTmp();
  const store = RunStore.openInMemory(); stores.push(store);
  const zone = new GrowZone(join(dir, "grow")); await zone.ensure(true);
  let t = Date.parse("2026-11-10T10:00:00.000Z");
  const now = (): string => new Date((t += 1000)).toISOString();
  const svc = new GrowService({ store, zone, env, now });
  /** Submit, pass review, publish: the only way a new skill goes live. */
  const live = async (f: GrowFields, ctx: SubmitCtx = CLEAN): Promise<void> => {
    await svc.submit(f, ctx);
    const row = store.listGrowStaged("staged").find((r) => r.name === f.name);
    if (row) { svc.recordReview(row.id, PASS); await svc.publishStaged(row.id); }
  };
  return { dir, store, zone, svc, live, now };
}

/** A small edit (one line of forty): under the small-update rule. */
export const small = (f: GrowFields): GrowFields => ({ ...f, body: f.body.replace("Step 3 of", "Step three of") });

/** Row count of a table, for "no operation was created" style assertions the store has no method for. */
export const countRows = (store: RunStore, table: "grow_ops" | "grow_versions" | "grow_reviews" | "grow_staged"): number =>
  (store as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const git = (zone: GrowZone, args: string[]): string => execFileSync("git", ["--git-dir", join(zone.dir, ".git"), "--work-tree", zone.dir, ...args], { encoding: "utf8" }).trim();
export const commitCount = (zone: GrowZone): number => Number(git(zone, ["rev-list", "--count", "HEAD"]));
export const headMessage = (zone: GrowZone): string => git(zone, ["log", "-1", "--format=%B"]);
/** Commits whose message carries exactly this operation's trailer line. */
export const commitsForOp = (zone: GrowZone, opId: string): number =>
  git(zone, ["log", "--format=%B%x1e"]).split("\x1e").filter((b) => b.split("\n").some((l) => l.trimEnd() === `Grow-Op: ${opId}`)).length;
/** Makes the skill's folder a regular file, so the next write of that name fails before any commit. `restoreToHead` removes it again. */
export const blockWrite = (zone: GrowZone, name: string): void => {
  mkdirSync(join(zone.dir, "skills"), { recursive: true });                // `git clean` drops the empty folder
  writeFileSync(join(zone.dir, "skills", name), "blocker");
};
