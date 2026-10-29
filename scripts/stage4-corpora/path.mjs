// Stage 4B differential, path corpus (spec 2026-10-29 §6 item 2). Each path is projected as: the gateTargets output, and for BOTH
// built-in gates (read -> fs_read / isDeniedRead, write -> fs_write / isDeniedWrite) the bridge's answer (allow, or deny + code) and the
// tool.path decision row. Bases: s3 = 548cb87 (targets, answers), s4a = 1451a66 (rows). All paths resolve against fixed synthetic roots
// (ROOTS in scripts/stage4-bridge-seam.mjs), so absolute targets compare byte for byte across dists.
// Item sources: table (tests/omp/gate-path.test.ts), one synthetic item per gateTargets branch (gate-path.ts:25-66; tags below),
// protected (every path src/omp/protected-paths.ts names, plus a child of each), transcript (live omp read/write/edit calls, private; also driven through the dist's real policy hook, scripts/stage4-bridge-seam.mjs hookCall).
import { join } from "node:path";
import { ROOTS, gateCall, hookCall } from "../stage4-bridge-seam.mjs";
import { SetupError } from "../stage4-diff-lib.mjs";
import { REPO_ROOT, testLiterals, transcriptCalls } from "../stage4-sources.mjs";

const TRANSCRIPT_INPUTS = 13; // 7 read + 3 write + 3 edit, distinct

const MANY = Array.from({ length: 300 }, (_, i) => `p${i}`).join(";"); // > MAX_GATE_TARGETS candidates
const FEW = Array.from({ length: 100 }, (_, i) => `p${i}`).join(";"); // under it: valid
// [branch tag, raw]. Branches follow gate-path.ts: resolver (expand) first, then gateTargets.
const SYNTHETIC = [
  ["missing_path", ""], ["missing_path", "   "],
  ["bad_control", "a\u0001b"], ["bad_control", "a\u007fb"], ["bad_backslash", "a\\b"], ["bad_backslash", "\\"],
  ["bad_too_many", MANY], ["valid_many", FEW],
  ["colon_valid", ":/x"], ["colon_valid", ":~/x"], ["colon_valid", ":./x"], ["colon_valid", ":../x"],
  ["colon_invalid", ":x"], ["colon_invalid", "::/x"], ["colon_invalid", ":"],
  ["at_url", "@https://x.io/a"], ["at_url", "@www.x.io/a"], ["at_valid", "@/x"], ["at_valid", "@~/x"], ["at_valid", "@~"],
  ["at_invalid", "@x"], ["at_invalid", "@@/x"], ["at_invalid", "@"],
  ["url", "https://x.io/a"], ["url", "local:/x"], ["url", "http://x"], ["www", "www.example.com/x"], ["www", "WWW.x.y/z"],
  ["tilde", "~"], ["tilde", "~/x"], ["tilde", "~x"], ["tilde", "~/.ssh/id_rsa"], ["tilde", "~root/x"],
  ["root_slash", "/"], ["root_slash", "///"],
  ["quoted", "\"/x y\""], ["quoted", "\"~/.ssh\""], ["quoted", "\""],
  ["peel", "a:b"], ["peel", "a?b"], ["peel", "a#b"], ["peel", "~/.ssh:1-5"], ["peel", "a;b,c d"], ["peel", "ok;~/.ssh/id_rsa"], ["peel", "x.zip:inner"],
  ["relative", "x"], ["relative", "./x"], ["relative", "a/b/c.txt"], ["relative", "notes/www.txt"],
  ["dotdot", "../x"], ["dotdot", "a/../../b"], ["dotdot", "../../../etc/passwd"], ["dotdot", "../repo/.env"]
];
// Credential files by NAME anywhere under $HOME (protected-paths.ts CREDENTIAL_PATTERNS, HOME_DOTENV_NAME, the .env template exemption).
const CREDENTIALS = [".env", "work/.env", ".env.local", "work/.env.production", ".env.example", ".env.sample", ".env.template", ".foo.env", "id_rsa", "work/id_ed25519.pub",
  "work/id_ecdsa", ".bash_history", ".zsh_history", ".lesshst", ".config/fish/fish_variables", "work/service_account_x.json", "work/client_secret_1.json",
  "work/my_credentials.json", "token.json", "work/api_token.json", "work/a-token.json", "work/private.pem", "work/server.key", "work/key.pem", "work/x.p12", "work/x.pfx",
  "work/tls.key", ".config/gh/auth.json", ".local/share/x/auth.json", ".local/share/y/credentials.txt", ".config/z/credentials", "Projects/app/.myauth", "Projects/app/auth_info_baileys/creds"];

