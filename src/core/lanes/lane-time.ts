/** Stage B §5/§8: the marker for "did not arrive in time, or the turn ended first". A LATE value is never used. */
export const LATE: unique symbol = Symbol("late");
export type Late = typeof LATE;

/**
 * `p` raced against `ms` and the turn's signal. The adapters behind `p` take no signal, so a late result is dropped, never
 * used; a later rejection of `p` stays handled (the race, or the explicit catch on the already-aborted path, subscribes).
 */
export function within<T>(ms: number, p: Promise<T>, signal: AbortSignal): Promise<T | Late> {
  if (signal.aborted) { void p.catch(() => undefined); return Promise.resolve(LATE); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<Late>((resolve) => {
    timer = setTimeout(() => resolve(LATE), Math.max(0, ms));
    onAbort = () => resolve(LATE);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([p, late]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}
