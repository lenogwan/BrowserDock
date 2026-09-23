import test from "node:test";
import assert from "node:assert/strict";
import { loadRecentMap, recordRecent, saveRecentMap, RECENT_CAP } from "../src/lib/features/bookmarks/recents.js";

const mem = (initial) => {
  let store = { ...initial };
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    dump: () => ({ ...store }),
  };
};

test("recent map loads newest-first, capped, tolerating corrupt payloads", () => {
  const storage = mem({
    "browserdock:recentlyOpened:v1": JSON.stringify({ a: 10, b: 30, c: 20, bad: "x", neg: -5 }),
  });
  const map = loadRecentMap(storage);
  assert.deepEqual([...map.keys()], ["b", "c", "a"]);
  assert.deepEqual(loadRecentMap(mem()), new Map());
  assert.deepEqual(loadRecentMap(mem({ "browserdock:recentlyOpened:v1": "{nope" })), new Map());
  assert.deepEqual(loadRecentMap(undefined), new Map());
});

test("record prunes oldest beyond the cap and save round-trips", () => {
  const map = new Map([["old", 1]]);
  for (let i = 0; i < RECENT_CAP + 5; i++) recordRecent(map, `id-${i}`, 100 + i);
  assert.equal(map.size, RECENT_CAP);
  assert.ok(!map.has("old"));
  assert.ok(map.has(`id-${RECENT_CAP + 4}`));
  const storage = mem();
  saveRecentMap(map, storage);
  assert.deepEqual(loadRecentMap(storage), map);
  assert.doesNotThrow(() => saveRecentMap(map, undefined));
  recordRecent(map, "", 999);
  assert.equal(map.size, RECENT_CAP);
});
