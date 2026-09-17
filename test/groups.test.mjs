import test from 'node:test';
import assert from 'node:assert/strict';
import { moveBookmark, groupSections, targetLabel } from '../src/lib/groups.js';
import { searchBookmarks } from '../src/lib/search.js';
test('move inserts and renumbers without changing original or other scope', () => {
 const original=[{id:'a',title:'A',group_id:'x',sort_order:0},{id:'b',title:'B',group_id:'y',sort_order:0},{id:'c',title:'C',group_id:'y',sort_order:1}];
 const moved=moveBookmark(original,'a','y',1);
 assert.deepEqual(groupSections(moved,[{id:'y',name:'Y',sort_order:0}])[0].items.map(b=>b.id),['b','a','c']);
 assert.equal(original[0].group_id,'x');
});
test('group search and resolved browser labels',()=>{
 const item={id:'a',title:'Mail',tags:[],url:'https://example.com',target_browser:'chrome',group_id:'x'};
 assert.equal(searchBookmarks([item],'Work',[{id:'x',name:'Work'}])[0].id,'a');
 assert.equal(targetLabel(item,[{id:'chrome',profile:'Ray'}]),'chrome · Ray');
 assert.equal(targetLabel({...item,browser_options:{profile:'Default'}},[{id:'chrome',profile:'Ray'}]),'chrome · Default');
});

test('identical group IDs never mix public and private bookmarks',()=>{
 const items=[{id:'same',title:'Public',group_id:'same'},{id:'same',title:'Private',group_id:'same',private:true}];
 const sections=groupSections(items,[{id:'same',name:'Public',sort_order:0},{id:'same',name:'Private',sort_order:0,private:true}]);
 assert.deepEqual(sections[0].items.map(b=>b.title),['Public']);
 assert.deepEqual(sections[1].items.map(b=>b.title),['Private']);
});
