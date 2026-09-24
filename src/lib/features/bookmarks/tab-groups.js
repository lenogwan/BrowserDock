import { bookmarkHost } from './search.js';

/** @param {string | undefined} color */
export function groupColor(color) {
  return ({ grey: '#9aa0a6', blue: '#4285f4', red: '#ea4335', yellow: '#fbbc04', green: '#34a853', pink: '#ff8bcb', purple: '#a142f4', cyan: '#24c1e0', orange: '#fa903e' })[color ?? 'grey'] ?? '#9aa0a6';
}

/** @typedef {import('../../shared/types').InstanceDigest['tabs'][number]} DigestTab
 * @typedef {{byHost: Map<string, DigestTab>, byHostStore: Map<string, DigestTab>, groups: Set<string>, storedGroups: Set<string>, defaultStores: Map<string, string>}} BrowserGroupIndex */
/** Build native-group lookups once per companion snapshot. A digest can contain
 * 2,000 tabs, so row rendering must not search every tab for every bookmark.
 * @param {import('../../shared/types').InstanceDigest[]} instances
 * @param {import('../../shared/types').Browser[]} browsers
 * @returns {BrowserGroupIndex} */
export function buildBrowserGroupIndex(instances, browsers = []) {
  const byHost = new Map();
  const byHostStore = new Map();
  const groups = new Set();
  const storedGroups = new Set();
  const defaultStores = new Map(
    browsers.flatMap(browser => browser.container ? [[browser.id, browser.container]] : []),
  );
  for (const instance of instances ?? []) {
    const namesById = new Map();
    for (const container of instance.containers ?? []) {
      const id = container.cookieStoreId ?? container.cookie_store_id;
      if (typeof id === 'string' && typeof container.name === 'string' && container.name) {
        const names = namesById.get(id) ?? [];
        names.push(container.name);
        namesById.set(id, names);
      }
    }
    for (const tab of instance.tabs ?? []) {
      if (tab.groupTitle === undefined) continue;
      const title = tab.groupTitle;
      const groupKey = `${instance.browser}\t${title}`;
      groups.add(groupKey);
      const stores = new Set(
        [tab.cookieStoreId, tab.cookie_store_id].filter(value => typeof value === 'string' && value),
      );
      for (const store of [...stores]) {
        for (const name of namesById.get(store) ?? []) stores.add(name);
      }
      for (const store of stores) storedGroups.add(`${groupKey}\t${store}`);

      const host = typeof tab.host === 'string' ? tab.host.toLowerCase() : '';
      if (!host) continue;
      const hostKey = `${instance.browser}\t${host}`;
      if (!byHost.has(hostKey)) byHost.set(hostKey, tab);
      for (const store of stores) {
        const storedKey = `${hostKey}\t${store}`;
        if (!byHostStore.has(storedKey)) byHostStore.set(storedKey, tab);
      }
    }
  }
  return { byHost, byHostStore, groups, storedGroups, defaultStores };
}

/** @param {import('../../shared/types').Bookmark} bookmark @param {BrowserGroupIndex} index */
function wantedStore(bookmark, index) {
  return bookmark.browser_options?.container || index.defaultStores.get(bookmark.target_browser);
}

/** @param {import('../../shared/types').Bookmark} bookmark @param {BrowserGroupIndex} index */
export function browserGroupFromIndex(bookmark, index) {
  if (bookmark.browser_options?.incognito) return undefined;
  const host = bookmarkHost(bookmark);
  if (!host) return undefined;
  const key = `${bookmark.target_browser}\t${host}`;
  const store = wantedStore(bookmark, index);
  return store ? index.byHostStore.get(`${key}\t${store}`) : index.byHost.get(key);
}

/** @param {import('../../shared/types').Group} group @param {import('../../shared/types').Bookmark[]} bookmarks @param {BrowserGroupIndex} index */
export function hasBrowserGroupInIndex(group, bookmarks, index) {
  return bookmarks.some(bookmark => {
    if (bookmark.browser_options?.incognito) return false;
    const key = `${bookmark.target_browser}\t${group.name}`;
    const store = wantedStore(bookmark, index);
    return store ? index.storedGroups.has(`${key}\t${store}`) : index.groups.has(key);
  });
}

/** Compatibility helper for callers without a retained snapshot index.
 * @param {import('../../shared/types').Bookmark} bookmark @param {import('../../shared/types').InstanceDigest[]} instances @param {import('../../shared/types').Browser[]} browsers */
export function browserGroupFor(bookmark, instances, browsers = []) {
  return browserGroupFromIndex(bookmark, buildBrowserGroupIndex(instances, browsers));
}

/** Compatibility helper for callers without a retained snapshot index.
 * @param {import('../../shared/types').Group} group @param {import('../../shared/types').Bookmark[]} bookmarks @param {import('../../shared/types').InstanceDigest[]} instances @param {import('../../shared/types').Browser[]} browsers */
export function hasBrowserGroup(group, bookmarks, instances, browsers = []) {
  return hasBrowserGroupInIndex(group, bookmarks, buildBrowserGroupIndex(instances, browsers));
}