function protectedItems(n) {
  const ctx = { ...ROOTS };
  const groups = [["secret_path", n.secretPaths(ctx)], ["protected_repo", n.protectedRepoPaths(ctx)], ["write_deny", n.operationalWriteDeny(ctx)],
    ["write_root", [...n.writeRoots(ctx, "planner"), ...n.writeRoots(ctx, "shell")]], ["credential_name", CREDENTIALS.map((c) => join(ROOTS.home, c))]];
  const byPath = new Map();
  for (const [tag, paths] of groups) for (const p of paths) for (const raw of [p, join(p, "child")]) byPath.set(raw, new Set([...(byPath.get(raw) ?? []), "protected", tag]));
  return [...byPath].map(([raw, tags]) => ({ key: `protected:${raw}`, input: { path: raw }, tags: [...tags] }));
}

function transcriptItems(dir) {
  const seen = new Map();
  for (const c of transcriptCalls(dir, ["read", "write", "edit"])) seen.set(`${c.name}:${JSON.stringify(c.arguments)}`, c);
  if (seen.size !== TRANSCRIPT_INPUTS) throw new SetupError(`transcript read/write/edit inputs: found ${seen.size} distinct, pinned at exactly ${TRANSCRIPT_INPUTS}`);
  return [...seen.values()].map((c, i) => ({ key: `transcript#${i + 1}`, private: true, tags: ["transcript", `tool_${c.name}`], input: gateInput(c.arguments), tool: c.name, args: c.arguments }));
}

const gateInput = (a) => Object.fromEntries(["path", "file_path", "paths"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const rawsOf = (input) => [input.path, input.file_path, ...(Array.isArray(input.paths) ? input.paths : [])].filter((x) => typeof x === "string");
const distName = (d) => d.dir.split("/").slice(-2, -1)[0];

export default {
  name: "path",
  pairs: [["s3", "new"], ["s4a", "new"]],
  min: { items: 5 + SYNTHETIC.length + TRANSCRIPT_INPUTS,
    branches: [...new Set(SYNTHETIC.map(([t]) => t)), "table", "protected", "secret_path", "protected_repo", "write_deny", "write_root", "credential_name", "transcript", "tool_read", "tool_write", "tool_edit"] },
  async load(ctx) {
    const lits = [...new Set(testLiterals(join(REPO_ROOT, "tests/omp/gate-path.test.ts"), ["gateTargets"]))];
    if (lits.length < 5) throw new SetupError(`gate-path test literals: found ${lits.length}, need at least 5`);
    return [...lits.map((raw) => ({ key: `table:${JSON.stringify(raw)}`, input: { path: raw }, tags: ["table"] })),
      ...SYNTHETIC.map(([tag, raw], i) => ({ key: `${tag}:${i + 1}:${JSON.stringify(raw).slice(0, 60)}`, input: { path: raw }, tags: [tag] })),
      ...protectedItems(ctx.dists.new), ...transcriptItems(ctx.transcriptsDir)];
  },
  async project(d, item) {
    if (!d.gateTargets) throw new Error(`${d.dir} has no gateTargets`);
    const name = distName(d);
    const targets = rawsOf(item.input).map((raw) => d.gateTargets(raw, ROOTS.home, ROOTS.cwd));
    // row: tool.path verdict/reason; 548cb87 records none, so it is omitted on the s3 pair (compared on s4a -> new only)
    const hook = item.tool ? await hookCall(d, name, item.tool, item.args) : null; // transcript items: the dist's real policy hook (edit/patch targets derived there)
    return { targets, read: await gateCall(d, name, "read", item.input), write: await gateCall(d, name, "write", item.input), hook, __s3Omit: ["row"], __strip: ["reached"] };
  },
  required(d, item, proj) {
    const bad = [];
    for (const side of ["read", "write"]) {
      if (typeof proj[side]?.answer?.decision !== "string") bad.push(`${side} answer missing`);
      // a row only for a non-default verdict (record.ts:28; default "allowed"): present iff the gate denied, with that code (a protected_path, or the gate's refusal)
      const denied = proj[side]?.answer?.decision === "deny";
      const row = proj[side]?.row;
      if (!denied && proj[side]?.reached !== true) bad.push(`${side} allowed gate never reached tool.policy`); // positive evidence: an allowed path leaves no row
      if (denied !== (row !== null) || (denied && (row.length !== 1 || row[0].verdict !== "blocked"))) bad.push(`${side} tool.path row wrong or missing`);
    }
    if (item.tool) { // the hook either refused before the bridge, or the bridge left a row / reached tool.policy
      const h = proj.hook;
      if (!h || !(h.row !== null || h.reached === true || (h.verdict?.block === true && h.sent === null))) bad.push("hook call left no evidence");
      if (item.tool === "edit" && h.sent === null && h.verdict?.block !== true) bad.push("edit hook sent nothing");
    }
    if (rawsOf(item.input).length !== proj.targets.length) bad.push("targets missing");
    if (bad.length) throw new Error(bad.join("; "));
  }
};
