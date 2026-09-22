import { entryKey } from './ids.js';
/** @typedef {import('./types').Bookmark} Bookmark */
/** @typedef {{item: Bookmark, children: TreeNode[], depth: number, count: number, parent: TreeNode|null}} TreeNode */
/** Rust compares UTF-8 strings lexically: use code points, not locale collation.
 * @param {string} a @param {string} b */
function textOrder(a, b) {
  const left = [...a], right = [...b];
  for (let i=0; i<Math.min(left.length,right.length); i++) {
    const difference = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
    if (difference) return difference;
  }
  return left.length-right.length;
}
/** @param {Bookmark} a @param {Bookmark} b */
export const siblingOrder = (a,b) => (a.sort_order??0)-(b.sort_order??0)||textOrder(a.title,b.title)||textOrder(a.id,b.id);
/** @param {Bookmark} item @param {string} id */
const keyFor = (item,id) => entryKey({...item,id});
/** @param {Bookmark} item @param {Map<string,Bookmark>} byKey */
function validChain(item, byKey) {
  const seen = new Set([entryKey(item)]);
  let current=item, depth=0;
  while(current.parent_id) {
    const key=keyFor(item,current.parent_id), parent=byKey.get(key);
    if (!parent || seen.has(key) || (parent.group_id??null)!==(item.group_id??null) || ++depth>2) return false;
    seen.add(key); current=parent;
  }
  return true;
}
/** Tolerant rendering: malformed links become roots; never hide nodes in cycles.
 * @param {Bookmark[]} items */
export function buildTree(items) {
  const byKey=new Map(items.map(item=>[entryKey(item),item]));
  const index=new Map(items.map(item=>[entryKey(item),/** @type {TreeNode} */({item,children:[],depth:0,count:0,parent:null})]));
  const roots=/** @type {TreeNode[]} */([]);
  for(const node of index.values()) {
    const parent=node.item.parent_id && validChain(node.item,byKey) ? index.get(keyFor(node.item,node.item.parent_id)) : null;
    if(parent) {parent.children.push(node);node.parent=parent;} else roots.push(node);
  }
  /** @param {TreeNode[]} nodes @param {number} depth */
  function finish(nodes,depth) {
    nodes.sort((a,b)=>siblingOrder(a.item,b.item));
    for(const node of nodes) {node.depth=depth;finish(node.children,depth+1);node.count=node.children.reduce((n,c)=>n+1+c.count,0);}
  }
  finish(roots,0);
  return {roots,index};
}
/** @param {TreeNode[]} roots @param {Record<string,boolean>} expanded @returns {TreeNode[]} */
export function visibleTree(roots,expanded) {
  return roots.flatMap(node=>[node,...(expanded[entryKey(node.item)]?visibleTree(node.children,expanded):[])]);
}
/** Can this item (including descendants) move below the proposed parent?
 * @param {Bookmark[]} items @param {Bookmark} item @param {Bookmark} parent */
export function canNest(items,item,parent) {
  if(!!item.private!==!!parent.private || item.id===parent.id) return false;
  const {index}=buildTree(items);
  const node=index.get(entryKey(item)), target=index.get(entryKey(parent));
  if(!target)return false;
  let current=target;
  while(current) {if(current.item.id===item.id)return false; if(!current.parent)break;current=current.parent;}
  /** @param {TreeNode} n @returns {number} */
  const height=n=>n.children.length?1+Math.max(...n.children.map(height)):0;
  return target.depth+1+(node?height(node):0)<=2;
}
/** @param {Bookmark[]} items */
export function validateTree(items) {
  const byKey=new Map(items.map(item=>[entryKey(item),item]));
  if(items.some(item=>!validChain(item,byKey))) throw Error('Choose a parent in the same scope and group, without cycles or more than two child levels.');
}

export const EXPANSION_KEY='browserdock:tree-expanded:v1';
/** @param {Storage | undefined} [storage] @returns {Record<string,boolean>} */
export function loadExpansion(storage) {
  try {
    storage ??= globalThis.localStorage;
    const raw=JSON.parse(storage?.getItem(EXPANSION_KEY)??'{}');
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return {};
    // Startup never restores private expansion from a previous session.
    return Object.fromEntries(Object.entries(raw).filter(([key,value])=>value===true && key.endsWith('-public') && key.length<=136).slice(0,2000));
  } catch {return {};}
}
/** @param {Record<string,boolean>} expanded @param {Storage | undefined} [storage] */
export function saveExpansion(expanded,storage) {
  try {storage ??= globalThis.localStorage;storage?.setItem(EXPANSION_KEY,JSON.stringify(Object.fromEntries(Object.entries(expanded).filter(([key,value])=>value===true&&key.length<=136).slice(0,2000))));} catch { /* Storage can be disabled. */ }
}
/** @param {Record<string,boolean>} expanded */
export function purgePrivateExpansion(expanded) {return Object.fromEntries(Object.entries(expanded).filter(([key])=>key.endsWith('-public')));}
