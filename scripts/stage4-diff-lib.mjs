// Shared machinery for the Stage 4B differential (spec 2026-10-29 §6): dist loading, temp roots, stores, the fake broker,
// the projection stripper and comparator. Corpora (scripts/stage4-corpora/*.mjs) build on these names; the CLI is
// scripts/check-ladder-stage4-differential.mjs. External inputs are read-only; nothing here reads real secrets or the repo .env.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DISTS = { new: null, s3: null, s4a: null, s4b: null }; // filled by the CLI
export const CORPORA = [];                               // filled by the CLI from scripts/stage4-corpora/*.mjs
/** Async teardown callbacks (a corpus's open sockets); the CLI runs them in a finally, on success and on error alike. */
export const closers = [];
export async function runClosers() {
  for (const fn of closers.splice(0)) { try { await fn(); } catch (e) { console.error(`teardown failed: ${e instanceof Error ? e.message : String(e)}`); } }
}
export const state = { requiredFailures: [], seq: 0, debug: false };

// export name -> compiled module (relative to a dist). A dist that lacks the module or the export yields null.
const EXPORTS = {
  RunStore: "run/run-store.js", CapabilityRunner: "capabilities/capability-runner.js", decideCapability: "policy/capability-policy.js",
  classifyCommand: "omp/command-matcher.js", gateTargets: "omp/gate-path.js", createToolApprovalSink: "omp/tool-approval-sink.js",
  storeOptionsFor: "run/store-options.js", decideSync: "decisions/decide.js", storeRecorder: "decisions/record.js",
  createSecretBroker: "config/secret-broker.js",
  // the bridge seam (scripts/stage4-bridge-seam.mjs): a real bridge handler over a temp store
  Gateway: "gateway/gateway.js", buildTypedTaskEvent: "domain/types.js", BudgetLedger: "budget/budget-ledger.js", ToolRegistry: "tools/tool-registry.js",
  createBridgeHandler: "omp/bridge-handler.js", resolveOmpConfig: "omp/omp-config.js", loadToolDeclarations: "omp/tool-decls.js",
  TOOL_DECLS_DIR: "omp/tool-decls.js", toolApprovalWaiters: "omp/tool-approval-sink.js",
  // the path corpus's protected-path inventory
  secretPaths: "omp/protected-paths.js", protectedRepoPaths: "omp/protected-paths.js", operationalWriteDeny: "omp/protected-paths.js",
  writeRoots: "omp/protected-paths.js",
  // the real policy hook, driven over a real bridge socket (edit/patch targets are derived inside it)
  BridgeServer: "omp/bridge-server.js", hougePolicy: "omp/extension/houge-policy.js",
  // the policy and binding matrices: real capability shapes, the runner's fingerprint, and the run-level worker
  OMP_SHELL_META: "core/omp-turn-wiring.js", OMP_BUILTIN_META: "core/omp-turn-wiring.js", OMP_LOOP_TOOL_META: "core/omp-turn-wiring.js",
  CoreWorker: "core/core-worker.js", actionFingerprint: "capabilities/capability-runner.js", stableHash: "domain/canonical.js",
  TOOL_POLICY: "decisions/entries/tool-policy.js", STANDING_REASON: "policy/capability-policy.js", STANDING_MISMATCH_REASON: "policy/capability-policy.js",
  TRUST_ASK_REASON: "policy/capability-policy.js",
  // Stage 4C: the lesson-write adapter and the correction preflight / executor
  createMemoryWriteAdapter: "capabilities/lesson-write.js", memoryWritePreflight: "capabilities/memory-correct.js",
  executeMemoryCorrect: "capabilities/memory-correct.js", memorySources: "capabilities/memory-sources.js"
};
const distCache = new Map();

/** Every export the corpora need, looked up by name; null when that dist lacks the module or the export (never throws). */
export async function loadDist(dir) {
  if (distCache.has(dir)) return distCache.get(dir);
  const mods = new Map();
  for (const rel of new Set(Object.values(EXPORTS))) {
    try { mods.set(rel, await import(join(dir, rel))); } catch (e) {
      if (e?.code !== "ERR_MODULE_NOT_FOUND" && e?.code !== "ENOENT") throw e;
      mods.set(rel, null);
    }
  }
  const d = { dir };
  for (const [name, rel] of Object.entries(EXPORTS)) d[name] = mods.get(rel)?.[name] ?? null;
  distCache.set(dir, d);
  return d;
}

