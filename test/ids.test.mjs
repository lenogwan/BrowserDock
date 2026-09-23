import test from "node:test";
import assert from "node:assert/strict";
import { entryId } from "../src/lib/features/bookmarks/ids.js";

test("entry creation survives unavailable UUID APIs without repeated IDs", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {configurable: true, value: {randomUUID() {throw new Error("Unavailable");}}});
  try {
    const ids = Array.from({length: 100}, () => entryId());
    assert.equal(new Set(ids).size, 100);
    assert.ok(ids.every(id => id.startsWith("entry-") && id.length <= 128));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});
