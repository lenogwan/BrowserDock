const captureApi = globalThis.browser ?? globalThis.chrome;
const form = document.getElementById('capture-form');
const title = document.getElementById('title');
const group = document.getElementById('group');
const save = document.getElementById('save');
const refresh = document.getElementById('refresh');
const status = document.getElementById('status');
const pageUrl = document.getElementById('page-url');
const target = document.getElementById('target');
let draft = null;
let busy = false;
let finished = false;

function controls() {
  title.disabled = group.disabled = save.disabled = busy || !draft || finished;
  refresh.disabled = busy || finished;
}
async function load() {
  if (busy || finished) return;
  busy = true; draft = null; title.value = ''; pageUrl.textContent = ''; target.textContent = '';
  group.replaceChildren(new Option('Ungrouped', ''));
  controls(); status.textContent = 'Reading this tab and your public groups…';
  try {
    const result = await captureApi.runtime.sendMessage({ type: 'BROWSERDOCK_CAPTURE_CONTEXT' });
    if (!result?.ok) throw new Error(result?.error || 'Cannot connect to BrowserDock. Check connection settings.');
    draft = result.payload;
    title.value = draft.title; pageUrl.textContent = draft.url;
    const names = { firefox: 'Firefox', mullvad: 'Mullvad', chrome: 'Chrome', edge: 'Edge' };
    target.textContent = `Opens with ${names[draft.browser] ?? draft.browser}.`;
    for (const item of draft.groups) group.add(new Option(item.name, item.id));
    status.textContent = 'Choose a group, then save.';
  } catch (error) { status.textContent = error.message || 'Cannot read this tab. Try refreshing.'; }
  finally { busy = false; controls(); }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !draft || finished) return;
  busy = true; controls(); status.textContent = 'Saving…';
  let replyReceived = false;
  try {
    const result = await captureApi.runtime.sendMessage({ type: 'BROWSERDOCK_CAPTURE_SAVE', contextId: draft.contextId, tabId: draft.tabId, url: draft.url, title: title.value, groupId: group.value || null });
    replyReceived = true;
    const validRejection = result?.ok === false && typeof result.error === 'string' && result.error.trim() && result.error.length <= 512 && (result.uncertain === undefined || typeof result.uncertain === 'boolean');
    if (validRejection) {
      finished = result?.uncertain === true;
      throw new Error(result.error);
    }
    if (result?.ok !== true || !['SAVED', 'ALREADY_SAVED'].includes(result.payload?.result)) { finished = true; throw new Error('Save outcome unknown. Check BrowserDock before trying again.'); }
    finished = true;
    status.textContent = result.payload.result === 'ALREADY_SAVED' ? 'This bookmark is already in that group. Nothing was changed.' : 'Saved to BrowserDock.';
  } catch (error) {
    // A rejected runtime message might have reached the desktop before the
    // background context disappeared. Never offer an automatic retry.
    if (!replyReceived) {
      finished = true; status.textContent = 'Save outcome unknown. Check BrowserDock before trying again.';
    } else status.textContent = error.message;
  } finally { busy = false; controls(); }
});
refresh.addEventListener('click', () => { void load(); });
document.getElementById('settings').addEventListener('click', () => {
  Promise.resolve(captureApi.runtime.openOptionsPage()).catch(() => { status.textContent = 'Could not open connection settings.'; });
});
void load();
