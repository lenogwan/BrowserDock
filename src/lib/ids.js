let sequence = 0;
/** IDs identify entries only; this fallback must never generate auth tokens. */
export function entryId() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `entry-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
/** Stable render/identity key for a bookmark across public/private scopes. */
/** @param {import('./types').Bookmark} bookmark */
export function entryKey(bookmark) {
  return `${bookmark.id}${bookmark.private ? "-private" : "-public"}`;
}
