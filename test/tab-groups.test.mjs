import test from 'node:test';
import assert from 'node:assert/strict';
import { browserGroupFor, hasBrowserGroup, groupColor } from '../src/lib/tab-groups.js';
const bookmark = {url:'https://one.test/', target_browser:'firefox', browser_options:{container:'Work'}};
const instances = [{browser:'firefox',containers:[{name:'Work',cookieStoreId:'firefox-container-1'}],tabs:[{host:'one.test',cookieStoreId:'firefox-container-1',groupTitle:'Research',groupColor:'blue'}]}];
test('native group badges resolve containers and browser defaults', () => {
  assert.equal(browserGroupFor(bookmark, instances).groupTitle, 'Research');
  assert.equal(browserGroupFor({...bookmark,browser_options:{}},instances,[{id:'firefox',container:'Work'}]).groupColor,'blue');
  assert.equal(browserGroupFor({...bookmark,target_browser:'edge'},instances),undefined);
  assert.equal(browserGroupFor({...bookmark,browser_options:{container:'Other'}},instances),undefined);
  assert.equal(browserGroupFor({...bookmark,browser_options:{incognito:true}},instances),undefined);
});
test('close group availability follows native title in the routed container', () => {
  assert.equal(hasBrowserGroup({name:'Research'},[bookmark],instances),true);
  assert.equal(hasBrowserGroup({name:'Work'},[bookmark],instances),false);
  assert.equal(hasBrowserGroup({name:'Research'},[{...bookmark,browser_options:{container:'Other'}}],instances),false);
  assert.equal(groupColor('blue'),'#4285f4');
  assert.equal(groupColor('invalid'),'#9aa0a6');
});
