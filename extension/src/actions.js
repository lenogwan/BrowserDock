import { safeUrl, validGroup, nearestGroupColor } from './protocol.js';

export function installActions(prototype) {
  Object.assign(prototype, {
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
      try {
        created = await this.api.tabs.create({ url: target.href, active: true, windowId: window.id, ...(cookieStoreId ? { cookieStoreId } : {}) });
      } catch {
        // Creation through a stale background-only Edge window rejects
        // without creating a tab, so handing off for process launch cannot
        // duplicate anything. Other browsers keep the API error.
        if (ctx.pairing.browser === 'edge') return error('ERROR_NO_BROWSER_WINDOW');
        throw new Error('tab create failed');
      }
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
  },

  checkRequest(ctx, request) {
    const failure = this.requestError(ctx, request);
    if (failure) throw new Error(failure);
  },

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
  },

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
  },

  async openGroup(ctx, request) {
    const error = result => ({ id: request.id, status: 'ERROR', result });
    if (!Array.isArray(request.urls) || !request.urls.length || request.urls.length > 50 || request.urls.some(url => !safeUrl(url)) || !validGroup(request.tab_group)) return error('ERROR_INVALID_REQUEST');
    const { cookieStoreId, windows } = await this.groupContext(ctx, request);
    // Edge can keep the companion alive after its last window closes. Hand
    // off before any tab operation so the dock can safely launch Edge
    // instead of failing window creation in that background-only state.
    if (ctx.pairing.browser === 'edge' && !windows.length) {
      this.checkRequest(ctx, request);
      return error('ERROR_NO_BROWSER_WINDOW');
    }
    const preferPrivate = ctx.pairing.includePrivate === true && ctx.pairing.browser === 'mullvad';
    const preferred = windows.filter(w => !!w.incognito === preferPrivate);
    const choices = preferred.length ? preferred : windows;
    let window = choices.find(w => w.focused) ?? this.recentWindows.map(id => choices.find(w => w.id === id)).find(Boolean) ?? choices[0];
    if (!window) {
      this.checkRequest(ctx, request);
      window = await this.api.windows.create({ incognito: preferPrivate && !cookieStoreId, focused: true });
    }
    this.checkRequest(ctx, request);
    let all;
    try {
      all = await this.api.tabs.query({ windowId: window.id });
    } catch {
      // A hidden/background-only Edge process can reject tab inventory even
      // though windows.getAll returned a stale window record. Hand off before
      // any mutation, mirroring focus().
      if (ctx.pairing.browser === 'edge') return error('ERROR_NO_BROWSER_WINDOW');
      throw new Error('tab query failed');
    }
    this.checkRequest(ctx, request);
    const tabs = [];
    // A stale background-only Edge window can serve inventory yet reject
    // creation. Track whether anything was created: handing off before the
    // first mutation cannot duplicate tabs, while a later failure is
    // genuinely ambiguous and must stay an error.
    let createdAny = false;
    for (const url of [...new Set(request.urls.map(url => safeUrl(url).href))]) {
      let tab = all.find(t => t.windowId === window.id && !t.pinned && (!t.incognito || ctx.pairing.includePrivate === true) && (cookieStoreId ? t.cookieStoreId === cookieStoreId : !t.cookieStoreId || ['firefox-default', 'firefox-private'].includes(t.cookieStoreId)) && safeUrl(t.url)?.href === url);
      if (!tab) {
        this.checkRequest(ctx, request);
        try {
          tab = await this.api.tabs.create({ windowId: window.id, url, active: false, ...(cookieStoreId ? { cookieStoreId } : {}) });
        } catch {
          if (ctx.pairing.browser === 'edge' && !createdAny) return error('ERROR_NO_BROWSER_WINDOW');
          throw new Error('tab create failed');
        }
        createdAny = true;
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
  },

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
  },

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
  });
}
