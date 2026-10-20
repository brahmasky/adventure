// Runs inside the omp planner process. Protected (self-write guard). Imports nothing from Houge.
// 2b-i §2.4 / 2b-R12: when the bridge is late or down, this fail-closed copy of Houge's phrase floor
// (src/decisions/entries/tool-injection.ts) and content checks (src/decisions/egress.ts passageBlock) decides. Any hit
// withholds the WHOLE canonical text: there is no splitter here on purpose. tests/omp/injection-floor.test.ts pins the
// regex sources byte-equal to Houge's and the verdicts equal on a fixture list.
export const INSTRUCTION_SOURCES: readonly string[] = [
  String.raw`ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)`,
  String.raw`disregard\s+(?:your\s+|all\s+|the\s+)?(?:previous|prior|instructions?|rules?|safety)`,
  String.raw`forget\s+(?:everything|anything|all|what)\s+(?:you|that)\s+(?:were|was|have\s+been)\s+told`,
  String.raw`(?:new|updated|revised)\s+instructions\s+(?:from|for)\s+(?:the\s+|your\s+)?(?:developer|system|admin\w*|operator|assistant|model|ai)\b`,
  String.raw`system\s*:\s*you`, String.raw`system\s+override`, String.raw`developer\s+mode`,
  String.raw`you\s+are\s+now\s+(?:in|a|an|the|dan|free|unrestricted|jailbroken)\b`,
  String.raw`(?:reveal|print|output|repeat|show)\s+(?:me\s+)?your\s+(?:system\s+)?(?:prompt|instructions)`,
  String.raw`(?:do\s+not|don'?t|never)\s+(?:tell|inform|alert|notify)\s+the\s+(?:user|operator|human|person)\s+(?:about|that\s+you)`,
  "忽略(?:之前|以上|上面|前面|先前)(?:的|所有的?)?(?:所有)?(?:指令|指示|提示|规则)"
];
export const CONTENT_SOURCES = Object.freeze({
  pem: String.raw`-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----`,
  secretJson: String.raw`"(?:private_key|client_secret|refresh_token)"\s*:`,
  serviceAccount: String.raw`"type"\s*:\s*"service_account"`,
  cookieJar: String.raw`^(?:\d{1,10}(?:-\d{1,10})?[:|])?#\s*(?:Netscape\s+)?HTTP Cookie File`
});
const INSTRUCTION = new RegExp(INSTRUCTION_SOURCES.join("|"), "i");
const INVISIBLE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g; // `\u` escapes, never literal invisibles (a copy-paste drops them silently)
const CONTENT = [new RegExp(CONTENT_SOURCES.pem), new RegExp(CONTENT_SOURCES.secretJson), new RegExp(CONTENT_SOURCES.serviceAccount), new RegExp(CONTENT_SOURCES.cookieJar, "im")];
/** The same text as Houge's WITHHELD_TEXT, plus why the whole read is gone (code-owned, never tool bytes). */
export const FLOORED_TEXT = "[withheld: text aimed at the assistant] (Houge could not judge this file in time; none of it is shown)";
const STOP = new Set("the and for are but not you all can was one our out has his how its who did get may him she too use her that this with from they have were will your what when been than them then".split(" "));
const SEED_LINE = /^(?:\d{1,10}(?:-\d{1,10})?[:|])?[ \t]*((?:[a-z]{3,8}[ \t]+){11,23}[a-z]{3,8})[ \t]*$/gm;
/** Secret-named keys (a segment equals a secret word) followed by a credential-shaped value: the dense-secrets count. */
const SECRET_WORDS = new Set(["pass", "passwd", "password", "passphrase", "pwd", "secret", "token", "key", "auth", "authorization", "cookie", "credential", "credentials",
  "signature", "apikey", "accesstoken", "authtoken", "secretkey", "privatekey", "clientsecret", "refreshtoken", "accesskey", "sessiontoken", "sid", "csrf", "xsrf", "jwt", "bearer"]);
// The line-start alternatives accept omp's read prefix `N:` (live gate 2b-i case 9), as egress's KEY_AT and SEED_LINE do;
// elsewhere any non-word character, or a word-starting run of one to eight `.`/`-` (A3, M1), may precede a key.
const KEY_VALUE = /(?:(?<=^(?:\d{1,10}(?:-\d{1,10})?[:|])?)|(?<![A-Za-z0-9_.-])|(?<=(?:^|[^A-Za-z0-9_.-])[.-]{1,8}))["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=][ \t]*["']?([^\s"',;&]{8,})/gm;
/** A3: `<key>value</key>` on one line, as egress's XML_PAIR. */
const XML_VALUE = /<([A-Za-z][A-Za-z0-9_.-]*)>([^<\n]{8,})<\/\1>/g;
/** A3: an all-caps env name ending in a secret word (`PGPASSWORD`), as egress's CAPS_SECRET (`MONKEY=ban4na` counts too). */
const CAPS_SECRET = /^[A-Z0-9_]+(?:PASSWORD|PASSWD|TOKEN|SECRET|KEY)$/;

/** Houge's looksInjected: NFKC, invisibles out, `_`/`-` and camelCase as spaces. */
export function looksInjectedLocal(text: string): boolean {
  return INSTRUCTION.test(text.normalize("NFKC").replace(INVISIBLE, "").replace(/[_-]+/g, " ").replace(/(?<=[a-z])(?=[A-Z])/g, " "));
}

/** `session` is secret only beside `id`, `key` or `token`, as egress's SESSION_PAIR. */
const SESSION_PAIR = new Set(["id", "key", "token"]);
/** A copy of egress's secretKey (2b-i final review A2): split on non-alphanumerics, then camelCase, THEN lowercase. */
function secretNamed(key: string): boolean {
  const segs = key.split(/[^A-Za-z0-9]+/).flatMap((s) => s.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).map((s) => s.toLowerCase()).filter(Boolean);
  return CAPS_SECRET.test(key) || segs.some((s, k) => SECRET_WORDS.has(s) || (s === "session" && SESSION_PAIR.has(segs[k + 1] ?? "")));
}

function seedPhrase(raw: string): boolean {
  for (const m of raw.matchAll(SEED_LINE)) { const w = m[1]!.split(/[ \t]+/); if (w.length % 3 === 0 && !w.some((x) => STOP.has(x))) return true; }
  return false;
}

function denseSecrets(raw: string): boolean {
  let n = 0;
  for (const m of [...raw.matchAll(KEY_VALUE), ...raw.matchAll(XML_VALUE)]) if (secretNamed(m[1]!) && !/^[a-z]+$/i.test(m[2]!)) n++;
  return n >= 3;
}

/** The whole canonical text, or FLOORED_TEXT on any phrase or content hit (fail closed). */
export function applyFloor(text: string): { text: string; withheld: boolean } {
  const hit = looksInjectedLocal(text) || CONTENT.some((re) => re.test(text)) || seedPhrase(text) || denseSecrets(text);
  return hit ? { text: FLOORED_TEXT, withheld: true } : { text, withheld: false };
}
