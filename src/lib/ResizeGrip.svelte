<script lang="ts">
  import { onDestroy } from 'svelte';
  import { resizeFromPointer } from './resize.js';
  import type { WindowSize } from './types';
  let {size,onpreview,oncommit,oncancel}:{size:WindowSize;onpreview:(size:WindowSize)=>Promise<void>;oncommit:(size:WindowSize)=>Promise<void>;oncancel:()=>Promise<void>}=$props();
  let drag: {id:number;x:number;y:number;height:number;size:WindowSize}|null=null;
  let pending:WindowSize|null=null;
  let last:WindowSize|null=null;
  let frame=0;
  let busy=$state(false);
  let error=$state('');
  let failed=false;
  let manual=false;
  let applying=Promise.resolve();
  function flush(){if(frame)cancelAnimationFrame(frame);frame=0;if(pending){const value=pending;pending=null;applying=onpreview(value).catch(e=>{failed=true;error=String(e)});}}
  function start(e:PointerEvent){
    if(e.button!==0||busy)return;
    e.preventDefault();e.stopPropagation();error='';failed=false;manual=size.height!==null;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag={id:e.pointerId,x:e.screenX,y:e.screenY,height:window.innerHeight,size:{...size,width:window.innerWidth}};
    last=null;
  }
  function move(e:PointerEvent){
    if(!drag||e.pointerId!==drag.id)return;
    last=resizeFromPointer(drag.size,drag.height,e.screenX-drag.x,e.screenY-drag.y);
    // Once a gesture changes height it remains manual, even if it returns to its start.
    manual ||= e.screenY!==drag.y;
    if(manual&&last.height===null)last.height=drag.height;
    pending=last;if(!frame)frame=requestAnimationFrame(flush);
  }
  async function finish(e:PointerEvent,cancel=false){
    if(!drag||e.pointerId!==drag.id)return;
    drag=null;busy=true;
    try{
      if(cancel){pending=null;if(frame)cancelAnimationFrame(frame);frame=0;await oncancel();}
      else if(last){flush();await applying;if(failed)await oncancel();else await oncommit(last);}
    }catch(e){error=String(e);await oncancel().catch(()=>{});}finally{busy=false;}
  }
  async function reset(){if(busy)return;busy=true;error='';try{const value={width:400,height:null};await onpreview(value);await oncommit(value);}catch(e){error=String(e);}finally{busy=false;}}
  onDestroy(()=>{if(frame)cancelAnimationFrame(frame);if(drag)void oncancel().catch(()=>{});});
</script>
<button class="resize-grip" aria-label="Resize dock" title="Drag to resize · double-click to reset to auto size" disabled={busy}
  onpointerdown={start} onpointermove={move} onpointerup={e=>finish(e)} onpointercancel={e=>finish(e,true)}
  onlostpointercapture={e=>{if(drag)void finish(e,true)}} ondblclick={reset}>
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 12 12 5M9 12l3-3" /></svg>
</button>
{#if error}<span class="resize-error" role="alert">{error}</span>{/if}
<style>
  .resize-grip{position:absolute;bottom:3px;right:4px;width:16px;height:16px;padding:0;background:transparent;color:var(--muted);cursor:nwse-resize;touch-action:none;z-index:5}
  svg{width:16px;height:16px;stroke:currentColor;stroke-width:1.4;fill:none}
  .resize-grip:hover{color:var(--accent)}
  .resize-error{position:absolute;bottom:20px;right:10px;max-width:240px;background:var(--surface);color:#f0b0a4;font-size:10px;padding:6px;border-radius:6px;z-index:6}
</style>
