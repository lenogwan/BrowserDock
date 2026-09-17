import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Windows webview leaves bookmark HTML drag and drop to the frontend", () => {
  const base = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
  const windows = JSON.parse(readFileSync(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url)));
  const effectiveWindows = windows.app?.windows ?? base.app.windows;
  const dock = effectiveWindows.find(window => window.label === "main");
  // Tauri defaults this to true, which intercepts HTML5 drops on Windows.
  assert.equal(dock.dragDropEnabled, false, "Native file-drop interception must be disabled for bookmark drops");
  assert.equal(dock.resizable, true, "The dock window must allow user resizing");
});
