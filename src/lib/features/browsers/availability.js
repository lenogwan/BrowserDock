const DOCK_BROWSER_IDS = new Set(["firefox", "mullvad", "chrome", "edge"]);

/**
 * Header shortcuts are useful only when BrowserDock has an executable it can
 * launch. Keep missing defaults in Settings, but out of the compact dock.
 * @param {import('../../shared/types').Browser[]} browsers
 */
export function installedDockBrowsers(browsers) {
  return browsers.filter(
    (browser) =>
      DOCK_BROWSER_IDS.has(browser.id) &&
      typeof browser.exe_path === "string" &&
      browser.exe_path.trim().length > 0,
  );
}
