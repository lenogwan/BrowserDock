const captureApi = globalThis.browser ?? globalThis.chrome;
const form = document.getElementById('capture-form');
const title = document.getElementById('title');
const group = document.getElementById('group');
const save = document.getElementById('save');
const refresh = document.getElementById('refresh');
const status = document.getElementById('status');
const pageUrl = document.getElementById('page-url');
const target = document.getElementById('target');
const windowMode = document.getElementById('mode-window');
const currentMode = document.getElementById('mode-current');
const tabList = document.getElementById('tab-list');
let mode = 'current';
let quickBlocked = !!windowMode;
let selectedTabs = new Set();
let draft = null;
let busy = false;
let finished = false;

function controls() {
  title.disabled = group.disabled = save.disabled = busy || !draft || finished;
  refresh.disabled = busy || finished;
  if (windowMode) {
    save.disabled ||= quickBlocked;
    windowMode.disabled = currentMode.disabled = busy || finished;
    document.getElementById('select-tabs').disabled = busy || !draft || finished;
    if (mode === 'window') { title.disabled = true; save.disabled ||= selectedTabs.size === 0 || selectedTabs.size > 50; save.textContent = `Save ${selectedTabs.size} tabs`; }
    else save.textContent = 'Save to BrowserDock';
    for (const input of tabList.querySelectorAll('input')) input.disabled = busy || finished;
  }
}
async function load() {
  if (busy || finished) return;
  busy = true; draft = null; title.value = ''; pageUrl.textContent = ''; target.textContent = '';
  group.replaceChildren(new Option('Ungrouped', ''));
  selectedTabs.clear(); if (tabList) tabList.replaceChildren();
  controls(); status.textContent = 'Reading this tab and your public groups…';
  try {
    const result = await captureApi.runtime.sendMessage({ type: mode === 'window' ? 'BROWSERDOCK_CAPTURE_BATCH_CONTEXT' : 'BROWSERDOCK_CAPTURE_CONTEXT' });
    if (!result?.ok) throw new Error(result?.error || 'Cannot connect to BrowserDock. Check connection settings.');
    draft = result.payload;
    title.value = draft.title ?? ''; pageUrl.textContent = draft.url ?? '';
    if (mode === 'window') {
      document.getElementById('batch-help').textContent = `${draft.total} eligible public tabs. Review up to 200; save up to 50 at once.`;
      for (const item of draft.tabs) {
        const label = document.createElement('label'); label.className = 'tab-choice';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = String(item.tabId);
        checkbox.addEventListener('change', () => { if (checkbox.checked) selectedTabs.add(item.tabId); else selectedTabs.delete(item.tabId); controls(); });
        const text = document.createElement('span'); text.textContent = item.title;
        const url = document.createElement('small'); url.textContent = item.url; text.append(url);
        label.append(checkbox, text); tabList.append(label);
      }
    }
    const names = { firefox: 'Firefox', mullvad: 'Mullvad', chrome: 'Chrome', edge: 'Edge' };
    target.textContent = `Opens with ${names[draft.browser] ?? draft.browser}.`;
    for (const item of draft.groups) group.add(new Option(item.name, item.id));
    status.textContent = mode === 'window' ? 'Choose tabs and a group, then save.' : 'Choose a group, then save.';
    void restoreGroup(draft);
  } catch (error) { draft = null; status.textContent = error.message || 'Cannot read this tab. Try refreshing.'; }
  finally { busy = false; controls(); }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !draft || finished || quickBlocked || (mode === 'window' && (!selectedTabs.size || selectedTabs.size > 50))) return;
  busy = true; controls(); status.textContent = 'Saving…';
  let replyReceived = false;
  try {
    const message = mode === 'window'
      ? {type:'BROWSERDOCK_CAPTURE_BATCH_SAVE', contextId:draft.contextId, items:draft.tabs.filter(item => selectedTabs.has(item.tabId)), groupId:group.value || null}
      : { type: 'BROWSERDOCK_CAPTURE_SAVE', contextId: draft.contextId, tabId: draft.tabId, url: draft.url, title: title.value, groupId: group.value || null };
    const result = await captureApi.runtime.sendMessage(message);
    replyReceived = true;
    const validRejection = result?.ok === false && typeof result.error === 'string' && result.error.trim() && result.error.length <= 512 && (result.uncertain === undefined || typeof result.uncertain === 'boolean');
    if (validRejection) {
      finished = result?.uncertain === true;
      throw new Error(result.error);
    }
    const validSuccess = mode === 'window' ? result?.payload?.result === 'BATCH_SAVED' && Number.isInteger(result.payload.added) && result.payload.added >= 0 && Number.isInteger(result.payload.duplicates) && result.payload.duplicates >= 0 && result.payload.added + result.payload.duplicates === selectedTabs.size : ['SAVED', 'ALREADY_SAVED'].includes(result?.payload?.result);
    if (result?.ok !== true || !validSuccess) { finished = true; throw new Error('Save outcome unknown. Check BrowserDock before trying again.'); }
    finished = true;
    void rememberGroup(group.value || null);
    status.textContent = mode === 'window' ? `Saved ${result.payload.added} tab${result.payload.added === 1 ? '' : 's'}; ${result.payload.duplicates} already saved.` : result.payload.result === 'ALREADY_SAVED' ? 'This bookmark is already in that group. Nothing was changed.' : 'Saved to BrowserDock.';
  } catch (error) {
    // A rejected runtime message might have reached the desktop before the
    // background context disappeared. Never offer an automatic retry.
    if (!replyReceived) {
      finished = true; status.textContent = 'Save outcome unknown. Check BrowserDock before trying again.';
    } else status.textContent = error.message;
  } finally { busy = false; controls(); }
});
refresh.addEventListener('click', () => { groupTouched = false; void load(); });
document.getElementById('settings').addEventListener('click', () => {
  Promise.resolve(captureApi.runtime.openOptionsPage()).catch(() => { status.textContent = 'Could not open connection settings.'; });
});
async function rememberGroup(groupId) {
  try { await captureApi.storage?.local?.set?.({capturePreferences:{groupId}}); } catch { /* Saving succeeded even when preferences cannot be stored. */ }
}
let groupTouched = false;
group.addEventListener('change', () => { groupTouched = true; });
async function restoreGroup(context) {
  try {
    const data = await captureApi.storage?.local?.get('capturePreferences');
    if (draft === context && !groupTouched && !busy && !finished && context.groups.some(item => item.id === data?.capturePreferences?.groupId)) group.value = data.capturePreferences.groupId;
  } catch { /* A public group preference must not prevent capture. */ }
}
if (windowMode) {
  const switchMode = next => {
    if (busy || finished) return;
    mode = next; groupTouched = false;
    document.getElementById('single-fields').hidden = next === 'window';
    document.getElementById('batch-panel').hidden = next !== 'window';
    title.required = next === 'current';
    currentMode.setAttribute('aria-pressed', String(next === 'current'));
    windowMode.setAttribute('aria-pressed', String(next === 'window'));
    document.getElementById('heading').textContent = next === 'window' ? 'Save several tabs' : 'Save this tab';
    void load();
  };
  currentMode.addEventListener('click', () => switchMode('current'));
  windowMode.addEventListener('click', () => switchMode('window'));
  document.getElementById('select-tabs').addEventListener('click', () => {
    if (busy || finished || !draft) return;
    const clear = selectedTabs.size > 0; selectedTabs.clear();
    for (const input of tabList.querySelectorAll('input')) { input.checked = !clear && selectedTabs.size < 50; if (input.checked) selectedTabs.add(Number(input.value)); }
    document.getElementById('select-tabs').textContent = clear ? 'Select first 50' : 'Clear selection'; controls();
  });
  void captureApi.runtime.sendMessage({type:'BROWSERDOCK_QUICK_STATUS'}).then(result => { quickBlocked = result?.blocked === true; document.getElementById('quick-unknown').hidden = !quickBlocked; controls(); }).catch(()=>{quickBlocked=false;controls();});
  document.getElementById('acknowledge').addEventListener('click', () => {
    void captureApi.runtime.sendMessage({type:'BROWSERDOCK_QUICK_ACK'}).then(result => { if (result?.ok === true) { quickBlocked=false;document.getElementById('quick-unknown').hidden = true;controls(); } }).catch(()=>{});
  });
}
void load();
