import test from 'node:test';
import assert from 'node:assert/strict';
import { Companion, validPairing, safeUrl, inventory, nearestGroupColor } from '../src/core.js';

const pairing = { browser: 'mullvad', token: '7d8bab34-411a-48ee-ae6c-8b1b1b110951', port: 49300 };
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
  const c = new Companion(api, url => { const s = { url, readyState: 0, sent: [], send(v) { this.sent.push(JSON.parse(v)); }, close() { this.readyState = 3; this.onclose?.(); }, open() { this.readyState = 1; this.onopen(); }, message(v) { this.onmessage({ data: JSON.stringify(v) }); } }; sockets.push(s); return s; }, clock, () => 'e8d741e8-460a-42bb-aea9-27d54a8e8542');
  return { c, api, sockets, calls, async start() { await c.start(); const s = sockets.at(-1); s.open(); return s; }, async auth() { const s = await this.start(); s.message({ type: 'AUTH_OK' }); await flush(); return s; }, async tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); } };
}
test('pairing requires explicit browser, UUIDv4 token and configured integer port', () => {
  assert.equal(validPairing(pairing), true);
  for (const change of [{ browser: 'auto' }, { token: 'secret' }, { port: 0 }, { port: '49300' }, { port: 65536 }]) assert.equal(validPairing({ ...pairing, ...change }), false);
});
test('URLs reject credentials, controls, non-web schemes and oversized UTF8', () => {
  assert.ok(safeUrl('https://example.com/a'));
  for (const u of ['javascript:alert(1)', 'https://u:p@example.com', 'https://example.com/\nfoo', ' https://example.com', 'https://example.com/' + 'é'.repeat(1100)]) assert.equal(safeUrl(u), null);
});
test('inventory excludes private and unsafe tabs and bounds UTF8 URLs and Unicode titles', () => {
  const result = inventory([tab(1, 'https://private.example', { incognito: true }), tab(2, 'file:///a'), ...Array.from({ length: 210 }, (_, i) => tab(i + 3, 'https://example.com', { title: '😀'.repeat(300) }))]);
  assert.equal(result.length, 200); assert.equal(result[0].id, 3); assert.equal([...result[0].title].length, 256);
});
test('auth precedes inventory and all browser actions', async () => {
  const f = fixture(); const s = await f.start();
  assert.deepEqual(s.sent, [{ type: 'AUTH', token: pairing.token, browser: 'mullvad', instance_id: 'e8d741e8-460a-42bb-aea9-27d54a8e8542', capabilities: ['tab_groups_v1'] }]);
  s.message({ id: 'a', action: 'FOCUS_OR_OPEN', url: 'https://example.com', match_mode: 'new_tab' }); await f.tick(1000);
  assert.equal(f.calls.length, 0); assert.equal(s.sent.length, 1);
});
test('exact match wins over hostname and substring never matches', async () => {
  const f = fixture([tab(1, 'https://example.com/other'), tab(2, 'https://example.com/desired'), tab(3, 'https://evil.example/?q=example.com')]); const s = await f.auth();
  s.message({ id: 'a', action: 'FOCUS_OR_OPEN', url: 'https://example.com/desired', match_mode: 'domain_or_exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'a', status: 'SUCCESS', result: 'FOCUSED_EXISTING', window_id: 10, tab_id: 2 });
  assert.deepEqual(f.calls[0], ['update', 2, { active: true }]);
});
test('exact mode opens missing URL in a non-private window; duplicate id executes once', async () => {
  const f = fixture([tab(1, 'https://example.com/other')]); const s = await f.auth();
  const req = { id: 'a', action: 'FOCUS_OR_OPEN', url: 'https://example.com/new', match_mode: 'exact' };
  s.message(req); s.message(req); await flush(); s.message(req); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.deepEqual(f.calls.find(c => c[0] === 'create'), ['create', { url: req.url, active: true, windowId: 10 }]);
  assert.equal(s.sent.at(-1).result, 'OPENED_NEW_TAB');
});
test('sync coalesces bursts and never sends more often than 500ms', async () => {
  const f = fixture([tab(1, 'https://example.com')]); const s = await f.auth();
  for (let i = 0; i < 30; i++) f.api.tabs.onUpdated.emit();
  await f.tick(499); assert.equal(s.sent.filter(x => x.action === 'TABS_SYNC').length, 0);
  await f.tick(1); assert.equal(s.sent.filter(x => x.action === 'TABS_SYNC').length, 1);
  f.api.tabs.query = async () => [tab(2, 'https://changed.example/')];
  f.api.tabs.onUpdated.emit(); await f.tick(499); assert.equal(s.sent.filter(x => x.action === 'TABS_SYNC').length, 1);
  await f.tick(1); assert.equal(s.sent.filter(x => x.action === 'TABS_SYNC').length, 2);
});
test('disconnect reconnects and stale socket commands cannot act', async () => {
  const f = fixture(); const s = await f.auth(); s.close(); await f.tick(3000);
  assert.equal(f.sockets.length, 2); assert.equal(f.sockets[1].url, 'ws://127.0.0.1:49300');
  s.message({ id: 'old', action: 'FOCUS_OR_OPEN', url: 'https://example.com', match_mode: 'new_tab' }); await flush(); assert.equal(f.calls.length, 0);
});
test('heartbeat sends PING and missing PONG closes stale connection', async () => {
  const f = fixture(); const s = await f.auth(); await f.tick(20000); assert.ok(s.sent.some(x => x.action === 'PING'));
  await f.tick(40000); assert.equal(s.readyState, 3);
});
test('pairing change cancels pending query before browser mutation', async () => {
  const f = fixture(); const s = await f.auth(); let finish;
  f.api.tabs.query = () => new Promise(r => { finish = r; });
  s.message({ id: 'a', action: 'FOCUS_OR_OPEN', url: 'https://example.com', match_mode: 'new_tab' }); await flush();
  f.api.storage.onChanged.emit({ pairing: { newValue: { ...pairing, port: 49301 } } }, 'local'); await flush(); finish([]); await flush();
  assert.equal(f.calls.length, 0); assert.equal(s.readyState, 3);
});
test('hostname matching does not mistake lookalike hosts or query strings for the target', async () => {
  const f = fixture([tab(1, 'https://example.com.evil.test'), tab(2, 'https://evil.test/?next=https://example.com'), tab(3, 'http://example.com/other')]);
  const s = await f.auth(); s.message({ id: 'host', action: 'FOCUS_OR_OPEN', url: 'https://example.com/wanted', match_mode: 'domain_or_exact' }); await flush();
  assert.equal(s.sent.at(-1).tab_id, 3);
});
test('new_tab forces creation even when exact match exists', async () => {
  const f = fixture([tab(1, 'https://example.com/')]); const s = await f.auth();
  s.message({ id: 'new', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' }); await flush();
  assert.equal(s.sent.at(-1).result, 'OPENED_NEW_TAB'); assert.equal(f.calls.filter(c => c[0] === 'update').length, 0);
});
test('private matching tabs are excluded and creation uses a new non-private window by default', async () => {
  const f = fixture([tab(1, 'https://example.com/', { incognito: true })]);
  f.api.windows.getAll = async () => [{ id: 20, incognito: true, type: 'normal' }];
  const s = await f.auth(); s.message({ id: 'private', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' }); await flush();
  assert.equal(s.sent.at(-1).result, 'OPENED_NEW_TAB');
  assert.deepEqual(f.calls[0], ['create-window', { url: 'https://example.com/', incognito: false, focused: true }]);
});
test('invalid requests and browser failures return correlated errors without sensitive detail', async () => {
  const f = fixture(); const s = await f.auth();
  s.message({ id: 'bad', action: 'FOCUS_OR_OPEN', url: 'file:///secret', match_mode: 'exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'bad', status: 'ERROR', result: 'ERROR_INVALID_REQUEST' });
  f.api.tabs.query = async () => { throw new Error('secret browser data'); };
  s.message({ id: 'api', action: 'FOCUS_OR_OPEN', url: 'https://example.com', match_mode: 'exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'api', status: 'ERROR', result: 'ERROR_BROWSER_API' });
});
test('auth timeout closes connection and alarm wakes disconnected companion', async () => {
  const f = fixture(); const s = await f.start(); await f.tick(5000); assert.equal(s.readyState, 3);
  f.api.alarms.onAlarm.emit({ name: 'browserdock-reconnect' }); assert.equal(f.sockets.length, 2);
});
test('PONG keeps heartbeat alive and malformed messages have no effects', async () => {
  const f = fixture(); const s = await f.auth();
  s.onmessage({ data: 'not-json' }); s.message(null); s.message([]);
  for (let i = 0; i < 5; i++) { await f.tick(20000); s.message({ action: 'PONG' }); }
  assert.equal(s.readyState, 1); assert.equal(f.calls.length, 0);
});
test('clearing pairing disconnects and prevents alarm reconnects', async () => {
  const f = fixture(); const s = await f.auth();
  f.api.storage.onChanged.emit({ pairing: { newValue: undefined } }, 'local');
  f.api.alarms.onAlarm.emit({ name: 'browserdock-reconnect' }); await f.tick(30000);
  assert.equal(s.readyState, 3); assert.equal(f.sockets.length, 1);
});
test('tab changes while inventory query is pending trigger a later bounded snapshot', async () => {
  const f = fixture(); const s = await f.auth(); let finish;
  f.api.tabs.query = () => new Promise(r => { finish = r; });
  await f.tick(500); f.api.tabs.onUpdated.emit(); finish([]); await flush();
  f.api.tabs.query = async () => [tab(1, 'https://new.example/')];
  await f.tick(500);
  assert.equal(s.sent.filter(x => x.action === 'TABS_SYNC').length, 2);
  assert.equal(s.sent.at(-1).tabs[0].url, 'https://new.example/');
});
test('private inventory remains excluded unless explicitly opted in', () => {
  const tabs = [tab(1, 'https://private.example/', { incognito: true })];
  assert.deepEqual(inventory(tabs), []);
  assert.deepEqual(inventory(tabs, false), []);
  assert.equal(inventory(tabs, true)[0].id, 1);
  assert.equal(validPairing({ ...pairing, includePrivate: 'true' }), false);
});
test('opt-in private tab is inventoried and focused after authentication', async () => {
  const f = fixture([tab(1, 'https://private.example/', { incognito: true })]);
  f.api.storage.local.get = async () => ({ pairing: { ...pairing, includePrivate: true } });
  const s = await f.auth(); await f.tick(500);
  assert.equal(s.sent.at(-1).tabs[0].id, 1);
  s.message({ id: 'private-focus', action: 'FOCUS_OR_OPEN', url: 'https://private.example/', match_mode: 'exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'private-focus', status: 'SUCCESS', result: 'FOCUSED_EXISTING', window_id: 10, tab_id: 1 });
});
test('opted-in Mullvad opens new tab in its existing private-only window', async () => {
  const f = fixture();
  f.api.storage.local.get = async () => ({ pairing: { ...pairing, includePrivate: true } });
  f.api.windows.getAll = async () => [{ id: 10, incognito: true, type: 'normal' }];
  const s = await f.auth(); s.message({ id: 'private-open', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' }); await flush();
  assert.equal(s.sent.at(-1).result, 'OPENED_NEW_TAB');
  assert.deepEqual(f.calls[0], ['create', { url: 'https://example.com/', active: true, windowId: 10 }]);
});
test('opted-in Mullvad creates an incognito window when none exists', async () => {
  const f = fixture();
  f.api.storage.local.get = async () => ({ pairing: { ...pairing, includePrivate: true } });
  f.api.windows.getAll = async () => [];
  f.api.windows.create = async opts => { f.calls.push(['create-window', opts]); return { id: 20, incognito: true, tabs: [tab(77, opts.url, { windowId: 20, incognito: true })] }; };
  const s = await f.auth(); s.message({ id: 'private-window', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' }); await flush();
  assert.deepEqual(f.calls[0], ['create-window', { url: 'https://example.com/', incognito: true, focused: true }]);
  assert.deepEqual(s.sent.at(-1), { id: 'private-window', status: 'SUCCESS', result: 'OPENED_NEW_TAB', window_id: 20, tab_id: 77 });
});
test('background-only Edge hands off before touching tabs or opening a window', async () => {
  const f = fixture([tab(1, 'https://example.com/')]);
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  f.api.windows.getAll = async () => [];
  f.api.tabs.query = async () => { throw new Error('Background-only Edge must not query hidden tabs'); };
  s.message({ id: 'edge-closed', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' });
  await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'edge-closed', status: 'ERROR', result: 'ERROR_NO_BROWSER_WINDOW' });
  assert.deepEqual(f.calls, []);
});
test('Edge window preflight rejection also hands off safely', async () => {
  const f = fixture();
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  f.api.windows.getAll = async () => { throw new Error('no Edge windows'); };
  f.api.tabs.query = async () => { throw new Error('must not query tabs'); };
  s.message({ id: 'edge-no-window-error', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' });
  await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'edge-no-window-error', status: 'ERROR', result: 'ERROR_NO_BROWSER_WINDOW' });
  assert.deepEqual(f.calls, []);
});
test('Edge stale hidden window with no tabs hands off safely', async () => {
  const f = fixture();
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  f.api.windows.getAll = async () => [{ id: 42, incognito: false, type: 'normal' }];
  f.api.tabs.query = async () => [];
  s.message({ id: 'edge-stale-window', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' });
  await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'edge-stale-window', status: 'ERROR', result: 'ERROR_NO_BROWSER_WINDOW' });
  assert.deepEqual(f.calls, []);
});

test('normal background-only browser creates a normal window', async () => {
  const f = fixture();
  f.api.storage.local.get = async () => ({ pairing: { ...pairing, browser: 'chrome' } });
  f.api.windows.getAll = async () => [];
  const s = await f.auth(); s.message({ id: 'normal-window', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' }); await flush();
  assert.deepEqual(f.calls[0], ['create-window', { url: 'https://example.com/', incognito: false, focused: true }]);
  assert.equal(s.sent.at(-1).result, 'OPENED_NEW_TAB');
});
test('Edge with an existing normal window still focuses its matching tab', async () => {
  const f = fixture([tab(1, 'https://example.com/')]);
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  s.message({ id: 'edge-open', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' });
  await flush();
  assert.equal(s.sent.at(-1).result, 'FOCUSED_EXISTING');
  assert.deepEqual(f.calls.map(c => c[0]), ['update', 'window']);
});
test('Edge missing tab hands off instead of creating through a stale window', async () => {
  const f = fixture([tab(1, 'https://other.example/')]);
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  s.message({ id: 'edge-missing', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' });
  await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'edge-missing', status: 'ERROR', result: 'ERROR_NO_BROWSER_WINDOW' });
  assert.deepEqual(f.calls, []);
});
test('Edge window handoff is cancelled if pairing changes during the window query', async () => {
  const f = fixture();
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  let finish;
  f.api.windows.getAll = () => new Promise(resolve => finish = resolve);
  s.message({ id: 'edge-cancel', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' });
  await flush();
  f.c.configure(null);
  finish([]);
  await flush();
  assert.deepEqual(f.calls, []);
  assert.equal(s.sent.some(r => r.id === 'edge-cancel'), false);
});
test('inventory truncates URLs on UTF8 boundaries and focus still matches full long tab URLs by hostname', async () => {
  const longUrl = 'https://example.com/' + 'é'.repeat(1200);
  const snapshot = inventory([tab(1, longUrl)]);
  assert.equal(snapshot.length, 1);
  assert.ok(new TextEncoder().encode(snapshot[0].url).length <= 2048);
  assert.ok(longUrl.startsWith(snapshot[0].url)); assert.ok(!snapshot[0].url.includes('�'));
  const f = fixture([tab(1, longUrl)]); const s = await f.auth();
  s.message({ id: 'long', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'domain_or_exact' }); await flush();
  assert.equal(s.sent.at(-1).result, 'FOCUSED_EXISTING');
});
test('container focus filters identical URLs and creates in resolved cookie store', async () => {
  const f=fixture([tab(1,'https://example.com/',{cookieStoreId:'firefox-default'}),tab(2,'https://example.com/',{cookieStoreId:'firefox-container-1'})]);
  f.api.contextualIdentities={async query(){return [{name:'work',cookieStoreId:'firefox-container-1'}]}};
  const s=await f.auth();
  s.message({id:'container-focus',action:'FOCUS_OR_OPEN',url:'https://example.com/',match_mode:'exact',container:'work'}); await flush();
  assert.equal(s.sent.at(-1).tab_id,2);
  s.message({id:'container-new',action:'FOCUS_OR_OPEN',url:'https://example.com/new',match_mode:'new_tab',container:'work'}); await flush();
  assert.equal(f.calls.find(c=>c[0]==='create')[1].cookieStoreId,'firefox-container-1');
  assert.equal(inventory([tab(2,'https://example.com/',{cookieStoreId:'firefox-container-1'})])[0].cookieStoreId,'firefox-container-1');
});
test('unknown containers fail without creating ordinary tabs', async () => {
 const f=fixture(); f.api.contextualIdentities={async query(){return []}}; const s=await f.auth();
 s.message({id:'missing',action:'FOCUS_OR_OPEN',url:'https://example.com/',match_mode:'exact',container:'missing'}); await flush();
 assert.equal(s.sent.at(-1).result,'ERROR_CONTAINER_NOT_FOUND'); assert.equal(f.calls.length,0);
});
test('invalid option fields return a request error and keep the connection usable', async () => {
  const f = fixture(); const s = await f.auth();
  s.message({id:'bad-profile',action:'FOCUS_OR_OPEN',url:'https://example.com/',match_mode:'exact',profile:'bad;profile'}); await flush();
  assert.equal(s.sent.at(-1).result,'ERROR_INVALID_REQUEST');
  assert.equal(f.calls.length,0);
  s.message({id:'valid-after-error',action:'FOCUS_OR_OPEN',url:'https://example.com/',match_mode:'new_tab'}); await flush();
  assert.equal(s.sent.at(-1).result,'OPENED_NEW_TAB');
});
test('rejected private window creation never downgrades to a normal window', async () => {
  const f=fixture();
  f.api.storage.local.get=async()=>({pairing:{...pairing,includePrivate:true}});
  f.api.windows.getAll=async()=>[];
  f.api.windows.create=async opts=>{f.calls.push(['create-window',opts]);throw new Error('Private browsing unavailable');};
  const s=await f.auth();
  s.message({id:'refused-private',action:'FOCUS_OR_OPEN',url:'https://example.com/',match_mode:'new_tab'});await flush();
  assert.equal(s.sent.at(-1).result,'ERROR_BROWSER_API');
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0][1].incognito,true);
});
test('default clock invokes timers on the global scope (Firefox strict receiver)', async () => {
  // Firefox throws when timer functions run with a plain-object receiver;
  // the default clock must delegate with globalThis as receiver instead.
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = function (fn, ms, ...args) { if (this !== globalThis) throw new TypeError("'setTimeout' called on an object that does not implement interface Window."); return realSetTimeout.call(globalThis, fn, ms, ...args); };
  globalThis.clearTimeout = function (id) { if (this !== globalThis) throw new TypeError("'clearTimeout' called on an object that does not implement interface Window."); return realClearTimeout.call(globalThis, id); };
  try {
    const f = fixture();
    const c = new Companion(f.api, url => { const s = { url, readyState: 0, sent: [], send(v) { this.sent.push(JSON.parse(v)); }, close() {}, open() { this.readyState = 1; this.onopen(); } }; f.sockets.push(s); return s; }, undefined, () => 'e8d741e8-460a-42bb-aea9-27d54a8e8542');
    await c.start(); f.sockets[0].open(); await flush();
    assert.equal(f.sockets.length, 1);
    assert.deepEqual(f.sockets[0].sent, [{ type: 'AUTH', token: pairing.token, browser: 'mullvad', instance_id: 'e8d741e8-460a-42bb-aea9-27d54a8e8542', capabilities: ['tab_groups_v1'] }]);
    c.disconnect();
  } finally {
    globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
  }
});
test('close removes exact matches only when present, else all hostname matches', async () => {
  const f = fixture([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/b'), tab(3, 'https://other.test/')]);
  const s = await f.auth();
  s.message({ id: 'close-exact', action: 'CLOSE_TABS', url: 'https://example.com/a', match_mode: 'domain_or_exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-exact', status: 'SUCCESS', result: 'CLOSED_TABS', closed: 1 });
  assert.deepEqual(f.calls.at(-1), ['remove', [1]]);
  s.message({ id: 'close-host', action: 'CLOSE_TABS', url: 'https://example.com/other', match_mode: 'domain_or_exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-host', status: 'SUCCESS', result: 'CLOSED_TABS', closed: 2 });
  assert.deepEqual(f.calls.at(-1), ['remove', [1, 2]]);
});
test('close in exact mode and unknown URLs report not-found without mutation', async () => {
  const f = fixture([tab(1, 'https://example.com/a')]);
  const s = await f.auth();
  s.message({ id: 'close-miss', action: 'CLOSE_TABS', url: 'https://example.com/other', match_mode: 'exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-miss', status: 'ERROR', result: 'ERROR_TAB_NOT_FOUND' });
  s.message({ id: 'close-bad', action: 'CLOSE_TABS', url: 'file:///secret', match_mode: 'exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-bad', status: 'ERROR', result: 'ERROR_INVALID_REQUEST' });
  s.message({ id: 'close-newtab', action: 'CLOSE_TABS', url: 'https://example.com/a', match_mode: 'new_tab' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-newtab', status: 'ERROR', result: 'ERROR_INVALID_REQUEST' });
  assert.ok(f.calls.every(c => c[0] !== 'remove'));
});
test('close respects containers and the private opt-in without mutating on failure', async () => {
  const f = fixture([tab(1, 'https://example.com/', { cookieStoreId: 'firefox-default' }), tab(2, 'https://example.com/', { cookieStoreId: 'firefox-container-1' }), tab(3, 'https://example.com/', { incognito: true })]);
  f.api.contextualIdentities = { async query() { return [{ name: 'work', cookieStoreId: 'firefox-container-1' }]; } };
  const s = await f.auth();
  s.message({ id: 'close-container', action: 'CLOSE_TABS', url: 'https://example.com/', match_mode: 'exact', container: 'work' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-container', status: 'SUCCESS', result: 'CLOSED_TABS', closed: 1 });
  assert.deepEqual(f.calls.at(-1), ['remove', [2]]);
  s.message({ id: 'close-missing', action: 'CLOSE_TABS', url: 'https://example.com/', match_mode: 'exact', container: 'missing' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-missing', status: 'ERROR', result: 'ERROR_CONTAINER_NOT_FOUND' });
  s.message({ id: 'close-private', action: 'CLOSE_TABS', url: 'https://example.com/', match_mode: 'exact' }); await flush();
  // Opted-out private tab is invisible: only the two non-private tabs close.
  assert.deepEqual(s.sent.at(-1), { id: 'close-private', status: 'SUCCESS', result: 'CLOSED_TABS', closed: 2 });
  assert.deepEqual(f.calls.at(-1), ['remove', [1, 2]]);
});
test('close failures keep the connection usable and replay the correlated response', async () => {
  const f = fixture([tab(1, 'https://example.com/')]);
  const s = await f.auth();
  f.api.tabs.query = async () => { throw new Error('secret browser data'); };
  s.message({ id: 'close-api', action: 'CLOSE_TABS', url: 'https://example.com/', match_mode: 'exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-api', status: 'ERROR', result: 'ERROR_BROWSER_API' });
  s.message({ id: 'close-api', action: 'CLOSE_TABS', url: 'https://example.com/', match_mode: 'exact' }); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'close-api', status: 'ERROR', result: 'ERROR_BROWSER_API' });
});

test('reconnected commands bypass an unresolved old query without letting it mutate', async () => {
  const f = fixture(); const old = await f.auth(); let release;
  f.api.tabs.query = () => new Promise(r => { release = r; });
  old.message({ id: 'old', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' }); await flush();
  old.close(); await f.tick(3000);
  f.api.tabs.query = async () => [];
  const fresh = f.sockets.at(-1); fresh.open(); fresh.message({ type: 'AUTH_OK' });
  fresh.message({ id: 'fresh', action: 'FOCUS_OR_OPEN', url: 'https://new.example/', match_mode: 'new_tab' }); await flush();
  assert.equal(fresh.sent.at(-1).result, 'OPENED_NEW_TAB');
  release([]); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
});
test('expired queued and in-flight requests cannot mutate tabs', async () => {
  const f = fixture(); const s = await f.auth(); let release;
  f.api.tabs.query = () => new Promise(r => { release = r; });
  s.message({ id: 'slow', action: 'CLOSE_TABS', url: 'https://example.com/', match_mode: 'exact', deadline_ms: 100 }); await flush();
  s.message({ id: 'queued', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab', deadline_ms: 100 });
  await f.tick(101); release([tab(1, 'https://example.com/')]); await flush();
  assert.equal(f.calls.length, 0);
});
test('irrelevant updates skip queries and identical inventories skip sends', async () => {
  const f = fixture([tab(1, 'https://example.com/')]); const s = await f.start(); s.message({ type: 'AUTH_OK', capabilities: ['paged_tabs_v1'] }); await f.tick(500);
  let queries = 0; f.api.tabs.query = async () => { queries++; return [tab(1, 'https://example.com/')]; };
  f.api.tabs.onUpdated.emit(1, { audible: true }); await f.tick(500); assert.equal(queries, 0);
  f.api.tabs.onUpdated.emit(1, { title: 'Example' }); await f.tick(500); assert.equal(queries, 1);
  assert.equal(s.sent.filter(m => m.action === 'TABS_SYNC_PAGE').length, 1);
});
test('negotiated inventory pages cover more than 200 tabs and legacy stays bounded', async () => {
  const tabs = Array.from({ length: 401 }, (_, i) => tab(i, `https://tab${i}.example/`));
  const f = fixture(tabs); const s = await f.start(); s.message({ type: 'AUTH_OK', capabilities: ['paged_tabs_v1'] }); await f.tick(500);
  const pages = s.sent.filter(m => m.action === 'TABS_SYNC_PAGE');
  assert.deepEqual(pages.map(p => p.tabs.length), [200, 200, 1]);
  assert.deepEqual(pages.map(p => p.page), [0, 1, 2]);
  assert.ok(pages.every(p => p.pages === 3 && p.snapshot_id === pages[0].snapshot_id));
  const legacy = fixture(tabs); const ls = await legacy.auth(); await legacy.tick(500);
  assert.equal(ls.sent.find(m => m.action === 'TABS_SYNC').tabs.length, 200);
});
test('new tabs prefer focused then recently focused eligible windows', async () => {
  const f = fixture(); f.api.windows.onFocusChanged = { addListener(fn) { this.listener = fn; } };
  let windows = [{ id: 10, incognito: false }, { id: 20, incognito: false, focused: true }, { id: 30, incognito: true, focused: true }];
  f.api.windows.getAll = async () => windows;
  const s = await f.auth();
  s.message({ id: 'focused', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' }); await flush();
  assert.equal(f.calls.find(c => c[0] === 'create')[1].windowId, 20);
  windows = windows.map(w => ({ ...w, focused: false })); f.api.windows.onFocusChanged.listener(20); f.api.windows.onFocusChanged.listener(-1);
  s.message({ id: 'recent', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' }); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'create').at(-1)[1].windowId, 20);
});

test('watchdog disconnects stuck commands and reconnects without waiting for them', async () => {
  const f = fixture(); const old = await f.auth();
  f.api.tabs.query = () => new Promise(() => {});
  old.message({ id: 'stuck', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' }); await flush();
  await f.tick(5000); assert.equal(old.readyState, 3);
  await f.tick(3000); assert.equal(f.sockets.length, 2);
  f.api.tabs.query = async () => [];
  const fresh = f.sockets.at(-1); fresh.open(); fresh.message({ type: 'AUTH_OK' });
  fresh.message({ id: 'fresh', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'exact' }); await flush();
  assert.equal(fresh.sent.at(-1).result, 'OPENED_NEW_TAB');
});
test('expired and malformed deadlines return errors without a browser mutation', async () => {
  const f = fixture(); const s = await f.auth();
  for (const [id, deadline_ms, result] of [['expired', 0, 'ERROR_REQUEST_EXPIRED'], ['invalid', 'soon', 'ERROR_INVALID_REQUEST']]) {
    s.message({ id, deadline_ms, action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab' }); await flush();
    assert.equal(s.sent.at(-1).result, result);
  }
  assert.equal(f.calls.length, 0);
});
test('paged inventory bounds totals, emits empty replacement, and respects backpressure', async () => {
  const f = fixture(Array.from({ length: 2001 }, (_, i) => tab(i, 'https://example.com/')));
  const s = await f.start(); s.message({ type: 'AUTH_OK', capabilities: ['paged_tabs_v1'] }); s.bufferedAmount = 600000;
  await f.tick(500); assert.equal(s.sent.filter(m => m.action === 'TABS_SYNC_PAGE').length, 0);
  s.bufferedAmount = 0; await f.tick(25);
  const pages = s.sent.filter(m => m.action === 'TABS_SYNC_PAGE');
  assert.equal(pages.length, 10); assert.equal(pages.flatMap(p => p.tabs).length, 2000);
  f.api.tabs.query = async () => []; f.api.tabs.onRemoved.emit(); await f.tick(500);
  assert.equal(s.sent.at(-1).pages, 1); assert.deepEqual(s.sent.at(-1).tabs, []);
});
test('status replies are local and contain no pairing secrets', async () => {
  const f = fixture(); let listener;
  f.api.runtime.id = 'companion'; f.api.runtime.onMessage = { addListener(fn) { listener = fn; } };
  await f.auth(); const replies = [];
  listener({ type: 'BROWSERDOCK_STATUS' }, { id: 'other' }, value => replies.push(value));
  assert.equal(replies.length, 0);
  listener({ type: 'BROWSERDOCK_STATUS' }, { id: 'companion' }, value => replies.push(value));
  assert.deepEqual(replies, [{ state: 'connected' }]);
  f.c.configure(null);
  listener({ type: 'BROWSERDOCK_STATUS' }, { id: 'companion' }, value => replies.push(value));
  assert.deepEqual(replies.at(-1), { state: 'unpaired' });
});

test('legacy servers receive unchanged refreshes to recover dropped snapshots', async () => {
  const f = fixture([tab(1, 'https://example.com/')]); const s = await f.auth(); await f.tick(500);
  f.api.alarms.onAlarm.emit({ name: 'browserdock-reconnect' }); await f.tick(500);
  assert.equal(s.sent.filter(m => m.action === 'TABS_SYNC').length, 2);
});

function withGroups(f, groups = []) {
  f.api.tabGroups = {
    async query() { return groups; },
    async update(id, options) { f.calls.push(['group-update', id, options]); },
  };
  f.api.tabs.group = async options => { f.calls.push(['group', options]); return options.groupId ?? 21; };
  return f;
}
const groupRequest = (more = {}) => ({ id: 'group', action: 'OPEN_GROUP', urls: ['https://one.test/', 'https://two.test/'], tab_group: { name: 'Work', color: '#4285f4', collapsed: true }, ...more });

test('all canonical colors and shorthand map deterministically', () => {
  assert.equal(nearestGroupColor('#4285f4'), 'blue');
  assert.equal(nearestGroupColor('#34a853'), 'green');
  assert.equal(nearestGroupColor('#fbbc04'), 'yellow');
  assert.equal(nearestGroupColor('#fff'), nearestGroupColor('#ffffff'));
  assert.equal(nearestGroupColor('not-a-color'), 'grey');
});
test('focus joins a matching native group and sets its metadata', async () => {
  const f = withGroups(fixture([tab(1, 'https://one.test/')]), [{ id: 8, title: 'Work', windowId: 10 }]);
  const s = await f.auth();
  s.message(groupRequest({ action: 'FOCUS_OR_OPEN', url: 'https://one.test/', match_mode: 'exact' })); await flush();
  assert.deepEqual(f.calls.find(c => c[0] === 'group'), ['group', { tabIds: [1], groupId: 8 }]);
  assert.deepEqual(f.calls.find(c => c[0] === 'group-update'), ['group-update', 8, { title: 'Work', color: 'blue', collapsed: true }]);
  assert.equal(s.sent.at(-1).result, 'FOCUSED_EXISTING');
});
test('open batch reuses exact URLs in one window and creates missing tabs once', async () => {
  const f = withGroups(fixture([tab(1, 'https://one.test/'), tab(2, 'https://two.test/', { windowId: 11 })]));
  const s = await f.auth(); const request = groupRequest();
  s.message(request); await flush(); await flush(); s.message(request); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.deepEqual(f.calls.find(c => c[0] === 'group'), ['group', { tabIds: [1, 99], createProperties: { windowId: 10 } }]);
  assert.equal(s.sent.at(-1).result, 'OPENED_GROUP');
});
test('background-only Edge group open hands off before creating a window', async () => {
  const f = fixture();
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  f.api.windows.getAll = async () => [];
  f.api.tabs.query = async () => { throw new Error('Background-only Edge must not query hidden tabs'); };
  f.api.windows.create = async () => { throw new Error('Background-only Edge must not create windows'); };
  s.message(groupRequest({ id: 'edge-group-closed' })); await flush(); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'edge-group-closed', status: 'ERROR', result: 'ERROR_NO_BROWSER_WINDOW' });
  assert.deepEqual(f.calls, []);
});
test('Edge group open with a stale window hands off before creating tabs', async () => {
  const f = fixture();
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  f.api.windows.getAll = async () => [{ id: 42, incognito: false, type: 'normal' }];
  f.api.tabs.query = async () => { throw new Error('stale Edge window rejects inventory'); };
  s.message(groupRequest({ id: 'edge-group-stale' })); await flush(); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'edge-group-stale', status: 'ERROR', result: 'ERROR_NO_BROWSER_WINDOW' });
  assert.deepEqual(f.calls, []);
});
test('Edge single open with a group hint hands off when no window exists', async () => {
  const f = fixture();
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  f.api.windows.getAll = async () => [];
  f.api.tabs.query = async () => { throw new Error('Background-only Edge must not query hidden tabs'); };
  s.message({ id: 'edge-focus-grouped', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'new_tab', tab_group: { name: 'Work', color: '#4285f4' } });
  await flush(); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'edge-focus-grouped', status: 'ERROR', result: 'ERROR_NO_BROWSER_WINDOW' });
  assert.deepEqual(f.calls, []);
});
test('Edge grouped open through a stale window hands off when creation rejects', async () => {
  const f = fixture([tab(1, 'https://other.example/')]);
  const s = await f.auth();
  f.c.connection.pairing = { ...pairing, browser: 'edge' };
  f.api.tabs.create = async () => { throw new Error('stale Edge window rejects creation'); };
  s.message({ id: 'edge-focus-stale-create', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'domain_or_exact', tab_group: { name: 'Work', color: '#4285f4' } });
  await flush(); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'edge-focus-stale-create', status: 'ERROR', result: 'ERROR_NO_BROWSER_WINDOW' });
  assert.deepEqual(f.calls, []);
});
test('non-Edge creation failure still reports a browser API error', async () => {
  const f = fixture([tab(1, 'https://other.example/')]);
  f.api.storage.local.get = async () => ({ pairing: { ...pairing, browser: 'chrome' } });
  const s = await f.auth();
  f.api.tabs.create = async () => { throw new Error('transient failure'); };
  s.message({ id: 'chrome-create-fails', action: 'FOCUS_OR_OPEN', url: 'https://example.com/', match_mode: 'domain_or_exact' });
  await flush(); await flush();
  assert.deepEqual(s.sent.at(-1), { id: 'chrome-create-fails', status: 'ERROR', result: 'ERROR_BROWSER_API' });
});
test('unsupported groups open ordinary tabs with a visible note and close fails safely', async () => {
  const f = fixture(); const s = await f.auth();
  s.message(groupRequest()); await flush(); await flush();
  assert.equal(s.sent.at(-1).result, 'OPENED_GROUP');
  assert.match(s.sent.at(-1).note, /unavailable/);
  s.message(groupRequest({ id: 'close', action: 'CLOSE_GROUP' })); await flush();
  assert.equal(s.sent.at(-1).result, 'ERROR_GROUPS_UNSUPPORTED');
  assert.equal(f.calls.filter(c => c[0] === 'remove').length, 0);
});
test('grouping API rejection reports opened tabs and never recreates them', async () => {
  const f = withGroups(fixture()); f.api.tabs.group = async () => { throw Error('disabled'); };
  const s = await f.auth(); const request = groupRequest();
  s.message(request); await flush(); await flush(); s.message(request); await flush();
  assert.equal(s.sent.at(-1).result, 'OPENED_GROUP');
  assert.match(s.sent.at(-1).note, /could not finish/);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 2);
});
test('collapsed group fallback activates its first tab without replaying opens', async () => {
  for (const unavailable of [true, false]) {
    const f = fixture([tab(1, 'https://one.test/')]);
    if (!unavailable) {
      withGroups(f);
      f.api.tabs.group = async () => { throw Error('disabled'); };
    }
    const s = await f.auth(); const request = groupRequest();
    s.message(request); await flush(); await flush();
    s.message(request); await flush();
    assert.equal(s.sent.at(-1).result, 'OPENED_GROUP');
    assert.ok(s.sent.at(-1).note);
    assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
    assert.deepEqual(f.calls.filter(c => c[0] === 'update'), [['update', 1, { active: true }]]);
    assert.deepEqual(f.calls.at(-1), ['window', 10, { focused: true }]);
  }
});
test('successful collapsed groups stay collapsed without activating a member', async () => {
  const f = withGroups(fixture([tab(1, 'https://one.test/')]));
  const s = await f.auth();
  s.message(groupRequest()); await flush(); await flush();
  assert.equal(s.sent.at(-1).result, 'OPENED_GROUP');
  assert.equal(s.sent.at(-1).note, undefined);
  assert.equal(f.calls.find(c => c[0] === 'group-update')[2].collapsed, true);
  assert.equal(f.calls.filter(c => c[0] === 'update').length, 0);
});
test('close group removes only matching non-shared, eligible container tabs', async () => {
  const f = withGroups(fixture([
    tab(1, 'https://one.test/', { groupId: 8, cookieStoreId: 'firefox-container-1' }),
    tab(2, 'https://two.test/', { groupId: 8, cookieStoreId: 'firefox-default' }),
    tab(3, 'https://private.test/', { groupId: 8, cookieStoreId: 'firefox-container-1', incognito: true }),
    tab(4, 'https://shared.test/', { groupId: 9, cookieStoreId: 'firefox-container-1' }),
  ]), [{ id: 8, title: 'Work', windowId: 10 }, { id: 9, title: 'Work', windowId: 10, shared: true }]);
  f.api.contextualIdentities = { async query() { return [{ name: 'work', cookieStoreId: 'firefox-container-1' }]; } };
  const s = await f.auth(); s.message(groupRequest({ action: 'CLOSE_GROUP', container: 'work' })); await flush();
  assert.deepEqual(f.calls.find(c => c[0] === 'remove'), ['remove', [1]]);
  assert.equal(s.sent.at(-1).closed, 1);
});
test('group creation does not reuse a same-name group from another container', async () => {
  const f = withGroups(fixture([tab(1, 'https://one.test/', { cookieStoreId: 'firefox-container-1' }), tab(2, 'https://other.test/', { groupId: 8, cookieStoreId: 'firefox-container-2' })]), [{ id: 8, title: 'Work', windowId: 10 }]);
  f.api.contextualIdentities = { async query() { return [{ name: 'work', cookieStoreId: 'firefox-container-1' }]; } };
  const s = await f.auth(); s.message(groupRequest({ urls: ['https://one.test/'], container: 'work' })); await flush(); await flush();
  assert.deepEqual(f.calls.find(c => c[0] === 'group')[1], { tabIds: [1], createProperties: { windowId: 10 } });
});
test('inventory groups are bounded, private-filtered and optional for legacy tabs', () => {
  const tabs = [tab(1, 'https://one.test/', { groupId: 8 }), tab(2, 'https://private.test/', { groupId: 8, incognito: true }), tab(3, 'https://plain.test/', { groupId: -1 })];
  const snapshot = inventory(tabs, false, 200, [{ id: 8, windowId: 10, title: '😀'.repeat(80), color: 'blue', collapsed: true }]);
  assert.equal(snapshot.length, 2);
  assert.equal([...snapshot[0].groupTitle].length, 64);
  assert.equal(snapshot[0].groupColor, 'blue');
  assert.equal(snapshot[0].groupCollapsed, true);
  assert.equal(snapshot[1].groupTitle, undefined);
});
test('invalid or oversized batches do not mutate browser state', async () => {
  const f = withGroups(fixture()); const s = await f.auth();
  for (const [i, more] of [{ urls: [] }, { urls: Array(51).fill('https://one.test/') }, { urls: ['file:///secret'] }, { tab_group: { name: 'x'.repeat(65) } }].entries()) {
    s.message(groupRequest({ ...more, id: String(i) })); await flush();
    assert.equal(s.sent.at(-1).result, 'ERROR_INVALID_REQUEST');
  }
  assert.deepEqual(f.calls, []);
});
test('expired in-flight batch stops after an already-issued create; replay cannot duplicate', async () => {
  const f = withGroups(fixture()); const s = await f.auth();
  let finish;
  f.api.tabs.create = options => { f.calls.push(['create', options]); return new Promise(resolve => { finish = () => resolve(tab(99, options.url)); }); };
  s.message(groupRequest()); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  await f.tick(5000); finish(); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'group').length, 0);
  assert.equal(s.readyState, 3);
});
test('mid-batch API failure returns one error and replay does not repeat the first create', async () => {
  const f = withGroups(fixture()); const s = await f.auth();
  f.api.tabs.create = async options => { f.calls.push(['create', options]); if (f.calls.length > 1) throw Error('failed'); return tab(99, options.url); };
  const request = groupRequest(); s.message(request); await flush(); s.message(request); await flush();
  assert.equal(s.sent.at(-1).result, 'ERROR_BROWSER_API');
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 2);
});
test('private batch cancellation prevents mutations after the outstanding browser call returns', async () => {
  const f = withGroups(fixture()); const s = await f.auth();
  let finish;
  f.api.tabs.create = options => { f.calls.push(['create', options]); return new Promise(resolve => { finish = () => resolve(tab(99, options.url)); }); };
  s.message(groupRequest()); await flush();
  s.message({ action: 'CANCEL_REQUEST', id: 'group' }); finish(); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'group').length, 0);
  assert.equal(s.sent.at(-1).status, 'ERROR');
});
test('grouped Edge opens missing tabs in an eligible browser window', async () => {
  const f = withGroups(fixture([tab(1, 'https://other.test/')]));
  await f.c.start(); f.c.configure({ ...pairing, browser: 'edge' }); const s = f.sockets.at(-1); s.open(); s.message({type:'AUTH_OK'});
  s.message(groupRequest({action:'FOCUS_OR_OPEN',url:'https://one.test/',match_mode:'exact'})); await flush(); await flush();
  assert.equal(s.sent.at(-1).result,'OPENED_NEW_TAB');
  assert.equal(f.calls.filter(c=>c[0]==='group').length,1);
});
