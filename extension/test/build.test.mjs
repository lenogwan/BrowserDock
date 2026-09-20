import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { build } from '../build.mjs';

test('build produces complete distinct local-only Chromium and Gecko distributions', async () => {
  const output = await mkdtemp(join(tmpdir(), 'browserdock-extension-'));
  await build(output);
  for (const browser of ['chromium', 'gecko']) {
    const dir = join(output, browser);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, browser === 'gecko' ? ['tabs', 'storage', 'alarms', 'tabGroups', 'contextualIdentities', 'cookies'] : ['tabs', 'storage', 'alarms', 'tabGroups']);
    assert.equal(manifest.incognito, 'spanning');
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
    assert.ok(manifest.content_security_policy.extension_pages.includes('connect-src ws://127.0.0.1:*'));
    if (browser === 'chromium') {
      assert.equal(manifest.background.service_worker, 'background.js'); assert.equal(manifest.background.scripts, undefined);
      assert.equal(manifest.minimum_chrome_version, '116');
    } else {
      assert.deepEqual(manifest.background.scripts, ['background.js']); assert.equal(manifest.background.service_worker, undefined);
      assert.ok(manifest.browser_specific_settings.gecko.id);
      assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions, { required: ['browsingActivity'] });
    }
    const html = await readFile(join(dir, manifest.options_ui.page), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(!match[1].includes('://')); await readFile(join(dir, match[1]));
    }
    new vm.Script(await readFile(join(dir, 'background.js'), 'utf8'));
    new vm.Script(await readFile(join(dir, 'options.js'), 'utf8'));
  }
});
