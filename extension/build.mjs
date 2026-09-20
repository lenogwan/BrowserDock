import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
// Strip ESM declaration exports for the concatenated classic-script build.
// Only `export <declaration>` forms are supported; anything else (default
// exports, export lists, re-exports) fails loudly instead of shipping broken
// code that silently shares one scope.
function stripExports(source, file) {
  if (/^\s*export\s+(default|\{|\*)/m.test(source)) {
    throw new Error(`${file}: unsupported export form (only "export <declaration>" is supported)`);
  }
  return source.replace(/^export (?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '');
}
export async function build(output = root) {
  const coreRaw = await readFile(join(root, 'src/core.js'), 'utf8');
  const source = stripExports(coreRaw, 'src/core.js');
  const background = source + '\n' + await readFile(join(root, 'src/background.js'), 'utf8');
  const options = source + '\n' + await readFile(join(root, 'src/options.js'), 'utf8');
  const common = {
    manifest_version: 3,
    name: 'BrowserDock Companion',
    version: '1.0.4',
    description: 'Connect this browser to BrowserDock on your computer to focus or open tabs.',
    permissions: ['tabs', 'storage', 'alarms', 'tabGroups'],
    host_permissions: ['http://127.0.0.1/*'],
    incognito: 'spanning',
    options_ui: { page: 'options.html', open_in_tab: true },
    action: { default_title: 'Pair with BrowserDock' },
    content_security_policy: { extension_pages: "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; connect-src ws://127.0.0.1:*; base-uri 'none'; form-action 'none'" }
  };
  for (const flavor of ['chromium', 'gecko']) {
    const manifest = flavor === 'chromium'
      ? { ...common, minimum_chrome_version: '116', background: { service_worker: 'background.js' } }
      // data_collection_permissions is required by Firefox for all new extensions.
      // browsingActivity is required (not "none"): the companion's core function is
      // sending open-tab URLs/titles to the local BrowserDock app over loopback.
      // Nothing leaves the device; there is no telemetry or remote server.
      : { ...common, permissions: [...common.permissions, 'contextualIdentities', 'cookies'], background: { scripts: ['background.js'] }, browser_specific_settings: { gecko: { id: 'browserdock@browserdock.local', strict_min_version: '121.0', data_collection_permissions: { required: ['browsingActivity'] } } } };
    const directory = join(output, flavor);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(directory, 'background.js'), background);
    await writeFile(join(directory, 'options.js'), options);
    for (const file of ['options.html', 'options.css']) await copyFile(join(root, 'src', file), join(directory, file));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await build();
