import test from 'node:test';
import assert from 'node:assert/strict';
import { launchPreview } from '../src/lib/features/bookmarks/launch-preview.js';

const browsers = [{ id: 'firefox', name: 'Firefox', exe_path: 'firefox.exe' }, { id: 'chrome', name: 'Chrome', exe_path: 'chrome.exe' }];
const instances = [{ browser: 'firefox', tabs: [{ host: 'example.com' }] }];
const input = { details: { browser_id: 'firefox' }, url: 'https://example.com/page', browsers, instances, uncertain: false };
test('preview distinguishes reported site matches, unknown inventory and process launch', () => {
  assert.equal(launchPreview(input).text, 'Switch to existing Firefox tab');
  assert.equal(launchPreview({ ...input, url: 'https://other.test' }).text, 'Open or switch in Firefox');
  assert.equal(launchPreview({ ...input, instances: [] }).text, 'Open in Firefox');
  assert.equal(launchPreview({ ...input, uncertain: true }).text, 'Open or switch in Firefox');
});
test('profile and container hints never claim a match in the wrong context', () => {
  const profile = launchPreview({ ...input, details: { browser_id: 'chrome', profile: 'Work' }, instances: [{ browser: 'chrome', tabs: [{ host: 'example.com' }] }] });
  assert.equal(profile.text, 'Open or switch in Chrome · Work profile');
  assert.match(profile.note, /another profile/);
  assert.equal(launchPreview({ ...input, details: { browser_id: 'firefox', container: 'Work' } }).text, 'Open or switch in Firefox · Work container');
});
test('private window preview bypasses tab reuse even when the connection is uncertain', () => {
  assert.equal(launchPreview({ ...input, details: { browser_id: 'firefox', incognito: true }, uncertain: true }).text, 'Open private window in Firefox');
});