const temp = { root: null, keep: false };
const STALE_MS = 6 * 3_600_000;
/** True when `<root>/owner.pid` names a live process (EPERM = alive); a missing or unreadable file means no live owner. */
function ownerAlive(root) {
  const f = join(root, "owner.pid");
  if (!existsSync(f)) return false;
  const pid = Number.parseInt(readFileSync(f, "utf8"), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; }
}
/** Removes hg-s4d-* roots under `base` older than 6 hours whose owner is dead (a killed run's leftovers); returns the count. */
function sweepStale(base) {
  let n = 0;
  for (const name of readdirSync(base)) {
    if (!name.startsWith("hg-s4d-")) continue;
    try {
      const p = join(base, name);
      if (Date.now() - statSync(p).mtimeMs <= STALE_MS || ownerAlive(p)) continue;
      rmSync(p, { recursive: true, force: true }); n += 1;
    } catch { /* gone or not ours: not a finding */ }
  }
  return n;
}
/** Opens the run's single temp root (call once, before any mkTemp). */
export function initTemp(keep, base = "/tmp") {
  console.error(`# swept ${sweepStale(base)} stale hg-s4d-* dir(s)`);
  temp.root = mkdtempSync(join(base, "hg-s4d-"));
  writeFileSync(join(temp.root, "owner.pid"), String(process.pid));
  temp.keep = keep;
  return temp.root;
}
/** Removes the run root on every exit path unless --keep. */
export function cleanupTemp() {
  if (!temp.root) return;
  if (temp.keep) console.log(`temp dir kept (--keep): ${temp.root}`);
  else rmSync(temp.root, { recursive: true, force: true });
  temp.root = null;
}
export function mkTemp(name) {
  if (!temp.root) throw new Error("mkTemp before initTemp");
  const dir = join(temp.root, `${String(state.seq++).padStart(3, "0")}-${name.replace(/[^\w.-]/g, "_")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The nine fake values of spec §6.5. Shapes are realistic; none is a real credential.
const FAKE = {
  KIMI_API_KEY: "sk-fakekimi0123456789abcdef\nsecond-line-of-a-multiline-value", // contains a newline
  GEMINI_API_KEY: "AIzaSyFAKE-gemini-0123456789abcdefghijklmn",
  TAVILY_API_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // 64 hex
  FIRECRAWL_API_KEY: "fc-$^*+?.()[]{}|\\-fake", // regex-special characters
  HOUGE_TELEGRAM_BOT_TOKEN: "123456789:AAFAKEtelegram0123456789abcdefghijklm",
  HOUGE_GMAIL_CLIENT_SECRET: "GOCSPX-fakeClientSecret01", // a substring of the oauth value below
  HOUGE_GMAIL_REFRESH_TOKEN: "1//0gFAKErefresh0123456789abcdefghijklmnopqrstuv",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-GOCSPX-fakeClientSecret01-tail",
  TYPESAFE_API_KEY: "ab9Zq" // 5 chars: below MIN_REDACTABLE_SECRET_LENGTH, must not mask
};
export const FAKE_VALUES = Object.freeze({ ...FAKE });

/** A secret broker over the fake values only, built by that dist's own createSecretBroker; never reads process.env. */
export function fakeBroker(d) {
  if (!d.createSecretBroker) throw new Error(`${d.dir} has no createSecretBroker`);
  return d.createSecretBroker({ ...FAKE });
}

/** kind: "bare" (no firewall) | "firewall" (fake broker). New dist goes through storeOptionsFor; an old dist gets { redact } / {}. */
export function mkStore(d, kind, path) {
  if (kind !== "bare" && kind !== "firewall") throw new Error(`mkStore: unknown kind ${kind}`);
  const broker = kind === "firewall" ? fakeBroker(d) : undefined;
  const opts = d.storeOptionsFor ? d.storeOptionsFor(broker, {}) : broker ? { redact: broker.redact } : {};
  return path ? d.RunStore.open(path, opts) : d.RunStore.openInMemory(opts);
}

/** Fake-broker redaction (defence in depth for a public log) and a 200-char cap. Transcript items print as `transcript#<n>` only. */
export function redactForPrint(s) {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  const t = String(text ?? "");
  if (/^transcript#\d+$/.test(t)) return t;
  let out = t;
  for (const v of Object.values(FAKE).filter((x) => x.length >= 6).sort((a, b) => b.length - a.length)) out = out.split(v).join("«redacted»");
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

/** Decision rows one pair's NEW build records and the OLD build cannot: excluded from both sides before comparing (per old build, P1). */
export const NEW_ROW_IDS = {
  s3: new Set(["approval.bind", "secret.redact"]),
  s4a: new Set(["approval.bind", "secret.redact"]),
  s4b: new Set(["memory.lesson_admit", "schedule.admit", "memory.correct_preflight"])
};
const ID_RE = /\b(tool|op)_[0-9A-Za-z][0-9A-Za-z-]{5,}/g;
/** Spec §6 metadata exclusions, by exact key name: row ids, timestamps, latency_ms. Nothing else is stripped; extend here, by name. */
export const STRIP_KEYS = new Set([
  "run_id", "decision_id", "notification_id", "outbox_id", "event_id", "approval_id", "tool_approval_id", "standing_id", "incident_id",
  "move_id", "correlation_id", "created_at", "updated_at", "consumed_at", "decided_at", "expires_at", "requested_at", "occurred_at",
  "resolved_at", "used_at", "next_attempt_at", "lease_expires_at", "ts", "timestamp", "latency_ms"
]);
/** Thrown by the harness itself (args, provenance, temp): its message is safe to print. Anything else is withheld. */
export class SetupError extends Error {}

const isNewRow = (x, ids) => x && typeof x === "object" && ids.has(x.entry_id);
function stripNode(v, map, omit, ids) {
  if (typeof v === "string") return v.replace(ID_RE, (m, kind) => {
    if (!map.has(m)) map.set(m, `${kind}#${[...map.values()].filter((x) => x.startsWith(`${kind}#`)).length + 1}`);
    return map.get(m);
  });
  if (Array.isArray(v)) return v.filter((x) => !isNewRow(x, ids)).map((x) => stripNode(x, map, omit, ids));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) { // sorted-key walk, the order canon() uses: id labels do not depend on key order
      if (k !== "__s3Omit" && k !== "__strip" && !STRIP_KEYS.has(k) && !omit.has(k)) out[k] = stripNode(v[k], map, omit, ids);
    }
    return out;
  }
  return v;
}

/** The keys one projection asks to drop: __strip (every pair) plus __s3Omit (pair[0] === "s3" only). */
export const ownOmit = (projection, pair) => [...(projection?.__strip ?? []), ...(pair[0] === "s3" ? projection?.__s3Omit ?? [] : [])];
const omitUnion = (a, b, pair) => [...new Set([...ownOmit(a, pair), ...ownOmit(b, pair)])];

/**
 * Spec §6 exclusions: STRIP_KEYS (exact names), the pair's NEW_ROW_IDS decision rows (s3/s4a: approval.bind, secret.redact; s4b: the three Stage 4C admit rows), and the keys a projection lists in
 * `__strip: string[]` (any pair) or `__s3Omit: string[]` (pair[0] === "s3" only). compare() takes the union of both sides' lists
 * and deletes those keys from both sides; both marker keys are dropped. tool_/op_ ids are renamed tool#1, op#1 ... in sorted-key
 * walk order, per side: ownership is NOT compared. A corpus whose result depends on which call owns which id must project that
 * ownership explicitly (e.g. {call: "first", tool: "tool#1"}). `omit` overrides the projection's own lists.
 */
export function strip(projection, pair, omit) {
  return stripNode(projection, new Map(), new Set(omit ?? ownOmit(projection, pair)), NEW_ROW_IDS[pair[0]]);
}

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}

/** Every differing key path (as segment arrays) between two stripped values; a missing side counts as a difference. */
export function diffPaths(a, b, path = []) {
  if (canon(a) === canon(b)) return [];
  const obj = (x) => x && typeof x === "object";
  if (obj(a) && obj(b) && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => diffPaths(a[k], b[k], [...path, k]));
  }
  return [path];
}

const walkPath = (v, segs) => segs.reduce((x, k) => x?.[k], v);
/** Transcript-derived (or corpus-marked private) items never print values: only `transcript#<n>`, the pair and masked key paths. */
export const isPrivate = (item) => item.private === true || (item.tags ?? []).includes("transcript");
const indexes = new WeakMap();
const TAG_RE = /^[a-z][a-z0-9_-]*$/;
/** Gives each item its 1-based index within the corpus (the only name a private item ever prints) and checks every tag is safe to print. */
export function indexItems(corpus, items) {
  items.forEach((item, i) => {
    indexes.set(item, i + 1);
    (item.tags ?? []).forEach((t, j) => {
      if (typeof t !== "string" || !TAG_RE.test(t)) throw new SetupError(`corpus ${corpus.name}: item ${i + 1} tag ${j + 1} is not /^[a-z][a-z0-9_-]*$/`);
    });
  });
}
export const itemLabel = (item) => (isPrivate(item) ? `transcript#${indexes.get(item) ?? "?"}` : redactForPrint(item.key));

const masks = new WeakMap();
/** A path segment is printed only if identifier-shaped or an array index; any other becomes <k1>, <k2> ... numbered per item. */
export function maskSeg(item, seg) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) || /^\d+$/.test(seg)) return seg;
  if (!masks.has(item)) masks.set(item, new Map());
  const m = masks.get(item);
  if (!m.has(seg)) m.set(seg, `<k${m.size + 1}>`);
  return m.get(seg);
}
const maskPath = (item, segs) => segs.map((g) => maskSeg(item, String(g))).join(".") || ".";

