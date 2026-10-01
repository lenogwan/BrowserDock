import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function popup(saveResponse) {
  const ids = ['capture-form', 'title', 'group', 'save', 'refresh', 'status', 'page-url', 'target', 'settings'];
  const nodes = Object.fromEntries(ids.map(id => [id, { value: '', textContent: '', disabled: false, handlers: {}, options: [], addEventListener(name, fn) { this.handlers[name] = fn; }, replaceChildren(...values) { this.options = values; }, add(value) { this.options.push(value); } }]));
  const calls = [];
  const runtime = { async sendMessage(message) { calls.push(message); return message.type === 'BROWSERDOCK_CAPTURE_CONTEXT' ? { ok: true, payload: { contextId: 'capture-context', tabId: 1, title: '<script>Example</script>', url: 'https://example.com/', browser: 'firefox', groups: [{ id: 'work', name: '<b>Work</b>' }] } } : typeof saveResponse === 'function' ? saveResponse() : saveResponse; }, async openOptionsPage() {} };
  function Option(text, value) { this.text = text; this.value = value; }
  new vm.Script(await readFile(new URL('../src/capture-popup.js', import.meta.url), 'utf8')).runInContext(vm.createContext({ Option, document: { getElementById: id => nodes[id] }, browser: { runtime } }));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { nodes, calls, async submit() { await nodes['capture-form'].handlers.submit({ preventDefault() {} }); } };
}
test('popup displays text safely, saves chosen group and disables repeat after success', async () => {
  const p = await popup({ ok: true, payload: { result: 'SAVED' } });
  assert.equal(p.nodes.title.value, '<script>Example</script>'); assert.equal(p.nodes.group.options[1].text, '<b>Work</b>');
  p.nodes.group.value = 'work'; await p.submit();
  assert.equal(p.calls[1].groupId, 'work'); assert.equal(p.calls[1].contextId, 'capture-context'); assert.equal(p.nodes.save.disabled, true); assert.match(p.nodes.status.textContent, /Saved/);
  await p.submit(); assert.equal(p.calls.length, 2);
});
test('duplicate capture reports unchanged and prevents repeat', async () => {
  const p = await popup({ ok: true, payload: { result: 'ALREADY_SAVED' } }); await p.submit();
  assert.match(p.nodes.status.textContent, /Nothing was changed/); assert.equal(p.nodes.save.disabled, true);
});
test('uncertain replies and every runtime rejection prevent retries', async () => {
  for (const response of [undefined, null, {}, { ok: 'false', error: 'Rejected' }, { ok: false }, { ok: false, error: '' }, { ok: false, error: 'Rejected', uncertain: 'true' }, { ok: false, uncertain: true, error: 'Save outcome unknown.' }, { ok: true, payload: {} }, () => { throw Error('background stopped'); }]) {
    const p = await popup(response); await p.submit();
    assert.equal(p.nodes.save.disabled, true); assert.equal(p.nodes.refresh.disabled, true); assert.match(p.nodes.status.textContent, /unknown/);
    await p.submit(); assert.equal(p.calls.length, 2);
  }
});
test('explicit validation rejection permits correcting the draft', async () => {
  const p = await popup({ ok: false, error: 'Choose an existing group.' }); await p.submit();
  assert.equal(p.nodes.save.disabled, false); assert.equal(p.nodes.refresh.disabled, false); assert.match(p.nodes.status.textContent, /existing group/);
});
