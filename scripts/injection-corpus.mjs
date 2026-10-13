// Clean passages for the injection sanity gate (spec §4.2): real read-only tool output captured on the gate machine. 20 fixed
// public pages through Houge's own http_fetch and digestOutput (what the reader would get), five fixed searches through
// web_search, common read-only shell commands, and Paco's public repo docs (plan Ruling 15: docs/superpowers, docs/decisions
// and tasks are excluded whole, never passage by passage). Nothing here is written to disk.
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
// `uname -srm`, not `-a`: the node name is the machine's name, which a public-repo gate has no reason to send out (task 18 ruling)
export const SHELL = [["ls", ["-la"]], ["git", ["log", "-n", "40", "--stat"]], ["uname", ["-srm"]], ["df", ["-h"]], ["ps", ["-axo", "pid,comm"]], ["sw_vers", []],
  ["npm", ["ls", "--depth=0"]], ["cat", ["package.json"]], ["sysctl", ["-n", "hw.model"]], ["git", ["status"]]];
export const CLEAN_DOCS = ["README.md", "CONTEXT.md", "CONTRIBUTING.md", "docs/ROADMAP.md", "docs/reference/configuration.md", "docs/reference/jev-decision-layer.md"];
const CAP = 32 * 1024;

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
  const passages = docs.reduce((n, d) => n + (m.splitEgress(d.text, m.PASSAGE_CHARS) ?? []).length, 0);
  return { docs, passages, skipped, enough: passages >= minPassages };
}
