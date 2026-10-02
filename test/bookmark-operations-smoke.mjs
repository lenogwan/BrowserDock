// Real Svelte/Chromium layout and clone flows; desktop IPC is mocked.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 560 } });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
const artifacts = process.env.BROWSERDOCK_BOOKMARK_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });
await page.addInitScript(() => {
  window.isTauri = true;
  const callbacks = new Map(), listeners = new Map(); let next = 0;
  const make = id => ({ id, title: id, url: `https://example.com/${id}`, target_browser: 'firefox', tags: ['work'], icon: '', group_id: 'work', sort_order: 0, browser_options: { container: 'Work', incognito: false } });
  const publicItems = [make('Parent'), { ...make('Child'), parent_id: 'Parent' }, { ...make('Sibling'), sort_order: 8 }];
  const privateItems = [{ ...make('Secret'), browser_options: { container: 'Private context', incognito: true } }];
  const groups = [{ id: 'work', name: 'Work', color: '#b8edc9', sort_order: 0, collapsed: false }];
  const vault = { exists: true, locked: true, retry_after_seconds: 0 };
  window.testState = { calls: [], publicItems, privateItems, vault };
  window.emitTest = event => { for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, payload: null }); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } }, transformCallback(fn) { callbacks.set(++next, fn); return next; },
    async invoke(cmd, args = {}) {
      if (cmd !== 'vault_auth') window.testState.calls.push({ cmd, args });
      switch (cmd) {
        case 'plugin:event|listen': { const list = listeners.get(args.event) || []; list.push(args.handler); listeners.set(args.event, list); return args.handler; }
        case 'get_dock_data': return structuredClone({ bookmarks: publicItems, groups, browsers: [{ id: 'firefox', name: 'Firefox', exe_path: 'C:\\Firefox.exe', color: '#ff7139' }], settings: { theme: 'tokyo', window_size: { width: 400, height: null }, opacity: 1, always_on_top: true, hide_on_open: false, auto_hide: false, auto_tab_groups: true, vault_timeout_minutes: 5, global_shortcut: 'Ctrl+Shift+Space', panic_shortcut: 'Ctrl+Alt+L' }, warnings: [] });
        case 'vault_status': return { ...vault };
        case 'vault_auth': vault.locked = false; return;
        case 'vault_list': return structuredClone({ bookmarks: privateItems, groups });
        case 'vault_lock': vault.locked = true; window.emitTest('vault-locked'); return;
        case 'companion_tabs_digest': return { instances: [{ instance_id: 'ff', browser: 'firefox', tabs: [{ host: 'example.com', cookie_store_id: 'firefox-container-1' }], containers: [{ name: 'Work', cookie_store_id: 'firefox-container-1' }] }], error: null };
        case 'route_details': return { browser_id: 'firefox', container: args.bookmarkId === 'Secret' ? 'Private context' : 'Work' };
        case 'save_bookmark': {
          if (args.private && vault.locked) throw Error('Vault is locked');
          const items = args.private ? privateItems : publicItems;
          const index = items.findIndex(item => item.id === args.bookmark.id);
          const saved = structuredClone(args.bookmark);
          if (index < 0) items.push(saved); else items[index] = saved;
          return;
        }
        default: return;
      }
    },
  };
});
async function screenshot(name) { if (artifacts) await page.screenshot({ path: `${artifacts}/${name}.png` }); }
try {
  await page.goto('http://127.0.0.1:1420/');
  await page.getByRole('button', { name: 'Edit Parent', exact: true }).waitFor();
  await page.getByText('1 companion connected', { exact: true }).waitFor();
  await page.locator('#enter-preview').filter({ hasText: 'Switch to existing Firefox tab' }).waitFor();
  const geometry = await page.evaluate(() => ({ navBottom: document.querySelector('nav').getBoundingClientRect().bottom, listTop: document.querySelector('.results').getBoundingClientRect().top, footerTop: document.querySelector('footer').getBoundingClientRect().top }));
  console.log('Bookmark layout (400 × 560):', geometry);
  assert.ok(geometry.listTop - geometry.navBottom <= 44, 'bookmark list must begin directly after the compact toolbar');
  assert.equal(await page.locator('footer #enter-preview').count(), 1);
  for (const width of [280, 400, 800]) {
    await page.setViewportSize({ width, height: 560 });
    assert.equal(await page.locator('.bookmark-toolbar').evaluate(el => el.scrollWidth > el.clientWidth), false, `toolbar overflow at ${width}`);
    await screenshot(`bookmarks-${width}`);
  }
  await page.setViewportSize({ width: 400, height: 560 });
  await page.getByRole('button', { name: 'Edit Parent', exact: true }).click();
  for (const width of [280, 400, 800]) {
    await page.setViewportSize({ width, height: 560 });
    assert.equal(await page.locator('.panel-content').evaluate(el => el.scrollWidth > el.clientWidth), false, `editor overflow at ${width}`);
    await screenshot(`editor-${width}`);
  }
  await page.setViewportSize({ width: 400, height: 560 });
  await page.getByLabel('Title', { exact: true }).fill('Prepared copy');
  await page.getByLabel('URL', { exact: true }).fill('https://example.com/new');
  await page.getByRole('button', { name: 'Clone bookmark', exact: true }).click();
  await page.getByRole('heading', { name: 'New bookmark', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Prepared copy');
  assert.equal(await page.getByLabel('URL', { exact: true }).inputValue(), 'https://example.com/new');
  assert.equal(await page.getByLabel('Group', { exact: true }).inputValue(), 'work');
  assert.equal(await page.getByLabel('Container', { exact: true }).inputValue(), 'Work');
  assert.equal(await page.getByRole('button', { name: 'Delete bookmark', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Title', { exact: true }).evaluate(el => document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length), true);
  assert.equal(await page.evaluate(() => window.testState.calls.filter(call => call.cmd === 'save_bookmark').length), 0, 'cloning only creates a draft');
  await screenshot('clone-400');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.testState.publicItems.length), 3, 'cancelling must not create a bookmark');
  await page.getByRole('button', { name: 'Edit Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Clone bookmark', exact: true }).click();
  await page.getByRole('heading', { name: 'New bookmark', exact: true }).waitFor();
  await page.getByLabel('Title', { exact: true }).fill('Saved copy');
  await page.getByRole('button', { name: 'Save bookmark', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Saved copy', exact: true }).waitFor();
  const items = await page.evaluate(() => window.testState.publicItems);
  assert.equal(items.length, 4);
  assert.equal(items.find(item => item.id === 'Parent').title, 'Parent');
  const copy = items.find(item => item.title === 'Saved copy');
  assert.notEqual(copy.id, 'Parent'); assert.equal(copy.sort_order, 9);
  assert.equal(items.filter(item => item.parent_id === copy.id).length, 0, 'clone must not copy a subtree');
  // Child copies keep their parent and normal inheritance controls.
  await page.getByRole('button', { name: 'Expand or collapse Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Child', exact: true }).click();
  await page.getByRole('button', { name: 'Clone bookmark', exact: true }).click();
  await page.getByRole('heading', { name: 'New bookmark', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Parent');
  assert.equal(await page.getByRole('combobox', { name: /^Open with/ }).isDisabled(), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Private copies remain private; lock removes an unsaved copy and its hints.
  await page.getByRole('button', { name: 'Vault', exact: true }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill('test-only-secret');
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Secret', exact: true }).click();
  await page.getByRole('button', { name: 'Clone bookmark', exact: true }).click();
  await page.getByRole('heading', { name: 'New bookmark', exact: true }).waitFor();
  await page.getByLabel('Title', { exact: true }).fill('Private copy');
  await page.getByRole('button', { name: 'Save bookmark', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Private copy', exact: true }).click();
  await page.getByRole('button', { name: 'Clone bookmark', exact: true }).click();
  await page.getByRole('heading', { name: 'New bookmark', exact: true }).waitFor();
  const privateSaved = await page.evaluate(() => window.testState.calls.filter(call => call.cmd === 'save_bookmark' && call.args.private).at(-1).args.bookmark);
  assert.equal(privateSaved.private, true); assert.equal(privateSaved.browser_options.container, 'Private context'); assert.equal(privateSaved.browser_options.incognito, true);
  await page.getByRole('button', { name: 'Lock vault', exact: true }).click();
  await page.getByRole('heading', { name: 'New bookmark', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('heading', { name: 'New bookmark', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Container', { exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator('main').innerText(), /Private copy|Private context/);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('Private context') || JSON.stringify(localStorage).includes('Private copy')), false);
  assert.deepEqual(errors, []);
  console.log('Compact bookmark toolbar and public/private clone smoke passed.');
} catch (error) {
  await screenshot('failure');
  console.error(await page.locator('main').innerText());
  console.error(errors);
  console.error(await page.evaluate(() => window.testState.calls.filter(call => call.cmd === 'save_bookmark')));
  throw error;
} finally { await browser.close(); }
