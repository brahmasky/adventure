import { redactForJudge } from "../decisions/egress.js";
import { HOME_SECRETS } from "../omp/protected-paths.js";
import type { RunStore } from "../run/run-store.js";

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** ADR 0032 §3.2 as literals: a path into a credential store under a home directory, or a dotenv file (templates exempt). */
const SECRET_PATH = new RegExp(`(?:~|\\$HOME|/Users/[^/\\s]+)/(?:${HOME_SECRETS.map(esc).join("|")})(?=$|[/\\s"'\`:,;)])|(?:^|[\\s/"'\`(])\\.env(?!\\.(?:example|sample|template)\\b)(?:\\.[A-Za-z0-9_-]+)?(?=$|[\\s"'\`:,;)])`, "m");

/** What a skill field may not contain: a known secret value, a secret-shaped token, or a secret path. Changes the text when it finds one. */
export function fieldScrub(store: Pick<RunStore, "redactSecretValues">): (s: string) => string {
  return (s) => {
    const r = redactForJudge(s, { brokerRedact: (x) => store.redactSecretValues(x) });
    return SECRET_PATH.test(r) ? `${r} ‹secret path›` : r;
  };
}
