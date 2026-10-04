// Rendered popup layout with mocked extension messaging; no desktop is required.
// Firefox's native toolbar sizing and Windows DPI still need manual acceptance.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1, height: 600 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    window.captureTest = { calls: [], resolve: null };
    window.browser = { runtime: {
      sendMessage(message) {
        window.captureTest.calls.push(message);
        if (message.type === 'BROWSERDOCK_QUICK_STATUS') return Promise.resolve({blocked:false});
        return new Promise(resolve => { window.captureTest.resolve = resolve; });
      },
      async openOptionsPage() {}
    } };
  });
  await page.goto(new URL('../src/capture.html', import.meta.url).href);
  // A popup must advertise its width even before Firefox gives it a viewport
  // and before the background replies. A viewport cap creates a sizing loop.
  assert.equal(await page.locator('body').evaluate(body => body.getBoundingClientRect().width), 360);
  assert.equal(await page.locator('#save').isDisabled(), true);
  await page.setViewportSize({ width: 360, height: 600 });
  const checkLayout = async () => {
    const layout = await page.evaluate(() => ({
      width: document.body.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.body.getBoundingClientRect().height
    }));
    assert.equal(layout.width, 360);
    assert.equal(layout.scrollWidth, 360, 'popup should have no horizontal overflow');
    assert.ok(layout.height <= 600, `popup height ${layout.height} exceeds the toolbar limit`);
  };
  await checkLayout();
  await page.evaluate(() => window.captureTest.resolve({ ok: true, payload: {
    contextId: 'test-context', tabId: 1, browser: 'firefox',
    title: 'A long page title '.repeat(30), url: `https://example.com/${'a'.repeat(500)}`,
    groups: [{ id: 'work', name: 'A long group name '.repeat(30) }]
  } }));
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  await checkLayout();
  await page.locator('#refresh').click();
  await page.evaluate(() => window.captureTest.resolve({ ok: false, error: 'Cannot connect to BrowserDock. Check connection settings.' }));
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Cannot connect'));
  await checkLayout();
  assert.equal(await page.locator('#save').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('Capture popup layout passed: tiny initial viewport, delayed context, long fields and disconnected desktop.');
} finally { await browser.close(); }
