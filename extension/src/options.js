const optionsApi = globalThis.browser ?? globalThis.chrome;
const form = document.getElementById('pairing-form');
const browserField = document.getElementById('browser');
const tokenField = document.getElementById('token');
const portField = document.getElementById('port');
const privateField = document.getElementById('include-private');
const status = document.getElementById('status');
const disconnectButton = document.getElementById('disconnect');
const codeField = document.getElementById('pairing-code');
const importButton = document.getElementById('import-code');
const fileField = document.getElementById('pairing-file');
const importStatus = document.getElementById('import-status');
const connectionStatus = document.getElementById('connection-status');
let editRevision = 0;
let importRevision = 0;

async function refreshConnectionStatus() {
  if (!connectionStatus) return;
  try {
    const result = await optionsApi.runtime.sendMessage({ type: 'BROWSERDOCK_STATUS' });
    const labels = {
      unpaired: 'Not paired.', connecting: 'Connecting to BrowserDock…',
      authenticating: 'Checking pairing with BrowserDock…', connected: 'Connected to BrowserDock.',
      disconnected: 'Disconnected. Check that BrowserDock is running and the pairing details are current.',
    };
    connectionStatus.textContent = labels[result?.state] ?? 'Connection status unavailable. Reload the extension if this continues.';
  } catch { connectionStatus.textContent = 'Connection status unavailable. Reload the extension if this continues.'; }
}
void refreshConnectionStatus();
setInterval(refreshConnectionStatus, 2000);

function applyPairing(pairing) {
  editRevision++;
  browserField.value = pairing.browser;
  tokenField.value = pairing.token;
  portField.value = pairing.port;
  privateField.checked = pairing.includePrivate === true;
  if (importStatus) importStatus.textContent = `Imported pairing for ${pairing.browser}. Press “Save pairing” to connect.`;
}

if (importButton) importButton.addEventListener('click', () => {
  importRevision++;
  const parsed = parsePairingInput(codeField ? codeField.value : '');
  if (!parsed.ok) {
    if (importStatus) importStatus.textContent = parsed.error;
    return;
  }
  applyPairing(parsed.pairing);
  if (codeField) codeField.value = '';
});
codeField?.addEventListener('input', () => { importRevision++; });
if (fileField) fileField.addEventListener('change', () => {
  const importing = ++importRevision;
  const file = fileField.files && fileField.files[0];
  if (!file) return;
  if (file.size > 16384) {
    if (importStatus) importStatus.textContent = 'Pairing file is too large (maximum 16 KB).';
    fileField.value = '';
    return;
  }
  const revision = ++editRevision;
  const reader = new FileReader();
  reader.onload = () => {
    if (revision !== editRevision || importing !== importRevision) return;
    const parsed = parsePairingInput(String(reader.result ?? ''));
    if (!parsed.ok) {
      if (importStatus) importStatus.textContent = parsed.error;
    } else {
      if (codeField) codeField.value = '';
      applyPairing(parsed.pairing);
    }
    fileField.value = '';
  };
  reader.onerror = () => {
    if (revision !== editRevision || importing !== importRevision) return;
    if (importStatus) importStatus.textContent = 'Could not read that file. Try again.';
    fileField.value = '';
  };
  reader.readAsText(file);
});
form.addEventListener('input', () => { editRevision++; });
form.addEventListener('change', () => { editRevision++; });
optionsApi.storage.local.get('pairing').then(({ pairing }) => {
  if (editRevision || !validPairing(pairing)) return;
  browserField.value = pairing.browser; tokenField.value = pairing.token; portField.value = pairing.port;
  privateField.checked = pairing.includePrivate === true;
  status.textContent = 'Pairing details loaded. Save after making changes.';
}).catch(() => { status.textContent = 'Could not read pairing details. Try reopening this page.'; });

let saving = false;
browserField.addEventListener('change', () => {
  // Mullvad Browser is always private: tab inventory and tab focusing stay
  // empty until the private opt-in is enabled, so pre-check it on selection.
  // The user can still uncheck it explicitly before saving.
  if (browserField.value === 'mullvad') privateField.checked = true;
});
form.addEventListener('submit', async event => {
  event.preventDefault(); if (saving) return;
  editRevision++;
  const pairing = { browser: browserField.value, token: tokenField.value.trim(), port: Number(portField.value), includePrivate: privateField.checked };
  if (!validPairing(pairing)) { status.textContent = 'Choose a browser, paste a valid pairing token, and enter the port from BrowserDock Settings → Connect your browsers (or use Import above).'; return; }
  saving = true; disconnectButton.disabled = true;
  try {
    await optionsApi.storage.local.set({ pairing });
    status.textContent = 'Pairing saved. The companion will connect when BrowserDock is running.';
  } catch { status.textContent = 'Could not save pairing. Try again.'; }
  finally { saving = false; disconnectButton.disabled = false; }
});
disconnectButton.addEventListener('click', async () => {
  if (saving) return;
  saving = true; editRevision++; disconnectButton.disabled = true;
  try {
    await optionsApi.storage.local.remove('pairing');
    if (codeField) codeField.value = '';
    if (fileField) fileField.value = '';
    if (importStatus) importStatus.textContent = '';
    form.reset(); status.textContent = 'Pairing forgotten. This browser is disconnected.';
  } catch { status.textContent = 'Could not forget pairing. Try again.'; }
  finally { saving = false; disconnectButton.disabled = false; }
});
