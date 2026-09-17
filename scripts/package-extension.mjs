import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from '../extension/build.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// Read AFTER build(): build.mjs regenerates the manifests from extension/build.mjs,
// which is the single source of truth for the extension version.
function readVersion() {
  try {
    return JSON.parse(readFileSync(join(root, 'extension/chromium/manifest.json'), 'utf8')).version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

// Reviewer instructions bundled INSIDE the AMO source zip. They reproduce the
// uploaded Gecko build byte-for-byte (modulo zip metadata) from this source.
function buildingText(version) {
  return `BrowserDock Companion v${version} — source for AMO review
=====================================================
This zip is the human-readable source of the uploaded Gecko (.xpi) build.
No minified or obfuscated code is used anywhere.

Contents:
  build.mjs          concatenates src/core.js + src/background.js into
                     background.js, and src/core.js + src/options.js into
                     options.js (stripping the leading "export " keywords),
                     then writes both distributions plus manifests.
  src/               authoritative source (background, core, options page)
  test/              node:test suites run against src/ (no dependencies)

Reproduce the uploaded build (requires Node.js 22+, no npm dependencies):
  1. Unzip this source package and cd into it.
  2. Run:  node -e "import('./build.mjs').then(m => m.build('out'))"
     (equivalently: node extension/build.mjs from the repo root)
  3. Compare out/gecko/background.js, out/gecko/options.js,
     out/gecko/options.html, out/gecko/options.css and
     out/gecko/manifest.json against the same paths in the uploaded .xpi.
     The .js files are byte-identical; the manifest is formatted with
     JSON.stringify(manifest, null, 2).

Run the test suites:
  node --test --test-isolation=none test/*.test.mjs

Notes for reviewers:
  - The only network endpoints are ws://127.0.0.1:<port> and
    http://127.0.0.1/* (loopback to the user's own BrowserDock desktop app).
    No remote servers, telemetry, analytics, or update checks exist.
  - Pairing credentials (UUIDv4 token, port, private-tab opt-in) are entered
    by the user on the options page and stored in storage.local only.
  - contextualIdentities/cookies exist only in the Gecko build to resolve
    Firefox/Mullvad container names to cookieStoreIds for tab focusing.
  - browsingActivity (tab URLs/titles) is sent to the local app only, and
    private tabs are excluded unless the user explicitly opts in AND grants
    the browser-level private-windows permission.
`;
}

function zipWithSystemTools(sourceDir, outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  const files = ['manifest.json', 'background.js', 'options.js', 'options.html', 'options.css'];
  try {
    // Prefer Info-ZIP when available (Linux/macOS/Git-Bash).
    execFileSync('zip', ['-j', '-X', '-9', outFile, ...files], { cwd: sourceDir, stdio: 'pipe' });
    return 'zip';
  } catch {
    try {
      // Portable fallback: Python stdlib (ships with most dev machines).
      execFileSync(
        'python3',
        ['-c', `import zipfile,sys; [zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED).write(f,f) for f in sys.argv[2:]]`, outFile, ...files],
        { cwd: sourceDir, stdio: 'pipe' }
      );
      return 'python3-zipfile';
    } catch {
      // Windows fallback without zip/python.
      const ps = `Compress-Archive -Path ${files.map((f) => `'${sourceDir}\\${f}'`).join(',')} -DestinationPath '${outFile}' -Force`;
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' });
      return 'powershell';
    }
  }
}

export async function packageExtension(outDir = join(root, 'build', 'extension')) {
  await build(); // regenerate chromium/ + gecko/ from extension/src/
  const version = readVersion();
  verifyBuild(version);
  // Prune stale versioned outputs so old zips never accumulate next to fresh ones.
  mkdirSync(outDir, { recursive: true });
  for (const stale of readdirSync(outDir)) {
    if (/^browserdock-(chromium|gecko|amo-source)-v.*\.(zip|xpi)$/.test(stale)) {
      rmSync(join(outDir, stale));
    }
  }
  const outputs = [];
  for (const flavor of ['chromium', 'gecko']) {
    const outFile = join(outDir, `browserdock-${flavor}-v${version}.zip`);
    const tool = zipWithSystemTools(join(root, 'extension', flavor), outFile);
    outputs.push({ flavor, outFile, tool });
  }
  // Firefox permanent installs expect an .xpi (byte-identical zip, renamed).
  const geckoZip = join(outDir, `browserdock-gecko-v${version}.zip`);
  const xpi = join(outDir, `browserdock-gecko-v${version}.xpi`);
  if (existsSync(geckoZip)) copyFileSync(geckoZip, xpi);
  // AMO source package: human-readable source + build/test instructions.
  // Reviewers rebuild with the steps in BUILDING.txt and diff against the .xpi.
  const sourceOut = join(outDir, `browserdock-amo-source-v${version}.zip`);
  writeFileSync(join(root, 'extension', 'BUILDING.txt'), buildingText(version));
  try {
    execFileSync(
      'python3',
      ['-c', `import zipfile,sys,os
out=sys.argv[1]; base=sys.argv[2]; paths=sys.argv[3:]
zf=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED)
for p in paths:
  full=os.path.join(base,p)
  if os.path.isdir(full):
    [zf.write(os.path.join(dp,f),os.path.relpath(os.path.join(dp,f),base)) for dp,_,fs in os.walk(full) for f in fs]
  else: zf.write(full,p)
zf.close()`, sourceOut, join(root, 'extension'), 'BUILDING.txt', 'build.mjs', 'src', 'test'],
      { stdio: 'pipe' }
    );
  } catch (e) {
    throw new Error(`AMO source packaging needs python3 (${e.message ?? e}). Install Python 3 or reuse the chromium/gecko zips above.`);
  } finally {
    // BUILDING.txt is generated packaging output, not a source file.
    rmSync(join(root, 'extension', 'BUILDING.txt'), { force: true });
  }
  writeSha256(outDir, [join(outDir, `browserdock-chromium-v${version}.zip`), xpi, sourceOut]);
  return { version, outputs, xpi, sourceOut };
}

/** Fail fast on drift, syntax errors, or version skew before zipping. */
function verifyBuild(version) {
  for (const flavor of ['chromium', 'gecko']) {
    const manifest = JSON.parse(readFileSync(join(root, 'extension', flavor, 'manifest.json'), 'utf8'));
    if (manifest.version !== version) {
      throw new Error(`extension/${flavor}/manifest.json version ${manifest.version} != built version ${version}`);
    }
    for (const file of ['background.js', 'options.js']) {
      execFileSync(process.execPath, ['--check', join(root, 'extension', flavor, file)], { stdio: 'pipe' });
    }
  }
}

function writeSha256(outDir, files) {
  const lines = files
    .filter((f) => existsSync(f))
    .map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f.split(/[\\/]/).pop()}\n`);
  writeFileSync(join(outDir, 'SHA256SUMS.txt'), lines.join(''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version: v, outputs, xpi, sourceOut } = await packageExtension();
  for (const o of outputs) console.log(`${o.flavor} -> ${o.outFile} (via ${o.tool})`);
  console.log(`gecko xpi copy -> ${xpi}`);
  console.log(`amo source -> ${sourceOut}`);
  console.log(`\nInstall:\n- Chrome/Edge: chrome://extensions > Developer mode > Load unpacked (unzip first), or drag the .zip onto the page.\n- Firefox/Mullvad: about:debugging#/runtime/this-firefox > Load Temporary Add-on > pick the .zip (manifest at root).\n- Permanent Firefox use requires a Mozilla-signed .xpi; the unsigned .xpi above is for self-distributed/developer installs.`);
  console.log(`\nAMO upload:\n- Add-on file: browserdock-gecko-v${v}.zip (or the .xpi).\n- "Provide source code": browserdock-amo-source-v${v}.zip (rebuild steps in BUILDING.txt).`);
}
