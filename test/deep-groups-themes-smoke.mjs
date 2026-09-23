// Rendered nested-bookmark and theme flows with a mocked desktop IPC boundary; requires npm run dev.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:400,height:680}});
page.setDefaultTimeout(10000);
const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
function mockDesktop(){
  window.isTauri=true;
  const callbacks=new Map(), listeners=new Map();let next=0;
  const group={id:'work',name:'Work',color:'#4285f4',sort_order:0,collapsed:false};
  const bookmark={id:'one',title:'Project docs',url:'https://one.test/',target_browser:'firefox',tags:[],icon:'',group_id:'work'};
  const settings={theme:'dark',window_size:{width:400,height:null},always_on_top:true,auto_hide:false,hide_on_open:false,auto_tab_groups:true,opacity:1,vault_timeout_minutes:5,global_shortcut:'Ctrl+Shift+Space',panic_shortcut:'Ctrl+Alt+L'};
  const items=[bookmark,{...bookmark,id:'child',title:'Child docs',parent_id:'one'},{...bookmark,id:'grand',title:'Grandchild docs',parent_id:'child'},{...bookmark,id:'other',title:'Other docs'}];
  const state=window.groupTest={calls:[],settings,items,closed:false,fail:false,locked:false};
  window.emitGroupTest=event=>{for(const id of listeners.get(event)||[])callbacks.get(id)?.({event,payload:null});};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},transformCallback(fn){callbacks.set(++next,fn);return next;},async invoke(cmd,args={}){
    state.calls.push({cmd,args});
    switch(cmd){
      case 'plugin:event|listen':{const ids=listeners.get(args.event)||[];ids.push(args.handler);listeners.set(args.event,ids);return args.handler;}
      case 'get_dock_data':return {bookmarks:state.items,groups:[group],browsers:[{id:'firefox',name:'Firefox',color:'#ff7139',exe_path:''}],settings:{...settings},warnings:[]};
      case 'vault_status':return {exists:true,locked:state.locked,retry_after_seconds:0};
      case 'vault_list':return {groups:[{...group,id:'private',name:'Private work'}],bookmarks:[{...bookmark,id:'secret',group_id:'private',title:'Secret docs'},{...bookmark,id:'secret-child',parent_id:'secret',group_id:'private',title:'Secret child'}]};
      case 'companion_tabs_digest':return {error:null,instances:[{instance_id:'test',browser:'firefox',tabs:state.closed?[]:[{host:'one.test',groupTitle:'Work',groupColor:'blue'}]}]};
      case 'route_details':return {browser_id:'firefox'};
      case 'route_url':return 'firefox';
      case 'open_url':return {browser_id:'firefox'};
      case 'open_bookmark_tree':if(args.private)return new Promise(resolve=>state.finishPrivate=()=>resolve({processed:2}));if(state.fail)throw Error('Partial subtree failure; no retry made');return {processed:3};
      case 'move_bookmark':if(state.fail)throw Error('Move rejected');return;
      case 'save_bookmark':state.items=state.items.map(b=>b.id===args.bookmark.id?args.bookmark:b);return;
      case 'open_group':if(args.private)return new Promise(resolve=>state.finishPrivate=()=>resolve({processed:1}));if(state.fail)throw Error('Partial group failure; no retry made');return {processed:1};
      case 'close_group_tabs':state.closed=true;return {processed:1};
      case 'save_settings':Object.assign(settings,args.settings);return {notice:''};
      default:return;
    }
  }};
}
await page.addInitScript(mockDesktop);
const search=page.getByRole('textbox',{name:'Search bookmarks or enter a URL'});
const row=id=>page.locator(`[data-vkey="${id}-public"]`);
const lastCall=cmd=>page.evaluate(cmd=>window.groupTest.calls.filter(c=>c.cmd===cmd).at(-1)?.args,cmd);
try {
  await page.goto('http://127.0.0.1:1420/');
  await page.getByRole('button',{name:'Open subtree Project docs',exact:true}).waitFor();
  assert.equal(await row('child').count(),0);
  assert.equal(await page.getByRole('button',{name:'Open subtree Project docs',exact:true}).textContent(),'+2');
  await page.getByRole('button',{name:'Open Project docs in firefox',exact:true}).click();
  assert.equal((await lastCall('open_url')).bookmarkId,'one');
  await page.getByRole('button',{name:'Open subtree Project docs',exact:true}).click();
  assert.deepEqual(await lastCall('open_bookmark_tree'),{id:'one',private:false});
  const focusedTreeCalls=await page.evaluate(()=>window.groupTest.calls.filter(c=>c.cmd==='open_bookmark_tree').length);
  await page.getByRole('button',{name:'Open Project docs in firefox',exact:true}).press('Shift+Enter');
  await page.waitForFunction(n=>window.groupTest.calls.filter(c=>c.cmd==='open_bookmark_tree').length===n+1,focusedTreeCalls);
  await search.focus();
  for(let i=0;i<5 && !(await row('one').evaluate(e=>e.classList.contains('active')));i++) await search.press('ArrowDown');
  assert.equal(await row('one').evaluate(e=>e.classList.contains('active')),true);
  const treeCalls=await page.evaluate(()=>window.groupTest.calls.filter(c=>c.cmd==='open_bookmark_tree').length);
  await search.press('Shift+Enter');
  await page.waitForFunction(n=>window.groupTest.calls.filter(c=>c.cmd==='open_bookmark_tree').length===n+1,treeCalls);
  assert.deepEqual(await lastCall('open_bookmark_tree'),{id:'one',private:false});
  await page.getByRole('button',{name:'Open Project docs in firefox',exact:true}).focus();
  await page.keyboard.press('ArrowRight'); await row('child').waitFor();
  await search.focus();
  for(let i=0;i<8 && !(await row('child').evaluate(e=>e.classList.contains('active')));i++) await search.press('ArrowDown');
  await search.press('ArrowRight'); await row('grand').waitFor();
  assert.equal(await row('grand').evaluate(e=>e.style.paddingLeft),'20px');
  await search.press('ArrowDown'); await search.press('Shift+Enter');
  assert.equal((await lastCall('open_url')).bookmarkId,'grand');
  assert.equal((await lastCall('open_url')).forceNewTab,true);
  const expanded=await page.evaluate(()=>JSON.parse(localStorage.getItem('browserdock:tree-expanded:v1')));
  assert.equal(expanded['one-public'],true);assert.equal(expanded['child-public'],true);
  await page.reload(); await row('grand').waitFor();
  await search.fill('Grandchild');
  await page.locator('.parent-badge').filter({hasText:'Child docs'}).waitFor();
  assert.equal(await row('grand').evaluate(e=>e.style.paddingLeft),'0px');
  await search.fill('');
  // Parent editor offers the accessible nesting path and locks the group.
  await row('other').hover();await page.getByRole('button',{name:'Edit Other docs',exact:true}).click();
  await page.getByLabel('Parent',{exact:true}).selectOption('one');
  assert.equal(await page.getByLabel('Group',{exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Save bookmark',exact:true}).click();
  assert.equal((await lastCall('save_bookmark')).bookmark.parent_id,'one');
  await row('other').waitFor();
  // Failed insert-edge move rolls back; nesting needs 250ms body hover intent.
  await page.evaluate(()=>window.groupTest.fail=true);
  await row('other').dispatchEvent('dragstart');
  let target=await row('one').boundingBox();
  await row('one').dispatchEvent('dragover',{clientY:target.y+2});
  assert.equal(await row('one').evaluate(e=>e.classList.contains('insertion')),true);
  await row('one').dispatchEvent('drop');
  await page.getByRole('alert').filter({hasText:'Move rejected'}).waitFor();
  assert.equal((await lastCall('move_bookmark')).parentId,null);
  assert.equal(await row('other').evaluate(e=>e.style.paddingLeft),'10px');
  await row('other').dispatchEvent('dragstart');target=await row('child').boundingBox();
  await row('child').dispatchEvent('dragover',{clientY:target.y+25});
  assert.equal(await row('child').evaluate(e=>e.classList.contains('nesting')),false);
  await page.waitForTimeout(280);
  assert.equal(await row('child').evaluate(e=>e.classList.contains('nesting')),true);
  await row('child').dispatchEvent('drop');
  assert.equal((await lastCall('move_bookmark')).parentId,'child');
  assert.equal(await row('other').evaluate(e=>e.style.paddingLeft),'10px');
  // Escape cancels drag without invoking dock_escape.
  const beforeEscape=await page.evaluate(()=>window.groupTest.calls.filter(c=>c.cmd==='dock_escape').length);
  await row('other').dispatchEvent('dragstart');await search.press('Escape');
  assert.equal(await page.evaluate(()=>window.groupTest.calls.filter(c=>c.cmd==='dock_escape').length),beforeEscape);
  await page.evaluate(()=>window.groupTest.fail=false);
  for(const width of [280,400,800]) {
    await page.setViewportSize({width,height:680});
    assert.equal(await page.locator('.results').evaluate(e=>e.scrollWidth>e.clientWidth),false,`tree overflow at ${width}`);
  }
  await page.setViewportSize({width:400,height:680});
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  assert.equal(await page.locator('main').getAttribute('data-theme'),'sage');
  for(const [label,id,rgb] of [['Nord Frost','nord','30 34 42'],['Midnight Amber','amber','21 22 24'],['Tokyo Violet','tokyo','26 27 38'],['Rosé Pine','rose','25 23 36'],['Sage Mint','sage','23 28 30']]) {
    await page.getByRole('radio',{name:label,exact:true}).check();
    assert.equal(await page.locator('main').getAttribute('data-theme'),id);
    assert.equal(await page.locator('main').evaluate(e=>getComputedStyle(e).getPropertyValue('--surface-rgb').trim()),rgb);
  }
  for(const width of [280,400,800]) {
    await page.setViewportSize({width,height:680});
    assert.equal(await page.locator('.settings-view').evaluate(e=>e.scrollWidth>e.clientWidth),false,`theme overflow at ${width}`);
  }
  await page.setViewportSize({width:400,height:680});
  const opacity=page.getByRole('slider');
  await opacity.fill('0.3');
  assert.equal(await page.locator('main').evaluate(e=>getComputedStyle(e).opacity),'1');
  // The background has a 120ms CSS transition; wait for its final alpha.
  await page.waitForFunction(()=>{
    const color=getComputedStyle(document.querySelector('main')).backgroundColor;
    // Chromium can quantize the computed alpha to 8 bits.
    return color.startsWith('rgba(23, 28, 30,') && Math.abs(Number(color.match(/, ([\d.]+)\)$/)?.[1])-0.288)<0.003;
  });
  for(const selector of ['.panel','.search-field']) {
    const alpha=await page.locator(selector).evaluate(e=>Number(getComputedStyle(e).backgroundColor.match(/, ([\d.]+)\)$/)?.[1]));
    assert.ok(Math.abs(alpha-0.78)<0.003,`${selector} keeps a readable surface at 30% opacity`);
  }
  await page.getByRole('radio',{name:'Nord Frost',exact:true}).check();
  await page.getByRole('button',{name:'Discard',exact:true}).click();
  assert.equal(await page.locator('main').getAttribute('data-theme'),'sage');
  await page.getByRole('radio',{name:'Tokyo Violet',exact:true}).check();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await lastCall('save_settings')).settings.theme,'tokyo');
  await page.getByRole('radio',{name:'Rosé Pine',exact:true}).check();
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Discard changes?',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('main')?.dataset.theme==='tokyo');
  // No cross-scope drop, and a vault lock purges expansion and stale outcomes.
  await page.evaluate(()=>window.emitGroupTest('dock-summoned'));
  const privateChevron=page.getByRole('button',{name:'Expand or collapse Secret docs',exact:true});
  await privateChevron.click();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('browserdock:tree-expanded:v1'))['secret-private']),true);
  const moveCount=await page.evaluate(()=>window.groupTest.calls.filter(c=>c.cmd==='move_bookmark').length);
  await page.locator('[data-vkey="secret-private"]').dispatchEvent('dragstart');
  target=await row('one').boundingBox();await row('one').dispatchEvent('dragover',{clientY:target.y+25});await page.waitForTimeout(280);await row('one').dispatchEvent('drop');
  assert.equal(await page.evaluate(()=>window.groupTest.calls.filter(c=>c.cmd==='move_bookmark').length),moveCount);
  await page.getByRole('button',{name:'Open subtree Secret docs',exact:true}).click();
  await page.waitForFunction(()=>typeof window.groupTest.finishPrivate==='function');
  await page.evaluate(()=>{window.groupTest.locked=true;window.emitGroupTest('vault-locked');window.groupTest.finishPrivate();});
  await privateChevron.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('browserdock:tree-expanded:v1'))).some(k=>k.endsWith('-private'))),false);
  assert.equal(await page.getByText('Opened 2 tabs for Secret docs',{exact:true}).count(),0);
  await page.screenshot({path:'/tmp/browserdock-deep-groups-themes.png'});
  await page.evaluate(()=>{window.groupTest.locked=false;window.emitGroupTest('dock-summoned');});
  await privateChevron.click();
  await search.press('Escape');
  assert.equal(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('browserdock:tree-expanded:v1'))).some(k=>k.endsWith('-private'))),false);
  const touch=await browser.newPage({hasTouch:true,viewport:{width:280,height:680}});
  await touch.addInitScript(mockDesktop);
  await touch.goto('http://127.0.0.1:1420/');
  await touch.getByRole('button',{name:'Open subtree Project docs',exact:true}).waitFor();
  assert.equal(await touch.evaluate(()=>matchMedia('(hover: none)').matches),true);
  assert.equal(await touch.locator('[data-vkey="one-public"] .row-actions').evaluate(e=>getComputedStyle(e).opacity),'1');
  assert.equal(await touch.getByRole('button',{name:'Expand or collapse Project docs',exact:true}).isVisible(),true);
  await touch.getByRole('button',{name:'Expand or collapse Project docs',exact:true}).click();
  await touch.screenshot({path:'/tmp/browserdock-tree-touch.png'});
  await touch.close();
  assert.deepEqual(errors,[]);
  console.log('Deep groups and themes smoke passed: split opens, keyboard, trees, search, parent editor, drag intent/rollback/scope/cancel, private lock, themes preview/save/discard, and 280–800px layout.');
} finally {await browser.close();}
