import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImport } from '../src/lib/features/portable/import.js';
test('import keeps safe URLs and folders and reports rejected entries', () => {
  const result = normalizeImport([{ title: ' Example ', url: 'https://example.com/', folder: 'Work' }, ...['javascript:alert(1)', 'file:///a', 'https://user:secret@example.com/', 'https://example.com/\npath'].map(url => ({ title: 'Unsafe', url, folder: null }))]);
  assert.deepEqual(result.items, [{ title: 'Example', url: 'https://example.com/', folder: 'Work' }]); assert.equal(result.rejected.length, 4);
});
test('import enforces byte limits, Unicode folder length and total entry bounds', () => {
  const entry = { title: '😀'.repeat(129), url: 'https://example.com/', folder: null };
  assert.equal(normalizeImport([entry]).rejected.length, 1);
  assert.equal(normalizeImport([{ ...entry, title: '', folder: '😀'.repeat(64) }]).items[0].title, 'example.com');
  assert.equal(normalizeImport([{ ...entry, title: 'Title', folder: 'x'.repeat(65) }]).rejected.length, 1);
  assert.throws(() => normalizeImport(Array(1001).fill(entry)), /1000/);
});
