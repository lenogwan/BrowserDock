import { safeUrl, encoder } from './protocol.js';

function captureError(message, uncertain = false) {
  return Object.assign(new Error(message), { uncertain });
}

function captureTitle(tab) {
  let title = '', bytes = 0;
  for (const char of (tab.title?.trim() || new URL(tab.url).hostname)) {
    bytes += encoder.encode(char).length;
    if (bytes > 512) break;
    title += char;
  }
  return title;
}
function tabContainer(tab, browser) {
  return ['firefox', 'mullvad'].includes(browser) && typeof tab.cookieStoreId === 'string' && !['firefox-default', 'firefox-private'].includes(tab.cookieStoreId) ? tab.cookieStoreId : null;
}
function validBatchReply(payload) {
  return payload?.result === 'BATCH_SAVED' && Number.isInteger(payload.added) && payload.added >= 0 && Number.isInteger(payload.duplicates) && payload.duplicates >= 0 && payload.added + payload.duplicates >= 1 && payload.added + payload.duplicates <= 50;
}

export function installCapture(prototype) {
  prototype.captureRequest = function (ctx, action, payload = {}) {
    if (!this.current(ctx)) return Promise.reject(captureError('Connect this browser to BrowserDock first.'));
    if (!ctx.capture) return Promise.reject(captureError('Update and restart BrowserDock to enable bookmark capture.'));
    if (ctx.capturePending.size >= 4) return Promise.reject(captureError('Another capture is in progress.'));
    const id = this.uuid();
    if (ctx.capturePending.has(id)) return Promise.reject(captureError('Another capture is in progress.'));
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        ctx.capturePending.delete(id);
        reject(captureError(['CAPTURE_SAVE', 'CAPTURE_BATCH'].includes(action) ? 'Save outcome unknown. Check BrowserDock before trying again.' : 'BrowserDock did not respond. Try refreshing.', ['CAPTURE_SAVE', 'CAPTURE_BATCH'].includes(action)));
      }, 6000);
      ctx.capturePending.set(id, { resolve, reject, timer, saving: ['CAPTURE_SAVE', 'CAPTURE_BATCH'].includes(action), batch: action === 'CAPTURE_BATCH', batchCount: payload.items?.length });
      if (!this.send(ctx, { action, id, ...payload })) {
        this.clock.clearTimeout(timer); ctx.capturePending.delete(id);
        reject(captureError('Connection lost. Check BrowserDock before trying again.', ['CAPTURE_SAVE', 'CAPTURE_BATCH'].includes(action)));
      }
    });
  };

  prototype.captureReply = function (ctx, data) {
    const pending = ctx.capturePending.get(data.id);
    if (!pending) return;
    ctx.capturePending.delete(data.id); this.clock.clearTimeout(pending.timer);
    if (data.ok === true && (!pending.saving || (pending.batch ? validBatchReply(data.payload) && data.payload.added + data.payload.duplicates === pending.batchCount : ['SAVED', 'ALREADY_SAVED'].includes(data.payload?.result)))) {
      pending.resolve(data.payload);
    } else if (data.ok === false && typeof data.error === 'string' && data.error.trim() && data.error.length <= 512 && (data.uncertain === undefined || typeof data.uncertain === 'boolean')) {
      pending.reject(captureError(data.error, data.uncertain === true));
    } else {
      pending.reject(captureError(pending.saving ? 'Save outcome unknown. Check BrowserDock before trying again.' : 'BrowserDock returned an invalid capture reply. Try refreshing.', pending.saving));
    }
  };

  prototype.captureTab = async function (message) {
    const ctx = this.connection;
    if (!ctx || !this.current(ctx)) throw captureError('Connect this browser to BrowserDock first.');
    if (message.type === 'BROWSERDOCK_CAPTURE_BATCH_SAVE') {
      if (!ctx.captureBatch) throw captureError('Update BrowserDock to save several tabs.');
      if (message.contextId !== ctx.captureContextId) throw captureError('Connection changed. Refresh before saving.');
      if (!Array.isArray(message.items) || !message.items.length || message.items.length > 50) throw captureError('Select between 1 and 50 tabs.');
      if (message.groupId !== null && (typeof message.groupId !== 'string' || !message.groupId || message.groupId.length > 128)) throw captureError('Choose an existing group.');
      const items = [], ids = new Set();
      for (const selected of message.items) {
        if (!Number.isSafeInteger(selected.tabId) || ids.has(selected.tabId)) throw captureError('Invalid tab selection.');
        ids.add(selected.tabId);
        let tab;
        try { tab = await this.api.tabs.get(selected.tabId); } catch { throw captureError('A selected tab closed. Refresh before saving.'); }
        if (!this.current(ctx)) throw captureError('Connection changed. Refresh before saving.');
        if (tab.incognito !== false || !safeUrl(tab.url) || selected.url !== tab.url) throw captureError('A selected tab changed or became private. Refresh before saving.');
        if (typeof selected.title !== 'string' || !selected.title.trim() || encoder.encode(selected.title.trim()).length > 512) throw captureError('Enter titles up to 512 bytes.');
        items.push({ id:this.uuid(), title:selected.title.trim(), url:tab.url, container:tabContainer(tab, ctx.pairing.browser) });
      }
      return this.captureRequest(ctx, 'CAPTURE_BATCH', {group_id:message.groupId, items});
    }
    let tab;
    try {
      tab = ['BROWSERDOCK_CAPTURE_CONTEXT', 'BROWSERDOCK_CAPTURE_BATCH_CONTEXT'].includes(message.type)
        ? (await this.api.tabs.query({ active: true, currentWindow: true }))[0]
        : await this.api.tabs.get(message.tabId);
    } catch { throw captureError('This tab is no longer available. Reopen the popup.'); }
    if (!this.current(ctx)) throw captureError('Connection changed. Reopen the popup.');
    if (!tab || !Number.isSafeInteger(tab.id)) throw captureError('No active browser tab is available.');
    if (tab.incognito) throw captureError('Private-window tabs cannot be saved to public bookmarks. Use BrowserDock’s vault.');
    if (!safeUrl(tab.url)) throw captureError('Only HTTP(S) pages with URLs up to 2 KB can be captured.');
    if (['BROWSERDOCK_CAPTURE_CONTEXT', 'BROWSERDOCK_CAPTURE_BATCH_CONTEXT'].includes(message.type)) {
      const response = await this.captureRequest(ctx, 'CAPTURE_GROUPS');
      if (!this.current(ctx)) throw captureError('Connection changed. Reopen the popup.');
      ctx.captureContextId ??= this.uuid();
      if (!Array.isArray(response?.groups) || response.groups.length > 50 || response.groups.some(group => typeof group.id !== 'string' || group.id.length > 128 || typeof group.name !== 'string' || [...group.name].length > 64)) throw captureError('BrowserDock returned an invalid group list.');
      if (message.type === 'BROWSERDOCK_CAPTURE_BATCH_CONTEXT') {
        if (!ctx.captureBatch) throw captureError('Update BrowserDock to save several tabs.');
        const tabs = await this.api.tabs.query({ currentWindow:true });
        if (!this.current(ctx)) throw captureError('Connection changed. Refresh before saving.');
        const eligible = tabs.filter(t => t.incognito === false && Number.isSafeInteger(t.id) && safeUrl(t.url));
        return {contextId:ctx.captureContextId, browser:ctx.pairing.browser, groups:response.groups, tabs:eligible.slice(0, 200).map(t => ({tabId:t.id, title:captureTitle(t), url:t.url})), total:eligible.length};
      }
      return { contextId: ctx.captureContextId, tabId: tab.id, url: tab.url, title:captureTitle(tab), browser:ctx.pairing.browser, groups:response.groups };
    }
    if (message.url !== tab.url) throw captureError('The tab navigated to another page. Reopen the popup before saving.');
    if (typeof message.contextId !== 'string' || message.contextId !== ctx.captureContextId) throw captureError('Connection changed. Refresh the popup before saving.');
    if (typeof message.title !== 'string' || !message.title.trim() || encoder.encode(message.title.trim()).length > 512) throw captureError('Enter a title up to 512 bytes.');
    if (message.groupId !== null && (typeof message.groupId !== 'string' || !message.groupId || message.groupId.length > 128)) throw captureError('Choose an existing group.');
    const container = tabContainer(tab, ctx.pairing.browser);
    return this.captureRequest(ctx, 'CAPTURE_SAVE', { title: message.title.trim(), url: tab.url, group_id: message.groupId, incognito: false, container });
  };
  prototype.readPublicTabs = async function (ctx, request) {
    if (typeof request.id !== 'string' || !request.id || request.id.length > 128) return;
    if (ctx.publicReviewBusy) { this.send(ctx, {action:'PUBLIC_TABS_RESULT',id:request.id,ok:false}); return; }
    ctx.publicReviewBusy = request.id;
    const timer = this.clock.setTimeout(() => {
      if (ctx.publicReviewBusy !== request.id) return;
      ctx.publicReviewBusy = null;
      if (this.current(ctx)) this.send(ctx, {action:'PUBLIC_TABS_RESULT', id:request.id, ok:false});
    }, 5000);
    try {
      const tabs = await this.api.tabs.query({});
      if (!this.current(ctx) || ctx.publicReviewBusy !== request.id) return;
      const result = tabs.filter(t => t.incognito === false && Number.isSafeInteger(t.id) && safeUrl(t.url)).slice(0,200)
        .map(t => ({id:t.id, title:captureTitle(t), url:t.url, container:tabContainer(t,ctx.pairing.browser), incognito:false}));
      this.send(ctx, {action:'PUBLIC_TABS_RESULT', id:request.id, ok:true, tabs:result});
    } catch { if (this.current(ctx) && ctx.publicReviewBusy === request.id) this.send(ctx, {action:'PUBLIC_TABS_RESULT', id:request.id, ok:false}); }
    finally { this.clock.clearTimeout(timer); if (ctx.publicReviewBusy === request.id) ctx.publicReviewBusy = null; }
  };

  prototype.quickSave = async function () {
    if (this.quickSaving || this.quickSaveUncertain) return;
    this.quickSaving = true;
    this.clock.clearTimeout(this.quickBadgeTimer);
    const ctx = this.connection;
    const badge = (text, title) => {
      const action = this.api.action;
      void Promise.resolve(action?.setBadgeText({text})).catch(()=>{});
      void Promise.resolve(action?.setTitle({title})).catch(()=>{});
    };
    try {
      const draft = await this.captureTab({type:'BROWSERDOCK_CAPTURE_CONTEXT'});
      let preferences, timer;
      try {
        const data = await Promise.race([this.api.storage.local.get('capturePreferences'), new Promise(resolve => { timer = this.clock.setTimeout(() => resolve(null), 1000); })]);
        preferences = data?.capturePreferences;
      } catch {} finally { this.clock.clearTimeout(timer); }
      if (!this.current(ctx)) throw captureError('Connection changed.');
      const groupId = draft.groups.some(g => g.id === preferences?.groupId) ? preferences.groupId : null;
      const result = await this.captureTab({type:'BROWSERDOCK_CAPTURE_SAVE', ...draft, groupId});
      badge(result.result === 'ALREADY_SAVED' ? 'Same' : 'Saved', result.result === 'ALREADY_SAVED' ? 'Already saved in BrowserDock' : 'Saved to BrowserDock');
      this.clock.clearTimeout(this.quickBadgeTimer);
      this.quickBadgeTimer = this.clock.setTimeout(() => badge('', 'Save this tab to BrowserDock'), 5000);
    } catch (error) {
      this.quickSaveUncertain = error.uncertain === true;
      badge(this.quickSaveUncertain ? '?' : '!', this.quickSaveUncertain ? 'Save outcome unknown. Check BrowserDock; reopen the popup to acknowledge.' : error.message);
    } finally { this.quickSaving = false; }
  };

}
