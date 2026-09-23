import { defaultClock, validPairing } from './protocol.js';
import { inventory } from './inventory.js';
import { installActions } from './actions.js';

export class Companion {
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

}

installActions(Companion.prototype);
