import test from "node:test";
import assert from "node:assert/strict";
import { installedDockBrowsers } from "../src/lib/features/browsers/availability.js";

test("dock browser chips include only known browsers with configured executables", () => {
  const browsers = [
    { id: "firefox", exe_path: "C:\\Firefox\\firefox.exe" },
    { id: "mullvad", exe_path: "" },
    { id: "chrome", exe_path: "   " },
    { id: "edge", exe_path: "C:\\Edge\\msedge.exe" },
    { id: "custom", exe_path: "C:\\Custom\\browser.exe" },
  ];

  assert.deepEqual(
    installedDockBrowsers(browsers).map((browser) => browser.id),
    ["firefox", "edge"],
  );
});
