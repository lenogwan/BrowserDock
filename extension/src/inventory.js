import { safeUrl, GROUP_COLORS, encoder } from './protocol.js';

function prefix(value, limit) {
  const characters = [];
  for (const character of value) {
    characters.push(character);
    if (characters.length === limit) break;
  }
  return characters.join('');
}

export function inventory(tabs, includePrivate = false, limit = 200, groups = []) {
  // Group IDs are scoped to windows. Index once instead of scanning every
  // group for every tab on each snapshot; preserve first-match semantics.
  const byWindow = new Map();
  for (const group of groups) {
    let byId = byWindow.get(group.windowId);
    if (!byId) { byId = new Map(); byWindow.set(group.windowId, byId); }
    if (!byId.has(group.id)) byId.set(group.id, group);
  }
  const result = [];
  for (const tab of tabs) {
    if ((tab.incognito && includePrivate !== true) || !Number.isSafeInteger(tab.id) || tab.id < 0 || !safeUrl(tab.url, Infinity)) continue;
    // The cache is a routing hint only. Actual focusing always queries the full tab URL.
    const encoded = encoder.encode(tab.url);
    let end = Math.min(encoded.length, 2048);
    if (end < encoded.length) while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
    const url = encoded.length <= 2048 ? tab.url : new TextDecoder().decode(encoded.subarray(0, end));
    // The full short URL was already validated above. Only truncation needs
    // a second parse; avoid repeating URL/UTF-8 work for ordinary tabs.
    if (encoded.length > 2048 && !safeUrl(url)) continue;
    const group = byWindow.get(tab.windowId)?.get(tab.groupId);
    result.push({ ...(group && Number.isSafeInteger(group.id) && group.id >= 0 ? { groupId: group.id, groupTitle: prefix(group.title ?? '', 64), groupColor: Object.hasOwn(GROUP_COLORS, group.color) ? group.color : 'grey', groupCollapsed: !!group.collapsed } : {}), id: tab.id, url, ...(typeof tab.cookieStoreId === 'string' && /^[A-Za-z0-9 _.-]{1,128}$/.test(tab.cookieStoreId) ? { cookieStoreId: tab.cookieStoreId } : {}), title: prefix(typeof tab.title === 'string' ? tab.title : '', 256) });
    if (result.length === limit) break;
  }
  return result;
}
