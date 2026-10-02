import definitions from './shortcuts.json' with { type: 'json' };

export const DOCK_SHORTCUTS = definitions;
export const DEFAULT_DOCK_SHORTCUTS = Object.freeze(Object.fromEntries(definitions.map(item => [item.id, item.binding])));
/** @param {string} binding */
export function displayShortcut(binding) {
  return binding.replaceAll('ArrowUp', '↑').replaceAll('ArrowDown', '↓').replaceAll('ArrowLeft', '←').replaceAll('ArrowRight', '→').replaceAll('Escape', 'Esc').replaceAll('Super', 'Win');
}
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Super'];
const aliases = new Map(Object.entries({ control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super', win: 'Super', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl' }));
const named = ['Enter', 'Escape', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Tab'];
const textBindings = new Set(['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+ArrowLeft', 'Ctrl+ArrowRight', 'Ctrl+Shift+ArrowLeft', 'Ctrl+Shift+ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+Home', 'Shift+End', 'Ctrl+Home', 'Ctrl+End', 'Ctrl+Shift+Home', 'Ctrl+Shift+End', 'Ctrl+Backspace', 'Ctrl+Delete', 'Ctrl+Shift+Backspace', 'Ctrl+Shift+Delete', 'Shift+Delete', 'Shift+Insert']);

/** Canonical key names shared with the native settings validator. @param {unknown} raw */
export function canonicalShortcut(raw) {
  if (typeof raw !== 'string' || raw.length > 80) return null;
  const parts = raw.split('+').map(part => part.trim());
  const last = parts.pop();
  if (!last) return null;
  const mods = parts.map(part => aliases.get(part.toLowerCase()));
  if (mods.some(part => !part) || new Set(mods).size !== mods.length) return null;
  const name = last.replace(/^(Key|Digit)(?=[A-Z0-9]$)/i, '');
  const key = /^[a-z0-9]$/i.test(name) ? name.toUpperCase()
    : /^F([1-9]|1[0-9]|2[0-4])$/i.test(name) ? name.toUpperCase()
    : named.find(key => key.toLowerCase() === name.toLowerCase());
  return key ? [...modifiers.filter(mod => mods.includes(mod)), key].join('+') : null;
}

/** @param {string} binding @param {string} action @param {boolean} [global] */
export function bindingProblem(binding, action, global = false) {
  const combo = canonicalShortcut(binding);
  if (!combo) return 'Choose a supported key combination.';
  const key = combo.split('+').at(-1);
  if (key === 'Escape' && (action !== 'hide' || combo !== 'Escape')) return 'Escape is reserved for hiding and panic lock.';
  if (key === 'Tab' || textBindings.has(combo)) return 'This combination is reserved for focus or text editing.';
  if (combo === key && (global ? !/^F\d+$/.test(key ?? '') : !['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key ?? '') && !/^F\d+$/.test(key ?? ''))) return 'Add Ctrl, Alt or another modifier to this key.';
  if (/^Shift\+[A-Z0-9]$/.test(combo)) return 'Add Ctrl or Alt so typing stays available.';
  return '';
}

/** Load older/hand-edited settings without introducing unsafe typing bindings. @param {unknown} raw */
export function normalizeDockShortcuts(raw) {
  const next = { ...DEFAULT_DOCK_SHORTCUTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const item of definitions) {
      const value = /** @type {Record<string, unknown>} */ (raw)[item.id];
      const combo = canonicalShortcut(value);
      if (combo && !bindingProblem(combo, item.id)) next[item.id] = combo;
    }
  }
  return new Set(Object.values(next)).size === definitions.length ? next : { ...DEFAULT_DOCK_SHORTCUTS };
}

/** @param {{global_shortcut:string,panic_shortcut:string,dock_shortcuts?:Record<string,string>}} settings */
export function shortcutProblems(settings) {
  const seen = new Map(), problems = [];
  const rows = [
    { id: 'global_shortcut', label: 'Summon shortcut', binding: settings.global_shortcut, global: true },
    { id: 'panic_shortcut', label: 'Panic lock shortcut', binding: settings.panic_shortcut, global: true },
    ...definitions.map(item => ({ ...item, binding: settings.dock_shortcuts?.[item.id] ?? item.binding, global: false })),
  ];
  for (const row of rows) {
    const problem = bindingProblem(row.binding, row.id, row.global);
    if (problem) { problems.push(`${row.label}: ${problem}`); continue; }
    const combo = canonicalShortcut(row.binding);
    if (seen.has(combo)) problems.push(`${row.label} conflicts with ${seen.get(combo)} (${combo}).`);
    else seen.set(combo, row.label);
  }
  for (const [index, action] of ['route_firefox', 'route_mullvad', 'route_chrome', 'route_edge'].entries()) {
    if ((settings.dock_shortcuts?.[action] ?? DEFAULT_DOCK_SHORTCUTS[action]) === DEFAULT_DOCK_SHORTCUTS[action] && seen.has(`Alt+${index + 1}`)) problems.push(`Alt+${index + 1} conflicts with the default browser number override.`);
  }
  return problems;
}

/** @param {KeyboardEvent} event @param {boolean} [physical] */
export function shortcutFromEvent(event, physical = true) {
  if (event.isComposing || event.getModifierState?.('AltGraph') || ['Control', 'Alt', 'Shift', 'Meta', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return null;
  const key = !physical && /^[a-z0-9]$/i.test(event.key) ? event.key
    : /^(Key[A-Z]|Digit[0-9])$/.test(event.code ?? '') ? event.code.slice(event.code.startsWith('Key') ? 3 : 5)
    : event.key === ' ' ? 'Space' : event.key;
  return canonicalShortcut([...modifiers.filter((_, index) => [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey][index]), key].join('+'));
}

/** @param {KeyboardEvent} event @param {Record<string,string>} bindings */
export function dockShortcutAction(event, bindings) {
  const combo = shortcutFromEvent(event);
  if (!combo) return null;
  // Escape remains a safety fallback even when Hide has another binding.
  if (combo === 'Escape') return 'hide';
  const action = definitions.find(item => bindings[item.id] === combo)?.id;
  if (action) return action;
  const number = /^Alt\+([1-4])$/.exec(combo)?.[1];
  const browserAction = number ? ['route_firefox', 'route_mullvad', 'route_chrome', 'route_edge'][Number(number) - 1] : undefined;
  return browserAction && bindings[browserAction] === DEFAULT_DOCK_SHORTCUTS[browserAction] ? browserAction : null;
}