/** null when the stripped projections are equal (key order ignored); else { key, pair, diff, paths } (diff: values for ordinary items, masked paths for private ones; paths are raw, internal). */
export function compare(corpus, item, a, b, pair) {
  const omit = omitUnion(a, b, pair);
  const [sa, sb] = [strip(a, pair, omit), strip(b, pair, omit)];
  const segs = diffPaths(sa, sb);
  if (segs.length === 0) return null;
  const show = (x, g) => redactForPrint(canon(walkPath(x, g)));
  const priv = isPrivate(item);
  const diff = priv ? (state.debug ? segs.map((g) => maskPath(item, g)).join(", ") : `${segs.length} differing path(s)`)
    : segs.slice(0, 3).map((g) => `${g.join(".") || "."}: ${show(sa, g)} != ${show(sb, g)}`).join("; ");
  return { key: item.key, pair, diff, paths: segs.map((g) => g.join(".")) };
}

/** A required new-side fact (spec: "required, not excluded"). False prints a FAIL line and counts toward the exit code via state.requiredFailures. */
export function requireNew(corpus, item, name, ok, detail = "") {
  if (ok) return ok;
  const priv = isPrivate(item);
  const k = (ordinals.get(item) ?? 0) + 1;
  ordinals.set(item, k);
  const what = priv ? `required fact #${k} failed${state.debug ? ` (${name.split(".").map((g) => maskSeg(item, g)).join(".")})` : ""}` : `${name}${detail ? `: ${redactForPrint(detail)}` : ""}`;
  console.log(`FAIL required [${corpus.name}] ${itemLabel(item)}${priv ? ":" : " —"} ${what}`);
  state.requiredFailures.push(`${corpus.name}/${itemLabel(item)}/${priv ? k : name}`);
  return ok;
}
const ordinals = new WeakMap();

