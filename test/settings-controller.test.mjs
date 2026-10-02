import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { compileModule } from 'svelte/compiler';
const sourceUrl = new URL('../src/lib/features/settings/controller.svelte.ts', import.meta.url);
const javascript = ts.transpileModule(await readFile(sourceUrl, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const compiled = compileModule(javascript, { filename: sourceUrl.pathname, generate: 'client' }).js.code.replace(/from (['"])([^'"]+)\1/g, (_all, _quote, specifier) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier === './themes' ? './themes.ts' : specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
const { SettingsController } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('shortcut dispatch uses actual Windows registrations after a failed activation and fresh loads', () => {
  const controller = new SettingsController();
  const desired = { ...controller.settings, global_shortcut: 'Ctrl+Alt+S', panic_shortcut: 'Ctrl+Alt+P' };
  controller.commit(desired, ['Ctrl+Shift+Space', 'Ctrl+Alt+L']);
  assert.deepEqual([...controller.activeWindowsShortcuts], ['Ctrl+Shift+Space', 'Ctrl+Alt+L']);
  assert.equal(controller.settings.global_shortcut, 'Ctrl+Alt+S');
  controller.load(desired, [null, 'Ctrl+Alt+L']);
  assert.deepEqual([...controller.activeWindowsShortcuts], ['Ctrl+Alt+L']);
  controller.commit(desired, ['Ctrl+Alt+S', 'Ctrl+Alt+P']);
  assert.deepEqual([...controller.activeWindowsShortcuts], ['Ctrl+Alt+S', 'Ctrl+Alt+P']);
  controller.load(desired); // Old/mocked IPC without actual-registration metadata.
  assert.deepEqual([...controller.activeWindowsShortcuts], ['Ctrl+Alt+S', 'Ctrl+Alt+P']);
});
