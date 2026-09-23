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