/**
 * Ordered relabelling of wall-clock values (replaces "set / not set" reduction). Walks the whole projection; every string value under a key
 * `isClockKey(key)` accepts is collected, the distinct values are sorted ascending and each is renamed `t#1`, `t#2`, ... (equal values share
 * a label, order is kept; null/undefined stay as they are). A `*_json` string is parsed first, so keys embedded in it (a lease expiry) are
 * relabelled too. Call it BEFORE the harness strips by key name: a stripped created_at still occupies a rank, so what is compared is the
 * ORDER and EQUALITY of the kept clocks among all clocks (e.g. valid_from == the fact's created_at shows as the same rank), never the
 * absolute instants or the gaps between them. Returns a new value; the input is untouched.
 */
export function relabelClocks(projection, isClockKey) {
  const prep = (v) => {
    if (Array.isArray(v)) return v.map(prep);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (k.endsWith("_json") && typeof x === "string") { try { return [k, prep(JSON.parse(x))]; } catch { return [k, x]; } }
      return [k, prep(x)];
    }));
  };
  const tree = prep(projection);
  const seen = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (isClockKey(k) && typeof x === "string") seen.add(x); else collect(x); }
  };
  collect(tree);
  const label = new Map([...seen].sort().map((t, i) => [t, `t#${i + 1}`]));
  const apply = (v) => {
    if (Array.isArray(v)) return v.map(apply);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isClockKey(k) && typeof x === "string" ? label.get(x) : apply(x)]));
  };
  return apply(tree);
}
