/** @param {string | undefined} color */
export function groupColor(color) {
  return ({ grey: '#9aa0a6', blue: '#4285f4', red: '#ea4335', yellow: '#fbbc04', green: '#34a853', pink: '#ff8bcb', purple: '#a142f4', cyan: '#24c1e0', orange: '#fa903e' })[color ?? 'grey'] ?? '#9aa0a6';
}
/** @param {import('./types').Bookmark} bookmark @param {import('./types').InstanceDigest} instance @param {import('./types').Browser[]} browsers */
function scope(bookmark, instance, browsers) {
  const browser = browsers.find(b => b.id === bookmark.target_browser);
  const container = bookmark.browser_options?.container || browser?.container;
  const store = instance.containers?.find(c => c.name === container)?.cookieStoreId ?? container;
  return { store, matches: instance.browser === bookmark.target_browser && !bookmark.browser_options?.incognito };
}
/** @param {import('./types').Bookmark} bookmark @param {import('./types').InstanceDigest[]} instances @param {import('./types').Browser[]} browsers */
export function browserGroupFor(bookmark, instances, browsers = []) {
  let host;
  try { host = new URL(bookmark.url).hostname; } catch { return undefined; }
  for (const instance of instances) {
    const { store, matches } = scope(bookmark, instance, browsers);
    if (!matches) continue;
    const tab = instance.tabs.find(t => t.host === host && t.groupTitle !== undefined && (!store || (t.cookieStoreId ?? t.cookie_store_id) === store));
    if (tab) return tab;
  }
  return undefined;
}
/** @param {import('./types').Group} group @param {import('./types').Bookmark[]} bookmarks @param {import('./types').InstanceDigest[]} instances @param {import('./types').Browser[]} browsers */
export function hasBrowserGroup(group, bookmarks, instances, browsers = []) {
  return bookmarks.some(bookmark => instances.some(instance => {
    const { store, matches } = scope(bookmark, instance, browsers);
    return matches && instance.tabs.some(t => t.groupTitle === group.name && (!store || (t.cookieStoreId ?? t.cookie_store_id) === store));
  }));
}
