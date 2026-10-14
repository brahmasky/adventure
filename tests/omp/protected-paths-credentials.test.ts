import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_PATTERNS, isCredentialPath, isDeniedRead, isDeniedWrite } from "../../src/omp/protected-paths.js";
import { renderSeatbelt } from "../../src/omp/seatbelt.js";

// Spec §7.0: the planner could read project .env files, opencode's auth.json, ollama's key, shell histories and browser
// profiles. Every byte it reads may go to TypeSafe (R11) and to its own model provider, so credential stores must be
// unreadable by NAME, in both the bridge's gate (built-in read) and the Seatbelt profiles (a shell `cat`).
const home = mkdtempSync(join(tmpdir(), "hcred-"));
const ctx = { home, repo: join(home, "Projects/adventure"), data: join(home, "Projects/adventure") };
const DENIED = [
  "Projects/adventure/.env.bak-2026-10-07", "Projects/trading-bot/.env", "Projects/a/b/c/.env.local",
  ".local/share/opencode/auth.json", ".config/some-tool/credentials.toml", ".ollama/id_ed25519", ".ssh2/id_rsa.pub", "Projects/x/keys/ID_RSA",
  ".zsh_history", ".bash_history", ".python_history", ".local/share/fish/fish_history", ".config/fish/fish_variables",
  ".agent-browser/profile/Cookies", "Library/Application Support/Claude/config.json", "Library/Cookies/Cookies.binarycookies",
  "Downloads/service_account-prod.json", "Projects/x/client_secret_123.apps.json", "Projects/x/gcp-credentials-v2.json",
  "Projects/x/oauth_token.json", "Projects/x/gmail-token.json", "Projects/x/token.json", "certs/privkey.pem", "certs/server.key", "certs/tls-private.pem",
  "certs/bundle.p12", "Projects/whatsapp-task-bot/.baileys_auth/creds.json", "Projects/bot/auth_info_baileys/creds.json"
];
// Plan S3 (Rev 2 extends it, senior W8): the spec's literal `*auth*/`, `id_*`, `*token*.json`, `*.pem`, `*.key` patterns would
// also match these and blind coding turns or break HTTPS in a project venv; .env templates carry no secrets and a coding task writes them.
const READABLE = [
  "Projects/adventure/README.md", "Projects/lego/packages/author/index.ts", "Projects/openclaw/src/agents/auth-profiles/a.ts",
  "Projects/hermes-agent/skills/github/github-auth/SKILL.md", "Projects/x/src/id_map.py", "notes/env-setup.md", "Projects/x/src/environment.ts",
  "Projects/adventure/.env.example", "Projects/x/.env.sample", "Projects/x/.venv/lib/python3.12/site-packages/certifi/cacert.pem", "Projects/x/certs/fullchain.pem",
  "Projects/x/models/tokenizer.json", "Projects/x/design/tokens.json", "Projects/x/design/design-tokens.json", "Documents/Talk.key"
];

describe("credential stores by name (spec §7.0)", () => {
  it("the bridge gate refuses every credential path, read and write", () => {
    for (const p of DENIED) expect([p, isDeniedRead(join(home, p), ctx), isDeniedWrite(join(home, p), ctx)]).toEqual([p, true, true]);
  });
  it("source code, CA bundles, tokenizers, design tokens, .env templates stay readable (S3, senior W8)", () => {
    for (const p of READABLE) expect([p, isCredentialPath(join(home, p), home), isDeniedRead(join(home, p), ctx)]).toEqual([p, false, false]);
  });
  it("every pattern is a JS regex and uses no alternation (SBPL and JS must read it the same way)", () => {
    for (const b of CREDENTIAL_PATTERNS) { expect(() => new RegExp(b)).not.toThrow(); expect(b.includes("|")).toBe(false); }
  });
  it("both rendered Seatbelt profiles carry a read+write deny for every pattern", () => {
    const r = renderSeatbelt(ctx);
    for (const profile of [r.planner, r.shell]) {
      const rules = profile.split("\n").filter((l) => l.startsWith("(deny file-read* file-write* (regex"));
      for (const b of CREDENTIAL_PATTERNS) expect(rules.some((l) => l.endsWith(`${b}$"))`))).toBe(true);
    }
  });
  it.runIf(process.platform === "darwin")("a sandboxed cat cannot read a planted dummy credential file; every READABLE file reads", () => {
    for (const p of [...DENIED, ...READABLE]) { mkdirSync(dirname(join(home, p)), { recursive: true }); writeFileSync(join(home, p), "dummy\n"); }
    const profile = join(home, "shell.sb"); writeFileSync(profile, renderSeatbelt(ctx).shell);
    const cat = (p: string): boolean => { try { execFileSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/cat", join(home, p)], { stdio: "pipe" }); return true; } catch { return false; } };
    for (const p of DENIED) expect([p, cat(p)]).toEqual([p, false]);
    for (const p of READABLE) expect([p, cat(p)]).toEqual([p, true]);
  });
  it.runIf(process.platform === "darwin")("the .env template allow never re-opens a write inside a protected tree (senior W-R2-2)", () => {
    const profile = join(home, "shell-w.sb"); writeFileSync(profile, renderSeatbelt(ctx).shell);
    const touch = (p: string): boolean => { mkdirSync(dirname(join(home, p)), { recursive: true });
      try { execFileSync("/usr/bin/sandbox-exec", ["-f", profile, "/usr/bin/touch", join(home, p)], { stdio: "pipe" }); return true; } catch { return false; } };
    expect(touch("Projects/adventure/src/decisions/.env.example")).toBe(false);
    expect(touch(".bun/x/.env.example")).toBe(false);
    expect(touch("Projects/other/.env.example")).toBe(true);
  });
  it("a template-named symlink to a real .env is refused; a real template file still reads (review fix round 1)", () => {
    // A planner shell may write the workspace: `ln -s ~/Projects/x/.env <ws>/.env.example` must not turn the gate's template
    // exemption into a read of another project's secrets. The exemption holds only when EVERY spelling is a template name.
    const ws = join(ctx.data, "omp", "workspace"), target = join(home, "Projects/fx/.env"), real = join(ws, "real/.env.example");
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "dummy\n");
    mkdirSync(dirname(real), { recursive: true }); writeFileSync(real, "dummy\n");
    const link = join(ws, ".env.example"); symlinkSync(target, link);
    expect([isCredentialPath(link, home), isDeniedRead(link, ctx), isDeniedWrite(link, ctx)]).toEqual([true, true, true]);
    expect([isCredentialPath(real, home), isDeniedRead(real, ctx)]).toEqual([false, false]);
  });
});
