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

const DROP_KEY = /^(id|ts|timestamp|latency_ms|.+_at)$/;
const BIND_REDACT = new Set(["approval.bind", "secret.redact"]);
const ID_RE = /\b(tool|op)_[0-9A-Za-z][0-9A-Za-z-]{5,}/g;

function stripNode(v, map, omit) {
  if (typeof v === "string") return v.replace(ID_RE, (m, kind) => {
    if (!map.has(m)) map.set(m, `${kind}#${[...map.values()].filter((x) => x.startsWith(`${kind}#`)).length + 1}`);
    return map.get(m);
  });
  if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === "object" && BIND_REDACT.has(x.entry_id))).map((x) => stripNode(x, map, omit));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "__s3Omit" || DROP_KEY.test(k) || omit.has(k)) continue;
      out[k] = stripNode(x, map, omit);
    }
    return out;
  }
  return v;
}

/** Spec §6 exclusions: ids, timestamps, latency_ms, approval.bind / secret.redact decision rows; tool_/op_ ids mapped in order of appearance. */
export function strip(projection, pair) {
  const omit = new Set(pair[0] === "s3" && Array.isArray(projection?.__s3Omit) ? projection.__s3Omit : []);
  return stripNode(projection, new Map(), omit);
}

function firstDiff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const r = firstDiff(a[k], b[k], `${path}.${k}`);
      if (r) return r;
    }
  }
  return `${path || "."}: ${redactForPrint(JSON.stringify(a))} != ${redactForPrint(JSON.stringify(b))}`;
}

/** null when the stripped projections are byte-equal; else { key, pair, diff } (diff already redacted). */
export function compare(corpus, item, a, b, pair) {
  const [sa, sb] = [strip(a, pair), strip(b, pair)];
  if (JSON.stringify(sa) === JSON.stringify(sb)) return null;
  return { key: item.key, pair, diff: firstDiff(sa, sb) };
}

/** A required new-side fact (spec: "required, not excluded"). False prints a FAIL line and is counted. */
export function requireNew(corpus, item, name, ok, detail = "") {
  if (!ok) {
    console.log(`FAIL required [${corpus.name}] ${redactForPrint(item.key)} — ${name}${detail ? `: ${redactForPrint(detail)}` : ""}`);
    state.requiredFailures.push(`${corpus.name}/${item.key}/${name}`);
  }
  return ok;
}
