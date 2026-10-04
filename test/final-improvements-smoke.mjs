// New library/routing screens rendered in Chromium with a mocked desktop boundary.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:400,height:700}}); page.setDefaultTimeout(10000);
 const errors=[],remote=[]; page.on('pageerror',e=>errors.push(String(e))); page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:1420')&&!r.url().startsWith('data:'))remote.push(r.url());});
 await page.addInitScript(()=>{
  window.isTauri=true; const callbacks=new Map(),listeners=new Map();let next=0;
  const make=(id,more={})=>({id,title:id,url:`https://example.com/${id}`,target_browser:'firefox',tags:[],icon:'',...more});
  const items=[make('Alpha',{group_id:'work'}),make('Duplicate Alpha',{url:'https://example.com/Alpha',group_id:'work'})];
  const groups=[{id:'work',name:'Work',color:'',sort_order:0,collapsed:false},{id:'empty',name:'Empty',color:'',sort_order:1,collapsed:false}];
  const vault={exists:true,locked:true,retry_after_seconds:0};
  window.featureTest={calls:[],items,groups,holdExplanation:false,failCleanup:false,holdWorkspace:false,failOpen:false};
  window.emitFeature=event=>{for(const id of listeners.get(event)||[])callbacks.get(id)?.({event,payload:null});};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},transformCallback(fn){callbacks.set(++next,fn);return next;},async invoke(cmd,args={}){
   const state=window.featureTest;if(cmd!=='vault_auth')state.calls.push({cmd,args});
   switch(cmd){
    case 'plugin:event|listen':{const list=listeners.get(args.event)||[];list.push(args.handler);listeners.set(args.event,list);return next;}
    case 'get_dock_data':return structuredClone({bookmarks:items,groups,browsers:[{id:'firefox',name:'Firefox',exe_path:'C:\\Firefox.exe',color:'#ff7139'},{id:'edge',name:'Edge',exe_path:'C:\\Edge.exe',color:'#0078d7'}],settings:{theme:'sage',window_size:{width:400,height:null},opacity:1,always_on_top:true,hide_on_open:false,auto_hide:false,auto_tab_groups:true,vault_timeout_minutes:5,global_shortcut:'Ctrl+Shift+Space',panic_shortcut:'Ctrl+Alt+L'},warnings:[]});
    case 'companion_tabs_digest':return {instances:[],error:null};
    case 'vault_status':return {...vault};
    case 'vault_auth':vault.locked=false;return;
    case 'vault_list':return {bookmarks:[make('Secret',{private:true})],groups:[]};
    case 'vault_lock':vault.locked=true;window.emitFeature('vault-locked');return;
    case 'route_details':return {browser_id:'firefox'};
    case 'route_explanation':if(state.holdExplanation)return new Promise(resolve=>state.finishExplanation=()=>resolve({details:{browser_id:'firefox'},steps:['STALE PRIVATE EXPLANATION']}));return {details:{browser_id:args.browserId??'firefox'},steps:['This bookmark is saved to open with Firefox.','The group organizes bookmarks; each top-level bookmark determines its browser.']};
    case 'library_inspect':return [{kind:'duplicate',id:'Duplicate Alpha',title:'Duplicate Alpha',detail:'Same destination and group as Alpha',removable:true},{kind:'empty_group',id:'empty',title:'Empty',detail:'No public bookmarks in this group',removable:true},{kind:'browser',id:'Alpha',title:'Alpha',detail:'Check the configured browser path',removable:false}];
    case 'library_cleanup':if(state.failCleanup)throw Error('Cleanup selection changed. Review the library again.');for(const selection of args.selections){if(selection.kind==='duplicate')items.splice(items.findIndex(b=>b.id===selection.id),1);else groups.splice(groups.findIndex(g=>g.id===selection.id),1);}return;
    case 'workspace_tabs':if(state.largeReview)return [{instance_id:'ff',browser:'firefox',tabs:Array.from({length:150},(_,index)=>({id:index,title:`Page ${index}`,url:`https://a.test/${index}`,container:null,incognito:false}))}];return [{instance_id:'ff',browser:'firefox',tabs:[{id:1,title:'Research page',url:'https://a.test/',container:'firefox-container-1',incognito:false}]},{instance_id:'edge',browser:'edge',tabs:[{id:2,title:'Reference page',url:'https://b.test/',container:null,incognito:false}]}];
    case 'workspace_save':if(state.holdWorkspace)await new Promise(resolve=>state.finishWorkspace=resolve);groups.push({id:'snapshot',name:args.name,color:'',sort_order:groups.length,collapsed:false});items.push(make('Saved research',{tags:['workspace'],group_id:'snapshot'}));return {group_id:'snapshot',added:2};
    case 'open_group':if(state.failOpen)throw Error('Companion disconnected; some tabs may have opened. No retry was made.');return {processed:2};
    default:return;
   }
  }};
 });
 await page.goto('http://127.0.0.1:1420/');
 await page.getByRole('button',{name:'Why this browser?',exact:true}).click(); await page.getByText('This bookmark is saved to open with Firefox.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Why this browser?',exact:true}).click();
 // Private explanation must disappear and ignore late replies after lock.
 await page.getByRole('button',{name:'Vault',exact:true}).click();await page.getByLabel('Passphrase',{exact:true}).fill('test passphrase');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
 await page.evaluate(()=>window.featureTest.holdExplanation=true);await page.getByRole('button',{name:'Why this browser?',exact:true}).click();await page.waitForFunction(()=>!!window.featureTest.finishExplanation);
 await page.evaluate(()=>{void window.__TAURI_INTERNALS__.invoke('vault_lock');window.featureTest.finishExplanation();window.featureTest.holdExplanation=false;});
 await page.getByRole('button',{name:'All bookmarks',exact:true}).waitFor();assert.equal(await page.getByText('STALE PRIVATE EXPLANATION').count(),0);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Library',exact:true}).click();
 const cleanup=page.locator('section').filter({has:page.getByRole('heading',{name:'Library cleanup',exact:true})});
 await cleanup.getByRole('button',{name:'Check library',exact:true}).click();await cleanup.getByRole('checkbox',{name:/Duplicate Alpha/}).check();
 assert.equal(await cleanup.getByRole('button',{name:'Remove selected items',exact:true}).isEnabled(),false);
 await cleanup.getByRole('checkbox',{name:'I reviewed these removals'}).check();await page.evaluate(()=>window.featureTest.failCleanup=true);await cleanup.getByRole('button',{name:'Remove selected items',exact:true}).click();await cleanup.getByText('Error: Cleanup selection changed. Review the library again.',{exact:true}).waitFor();
 assert.equal(await cleanup.getByRole('checkbox',{name:'I reviewed these removals'}).isChecked(),false);
 await page.evaluate(()=>window.featureTest.failCleanup=false);await cleanup.getByRole('checkbox',{name:/^Empty/}).check();await cleanup.getByRole('checkbox',{name:'I reviewed these removals'}).check();await cleanup.getByRole('button',{name:'Remove selected items',exact:true}).click();await cleanup.getByText('Removed 2 selected items.',{exact:true}).waitFor();
 const workspace=page.locator('section').filter({has:page.getByRole('heading',{name:'Workspace snapshots',exact:true})});
 await workspace.getByRole('button',{name:'Review open tabs',exact:true}).click();await workspace.getByLabel('Workspace name',{exact:true}).fill('Research');await workspace.getByRole('button',{name:'Select first 50',exact:true}).click();
 await page.evaluate(()=>window.featureTest.holdWorkspace=true);await workspace.getByRole('button',{name:'Save workspace',exact:true}).click();await page.waitForFunction(()=>!!window.featureTest.finishWorkspace);
 assert.equal(await page.getByRole('button',{name:'Back',exact:true}).isEnabled(),false);assert.equal(await page.getByRole('tab',{name:'Appearance',exact:true}).isEnabled(),false);
 await page.evaluate(()=>window.featureTest.finishWorkspace());await workspace.getByText('Saved 2 unique destinations in a new public group.',{exact:true}).waitFor();
 const sent=await page.evaluate(()=>window.featureTest.calls.find(c=>c.cmd==='workspace_save').args);assert.equal(sent.name,'Research');assert.deepEqual(sent.selected,[{instance_id:'ff',tab_id:1,url:'https://a.test/',container:'firefox-container-1'},{instance_id:'edge',tab_id:2,url:'https://b.test/',container:null}]);
 await workspace.getByRole('button',{name:'Reopen workspace',exact:true}).click();await workspace.getByText('Opened or reused 2 workspace tabs.',{exact:true}).waitFor();
 await page.evaluate(()=>window.featureTest.failOpen=true);await workspace.getByRole('button',{name:'Reopen workspace',exact:true}).click();await workspace.getByText('Error: Companion disconnected; some tabs may have opened. No retry was made.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.featureTest.calls.filter(c=>c.cmd==='open_group').length),2);
 for(const width of [280,400,800]){await page.setViewportSize({width,height:700});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`/tmp/browserdock-final-library-${width}.png`});}
 await page.evaluate(()=>window.featureTest.largeReview=true);await workspace.getByRole('button',{name:'Review open tabs',exact:true}).click();assert.equal(await workspace.locator('.tab-choice').count(),50);await workspace.locator('.tab-choice input').first().check();await workspace.getByRole('button',{name:'Next tabs',exact:true}).click();await workspace.locator('.tab-choice input').first().check();await workspace.getByText('2 tabs selected.',{exact:true}).waitFor();await workspace.getByRole('button',{name:'Previous tabs',exact:true}).click();assert.equal(await workspace.locator('.tab-choice input').first().isChecked(),true);
 assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);console.log('Final improvements passed: routing/private cleanup, selected removals, mixed-browser workspace save/reopen, pending/error guards and 280/400/800 px layouts.');
}finally{await browser.close();}
