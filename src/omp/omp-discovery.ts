/**
 * ADR 0032 5.1 (k): the omp discovery providers that can load code (custom tools, hooks, extension modules, MCP servers,
 * settings) from the planner's cwd or $HOME. All of them are listed in the planner's config overlay as `disabledProviders`.
 * These are omp discovery-provider ids, not model providers and not binaries: "claude" here names Claude Code's config
 * directories, which omp would read for project tools and hooks.
 */
export const OMP_DISABLED_DISCOVERY: readonly string[] = ["native", "claude", "claude-plugins", "codex", "omp-plugins", "agent-plugins",
  "cursor", "gemini", "opencode", "windsurf", "vscode", "github"];
