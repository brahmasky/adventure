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
  ["a variation selector", /\p{Variation_Selector}/u],
  ["an invisible filler or blank character", /[\u115F\u1160\u3164\uFFA0\u2800\u{16FE4}\u{1D159}]/u],
  ["an invisible default-ignorable character (such as a combining grapheme joiner)", /\p{Default_Ignorable_Code_Point}/u],
  ["a line or paragraph separator", /[\u2028\u2029]/u],
  ["a private-use character", /\p{Co}/u],
  ["an unassigned code point", /\p{Cn}/u],
  ["a lone surrogate", /\p{Cs}/u]
];
const HIDDEN_ANY = new RegExp(HIDDEN_CLASSES.map(([, re]) => re.source).join("|"), "gu");
/** The text a reader sees: hidden characters dropped, compatibility forms folded (fullwidth `ｇｈｐ_` reads as `ghp_`). */
export const visibleView = (s: string): string => s.replace(HIDDEN_ANY, "").normalize("NFKC");

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_CHAR = "[A-Za-z0-9_-]";
/**
 * ADR 0032 §3.2 as literals: a path into a credential store under a home directory, any case (APFS folds case). A
 * match ends where the name does, so sentence punctuation after it still matches.
 */
const HOME_SECRET_PATH = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\}|/Users/[^/\\s]+|/home/[^/\\s]+)/(?:${HOME_SECRETS.map(esc).join("|")})(?!${NAME_CHAR})`, "i");
/** A dotenv file after anything but a name character or a dot, any case; `.env.example|sample|template` are templates, not secrets. */
const DOTENV_PATH = new RegExp(`(?:^|[^A-Za-z0-9_.-])\\.env(?!\\.(?:example|sample|template)(?!${NAME_CHAR}))(?:\\.${NAME_CHAR}+)?(?!${NAME_CHAR})`, "im");
/** `//` and `/./` read as `/`, and `seg/..` as nothing, so `~//.ssh`, `~/./.ssh` and `~/Documents/../.ssh` are judged as `~/.ssh`. */
const DOT_DOT_HOP = /\/(?!\.\.(?:\/|$))[^/\s]+\/\.\.(?=\/|$)/;
const samePath = (s: string): string => {
  let p = s.replace(/\/(?:\.?\/)+/g, "/");
  while (DOT_DOT_HOP.test(p)) p = p.replace(DOT_DOT_HOP, "");   // terminates: each pass shortens the text
  return p;
};
/** A `..` the hops could not resolve (`~/../paco/.ssh`, a segment with a space) followed by a credential store: judged a secret path, fail closed. */
const UNRESOLVED_HOP_SECRET = new RegExp(`(?:^|[\\s/])\\.\\.(?=/|$)[\\s\\S]*?/(?:${HOME_SECRETS.map(esc).join("|")})(?!${NAME_CHAR})`, "i");
const isSecretPath = (s: string): boolean => { const p = samePath(s); return HOME_SECRET_PATH.test(p) || UNRESOLVED_HOP_SECRET.test(p) || DOTENV_PATH.test(p); };

/**
 * What a skill field may not contain: a known secret value, a secret-shaped token, or a secret path. Changes the text
 * when it finds one, in the text as given or in its visible view (a secret split by a soft hyphen, or spelled
 * fullwidth). Text whose view differs but holds no secret comes back unchanged: `½` or `…` is not a secret.
 */
export function fieldScrub(store: Pick<RunStore, "redactSecretValues">): (s: string) => string {
  const one = (s: string): string => {
    const r = redactForJudge(s, { brokerRedact: (x) => store.redactSecretValues(x) });
    return isSecretPath(r) ? `${r} ‹secret path›` : r;
  };
  return (s) => {
    const r = one(s);
    if (r !== s) return r;
    const v = visibleView(s);
    if (v === s) return s;
    const w = one(v);
    return w === v ? s : `${w} ‹secret›`;
  };
}
