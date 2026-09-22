const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay, ...args) => globalThis.setTimeout(callback, delay, ...args),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
}

function validPairing(value) {
  return !!value && ['firefox', 'mullvad', 'chrome', 'edge'].includes(value.browser)
    && typeof value.token === 'string' && UUID_V4.test(value.token)
    && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
    && (value.includePrivate === undefined || typeof value.includePrivate === 'boolean');
}

// One-click pairing codes (`BD1.<base64url_nopad(json)>`) copied from
// BrowserDock Settings, or the raw JSON body of an exported pairing file.
// Manual base64url decode (no atob/Buffer) so the same code runs in every
// browser, the AMO reviewer sandbox and node:test.
function decodePairingCode(code) {
  const values = [];
  for (const character of code) {
    const point = character.codePointAt(0);
    let value;
    if (point >= 65 && point <= 90) value = point - 65;
    else if (point >= 97 && point <= 122) value = point - 97 + 26;
    else if (point >= 48 && point <= 57) value = point - 48 + 52;
    else if (character === '-') value = 62;
    else if (character === '_') value = 63;
    else throw new Error('invalid base64url');
    values.push(value);
  }
  if (values.length % 4 === 1) throw new Error('invalid length');
  const bytes = [];
  for (let i = 0; i < values.length; i += 4) {
    const chunk = values.slice(i, i + 4);
    const n = chunk.length === 4 ? (chunk[0] << 18) | (chunk[1] << 12) | (chunk[2] << 6) | chunk[3]
      : chunk.length === 3 ? (chunk[0] << 18) | (chunk[1] << 12) | (chunk[2] << 6)
      : (chunk[0] << 18) | (chunk[1] << 12);
    bytes.push((n >> 16) & 255);
    if (chunk.length > 2) bytes.push((n >> 8) & 255);
    if (chunk.length > 3) bytes.push(n & 255);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function parsePairingInput(text) {
  if (typeof text === 'string' && text.length > 16384) return { ok: false, error: 'Pairing data is too large (maximum 16 KB).' };
  const trimmed = String(text ?? '').trim();
  if (encoder.encode(trimmed).length > 16384) return { ok: false, error: 'Pairing data is too large (maximum 16 KB).' };
  if (!trimmed) return { ok: false, error: 'Paste a pairing code or pairing file first.' };
  let jsonText = trimmed;
  if (trimmed.startsWith('BD1.')) {
    try {
      jsonText = decodePairingCode(trimmed.slice(4).trim());
    } catch {
      return { ok: false, error: 'That pairing code is not valid. Copy a fresh one from BrowserDock Settings.' };
    }
  }
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'That pairing data is not valid JSON.' };
  }
  if (!validPairing(value)) {
    return { ok: false, error: 'That pairing data is invalid. Copy a fresh code from BrowserDock Settings.' };
  }
  return {
    ok: true,
    pairing: {
      browser: value.browser,
      token: value.token,
      port: value.port,
      includePrivate: value.includePrivate === true,
    },
  };
}

function safeUrl(value, maxBytes = 2048) {
  if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
    || (maxBytes !== Infinity && encoder.encode(value).length > maxBytes)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url : null;
  } catch { return null; }
}

const GROUP_COLORS = { grey: '#9aa0a6', blue: '#4285f4', red: '#ea4335', yellow: '#fbbc04', green: '#34a853', pink: '#ff8bcb', purple: '#a142f4', cyan: '#24c1e0', orange: '#fa903e' };
function nearestGroupColor(hex) {
  if (typeof hex !== 'string' || !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(hex)) return 'grey';
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(c => c + c).join('');
  const rgb = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  const color = rgb(hex);
  return Object.keys(GROUP_COLORS).sort((a, b) => {
    const distance = name => rgb(GROUP_COLORS[name]).reduce((sum, v, i) => sum + (v - color[i]) ** 2, 0);
    return distance(a) - distance(b);
  })[0];
}
function validGroup(hint) {
  return hint && typeof hint.name === 'string' && hint.name.trim().length > 0 && [...hint.name].length <= 64
    && (hint.color == null || hint.color === '' || /^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(hint.color))
    && (hint.collapsed == null || typeof hint.collapsed === 'boolean');
}

