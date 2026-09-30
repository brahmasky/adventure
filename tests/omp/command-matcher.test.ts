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
    "truncate -s 0 f", "shred f", "mkfs /dev/disk9", "diskutil eraseDisk JHFS+ X disk9"
  ])("%s is destructive and always asks — even inside the workspace (Paco, 2026-09-30)", (cmd) => {
    expect(classifyCommand(cmd).kind).toBe("destructive");
  });

  it.each([
    ["bash -c 'rm -rf x'", "destructive"], ["sh -c \"git push\"", "external_write"], ["eval 'git push origin main'", "external_write"]
  ])("%s: an executed quoted payload is classified by what it runs → %s", (cmd, kind) => expect(classifyCommand(cmd).kind).toBe(kind));

  it.each([
    ["git -C dir push", "external_write"], ["git -C /repo push origin main", "external_write"], ["git --git-dir=.git push", "external_write"],
    ["git -c a=b push", "external_write"], ["git -C d clean -fd", "destructive"], ["git -C d reset --hard", "destructive"],
    ["git -C d checkout -- .", "destructive"], ["curl -XPOST https://x.io", "external_write"],
    ["curl https://x.io \\\n  --data a=1", "external_write"], ["curl https://x.io \\\n  -X POST", "external_write"],
    ["find . \\\n -delete", "destructive"], ["echo hi\ngit push", "external_write"],
    ['out="$(git push origin main 2>&1)"', "external_write"], ['echo "$(rm -rf x)"', "destructive"], ["echo `git push`", "external_write"],
    ["rm -v -rf x", "destructive"], ["rm -i -r x", "destructive"], ["rm -r -f x", "destructive"],
    ["/bin/rm -rf x", "destructive"], ["\\rm -rf x", "destructive"], ["command rm -rf x", "destructive"], ["ls | xargs rm -rf", "destructive"],
    ["FOO=1 git push", "external_write"], ["env A=b git push", "external_write"], ["true && sudo ls", "external_write"]
  ])("%s → %s (forms the first matcher missed)", (cmd, kind) => expect(classifyCommand(cmd).kind).toBe(kind));

  it.each(["ls ~/.ssh", "grep mail log.txt", "cat /var/mail/x", "echo sudo-less", "echo 'git push'", "echo \"git push\"", "rm -v x", "git log --oneline"])(
    "%s is plain: names in argument position never trigger a tap (approval fatigue)", (cmd) => expect(classifyCommand(cmd).kind).toBe("plain")
  );

  it.each(["ls -la", "rm file.txt", "curl https://example.com", "git status", "git push --dry-run", "python3 x.py", "echo 'rm -rf' > note.txt"])(
    "%s is plain", (cmd) => expect(classifyCommand(cmd).kind).toBe("plain")
  );

  it("labels the match so the approval card can say what it is asking about", () => {
    const c = classifyCommand("git push");
    expect(c.kind === "plain" ? "" : c.label).toBe("git push");
  });

  it.each([
    ["echo hi # don't worry\nrm -rf /tmp/x", "destructive"], ["ls # it's fine\ngit push origin main", "external_write"],
    ["# Paco's cleanup\nrm -rf build", "destructive"], ["cat <<'EOF'\nit's\nEOF\nrm -rf x", "destructive"],
    ["cat > n.md <<EOF\nPaco's notes\nEOF\ngit push", "external_write"], ["cat <<-EOF\n\tx's\n\tEOF\nrm -rf x", "destructive"],
    ["echo it's\nrm -rf x", "destructive"]
  ])("%j → %s: apostrophes in comments and heredocs never hide later lines", (cmd, kind) => expect(classifyCommand(cmd).kind).toBe(kind));

  it.each([["cat <<EOF > notes.md\nrm -rf /tmp/x\nEOF", "destructive"], ["cat <<'EOF'\ngit push\nEOF\nls", "external_write"]])(
    "%j → %s: a heredoc mentioning a destructive command asks (fail toward asking)", (cmd, kind) => expect(classifyCommand(cmd).kind).toBe(kind));

  it.each(["echo hi # rm -rf x", "echo ${#PATH}", "cat <<EOF > notes.md\nnever run rm -rf /\nEOF", "cat <<EOF > n.md\nhello\nEOF"])("%j is plain: comments and harmless heredocs", (cmd) =>
    expect(classifyCommand(cmd).kind).toBe("plain"));

  it.each([
    ["echo $((1<<2))\nrm -rf x", "destructive"], ["echo $((1<<2)); echo ok\ngit push", "external_write"], ["x=$((a<<1))\ngit push", "external_write"],
    ['cat <<E"O"F\nEOF\nrm -rf x', "destructive"], ["cat <<E'O'F\nEOF\nrm -rf x", "destructive"]
  ])("%j → %s: arithmetic shifts and partly quoted words are not heredocs", (cmd, kind) => expect(classifyCommand(cmd).kind).toBe(kind));

  it("`let y=1<<3` followed by a destructive line does not crash and asks (bash would treat it as a heredoc; we fail toward asking)", () => {
    expect(classifyCommand("let y=1<<3\nrm -rf x").kind).toBe("destructive");
  });

  it("caps nesting and fails toward asking, quickly (10000 nested evals)", () => {
    const t0 = Date.now();
    expect(classifyCommand("eval ".repeat(10000) + "rm -rf x")).toEqual({ kind: "destructive", label: "nesting too deep" });
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("treats a parser throw as destructive 'unparseable'", () => {
    expect(classifyCommand({ toString() { throw new Error("x"); } } as unknown as string)).toEqual({ kind: "destructive", label: "unparseable" });
  });
});
