// Live gate for the Vision role's second leg (Paco 2026-11-12, tasks/todo.md P0a). One real photo read through the
// real omp one-shot seat (profile `houge`), on the list the daemon runs: the code's Vision legs resolved over tier heads
// that have a previous head, as the live `model_tiers` rows do (two Gemini selectors, then Kimi's). Every
// google-antigravity selector's model id is replaced by one omp must refuse (`model_missing`, a retryable kind).
// PASS = every refused leg is audited as an error, the first kimi-code selector the code lists answers ok, and the
// answer carries the code rendered into the image. A list without a Kimi leg fails here.
// The normal case, a photo read on the first leg, is line 105-112 of live-gate-media.mjs; run that gate too.
// What this does not prove: how omp words a suspended Antigravity account. A 403 reads as `auth` and walks like this;
// an error with no status code reads as `other` and ends the call (ADR 0032 section 10).
// In-memory store; never opens houge.sqlite. Up to three subscription calls. Needs ffmpeg and omp. Build first.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHougeEnv } from "../dist/config/load-env.js";

loadHougeEnv();
const data = mkdtempSync(join(tmpdir(), "hg-vision2-"));
process.env.HOUGE_DAEMON_TMP_DIR = join(data, "daemon-tmp"); // set before the first daemonTmpRoot() call

const { daemonTmpRoot } = await import("../dist/run/daemon-tmp.js");
const { RunStore } = await import("../dist/run/run-store.js");
const { buildMediaCall, PHOTO_BARE_OBJECTIVE } = await import("../dist/media/media-ingest.js");
const { roleSelectors, staticRoleChains } = await import("../dist/omp/model-roles.js");
const { tierHeadsOf } = await import("../dist/omp/model-tiers.js");
const { formatModelString } = await import("../dist/omp/model-string.js");

const CODE = "5823";
const RUN = "run_gate_vision2";
const failures = [];
let inconclusive = null;
const store = RunStore.openInMemory();
try {
  const mediaDir = mkdtempSync(join(daemonTmpRoot(), "houge-media-"));
  const file = join(mediaDir, "media.jpg");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=640x200", "-vf",
    `drawtext=text='HOUGE PROBE ${CODE}':fontsize=48:fontcolor=black:x=60:y=80`, "-frames:v", "1", file]);

  // The heads the live model_tiers rows held on 2026-11-12: each tier with an adopted and a previous head.
  const heads = tierHeadsOf([
    { tier: "gemini-flash", adopted: "gemini-3.8-flash", previous: "gemini-2.5-flash" },
    { tier: "kimi", adopted: "k3.1-pro", previous: "k3" }
  ]);
  const listed = roleSelectors("vision", undefined, "resolved", heads);
  const firstKimi = listed.find((m) => m.provider === "kimi-code");
  if (!firstKimi) throw new Error(`the Vision legs hold no kimi-code selector: ${listed.map(formatModelString).join(", ")}`);
  const media = listed.map((m, i) => (m.provider === "google-antigravity" ? { ...m, model: `no-such-model-houge-gate-${i}` } : m));
  const refusedCount = media.indexOf(firstKimi);
  console.log(`vision list under test: ${media.map(formatModelString).join(" -> ")}`);

  const call = buildMediaCall({ store, run_id: RUN, kind: "photo", env: process.env, chains: { ...staticRoleChains(), media } });
  const r = await call({ question: PHOTO_BARE_OBJECTIVE, system: "You read an image for another program. Describe it and quote any text in it.", media: { path: file, mime: "image/jpeg" } });
  const rows = store.getLedgerEvents(RUN).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload);
  console.log(`attempts: ${rows.map((a) => `${a.provider}/${a.model}:${a.outcome}${a.error_kind ? `(${a.error_kind})` : ""}`).join(", ") || "none"}`);

  if (rows.length === 0) inconclusive = "no llm_attempt row: the omp check refused or no leg ran";
  else {
    const before = rows.slice(0, refusedCount);
    const served = rows[refusedCount];
    if (refusedCount < 1) failures.push("no google-antigravity selector precedes the Kimi leg: nothing was refused");
    if (before.length !== refusedCount || !before.every((a) => a.provider === "google-antigravity" && a.outcome === "error" && a.error_kind === "model_missing")) failures.push(`the ${refusedCount} refused leg(s) were not each audited as a model_missing error`);
    if (!served) failures.push("no Kimi leg ran");
    else {
      if (served.provider !== "kimi-code" || served.model !== firstKimi.model) failures.push(`the serving leg was ${served.provider}/${served.model}, not kimi-code/${firstKimi.model}`);
      if (served.outcome !== "ok") failures.push(`the Kimi leg ended ${served.outcome}${served.error_kind ? ` (${served.error_kind})` : ""}`);
    }
    if (rows.length > refusedCount + 1) failures.push(`${rows.length} legs ran; expected ${refusedCount + 1}`);
    if (!r.ok) failures.push("the photo call did not return ok");
    else if (!String(r.output?.answer ?? "").includes(CODE)) failures.push("the answer does not carry the rendered code");
    else console.log(`answer carries the code; served by ${r.output.provider}`);
  }
} catch (e) {
  failures.push(`gate error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  store.close();
  rmSync(data, { recursive: true, force: true });
}

if (inconclusive) { console.log(`INCONCLUSIVE: ${inconclusive}`); process.exit(2); }
if (failures.length > 0) { for (const f of failures) console.log(`FAIL: ${f}`); process.exit(1); }
console.log("PASS: a photo whose first Vision leg is refused is read by the Kimi leg");
