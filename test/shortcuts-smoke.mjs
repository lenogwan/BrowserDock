// Every dock shortcut is exercised through real key events before/after saving.
// Desktop IPC and native registration are mocked; Windows OS acceptance is separate.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { DOCK_SHORTCUTS, DEFAULT_DOCK_SHORTCUTS } from '../src/lib/features/settings/shortcuts.js';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 680 } });
const errors = [], artifacts = process.env.BROWSERDOCK_SHORTCUT_ARTIFACTS;
page.on('pageerror', error => errors.push(String(error)));
if (artifacts) await mkdir(artifacts, { recursive: true });
await page.addInitScript(() => {
  window.isTauri = true;
  const callbacks = new Map(), listeners = new Map(); let next = 0;
  const make = (id, group_id) => ({ id, title: id, group_id, url: `https://example.com/${id}`, target_browser: 'firefox', tags: [], icon: '' });
  const publicItems = [make('Parent', 'work'), {...make('Child','work'),parent_id:'Parent'},make('Leaf','other')];
  const privateItems = [make('Secret','private-work'),{...make('Secret child','private-work'),parent_id:'Secret'}];
  const groups = [{id:'work',name:'Work',sort_order:0,color:'',collapsed:false},{id:'other',name:'Other',sort_order:1,color:'',collapsed:false}];
  const privateGroups = [{id:'private-work',name:'Private work',sort_order:0,color:'',collapsed:false}];
  // Test-only storage simulates config.json surviving a webview reload.
  const settings = {theme:'tokyo',window_size:{width:400,height:null},always_on_top:true,hide_on_open:false,auto_hide:false,auto_tab_groups:true,opacity:1,vault_timeout_minutes:5,global_shortcut:'Ctrl+Shift+Space',panic_shortcut:'Ctrl+Alt+L',...JSON.parse(sessionStorage.getItem('test:shortcut-settings')??'{}')};
  const vault = {exists:true,locked:true,retry_after_seconds:0};
  window.shortcutTest = {calls:[],settings,groups,privateGroups,vault,failCollapse:false};
  window.emitTest = event => { for (const id of listeners.get(event) || []) callbacks.get(id)?.({event,payload:null}); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener() {}};
  window.__TAURI_INTERNALS__ = {
    metadata:{currentWindow:{label:'main'}},transformCallback(fn) {callbacks.set(++next,fn);return next;},
    async invoke(cmd,args={}) {
      if (cmd !== 'vault_auth') window.shortcutTest.calls.push({cmd,args:JSON.parse(JSON.stringify(args))});
      switch(cmd) {
        case 'plugin:event|listen': {const ids=listeners.get(args.event)||[];ids.push(args.handler);listeners.set(args.event,ids);return args.handler;}
        case 'get_dock_data': return structuredClone({bookmarks:publicItems,groups,settings,active_shortcuts:[settings.global_shortcut,settings.panic_shortcut],warnings:[],browsers:[['firefox','Firefox'],['mullvad','Mullvad'],['chrome','Chrome'],['edge','Edge']].map(([id,name])=>({id,name,exe_path:`C:\\${name}.exe`,color:'#b8edc9'}))});
        case 'vault_status': return {...vault};
        case 'vault_auth': vault.locked=false;return;
        case 'vault_list': return structuredClone({bookmarks:privateItems,groups:privateGroups});
        case 'vault_lock': vault.locked=true;window.emitTest('vault-locked');return;
        case 'save_settings': Object.assign(settings,JSON.parse(JSON.stringify(args.settings)));sessionStorage.setItem('test:shortcut-settings',JSON.stringify(settings));return {notice:'',active_shortcuts:[settings.global_shortcut,settings.panic_shortcut]};
        case 'companion_tabs_digest': return {instances:[],error:null};
        case 'route_details': return {browser_id:args.browserId??'firefox'};
        case 'browser_profiles': return [];
        case 'open_url': return {browser_id:args.browserId??'firefox'};
        case 'open_bookmark_tree': return {processed:2};
        case 'save_group': {const scope=args.private?privateGroups:groups;scope[scope.findIndex(group=>group.id===args.group.id)]=JSON.parse(JSON.stringify(args.group));return;}
        case 'collapse_groups': {if(window.shortcutTest.failCollapse)throw Error('Collapse rejected');if(args.private&&vault.locked)throw Error('Vault is locked');for(const group of args.private?privateGroups:groups)group.collapsed=true;return;}
        default:return;
      }
    },
  };
});
const search = page.getByRole('textbox',{name:'Search bookmarks or enter a URL',exact:true});
const key = combo => combo.replaceAll('Ctrl','Control').replaceAll('Super','Meta');
const calls = cmd => page.evaluate(cmd=>window.shortcutTest.calls.filter(call=>call.cmd===cmd),cmd);
const active = id => page.locator(`[data-vkey="${id}-public"].active`);
async function pressed(combo, target=search) {await target.press(key(combo));}
async function screenshot(name) {if(artifacts)await page.screenshot({path:`${artifacts}/${name}.png`});}
async function openGroups() {
  for(const name of ['Work','Other']) {
    const header=page.locator('.group-title').filter({has:page.getByText(name,{exact:true})});
    if(await header.getAttribute('aria-expanded')==='false')await header.click();
  }
  await page.getByRole('button',{name:'Edit Parent',exact:true}).waitFor();
  await search.fill('Parent');await search.fill('');await search.focus();await active('Parent').waitFor();
}
async function record(label, combo) {
  const row=page.locator('[data-shortcut-recorder]').filter({has:page.getByText(label,{exact:true})});
  const button=row.getByRole('button');await button.click();await pressed(combo,button);
  await button.filter({hasText:combo}).waitFor();
}
async function runActions(bindings) {
  await openGroups();
  await pressed(bindings.next_result);await active('Leaf').waitFor();
  await pressed(bindings.previous_result);await active('Parent').waitFor();
  await pressed(bindings.expand_branch);await page.getByRole('button',{name:'Edit Child',exact:true}).waitFor();
  await pressed(bindings.collapse_branch);await page.getByRole('button',{name:'Edit Child',exact:true}).waitFor({state:'hidden'});
  let count=(await calls('open_bookmark_tree')).length;
  await pressed(bindings.open_subtree);await page.waitForFunction(count=>window.shortcutTest.calls.filter(call=>call.cmd==='open_bookmark_tree').length===count+1,count);
  assert.deepEqual((await calls('open_bookmark_tree')).at(-1).args,{id:'Parent',private:false});
  await pressed(bindings.new_tab);assert.equal((await calls('open_url')).at(-1).args.forceNewTab,true);assert.equal((await calls('open_url')).at(-1).args.bookmarkId,'Parent');
  assert.equal((await calls('open_bookmark_tree')).length,count+1,'new tab must not open the subtree');
  await pressed(bindings.open_selected);assert.equal((await calls('open_url')).at(-1).args.forceNewTab,false);
  await search.fill('https://typed.example/new');await pressed(bindings.new_tab);
  assert.equal((await calls('open_url')).at(-1).args.url,'https://typed.example/new');assert.equal((await calls('open_url')).at(-1).args.forceNewTab,true);
  await openGroups();
  await page.getByRole('button',{name:'Select bookmarks',exact:true}).click();
  const row=page.getByRole('button',{name:'Select bookmark Parent',exact:true});await row.focus();await pressed(bindings.open_selected,row);
  assert.equal(await page.getByLabel('Select Parent',{exact:true}).isChecked(),true);
  await page.getByRole('button',{name:'Deselect bookmark Parent',exact:true}).press('Space');assert.equal(await page.getByLabel('Select Parent',{exact:true}).isChecked(),false);
  await page.getByRole('button',{name:'Cancel selection',exact:true}).click();await search.focus();
  for(const id of ['firefox','mullvad','chrome','edge']) {
    await pressed(bindings[`route_${id}`]);await page.getByRole('button',{name:'Clear browser override',exact:true}).waitFor();
    assert.match(await page.locator('.override-clear').innerText(),new RegExp(id));await pressed(bindings[`route_${id}`]);
    await page.getByRole('button',{name:'Clear browser override',exact:true}).waitFor({state:'hidden'});
  }
  await pressed(bindings.expand_branch);await pressed(bindings.collapse_all);
  await page.getByText('All groups and sub-pages collapsed.',{exact:true}).waitFor();
  assert.equal(await page.locator('.result').count(),0);
  assert.equal(await page.evaluate(()=>window.shortcutTest.groups.every(group=>group.collapsed)),true);
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('Parent-public')),false);
  await pressed(bindings.collapse_dock);await page.waitForFunction(()=>!document.querySelector('main').classList.contains('expanded'));
  await search.click();await page.getByRole('button',{name:'Select bookmarks',exact:true}).waitFor();
  count=(await calls(bindings.hide==='Escape'?'dock_escape':'dock_hide')).length;
  await pressed(bindings.hide);
  assert.equal((await calls(bindings.hide==='Escape'?'dock_escape':'dock_hide')).length,count+1);
  await page.evaluate(()=>window.emitTest('dock-summoned'));await page.getByRole('button',{name:'Select bookmarks',exact:true}).waitFor();
}
try {
  await page.goto('http://127.0.0.1:1420/');
  await page.getByRole('button',{name:'Edit Parent',exact:true}).waitFor();
  assert.equal(await page.locator('.keyboard-hints, footer kbd').count(),0);
  await runActions(DEFAULT_DOCK_SHORTCUTS);
  await openGroups();
  for(const number of [1,2,3,4]) {await pressed(`Alt+${number}`);await page.getByRole('button',{name:'Clear browser override',exact:true}).waitFor();await pressed(`Alt+${number}`);}
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Shortcuts',exact:true}).click();
  for(const width of [280,400,800]) {
    await page.setViewportSize({width,height:680});
    assert.equal(await page.locator('.panel-content').evaluate(el=>el.scrollWidth>el.clientWidth),false,`shortcuts overflow at ${width}`);
    assert.equal(await page.locator('[role=tab]').evaluateAll(tabs=>tabs.some(tab=>tab.scrollWidth>tab.clientWidth)),false,`tab labels truncate at ${width}`);
    await screenshot(`shortcuts-${width}`);
  }
  await page.setViewportSize({width:400,height:680});
  // Recording cancels without hiding and text editing keys remain protected.
  let row=page.locator('[data-shortcut-recorder]').filter({has:page.getByText('Always open a new tab',{exact:true})});
  await row.getByRole('button').click();await row.getByRole('button').press('Control+C');
  await row.getByRole('alert').filter({hasText:'reserved'}).waitFor();
  const hides=(await calls('dock_escape')).length;await row.getByRole('button').press('Escape');
  assert.equal((await calls('dock_escape')).length,hides);
  const custom=Object.fromEntries(DOCK_SHORTCUTS.map((item,index)=>[item.id,index < 12 ? `Ctrl+Alt+F${index+1}` : `Ctrl+Alt+${index === 12 ? 'A' : 'B'}`]));
  for(const item of DOCK_SHORTCUTS)await record(item.label,custom[item.id]);
  await record('Summon shortcut','Ctrl+Alt+S');await record('Panic lock shortcut','Ctrl+Alt+P');
  // Duplicate local/global bindings disable Save and tell the user what conflicts.
  await record('Always open a new tab',custom.open_selected);
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
  await page.getByRole('alert').filter({hasText:'conflicts'}).waitFor();await record('Always open a new tab',custom.new_tab);
  await record('Summon shortcut',custom.new_tab);assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
  await record('Summon shortcut','Ctrl+Alt+S');
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Saved — all changes are live.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.shortcutTest.settings.dock_shortcuts),custom);
  await page.getByRole('button',{name:'Back',exact:true}).click();await runActions(custom);
  await openGroups();
  let previousOpens=(await calls('open_url')).length, previousTrees=(await calls('open_bookmark_tree')).length;
  for(const combo of ['Enter','Shift+Enter','Ctrl+Enter','ArrowDown','ArrowRight','Alt+F','Alt+1'])await pressed(combo);
  assert.equal((await calls('open_url')).length,previousOpens);assert.equal((await calls('open_bookmark_tree')).length,previousTrees);
  assert.equal(await page.getByRole('button',{name:'Clear browser override',exact:true}).count(),0);
  await active('Parent').waitFor();
  await page.evaluate(()=>window.shortcutTest.failCollapse=true);await pressed(custom.collapse_all);
  await page.getByRole('alert').filter({hasText:'Collapse rejected'}).waitFor();
  assert.equal(await page.evaluate(()=>window.shortcutTest.groups.every(group=>!group.collapsed)),true);
  await page.evaluate(()=>window.shortcutTest.failCollapse=false);await pressed(custom.collapse_all);
  await page.getByText('All groups and sub-pages collapsed.',{exact:true}).waitFor();
  // Saved changes survive a fresh dock-data load, including global recorder values.
  await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Shortcuts',exact:true}).click();
  await page.getByRole('button',{name:'Change Summon shortcut, currently Ctrl+Alt+S',exact:true}).waitFor();
  for(const item of DOCK_SHORTCUTS)await page.getByRole('button',{name:`Change ${item.label}, currently ${custom[item.id]}`,exact:true}).waitFor();
  // Discarding a changed recorder keeps the saved binding.
  await record('Next bookmark','Ctrl+Alt+N');await page.getByRole('button',{name:'Discard',exact:true}).click();
  await page.getByRole('button',{name:`Change Next bookmark, currently ${custom.next_result}`,exact:true}).waitFor();
  await page.getByRole('button',{name:'Back',exact:true}).click();await openGroups();
  // Remapped bookmark actions do not run in editor fields.
  await page.getByRole('button',{name:'Edit Parent',exact:true}).click();let opens=(await calls('open_url')).length;
  await page.getByLabel('Title',{exact:true}).press(key(custom.new_tab));assert.equal((await calls('open_url')).length,opens);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  // Repeat events cannot dispatch additional opens after the first completes.
  await search.focus();const repeated=custom.new_tab.split('+').at(-1);
  await search.dispatchEvent('keydown',{key:repeated,code:repeated,ctrlKey:true,altKey:true,repeat:true});assert.equal((await calls('open_url')).length,opens);
  // Vault-only Collapse all does not collapse public groups; hide clears private UI.
  await page.getByRole('button',{name:'Vault',exact:true}).click();await page.getByLabel('Passphrase',{exact:true}).fill('test-only-secret');
  await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await search.focus();
  await pressed(custom.expand_branch);await page.getByRole('button',{name:'Edit Secret child',exact:true}).waitFor();
  await pressed(custom.collapse_all);await page.getByText('All groups and sub-pages collapsed.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.shortcutTest.privateGroups.every(group=>group.collapsed)),true);
  assert.equal(await page.evaluate(()=>window.shortcutTest.groups.every(group=>!group.collapsed)),true);
  await pressed(custom.hide);await page.waitForFunction(()=>!document.body.innerText.includes('Secret child'));
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('-private')),false);
  // Escape remains the hide/panic fallback after remapping Hide.
  await page.evaluate(()=>window.emitTest('dock-summoned'));await search.focus();opens=(await calls('dock_escape')).length;
  await search.press('Escape');assert.equal((await calls('dock_escape')).length,opens+1);
  await page.evaluate(()=>window.emitTest('dock-summoned'));
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Shortcuts',exact:true}).click();
  await page.getByRole('button',{name:'Reset shortcuts to defaults',exact:true}).click();await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Saved — all changes are live.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.shortcutTest.settings.dock_shortcuts),DEFAULT_DOCK_SHORTCUTS);
  assert.deepEqual(errors,[]);
  console.log('All 14 dock shortcuts passed with default/custom bindings; globals, conflicts, persistence, focus, repeat, private scopes and responsive settings checked (desktop IPC mocked).');
} catch(error) {await screenshot('failure');console.error(await page.locator('main').innerText());console.error(errors);throw error;}
finally {await browser.close();}
