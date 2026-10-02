import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { compileModule } from 'svelte/compiler';

const sourceUrl = new URL('../src/lib/features/companion/controller.svelte.ts', import.meta.url);
const source = (await readFile(sourceUrl, 'utf8')).replace("import { invokeCommand, type CompanionDigest } from '../../platform/tauri/commands';", 'const invokeCommand = (...args: any[]) => globalThis.__companionTestInvoke(...args);');
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const compiled = compileModule(javascript, { filename: sourceUrl.pathname, generate: 'client' }).js.code.replace(/from (['"])([^'"]+)\1/g, (_all, _quote, specifier) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
const { CompanionController } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const status = host => ({ error: null, instances: [{ instance_id: 'test', browser: 'firefox', tabs: [{ host }] }] });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('unchanged polls preserve inventory and reconnecting array identity', () => {
  const c = new CompanionController(); c.applyDigest(status('example.com'));
  const instances = c.instances, reconnecting = c.reconnecting;
  c.applyDigest(status('example.com'));
  assert.equal(c.instances, instances); assert.equal(c.reconnecting, reconnecting);
  c.applyDigest({ instances: [], error: null });
  assert.deepEqual([...c.reconnecting], ['firefox']);
  const waiting = c.reconnecting;
  c.applyDigest({ instances: [], error: null });
  assert.equal(c.reconnecting, waiting);
});
test('an older digest reply cannot overwrite a newer refresh', async () => {
  const c = new CompanionController(), old = deferred(), fresh = deferred(); let calls = 0;
  globalThis.__companionTestInvoke = () => ++calls === 1 ? old.promise : fresh.promise;
  const first = c.refresh(), second = c.refresh();
  fresh.resolve(status('new.example')); await second;
  old.resolve(status('old.example')); await first;
  assert.equal(c.instances[0].tabs[0].host, 'new.example');
});
test('polling skips hidden work and does not apply a reply after hiding', async () => {
  const original = globalThis.setInterval, clear = globalThis.clearInterval;
  let poll, visible = true, calls = 0;
  globalThis.setInterval = fn => { poll = fn; return 1; };
  globalThis.clearInterval = () => {};
  try {
    const c = new CompanionController(), vault = deferred(), digest = deferred();
    globalThis.__companionTestInvoke = () => { calls++; return digest.promise; };
    const stop = c.startPolling(() => visible, () => vault.promise);
    const first = poll(); visible = false; vault.resolve(); await first;
    assert.equal(calls, 0, 'skip IPC after a slow vault refresh finishes while hidden');
    visible = true; const second = poll();
    assert.equal(calls, 1);
    visible = false; digest.resolve(status('hidden.example')); await second;
    assert.equal(c.instances.length, 0);
    stop();
  } finally { globalThis.setInterval = original; globalThis.clearInterval = clear; }
});
