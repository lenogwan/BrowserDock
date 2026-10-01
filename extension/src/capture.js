import { safeUrl, encoder } from './protocol.js';

function captureError(message, uncertain = false) {
  return Object.assign(new Error(message), { uncertain });
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
        reject(captureError(action === 'CAPTURE_SAVE' ? 'Save outcome unknown. Check BrowserDock before trying again.' : 'BrowserDock did not respond. Try refreshing.', action === 'CAPTURE_SAVE'));
      }, 6000);
      ctx.capturePending.set(id, { resolve, reject, timer, saving: action === 'CAPTURE_SAVE' });
      if (!this.send(ctx, { action, id, ...payload })) {
        this.clock.clearTimeout(timer); ctx.capturePending.delete(id);
        reject(captureError('Connection lost. Check BrowserDock before trying again.', action === 'CAPTURE_SAVE'));
      }
    });
  };

  prototype.captureReply = function (ctx, data) {
    const pending = ctx.capturePending.get(data.id);
    if (!pending) return;
    ctx.capturePending.delete(data.id); this.clock.clearTimeout(pending.timer);
    if (data.ok === true && (!pending.saving || ['SAVED', 'ALREADY_SAVED'].includes(data.payload?.result))) {
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
    let tab;
    try {
      tab = message.type === 'BROWSERDOCK_CAPTURE_CONTEXT'
        ? (await this.api.tabs.query({ active: true, currentWindow: true }))[0]
        : await this.api.tabs.get(message.tabId);
    } catch { throw captureError('This tab is no longer available. Reopen the popup.'); }
    if (!this.current(ctx)) throw captureError('Connection changed. Reopen the popup.');
    if (!tab || !Number.isSafeInteger(tab.id)) throw captureError('No active browser tab is available.');
    if (tab.incognito) throw captureError('Private-window tabs cannot be saved to public bookmarks. Use BrowserDock’s vault.');
    if (!safeUrl(tab.url)) throw captureError('Only HTTP(S) pages with URLs up to 2 KB can be captured.');
    if (message.type === 'BROWSERDOCK_CAPTURE_CONTEXT') {
      const response = await this.captureRequest(ctx, 'CAPTURE_GROUPS');
      if (!this.current(ctx)) throw captureError('Connection changed. Reopen the popup.');
      ctx.captureContextId ??= this.uuid();
      if (!Array.isArray(response?.groups) || response.groups.length > 50 || response.groups.some(group => typeof group.id !== 'string' || group.id.length > 128 || typeof group.name !== 'string' || [...group.name].length > 64)) throw captureError('BrowserDock returned an invalid group list.');
      let title = '', bytes = 0;
      for (const char of (tab.title?.trim() || new URL(tab.url).hostname)) {
        bytes += encoder.encode(char).length;
        if (bytes > 512) break;
        title += char;
      }
      return { contextId: ctx.captureContextId, tabId: tab.id, url: tab.url, title, browser: ctx.pairing.browser, groups: response.groups };
    }
    if (message.url !== tab.url) throw captureError('The tab navigated to another page. Reopen the popup before saving.');
    if (typeof message.contextId !== 'string' || message.contextId !== ctx.captureContextId) throw captureError('Connection changed. Refresh the popup before saving.');
    if (typeof message.title !== 'string' || !message.title.trim() || encoder.encode(message.title.trim()).length > 512) throw captureError('Enter a title up to 512 bytes.');
    if (message.groupId !== null && (typeof message.groupId !== 'string' || !message.groupId || message.groupId.length > 128)) throw captureError('Choose an existing group.');
    const container = ['firefox', 'mullvad'].includes(ctx.pairing.browser) && typeof tab.cookieStoreId === 'string' && !['firefox-default', 'firefox-private'].includes(tab.cookieStoreId) ? tab.cookieStoreId : null;
    return this.captureRequest(ctx, 'CAPTURE_SAVE', { title: message.title.trim(), url: tab.url, group_id: message.groupId, incognito: false, container });
  };
}
