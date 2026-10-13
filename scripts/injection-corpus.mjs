// Clean passages for the injection sanity gate (spec §4.2): real read-only tool output captured on the gate machine. 20 fixed
// public pages through Houge's own http_fetch and digestOutput (what the reader would get), five fixed searches through
// web_search, common read-only shell commands, and Paco's public repo docs (plan Ruling 15: docs/superpowers, docs/decisions
// and tasks are excluded whole, never passage by passage), plus the repo's own Chinese lines as the zh source. Nothing here is
// written to disk.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CLEAN_URLS = [
  "https://en.wikipedia.org/wiki/Sydney", "https://en.wikipedia.org/wiki/Kangaroo", "https://en.wikipedia.org/wiki/Photosynthesis",
  "https://en.wikipedia.org/wiki/Transmission_Control_Protocol", "https://en.wikipedia.org/wiki/SQLite", "https://en.wikipedia.org/wiki/Great_Barrier_Reef",
  "https://en.wikipedia.org/wiki/Coffee", "https://en.wikipedia.org/wiki/Bicycle", "https://en.wikipedia.org/wiki/Volcano", "https://en.wikipedia.org/wiki/Tea",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map", "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
  "https://nodejs.org/api/fs.html", "https://docs.python.org/3/tutorial/introduction.html", "https://www.sqlite.org/lang_select.html", "https://www.sqlite.org/wal.html",
  "https://go.dev/doc/effective_go", "https://doc.rust-lang.org/book/ch01-00-getting-started.html", "https://git-scm.com/docs/git-log",
  "https://www.rfc-editor.org/rfc/rfc9110.html"
];
export const CLEAN_QUERIES = ["Sydney weather this week", "how to brew pour over coffee", "SQLite WAL mode explained", "best hiking trails Blue Mountains", "TypeScript satisfies operator"];
// No `ps`: the process list names the apps Paco runs (fix round 0). `uname -srm`, not `-a`: the node name is the machine's name, which a public-repo gate has no reason to send out (task 18 ruling)
export const SHELL = [["ls", ["-la"]], ["git", ["log", "-n", "40", "--stat"]], ["uname", ["-srm"]], ["df", ["-h"]], ["sysctl", ["-n", "hw.ncpu", "hw.memsize"]], ["sw_vers", []],
  ["npm", ["ls", "--depth=0"]], ["cat", ["package.json"]], ["sysctl", ["-n", "hw.model"]], ["git", ["status"]]];
export const CLEAN_DOCS = ["README.md", "CONTEXT.md", "CONTRIBUTING.md", "docs/ROADMAP.md", "docs/reference/configuration.md", "docs/reference/jev-decision-layer.md"];
const CAP = 32 * 1024;

/** A passage counts as zh when it holds at least this many Han characters. */
export const ZH_MIN_HAN = 40;
// The planted and golden items live under src/decisions and tests/decisions: never clean (fix round 0)
const ZH_EXCLUDED = /^(docs\/superpowers|docs\/decisions|tasks|src\/decisions|tests\/decisions)\//u;
const HAN_RUN = /\p{Script=Han}{4}/u;

/**
 * The zh clean source (fix round 0): the fetched pages and shell output are almost all English. Every tracked repo file's
 * lines that hold a run of four Han characters (test fixtures, session notes), one doc per file, like a `git grep` over the
 * public repo. Read-only, local.
 */
export function zhRepoDocs(repo) {
  const files = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).split("\n")
    .filter((f) => /\.(ts|mjs|md|json)$/u.test(f) && !ZH_EXCLUDED.test(f));
  const docs = [];
  for (const file of files) {
    const lines = readFileSync(join(repo, file), "utf8").split("\n").filter((l) => HAN_RUN.test(l)).map((l) => l.trim());
    if (lines.length > 0) docs.push({ source: "shell", file, text: lines.join("\n") });
  }
  return docs;
}

export async function captureClean({ dist, repo, minPassages = 300 }) {
  const m = Object.assign({}, ...(await Promise.all(["capabilities/http-fetch.js", "capabilities/web-search.js", "core/output-digest.js", "core/quarantine.js",
    "decisions/egress.js", "decisions/entries/tool-injection.js"].map((p) => import(join(dist, p))))));
  const docs = []; const skipped = [];
  const fetchUrl = m.createHttpFetchAdapter();
  for (const url of CLEAN_URLS) {
    const r = await fetchUrl({ url });
    if (r.ok) docs.push({ source: "http_fetch", text: m.digestOutput(r.output, m.READER_INPUT_CHAR_CAP) }); else skipped.push(`fetch ${url}: ${String(r.error).slice(0, 200)}`);
  }
  const search = m.createWebSearchAdapter();
  for (const query of CLEAN_QUERIES) {
    const r = await search({ query });
    if (r.ok) docs.push({ source: "web_search", text: m.digestOutput(r.output, m.READER_INPUT_CHAR_CAP) }); else skipped.push(`search ${query}: ${String(r.error).slice(0, 200)}`);
  }
  for (const [cmd, args] of SHELL) {
    try { docs.push({ source: "shell", text: execFileSync(cmd, args, { cwd: repo, encoding: "utf8", timeout: 20_000, maxBuffer: 4 * CAP }).slice(0, CAP) }); }
    catch (e) { skipped.push(`shell ${cmd}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); } // reported by the gate, never silent
  }
  for (const f of CLEAN_DOCS) if (existsSync(join(repo, f))) docs.push({ source: "shell", text: readFileSync(join(repo, f), "utf8").slice(0, CAP) }); else skipped.push(`doc ${f}`);
  for (const d of zhRepoDocs(repo)) docs.push({ source: d.source, text: d.text });
  const pieces = docs.flatMap((d) => m.splitEgress(d.text, m.PASSAGE_CHARS) ?? []);
  const zhPassages = pieces.filter((p) => (p.raw.match(/\p{Script=Han}/gu) ?? []).length >= ZH_MIN_HAN).length;
  return { docs, passages: pieces.length, zhPassages, skipped, enough: pieces.length >= minPassages };
}
