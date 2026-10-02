// Review regressions for keyboard, selection, import, restore and narrow layouts. Desktop IPC is mocked.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 700 }, acceptDownloads: true });
const errors = [], remote = [];
const artifacts = process.env.BROWSERDOCK_UX_ARTIFACTS;
if (artifacts) await (await import('node:fs/promises')).mkdir(artifacts, { recursive: true });
async function screenshot(name) { if (artifacts) await page.screenshot({ path: `${artifacts}/${name}.png` }); }
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
        case 'get_dock_data': if (window.testState.failRefresh) throw Error('Dock refresh unavailable'); return structuredClone({ bookmarks: publicItems, groups, browsers: [{ id: 'firefox', name: 'Firefox', exe_path: 'C:\\Firefox.exe', color: '#ff7139' }], settings: { theme: 'sage', window_size: { width: 400, height: null }, opacity: 1, always_on_top: true, hide_on_open: false, auto_hide: false, auto_tab_groups: true, vault_timeout_minutes: 5, global_shortcut: 'Ctrl+Shift+Space', panic_shortcut: 'Ctrl+Alt+L' }, warnings: [] });
        case 'vault_status': return { ...vault };
        case 'vault_auth': window.testState.authCount = (window.testState.authCount || 0) + 1; vault.locked = false; return;
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
        case 'pairing_install_companion': return { dir: 'C:\\BrowserDock\\companion', files: [] };
        case 'import_bookmarks': {
          if (window.testState.onlyDuplicates) return { added: 0, duplicates: args.items.length, groups_added: 0 };
          if (!args.preview) publicItems.push({ ...make('Imported'), title: args.items[0].title, url: args.items[0].url });
          return { added: 1, duplicates: 0, groups_added: 0 };
        }
        case 'backup_save': return 'C:\\Users\\Test\\Downloads\\browserdock-library-test.json';
        case 'backup_preview': { const data = JSON.parse(args.text); return { bookmarks: data.bookmarks.length, groups: data.groups.length, has_vault: !!data.vault_hex }; }
        case 'backup_restore': if (window.testState.failRestore) throw Error('Restore rejected before changes'); if (window.testState.holdRestore) await new Promise(resolve => window.testState.pendingRestore = resolve); vault.locked = true; history.private = null; window.emitTest('vault-locked'); return 'C:\\BrowserDock\\restore-backup-test';
        default: return;
      }
    },
  };
});
try {
  await page.goto('http://127.0.0.1:1420/');
  await page.getByRole('button', { name: 'Select bookmarks', exact: true }).click();
  await page.getByRole('button', { name: 'Select bookmark Parent', exact: true }).click();
  assert.equal(await page.getByLabel('Select Parent', { exact: true }).isChecked(), true);
  await page.getByText('1 selected · Public · 2 including sub-pages', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Deselect bookmark Parent', exact: true }).press('Enter');
  assert.equal(await page.getByLabel('Select Parent', { exact: true }).isChecked(), false);
  await page.getByRole('button', { name: 'Select bookmark Parent', exact: true }).press('Space');
  assert.equal(await page.getByLabel('Select Parent', { exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('button', { name: 'Open subtree Parent', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Edit Parent', exact: true }).count(), 0);
  const destination = page.getByLabel('Move selected bookmarks to group');
  await destination.focus();
  await destination.press('ArrowDown');
  assert.equal(await destination.evaluate(el => document.activeElement === el), true);
  assert.equal(await page.evaluate(() => window.testState.calls.filter(c => ['open_url', 'open_bookmark', 'open_group', 'open_subtree'].includes(c.cmd)).length), 0);
  await screenshot('selection-400');
  await destination.selectOption('work');
  await page.getByRole('button', { name: 'Move selected', exact: true }).click();
  await page.getByText('Moved 2 bookmarks to Work. Undo is available.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Undo public action', exact: true }).click();
  await page.getByText('Last public move or deletion undone.', { exact: true }).waitFor();

  // Editors begin at their first useful field, and destructive confirmation can be cancelled.
  await page.getByRole('button', { name: 'Edit Other', exact: true }).click();
  assert.equal(await page.getByLabel('Title', { exact: true }).evaluate(el => document.activeElement === el), true);
  await page.getByRole('button', { name: 'Delete bookmark', exact: true }).click();
  await page.getByRole('button', { name: 'Keep bookmark', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Confirm deletion', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add group', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).evaluate(el => document.activeElement === el), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Vault', exact: true }).click();
  assert.equal(await page.getByLabel('Passphrase', { exact: true }).evaluate(el => document.activeElement === el), true);
  await page.getByLabel('Passphrase', { exact: true }).fill('1234');
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Secret', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.testState.authCount), 1, 'legacy short secrets must reach the backend');
  await page.getByRole('button', { name: 'Lock vault', exact: true }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const width of [280,400,800]) {
    await page.setViewportSize({ width, height: 700 });
    assert.equal(await page.locator('[role=tab]').evaluateAll(tabs => tabs.some(t => t.scrollWidth > t.clientWidth)), false, `section names truncated at ${width}px`);
    await screenshot(`settings-${width}`);
  }
  const appearance = page.getByRole('tab', { name: 'Appearance', exact: true });
  await appearance.focus();
  await appearance.press('End');
  assert.equal(await page.getByRole('tab', { name: 'Library', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'Library', exact: true }).press('Home');
  assert.equal(await appearance.getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'Companion', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare companion folder', exact: true }).click();
  await page.getByRole('button', { name: 'Show companion folder', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Companion setup' }).getByText('C:\\BrowserDock\\companion', { exact: true }).isVisible(), true);

  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  const html = '<DL><DT><A HREF="https://example.com/new">New bookmark</A></DL>';
  const file = { name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) };
  await page.getByLabel('Bookmark HTML', { exact: true }).setInputFiles(file);
  await page.getByText('1 eligible bookmarks; 0 unsupported or oversized entries skipped.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check import', exact: true }).click();
  await page.getByRole('button', { name: 'Import bookmarks', exact: true }).waitFor();
  await page.getByLabel('Use folder names as groups', { exact: true }).uncheck();
  assert.equal(await page.getByRole('button', { name: 'Import bookmarks', exact: true }).count(), 0, 'changing options invalidates the checked preview');
  await page.evaluate(() => window.testState.onlyDuplicates = true);
  await page.getByRole('button', { name: 'Check import', exact: true }).click();
  await page.getByText('Everything is already in your library. No changes needed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Import bookmarks', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.testState.onlyDuplicates = false);
  await page.getByLabel('Bookmark HTML', { exact: true }).setInputFiles(file);
  assert.equal(await page.getByRole('button', { name: 'Import bookmarks', exact: true }).count(), 0, 'the same file can be reselected');

  await page.waitForFunction(() => !document.querySelector('input[accept=".json,application/json"]').disabled);
  const archive = { format: 'BrowserDock library', version: 1, bookmarks: [], groups: [], vault_hex: 'ab'.repeat(44) };
  await page.getByLabel('Restore backup', { exact: true }).setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await page.getByText('Your current vault will be kept. Restoring locks the vault.', { exact: true }).waitFor();
  await page.getByText('3 current public bookmarks → 0 backup bookmarks', { exact: true }).waitFor();
  const confirmation = page.getByLabel('Replace my public library; keep recovery copies of the current files', { exact: true });
  await confirmation.check();
  await page.getByLabel('Also replace the encrypted vault', { exact: true }).check();
  assert.equal(await page.getByRole('button', { name: 'Restore library', exact: true }).isDisabled(), true, 'changing vault scope requires renewed confirmation');
  await page.getByLabel('Also replace the encrypted vault', { exact: true }).uncheck();
  await confirmation.check();
  for (const width of [280,400,800]) {
    await page.setViewportSize({ width, height: 700 });
    assert.equal(await page.locator('.settings-view').evaluate(el => el.scrollWidth > el.clientWidth), false, `library overflow at ${width}px`);
    await page.getByRole('button', { name: 'Restore library', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.settings-view .tabs').evaluate(el => el.getBoundingClientRect().top >= el.closest('.panel-content').getBoundingClientRect().top - 1), true, 'settings navigation stays visible when scrolled');
    await screenshot(`restore-${width}`);
  }
  await page.evaluate(() => window.testState.failRestore = true);
  await page.getByRole('button', { name: 'Restore library', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Restore rejected before changes' }).waitFor();
  assert.equal(await page.locator('.feedback').evaluate(el => document.activeElement === el), true, 'failed operation feedback receives focus');
  assert.equal(await confirmation.isChecked(), true);
  await page.evaluate(() => { window.testState.failRestore = false; window.testState.holdRestore = true; });
  await page.getByRole('button', { name: 'Restore library', exact: true }).click();
  await page.waitForFunction(() => window.testState.pendingRestore);
  assert.equal(await page.getByRole('tab', { name: 'Appearance', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Collapse dock', exact: true }).isDisabled(), true);
  await page.getByRole('button', {name:'Open vault',exact:true}).click();
  await page.getByRole('button', { name: 'Restoring…', exact: true }).waitFor();
  await page.getByLabel('Search bookmarks or enter a URL').fill('/vault');
  await page.getByRole('button', { name: 'Restoring…', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.testState.calls.some(c => c.cmd === 'dock_escape')), true, 'Escape still reaches backend hide/panic handling during a library operation');
  await page.getByRole('button', { name: 'Restoring…', exact: true }).waitFor();
  await page.evaluate(() => window.emitTest('dock-summoned'));
  await page.getByRole('button', { name: 'Restoring…', exact: true }).waitFor();
  await page.evaluate(() => window.testState.pendingRestore());
  await page.getByText('Library restored.', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.testState.calls.filter(c => c.cmd === 'backup_restore').at(-1).args.restoreVault), false);
  assert.equal(await page.locator('.feedback').evaluate(el => document.activeElement === el), true);
  assert.equal(await page.getByRole('button', { name: 'Check import', exact: true }).count(), 0, 'restore clears a stale import draft');
  await page.setViewportSize({width:400,height:700});
  await screenshot('library-400');
  await page.getByLabel('Bookmark HTML', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Check import', exact: true }).click();
  await page.getByRole('button', { name: 'Import bookmarks', exact: true }).waitFor();
  await page.evaluate(() => window.testState.failRefresh = true);
  await page.getByRole('button', { name: 'Import bookmarks', exact: true }).click();
  await page.getByText('Imported 1 bookmark; skipped 0 duplicates.', { exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: 'Your library was saved, but the bookmark list could not refresh.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Import bookmarks', exact: true }).count(), 0, 'a committed import cannot be resubmitted after refresh failure');
  assert.equal(await page.locator('.feedback').evaluate(el => el.getBoundingClientRect().top >= document.querySelector('.settings-view .tabs').getBoundingClientRect().bottom - 1), true, 'sticky navigation must not obscure operation feedback');
  await screenshot('saved-refresh-error-400');
  assert.deepEqual(remote, []); assert.deepEqual(errors, []);
  console.log('UI/UX smoke passed: selection, keyboard/focus, legacy unlock, companion files, import and restore (mocked desktop IPC).');
} finally { await browser.close(); }
