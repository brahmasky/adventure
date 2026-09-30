import { describe, expect, it } from "vitest";
import { classifyCommand } from "../../src/omp/command-matcher.js";

describe("command matcher — floor B for bash: which commands ask Paco first (D12 + destructive rule)", () => {
  it.each([
    ["git push origin main", "external_write"], ["gh pr create --fill", "external_write"],
    ["curl -X POST https://x.io -d a=1", "external_write"], ["curl --data @f https://x.io", "external_write"],
    ["wget --post-data=x https://x.io", "external_write"], ["mail -s hi a@b.c < m.txt", "external_write"],
    ["scp f.txt host:/tmp", "external_write"], ["rsync -a d/ host:/d", "external_write"], ["ssh host ls", "external_write"],
    ["npm publish", "external_write"], ["twine upload dist/*", "external_write"], ["osascript -e 'tell app \"Mail\" to send'", "external_write"],
    ["sudo ls", "external_write"], ["launchctl list", "external_write"], ["crontab -e", "external_write"]
  ])("%s → %s", (cmd, kind) => expect(classifyCommand(cmd).kind).toBe(kind));

  it.each([
    "rm -rf build", "rm -r d", "rm -f x", "rm -fr x", "rm -Rf x", "rm --recursive x", "cd /tmp && rm -rf x",
    "find . -name '*.log' -delete", "git clean -fdx", "git reset --hard HEAD~1", "git checkout -- .",
    "truncate -s 0 f", "shred f", "mkfs /dev/disk9", "diskutil eraseDisk JHFS+ X disk9",
    "bash -c 'rm -rf x'", "sh -c \"git push\""
  ])("%s is destructive or external and always asks — even inside the workspace (Paco, 2026-09-30)", (cmd) => {
    expect(classifyCommand(cmd).kind).not.toBe("plain");
  });

  it("rm -rf is destructive, not merely external", () => expect(classifyCommand("rm -rf build").kind).toBe("destructive"));

  it.each(["ls -la", "rm file.txt", "curl https://example.com", "git status", "git push --dry-run", "python3 x.py", "echo 'rm -rf' > note.txt"])(
    "%s is plain", (cmd) => expect(classifyCommand(cmd).kind).toBe("plain")
  );

  it("labels the match so the approval card can say what it is asking about", () => {
    const c = classifyCommand("git push");
    expect(c.kind === "plain" ? "" : c.label).toBe("git push");
  });
});
