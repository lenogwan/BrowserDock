import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
// Source modules use local named imports for Node tests. The extension build
// concatenates them in dependency order into classic scripts for MV3/Gecko.
export function stripModuleSyntax(source, file) {
  if (/^\s*export\s+(default|\{|\*)/m.test(source)) {
    throw new Error(`${file}: unsupported export form (only "export <declaration>" is supported)`);
  }
  const imports = [...source.matchAll(/^import[ \t]+[^\r\n]+/gm)];
  for (const [statement] of imports) {
    if (!/^import\s+\{[^}]+\}\s+from\s+['"]\.\/[a-z-]+\.js['"];?$/.test(statement)) {
      throw new Error(`${file}: unsupported import form`);
    }
  }
  return source.replace(/^import[ \t]+[^\r\n]+(?:\r?\n|$)/gm, '').replace(/^export (?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '');
}
export async function build(output = root) {
  const modules = {};
  for (const name of ['protocol', 'inventory', 'actions', 'core']) {
    modules[name] = stripModuleSyntax(await readFile(join(root, `src/${name}.js`), 'utf8'), `src/${name}.js`);
  }
  const background = ['protocol', 'inventory', 'actions', 'core'].map(name => modules[name]).join('\n') + '\n' + await readFile(join(root, 'src/background.js'), 'utf8');
  const options = modules.protocol + '\n' + await readFile(join(root, 'src/options.js'), 'utf8');
  const common = {
    manifest_version: 3,
    name: 'BrowserDock Companion',
    version: '1.0.7',
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
      // strict_min_version must satisfy the newest manifest key on every
      // platform: data_collection_permissions needs desktop 140+ / Android
      // 142+ (and tabGroups needs 139+), so 142.0 keeps AMO validation clean.
      // Firefox 121–141 users stay on companion 1.0.4.
      : { ...common, permissions: [...common.permissions, 'contextualIdentities', 'cookies'], background: { scripts: ['background.js'] }, browser_specific_settings: { gecko: { id: 'browserdock@browserdock.local', strict_min_version: '142.0', data_collection_permissions: { required: ['browsingActivity'] } } } };
    const directory = join(output, flavor);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(directory, 'background.js'), background);
    await writeFile(join(directory, 'options.js'), options);
    for (const file of ['options.html', 'options.css']) await copyFile(join(root, 'src', file), join(directory, file));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await build();
