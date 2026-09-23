// Recently-opened tracking for result ranking. Persisted in webview
// localStorage so opens never force a config/vault rewrite. Only bookmark
// IDs (random strings) and timestamps are stored — never URLs or titles.
const KEY = "browserdock:recentlyOpened:v1";
export const RECENT_CAP = 100;

/** @param {{ getItem: (k: string) => string | null } | undefined} storage */
export function loadRecentMap(storage = globalThis.localStorage) {
  const map = new Map();
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return map;
    const entries = Object.entries(JSON.parse(raw));
    // Newest first, capped; tolerate corrupt or legacy shapes.
    entries
      .filter(([, ts]) => Number.isFinite(ts) && ts > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, RECENT_CAP)
      .forEach(([id, ts]) => {
        if (typeof id === "string" && id) map.set(id, ts);
      });
  } catch {
    /* Private mode or corrupt payload: rank without recency. */
  }
  return map;
}

/** Record an open and prune oldest beyond the cap. Mutates and returns the map. */
/** @param {Map<string, number>} map @param {string} id @param {number} now */
export function recordRecent(map, id, now = Date.now()) {
  if (!id) return map;
  map.set(id, now);
  if (map.size > RECENT_CAP) {
    const oldest = [...map.entries()].sort(([, a], [, b]) => a - b);
    for (const [key] of oldest.slice(0, map.size - RECENT_CAP)) map.delete(key);
  }
  return map;
}

/** @param {Map<string, number>} map @param {{ setItem: (k: string, v: string) => void } | undefined} storage */
export function saveRecentMap(map, storage = globalThis.localStorage) {
  try {
    storage?.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* Ephemeral session: ranking still works in memory. */
  }
}
