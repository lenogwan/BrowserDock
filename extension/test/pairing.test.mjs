import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadCore() {
  const core = (await readFile(new URL('../src/core.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const ctx = vm.createContext({ TextEncoder, TextDecoder, URL });
  new vm.Script(`${core}\nglobalThis.__api = { parsePairingInput, decodePairingCode, validPairing };`).runInContext(ctx);
  return vm.runInContext('__api', ctx);
}

const token = '7d8bab34-411a-48ee-ae6c-8b1b1b110951';

function encodePairing(pairing) {
  const raw = new TextEncoder().encode(JSON.stringify(pairing));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return `BD1.${Buffer.from(binary, 'binary').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

test('pairing code round-trips through the extension parser', async () => {
  const api = await loadCore();
  for (const browser of ['firefox', 'mullvad', 'chrome', 'edge']) {
    const code = encodePairing({ browser, token, port: 49222, includePrivate: browser === 'mullvad' });
    const parsed = api.parsePairingInput(code);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.pairing.browser, browser);
    assert.equal(parsed.pairing.token, token);
    assert.equal(parsed.pairing.port, 49222);
    assert.equal(parsed.pairing.includePrivate, browser === 'mullvad');
  }
});

test('raw pairing file JSON is accepted and invalid input rejected', async () => {
  const api = await loadCore();
  const file = JSON.stringify({ browser: 'chrome', token, port: 49301 });
  const parsed = api.parsePairingInput(file);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.pairing.includePrivate, false);
  for (const bad of ['', 'BD1.!!!', 'BD1.e30', '{"browser":"safari","token":"x","port":1}', `{"browser":"chrome","token":"bad","port":1}`]) {
    assert.equal(api.parsePairingInput(bad).ok, false, JSON.stringify(bad));
  }
});

test('pairing text is bounded before decoding or parsing', async () => {
  const { parsePairingInput } = await import('../src/core.js');
  assert.equal(parsePairingInput('BD1.' + 'a'.repeat(16384)).ok, false);
  assert.match(parsePairingInput(' '.repeat(16385)).error, /too large/i);
});
