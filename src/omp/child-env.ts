/** The child env for every spawned CLI: an allowlist, never process.env wholesale (ADR 0015 §5). */
export const CLI_ENV_ALLOWLIST = ["PATH", "HOME", "TERM", "LANG", "USER"] as const;

export function buildChildEnv(passthrough: string[] | string | undefined): Record<string, string> {
  const extra = Array.isArray(passthrough) ? passthrough : (passthrough ?? "").split(",");
  const allowed = new Set<string>(CLI_ENV_ALLOWLIST);
  for (const name of extra.map((n) => n.trim())) if (name.length > 0) allowed.add(name);
  const env: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
