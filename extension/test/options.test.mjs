import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function page(saved) {
  const ids = ['pairing-form', 'browser', 'token', 'port', 'include-private', 'status', 'disconnect', 'pairing-code', 'import-code', 'pairing-file', 'import-status', 'connection-status'];
  const nodes = Object.fromEntries(ids.map(id => [id, { value: '', checked: false, textContent: '', disabled: false, files: [], handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } }]));
  nodes['pairing-form'].reset = () => { for (const id of ['browser', 'token', 'port']) nodes[id].value = ''; nodes['include-private'].checked = false; };
  const writes = [];
  const storage = { async get() { return { pairing: saved }; }, async set(data) { writes.push(data); }, async remove(key) { writes.push({ removed: key }); } };
  const core = (await readFile(new URL('../src/protocol.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const code = await readFile(new URL('../src/options.js', import.meta.url), 'utf8');
  const readers = []; const polls = [];
  const runtime = { async sendMessage() { return { state: 'connected' }; } };
  class FileReader { constructor() { readers.push(this); } readAsText() {} }
  const ctx = vm.createContext({ TextEncoder, TextDecoder, URL, FileReader, setInterval(fn) { polls.push(fn); }, document: { getElementById: id => nodes[id] }, browser: { runtime, storage: { local: storage } } });
  new vm.Script(core + '\n' + code).runInContext(ctx);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { nodes, writes, storage, readers, polls, runtime, async submit() { await nodes['pairing-form'].handlers.submit({ preventDefault() {} }); } };
}
const token = '7d8bab34-411a-48ee-ae6c-8b1b1b110951';
test('pairing page persists only explicit validated local connection settings', async () => {
  const p = await page(); p.nodes.browser.value = 'edge'; p.nodes.token.value = token; p.nodes.port.value = '49301';
  await p.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(p.writes)), [{ pairing: { browser: 'edge', token, port: 49301, includePrivate: false } }]);
  assert.ok(p.nodes.status.textContent.includes('saved'));
});
test('pairing page rejects invalid values without persisting and forget clears fields', async () => {
  const p = await page({ browser: 'firefox', token, port: 49301 });
  assert.equal(p.nodes.token.value, token);
  p.nodes.token.value = 'bad'; await p.submit(); assert.equal(p.writes.length, 0);
  await p.nodes.disconnect.handlers.click();
  assert.deepEqual(JSON.parse(JSON.stringify(p.writes)), [{ removed: 'pairing' }]);
  assert.equal(p.nodes.token.value, ''); assert.equal(p.nodes.port.value, '');
});
test('one-click import fills the form from a pairing code', async () => {
  const p = await page();
  const raw = new TextEncoder().encode(JSON.stringify({ browser: 'firefox', token, port: 49222, includePrivate: false }));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  const code = `BD1.${Buffer.from(binary, 'binary').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
  p.nodes['pairing-code'].value = code;
  await p.nodes['import-code'].handlers.click();
  assert.equal(p.nodes.browser.value, 'firefox');
  assert.equal(p.nodes.token.value, token);
  assert.equal(p.nodes.port.value, 49222);
  assert.ok(p.nodes['import-status'].textContent.includes('Imported'));
});
test('storage failure does not falsely report pairing saved', async () => {
  const p = await page(); p.nodes.browser.value = 'chrome'; p.nodes.token.value = token; p.nodes.port.value = '49301';
  p.storage.set = async () => { throw new Error('storage unavailable'); };
  await p.submit(); assert.ok(p.nodes.status.textContent.includes('Could not save')); assert.equal(p.nodes.disconnect.disabled, false);
});
test('private-tab opt-in is loaded, saved explicitly and cleared by forgetting pairing', async () => {
  const p = await page({ browser: 'mullvad', token, port: 49301, includePrivate: true });
  assert.equal(p.nodes['include-private'].checked, true);
  await p.submit(); assert.equal(p.writes[0].pairing.includePrivate, true);
  await p.nodes.disconnect.handlers.click(); assert.equal(p.nodes['include-private'].checked, false);
});

test('oversized file imports are rejected before reading', async () => {
  const p = await page(); p.nodes['pairing-file'].files = [{ size: 16385 }];
  p.nodes['pairing-file'].handlers.change();
  assert.equal(p.readers.length, 0);
  assert.match(p.nodes['import-status'].textContent, /too large/i);
});

test('late file import cannot overwrite user edits or forgotten pairing', async () => {
  for (const action of ['edit', 'forget']) {
    const p = await page(); p.nodes['pairing-file'].files = [{ size: 100 }];
    p.nodes['pairing-file'].handlers.change();
    if (action === 'edit') { p.nodes.browser.value = 'chrome'; p.nodes['pairing-form'].handlers.input(); }
    else await p.nodes.disconnect.handlers.click();
    p.readers[0].result = JSON.stringify({ browser: 'firefox', token, port: 49222 });
    p.readers[0].onload();
    assert.equal(p.nodes.browser.value, action === 'edit' ? 'chrome' : '');
  }
});

test('connection feedback follows actual companion state without exposing credentials', async () => {
  const p = await page();
  assert.match(p.nodes['connection-status'].textContent, /Connected/);
  p.runtime.sendMessage = async () => ({ state: 'disconnected' });
  await p.polls[0]();
  assert.match(p.nodes['connection-status'].textContent, /Disconnected/);
  p.runtime.sendMessage = async () => { throw Error('unavailable'); };
  await p.polls[0]();
  assert.match(p.nodes['connection-status'].textContent, /unavailable/i);
});
