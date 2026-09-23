import { safeUrl, GROUP_COLORS, encoder } from './protocol.js';

export function inventory(tabs, includePrivate = false, limit = 200, groups = []) {
  const result = [];
  for (const tab of tabs) {
    if ((tab.incognito && includePrivate !== true) || !Number.isSafeInteger(tab.id) || tab.id < 0 || !safeUrl(tab.url, Infinity)) continue;
    // The cache is a routing hint only. Actual focusing always queries the full tab URL.
    const encoded = encoder.encode(tab.url);
    let end = Math.min(encoded.length, 2048);
    if (end < encoded.length) while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
    const url = encoded.length <= 2048 ? tab.url : new TextDecoder().decode(encoded.subarray(0, end));
    if (!safeUrl(url)) continue;
    const group = groups.find(g => g.id === tab.groupId && g.windowId === tab.windowId);
    result.push({ ...(group && Number.isSafeInteger(group.id) && group.id >= 0 ? { groupId: group.id, groupTitle: [...(group.title ?? '')].slice(0, 64).join(''), groupColor: Object.hasOwn(GROUP_COLORS, group.color) ? group.color : 'grey', groupCollapsed: !!group.collapsed } : {}), id: tab.id, url, ...(typeof tab.cookieStoreId === 'string' && /^[A-Za-z0-9 _.-]{1,128}$/.test(tab.cookieStoreId) ? { cookieStoreId: tab.cookieStoreId } : {}), title: [...(typeof tab.title === 'string' ? tab.title : '')].slice(0, 256).join('') });
    if (result.length === limit) break;
  }
  return result;
}