function inventory(tabs, includePrivate = false, limit = 200, groups = []) {
  const result = [];
  for (const tab of tabs) {
    if ((tab.incognito && includePrivate !== true) || !Number.isSafeInteger(tab.id) || tab.id < 0 || !safeUrl(tab.url, Infinity)) continue;
    // The cache is a routing hint only. Actual focusing always queries the full tab URL.
    const encoded = encoder.encode(tab.url);
    let end = Math.min(encoded.length, 2048);
    if (end < encoded.length) while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
    const url = encoded.length <= 2048 ? tab.url : new TextDecoder().decode(encoded.subarray(0, end));
    if (!safeUrl(url)) continue;
    const group = groups.find(g => g.id === tab.groupId && g.windowId === tab.windowId);
    result.push({ ...(group && Number.isSafeInteger(group.id) && group.id >= 0 ? { groupId: group.id, groupTitle: [...(group.title ?? '')].slice(0, 64).join(''), groupColor: Object.hasOwn(GROUP_COLORS, group.color) ? group.color : 'grey', groupCollapsed: !!group.collapsed } : {}), id: tab.id, url, ...(typeof tab.cookieStoreId === 'string' && /^[A-Za-z0-9 _.-]{1,128}$/.test(tab.cookieStoreId) ? { cookieStoreId: tab.cookieStoreId } : {}), title: [...(typeof tab.title === 'string' ? tab.title : '')].slice(0, 256).join('') });
    if (result.length === limit) break;
  }
  return result;
}

class Companion {
  // Timer functions are WebIDL methods: Firefox throws when they are invoked
  // with a plain-object receiver, so the default clock delegates with the
  // global scope as receiver. Chrome tolerates the unbound form, which is why
  // this only ever broke Gecko. Injected test clocks are used as-is.
  constructor(api, transport, clock = defaultClock(), uuid = () => crypto.randomUUID()) {
    this.api = api; this.transport = transport; this.clock = clock; this.uuid = uuid;
    this.connection = null; this.pairing = null; this.revision = 0;
    this.recentWindows = []; this.status = 'unpaired';
    this.reconnectTimer = null; this.syncTimer = null; this.heartbeatTimer = null;
  }

