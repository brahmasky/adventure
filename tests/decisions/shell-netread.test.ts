import { describe, expect, it } from "vitest";
import { isNetworkCommand } from "../../src/decisions/entries/shell-netread.js";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry } from "../../src/decisions/types.js";

// Spec §7.2: a command that reads from the network makes the turn untrusted. Best effort by design: a miss costs a missed
// `untrusted` (the output is judged anyway, §7.1), never a missed judgement. tool.shell_class (approvals) is untouched.
const NETWORK = ["curl https://example.com", "wget -qO- http://x.example", "http GET api.example.com", "ssh paco@mini uptime", "scp host:/etc/hosts .",
  "rsync -a mini:/data ./data", "git fetch origin", "git -C repo pull", "git clone https://github.com/a/b", "nc example.com 80",
  "python3 -c \"import urllib.request as u; print(u.urlopen('https://x').read())\"", "node -e \"fetch('https://x').then(r=>r.text())\"",
  "cat list.txt | xargs curl -s", "for u in a b; do curl -s https://$u.example; done", "env FOO=1 curl https://x", "/usr/bin/curl https://x"];
const LOCAL = ["ls -la", "git log -n 5", "git status", "cat README.md", "grep -rn http src", "echo https://example.com", "python3 script.py", "rsync -a ./a ./b",
  "node build.js", "scp ./a ./b"];

describe("tool.shell_netread", () => {
  it("flags every network reader", () => { for (const c of NETWORK) expect([c, isNetworkCommand(c).network]).toEqual([c, true]); });
  it("leaves local commands local (a URL in an echo or a grep reads nothing)", () => { for (const c of LOCAL) expect([c, isNetworkCommand(c).network]).toEqual([c, false]); });
  it("is a sound code-only entry whose network verdict only tightens", () => {
    const e = entryById("tool.shell_netread") as AnyEntry;
    expect(entryProblems(e)).toEqual([]);
    expect(e.ladder.every((r) => r.kind === "rule")).toBe(true);
    expect(e.effects.network?.kind).toBe("tighten");
  });
});
