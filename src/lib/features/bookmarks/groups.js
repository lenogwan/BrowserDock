import { buildTree, siblingOrder, validateTree } from "./trees.js";
/** @typedef {{group: import('../../shared/types').Group | null; private: boolean; items: import('../../shared/types').Bookmark[], roots?: import('./trees.js').TreeNode[]}} Section */
const sectionsCache = /** @type {WeakMap<object, WeakMap<object, Section[]>>} */ (new WeakMap());
/** @param {import('../../shared/types').Bookmark[]} items @param {import('../../shared/types').Group[]} groups @returns {Section[]} */
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
/** @param {import('../../shared/types').Bookmark[]} items @param {import('../../shared/types').Group[]} groups */
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
    /** @param {import('../../shared/types').Bookmark[]} list @returns {import('../../shared/types').Bookmark[]} */
    (list) =>
      list.toSorted(
        /** @param {import('../../shared/types').Bookmark} a @param {import('../../shared/types').Bookmark} b */
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
  return [...groupSections, ...ungrouped].map(section=>({...section, roots: buildTree(section.items).roots}));
}
/** Immutable draft: the caller retains the original for persistence rollback.
 * @param {import('../../shared/types').Bookmark[]} items @param {string} id @param {string|null} groupId @param {number} index @param {string|null|undefined} [parentId] */
export function moveBookmark(items,id,groupId,index,parentId) {
 const item=items.find(b=>b.id===id); if(!item)return items;
 const draft=items.map(b=>({...b}));
 const moved=draft.find(b=>b.id===id && !!b.private===!!item.private);
 if(!moved)return items;
 if(parentId!==undefined)moved.parent_id=parentId;
 moved.group_id=groupId;
 if(moved.parent_id) {
   const parent=draft.find(b=>b.id===moved.parent_id && !!b.private===!!moved.private);
   if(!parent)throw Error('Choose a parent in the same bookmark scope');
   moved.group_id=parent.group_id??null;
 }
 const pending=[moved],seen=new Set();
 while(pending.length) {
   const parent=pending.pop(); if(!parent||seen.has(parent.id))continue;seen.add(parent.id);
   for(const child of draft.filter(b=>b.parent_id===parent.id && !!b.private===!!parent.private)) {child.group_id=parent.group_id;pending.push(child);}
 }
 validateTree(draft);
 const siblings=draft.filter(b=>b!==moved && !!b.private===!!moved.private && (b.group_id??null)===(moved.group_id??null) && (b.parent_id??null)===(moved.parent_id??null)).sort(siblingOrder);
 siblings.splice(Math.max(0,Math.min(index,siblings.length)),0,moved);
 siblings.forEach((b,i)=>b.sort_order=i);
 const partitions=new Map();
 for(const b of draft) {const key=JSON.stringify([!!b.private,b.group_id??null,b.parent_id??null]);if(!partitions.has(key))partitions.set(key,[]);partitions.get(key).push(b);}
 for(const partition of partitions.values())partition.sort(siblingOrder).forEach((/** @type {import('../../shared/types').Bookmark} */ b,/** @type {number} */ i)=>b.sort_order=i);
 return draft;
}
/** @param {import('../../shared/types').Bookmark} item @param {import('../../shared/types').Browser[]} browsers */
export function targetLabel(item,browsers) {
 const browser=browsers.find(b=>b.id===item.target_browser);
 const option=['chrome','edge'].includes(item.target_browser)?item.browser_options?.profile||browser?.profile:['firefox','mullvad'].includes(item.target_browser)?item.browser_options?.container||browser?.container:null;
 return `${item.target_browser}${option?` · ${option}`:''}${item.browser_options?.incognito?' · private':''}`;
}
