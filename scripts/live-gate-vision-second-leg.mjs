// Live gate for the Vision role's second leg (Paco 2026-11-12, tasks/todo.md P0a). One real photo through the real
// ingest step (`ingestMedia`, the reader prompt and schema the daemon uses) and the real omp one-shot seat (profile
// `houge`). The list is the one the daemon would run: the code's Vision legs, resolved against omp's live catalog over
// tier heads that have a previous head, as the live `model_tiers` rows did on 2026-11-12 (two Gemini selectors, then
// Kimi's). Every google-antigravity selector's model id is then replaced by one omp must refuse (`model_missing`, a
// retryable kind).
// PASS = every refused leg is audited as an error, the first kimi-code selector answers ok, and the ingest step returns
// a reader digest that carries the code rendered into the image. A list with no Kimi leg, a catalog that no longer
// lists Kimi's model, or a Kimi answer the reader schema rejects all fail here.
// The normal case, a photo read on the first leg, is live-gate-media.mjs's photo turn; run that gate too.
// What this does not prove: how omp words a suspended Antigravity account (a 403 reads as `auth` and walks like this;
// an error with no status code reads as `other` and ends the call), nor a Gemini leg that hangs (ADR 0032 section 10).
// In-memory store; never opens houge.sqlite. One catalog read and up to three subscription calls. Needs ffmpeg and
// omp. Build first.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadHougeEnv } from "../dist/config/load-env.js";

loadHougeEnv();
const data = mkdtempSync(join(tmpdir(), "hg-vision2-"));
process.env.HOUGE_DAEMON_TMP_DIR = join(data, "daemon-tmp"); // set before the first daemonTmpRoot() call

const { RunStore } = await import("../dist/run/run-store.js");
const { buildMediaCall, ingestMedia } = await import("../dist/media/media-ingest.js");
const { resolveRole, staticRoleChains } = await import("../dist/omp/model-roles.js");
const { tierHeadsOf } = await import("../dist/omp/model-tiers.js");
const { readOmpCatalog } = await import("../dist/omp/model-catalog.js");
const { resolveOmpConfig } = await import("../dist/omp/omp-config.js");
const { formatModelString } = await import("../dist/omp/model-string.js");
const { composeSystemPrompt, memoryRootFor } = await import("../dist/prompt/composer.js");

const CODE = "5823";
const RUN = "run_gate_vision2";
const DIGEST_MARK = "[external source — untrusted-derived summary]";
const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env")));
const failures = [];
let inconclusive = null;
const store = RunStore.openInMemory();
try {
  const jpeg = join(data, "probe.jpg");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=640x200", "-vf",
    `drawtext=text='HOUGE PROBE ${CODE}':fontsize=48:fontcolor=black:x=60:y=80`, "-frames:v", "1", jpeg]);
  const bytes = readFileSync(jpeg);

  const cfg = resolveOmpConfig(process.env, staticRoleChains());
  const catalog = await readOmpCatalog(cfg);
  if (catalog === null) throw new Error("omp's catalog could not be read");
  // The heads the live model_tiers rows held on 2026-11-12: each tier with an adopted and a previous head.
  const tiers = tierHeadsOf([
    { tier: "gemini-flash", adopted: "gemini-3.8-flash", previous: "gemini-2.5-flash" },
    { tier: "kimi", adopted: "k3.1-pro", previous: "k3" }
  ]);
  const listed = resolveRole({ role: "vision", catalog, override: null, refused: new Set(), mode: "resolved", tiers });
  const firstKimi = listed.find((m) => m.provider === "kimi-code");
  if (!firstKimi) throw new Error(`Vision resolves to no kimi-code selector against the live catalog: ${listed.map(formatModelString).join(", ") || "empty"}`);
  const media = listed.map((m, i) => (m.provider === "google-antigravity" ? { ...m, model: `no-such-model-houge-gate-${i}` } : m));
  const refusedCount = media.indexOf(firstKimi);
  console.log(`vision list under test: ${media.map(formatModelString).join(" -> ")}`);

  const r = await ingestMedia({
    downloadFile: async () => ({ bytes }),
    mediaCall: buildMediaCall({ store, run_id: RUN, kind: "photo", env: process.env, chains: { ...staticRoleChains(), media } }),
    readerSystem: composeSystemPrompt(memoryRootFor(repo), "reader")
  }, { kind: "photo", file_id: "gate", file_unique_id: "gate", mime_type: "image/jpeg", has_caption: true, file_size: bytes.length, width: 640, height: 200 },
  "what text is in this image?");
  const rows = store.getLedgerEvents(RUN).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload);
  console.log(`attempts: ${rows.map((a) => `${a.provider}/${a.model}:${a.outcome}${a.error_kind ? `(${a.error_kind})` : ""}`).join(", ") || "none"}`);
  console.log(`ingest: ${r.ok ? "ok" : `failed (${r.status})`}; ledger=${JSON.stringify(r.ledger)}`);

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
    if (!r.ok) failures.push(`the ingest step failed: ${r.status}`);
    else {
      if (!r.text.includes(DIGEST_MARK)) failures.push("the turn text is not the reader digest");
      if (!r.text.includes(CODE)) failures.push("the digest does not carry the rendered code");
      if (r.ledger.provider !== "kimi-code") failures.push(`media_ingested names ${r.ledger.provider}, not kimi-code`);
    }
  }
} catch (e) {
  failures.push(`gate error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  store.close();
  rmSync(data, { recursive: true, force: true });
}

if (inconclusive) { console.log(`INCONCLUSIVE: ${inconclusive}`); process.exit(2); }
if (failures.length > 0) { for (const f of failures) console.log(`FAIL: ${f}`); process.exit(1); }
console.log("PASS: a photo whose Gemini legs are refused is ingested through the Kimi leg, digest and all");
