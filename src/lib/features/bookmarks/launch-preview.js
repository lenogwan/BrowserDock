import { buildOpenTabIndex, isTabOpen } from './search.js';

/**
 * Inventory is a bounded site hint, never proof of an exact page/profile match.
 * @param {{details: import('../../platform/tauri/commands').RouteDetails, url: string,
 * browsers: import('../../shared/types').Browser[], instances: import('../../shared/types').InstanceDigest[], uncertain: boolean}} input
 */
export function launchPreview({ details, url, browsers, instances, uncertain }) {
  const browser = browsers.find(browser => browser.id === details.browser_id);
  const name = browser?.name ?? details.browser_id;
  const suffix = details.profile ? ` · ${details.profile} profile` : details.container ? ` · ${details.container} container` : '';
  const connected = instances.some(instance => instance.browser === details.browser_id);
  if (details.incognito) return { text: `Open private window in ${name}${suffix}`, note: 'Private windows bypass existing-tab reuse.' };
  if (uncertain) return { text: `Open or switch in ${name}${suffix}`, note: 'Connection state is uncertain. BrowserDock checks again when you open.' };
  if (!connected) return { text: `Open in ${name}${suffix}`, note: browser?.exe_path ? 'No companion is connected; this starts the browser with your URL.' : 'Configure this browser’s executable in Settings before opening.' };
  if (details.profile) return { text: `Open or switch in ${name}${suffix}`, note: 'The profile applies to a new browser launch. A connected companion may belong to another profile.' };
  const matching = isTabOpen({ id: '', title: '', url, target_browser: details.browser_id, tags: [], icon: '', browser_options: { container: details.container } }, buildOpenTabIndex(instances));
  return matching
    ? { text: `Switch to existing ${name} tab${suffix}`, note: 'A tab on this site was reported. The browser checks again before switching; it may open a new tab if that tab is no longer available.' }
    : { text: `Open or switch in ${name}${suffix}`, note: 'No matching tab was reported. The browser checks its current tabs before opening a new one.' };
}
