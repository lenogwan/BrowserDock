<script lang="ts">
 import type {Group} from '../../shared/types';
 let {group,groups,onsave,ondelete,oncancel,onreorder}:{group:Group;groups:Group[];onsave:(group:Group)=>Promise<void>;ondelete:()=>Promise<void>;oncancel:()=>void;onreorder:(direction:number)=>Promise<void>}=$props();
 // svelte-ignore state_referenced_locally
 let name=$state(group.name);
 // svelte-ignore state_referenced_locally
 let color=$state(group.color||'#b8edc9');
 let busy=$state(false),error=$state(''),confirm=$state(false);
 async function run(action:()=>Promise<void>){busy=true;error='';try{await action()}catch(e){error=String(e)}finally{busy=false}}
</script>
<form class="editor" onsubmit={e=>{e.preventDefault();void run(()=>onsave({...group,name:name.trim(),color}))}}>
 <span class="eyebrow">{group.private?'PRIVATE GROUP':'BOOKMARK GROUP'}</span><h1>A place for your places.</h1>
 <label>Name<input bind:value={name} required maxlength="64" /></label><label>Color<input type="color" bind:value={color} /></label>
 {#if groups.some(g=>g.id===group.id)}<div class="actions"><button type="button" class="secondary" disabled={busy||groups[0]?.id===group.id} onclick={()=>run(()=>onreorder(-1))}>Move up</button><button type="button" class="secondary" disabled={busy||groups.at(-1)?.id===group.id} onclick={()=>run(()=>onreorder(1))}>Move down</button></div>{/if}
 <div class="actions"><button type="button" class="secondary" onclick={oncancel} disabled={busy}>Cancel</button><button class="primary" disabled={busy}>Save group</button></div>
 {#if groups.some(g=>g.id===group.id)}<button type="button" class="secondary" disabled={busy} onclick={()=>{if(!confirm)confirm=true;else void run(ondelete)}}>{confirm?'Confirm deletion · keep bookmarks':'Delete group'}</button>{/if}
 {#if confirm}<p>Bookmarks move to Ungrouped.</p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
</form>
<style>.editor{padding:12px;display:grid;gap:14px}h1{font:23px Georgia,serif}.actions{display:flex;gap:8px}.actions button{flex:1}p{font-size:11px;color:var(--muted)}</style>
