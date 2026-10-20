/** The 32 KiB cut every bridge response shares; a leaf module so bridge-read-judge and bridge-handler need no import cycle. */
export const RESPONSE_CAP = 32 * 1024;
export const TRUNCATION_NOTE = "\n…[truncated at 32 KiB]";

/** Cap in UTF-8 bytes, cut on a character boundary (never inside a multi-byte sequence). */
export function capResponse(s: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= RESPONSE_CAP) return s;
  let end = RESPONSE_CAP;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}${TRUNCATION_NOTE}`;
}
