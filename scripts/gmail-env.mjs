// Pure .env helpers for scripts/gmail-auth.mjs --account paco (zero dependencies; unit-tested in tests/scripts).

/** Parses KEY=VALUE lines (optional `export `, optional matching quotes, `#` comments); the first value of a name wins, as the daemon's loader does. */
export function parseEnvText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m || m[1] in out) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Sets `NAME=value`: replaces the first existing line (dropping any later duplicates, since the loader keeps the first), else appends. Other lines are kept as they are. */
export function upsertEnvLine(text, name, value) {
  const line = `${name}=${value}`;
  const isMine = (l) => new RegExp(`^\\s*(?:export\\s+)?${name}=`).test(l);
  const lines = text.length === 0 ? [] : text.split("\n");
  if (!lines.some(isMine)) return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
  let placed = false;
  const out = [];
  for (const l of lines) {
    if (!isMine(l)) out.push(l);
    else if (!placed) { out.push(line); placed = true; }
  }
  return out.join("\n");
}
