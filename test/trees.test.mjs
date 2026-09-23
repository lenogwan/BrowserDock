import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, visibleTree, canNest, loadExpansion, saveExpansion, purgePrivateExpansion, EXPANSION_KEY } from '../src/lib/features/bookmarks/trees.js';
import { moveBookmark, groupSections } from '../src/lib/features/bookmarks/groups.js';
const item=(id,parent_id=null,more={})=>({id,title:id,url:'https://example.com',target_browser:'firefox',tags:[],parent_id,...more});
test('trees sort siblings, count descendants and flatten only expanded branches',()=>{
 const items=[item('root'),item('z','root'),item('a','root'),item('grand','a')];
 const {roots,index}=buildTree(items);
 assert.equal(roots.length,1); assert.equal(roots[0].count,3);
 assert.equal(index.get('grand-public').depth,2);
 assert.deepEqual(visibleTree(roots,{}).map(n=>n.item.id),['root']);
 assert.deepEqual(visibleTree(roots,{'root-public':true}).map(n=>n.item.id),['root','a','z']);
 assert.deepEqual(visibleTree(roots,{'root-public':true,'a-public':true}).map(n=>n.item.id),['root','a','grand','z']);
});
test('orphans, cross-group links, cycles and cross-scope links render as roots',()=>{
 const items=[item('a','b'),item('b','a'),item('missing','private'),item('private',null,{private:true}),item('child','group',{group_id:'other'}),item('group')];
 const {roots}=buildTree(items);
 assert.equal(roots.length,items.length);
 assert.equal(groupSections([item('root'),item('child','root')],[])[0].roots[0].count,1);
});
test('nest eligibility rejects self, descendants, excessive depth and other scopes',()=>{
 const root=item('root'),child=item('child','root'),grand=item('grand','child'),other=item('other');
 const items=[root,child,grand,other];
 assert.equal(canNest(items,root,root),false);
 assert.equal(canNest(items,root,child),false);
 assert.equal(canNest(items,root,other),false);
 assert.equal(canNest(items,other,grand),false);
 assert.equal(canNest(items,other,{...child,private:true}),false);
 assert.equal(canNest(items,other,child),true);
});
test('moves preserve parents when omitted, unnest on null and sync groups through descendants',()=>{
 const original=[item('root',null,{group_id:'work'}),item('a'),item('child','a'),item('b')];
 let moved=moveBookmark(original,'a',null,0,'root');
 assert.equal(moved.find(b=>b.id==='child').group_id,'work');
 assert.equal(moved.find(b=>b.id==='a').parent_id,'root');
 moved=moveBookmark(moved,'b',null,0,'root');
 assert.equal(moved.find(b=>b.id==='a').sort_order,1);
 moved=moveBookmark(moved,'a',null,0);
 assert.equal(moved.find(b=>b.id==='a').parent_id,'root');
 assert.equal(moved.find(b=>b.id==='a').sort_order,0);
 moved=moveBookmark(moved,'a',null,0,null);
 assert.equal(moved.find(b=>b.id==='a').parent_id,null);
 assert.equal(moved.find(b=>b.id==='child').group_id,null);
 assert.equal(original[1].parent_id,null);
 assert.throws(()=>moveBookmark(moved,'a',null,0,'child'));
});
test('expansion storage contains IDs only, tolerates corruption and purges private keys',()=>{
 const values=new Map();const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 saveExpansion({'a-public':true,'secret-private':true,'closed-public':false},storage);
 assert.deepEqual(JSON.parse(values.get(EXPANSION_KEY)),{'a-public':true,'secret-private':true});
 assert.deepEqual(loadExpansion(storage),{'a-public':true});
 assert.deepEqual(purgePrivateExpansion({'a-public':true,'secret-private':true}),{'a-public':true});
 for(const value of ['null','[]','bad']) {values.set(EXPANSION_KEY,value);assert.deepEqual(loadExpansion(storage),{});}
 assert.doesNotThrow(()=>saveExpansion({}, {setItem(){throw Error('disabled')}}));
});
