// Stage 4B differential, command corpus (spec 2026-10-29 §6 item 1). Each command is projected two ways: the pure classifier
// (classifyCommand -> {kind, label}) and the real bridge seam (a bash call through each dist's bridge handler: was an approval card
// created, its `Action:` label, and the tool.shell_class decision row). Bases: s3 = 548cb87 (pure part, asked, label), s4a = 1451a66 (row).
//
// Classifier kind <-> spec class (src/omp/command-matcher.ts; CommandClass is plain | external_write | destructive):
//   spec `external_write`       <-> kind "external_write"   -> tag external_write
//   spec `destructive`          <-> kind "destructive"      -> tag destructive
//   spec `plain`                <-> kind "plain"            -> tag plain
//   spec `unseen shell script`  <-> kind "external_write" whose label includes UNSEEN_SCRIPT_LABEL ("unseen shell script") -> tag unseen_shell_script
// Source tags: table (it.each literals of tests/omp/command-matcher.test.ts), transcript (live omp transcripts, private), adr_residual
// (ADR 0028 D12 matcher misses, pinned as today's answer) plus the group tags below.
// Transcript commands live in memory only: they are tagged `transcript`, so the harness prints `transcript#<i>` and counts, never text.
import { bashCall } from "../stage4-bridge-seam.mjs";
import { SetupError } from "../stage4-diff-lib.mjs";
import { REPO_ROOT, transcriptCalls, testLiterals } from "../stage4-sources.mjs";
import { join } from "node:path";

const TRANSCRIPT_COMMANDS = 147;

// ADR 0028 "Matcher misses (D12, best effort)" (docs/decisions/0028-omp-runtime.md:239-241), one concrete command per miss:
// Concrete forms chosen so each really is classified plain today (probed on this build); the two quoting misses hide a `git push`.
//   `dd`, `unlink`, `python3 -c` / `node -e` / `perl -e`, ANSI-C `$'…'` quoting, spaced arithmetic `$(( a << 1 ))` next to a
//   multi-line quoted message, an apostrophe inside nested double quotes in a `$()`, and `bash file.sh`.
const RESIDUALS = [
  ["dd", "dd if=/dev/zero of=x"], ["unlink", "unlink x"],
  ["interp_e", "python3 -c 'print(1)'"], ["interp_e", "node -e '1'"], ["interp_e", "perl -e '1'"],
  ["ansi_c", "echo $'a\\x27b'"],
  ["spaced_arith", "echo $(( a << 1 ))\ngit commit -m \"msg\n1\nmore\" && git push"],
  ["nested_apostrophe", "echo \"$(echo \"it's\")\"; git push"],
  ["bash_file", "bash file.sh", "plain"] // plain by design (command-matcher.ts:203)
];
const GROUPS = ["dd", "unlink", "interp_e", "ansi_c", "spaced_arith", "nested_apostrophe", "bash_file"];

const distName = (d) => d.dir.split("/").slice(-2, -1)[0];

function classTags(c) {
  return c.kind === "plain" ? ["plain"] : [c.kind, ...(c.label.split(", ").includes("unseen shell script") ? ["unseen_shell_script"] : [])];
}

function tableItems(cls) {
  const cmds = [...new Set(testLiterals(join(REPO_ROOT, "tests/omp/command-matcher.test.ts")))];
  if (cmds.length < 100) throw new SetupError(`command table literals: found ${cmds.length}, need at least 100`);
  if (!cmds.some((c) => c.includes("\n"))) throw new SetupError("command table literals: no evaluated item carries a real newline (heredoc)");
  return cmds.map((command, i) => ({ key: `table:${JSON.stringify(command)}`, command, tags: ["table", ...classTags(cls(command))], ord: i }));
}

function transcriptItems(dir, cls) {
  const cmds = [...new Set(transcriptCalls(dir, ["bash"]).map((c) => c.arguments.command).filter((x) => typeof x === "string"))];
  if (cmds.length !== TRANSCRIPT_COMMANDS) throw new SetupError(`transcript bash commands: found ${cmds.length} distinct, pinned at exactly ${TRANSCRIPT_COMMANDS}`);
  return cmds.map((command, i) => ({ key: `transcript#${i + 1}`, command, private: true, tags: ["transcript", ...classTags(cls(command))] }));
}

function residualItems(cls) {
  return RESIDUALS.map(([group, command, extra], i) => ({ key: `adr:${group}:${i + 1}`, command, tags: ["adr_residual", group, ...classTags(cls(command)), ...(extra ? [extra] : [])] }))
    .map((it) => ({ ...it, tags: [...new Set(it.tags)] }));
}

export default {
  name: "command",
  pairs: [["s3", "new"], ["s4a", "new"]],
  min: { items: 100 + TRANSCRIPT_COMMANDS + 9, branches: ["external_write", "destructive", "plain", "unseen_shell_script", "table", "transcript", "adr_residual", ...GROUPS] },
  async load(ctx) {
    const cls = (c) => ctx.dists.new.classifyCommand(c);
    return [...tableItems(cls), ...transcriptItems(ctx.transcriptsDir, cls), ...residualItems(cls)];
  },
  async project(d, item) {
    if (!d.classifyCommand) throw new Error(`${d.dir} has no classifyCommand`);
    const seam = await bashCall(d, distName(d), item.command);
    // row: tool.shell_class verdict/reason; 548cb87 records none, so it is omitted on the s3 pair (compared on s4a -> new only)
    return { pure: d.classifyCommand(item.command), asked: seam.asked, label: seam.label, outcome: seam.outcome, result: seam.result, row: seam.row, __s3Omit: ["row"] };
  },
  required(d, item, proj) {
    const want = d.classifyCommand(item.command);
    const bad = [];
    if (typeof proj.asked !== "boolean") bad.push("asked missing");
    if (!("label" in proj)) bad.push("label missing");
    // the recorder keeps a row only for a non-default verdict (record.ts:28; default "plain"): a plain command leaves none; the label is not a reason code (reasonCodes: []), so the row carries the verdict only
    const row = Array.isArray(proj.row) ? proj.row : [];
    if (want.kind === "plain" ? proj.row !== null : row.length !== 1 || row[0].verdict !== want.kind) bad.push("tool.shell_class row wrong or missing");
    if (proj.asked !== (want.kind !== "plain")) bad.push("asked disagrees with the classifier");
    if (proj.asked && proj.label !== want.label) bad.push("card label differs from the classifier label");
    if (bad.length) throw new Error(bad.join("; "));
  }
};
