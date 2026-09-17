# BrowserDock

**BrowserDock** is an always-on-top floating dock for Windows that manages bookmarks, routes URLs to the right browser (Firefox, Mullvad, Chrome, Edge), focuses already-open tabs via a companion extension, and locks sensitive bookmarks in an encrypted vault.

- **Desktop app:** Tauri v2 (Rust backend) + Svelte 5 / Tailwind CSS frontend. Lightweight (< 40 MB RAM).
- **Companion extension:** one build for Chrome/Edge, one for Firefox/Mullvad; talks to the app over `ws://127.0.0.1`.
- **Private vault:** Argon2id + AES-256-GCM, stored in `vault.enc`, auto-locks after inactivity.

## Prerequisites (Windows 10/11)

1. **Node.js 22+** (check with `node --version`) and npm.
2. **Rust stable** with the MSVC toolchain — install from [rust-lang.org](https://www.rust-lang.org/learn/get-started); the `npm run tauri dev` step needs `cargo`.
3. **WebView2 runtime** (preinstalled on Windows 10/11; the installer will tell you if it's missing).
4. The four browsers are optional — the dock works with whichever of Firefox, Mullvad, Chrome, Edge you have installed (it auto-detects them on first run).

> Rust/Tauri commands below must run on Windows. Plain `npm run dev` (frontend preview) works anywhere Node runs.

## Install dependencies

```sh
npm install
```

## Run the app (development)

```sh
npm run tauri dev
```

This starts the Vite frontend and the Rust backend together. The dock appears as a small floating pill (starts hidden until positioned, then shows centered).

Frontend-only preview (no backend — bookmarks/vault disabled, UI explorable in a browser):

```sh
npm run dev
```

## Build an installer (production)

On a Windows development machine:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
```

> If PowerShell refuses to run `npm` (`npm.ps1 cannot be loaded…running scripts is disabled`), call `npm.cmd` explicitly (`npm.cmd install`) or launch the shell with `-ExecutionPolicy Bypass` as above. Permanent per-user fix: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

The script tests and builds a setup `.exe` and an MSI with offline WebView2 support,
then collects them with user instructions and checksums under `dist/`. End users
only run the installer; they do not need Rust or Node.js. You can also build through
the **Windows installers** GitHub Actions workflow. See
[`docs/windows-installer.md`](docs/windows-installer.md) for prerequisites and distribution steps.

## Build flow in detail

Two version numbers with separate sources of truth:

| What | Source of truth | Where it lands |
| :--- | :--- | :--- |
| App (installer filename, upgrade identity) | `package.json` + `package-lock.json` + `src-tauri/Cargo.toml` + `src-tauri/Cargo.lock` + `src-tauri/tauri.conf.json` — all five must match | setup `.exe` / `.msi` names |
| Companion extension | `extension/build.mjs` (`version` field) | `extension/chromium` + `extension/gecko` manifests, companion zip, installer resources |

### Bumping the extension version

1. Edit the `version` field in `extension/build.mjs`.
2. Run `npm run build:extension` to regenerate `extension/chromium/` and `extension/gecko/` from `extension/src/`, and commit those regenerated files — they are checked in so the extension loads straight from a checkout.
3. Run the Windows build below. It re-runs the extension build itself, so the new version flows into the companion zip and the installer resources automatically.

### Bumping the app version

Update all five app version files in the table (keep `identifier` and the WiX `upgradeCode` stable; downgrades are disabled). Full checklist: [`docs/windows-installer.md`](docs/windows-installer.md).

### What `scripts/build-windows.ps1` does, in order

1. Adds the `x86_64-pc-windows-msvc` Rust target; `npm ci` (locked deps).
2. `npm run check` — Svelte + TypeScript diagnostics.
3. `npm run test:ui` — frontend unit tests.
4. `npm run build:extension` — regenerates both companion builds from `extension/src/`.
5. `npm run test:extension` — companion protocol tests.
6. `cargo test --locked` — Rust core tests (routing, vault, WebSocket, pairing).
7. `tauri build --target x86_64-pc-windows-msvc` — setup `.exe` (NSIS) + `.msi`, embedding the offline WebView2 runtime and the `extension/chromium|gecko` resources.
8. Verifies both installers exist, then collects into `dist/BrowserDock-<app-version>-windows-x64-<timestamp>/`:
   - `BrowserDock_<version>_x64-setup.exe`, `BrowserDock_<version>_x64_en-US.msi`
   - `install-companion.ps1` (one-click pairing helper)
   - `BrowserDock-Companion.zip`, `INSTALL-WINDOWS.txt`, `SHA256SUMS.txt`

Related scripts: `npm run package:extension` builds the store-upload artifacts (`build/extension/*.zip`, Gecko `.xpi`, AMO source zip) — only needed for Firefox/Chrome store submissions, not for the Windows installer.

## First run

1. Launch BrowserDock once. It creates `%APPDATA%\BrowserDock\config.json` (settings, browsers, routing rules, bookmarks, auth token) and auto-detects installed browsers into it.
2. Summon the dock anytime with **`Ctrl+Shift+Space`**. Single `Esc` hides it.
3. The tray icon offers Show/Hide, Lock Vault, Settings, Exit. Right-click it if the dock seems lost.
4. Add bookmarks and groups in-app; advanced routing rules live in `config.json`. Public bookmark settings stay in config, while private bookmarks, groups and options stay encrypted.

## Install and pair the companion extension (tab focusing)

Without this, URLs open as new tabs; with it, the dock finds and focuses already-open tabs. No `config.json` editing needed — the installer bundles the companion and the app generates pre-configured pairing data.

1. In BrowserDock, open **Settings → Connect your browsers**.
2. Press **Stage companion folder**, then **Copy code** for a browser (or **Save pairing files** for all four) and **Open extensions**.
3. In Chrome/Edge: enable Developer mode → **Load unpacked** → pick the staged `companion\chromium` folder. In Firefox/Mullvad: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `companion\gecko\manifest.json`.
4. On the companion options page press **Import pairing** (paste the code or pick the `browserdock-pairing-<browser>.json` file), then Save.

Alternative: run `install-companion.ps1 -OpenBrowsers` from the extracted dist folder — it stages the companion and writes the pairing files in one go.

Full details, private-tab opt-in, and limits: [`extension/README.md`](extension/README.md).

## Daily use

| Action | How |
| :--- | :--- |
| Summon / hide | `Ctrl+Shift+Space` / `Esc` |
| Open with specific browser | `Alt+F` Firefox · `Alt+M` Mullvad · `Alt+C` Chrome · `Alt+E` Edge (or `Alt+1–4`) |
| Force new tab | `Shift+Enter` |
| Panic lock vault | `Esc` twice quickly, or `Ctrl+Alt+L` |
| Vault | Click the lock icon or type `/vault` (min 8-char passphrase, numeric-only rejected) |

## Settings and bookmark organization

| Setting | Behavior | Default |
| :--- | :--- | :--- |
| Always on top | Keeps the window above other windows | On |
| Hide after opening link | Hides after a successful launch; turn off to keep the dock visible | On |
| Auto-hide | Collapses to a strip when idle and the pointer leaves | Off |
| Interface opacity | Background transparency, 30–100%; text remains solid | 100% |

Settings previews opacity until Save; Cancel restores the saved appearance. The three visibility settings are independent.

Create groups using **G+**, move bookmarks by dragging or the editor's Group select, and use group editing controls to rename, reorder, or delete. Deleting a group keeps its bookmarks under Ungrouped. Search includes group names. Private groups are available only while the vault is unlocked.

Use BookmarkEditor for Chrome/Edge profile directories (such as `Default` or `Profile 1`) and Firefox/Mullvad container names. Settings → Browsers configures defaults and advanced arguments. Per-bookmark choices override defaults. Container support needs the Gecko companion and enabled containers; an unavailable container opens normally with a note. Private/incognito opens a new window and bypasses tab reuse.

Chrome profile names are directory names, not necessarily the display names shown by Chrome. Profiles are selected by CLI on process launch; companion reuse targets a connected instance. Install a companion in every profile and verify warm-browser behavior on your machine.

The first load of a v1.0 config creates a `config.json.bak.<timestamp>` backup before upgrading to v1.1. Legacy encrypted vaults load without a prompt and adopt the new inner format on the next successful edit.

## Verify / test

Keep `%APPDATA%\BrowserDock` restricted to your Windows user account using its file permissions (ACLs), and never share `settings.auth_token`: it is a bearer credential for local companion access. A copied `vault.enc` can be attacked offline, so use a strong passphrase of at least eight characters rather than a numeric PIN; the three-attempt lockout protects only this running app. DPAPI-wrapping the pairing token is not implemented.

```sh
npm run check            # Svelte + TypeScript diagnostics
npm run test:ui          # frontend search/URL unit tests
npm run test:extension   # companion protocol tests (also: npm run build:extension first after editing extension/src)
cargo test -p browserdock-launcher   # Rust routing/vault/server tests (Windows, needs cargo)
```

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| `cargo` not found | Install Rust MSVC toolchain and reopen the terminal |
| `npm.ps1 cannot be loaded…` | PowerShell execution policy is blocking npm — use `npm.cmd …`, or `powershell -ExecutionPolicy Bypass`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Summon shortcut does nothing | Another app owns it — change it in Settings (applies after restart); tray still works |
| Companion shows disconnected | Dock not running, stale pairing, or extension disabled — re-copy the pairing code from Settings → Connect your browsers (if the dock logged a port change after a conflict, re-pair every companion to the new port) |
| "Invalid config.json" on start | Edit was malformed — fix the JSON (the file is never overwritten); delete only as a last resort (regenerates with a fresh token, breaking pairings) |
| Vault locked message right after 3 wrong tries | 30 s lockout by design; wait and retry |

## Repository map (for humans and agents)

| File | Purpose |
| :--- | :--- |
| [`SPECIFICATION.md`](SPECIFICATION.md) | Authoritative architecture, schemas, IPC protocol |
| [`PROGRESS.md`](PROGRESS.md) | Build status shared across AI agents |
| [`BUGS.md`](BUGS.md) | Open bug report + fix plan (read before fixing) |
| [`extension/README.md`](extension/README.md) | Companion install, pairing, behavior limits |
| [`docs/phase-6-7.md`](docs/phase-6-7.md) | Dock and vault usage notes |
| [`.agents/skills/browser-dock-builder/SKILL.md`](.agents/skills/browser-dock-builder/SKILL.md) | Implementation skill (mirrored in `.codex/` and `.opencode/` — keep the 3 copies in sync) |
