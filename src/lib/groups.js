/** @typedef {{group: import('./types').Group | null; private: boolean; items: import('./types').Bookmark[]}} Section */
const sectionsCache = /** @type {WeakMap<object, WeakMap<object, Section[]>>} */ (new WeakMap());
/** @param {import('./types').Bookmark[]} items @param {import('./types').Group[]} groups @returns {Section[]} */
export function groupSections(items, groups) {
  // Component `$derived` arrays keep identity until data changes, so the three
  // call sites per render (results, keyboard nav, list sections) share one result.
  let byGroups = sectionsCache.get(items);
  if (!byGroups) { byGroups = new WeakMap(); sectionsCache.set(items, byGroups); }
  const cached = byGroups.get(groups);
  if (cached) return cached;
  const sections = buildSections(items, groups);
  byGroups.set(groups, sections);
  return sections;
}
/** @param {import('./types').Bookmark[]} items @param {import('./types').Group[]} groups */
function buildSections(items, groups) {
  const ordered = [...groups].sort(
    (a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id),
  );
  const scopes = [false, true].filter(
    (scope) =>
      items.some((b) => !!b.private === scope) ||
      groups.some((g) => !!g.private === scope),
  );
  const sortItems =
    /** @param {import('./types').Bookmark[]} list @returns {import('./types').Bookmark[]} */
    (list) =>
      list.toSorted(
        /** @param {import('./types').Bookmark} a @param {import('./types').Bookmark} b */
        (a, b) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id),
      );
  const groupSections = ordered.map((group) => ({
    group,
    private: !!group.private,
    items: sortItems(
      items.filter((b) => b.group_id === group.id && !!b.private === !!group.private),
    ),
  }));
  const ungrouped = scopes.map((scope) => ({
    group: null,
    private: scope,
    items: sortItems(
      items.filter(
        (b) =>
          !!b.private === scope &&
          !groups.some((g) => g.id === b.group_id && !!g.private === scope),
      ),
    ),
  }));
  return [...groupSections, ...ungrouped];
}
/** Immutable draft: callers retain the original array for failed persistence rollback.
 * Identity note: `target` holds references into `draft` (plus one fresh copy
 * of the moved item), so the `includes` checks below are intentional
 * reference comparisons, not value comparisons.
 * @param {import('./types').Bookmark[]} items @param {string} id @param {string|null} groupId @param {number} index */
export function moveBookmark(items,id,groupId,index) {
 const item=items.find(b=>b.id===id); if(!item)return items;
 const draft=items.filter(b=>b.id!==id).map(b=>({...b}));
 const target=draft.filter(b=>(b.group_id??null)===groupId).sort((a,b)=>(a.sort_order??0)-(b.sort_order??0)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
 target.splice(Math.max(0,Math.min(index,target.length)),0,{...item,group_id:groupId});
 target.forEach((b,i)=>b.sort_order=i);
 const source=draft.filter(b=>(b.group_id??null)===(item.group_id??null)&&!target.includes(b)).sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
 source.forEach((b,i)=>b.sort_order=i);
 return [...draft.filter(b=>!target.includes(b)),...target];
}
/** @param {import('./types').Bookmark} item @param {import('./types').Browser[]} browsers */
export function targetLabel(item,browsers) {
 const browser=browsers.find(b=>b.id===item.target_browser);
 const option=['chrome','edge'].includes(item.target_browser)?item.browser_options?.profile||browser?.profile:['firefox','mullvad'].includes(item.target_browser)?item.browser_options?.container||browser?.container:null;
 return `${item.target_browser}${option?` · ${option}`:''}${item.browser_options?.incognito?' · private':''}`;
}
