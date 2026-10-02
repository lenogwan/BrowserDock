<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { revealItemInDir } from '@tauri-apps/plugin-opener';
  import { invokeCommand, type ImportItem, type ImportSummary, type BackupPreview } from '../../platform/tauri/commands';
  import type { Browser, Group } from '../../shared/types';
  import { parseBookmarkHtml } from './import.js';
  let { browsers, groups, publicCount, native, onchange, busy = $bindable(false) }: {
    browsers: Browser[]; groups: Group[]; publicCount: number; native: boolean;
    onchange: () => Promise<void>; busy?: boolean;
  } = $props();
  let items = $state<ImportItem[]>([]), rejected = $state(0), browserId = $state('firefox'), groupId = $state(''), folders = $state(true);
  let summary = $state<ImportSummary | null>(null), backup = $state<BackupPreview | null>(null), backupText = $state(''), restoreVault = $state(false), confirmed = $state(false);
  let importName = $state(''), backupName = $state(''), active = $state(''), error = $state(''), message = $state(''), generation = 0;
  let feedback = $state<HTMLDivElement>();
  let savedBackup = $state('');
  onDestroy(() => { generation++; });
  async function run(label: string, action: () => Promise<void>) {
    if (busy || !native) return;
    busy = true; active = label; error = ''; message = '';
    try { await action(); } catch (cause) { error = String(cause); }
    finally {
      busy = false; active = '';
      if (error || message) { await tick(); feedback?.focus(); feedback?.scrollIntoView({ block: 'nearest' }); }
    }
  }
  function plural(count: number, noun: string) { return `${count} ${noun}${count === 1 ? '' : 's'}`; }
  function invalidate() { summary = null; message = ''; error = ''; }
  async function refresh() {
    try { await onchange(); }
    catch { error = 'Your library was saved, but the bookmark list could not refresh. Close and reopen BrowserDock to see the changes.'; }
  }
  async function readImport(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file || busy) return;
    const epoch = ++generation;
    items = []; summary = null; rejected = 0; importName = '';
    await run('Reading bookmark file…', async () => {
      if (file.size > 4 * 1024 * 1024) throw Error('Bookmark HTML must be at most 4 MB.');
      const text = await file.text();
      if (epoch !== generation) return;
      const result = parseBookmarkHtml(text); items = result.items; rejected = result.rejected.length; importName = file.name;
    });
  }
  async function previewImport() {
    await run('Checking duplicates and groups…', async () => { summary = await invokeCommand('import_bookmarks', { items: $state.snapshot(items), browserId, groupId: groupId || null, folders, preview: true }); });
  }
  async function commitImport() {
    await run('Importing bookmarks…', async () => {
      const result = await invokeCommand('import_bookmarks', { items: $state.snapshot(items), browserId, groupId: groupId || null, folders, preview: false });
      items = []; summary = null; importName = ''; rejected = 0;
      message = `Imported ${plural(result.added, 'bookmark')}; skipped ${plural(result.duplicates, 'duplicate')}.`;
      await refresh();
    });
  }
  async function saveBackup() {
    await run('Saving your backup…', async () => {
      const path = await invokeCommand('backup_save');
      savedBackup = path;
      message = `Backup saved to ${path}. The encrypted vault needs its original passphrase to unlock.`;
    });
  }
  async function showBackup() {
    if (!savedBackup) return;
    await run('Opening backup folder…', async () => {
      try { await revealItemInDir(savedBackup); }
      catch { throw Error(`Your backup is saved at ${savedBackup}, but the folder could not open. Open Downloads in File Explorer.`); }
    });
  }
  async function readBackup(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file || busy) return;
    const epoch = ++generation;
    backup = null; backupText = ''; backupName = ''; confirmed = false; restoreVault = false;
    await run('Checking your backup…', async () => {
      if (file.size > 12 * 1024 * 1024) throw Error('Backup must be at most 12 MB.');
      const text = await file.text();
      if (epoch !== generation) return;
      const result = await invokeCommand('backup_preview', { text });
      if (epoch !== generation) return;
      backupText = text; backup = result; backupName = file.name;
    });
  }
  async function restore() {
    if (!backup || !confirmed) return;
    await run('Restoring your library…', async () => {
      const directory = await invokeCommand('backup_restore', { text: backupText, restoreVault });
      backup = null; backupText = ''; backupName = ''; confirmed = false;
      items = []; summary = null; importName = ''; rejected = 0;
      message = `Library restored. Previous files are saved in ${directory}.`;
      await refresh();
    });
  }
