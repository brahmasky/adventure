/** Floor B for `bash` (spec §5.5). Best effort by design (D12): a miss runs without a tap. */
export type CommandClass = { kind: "plain" } | { kind: "external_write" | "destructive"; label: string };

const EXTERNAL: Array<[RegExp, string]> = [
  [/\bgit\s+push\b(?!.*--dry-run)/, "git push"],
  [/\bgh\s+(pr|issue|release|repo)\s+(create|merge|delete|edit|comment)\b/, "gh write"],
  [/\b(curl|http|https|httpie)\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--data\b|\s-d\s|\s--upload-file\b|\s-T\s|\s-F\s|\s--form\b)/i, "HTTP write"],
  [/\bwget\b.*--(post|method|body)/, "HTTP write"],
  [/\b(mail|mailx|sendmail)\b/, "send mail"],
  [/\bosascript\b/, "AppleScript"],
  [/\b(ssh|scp|sftp)\b|\brsync\b.*\S+:/, "remote copy"],
  [/\bnpm\s+publish\b|\btwine\s+upload\b|\bpip\s+upload\b|\bcargo\s+publish\b/, "publish package"],
  [/\bsudo\b/, "sudo"], [/\blaunchctl\b/, "launchctl"], [/\bcrontab\b/, "crontab"]
];

const DESTRUCTIVE: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\b/, "recursive/forced delete"],
  [/\bfind\b.*\s-delete\b/, "find -delete"],
  [/\bgit\s+clean\b/, "git clean"], [/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
  [/\bgit\s+checkout\s+--\s/, "git checkout --"], [/\btruncate\b/, "truncate"], [/\bshred\b/, "shred"],
  [/\bmkfs\b/, "mkfs"], [/\bdiskutil\s+erase/, "diskutil erase"]
];

const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const EXEC_PAYLOAD = /\b(?:bash|sh|zsh)\s+-c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")|\beval\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g;

export function classifyCommand(command: string): CommandClass {
  for (const m of command.matchAll(EXEC_PAYLOAD)) {
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    const c = classifyCommand(inner);
    if (c.kind !== "plain") return c;
  }
  const bare = command.replace(QUOTED, "''");
  for (const [re, label] of DESTRUCTIVE) if (re.test(bare)) return { kind: "destructive", label };
  for (const [re, label] of EXTERNAL) if (re.test(bare)) return { kind: "external_write", label };
  return { kind: "plain" };
}
