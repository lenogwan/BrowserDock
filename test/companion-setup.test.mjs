import test from 'node:test';
import assert from 'node:assert/strict';
import { setupBrowsers, excludedSetupBrowsers } from '../src/lib/features/companion/setup.js';

test('setup includes installed, connected and recovering known browsers only', () => {
  const browsers = [{ id: 'firefox', exe_path: 'firefox.exe' }, { id: 'chrome', exe_path: '' }, { id: 'custom', exe_path: 'custom.exe' }];
  assert.deepEqual(setupBrowsers(browsers, [], []).map(browser => browser.id), ['firefox']);
  assert.deepEqual(setupBrowsers(browsers, [{ browser: 'chrome' }], ['edge']).map(browser => browser.id), ['firefox', 'chrome', 'edge']);
});
test('setup preferences tolerate unavailable or malformed storage and exclude unknown values', () => {
  for (const raw of [null, '{', '{}', 'null']) assert.deepEqual(excludedSetupBrowsers(raw), []);
  assert.deepEqual(excludedSetupBrowsers('["chrome", "custom", 5]'), ['chrome']);
});
