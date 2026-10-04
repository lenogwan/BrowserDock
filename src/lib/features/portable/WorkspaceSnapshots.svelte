<script lang="ts">
  import { invokeCommand, type PublicTabs, type TabSelection } from '../../platform/tauri/commands';
  import type { Group, Bookmark, Browser } from '../../shared/types';
  let { native, groups, bookmarks, browsers, onchange, busy = $bindable(false) }: {native:boolean; groups:Group[]; bookmarks:Bookmark[]; browsers:Browser[]; onchange:()=>Promise<void>; busy?:boolean} = $props();
  let page = $state(0);
  let inventory = $state<PublicTabs[] | null>(null), selected = $state<string[]>([]), name = $state(''), savedGroup = $state(''), error = $state(''), message = $state('');
  const entries = $derived((inventory ?? []).flatMap(i=>i.tabs.map(tab=>({tab,instanceId:i.instance_id,browser:i.browser}))));
  const visibleEntries = $derived(entries.slice(page * 50, page * 50 + 50));
  const key = (instance:string,id:number)=>JSON.stringify([instance,id]);
  const workspaceGroups = $derived(groups.filter(g=>bookmarks.some(b=>b.group_id===g.id && b.tags.includes('workspace'))));
  const browserName = (id:string)=>browsers.find(b=>b.id===id)?.name??id;
  async function review() {
    if (busy || !native) return;
    busy = true; error = ''; message = ''; inventory = null; selected = []; page = 0;
    try { inventory = await invokeCommand('workspace_tabs'); }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
  function selectFirst() {
    if (busy || !inventory) return;
    selected = selected.length ? [] : inventory.flatMap(i=>i.tabs.map(t=>key(i.instance_id,t.id))).slice(0,50);
  }
  async function save() {
    if (busy || !inventory || !selected.length || selected.length > 50 || !name.trim()) return;
    busy = true; error = ''; message = '';
    try {
      const tabs:TabSelection[] = inventory.flatMap(i=>i.tabs.filter(t=>selected.includes(key(i.instance_id,t.id))).map(t=>({instance_id:i.instance_id,tab_id:t.id,url:t.url,container:t.container})));
      const result = await invokeCommand('workspace_save',{name:name.trim(),selected:tabs});
      savedGroup = result.group_id; inventory = null; selected = []; name = '';
      message = `Saved ${result.added} unique destinations in a new public group.`;
      try { await onchange(); } catch { error = 'Your workspace was saved, but the library could not refresh. Reopen BrowserDock.'; }
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
  async function reopen() {
    if (busy || !savedGroup) return;
    busy = true; error = ''; message = '';
    try {
      const result = await invokeCommand('open_group',{groupId:savedGroup,private:false});
      message = `Opened or reused ${result.processed} workspace tabs.${result.note ? ` ${result.note}` : ''}`;
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
</script>
<section class="library-card" aria-labelledby="workspace-heading">
  <h2 id="workspace-heading">Workspace snapshots</h2>
  <p>Save selected public tabs across connected browsers as a named group. Reopen it with each saved browser and non-default container. Identical destinations are combined.</p>
  <p>Profiles, private tabs and window positions are not captured. Review up to 200 tabs per companion and save up to 50 at once.</p>
  <button class="secondary" disabled={busy || !native} onclick={review}>Review open tabs</button>
  {#if inventory}
    <label>Workspace name<input bind:value={name} maxlength="64" placeholder="Research, daily work…" disabled={busy} /></label>
    <button class="secondary" disabled={busy} onclick={selectFirst}>{selected.length ? 'Clear selection' : 'Select first 50'}</button>
    <div class="tab-list">
      {#each visibleEntries as item (key(item.instanceId,item.tab.id))}
        <label class="tab-choice"><input type="checkbox" value={key(item.instanceId,item.tab.id)} checked={selected.includes(key(item.instanceId,item.tab.id))} disabled={busy} onchange={event=>{const id=key(item.instanceId,item.tab.id);selected=event.currentTarget.checked?[...selected,id]:selected.filter(value=>value!==id);}} /><span><strong>{item.tab.title}</strong><small>{item.tab.url}</small><small>{browserName(item.browser)}{item.tab.container ? ` · Container: ${item.tab.container}` : ''}</small></span></label>
      {/each}
    </div>
    {#if entries.length > 50}<div class="pages"><button class="secondary" disabled={busy || page === 0} onclick={()=>page--}>Previous tabs</button><span>Page {page + 1} / {Math.ceil(entries.length / 50)}</span><button class="secondary" disabled={busy || (page + 1) * 50 >= entries.length} onclick={()=>page++}>Next tabs</button></div>{/if}
    <p role="status">{selected.length} tabs selected{selected.length > 50 ? ' — select at most 50.' : '.'}</p>
    <button class="primary" disabled={busy || !name.trim() || !selected.length || selected.length > 50} onclick={save}>Save workspace</button>
  {/if}
  {#if workspaceGroups.length}
    <label>Saved workspace<select bind:value={savedGroup} disabled={busy}><option value="">Choose a workspace</option>{#each workspaceGroups as group}<option value={group.id}>{group.name}</option>{/each}</select></label>
    <button class="secondary" disabled={busy || !savedGroup || !native} onclick={reopen}>Reopen workspace</button>
    <p>Edit, rename or remove its bookmarks and group from All bookmarks. Library backups include workspace groups.</p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p class="notice" role="status">{message}</p>{/if}
</section>
<style>
  .library-card {padding:14px;border:1px solid #ffffff18;border-radius:10px;display:grid;gap:10px;min-width:0;}
  h2 {margin:0;font-size:14px;}
  p {margin:0;font-size:11px;line-height:1.6;color:var(--muted);}
  button {justify-self:start;font-size:11px;}
  .pages {display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:10px;}
  .tab-list {max-height:260px;overflow:auto;}
  .tab-choice {display:flex;align-items:flex-start;gap:8px;font-size:11px;padding:6px 0;line-height:1.5;}
  .tab-choice input {width:15px;height:15px;flex-shrink:0;}
  .tab-choice span {min-width:0;overflow-wrap:anywhere;}
  small {display:block;color:var(--muted);font-size:10px;}
</style>