  async start() {
    // Register synchronously so browser event dispatch can wake an MV3 background context.
    this.api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.pairing) this.configure(changes.pairing.newValue);
    });
    for (const name of ['onCreated', 'onRemoved', 'onAttached', 'onDetached', 'onReplaced']) {
      this.api.tabs[name].addListener(() => this.scheduleSync());
    }
    this.api.tabs.onUpdated.addListener((_id, change) => {
      if (!change || ['url', 'title', 'status', 'cookieStoreId', 'groupId'].some(key => key in change)) this.scheduleSync();
    });
    for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) this.api.tabGroups?.[name]?.addListener(() => this.scheduleSync());
    this.api.windows.onFocusChanged?.addListener(id => {
      if (Number.isSafeInteger(id) && id >= 0) this.recentWindows = [id, ...this.recentWindows.filter(w => w !== id)].slice(0, 100);
    });
    this.api.runtime.onMessage?.addListener((message, sender, reply) => {
      if (message?.type === 'BROWSERDOCK_STATUS' && sender.id === this.api.runtime.id) reply({ state: this.status });
    });
    this.api.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === 'browserdock-reconnect') { this.connect(); this.scheduleSync(); }
    });
    for (const name of ['onCreated', 'onUpdated', 'onRemoved']) this.api.contextualIdentities?.[name]?.addListener(() => { const ctx = this.connection; if (ctx && this.current(ctx)) void this.syncContainers(ctx); });
    this.api.runtime.onStartup.addListener(() => this.connect());
    this.api.runtime.onInstalled.addListener(() => this.connect());
    // Alarms survive worker suspension; recreate on every worker start/browser restart.
    Promise.resolve(this.api.alarms.create('browserdock-reconnect', { periodInMinutes: 1 })).catch(() => {});
    const revision = this.revision;
    try {
      const data = await this.api.storage.local.get('pairing');
      if (revision === this.revision) this.configure(data.pairing);
    } catch { /* Remain unpaired when storage is unavailable. */ }
  }

  configure(pairing) {
    this.revision++;
    this.pairing = validPairing(pairing) ? { ...pairing } : null;
    this.disconnect(); this.connect();
    if (!this.pairing) this.status = 'unpaired';
  }

  disconnect() {
    const previous = this.connection; this.connection = null;
    for (const key of ['reconnectTimer', 'syncTimer', 'heartbeatTimer']) {
      this.clock.clearTimeout(this[key]); this[key] = null;
    }
    if (previous) {
      this.clock.clearTimeout(previous.authTimer);
      for (const timer of previous.commandTimers) this.clock.clearTimeout(timer);
      previous.socket.close();
    }
    this.status = this.pairing ? 'disconnected' : 'unpaired';
  }

  current(ctx) { return this.connection === ctx && ctx.socket.readyState === 1 && ctx.authenticated; }

  requestError(ctx, request) {
    if (!this.current(ctx)) return 'ERROR_DISCONNECTED';
    if (ctx.cancelled?.has(request.id)) return 'ERROR_REQUEST_CANCELLED';
    if (this.clock.now() >= request.expiresAt) return 'ERROR_REQUEST_EXPIRED';
    return null;
  }

  connect() {
    if (!this.pairing || this.connection) return;
    this.clock.clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    let socket;
    try { socket = this.transport(`ws://127.0.0.1:${this.pairing.port}`); }
    catch { this.retry(); return; }
    const ctx = { socket, pairing: this.pairing, authenticated: false, seen: new Map(), cancelled: new Set(), pending: 0, pong: this.clock.now(), syncDirty: false, queue: Promise.resolve(), commandTimers: new Set(), lastSnapshot: null, paged: false };
    this.connection = ctx;
    this.status = 'connecting';
    ctx.authTimer = this.clock.setTimeout(() => { if (this.connection === ctx) this.drop(ctx); }, 5000);
    socket.onopen = () => {
      if (this.connection !== ctx) return;
      this.status = 'authenticating';
      this.send(ctx, { type: 'AUTH', token: ctx.pairing.token, browser: ctx.pairing.browser, instance_id: this.uuid(), capabilities: ['tab_groups_v1'] });
    };
    socket.onmessage = event => this.receive(ctx, event.data);
    socket.onerror = () => this.drop(ctx);
    socket.onclose = () => {
      if (this.connection !== ctx) return;
      this.disconnect(); this.retry();
    };
  }

  retry() {
    if (this.pairing && this.reconnectTimer === null) {
      this.reconnectTimer = this.clock.setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 3000);
    }
  }

  drop(ctx) { if (this.connection === ctx) { this.disconnect(); this.retry(); } }

  send(ctx, message) {
    if (this.connection !== ctx || ctx.socket.readyState !== 1) return false;
    try {
      if (ctx.socket.bufferedAmount > 1024 * 1024) { this.drop(ctx); return false; }
      ctx.socket.send(JSON.stringify(message));
      return true;
    } catch { this.drop(ctx); return false; }
  }

  receive(ctx, raw) {
    if (this.connection !== ctx || typeof raw !== 'string' || raw.length > 16384) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (!ctx.authenticated) {
      if (data.type === 'AUTH_OK') {
        ctx.authenticated = true; ctx.pong = this.clock.now(); this.clock.clearTimeout(ctx.authTimer);
        ctx.paged = Array.isArray(data.capabilities) && data.capabilities.includes('paged_tabs_v1');
        this.status = 'connected';
        this.scheduleSync(); this.heartbeat(ctx); void this.syncContainers(ctx);
      }
      return;
    }
    if (data.action === 'CANCEL_REQUEST') { if (ctx.seen.has(data.id) && ctx.seen.get(data.id) === null) ctx.cancelled.add(data.id); return; }
    if (data.action === 'CONTAINERS_LIST') { void this.syncContainers(ctx); return; }
    if (data.action === 'PONG') { ctx.pong = this.clock.now(); return; }
    if (!['FOCUS_OR_OPEN', 'CLOSE_TABS', 'OPEN_GROUP', 'CLOSE_GROUP'].includes(data.action) || typeof data.id !== 'string' || !data.id.length || data.id.length > 128) return;
    if (ctx.seen.has(data.id)) {
      const response = ctx.seen.get(data.id); if (response) this.send(ctx, response);
      return;
    }
    // Never evict IDs on a live connection: eviction could execute a replay twice.
    if (ctx.seen.size >= 1024 || ctx.pending >= 32) { this.drop(ctx); return; }
    ctx.seen.set(data.id, null); ctx.pending++;
    const now = this.clock.now();
    const invalidDeadline = data.deadline_ms !== undefined && (!Number.isSafeInteger(data.deadline_ms) || data.deadline_ms < 0);
    data.expiresAt = Math.min(now + 5000, data.deadline_ms ?? now + 5000);
    const handler = { CLOSE_TABS: 'close', FOCUS_OR_OPEN: 'focus', OPEN_GROUP: 'openGroup', CLOSE_GROUP: 'closeGroup' }[data.action];
    ctx.queue = ctx.queue.then(async () => {
      let response;
      let timer;
      try {
        const failure = invalidDeadline ? 'ERROR_INVALID_REQUEST' : this.requestError(ctx, data);
        if (failure) response = { id: data.id, status: 'ERROR', result: failure };
        else {
          // A timed-out API call cannot be undone. Invalidate its context so
          // it cannot issue another mutation after eventually resolving.
          timer = this.clock.setTimeout(() => this.drop(ctx), data.expiresAt - this.clock.now());
          ctx.commandTimers.add(timer);
          response = await this[handler](ctx, data);
        }
      }
      catch { response = { id: data.id, status: 'ERROR', result: 'ERROR_BROWSER_API' }; }
      finally { this.clock.clearTimeout(timer); ctx.commandTimers.delete(timer); }
      ctx.pending--;
      ctx.cancelled.delete(data.id);
      ctx.seen.set(data.id, response);
      if (this.current(ctx)) { this.send(ctx, response); this.scheduleSync(); }
    });
  }

  heartbeat(ctx) {
    this.heartbeatTimer = this.clock.setTimeout(() => {
      if (!this.current(ctx)) return;
      if (this.clock.now() - ctx.pong >= 60000) { this.drop(ctx); return; }
      this.send(ctx, { action: 'PING' }); this.heartbeat(ctx);
    }, 20000);
  }

  scheduleSync() {
    const ctx = this.connection;
    if (!ctx || !this.current(ctx)) return;
    ctx.syncDirty = true;
    if (this.syncTimer !== null) return;
    this.syncTimer = this.clock.setTimeout(async () => {
      // Keep the timer marked active across the query, then throttle the next snapshot.
      ctx.syncDirty = false;
      try {
        const tabs = await this.api.tabs.query({});
        let groups = [];
        try { groups = await this.api.tabGroups?.query({}) ?? []; } catch { /* Unsupported/disabled grouping. */ }
        const snapshot = inventory(tabs, ctx.pairing.includePrivate, ctx.paged ? 2000 : 200, groups);
        const serialized = JSON.stringify(snapshot);
        // Older servers may silently throttle received snapshots. Keep their
        // periodic refreshes so a dropped update cannot remain stale forever.
        if (this.current(ctx) && (!ctx.paged || serialized !== ctx.lastSnapshot)) {
          if (await this.sendInventory(ctx, snapshot)) ctx.lastSnapshot = serialized;
        }
      } catch { /* A later tab event or alarm retries inventory. */ }
      finally {
        if (this.connection === ctx) {
          this.syncTimer = null;
          if (ctx.syncDirty) this.scheduleSync();
        }
      }
    }, 500);
  }

  async sendInventory(ctx, tabs) {
    if (!ctx.paged) return this.send(ctx, { action: 'TABS_SYNC', browser: ctx.pairing.browser, tabs });
    const pages = Math.max(1, Math.ceil(tabs.length / 200));
    const snapshot_id = this.uuid();
    const deadline = this.clock.now() + 5000;
    for (let page = 0; page < pages; page++) {
      while (this.current(ctx) && ctx.socket.bufferedAmount > 512 * 1024) {
        if (this.clock.now() >= deadline) { this.drop(ctx); return false; }
        await new Promise(resolve => this.clock.setTimeout(resolve, 25));
      }
      if (!this.current(ctx) || !this.send(ctx, { action: 'TABS_SYNC_PAGE', browser: ctx.pairing.browser, snapshot_id, page, pages, tabs: tabs.slice(page * 200, (page + 1) * 200) })) return false;
    }
    return true;
  }

  async syncContainers(ctx) {
    if (!['firefox', 'mullvad'].includes(ctx.pairing.browser) || !this.api.contextualIdentities) return;
    try {
      const identities = await this.api.contextualIdentities.query({});
      const containers = identities.filter(c => typeof c.name === 'string' && c.name.length <= 128 && /^[A-Za-z0-9 _.-]{1,128}$/.test(c.cookieStoreId)).slice(0, 200).map(({ name, cookieStoreId }) => ({ name, cookieStoreId }));
      if (this.current(ctx)) this.send(ctx, { action: 'CONTAINERS_LIST', containers });
    } catch { /* Container support can be disabled in Gecko preferences. */ }
  }

  async focus(ctx, request) {
    const error = result => ({ id: request.id, status: 'ERROR', result });
    for (const value of [request.container, request.profile]) {
      if (value != null && (typeof value !== 'string' || !/^[A-Za-z0-9 _.-]{1,128}$/.test(value) || value === '.' || value === '..')) return error('ERROR_INVALID_REQUEST');
    }
    if (request.tab_group != null && !validGroup(request.tab_group)) return error('ERROR_INVALID_REQUEST');
    const target = safeUrl(request.url);
    if (!target || !['domain_or_exact', 'exact', 'new_tab'].includes(request.match_mode)) return error('ERROR_INVALID_REQUEST');
    if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    let edgeWindows;
    if (ctx.pairing.browser === 'edge') {
      // Edge can keep the companion alive after its last window closes.
      // Hand off before any tab operation so the dock can safely launch Edge.
      try {
        edgeWindows = await this.api.windows.getAll({ windowTypes: ['normal'] });
      } catch {
        // Chromium may reject this query while Edge is background-only.
        return error('ERROR_NO_BROWSER_WINDOW');
      }
      if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
      if (!edgeWindows.some(w => Number.isSafeInteger(w.id) && w.id >= 0 && (!w.incognito || ctx.pairing.includePrivate === true))) {
        return error('ERROR_NO_BROWSER_WINDOW');
      }
    }
    let cookieStoreId;
    if (request.container && ['firefox', 'mullvad'].includes(ctx.pairing.browser)) {
      if (typeof request.container !== 'string' || !/^[A-Za-z0-9 _.-]{1,128}$/.test(request.container)) return error('ERROR_INVALID_REQUEST');
      let identities = [];
      try { identities = await this.api.contextualIdentities?.query({}) ?? []; } catch { /* Disabled containers. */ }
      cookieStoreId = identities.find(c => c.name === request.container || c.cookieStoreId === request.container)?.cookieStoreId;
      if (!cookieStoreId) return error('ERROR_CONTAINER_NOT_FOUND');
      if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    }
    let tabs;
    try {
      tabs = await this.api.tabs.query(cookieStoreId ? { cookieStoreId } : {});
    } catch {
      // A hidden/background-only Edge process can reject tab inventory even
      // though windows.getAll returned a stale window record.
      if (ctx.pairing.browser === 'edge') return error('ERROR_NO_BROWSER_WINDOW');
      throw new Error('tab query failed');
    }
    if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    if (ctx.pairing.browser === 'edge' && tabs.length === 0) return error('ERROR_NO_BROWSER_WINDOW');
    const includePrivate = ctx.pairing.includePrivate === true;
    const candidates = tabs.filter(t => (!cookieStoreId || t.cookieStoreId === cookieStoreId) && (!t.incognito || includePrivate) && Number.isSafeInteger(t.id) && t.id >= 0 && Number.isSafeInteger(t.windowId) && t.windowId >= 0 && safeUrl(t.url, Infinity));
    let found;
    if (request.match_mode !== 'new_tab') {
      found = candidates.find(t => safeUrl(t.url, Infinity).href === target.href);
      if (!found && request.match_mode === 'domain_or_exact') found = candidates.find(t => safeUrl(t.url, Infinity).hostname === target.hostname);
    }
    if (found) {
      const note = await this.ensureTabGroup(ctx, request, [found]);
      if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
      await this.api.tabs.update(found.id, { active: true });
      if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
      await this.api.windows.update(found.windowId, { focused: true });
      return { id: request.id, status: 'SUCCESS', result: 'FOCUSED_EXISTING', note, window_id: found.windowId, tab_id: found.id };
    }
    // Edge may retain background-only/stale windows after its visible UI has
    // closed. Do not attempt tabs.create in that state; the desktop launcher
    // can start/forward the URL reliably. This response is pre-mutation.
    if (ctx.pairing.browser === 'edge' && !request.tab_group) return error('ERROR_NO_BROWSER_WINDOW');
    const windows = edgeWindows ?? await this.api.windows.getAll({ windowTypes: ['normal'] });
    if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    const preferPrivate = includePrivate && ctx.pairing.browser === 'mullvad';
    const eligible = windows.filter(w => (!cookieStoreId || !w.incognito) && (!w.incognito || includePrivate) && Number.isSafeInteger(w.id) && w.id >= 0);
    const preferred = eligible.filter(w => !!w.incognito === preferPrivate);
    const choices = preferred.length ? preferred : eligible;
    const window = choices.find(w => w.focused) ?? this.recentWindows.map(id => choices.find(w => w.id === id)).find(Boolean) ?? choices[0];
    let created;
    if (window) {
      created = await this.api.tabs.create({ url: target.href, active: true, windowId: window.id, ...(cookieStoreId ? { cookieStoreId } : {}) });
    } else if (cookieStoreId) {
      const opened = await this.api.windows.create({ incognito: false, focused: true });
      if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
      created = await this.api.tabs.create({ url: target.href, active: true, windowId: opened.id, cookieStoreId });
    } else {
      const opened = await this.api.windows.create({ url: target.href, incognito: preferPrivate, focused: true });
      if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
      created = opened.tabs?.[0];
      if (!created) {
        const openedTabs = await this.api.tabs.query({ windowId: opened.id });
        created = openedTabs.find(t => safeUrl(t.url, Infinity)?.href === target.href);
      }
    }
    if (!created || !Number.isSafeInteger(created.id) || !Number.isSafeInteger(created.windowId)) return error('ERROR_BROWSER_API');
    if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    const note = await this.ensureTabGroup(ctx, request, [created]);
    if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    await this.api.windows.update(created.windowId, { focused: true });
    return { id: request.id, status: 'SUCCESS', result: 'OPENED_NEW_TAB', note, window_id: created.windowId, tab_id: created.id };
  }

  checkRequest(ctx, request) {
    const failure = this.requestError(ctx, request);
    if (failure) throw new Error(failure);
  }

  async ensureTabGroup(ctx, request, tabs) {
    const hint = request.tab_group;
    if (!hint) return undefined;
    if (!this.api.tabGroups?.query || !this.api.tabGroups?.update || !this.api.tabs.group)
      return 'Tab groups unavailable; opened regular tabs';
    try {
      const windowId = tabs[0].windowId;
      const groups = await this.api.tabGroups.query({ windowId });
      this.checkRequest(ctx, request);
      // Never combine container identities, or mutate shared groups.
      const all = await this.api.tabs.query({ windowId });
      this.checkRequest(ctx, request);
      const store = tabs[0].cookieStoreId;
      const existing = groups.find(g => g.title === hint.name && !g.shared
        && all.filter(t => t.groupId === g.id).every(t => t.cookieStoreId === store));
      const groupId = await this.api.tabs.group({ tabIds: tabs.map(t => t.id),
        ...(existing ? { groupId: existing.id } : { createProperties: { windowId } }) });
      this.checkRequest(ctx, request);
      await this.api.tabGroups.update(groupId, { title: hint.name, color: nearestGroupColor(hint.color), collapsed: hint.collapsed ?? false });
      return undefined;
    } catch {
      this.checkRequest(ctx, request);
      // Tabs may already exist or be grouped. Never replay a failed mutation.
      return 'Tabs opened; browser could not finish tab grouping';
    }
  }

  async groupContext(ctx, request) {
    if (!validGroup(request.tab_group)) throw new Error('Invalid group');
    for (const value of [request.container, request.profile]) {
      if (value != null && (typeof value !== 'string' || !/^[A-Za-z0-9 _.-]{1,128}$/.test(value) || value === '.' || value === '..')) throw new Error('Invalid options');
    }
    let cookieStoreId;
    if (request.container && ['firefox', 'mullvad'].includes(ctx.pairing.browser)) {
      const identities = await this.api.contextualIdentities?.query({}) ?? [];
      cookieStoreId = identities.find(c => c.name === request.container || c.cookieStoreId === request.container)?.cookieStoreId;
      if (!cookieStoreId) throw new Error('Container unavailable');
    }
    this.checkRequest(ctx, request);
    const windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
    this.checkRequest(ctx, request);
    const eligible = windows.filter(w => Number.isSafeInteger(w.id) && w.id >= 0 && (!w.incognito || ctx.pairing.includePrivate === true) && (!cookieStoreId || !w.incognito));
    return { cookieStoreId, windows: eligible };
  }

  async openGroup(ctx, request) {
    const error = result => ({ id: request.id, status: 'ERROR', result });
    if (!Array.isArray(request.urls) || !request.urls.length || request.urls.length > 50 || request.urls.some(url => !safeUrl(url)) || !validGroup(request.tab_group)) return error('ERROR_INVALID_REQUEST');
    const { cookieStoreId, windows } = await this.groupContext(ctx, request);
    const preferPrivate = ctx.pairing.includePrivate === true && ctx.pairing.browser === 'mullvad';
    const preferred = windows.filter(w => !!w.incognito === preferPrivate);
    const choices = preferred.length ? preferred : windows;
    let window = choices.find(w => w.focused) ?? this.recentWindows.map(id => choices.find(w => w.id === id)).find(Boolean) ?? choices[0];
    if (!window) {
      this.checkRequest(ctx, request);
      window = await this.api.windows.create({ incognito: preferPrivate && !cookieStoreId, focused: true });
    }
    this.checkRequest(ctx, request);
    const all = await this.api.tabs.query({ windowId: window.id });
    this.checkRequest(ctx, request);
    const tabs = [];
    for (const url of [...new Set(request.urls.map(url => safeUrl(url).href))]) {
      let tab = all.find(t => t.windowId === window.id && !t.pinned && (!t.incognito || ctx.pairing.includePrivate === true) && (cookieStoreId ? t.cookieStoreId === cookieStoreId : !t.cookieStoreId || ['firefox-default', 'firefox-private'].includes(t.cookieStoreId)) && safeUrl(t.url)?.href === url);
      if (!tab) {
        this.checkRequest(ctx, request);
        tab = await this.api.tabs.create({ windowId: window.id, url, active: false, ...(cookieStoreId ? { cookieStoreId } : {}) });
      }
      tabs.push(tab);
    }
    this.checkRequest(ctx, request);
    const note = await this.ensureTabGroup(ctx, request, tabs);
    this.checkRequest(ctx, request);
    // Collapse only suppresses activation when native grouping succeeded.
    if (note || !request.tab_group.collapsed) await this.api.tabs.update(tabs[0].id, { active: true });
    this.checkRequest(ctx, request);
    await this.api.windows.update(window.id, { focused: true });
    return { id: request.id, status: 'SUCCESS', result: 'OPENED_GROUP', window_id: window.id, tab_id: tabs[0].id, note };
  }

  async closeGroup(ctx, request) {
    const error = result => ({ id: request.id, status: 'ERROR', result });
    if (!validGroup(request.tab_group)) return error('ERROR_INVALID_REQUEST');
    const { cookieStoreId, windows } = await this.groupContext(ctx, request);
    if (!this.api.tabGroups?.query) return error('ERROR_GROUPS_UNSUPPORTED');
    const groups = await this.api.tabGroups.query({});
    this.checkRequest(ctx, request);
    const ids = new Set(groups.filter(g => g.title === request.tab_group.name && !g.shared && windows.some(w => w.id === g.windowId)).map(g => g.id));
    const tabs = await this.api.tabs.query({});
    this.checkRequest(ctx, request);
    const targets = tabs.filter(t => ids.has(t.groupId) && windows.some(w => w.id === t.windowId) && (!t.incognito || ctx.pairing.includePrivate === true) && (!cookieStoreId || t.cookieStoreId === cookieStoreId) && Number.isSafeInteger(t.id) && t.id >= 0);
    if (!targets.length) return error('ERROR_TAB_NOT_FOUND');
    await this.api.tabs.remove(targets.map(t => t.id));
    return { id: request.id, status: 'SUCCESS', result: 'CLOSED_TABS', closed: targets.length };
  }

  // Close every tab matching the request (exact URL first, then hostname when
  // match_mode is domain_or_exact) within the requested container scope.
  // Mirrors focus() candidate filtering so the dock only closes tabs its
  // inventory can see; private tabs need the same explicit opt-in.
  async close(ctx, request) {
    const error = result => ({ id: request.id, status: 'ERROR', result });
    for (const value of [request.container, request.profile]) {
      if (value != null && (typeof value !== 'string' || !/^[A-Za-z0-9 _.-]{1,128}$/.test(value) || value === '.' || value === '..')) return error('ERROR_INVALID_REQUEST');
    }
    const target = safeUrl(request.url);
    if (!target || !['domain_or_exact', 'exact'].includes(request.match_mode)) return error('ERROR_INVALID_REQUEST');
    if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    let cookieStoreId;
    if (request.container && ['firefox', 'mullvad'].includes(ctx.pairing.browser)) {
      if (typeof request.container !== 'string' || !/^[A-Za-z0-9 _.-]{1,128}$/.test(request.container)) return error('ERROR_INVALID_REQUEST');
      let identities = [];
      try { identities = await this.api.contextualIdentities?.query({}) ?? []; } catch { /* Disabled containers. */ }
      cookieStoreId = identities.find(c => c.name === request.container || c.cookieStoreId === request.container)?.cookieStoreId;
      if (!cookieStoreId) return error('ERROR_CONTAINER_NOT_FOUND');
      if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    }
    let tabs;
    try {
      tabs = await this.api.tabs.query(cookieStoreId ? { cookieStoreId } : {});
    } catch {
      throw new Error('tab query failed');
    }
    if (this.requestError(ctx, request)) return error(this.requestError(ctx, request));
    const includePrivate = ctx.pairing.includePrivate === true;
    const matched = tabs.filter(t => (!cookieStoreId || t.cookieStoreId === cookieStoreId) && (!t.incognito || includePrivate) && Number.isSafeInteger(t.id) && t.id >= 0 && safeUrl(t.url, Infinity));
    const exact = matched.filter(t => safeUrl(t.url, Infinity).href === target.href);
    const targets = exact.length ? exact : (request.match_mode === 'domain_or_exact' ? matched.filter(t => safeUrl(t.url, Infinity).hostname === target.hostname) : []);
    if (!targets.length) return error('ERROR_TAB_NOT_FOUND');
    await this.api.tabs.remove(targets.map(t => t.id));
    return { id: request.id, status: 'SUCCESS', result: 'CLOSED_TABS', closed: targets.length };
  }
}

const extensionApi = globalThis.browser ?? globalThis.chrome;
if (!extensionApi?.tabs || !extensionApi?.storage || typeof WebSocket === "undefined") {
  throw new Error("BrowserDock Companion requires the tabs/storage extension APIs and WebSocket.");
}
const companion = new Companion(extensionApi, url => new WebSocket(url));
if (extensionApi.action?.onClicked) {
  extensionApi.action.onClicked.addListener(() => {
    Promise.resolve(extensionApi.runtime.openOptionsPage()).catch(() => {});
  });
}
void companion.start();
