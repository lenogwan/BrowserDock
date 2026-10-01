// Track counts, not instance IDs: a reconnect receives a fresh instance ID.
// Keep no tab inventory after a connection disappears.
/**
 * @param {Record<string, {count: number, since: number | null}>} previous
 * @param {{browser: string}[]} instances
 * @param {number} now
 */
export function recoveryState(previous, instances, now) {
  const counts = new Map();
  for (const instance of instances) counts.set(instance.browser, (counts.get(instance.browser) ?? 0) + 1);
  /** @type {Record<string, {count: number, since: number | null}>} */
  const next = {};
  for (const browser of new Set([...Object.keys(previous), ...counts.keys()])) {
    const count = counts.get(browser) ?? 0;
    const old = previous[browser];
    const expected = Math.max(count, old?.count ?? 0);
    const since = count < expected ? (old?.since ?? now) : null;
    next[browser] = since !== null && now - since >= 15000
      ? { count, since: null }
      : { count: expected, since };
  }
  return next;
}
