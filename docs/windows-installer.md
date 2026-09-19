# Windows installer builds

The Windows configuration produces an NSIS setup `.exe` for the current user and
an MSI alternative. Both use the WebView2 download bootstrapper, which fetches
the WebView2 runtime at install time — this keeps the packages small (roughly
the app itself plus a small stub) but requires internet access during
installation. If you need fully offline installation, switch
`webviewInstallMode.type` back to `offlineInstaller` in
`src-tauri/tauri.windows.conf.json` at the cost of ~200MB per package.
See [Tauri's installer documentation](https://v2.tauri.app/distribute/windows-installer/).

## Build using GitHub Actions

Every push to `main`/`dev` builds on Windows via the `Build Windows EXE`
workflow. Download the `BrowserDock-windows-x64-exe-<sha>` artifact from the
completed run. Pushing a `v*` tag additionally publishes a GitHub Release with
the installers attached. Artifacts expire after 30 days, so copy the files to
your distribution location before then.

## Build on a Windows development machine

Install Node.js 24, Rust through rustup (stable MSVC), and Visual Studio Build
Tools with **Desktop development with C++** and a Windows SDK. Reopen the terminal
after installation. MSI generation also needs the Windows VBScript optional
feature; see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

For a quick Rust installation in an Administrator or normal PowerShell window:

```powershell
winget install --id Rustlang.Rustup -e
```

Close and reopen the terminal afterward, then confirm `cargo --version` works.

From the project root in PowerShell:

```powershell
powershell -NoProfile -File .\scripts\build-windows.ps1
```

The script restores locked npm dependencies, runs frontend/extension/Rust tests,
and builds the x64 release with locked Cargo dependencies. The build machine
needs internet access to obtain dependencies, bundler tools, and WebView2.

Share the files in the newly printed `dist/BrowserDock-<version>-windows-x64-<timestamp>/`
directory. It contains the setup EXE, MSI, `install-companion.ps1` one-click
pairing helper, optional companion ZIP, user instructions,
and SHA-256 checksums. Raw Tauri outputs remain in
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`. A `-setup.exe` is an
installer, not a portable executable.

The installer bundles the companion extension as Tauri resources
(`extension/chromium`, `extension/gecko`), so the installed app can stage a
permanent copy and generate pre-configured pairing codes/files from
Settings → Connect your browsers without the user ever opening
`config.json`. Browsers still require two in-browser clicks (Load unpacked /
Load Temporary Add-on + Import) because Chrome, Edge and Firefox block silent
sideloads; there is no supported zero-click path without store listings plus
enterprise force-install policies.

## Release validation

Before broad distribution, test the setup on a clean Windows 10/11 x64 machine:
installation without Rust/Node, WebView2 installation while offline, Start menu
launch, tray and shortcuts, browser dispatch, vault locking, upgrading an existing
installation, and uninstalling. Check the MSI separately. The supplied automation
builds and tests the source; it does not perform these interactive acceptance tests.

The packages are unsigned unless you configure an Authenticode certificate or
signing command through Tauri's Windows bundler options. Unsigned downloads may
trigger Windows SmartScreen. See [Windows signing](https://v2.tauri.app/distribute/sign/windows/).

Keep `identifier` and the WiX `upgradeCode` stable across releases. Increment the
version consistently in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Downgrades are disabled.
This build targets Intel/AMD x64; native ARM64 packages are not included.
