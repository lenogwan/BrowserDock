const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const encoder = new TextEncoder();

export function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay, ...args) => globalThis.setTimeout(callback, delay, ...args),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
}

export function validPairing(value) {
  return !!value && ['firefox', 'mullvad', 'chrome', 'edge'].includes(value.browser)
    && typeof value.token === 'string' && UUID_V4.test(value.token)
    && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
    && (value.includePrivate === undefined || typeof value.includePrivate === 'boolean');
}

// One-click pairing codes (`BD1.<base64url_nopad(json)>`) copied from
// BrowserDock Settings, or the raw JSON body of an exported pairing file.
// Manual base64url decode (no atob/Buffer) so the same code runs in every
// browser, the AMO reviewer sandbox and node:test.
export function decodePairingCode(code) {
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

export function parsePairingInput(text) {
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

export function safeUrl(value, maxBytes = 2048) {
  if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
    || (maxBytes !== Infinity && encoder.encode(value).length > maxBytes)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export const GROUP_COLORS = { grey: '#9aa0a6', blue: '#4285f4', red: '#ea4335', yellow: '#fbbc04', green: '#34a853', pink: '#ff8bcb', purple: '#a142f4', cyan: '#24c1e0', orange: '#fa903e' };
export function nearestGroupColor(hex) {
  if (typeof hex !== 'string' || !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(hex)) return 'grey';
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(c => c + c).join('');
  const rgb = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  const color = rgb(hex);
  return Object.keys(GROUP_COLORS).sort((a, b) => {
    const distance = name => rgb(GROUP_COLORS[name]).reduce((sum, v, i) => sum + (v - color[i]) ** 2, 0);
    return distance(a) - distance(b);
  })[0];
}
export function validGroup(hint) {
  return hint && typeof hint.name === 'string' && hint.name.trim().length > 0 && [...hint.name].length <= 64
    && (hint.color == null || hint.color === '' || /^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(hint.color))
    && (hint.collapsed == null || typeof hint.collapsed === 'boolean');
}
