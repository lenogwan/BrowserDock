import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryState } from '../src/lib/features/companion/recovery.js';

test('a single lost browser gets a bounded recovery indication without retaining tabs', () => {
  const connected = recoveryState({}, [{ browser: 'firefox' }, { browser: 'chrome' }], 0);
  const lost = recoveryState(connected, [{ browser: 'chrome' }], 100);
  assert.deepEqual(lost.firefox, { count: 1, since: 100 });
  assert.equal(lost.chrome.since, null);
  assert.equal(recoveryState(lost, [{ browser: 'chrome' }], 15100).firefox.since, null);
  assert.equal(recoveryState(lost, [{ browser: 'firefox' }, { browser: 'chrome' }], 200).firefox.since, null);
});

test('replacement instance clears recovery and partial multi-profile loss is visible', () => {
  const state = recoveryState({}, [{ browser: 'chrome', id: 'a' }, { browser: 'chrome', id: 'b' }], 0);
  const lost = recoveryState(state, [{ browser: 'chrome', id: 'b' }], 50);
  assert.equal(lost.chrome.since, 50);
  const restored = recoveryState(lost, [{ browser: 'chrome', id: 'b' }, { browser: 'chrome', id: 'c' }], 100);
  assert.equal(restored.chrome.since, null);
});
