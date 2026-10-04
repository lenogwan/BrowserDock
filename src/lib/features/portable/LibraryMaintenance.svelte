<script lang="ts">
  import { invokeCommand, type LibraryIssue } from '../../platform/tauri/commands';
  let { native, onchange, busy = $bindable(false) }: {native:boolean; onchange:()=>Promise<void>; busy?:boolean} = $props();
  let page = $state(0);
  let issues = $state<LibraryIssue[] | null>(null), selected = $state<string[]>([]), confirm = $state(false), error = $state(''), message = $state('');
  const visibleIssues = $derived((issues ?? []).slice(page * 50, page * 50 + 50));
  const key = (issue:LibraryIssue) => JSON.stringify([issue.kind,issue.id]);
  async function inspect() {
    if (busy || !native) return;
    busy = true; error = ''; message = ''; selected = []; confirm = false; page = 0;
    try { issues = await invokeCommand('library_inspect'); }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
  async function cleanup() {
    if (busy || !issues || !selected.length || !confirm) return;
    busy = true; error = ''; message = '';
    try {
      const selections = issues.filter(i=>selected.includes(key(i))).map(({kind,id})=>({kind,id}));
      await invokeCommand('library_cleanup',{selections});
      message = `Removed ${selections.length} selected items.`; issues = null; selected = []; confirm = false;
      try { await onchange(); } catch { error = 'Cleanup was saved, but the bookmark list could not refresh. Reopen BrowserDock.'; }
    } catch (cause) { error = String(cause); confirm = false; }
    finally { busy = false; }
  }
</script>
<section class="library-card" aria-labelledby="cleanup-heading">
  <h2 id="cleanup-heading">Library cleanup</h2>
  <p>Find duplicate destinations, empty public groups and unavailable browsers or containers. This check stays on your computer.</p>
  <button class="secondary" disabled={busy || !native} onclick={inspect}>Check library</button>
  {#if issues}
    <p role="status">{issues.length ? `${issues.length} issues to review.` : 'No issues found.'} Container availability is checked only against connected companions.</p>
    <div class="issues">
      {#each visibleIssues as issue (key(issue))}
        <label class="issue">
          {#if issue.removable}<input type="checkbox" value={key(issue)} checked={selected.includes(key(issue))} disabled={busy} onchange={event=>{ selected = event.currentTarget.checked ? [...selected,key(issue)] : selected.filter(id=>id!==key(issue)); confirm=false; }} />{/if}
          <span><strong>{issue.title}</strong><small>{issue.detail}</small>{#if !issue.removable}<small>Review this bookmark in All bookmarks; browser paths are in Settings → Browsers.</small>{/if}</span>
        </label>
      {/each}
    </div>
    {#if issues.length > 50}<div class="pages"><button class="secondary" disabled={busy || page === 0} onclick={()=>page--}>Previous issues</button><span>Page {page + 1} / {Math.ceil(issues.length / 50)}</span><button class="secondary" disabled={busy || (page + 1) * 50 >= issues.length} onclick={()=>page++}>Next issues</button></div>{/if}
    {#if selected.length}
      <p>Remove {selected.length} selected duplicate bookmarks or empty groups? Save a library backup first if you want a recovery copy.</p>
      <label class="check"><input type="checkbox" bind:checked={confirm} disabled={busy} /> I reviewed these removals</label>
      <button class="secondary" disabled={busy || !confirm} onclick={cleanup}>Remove selected items</button>
    {/if}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p class="notice" role="status">{message}</p>{/if}
</section>
<style>
  .library-card {padding:14px;border:1px solid #ffffff18;border-radius:10px;display:grid;gap:10px;min-width:0;}
  h2 {margin:0;font-size:14px;} p {margin:0;font-size:11px;line-height:1.6;color:var(--muted);}
  button {justify-self:start;font-size:11px;}
  .pages {display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:10px;}
  .issues {max-height:260px;overflow:auto;display:grid;gap:8px;}
  .issue,.check {display:flex;align-items:flex-start;gap:8px;font-size:11px;line-height:1.5;}
  input {width:15px;height:15px;flex-shrink:0;} .issue span {min-width:0;overflow-wrap:anywhere;}
  small {display:block;color:var(--muted);font-size:10px;}
</style>
