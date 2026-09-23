import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, normalizeTheme } from '../src/lib/features/settings/themes.ts';
test('theme normalization is tolerant and preserves supported themes', () => {
  for (const raw of [undefined, null, 'dark', 'neon', '', 42]) assert.equal(normalizeTheme(raw), 'sage');
  assert.equal(new Set(THEMES.map(t => t.id)).size, 5);
  for (const theme of THEMES) {
    assert.equal(normalizeTheme(theme.id), theme.id);
    assert.ok(theme.label);
    for (const key of ['surface', 'accent', 'text']) assert.match(theme[key], /^#[0-9a-f]{6}$/i);
  }
});

test('theme tokens meet text contrast targets on their opaque base surfaces', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/app.css', import.meta.url), 'utf8');
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(v => parseInt(v,16)/255).map(v => v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
    return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
  };
  const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+0.05)/(Math.min(luminance(a),luminance(b))+0.05);
  for(const theme of THEMES) {
    const block=css.match(new RegExp('\\[data-theme="'+theme.id+'"\\]\\s*\\{([^}]+)'))[1];
    const token=name=>block.match(new RegExp('--'+name+':\\s*(#[0-9a-f]{6})','i'))[1];
    assert.ok(contrast(theme.surface,token('text'))>=7,theme.id+' text contrast');
    assert.ok(contrast(theme.surface,token('muted'))>=4.5,theme.id+' muted contrast');
    assert.ok(contrast(token('accent'),token('accent-contrast'))>=4.5,theme.id+' button contrast');
  }
});