</script>
<div class="portable" aria-busy={busy}>
  <p class="intro">Bring bookmarks in, keep a local backup, or restore a saved library.</p>
  {#if busy || error || message}
    <div class="feedback" tabindex="-1" bind:this={feedback}>
      {#if busy}<p role="status">{active} Keep this view open until it finishes.</p>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if message}<p class="notice" role="status">{message}</p>{/if}
    </div>
  {/if}
  <section aria-labelledby="library-import" class="library-card">
    <h2 id="library-import">Import browser bookmarks</h2>
    <p>Add bookmarks to your public library. Your existing bookmarks stay in place.</p>
    <label>Bookmark HTML <input type="file" accept=".html,.htm,text/html" aria-describedby="import-file-help" disabled={busy || !native} onchange={readImport} /></label>
    <p id="import-file-help">Choose an HTML export from Firefox, Mullvad, Chrome or Edge. Up to 4 MB and 1,000 links.</p>
    {#if importName}<p class="filename">{importName}</p>{/if}
    {#if items.length || rejected}
      <p>{items.length} eligible bookmarks; {rejected} unsupported or oversized entries skipped.</p>
      {#if !items.length}<p>No supported bookmarks to import. Choose a file with http:// or https:// links.</p>{:else}
        <label>Open with <select bind:value={browserId} disabled={busy} onchange={invalidate}>{#each browsers as browser}<option value={browser.id}>{browser.name}</option>{/each}</select></label>
        <label>Default group <select bind:value={groupId} disabled={busy} onchange={invalidate}><option value="">Ungrouped</option>{#each groups as group}<option value={group.id}>{group.name}</option>{/each}</select></label>
        <label class="check"><input type="checkbox" bind:checked={folders} disabled={busy} onchange={invalidate} /> Use folder names as groups</label>
        <details><summary>How folders and duplicates are handled</summary><p>Each bookmark uses its nearest folder name, or the default group when it has no folder. Matching group names are reused. Bookmarks already saved with the same URL, browser and group are skipped unless they have custom profile, container or private-window options.</p></details>
        {#if summary}
          <p class="import-summary" role="status">{plural(summary.added, 'new bookmark')}, {plural(summary.duplicates, 'duplicate')}, {plural(summary.groups_added, 'new group')}.</p>
          {#if !summary.added}<p>Everything is already in your library. No changes needed.</p>{/if}
        {/if}
        <div class="actions">
          <button class="secondary" disabled={busy} onclick={previewImport}>{active === 'Checking duplicates and groups…' ? 'Checking…' : 'Check import'}</button>
          {#if summary}<button class="primary" disabled={busy || !summary.added} onclick={commitImport}>{active === 'Importing bookmarks…' ? 'Importing…' : 'Import bookmarks'}</button>{/if}
        </div>
        {#if !summary}<p>Check the import to review duplicates before adding anything.</p>{/if}
        <details><summary>Preview bookmarks · {items.length}</summary>
          <ul class="preview" aria-label="Import preview">{#each items.slice(0, 100) as item}<li><strong>{item.title}</strong><small>{item.url}</small>{#if folders && item.folder}<small>Group: {item.folder}</small>{/if}</li>{/each}</ul>
          {#if items.length > 100}<p>Showing the first 100 of {items.length} bookmarks.</p>{/if}
        </details>
      {/if}
    {/if}
  </section>
  <section aria-labelledby="library-backup" class="library-card">
    <h2 id="library-backup">Back up your library</h2>
    <p>Save public bookmarks and groups, plus your encrypted vault if one exists, to your Downloads folder.</p>
    <p><strong>Public bookmarks are readable in the backup. Only the vault stays encrypted</strong> and needs its original passphrase.</p>
    <details><summary>What stays on this computer?</summary><p>Browser paths, app settings, routing rules and pairing credentials are excluded. Reconnect your browsers separately on another computer.</p></details>
    <button class="secondary" disabled={busy || !native} onclick={saveBackup}>{active === 'Saving your backup…' ? 'Saving backup…' : 'Save library backup'}</button>
    {#if savedBackup}<p class="filename">Last saved backup: {savedBackup}</p><button class="secondary" disabled={busy} onclick={showBackup}>Show in folder</button>{/if}
  </section>
  <section aria-labelledby="library-restore" class="library-card">
    <h2 id="library-restore">Restore a backup</h2>
    <p>Restore replaces your public library. Import browser bookmarks above if you want to add to it.</p>
    <label>Restore backup <input type="file" accept=".json,application/json" aria-describedby="restore-file-help" disabled={busy || !native} onchange={readBackup} /></label>
    <p id="restore-file-help">Choose a BrowserDock JSON backup, up to 12 MB. Choosing a file only previews it.</p>
    {#if backup}
      <p class="filename">{backupName}</p>
      <p>{backup.bookmarks} public bookmarks, {backup.groups} public groups. {backup.has_vault ? 'Contains an encrypted vault; its contents are verified when unlocked.' : 'No vault included.'}</p>
      {#if backup.has_vault}<label class="check"><input type="checkbox" bind:checked={restoreVault} disabled={busy} onchange={() => confirmed = false} /> Also replace the encrypted vault</label>{/if}
      <div class="restore-impact">
        <strong>{publicCount} current public bookmarks → {backup.bookmarks} backup bookmarks</strong>
        <p>{restoreVault ? 'Your current vault will be replaced. Unlock the restored vault with the backup’s original passphrase.' : 'Your current vault will be kept.'} Restoring locks the vault.</p>
        <p>Recovery copies of the current files are kept on this computer.</p>
      </div>
      <label class="check"><input type="checkbox" bind:checked={confirmed} disabled={busy} /> Replace my public library{restoreVault ? ' and vault' : ''}; keep recovery copies of the current files</label>
      <button class="secondary restore-button" disabled={busy || !confirmed} onclick={restore}>{active === 'Restoring your library…' ? 'Restoring…' : 'Restore library'}</button>
    {/if}
  </section>
</div>
<style>
  .portable {display:grid;gap:12px;min-width:0;font-size:12px;color:var(--text);}
  .library-card {display:grid;gap:10px;min-width:0;border:1px solid #ffffff17;border-radius:10px;padding:12px;}
  h2 {font-size:13px;font-weight:600;margin:0;} p {font-size:11px;color:var(--muted);line-height:1.55;margin:0;overflow-wrap:anywhere;}
  p strong,.restore-impact strong {color:var(--text);font-weight:500;} .intro {font-size:12px;}
  label {display:grid;gap:6px;} .check {display:flex;align-items:flex-start;gap:8px;line-height:1.5;}
  .check input {flex-shrink:0;margin-top:3px;accent-color:var(--accent);}
  input,select {max-width:100%;min-width:0;} input[type=file] {font-size:11px;padding:8px;}
  input::file-selector-button {border:1px solid #ffffff20;border-radius:5px;background:var(--accent-alpha-12);color:var(--text);padding:6px;margin-right:7px;font:inherit;cursor:pointer;}
  details {font-size:11px;color:var(--muted);line-height:1.5;min-width:0;} summary {cursor:pointer;color:var(--text);padding:4px 0;} details p {margin-top:6px;}
  .preview {max-height:180px;overflow:auto;padding-left:17px;margin:6px 0;}
  li {margin:7px 0;overflow-wrap:anywhere;} li small {display:block;color:var(--muted);}
  button {justify-self:start;font-size:11px;} .actions {display:flex;flex-wrap:wrap;gap:7px;}
  .feedback {padding:10px;border:1px solid var(--accent-alpha-33);border-radius:8px;display:grid;gap:6px;scroll-margin-top:84px;scroll-margin-bottom:10px;}
  .feedback:focus {outline:2px solid var(--accent);outline-offset:2px;} .feedback .error {color:#f0b0a4;} .feedback .notice,.import-summary {color:var(--accent);}
  .filename {color:var(--text);overflow-wrap:anywhere;}
  .restore-impact {border-left:2px solid var(--accent);padding:4px 0 4px 9px;display:grid;gap:6px;font-size:11px;}
  .restore-button {color:#f0b0a4;border-color:#f0b0a450;}
</style>
