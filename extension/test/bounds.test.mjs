import test from 'node:test';
import assert from 'node:assert/strict';
import { Companion } from '../src/core.js';

const pairing = { browser: 'chrome', token: '7d8bab34-411a-48ee-ae6c-8b1b1b110951', port: 49300 };
const tab = (id, url, more = {}) => ({ id, url, title: 'Example', windowId: 10, incognito: false, ...more });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(tabs = []) {
  const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
  let now = 0;
  const timers = new Map(); let timerId = 0;
  const clock = { now: () => now, setTimeout(fn, ms) { timers.set(++timerId, { fn, at: now + ms }); return timerId; }, clearTimeout(id) { timers.delete(id); } };
  const sockets = [], calls = [];
  const api = {
    storage: { local: { async get() { return { pairing }; } }, onChanged: events() },
    alarms: { async create() {}, onAlarm: events() },
    runtime: { onStartup: events(), onInstalled: events() },
    tabs: { async query() { return tabs; }, async update(id, opts) { calls.push(['update', id, opts]); return tabs.find(t => t.id === id); }, async create(opts) { calls.push(['create', opts]); return tab(99, opts.url); }, async remove(ids) { calls.push(['remove', ids]); }, onCreated: events(), onUpdated: events(), onRemoved: events(), onAttached: events(), onDetached: events(), onReplaced: events() },
    windows: { async getAll() { return [{ id: 10, incognito: false, type: 'normal' }]; }, async update(id, opts) { calls.push(['window', id, opts]); }, async create(opts) { calls.push(['create-window', opts]); return { id: 10, incognito: opts.incognito, tabs: [tab(99, opts.url)] }; } }
  };
  const c = new Companion(api, url => { const s = { url, readyState: 0, bufferedAmount: 0, sent: [], send(v) { this.sent.push(JSON.parse(v)); }, close() { this.readyState = 3; this.onclose?.(); }, open() { this.readyState = 1; this.onopen(); }, message(v) { this.onmessage({ data: JSON.stringify(v) }); }, raw(v) { this.onmessage({ data: v }); } }; sockets.push(s); return s; }, clock, () => 'e8d741e8-460a-42bb-aea9-27d54a8e8542');
  return { c, api, sockets, calls, async start() { await c.start(); const s = sockets.at(-1); s.open(); return s; }, async auth() { const s = await this.start(); s.message({ type: 'AUTH_OK' }); await flush(); return s; }, async tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); } };
}
const req = (id) => ({ id, action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' });

test('seen id replay cap drops the connection instead of executing twice', async () => {
  const f = fixture(); const s = await f.auth();
  const ctx = f.c.connection;
  for (let i = 0; i < 1024; i++) ctx.seen.set(`old-${i}`, null);
  s.message(req('fresh')); await flush();
  assert.equal(s.readyState, 3);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
});

test('pending request cap drops the connection instead of queueing unbounded work', async () => {
  const f = fixture(); const s = await f.auth();
  f.c.connection.pending = 32;
  s.message(req('overflow')); await flush();
  assert.equal(s.readyState, 3);
  assert.equal(f.calls.length, 0);
});

test('backpressured socket (>=1MB buffered) drops instead of buffering forever', async () => {
  const f = fixture(); const s = await f.auth();
  s.bufferedAmount = 1024 * 1024 + 1;
  f.api.tabs.onUpdated.emit(); await f.tick(600);
  assert.equal(s.readyState, 3);
});

test('oversized frames (>16KB) are ignored without killing the connection', async () => {
  const f = fixture([tab(1, 'https://example.com/')]); const s = await f.auth();
  s.raw('x'.repeat(16385)); await flush();
  assert.notEqual(s.readyState, 3);
  s.message(req('after')); await flush();
  assert.equal(s.sent.at(-1).result, 'OPENED_NEW_TAB');
});

test('socket errors drop and schedule a reconnect', async () => {
  const f = fixture(); const s = await f.auth();
  s.onerror(); await f.tick(3000);
  assert.equal(f.sockets.length, 2);
});

test('unavailable storage leaves the companion unpaired without throwing', async () => {
  const f = fixture();
  f.api.storage.local.get = async () => { throw new Error('denied'); };
  await f.c.start(); await flush();
  assert.equal(f.c.status, 'unpaired');
  assert.equal(f.sockets.length, 0);
});

test('background entry requires extension APIs and websocket support', async () => {
  const src = await import('node:fs/promises').then(m => m.readFile(new URL('../src/background.js', import.meta.url), 'utf8'));
  assert.match(src, /requires the tabs\/storage extension APIs/);
  assert.match(src, /action\?\.onClicked/);
});
