// Rendered organization/import/backup flows; desktop IPC is mocked. Run against npm run dev.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 700 }, acceptDownloads: true });
const errors = [], remote = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:1420') && !request.url().startsWith('data:')) remote.push(request.url()); });
await page.addInitScript(() => {
  window.isTauri = true;
  const callbacks = new Map(), listeners = new Map(); let next = 0;
  const make = id => ({ id, title: id, url: `https://example.com/${id}`, target_browser: 'firefox', tags: [], icon: '' });
  const publicItems = [make('Parent'), { ...make('Child'), parent_id: 'Parent' }, make('Other')];
  const privateItems = [make('Secret')], groups = [{ id: 'work', name: 'Work', sort_order: 0, color: '', collapsed: false }];
  const vault = { exists: true, locked: true, retry_after_seconds: 0 };
  const history = { public: null, private: null };
  window.testState = { calls: [], failMove: false, holdMove: false, pendingMove: null, publicItems, privateItems };
  window.emitTest = event => { for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, payload: null }); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } }, transformCallback(fn) { callbacks.set(++next, fn); return next; },
    async invoke(cmd, args = {}) {
      if (cmd !== 'vault_auth') window.testState.calls.push({ cmd, args });
      const items = args.private ? privateItems : publicItems, scope = args.private ? 'private' : 'public';
      switch (cmd) {
        case 'plugin:event|listen': { const list = listeners.get(args.event) || []; list.push(args.handler); listeners.set(args.event, list); return args.handler; }
        case 'get_dock_data': return structuredClone({ bookmarks: publicItems, groups, browsers: [{ id: 'firefox', name: 'Firefox', exe_path: 'C:\\Firefox.exe', color: '#ff7139' }], settings: { theme: 'sage', window_size: { width: 400, height: null }, opacity: 1, always_on_top: true, hide_on_open: false, auto_hide: false, auto_tab_groups: true, vault_timeout_minutes: 5, global_shortcut: 'Ctrl+Shift+Space', panic_shortcut: 'Ctrl+Alt+L' }, warnings: [] });
        case 'vault_status': return { ...vault };
        case 'vault_auth': vault.locked = false; return;
        case 'vault_list': return structuredClone({ bookmarks: privateItems, groups });
        case 'vault_lock': vault.locked = true; history.private = null; window.emitTest('vault-locked'); return;
        case 'companion_tabs_digest': return { instances: [], error: null };
        case 'route_details': return { browser_id: 'firefox' };
        case 'delete_bookmark': history[scope] = structuredClone(items); items.splice(items.findIndex(b => b.id === args.id), 1); return;
        case 'move_bookmarks': {
          if (window.testState.failMove) throw Error('Move rejected');
          history[scope] = structuredClone(items);
          for (const item of items) if (args.ids.includes(item.id) || args.ids.includes(item.parent_id)) { item.group_id = args.groupId; if (args.ids.includes(item.id) && !args.ids.includes(item.parent_id)) item.parent_id = null; }
          if (window.testState.holdMove) return new Promise(resolve => { window.testState.pendingMove = resolve; });
          return;
        }
        case 'undo_organization': { if (!history[scope]) throw Error('Nothing to undo'); items.splice(0, items.length, ...history[scope]); history[scope] = null; return; }
        case 'import_bookmarks': {
          if (!args.preview) publicItems.push({ ...make('Imported'), title: args.items[0].title, url: args.items[0].url });
          return { added: 1, duplicates: 1, groups_added: 1 };
        }
        case 'backup_export': return JSON.stringify({ format: 'BrowserDock library', version: 1, bookmarks: publicItems, groups, vault_hex: 'ab'.repeat(44) });
        case 'backup_preview': { const data = JSON.parse(args.text); return { bookmarks: data.bookmarks.length, groups: data.groups.length, has_vault: !!data.vault_hex }; }
        case 'backup_restore': vault.locked = true; history.private = null; window.emitTest('vault-locked'); return 'C:\\BrowserDock\\restore-backup-test';
        default: return;
      }
    },
  };
});
try {
  await page.goto('http://127.0.0.1:1420/');
  await page.getByRole('button', { name: 'Select bookmarks', exact: true }).click();
  await page.getByLabel('Select Parent', { exact: true }).check();
  await page.getByLabel('Select Other', { exact: true }).check();
  await page.getByLabel('Move selected bookmarks to group').selectOption('work');
  await page.getByRole('button', { name: 'Move selected', exact: true }).click();
  await page.getByRole('button', { name: 'Undo public action' }).waitFor();
  const call = await page.evaluate(() => window.testState.calls.find(c => c.cmd === 'move_bookmarks'));
  assert.deepEqual(call.args, { ids: ['Parent', 'Other'], groupId: 'work', private: false });
  await page.getByRole('button', { name: 'Undo public action' }).click();
  assert.equal(await page.evaluate(() => window.testState.publicItems[0].group_id), undefined);
  await page.getByRole('button', { name: 'Edit Other', exact: true }).click();
  await page.getByRole('button', { name: 'Delete bookmark', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await page.getByRole('button', { name: 'Undo public action' }).click();
  await page.getByRole('button', { name: 'Edit Other', exact: true }).waitFor();
  // Failed move retains selection and exposes the error without optimistic data loss.
  await page.getByRole('button', { name: 'Select bookmarks', exact: true }).click();
  await page.getByLabel('Select Other', { exact: true }).check();
  await page.evaluate(() => window.testState.failMove = true);
  await page.getByRole('button', { name: 'Move selected', exact: true }).click();
  await page.getByText('Error: Move rejected', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Select Other', { exact: true }).isChecked(), true);
  await page.evaluate(() => window.testState.failMove = false);
  await page.getByRole('button', { name: 'Cancel selection' }).click();
  // A lock during an in-flight private move must not restore undo or selection.
  await page.getByRole('button', { name: 'Vault', exact: true }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill('test secret');
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  await page.getByRole('button', { name: 'Select bookmarks', exact: true }).click();
  await page.getByLabel('Select Secret', { exact: true }).check();
  await page.evaluate(() => window.testState.holdMove = true);
  await page.getByRole('button', { name: 'Move selected', exact: true }).click();
  await page.waitForFunction(() => window.testState.pendingMove);
  await page.getByRole('button', { name: 'Lock vault', exact: true }).click();
  await page.evaluate(() => { window.testState.pendingMove(); window.testState.holdMove = false; });
  assert.equal(await page.getByRole('button', { name: 'Undo private action' }).count(), 0);
  assert.equal(await page.getByLabel('Select Secret', { exact: true }).count(), 0);
  // Inert HTML parsing must not execute scripts or fetch embedded resources.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Work</H3><DL><p><DT><A HREF="https://example.com/">Example</A><DT><A HREF="https://example.com/">Duplicate</A><DT><A HREF="javascript:alert(1)">Unsafe</A></DL><p></DL><img src="https://remote.invalid/image"><script>window.importExecuted=true</script>';
  await page.getByLabel('Bookmark HTML', { exact: true }).setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await page.getByText('2 eligible bookmarks; 1 unsupported or oversized entries skipped.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.importExecuted), undefined);
  await page.getByRole('button', { name: 'Check import', exact: true }).click();
  await page.getByText('1 new bookmark, 1 duplicate, 1 new group.', { exact: true }).waitFor();
  const imported = await page.evaluate(() => window.testState.calls.find(c => c.cmd === 'import_bookmarks'));
  assert.equal(imported.args.items[0].folder, 'Work');
  await page.getByRole('button', { name: 'Import bookmarks', exact: true }).click();
  await page.getByText('Imported 1 bookmark; skipped 1 duplicate.', { exact: true }).waitFor();
  const downloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download library backup', exact: true }).click();
  assert.match((await downloadWait).suggestedFilename(), /^browserdock-library-.*\.json$/);
  const archive = { format: 'BrowserDock library', version: 1, bookmarks: [], groups: [], vault_hex: 'ab'.repeat(44) };
  await page.getByLabel('Restore backup', { exact: true }).setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await page.getByLabel('Also replace the encrypted vault').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Restore library', exact: true }).isDisabled(), true);
  await page.getByLabel('Also replace the encrypted vault').check();
  await page.getByLabel('Replace my public library and vault; keep recovery copies of the current files', { exact: true }).check();
  for (const width of [280, 400, 800]) {
    await page.setViewportSize({ width, height: 700 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflow, false, `page overflow at ${width}px`);
    assert.equal(await page.locator('.settings-view').evaluate(el => el.scrollWidth > el.clientWidth), false, `library overflow at ${width}px`);
  }
  await page.getByRole('button', { name: 'Restore library', exact: true }).click();
  await page.getByText('Library restored.', { exact: false }).waitFor();
  assert.equal((await page.evaluate(() => window.testState.calls.find(c => c.cmd === 'backup_restore'))).args.restoreVault, true);
  assert.deepEqual(remote, []); assert.deepEqual(errors, []);
  console.log('Organization and portable library smoke passed (mocked desktop IPC).');
} finally { await browser.close(); }
