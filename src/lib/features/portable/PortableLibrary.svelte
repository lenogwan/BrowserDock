<script lang="ts">
  import { onDestroy } from 'svelte';
  import { invokeCommand, type ImportItem, type ImportSummary, type BackupPreview } from '../../platform/tauri/commands';
  import type { Browser, Group } from '../../shared/types';
  import { parseBookmarkHtml } from './import.js';
  let { browsers, groups, native, onchange }: { browsers: Browser[]; groups: Group[]; native: boolean; onchange: () => Promise<void> } = $props();
  let items = $state<ImportItem[]>([]), rejected = $state(0), browserId = $state('firefox'), groupId = $state(''), folders = $state(true);
  let summary = $state<ImportSummary | null>(null), backup = $state<BackupPreview | null>(null), backupText = $state(''), restoreVault = $state(false), confirmed = $state(false);
  let busy = $state(false), error = $state(''), message = $state(''), generation = 0;
  const downloads = new Set<string>();
  onDestroy(() => { generation++; for (const url of downloads) URL.revokeObjectURL(url); });
  async function run(action: () => Promise<void>) {
    if (busy || !native) return;
    busy = true; error = ''; message = '';
    try { await action(); } catch (cause) { error = String(cause); } finally { busy = false; }
  }
  function invalidate() { summary = null; }
  async function readImport(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const epoch = ++generation;
    items = []; summary = null; rejected = 0;
    await run(async () => {
      if (file.size > 4 * 1024 * 1024) throw Error('Bookmark HTML must be at most 4 MB.');
      const text = await file.text();
      if (epoch !== generation) return;
      const result = parseBookmarkHtml(text); items = result.items; rejected = result.rejected.length;
    });
  }
  async function previewImport() {
    await run(async () => { summary = await invokeCommand('import_bookmarks', { items: $state.snapshot(items), browserId, groupId: groupId || null, folders, preview: true }); });
  }
  async function commitImport() {
    await run(async () => {
      const result = await invokeCommand('import_bookmarks', { items: $state.snapshot(items), browserId, groupId: groupId || null, folders, preview: false });
      items = []; summary = null;
      message = `Imported ${result.added} bookmarks; skipped ${result.duplicates} duplicates.`;
      await onchange();
    });
  }
  async function downloadBackup() {
    await run(async () => {
      const text = await invokeCommand('backup_export');
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); downloads.add(url);
      const a = document.createElement('a'); a.href = url; a.download = `browserdock-library-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1000);
      message = 'Backup prepared. Keep it with the vault password in a safe place.';
    });
  }
  async function readBackup(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const epoch = ++generation;
    backup = null; backupText = ''; confirmed = false; restoreVault = false;
    await run(async () => {
      if (file.size > 12 * 1024 * 1024) throw Error('Backup must be at most 12 MB.');
      const text = await file.text();
      if (epoch !== generation) return;
      const result = await invokeCommand('backup_preview', { text });
      if (epoch !== generation) return;
      backupText = text; backup = result;
    });
  }
  async function restore() {
    await run(async () => {
      const directory = await invokeCommand('backup_restore', { text: backupText, restoreVault });
      backup = null; backupText = ''; confirmed = false;
      message = `Library restored. Previous files are saved in ${directory}.`;
      await onchange();
    });
  }
</script>
<div class="portable">
  <h3>Import browser bookmarks</h3>
  <p>Export bookmarks as HTML from Firefox, Mullvad, Chrome or Edge. Imports go to public bookmarks; private data stays in the vault.</p>
  <label>Bookmark HTML <input type="file" accept=".html,.htm,text/html" disabled={busy || !native} onchange={readImport} /></label>
  {#if items.length || rejected}
    <p>{items.length} eligible bookmarks; {rejected} unsupported or oversized entries skipped.</p>
    <label>Open with <select bind:value={browserId} disabled={busy} onchange={invalidate}>{#each browsers as browser}<option value={browser.id}>{browser.name}</option>{/each}</select></label>
    <label>Default group <select bind:value={groupId} disabled={busy} onchange={invalidate}><option value="">Ungrouped</option>{#each groups as group}<option value={group.id}>{group.name}</option>{/each}</select></label>
    <label class="check"><input type="checkbox" bind:checked={folders} disabled={busy} onchange={invalidate} /> Use folder names as groups</label>
    <p>Nested folders use their immediate folder name. Groups with the same name are merged. Exact URL/browser/group destinations without a profile, container or private window are skipped.</p>
    <ul class="preview" aria-label="Import preview">{#each items.slice(0, 100) as item}<li><strong>{item.title}</strong><small>{item.url}</small>{#if folders && item.folder}<small>{item.folder}</small>{/if}</li>{/each}</ul>
    {#if items.length > 100}<p>Showing the first 100 of {items.length} bookmarks.</p>{/if}
    <button class="secondary" disabled={busy || !items.length} onclick={previewImport}>Check import</button>
    {#if summary}<p role="status">{summary.added} new bookmarks, {summary.duplicates} duplicates, {summary.groups_added} new groups.</p><button class="primary" disabled={busy || !summary.added} onclick={commitImport}>Import bookmarks</button>{/if}
  {/if}
  <h3>Portable library backup</h3>
  <p>Includes public bookmarks/groups and the encrypted vault. Browser paths, settings, routing rules and pairing credentials stay on this computer. The vault needs its original password.</p>
  <button class="secondary" disabled={busy || !native} onclick={downloadBackup}>Download library backup</button>
  <label>Restore backup <input type="file" accept=".json,application/json" disabled={busy || !native} onchange={readBackup} /></label>
  {#if backup}
    <p>{backup.bookmarks} public bookmarks, {backup.groups} public groups. {backup.has_vault ? 'Contains an encrypted vault; its contents are verified when unlocked.' : 'No vault included.'}</p>
    {#if backup.has_vault}<label class="check"><input type="checkbox" bind:checked={restoreVault} disabled={busy} onchange={() => confirmed = false} /> Also replace the encrypted vault</label>{/if}
    <label class="check"><input type="checkbox" bind:checked={confirmed} disabled={busy} /> Replace my public library{restoreVault ? ' and vault' : ''}; keep recovery copies of the current files</label>
    <button class="primary" disabled={busy || !confirmed} onclick={restore}>Restore library</button>
  {/if}
  {#if busy}<p role="status">Working…</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</div>
<style>
  .portable {display:grid;gap:9px;min-width:0;font-size:11px;color:var(--text);}
  h3 {font-size:12px;margin:5px 0;} p {color:var(--muted);line-height:1.5;margin:0;overflow-wrap:anywhere;}
  label {display:grid;gap:5px;} .check {display:flex;align-items:center;gap:7px;}
  input,select {max-width:100%;min-width:0;} .preview {max-height:180px;overflow:auto;padding-left:17px;}
  li {margin:5px 0;overflow-wrap:anywhere;} li small {display:block;color:var(--muted);}
  button {justify-self:start;font-size:11px;} .error {color:var(--danger,#e08a8a);}
</style>
