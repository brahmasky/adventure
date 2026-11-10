import { redactForJudge } from "../decisions/egress.js";
import { HOME_SECRETS } from "../omp/protected-paths.js";
import type { RunStore } from "../run/run-store.js";

/**
 * What a skill field may not contain, by Unicode class (the `u` flag), first match named. Each hides or splits text:
 * it can keep a step from the reviewer or break a secret's shape so the scrub misses it. Newline and tab stay. An
 * emoji sequence needs the joiner or a variation selector, and a procedure needs neither, so emoji sequences go too.
 */
export const HIDDEN_CLASSES: ReadonlyArray<readonly [label: string, re: RegExp]> = [
  ["a control character", /(?![\n\t])\p{Cc}/u],
  ["an invisible format character (zero-width, joiner, bidi, tag)", /\p{Cf}/u],
  ["a variation selector", /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u],
  ["an invisible filler character", /[\u115F\u1160\u3164\uFFA0]/u],
  ["a line or paragraph separator", /[\u2028\u2029]/u],
  ["a private-use character", /\p{Co}/u],
  ["an unassigned code point", /\p{Cn}/u],
  ["a lone surrogate", /\p{Cs}/u]
];

const esc =(s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_CHAR = "[A-Za-z0-9_-]";
/** ADR 0032 §3.2 as literals: a path into a credential store under a home directory. A match ends where the name does, so sentence punctuation after it still matches. */
const HOME_SECRET_PATH = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\}|/Users/[^/\\s]+|/home/[^/\\s]+)/(?:${HOME_SECRETS.map(esc).join("|")})(?!${NAME_CHAR})`);
/** A dotenv file after a separator, any case; `.env.example|sample|template` are templates, not secrets. */
const DOTENV_PATH = new RegExp(`(?:^|[\\s/"'\`(])\\.env(?!\\.(?:example|sample|template)(?!${NAME_CHAR}))(?:\\.${NAME_CHAR}+)?(?!${NAME_CHAR})`, "im");
const isSecretPath = (s: string): boolean => HOME_SECRET_PATH.test(s) || DOTENV_PATH.test(s);

/** What a skill field may not contain: a known secret value, a secret-shaped token, or a secret path. Changes the text when it finds one. */
export function fieldScrub(store: Pick<RunStore, "redactSecretValues">): (s: string) => string {
  return (s) => {
    const r = redactForJudge(s, { brokerRedact: (x) => store.redactSecretValues(x) });
    return isSecretPath(r) ? `${r} ‹secret path›` : r;
  };
}
