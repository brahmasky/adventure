/**
 * Pure unified-diff formatting for the Telegram [View diff] reply (⓪·2c U1).
 *
 * Renders `git diff` output as: `Diff for <branch>` + a per-file stat summary (parsed
 * from the diff itself — no extra git call) + a compact body (index/---/+++/diff-header
 * noise stripped, `@@` hunk headers compressed to `@ <newStart>`, head-capped per file)
 * bounded well under Telegram's 4096-char message limit.
 *
 * `truncated: true` means the inline view lost diff content, so the caller should also
 * attach the full patch as a document.
 */

/** Hard budget for the whole rendered message (headroom under Telegram's 4096). */
const MESSAGE_CAP = 3_900;
/** Budget for the compact diff body inside the message. */
const BODY_CAP = 3_200;
/** Budget for the stat summary block. */
const STAT_CAP = 1_200;
/** Per-file head cap: changed (+/−) lines kept before "… (+N more lines)". */
const FILE_HEAD_CHANGED_LINES = 40;

export interface ParsedDiffFile {
  /** Display path — `old → new` for renames. */
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Compact body lines: `@ <newStart>` hunk markers + verbatim +/−/context lines. */
  body: string[];
}

export interface FormattedDiff {
  /** The complete message text (header + stat summary + fenced compact body). */
  text: string;
  /** True when the inline view lost diff content (per-file or overall cap hit). */
  truncated: boolean;
}

const FILE_HEADER = /^diff --git "?a\/(.+?)"? "?b\/(.+)"?$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** Per-file metadata lines that carry no reviewable content (dropped from the body). */
const META_PREFIXES = [
  "index ",
  "--- ",
  "+++ ",
  "old mode",
  "new mode",
  "new file mode",
  "deleted file mode",
  "similarity index",
  "dissimilarity index",
  "rename from",
  "rename to",
  "copy from",
  "copy to"
];

/** Parse a unified `git diff` into per-file stats + compact body lines. */
export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;

  for (const line of diff.split("\n")) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      const oldPath = header[1] ?? "";
      const newPath = header[2] ?? "";
      const file: ParsedDiffFile = {
        path: oldPath === newPath ? newPath : `${oldPath} → ${newPath}`,
        additions: 0,
        deletions: 0,
        binary: false,
        body: []
      };
      files.push(file);
      current = file;
      continue;
    }
    if (!current) continue; // preamble before the first file header
    if (line.startsWith("Binary files") || line === "GIT binary patch") {
      current.binary = true;
      continue;
    }
    if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      current.body.push(`@ ${hunk[1] ?? ""}`);
      continue;
    }
    if (line.startsWith("+")) {
      current.additions += 1;
      current.body.push(line);
    } else if (line.startsWith("-")) {
      current.deletions += 1;
      current.body.push(line);
    } else if (line.startsWith(" ") || line.startsWith("\\")) {
      current.body.push(line); // context / "\ No newline at end of file"
    }
    // Anything else (e.g. the trailing "" from split) is dropped.
  }

  return files;
}

/**
 * Render the [View diff] message for a non-empty diff. Small diffs render fully inline
 * (`truncated: false`); anything that hits a cap comes back `truncated: true` so the
 * caller can attach the full patch.
 */
export function formatDiffMessage(branch: string, diff: string): FormattedDiff {
  const files = parseUnifiedDiff(diff);
  const header = `Diff for \`${branch}\``;

  if (files.length === 0) {
    // Not a recognizable unified diff — fall back to a bounded verbatim block (head-capped).
    const body = diff.length > BODY_CAP ? `${diff.slice(0, BODY_CAP)}\n…` : diff;
    return {
      text: `${header}\n\n\`\`\`\n${body}\n\`\`\``,
      truncated: diff.length > BODY_CAP
    };
  }

  const stat = buildStat(files);
  // The body gets whatever the message budget leaves after header + stats + fences.
  const bodyBudget = Math.max(0, Math.min(BODY_CAP, MESSAGE_CAP - header.length - stat.text.length - 16));
  const body = buildBody(files, bodyBudget);

  return {
    text: `${header}\n\n${stat.text}\n\n\`\`\`\n${body.text}\n\`\`\``,
    truncated: stat.truncated || body.truncated
  };
}

/** Per-file `path | +A −D` lines (`| bin` for binaries) plus a totals line, stat-capped. */
function buildStat(files: ParsedDiffFile[]): { text: string; truncated: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const totals = `${files.length} ${files.length === 1 ? "file" : "files"} changed, +${additions} −${deletions}`;

  const lines: string[] = [];
  let used = 0;
  for (const file of files) {
    const line = file.binary
      ? `${file.path} | bin`
      : `${file.path} | +${file.additions} −${file.deletions}`;
    if (used + line.length + 1 > STAT_CAP) break;
    lines.push(line);
    used += line.length + 1;
  }
  const dropped = files.length - lines.length;
  if (dropped > 0) lines.push(`… (+${dropped} more files)`);
  lines.push(totals);
  return { text: lines.join("\n"), truncated: dropped > 0 };
}

/** Assemble per-file compact blocks into the fenced body, within `budget` chars. */
function buildBody(files: ParsedDiffFile[], budget: number): { text: string; truncated: boolean } {
  const blocks: string[] = [];
  let truncated = false;
  let used = 0;
  let included = 0;

  for (const file of files) {
    const block = fileBlock(file);
    const cost = block.text.length + (blocks.length > 0 ? 2 : 0); // "\n\n" separator
    if (used + cost > budget) break;
    blocks.push(block.text);
    used += cost;
    included += 1;
    truncated ||= block.truncated;
  }

  const droppedFiles = files.length - included;
  if (droppedFiles > 0) {
    blocks.push(`… (+${droppedFiles} more files)`);
    truncated = true;
  }
  return { text: blocks.join("\n\n"), truncated };
}

/** One file's compact block: `📄 <path>` + head-capped hunk/content lines. */
function fileBlock(file: ParsedDiffFile): { text: string; truncated: boolean } {
  const lines = [`📄 ${file.path}`];
  if (file.binary) {
    lines.push("(binary)");
    return { text: lines.join("\n"), truncated: false };
  }

  let changed = 0;
  let kept = 0;
  for (const line of file.body) {
    const isChange = line.startsWith("+") || line.startsWith("-");
    if (isChange && changed >= FILE_HEAD_CHANGED_LINES) break;
    if (isChange) changed += 1;
    lines.push(line);
    kept += 1;
  }
  const remaining = file.body
    .slice(kept)
    .filter((line) => line.startsWith("+") || line.startsWith("-")).length;
  if (remaining > 0) lines.push(`… (+${remaining} more lines)`);
  return { text: lines.join("\n"), truncated: remaining > 0 };
}
