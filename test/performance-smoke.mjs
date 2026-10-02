// Manual rendered performance review; requires npm run dev and external Playwright.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 680 } });
const errors = []; page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(() => {
  window.isTauri = true;
  const callbacks = new Map(), listeners = new Map(); let next = 0;
  const groups = Array.from({ length: 20 }, (_, i) => ({ id: `g${i}`, name: `Group ${i}`, color: '#4285f4', sort_order: i, collapsed: false }));
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `b${i}`, title: `Bookmark ${String(i).padStart(4, '0')}`, url: `https://host${i}.example/`, target_browser: 'firefox', group_id: `g${Math.floor(i / 50)}`, tags: [], icon: '' }));
  const settings = { theme: 'dark', window_size: { width: 400, height: null }, always_on_top: true, auto_hide: false, hide_on_open: false, auto_tab_groups: true, opacity: 1, vault_timeout_minutes: 5, global_shortcut: 'Ctrl+Shift+Space', panic_shortcut: 'Ctrl+Alt+L' };
  window.perfTest = { badges: false, digestCalls: 0 };
  window.emitPerf = event => { for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, payload: null }); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } },
    transformCallback(fn) { callbacks.set(++next, fn); return next; },
    async invoke(cmd, args = {}) {
      switch (cmd) {
        case 'plugin:event|listen': { const ids = listeners.get(args.event) || []; ids.push(args.handler); listeners.set(args.event, ids); return args.handler; }
        case 'get_dock_data': return structuredClone({ bookmarks: items, groups, browsers: [{ id: 'firefox', name: 'Firefox', color: '#ff7139', exe_path: '' }], settings, warnings: [] });
        case 'vault_status': return { exists: false, locked: true, retry_after_seconds: 0 };
        case 'companion_tabs_digest': window.perfTest.digestCalls++; return { error: null, instances: [{ instance_id: 'test', browser: 'firefox', tabs: items.map((b, i) => ({ host: `host${i}.example`, ...(window.perfTest.badges ? { groupTitle: groups[Math.floor(i / 50)].name, groupColor: 'blue' } : {}) })) }] };
        case 'route_details': return { browser_id: 'firefox' };
        case 'route_url': return 'firefox';
        case 'browser_profiles': return [];
        default: return;
      }
    }
  };
});
const search = page.getByRole('textbox', { name: 'Search bookmarks or enter a URL' });
async function settledFrames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
try {
  await page.goto('http://127.0.0.1:1420/');
  await page.locator('.vlist').waitFor(); await settledFrames();
  const mounted = await page.locator('.result').count();
  assert.ok(mounted < 100, `mounted ${mounted} rows for 1000 bookmarks`);
  for (const position of [0.5, 1, 0.25, 0]) {
    await page.locator('.panel-content').evaluate((el, position) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * position; }, position);
    await settledFrames();
    assert.ok(await page.locator('.result').count() < 100);
  }
  await page.locator('.panel-content').evaluate(el => { el.scrollTop = el.scrollHeight; }); await settledFrames();
  await page.getByRole('button', { name: 'Open Bookmark 0999 in firefox', exact: true }).waitFor();
  await page.locator('.panel-content').evaluate(el => { el.scrollTop = 0; }); await settledFrames();
  await page.evaluate(() => { window.perfTest.badges = true; });
  await page.locator('.native-group').first().waitFor(); await settledFrames();
  // Check total extent after live badges change row heights. Group headers
  // have small margins, so allow their bounded layout rounding/offset.
  const list = await page.locator('.vlist').evaluate(el => {
    const rows = [...el.querySelectorAll('[data-vkey]')];
    const last = rows.at(-1);
    const bottomSpacer = last.nextElementSibling;
    return { total: el.getBoundingClientRect().height, actual: bottomSpacer ? bottomSpacer.offsetTop + bottomSpacer.offsetHeight : last.offsetTop + last.offsetHeight };
  });
  assert.ok(Math.abs(list.total - list.actual) <= 8, `virtual list drift: ${JSON.stringify(list)}`);
  const timings = [];
  for (const query of ['Bookmark 0999', 'host500', 'Bookmark 0500', 'Bookmark 0000']) {
    const start = performance.now(); await search.fill(query); await settledFrames();
    await page.locator('.result').first().waitFor(); timings.push(Math.round(performance.now() - start));
  }
  await search.fill(''); await settledFrames();
  await page.getByRole('button', { name: 'Select bookmarks', exact: true }).click(); await settledFrames();
  await page.getByRole('button', { name: 'Select bookmark Bookmark 0000', exact: true }).click();
  assert.ok(await page.locator('.result').count() < 100);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ bookmarks: 1000, mountedRows: mounted, searchInteractionMs: timings, virtualList: list }));
} finally { await browser.close(); }
