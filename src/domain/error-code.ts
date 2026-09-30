/**
 * Error text that may enter an error_ref, an incident detail or a log line (fix round 1, M-6):
 * an errno-style code, never an fs message (those carry paths) or free text.
 */
export function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : error instanceof Error ? error.name : "unknown";
}

/** Code-owned short reasons ("planner not running", "start timed out") have no path characters. */
const SAFE_REASON = /^[A-Za-z0-9_ .:=-]{1,80}$/;

/** The errno code when there is one; else the message only if it is short and path-free; else the error's name. */
export function safeReason(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return SAFE_REASON.test(text) ? text : errorCode(error);
}
