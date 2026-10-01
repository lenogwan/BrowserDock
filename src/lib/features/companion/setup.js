const names = { firefox: 'Firefox', mullvad: 'Mullvad', chrome: 'Chrome', edge: 'Edge' };

/** @param {import('../../shared/types').Browser[]} browsers @param {import('../../shared/types').InstanceDigest[]} instances @param {string[]} reconnecting */
export function setupBrowsers(browsers, instances, reconnecting) {
  return Object.entries(names).filter(([id]) => browsers.some(browser => browser.id === id && browser.exe_path?.trim()) || instances.some(instance => instance.browser === id) || reconnecting.includes(id)).map(([id, name]) => ({ id, name }));
}

/** @param {string | null} raw */
export function excludedSetupBrowsers(raw) {
  try {
    const value = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && Object.hasOwn(names, id)) : [];
  } catch { return []; }
}
