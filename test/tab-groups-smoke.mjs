// Rendered tab-group flow with a mocked desktop IPC boundary; requires npm run dev.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:400,height:680}});
const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
await page.addInitScript(()=>{
  window.isTauri=true;
  const callbacks=new Map(), listeners=new Map();let next=0;
  const group={id:'work',name:'Work',color:'#4285f4',sort_order:0,collapsed:false};
  const bookmark={id:'one',title:'Project docs',url:'https://one.test/',target_browser:'firefox',tags:[],icon:'',group_id:'work'};
  const settings={window_size:{width:400,height:null},always_on_top:true,auto_hide:false,hide_on_open:false,auto_tab_groups:true,opacity:1,vault_timeout_minutes:5,global_shortcut:'Ctrl+Shift+Space',panic_shortcut:'Ctrl+Alt+L'};
  const state=window.groupTest={calls:[],settings,closed:false,fail:false,locked:false};
  window.emitGroupTest=event=>{for(const id of listeners.get(event)||[])callbacks.get(id)?.({event,payload:null});};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},transformCallback(fn){callbacks.set(++next,fn);return next;},async invoke(cmd,args={}){
    state.calls.push({cmd,args});
    switch(cmd){
      case 'plugin:event|listen':{const ids=listeners.get(args.event)||[];ids.push(args.handler);listeners.set(args.event,ids);return args.handler;}
      case 'get_dock_data':return {bookmarks:[bookmark],groups:[group],browsers:[{id:'firefox',name:'Firefox',color:'#ff7139',exe_path:''}],settings:{...settings},warnings:[]};
      case 'vault_status':return {exists:true,locked:state.locked,retry_after_seconds:0};
      case 'vault_list':return {groups:[{...group,id:'private',name:'Private work'}],bookmarks:[{...bookmark,id:'secret',group_id:'private',title:'Secret docs'}]};
      case 'companion_tabs_digest':return {error:null,instances:[{instance_id:'test',browser:'firefox',tabs:state.closed?[]:[{host:'one.test',groupTitle:'Work',groupColor:'blue'}]}]};
      case 'route_details':return {browser_id:'firefox'};
      case 'route_url':return 'firefox';
      case 'open_group':if(args.private)return new Promise(resolve=>state.finishPrivate=()=>resolve({processed:1}));if(state.fail)throw Error('Partial group failure; no retry made');return {processed:1};
      case 'close_group_tabs':state.closed=true;return {processed:1};
      case 'save_settings':Object.assign(settings,args.settings);return {notice:''};
      default:return;
    }
  }};
});
try {
  await page.goto('http://127.0.0.1:1420/');
  const open=page.getByRole('button',{name:'Open group Work in browser',exact:true});
  await open.waitFor();
  await page.locator('.native-group').first().waitFor();
  assert.equal(await page.locator('.native-group').first().textContent(),'Work');
  await open.click();
  await page.waitForFunction(()=>window.groupTest.calls.some(c=>c.cmd==='open_group'));
  assert.deepEqual(await page.evaluate(()=>window.groupTest.calls.find(c=>c.cmd==='open_group').args),{groupId:'work',private:false});
  await page.evaluate(()=>window.groupTest.fail=true);
  await open.click();
  await page.getByRole('alert').filter({hasText:'Partial group failure'}).waitFor();
  assert.equal(await page.evaluate(()=>window.groupTest.calls.filter(c=>c.cmd==='open_group').length),2);
  await page.evaluate(()=>window.groupTest.fail=false);
  await page.getByRole('button',{name:'Close group tabs Work',exact:true}).click();
  await page.waitForFunction(()=>window.groupTest.calls.some(c=>c.cmd==='close_group_tabs'));
  await page.getByRole('button',{name:'Close group tabs Work',exact:true}).waitFor({state:'hidden'});
  for(const width of [280,400,800]){
    await page.setViewportSize({width,height:680});
    assert.equal(await page.locator('.group-header').first().evaluate(e=>e.scrollWidth>e.clientWidth),false,`group header overflow at ${width}`);
  }
  await page.setViewportSize({width:400,height:680});
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('tab',{name:'Behavior',exact:true}).click();
  const toggle=page.getByLabel('Sync bookmark groups to browser tab groups');
  assert.equal(await toggle.isChecked(),true);
  await toggle.uncheck();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>window.groupTest.settings.auto_tab_groups===false);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.evaluate(()=>window.emitGroupTest('dock-summoned'));
  await page.getByRole('button',{name:'Open group Private work in browser',exact:true}).click();
  await page.waitForFunction(()=>typeof window.groupTest.finishPrivate==='function');
  assert.deepEqual(await page.evaluate(()=>window.groupTest.calls.filter(c=>c.cmd==='open_group').at(-1).args),{groupId:'private',private:true});
  await page.evaluate(()=>{window.groupTest.closed=false;window.groupTest.locked=true;window.emitGroupTest('vault-locked');window.groupTest.finishPrivate();});
  assert.equal(await page.getByRole('button',{name:'Open group Private work in browser',exact:true}).count(),0);
  await page.locator('.native-group').first().waitFor();
  assert.equal(await page.getByText('Opened 1 tab for Private work',{exact:true}).count(),0);
  await page.screenshot({path:'/tmp/browserdock-tab-groups.png'});
  assert.deepEqual(errors,[]);
  console.log('Tab-group rendered smoke passed: open, close, error, badges, settings, private lock and 280–800px layout.');
} finally {await browser.close();}
