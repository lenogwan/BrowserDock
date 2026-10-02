import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCK_SHORTCUTS, DEFAULT_DOCK_SHORTCUTS, canonicalShortcut, normalizeDockShortcuts, shortcutProblems, shortcutFromEvent, dockShortcutAction, bindingProblem } from '../src/lib/features/settings/shortcuts.js';

const settings = local => ({ global_shortcut: 'Ctrl+Shift+Space', panic_shortcut: 'Ctrl+Alt+L', dock_shortcuts: { ...DEFAULT_DOCK_SHORTCUTS, ...local } });
const event = binding => {
  const parts = binding.split('+'), key = parts.pop();
  return { key: key === 'Space' ? ' ' : key, code: /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : key,
    ctrlKey: parts.includes('Ctrl'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), metaKey: parts.includes('Super'), isComposing: false, getModifierState: () => false };
};
test('all configured/default actions match exact modifiers and support remapping', () => {
  assert.equal(shortcutProblems(settings()).length, 0);
  for (const item of DOCK_SHORTCUTS) {
    assert.equal(dockShortcutAction(event(item.binding), DEFAULT_DOCK_SHORTCUTS), item.id, item.id);
    const changed = { ...DEFAULT_DOCK_SHORTCUTS, [item.id]: 'Ctrl+Alt+F12' };
    assert.equal(dockShortcutAction(event('Ctrl+Alt+F12'), changed), item.id);
    assert.equal(dockShortcutAction(event(item.binding), changed), item.id === 'hide' ? 'hide' : null);
    assert.equal(dockShortcutAction(event(`Super+${item.binding}`), DEFAULT_DOCK_SHORTCUTS), null);
  }
});
test('legacy settings load safe defaults while duplicate or invalid typing bindings cannot be saved', () => {
  assert.deepEqual(normalizeDockShortcuts(null), DEFAULT_DOCK_SHORTCUTS);
  assert.deepEqual(normalizeDockShortcuts({ open_selected: 'O', unknown: 'Alt+Q' }), DEFAULT_DOCK_SHORTCUTS);
  assert.equal(normalizeDockShortcuts({ new_tab: 'alt+ctrl+keyn' }).new_tab, 'Ctrl+Alt+N');
  for (const bad of ['Tab', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+ArrowLeft', 'Ctrl+Shift+ArrowLeft', 'Ctrl+Backspace', 'Shift+Delete', 'Shift+A', 'Space', 'Ctrl+Escape', '', 'Ctrl+Ctrl+K']) assert.ok(bindingProblem(bad, 'open_selected'), bad);
  assert.ok(shortcutProblems(settings({ new_tab: 'Enter' })).some(message => message.includes('conflicts')));
  assert.ok(shortcutProblems(settings({ new_tab: 'Ctrl+Alt+L' })).some(message => message.includes('Panic lock')));
  assert.ok(shortcutProblems(settings({ new_tab: 'Alt+1' })).some(message => message.includes('number override')));
});
test('browser number aliases stop applying when their browser action is remapped', () => {
  for (const [index, action] of ['route_firefox', 'route_mullvad', 'route_chrome', 'route_edge'].entries()) {
    assert.equal(dockShortcutAction(event(`Alt+${index + 1}`), DEFAULT_DOCK_SHORTCUTS), action);
    assert.equal(dockShortcutAction(event(`Alt+${index + 1}`), { ...DEFAULT_DOCK_SHORTCUTS, [action]: 'Ctrl+Alt+F12' }), null);
  }
});
test('canonicalization and physical key handling preserve shifted/layout keys and ignore composition', () => {
  assert.equal(canonicalShortcut('shift+control+KeyN'), 'Ctrl+Shift+N');
  assert.equal(canonicalShortcut('Meta+Digit2'), 'Super+2');
  assert.equal(canonicalShortcut('Ctrl+F01'), null);
  assert.equal(shortcutFromEvent({ ...event('Ctrl+Shift+N'), key: 'ñ' }), 'Ctrl+Shift+N');
  assert.equal(shortcutFromEvent({ ...event('Ctrl+Alt+Y'), key: 'z' }), 'Ctrl+Alt+Y');
  assert.equal(shortcutFromEvent({ ...event('Ctrl+Alt+Y'), key: 'z' }, false), 'Ctrl+Alt+Z');
  assert.equal(shortcutFromEvent({ ...event('Alt+F'), isComposing: true }), null);
  assert.equal(shortcutFromEvent({ ...event('Alt+F'), getModifierState: () => true }), null);
  assert.equal(shortcutFromEvent({ ...event('Alt+F'), key: 'Dead' }), null);
});
