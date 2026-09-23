import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resizeFromPointer, createSizeController } from '../src/lib/features/dock/resize.js';

// Tauri runs synchronous commands on the UI thread. These commands acquire
// locks also held by auto-fit while it waits for a UI-thread window getter.
// Guard the dispatch contract: browser IPC mocks cannot reproduce that deadlock.
test('native size commands must not wait for sizing locks on the UI thread',()=>{
 const source=readFileSync(new URL('../src-tauri/src/window_sizing.rs',import.meta.url),'utf8');
 for(const command of ['dock_set_size','dock_cancel_size','dock_commit_size']) {
  assert.match(source,new RegExp('#\\[tauri::command\\]\\s+pub async fn '+command+'\\('),`${command} must use asynchronous Tauri dispatch`);
 }
});

test('horizontal drag preserves auto height; vertical drag enters manual; dimensions clamp',()=>{
 const start={width:400,height:null};
 assert.deepEqual(resizeFromPointer(start,440,100,0),{width:500,height:null});
 assert.deepEqual(resizeFromPointer(start,440,100,60),{width:500,height:500});
 assert.deepEqual(resizeFromPointer(start,440,-300,-1000),{width:280,height:56});
 assert.deepEqual(resizeFromPointer({width:400,height:500},500,900,0),{width:800,height:500});
});
test('size preview is serialized; commit follows pending apply and cancel restores saved backend state',async()=>{
 const calls=[];let release;
 const controller=createSizeController(async(cmd,args)=>{
  calls.push({cmd,args});
  if(calls.length===1)await new Promise(resolve=>release=resolve);
 });
 const first=controller.preview({width:500,height:600});
 const second=controller.preview({width:600,height:650});
 const commit=controller.commit();
 await Promise.resolve();assert.equal(calls.length,1);
 release();await Promise.all([first,second,commit]);
 assert.deepEqual(calls.map(c=>c.cmd),['dock_set_size','dock_set_size','dock_commit_size']);
 await controller.preview({width:400,height:null});
 await controller.cancel();
 assert.deepEqual(calls.at(-2).args,{width:400,height:null});
 assert.equal(calls.at(-1).cmd,'dock_cancel_size');
});
