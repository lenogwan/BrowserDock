import Fuse from "fuse.js";
/** @typedef {import('../../shared/types').Bookmark & {group_name: string}} IndexedBookmark
 * @typedef {{items: IndexedBookmark[]; fuse: import('fuse.js').default<IndexedBookmark>}} BookmarkIndex */
const indexCache = /** @type {WeakMap<object, WeakMap<object, BookmarkIndex>>} */ (new WeakMap());
/** Build (and memoize) a Fuse index for an exact bookmarks/groups array pair.
 * Component `$derived` arrays keep identity across renders, so per-keystroke
 * searches reuse the index and only pay for the query itself. */
/** @param {import('../../shared/types').Bookmark[]} bookmarks @param {import('../../shared/types').Group[]} groups @returns {BookmarkIndex} */
export function createBookmarkIndex(bookmarks, groups = []) {
  let byGroups = indexCache.get(bookmarks);
  if (!byGroups) { byGroups = new WeakMap(); indexCache.set(bookmarks, byGroups); }
  let entry = byGroups.get(groups);
  if (!entry) {
    const groupNames = new Map(groups.map(g => [`${g.id}	${!!g.private}`, g.name ?? ""]));
    const items = /** @type {IndexedBookmark[]} */ (bookmarks.map(b => ({ ...b, group_name: groupNames.get(`${b.group_id}	${!!b.private}`) ?? "" })));
    entry = {
      items,
      fuse: new Fuse(items, {
        keys: [{ name: "title", weight: 0.4 }, { name: "tags", weight: 0.3 }, { name: "url", weight: 0.2 }, { name: "group_name", weight: 0.1 }],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    };
    byGroups.set(groups, entry);
  }
  return entry;
}
/** @param {import('../../shared/types').Bookmark[]} bookmarks @param {string} query @param {import("../../shared/types").Group[]} groups */
export function searchBookmarks(bookmarks, query, groups = []) {
  if (!query.trim()) return bookmarks;
  return createBookmarkIndex(bookmarks, groups).fuse.search(query.trim()).map((result) => result.item);
}
/** @param {string} value */
export function directUrl(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  value = value.trim();
  if (/[\u0000-\u0020\u007f]/.test(value) || !value) return null;
  const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#].*)?$/i;
  if (!value.includes("://") && !value.includes(".") && !localHost.test(value))
    return null;
  try {
    const url = new URL(value.includes("://") ? value : `${localHost.test(value) ? "http" : "https"}://${value}`);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
/** @param {import('../../shared/types').Bookmark} bookmark @param {import('../../shared/types').Instance[]} instances */
export function openInBrowser(bookmark, instances) {
  try {
    const host = new URL(bookmark.url).hostname.toLowerCase();
    return instances.some(
      (instance) => {
        if (instance.browser !== bookmark.target_browser) return false;
        const wanted = bookmark.browser_options?.container;
        const namesById = new Map();
        for (const c of instance.containers ?? []) {
          const id = c.cookieStoreId ?? c.cookie_store_id;
          if (typeof id === "string" && typeof c.name === "string" && c.name) {
            if (!namesById.has(id)) namesById.set(id, []);
            namesById.get(id).push(c.name);
          }
        }
        return instance.tabs.some((tab) => {
          try {
            if (new URL(tab.url).hostname.toLowerCase() !== host) return false;
            if (!wanted) return true;
            if (tab.cookieStoreId === wanted || tab.container === wanted) return true;
            // Resolve human container names (e.g. "Work") to IDs
            // (e.g. "firefox-container-1") via the instance inventory.
            const id = tab.cookieStoreId ?? tab.container;
            return (namesById.get(id) ?? []).includes(wanted);
          } catch {
            return false;
          }
        });
      },
    );
  } catch {
    return false;
  }
}
/** A companion row in either shape: full instance (`tabs[].url`) or lightweight
 * digest (`tabs[].host`, already parsed server-side).
 * Gecko tabs carry `cookieStoreId` values like `firefox-container-1` while
 * bookmarks store the human name (`Work`), so instances may also carry a
 * `containers` list (`{name, cookieStoreId}`) to resolve names to IDs —
 * mirroring the backend `focus_or_open` name→ID resolution.
 * @typedef {{browser: string; tabs?: {url?: string; host?: string; cookieStoreId?: string; container?: string; cookie_store_id?: string}[]; containers?: {name?: string; cookieStoreId?: string; cookie_store_id?: string}[]}} OpenTabRow
 * @typedef {{base: Set<string>; stored: Set<string>}} OpenTabIndex */
/** Precompute open-tab lookup once per companion snapshot instead of parsing
 * every tab URL for every rendered row. Accepts full instances (`tabs[].url`)
 * or lightweight digests (`tabs[].host`, already parsed server-side). Container
 * names are indexed alongside IDs so Firefox `browser_options.container`
 * values (e.g. `Work`) match `cookieStoreId`s (e.g. `firefox-container-1`). */
/** @param {OpenTabRow[]} instances @returns {OpenTabIndex} */
export function buildOpenTabIndex(instances) {
  const base = /** @type {Set<string>} */ (new Set());
  const stored = /** @type {Set<string>} */ (new Set());
  for (const instance of instances ?? []) {
    // Map cookieStoreId -> container name(s) for this instance.
    const namesById = new Map();
    for (const c of instance.containers ?? []) {
      const id = c.cookieStoreId ?? c.cookie_store_id;
      if (typeof id === "string" && typeof c.name === "string" && c.name) {
        if (!namesById.has(id)) namesById.set(id, []);
        namesById.get(id).push(c.name);
      }
    }
    for (const tab of instance.tabs ?? []) {
      let host = tab.host;
      if (!host) {
        try { host = new URL(tab.url ?? "").hostname; } catch { continue; }
      }
      host = String(host).toLowerCase();
      if (!host) continue;
      const key = `${instance.browser}	${host}`;
      base.add(key);
      const ids = [tab.cookieStoreId, tab.cookie_store_id, tab.container].filter(
        (v) => typeof v === "string" && v,
      );
      for (const id of ids) {
        stored.add(`${key}	${id}`);
        // Index the human-readable name(s) for this ID as well, so a bookmark
        // saving `container: "Work"` matches a tab with
        // `cookieStoreId: "firefox-container-1"`.
        for (const name of namesById.get(id) ?? []) {
          stored.add(`${key}	${name}`);
        }
      }
      // Reverse lookup is covered by the ID loop above: a tab carrying both a
      // human name and an ID indexes both keys, so no extra step is needed.
    }
  }
  return { base, stored };
}
/** O(1) open-indicator check against a prebuilt index. Same semantics as openInBrowser. */
/** @param {import('../../shared/types').Bookmark} bookmark @param {OpenTabIndex} index */
export function isTabOpen(bookmark, index) {
  let host;
  try { host = new URL(bookmark.url).hostname.toLowerCase(); } catch { return false; }
  const key = `${bookmark.target_browser}	${host}`;
  const container = bookmark.browser_options?.container;
  if (!container) return index.base.has(key);
  return index.stored.has(`${key}	${container}`);
}
/** Stable partition: open tabs first, preserving relative order. */
/** @param {import('../../shared/types').Bookmark[]} items @param {OpenTabIndex} index */
export function openFirst(items, index) {
  if (!index) return items;
  const open = /** @type {import('../../shared/types').Bookmark[]} */ ([]);
  const rest = /** @type {import('../../shared/types').Bookmark[]} */ ([]);
  for (const item of items) (isTabOpen(item, index) ? open : rest).push(item);
  return [...open, ...rest];
}
/** Stable partition: pinned bookmarks first, preserving relative order. */
/** @param {import('../../shared/types').Bookmark[]} items */
export function pinnedFirst(items) {
  return [...items.filter((b) => b.pinned), ...items.filter((b) => !b.pinned)];
}
/** Stable partition: recently opened first (most recent first); never-opened keep order at the end. */
/** @param {import('../../shared/types').Bookmark[]} items @param {Map<string, number>} [recent] */
export function recentFirst(items, recent) {
  if (!recent) return items;
  /** @param {string} id @returns {number} */
  const at = (id) => recent.get(id) ?? 0;
  const fresh = items.filter((b) => at(b.id) > 0).sort((a, b) => at(b.id) - at(a.id));
  const seen = new Set(fresh);
  return [...fresh, ...items.filter((b) => !seen.has(b))];
}
/** Combined result ranking for massive lists: open → pinned → recent.
 * Each step is a stable partition, so lower-priority orders survive inside
 * higher-priority blocks (e.g. open items stay pin/recency ordered). */
/** @param {import('../../shared/types').Bookmark[]} items @param {OpenTabIndex} index @param {Map<string, number>} [recent] */
export function rankResults(items, index, recent) {
  return openFirst(pinnedFirst(recentFirst(items, recent)), index);
}
/** @param {string} key */
export function shortcutBrowser(key) {
  return (
    {
      f: "firefox",
      m: "mullvad",
      c: "chrome",
      e: "edge",
      1: "firefox",
      2: "mullvad",
      3: "chrome",
      4: "edge",
    }[key.toLowerCase()] ?? null
  );
}
