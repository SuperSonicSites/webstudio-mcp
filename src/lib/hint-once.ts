// Per-process rate limiting for pedagogical hints (v2.20.3).
//
// Fixed teaching strings appended to EVERY response are pure token overhead
// after the first occurrence — for a 1-instance read.inspect the hint exceeded
// the data. Emit on the first call and every Nth thereafter; periodic
// re-emission guards against client-side context compaction dropping the hint
// from a long session. Counters are module-scope (precedent: the build cache
// Map in webstudio-client.ts) — stdio servers are long-lived per session.

const counters = new Map<string, number>();

/**
 * Returns `text` on the 1st call for `key` and every `everyN`th call after,
 * otherwise "". Callers append the result unconditionally.
 */
export function hintOnce(key: string, text: string, everyN = 10): string {
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return n === 1 || n % everyN === 0 ? text : "";
}

/** Test hook: reset all counters. */
export function resetHintCounters(): void {
  counters.clear();
}
