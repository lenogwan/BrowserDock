import { defaultClock, validPairing } from './protocol.js';
import { inventory } from './inventory.js';
import { installActions } from './actions.js';
import { installCapture } from './capture.js';

const HEARTBEAT_INTERVAL = 20000, HEARTBEAT_TIMEOUT = 90000, PROBE_TIMEOUT = 5000;
const STABLE_CONNECTION = 60000;

export class Companion {
  // Timer functions are WebIDL methods: Firefox throws when they are invoked
  // with a plain-object receiver, so the default clock delegates with the
  // global scope as receiver. Chrome tolerates the unbound form, which is why
  // this only ever broke Gecko. Injected test clocks are used as-is.
  constructor(api, transport, clock = defaultClock(), uuid = () => crypto.randomUUID()) {
    this.api = api; this.transport = transport; this.clock = clock; this.uuid = uuid;
    this.connection = null; this.pairing = null; this.revision = 0;
    this.recentWindows = []; this.status = 'unpaired';
    this.reconnectTimer = null; this.syncTimer = null; this.heartbeatTimer = null; this.heartbeatProbeTimer = null;
    this.reconnectFailures = 0;
    this.diagnostics = []; this.diagnosticWrites = Promise.resolve(); this.outageStarted = null;
    this.diagnosticsLoading = false; this.diagnosticsDirty = false; this.diagnosticWriting = false;
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
      if (message?.type === 'BROWSERDOCK_STATUS' && sender.id === this.api.runtime.id) reply({ state: this.status, diagnostics: this.diagnostics });
      if (['BROWSERDOCK_CAPTURE_CONTEXT', 'BROWSERDOCK_CAPTURE_SAVE'].includes(message?.type) && sender.id === this.api.runtime.id && sender.url === this.api.runtime.getURL('capture.html')) {
        this.captureTab(message).then(payload => reply({ ok: true, payload }), error => reply({ ok: false, error: error.message, uncertain: error.uncertain === true }));
        return true;
      }
    });
    this.api.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === 'browserdock-reconnect') { this.maintainConnection(); this.scheduleSync(); }
    });
    for (const name of ['onCreated', 'onUpdated', 'onRemoved']) this.api.contextualIdentities?.[name]?.addListener(() => { const ctx = this.connection; if (ctx && this.current(ctx)) void this.syncContainers(ctx); });
    this.api.runtime.onStartup.addListener(() => this.connect());
    this.api.runtime.onInstalled.addListener(() => this.connect());
    // Alarms survive worker suspension; recreate on every worker start/browser restart.
    Promise.resolve(this.api.alarms.create('browserdock-reconnect', { periodInMinutes: 1 })).catch(() => {});
    const revision = this.revision;
    // Optional diagnostics must not serialize pairing behind slow session storage.
    void this.loadDiagnostics();
    this.record('background_start');
    try {
      const data = await this.api.storage.local.get('pairing');
      if (revision === this.revision) this.configure(data.pairing);
    } catch { /* Remain unpaired when storage is unavailable. */ }
  }

  async loadDiagnostics() {
    this.diagnosticsLoading = true;
    let timer;
    try {
      const saved = await Promise.race([
        this.api.storage.session?.get('connectionDiagnostics'),
        new Promise(resolve => { timer = this.clock.setTimeout(() => resolve(null), 5000); })
      ]);
      const history = Array.isArray(saved?.connectionDiagnostics) ? saved.connectionDiagnostics : [];
      const valid = history.filter(entry => entry &&
        Number.isFinite(entry.at) && ['background_start', 'connected', 'socket_closed', 'socket_error', 'connect_failed', 'auth_timeout', 'heartbeat_timeout', 'command_timeout', 'backpressure', 'send_failed', 'request_limit', 'heartbeat_probe', 'background_delayed'].includes(entry.reason)
      ).slice(-49).map(({ at, reason, durationMs }) => ({ at, reason, ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}) }));
      // Preserve events recorded while the history read was pending.
      this.diagnostics = [...valid, ...this.diagnostics].slice(-50);
    } catch { /* Diagnostics must never prevent connecting. */ }
    finally {
      this.clock.clearTimeout(timer);
      this.diagnosticsLoading = false;
      this.persistDiagnostics();
    }
  }

  record(reason, durationMs) {
    this.diagnostics.push({ at: this.clock.now(), reason, ...(durationMs === undefined ? {} : { durationMs: Math.max(0, durationMs) }) });
    this.diagnostics = this.diagnostics.slice(-50);
    this.diagnosticsDirty = true;
    this.persistDiagnostics();
  }

  persistDiagnostics() {
    if (this.diagnosticsLoading || this.diagnosticWriting || !this.diagnosticsDirty) return;
    this.diagnosticWriting = true;
    // At most one write is in flight. Slow storage retains only the latest
    // bounded memory log, instead of a promise/snapshot for every event.
    this.diagnosticWrites = (async () => {
      try {
        while (this.diagnosticsDirty) {
          this.diagnosticsDirty = false;
          try { await this.api.storage.session?.set({ connectionDiagnostics: this.diagnostics.slice() }); }
          catch { /* Keep the memory log when session storage is unavailable. */ }
        }
      } finally { this.diagnosticWriting = false; }
    })();
  }

  configure(pairing) {
    this.revision++;
    this.reconnectFailures = 0;
    this.outageStarted = null;
    this.pairing = validPairing(pairing) ? { ...pairing } : null;
    this.disconnect(); this.connect();
    if (!this.pairing) this.status = 'unpaired';
  }

  disconnect() {
    const previous = this.connection; this.connection = null;
    for (const key of ['reconnectTimer', 'syncTimer', 'heartbeatTimer', 'heartbeatProbeTimer']) {
      this.clock.clearTimeout(this[key]); this[key] = null;
    }
    if (previous) {
      for (const pending of previous.capturePending.values()) {
        this.clock.clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error(pending.saving ? 'Save outcome unknown. Check BrowserDock before trying again.' : 'Connection lost. Try refreshing.'), { uncertain: pending.saving }));
      }
      previous.capturePending.clear();
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
    catch { this.record('connect_failed'); this.retry(); return; }
    const ctx = { socket, pairing: this.pairing, authenticated: false, started: this.clock.now(), seen: new Map(), cancelled: new Set(), pending: 0, pong: this.clock.now(), syncDirty: false, queue: Promise.resolve(), commandTimers: new Set(), lastSnapshot: null, paged: false };
    this.connection = ctx;
    ctx.capturePending = new Map(); ctx.capture = false;
    this.status = 'connecting';
    ctx.authTimer = this.clock.setTimeout(() => { if (this.connection === ctx) this.drop(ctx, 'auth_timeout'); }, 5000);
    socket.onopen = () => {
      if (this.connection !== ctx) return;
      this.status = 'authenticating';
      this.send(ctx, { type: 'AUTH', token: ctx.pairing.token, browser: ctx.pairing.browser, instance_id: this.uuid(), capabilities: ['tab_groups_v1'] });
    };
    socket.onmessage = event => this.receive(ctx, event.data);
    socket.onerror = () => this.drop(ctx, 'socket_error');
    socket.onclose = () => {
      if (this.connection !== ctx) return;
      this.drop(ctx, 'socket_closed');
    };
  }

  retry() {
    if (this.pairing && this.reconnectTimer === null) {
      this.status = 'reconnecting';
      const delay = Math.min(30000, 3000 * 2 ** this.reconnectFailures);
      this.reconnectFailures = Math.min(4, this.reconnectFailures + 1);
      this.reconnectTimer = this.clock.setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    }
  }

  maintainConnection() {
    const ctx = this.connection;
    if (!ctx) { this.connect(); return; }
    // Timers can be suspended while an MV3 background context is idle or the
    // machine sleeps. The browser alarm is an independent recovery path: it
    // must not let a half-open WebSocket block connect() indefinitely.
    if (!this.current(ctx)) {
      if (ctx.socket.readyState > 1 || this.clock.now() - ctx.started >= 5000) { this.drop(ctx, 'auth_timeout'); this.connect(); }
      return;
    }
    // An alarm can recover a probe whose timer was suspended. Otherwise a
    // stale heartbeat gets one fresh reply window before declaring an outage.
    if (ctx.heartbeatProbe != null && this.clock.now() - ctx.heartbeatProbe >= PROBE_TIMEOUT) {
      this.drop(ctx, 'heartbeat_timeout'); this.connect(); return;
    }
    this.checkHeartbeat(ctx);
  }

  drop(ctx, reason = 'socket_closed') {
    if (this.connection === ctx) {
      this.record(reason);
      this.outageStarted ??= this.clock.now();
      this.disconnect(); this.retry();
    }
  }

  send(ctx, message) {
    if (this.connection !== ctx || ctx.socket.readyState !== 1) return false;
    try {
      if (ctx.socket.bufferedAmount > 1024 * 1024) { this.drop(ctx, 'backpressure'); return false; }
      ctx.socket.send(JSON.stringify(message));
      return true;
    } catch { this.drop(ctx, 'send_failed'); return false; }
  }

  receive(ctx, raw) {
    if (this.connection !== ctx || typeof raw !== 'string' || raw.length > 16384) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (!ctx.authenticated) {
      if (data.type === 'AUTH_OK') {
        ctx.authenticated = true; ctx.authenticatedAt = this.clock.now(); ctx.pong = this.clock.now(); this.clock.clearTimeout(ctx.authTimer);
        ctx.paged = Array.isArray(data.capabilities) && data.capabilities.includes('paged_tabs_v1');
        ctx.capture = Array.isArray(data.capabilities) && data.capabilities.includes('capture_public_v1');
        this.status = 'connected';
        this.record('connected', this.outageStarted === null ? undefined : this.clock.now() - this.outageStarted);
        this.outageStarted = null;
        this.scheduleSync(); this.heartbeat(ctx); void this.syncContainers(ctx);
      }
      return;
    }
    if (data.action === 'CAPTURE_RESULT') { this.captureReply(ctx, data); return; }
    if (data.action === 'CANCEL_REQUEST') { if (ctx.seen.has(data.id) && ctx.seen.get(data.id) === null) ctx.cancelled.add(data.id); return; }
    if (data.action === 'CONTAINERS_LIST') { void this.syncContainers(ctx); return; }
    if (data.action === 'PONG') {
      ctx.pong = this.clock.now(); ctx.heartbeatProbe = null;
      this.clock.clearTimeout(this.heartbeatProbeTimer); this.heartbeatProbeTimer = null;
      // Brief connections must not reset backoff and create a tight flap loop.
      if (ctx.pong - ctx.authenticatedAt >= STABLE_CONNECTION) this.reconnectFailures = 0;
      return;
    }
    if (!['FOCUS_OR_OPEN', 'CLOSE_TABS', 'OPEN_GROUP', 'CLOSE_GROUP'].includes(data.action) || typeof data.id !== 'string' || !data.id.length || data.id.length > 128) return;
    if (ctx.seen.has(data.id)) {
      const response = ctx.seen.get(data.id); if (response) this.send(ctx, response);
      return;
    }
    // Never evict IDs on a live connection: eviction could execute a replay twice.
    if (ctx.seen.size >= 1024 || ctx.pending >= 32) { this.drop(ctx, 'request_limit'); return; }
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
          timer = this.clock.setTimeout(() => this.drop(ctx, 'command_timeout'), data.expiresAt - this.clock.now());
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

  checkHeartbeat(ctx) {
    if (!this.current(ctx)) return false;
    if (ctx.heartbeatProbe != null) return true;
    if (this.clock.now() - ctx.pong < HEARTBEAT_TIMEOUT) {
      const sent = this.send(ctx, { action: 'PING' });
      if (sent) void this.keepGeckoActive(ctx);
      return sent;
    }
    // A delayed callback may run before an already queued PONG. Check the
    // live socket with a fresh ping rather than closing on the old timestamp.
    ctx.heartbeatProbe = this.clock.now(); this.record('heartbeat_probe');
    if (!this.send(ctx, { action: 'PING' })) return false;
    void this.keepGeckoActive(ctx);
    this.heartbeatProbeTimer = this.clock.setTimeout(() => {
      if (this.current(ctx) && ctx.heartbeatProbe != null) this.drop(ctx, 'heartbeat_timeout');
    }, PROBE_TIMEOUT);
    return true;
  }

  async keepGeckoActive(ctx) {
    // Gecko MV3 event pages reset idle on parent extension API calls, unlike
    // Chromium's WebSocket activity keepalive. No storage write or permission
    // is needed; discard platform info and coalesce stalled calls globally.
    if (!this.current(ctx) || !['firefox', 'mullvad'].includes(ctx.pairing.browser)
      || this.lifecyclePending || !this.api.runtime.getPlatformInfo) return;
    this.lifecyclePending = true;
    try { await this.api.runtime.getPlatformInfo(); }
    catch { /* The recovery alarm still handles unloads/API failures. */ }
    finally { this.lifecyclePending = false; }
  }

  heartbeat(ctx) {
    const expected = this.clock.now() + HEARTBEAT_INTERVAL;
    this.heartbeatTimer = this.clock.setTimeout(() => {
      if (!this.current(ctx)) return;
      const delayed = this.clock.now() - expected;
      if (delayed >= 10000) this.record('background_delayed', delayed);
      if (this.checkHeartbeat(ctx)) this.heartbeat(ctx);
    }, HEARTBEAT_INTERVAL);
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
        if (!this.current(ctx)) return;
        let groups = [];
        try { groups = await this.api.tabGroups?.query({}) ?? []; } catch { /* Unsupported/disabled grouping. */ }
        if (!this.current(ctx)) return;
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
        if (this.clock.now() >= deadline) { this.drop(ctx, 'backpressure'); return false; }
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
installCapture(Companion.prototype);
