// Rendered capture controls; runtime and storage are mocked, native popup hosting is not.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:360,height:600}}); const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{
  const groups=[{id:'work',name:'Work'}];
  window.captureTest={calls:[],writes:[],response:null,blocked:true};
  window.browser={storage:{local:{async get(){return {capturePreferences:{groupId:'work'}};},async set(value){window.captureTest.writes.push(value);}}},runtime:{
   async sendMessage(message){
    const state=window.captureTest; state.calls.push(message);
    if(message.type==='BROWSERDOCK_QUICK_STATUS')return {blocked:state.blocked};
    if(message.type==='BROWSERDOCK_QUICK_ACK'){state.blocked=false;return {ok:true};}
    if(message.type==='BROWSERDOCK_CAPTURE_CONTEXT')return {ok:true,payload:{contextId:'context',tabId:1,url:'https://a.test/',title:'A',browser:'firefox',groups}};
    if(message.type==='BROWSERDOCK_CAPTURE_BATCH_CONTEXT')return {ok:true,payload:{contextId:'context',browser:'firefox',groups,total:3,tabs:[{tabId:1,title:'<script>A</script>',url:'https://a.test/'},{tabId:2,title:'B',url:'https://b.test/'},{tabId:3,title:'C',url:'https://c.test/'}]}};
    return state.response??{ok:true,payload:{result:'BATCH_SAVED',added:message.items.length-1,duplicates:1}};
   },async openOptionsPage(){}
  }};
 });
 await page.goto(new URL('../src/capture.html',import.meta.url).href);
 await page.waitForFunction(()=>document.getElementById('group').value==='work');
 assert.equal(await page.locator('#quick-unknown').isVisible(),true);
 await page.getByRole('button',{name:'I checked BrowserDock'}).click(); assert.equal(await page.locator('#quick-unknown').isVisible(),false);
 await page.getByRole('button',{name:'Several tabs',exact:true}).click();
 await page.locator('.tab-choice').first().waitFor(); assert.equal(await page.locator('.tab-choice').count(),3);
 assert.equal(await page.locator('#title').isDisabled(),true); assert.equal(await page.locator('#save').isDisabled(),true);
 await page.getByRole('button',{name:'Select first 50'}).click(); assert.equal(await page.locator('#save').textContent(),'Save 3 tabs');
 await page.locator('.tab-choice input').nth(2).uncheck();
 await page.locator('#save').click(); await page.getByText('Saved 1 tab; 1 already saved.',{exact:true}).waitFor();
 const sent=await page.evaluate(()=>window.captureTest.calls.find(c=>c.type==='BROWSERDOCK_CAPTURE_BATCH_SAVE'));
 assert.equal(sent.groupId,'work'); assert.deepEqual(sent.items.map(t=>t.tabId),[1,2]);
 assert.equal(await page.locator('#refresh').isDisabled(),true); assert.equal(await page.locator('#mode-current').isDisabled(),true);
 assert.deepEqual(await page.evaluate(()=>window.captureTest.writes),[{capturePreferences:{groupId:'work'}}]);
 // A definite rejection permits correction; an ambiguous result freezes every save path.
 await page.reload(); await page.getByRole('button',{name:'I checked BrowserDock'}).click(); await page.getByRole('button',{name:'Several tabs',exact:true}).click(); await page.locator('.tab-choice').first().waitFor(); await page.locator('.tab-choice input').first().check();
 await page.evaluate(()=>window.captureTest.response={ok:false,error:'A selected tab changed. Refresh before saving.'});
 await page.locator('#save').click(); await page.getByText('A selected tab changed. Refresh before saving.',{exact:true}).waitFor(); assert.equal(await page.locator('#refresh').isDisabled(),false);
 await page.evaluate(()=>window.captureTest.response={ok:true,payload:{result:'BATCH_SAVED',added:99,duplicates:0}});
 await page.locator('#save').click(); await page.getByText('Save outcome unknown. Check BrowserDock before trying again.',{exact:true}).waitFor(); assert.equal(await page.locator('#refresh').isDisabled(),true); assert.equal(await page.locator('#mode-window').isDisabled(),true);
 assert.deepEqual(errors,[]); console.log('Capture workflows passed: remembered group, explicit shortcut acknowledgement, selected-tab save, duplicates, correction and uncertain-result guards.');
} finally {await browser.close();}
