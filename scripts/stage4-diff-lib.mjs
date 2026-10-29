// Shared machinery for the Stage 4B differential (spec 2026-10-29 §6): dist loading, temp roots, stores, the fake broker,
// the projection stripper and comparator. Corpora (scripts/stage4-corpora/*.mjs) build on these names; the CLI is
// scripts/check-ladder-stage4-differential.mjs. External inputs are read-only; nothing here reads real secrets or the repo .env.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export const DISTS = { new: null, s3: null, s4a: null }; // filled by the CLI
export const CORPORA = [];                               // filled by the CLI from scripts/stage4-corpora/*.mjs
export const state = { requiredFailures: [], seq: 0 };

// export name -> compiled module (relative to a dist). A dist that lacks the module or the export yields null.
const EXPORTS = {
  RunStore: "run/run-store.js", CapabilityRunner: "capabilities/capability-runner.js", decideCapability: "policy/capability-policy.js",
  classifyCommand: "omp/command-matcher.js", gateTargets: "omp/gate-path.js", createToolApprovalSink: "omp/tool-approval-sink.js",
  storeOptionsFor: "run/store-options.js", decideSync: "decisions/decide.js", storeRecorder: "decisions/record.js",
  createSecretBroker: "config/secret-broker.js"
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
/** Opens the run's single temp root (call once, before any mkTemp). */
export function initTemp(keep, base = "/tmp") {
  temp.root = mkdtempSync(join(base, "hg-s4d-"));
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

const BIND_REDACT = new Set(["approval.bind", "secret.redact"]);
const ID_RE = /\b(tool|op)_[0-9A-Za-z][0-9A-Za-z-]{5,}/g;
/** Spec §6 metadata exclusions, by exact key name: row ids, timestamps, latency_ms. Nothing else is stripped; extend here, by name. */
export const STRIP_KEYS = new Set([
  "id", "run_id", "decision_id", "notification_id", "outbox_id", "event_id", "approval_id", "tool_approval_id",
  "created_at", "updated_at", "consumed_at", "decided_at", "expires_at", "requested_at", "ts", "timestamp", "latency_ms"
]);

const isBindRow = (x) => x && typeof x === "object" && BIND_REDACT.has(x.entry_id);
function stripNode(v, map, omit) {
  if (typeof v === "string") return v.replace(ID_RE, (m, kind) => {
    if (!map.has(m)) map.set(m, `${kind}#${[...map.values()].filter((x) => x.startsWith(`${kind}#`)).length + 1}`);
    return map.get(m);
  });
  if (Array.isArray(v)) return v.filter((x) => !isBindRow(x)).map((x) => stripNode(x, map, omit));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (k !== "__s3Omit" && !STRIP_KEYS.has(k) && !omit.has(k)) out[k] = stripNode(x, map, omit);
    return out;
  }
  return v;
}

/**
 * Spec §6 exclusions: STRIP_KEYS, approval.bind / secret.redact decision rows, and (pair[0] === "s3") the keys in __s3Omit.
 * tool_/op_ ids are renamed tool#1, op#1 ... by order of first appearance, per side: ownership is NOT compared. A corpus whose
 * result depends on which call owns which id must project that ownership explicitly (e.g. {call: "first", tool: "tool#1"}).
 * `omit` overrides the projection's own __s3Omit list (compare passes the union of both sides').
 */
export function strip(projection, pair, omit) {
  const own = pair[0] === "s3" && Array.isArray(projection?.__s3Omit) ? projection.__s3Omit : [];
  return stripNode(projection, new Map(), new Set(omit ?? own));
}

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}

/** Every differing key path between two stripped values (leaf level; a missing side counts as a difference). */
export function diffPaths(a, b, path = "") {
  if (canon(a) === canon(b)) return [];
  const obj = (x) => x && typeof x === "object";
  if (obj(a) && obj(b) && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => diffPaths(a[k], b[k], `${path}.${k}`));
  }
  return [path || "."];
}

const walkPath = (v, path) => path.split(".").filter(Boolean).reduce((x, k) => x?.[k], v);
/** Transcript-derived (or corpus-marked private) items never print values: only `transcript#<n>`, the pair and key paths. */
export const isPrivate = (item) => item.private === true || (item.tags ?? []).includes("transcript");
export function itemLabel(item) {
  if (!isPrivate(item)) return redactForPrint(item.key);
  return /^transcript#\d+$/.test(String(item.key)) ? item.key : `transcript#${item.n ?? "?"}`;
}

/** null when the stripped projections are equal (key order ignored); else { key, pair, diff, paths } (diff is values for ordinary items, paths only for private ones). */
export function compare(corpus, item, a, b, pair) {
  const omit = pair[0] === "s3" ? [...new Set([...(a?.__s3Omit ?? []), ...(b?.__s3Omit ?? [])])] : [];
  const [sa, sb] = [strip(a, pair, omit), strip(b, pair, omit)];
  const paths = diffPaths(sa, sb);
  if (paths.length === 0) return null;
  const diff = isPrivate(item) ? paths.join(", ")
    : paths.slice(0, 3).map((p) => `${p}: ${redactForPrint(canon(walkPath(sa, p)))} != ${redactForPrint(canon(walkPath(sb, p)))}`).join("; ");
  return { key: item.key, pair, diff, paths };
}

/** A required new-side fact (spec: "required, not excluded"). False prints a FAIL line and counts toward the exit code via state.requiredFailures. */
export function requireNew(corpus, item, name, ok, detail = "") {
  if (!ok) {
    const tail = detail && !isPrivate(item) ? `: ${redactForPrint(detail)}` : "";
    console.log(`FAIL required [${corpus.name}] ${itemLabel(item)} — ${name}${tail}`);
    state.requiredFailures.push(`${corpus.name}/${itemLabel(item)}/${name}`);
  }
  return ok;
}
