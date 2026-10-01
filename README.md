# BrowserDock

**BrowserDock** is an always-on-top floating dock for Windows that manages bookmarks, routes URLs to the right browser (Firefox, Mullvad, Chrome, Edge), focuses already-open tabs via a companion extension, and locks sensitive bookmarks in an encrypted vault.

- **Desktop app:** Tauri v2 (Rust backend) + Svelte 5 / Tailwind CSS frontend. Memory target: < 40 MB RAM; native measurement pending.
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

In **Settings → Companion**, choose the browsers you use. Installed or connected browsers appear automatically; deselect any you do not want in setup. **Ready** means all selected browsers are connected. Each browser has a **Test connection** button for a fresh local check without opening tabs. A passing test confirms that the connection responds, not that Windows can foreground the browser. Use **Configure or detect browsers** if one is missing; bulk pairing-file export is under advanced options.

1. In BrowserDock, open **Settings → Companion**.
2. Press **Prepare companion folder**, use **Show companion folder** to find the files, then **Copy code** for a browser (or **Save pairing files** for all four) and **Open extensions**.
3. In Chrome/Edge: enable Developer mode → **Load unpacked** → pick the staged `companion\chromium` folder. In Firefox/Mullvad: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `companion\gecko\manifest.json`.
4. On the companion options page press **Import pairing** (paste the code or pick the `browserdock-pairing-<browser>.json` file), then Save.

Alternative: run `install-companion.ps1 -OpenBrowsers` from the extracted dist folder — it stages the companion and writes the pairing files in one go.

Full details, private-tab opt-in, and limits: [`extension/README.md`](extension/README.md).

## Daily use

The expanded dock previews what **Enter** will do for the selected bookmark or URL, including your browser override and profile/container. “Switch to existing…” uses the reported site match; the browser checks again when you open. “Open or switch” means the available inventory or connection state cannot establish which action will happen. Private-window launches are labeled explicitly. Hover over the preview for details, including the limitation that a Chromium profile setting cannot guarantee which connected profile handles tab reuse.

| Action | How |
| :--- | :--- |
| Summon / hide | `Ctrl+Shift+Space` / `Esc` |
| Open with specific browser | `Alt+F` Firefox · `Alt+M` Mullvad · `Alt+C` Chrome · `Alt+E` Edge (or `Alt+1–4`) |
| Open entire bookmark subtree | Parent row's `+N` button or `Shift+Enter` |
| Force new tab for a leaf bookmark or typed URL | `Shift+Enter` |
| Expand / collapse a bookmark parent | Chevron or `Right Arrow` / `Left Arrow` |
| Panic lock vault | `Esc` twice quickly, or `Ctrl+Alt+L` |
| Vault | Click the lock icon or type `/vault` (new vaults need a nonnumeric passphrase of at least 8 characters; existing PINs still unlock) |

## Settings and bookmark organization

| Setting | Behavior | Default |
| :--- | :--- | :--- |
| Always on top | Keeps the window above other windows | On |
| Hide after opening link | Hides after a successful launch; turn off to keep the dock visible | On |
| Auto-hide | Collapses to a strip when idle and the pointer leaves | Off |
| Interface opacity | Background transparency, 30–100%; text remains solid | 100% |
| Theme | Sage Mint, Nord Frost, Midnight Amber, Tokyo Violet or Rosé Pine | Sage Mint |

Settings → Appearance previews theme and opacity until Save; Discard restores the saved appearance. The three visibility settings are independent. Section labels wrap at narrow widths and stay visible while scrolling. Use Left/Right, Home or End when a section tab has focus.

Create groups using **Add group**, move bookmarks by dragging or the editor's Group select, and use group editing controls to rename, reorder, or delete. Deleting a group keeps its bookmarks under Ungrouped. Search includes group names. Private groups are available only while the vault is unlocked.

Use **Undo public action** or **Undo private action** after deleting or moving a bookmark. Undo restores one action, including affected descendants and order; later edits invalidate it. Private undo disappears when the vault locks. **Select bookmarks** lets you click rows or checkboxes to select them, then move them to a group or Ungrouped. Enter/Space toggles a focused selection row. The count includes sub-pages that move with a selected parent. Moving reports the destination and offers undo; selections stay within one public/private scope.

**Settings → Library** imports bookmark HTML exported by Firefox, Mullvad, Chrome or Edge. Choose the browser and grouping, use **Check import** to see new bookmarks and duplicates, then **Import bookmarks**. Expand **Preview bookmarks** to inspect individual links. Changing an option requires checking again. Exact duplicate destinations are skipped. Nested folders become groups using their immediate folder name; equal names merge. Unsupported URLs and oversized entries are reported and skipped. Imports are public and limited to 1000 links per file.

**Download library backup** saves public bookmarks/groups and the encrypted vault locally. Public bookmarks are readable in the backup; only vault content stays encrypted. Keep the original vault password: the backup cannot recover it. Machine settings, browser paths, routing rules and pairing credentials are excluded. To restore, choose the JSON backup, review the current-versus-backup counts and confirm replacement. Restore replaces the public library; it does not merge bookmarks. Replacing the vault is optional and off by default. Keep the Library view open until an operation finishes. Restore locks the vault and keeps the old config/vault in a local recovery folder whose path is shown afterward; interrupted restores recover on the next startup. If recovery remains pending after a failure, further saves, exports and vault unlocks are blocked until you restart BrowserDock. These recovery copies stay until you remove them manually.

Nest bookmarks using the editor's **Parent** select or by holding a dragged row over another row's body briefly. Trees support children and grandchildren; the group follows the parent. Drop on a row's top edge to reorder siblings, or on a group header to return to root. Choose **Parent → None** to unnest using the keyboard or touch. Escape cancels dragging. Deleting a parent keeps its children under its former parent, or at root.

Click a parent normally to open only its URL. Its **+N** button or **Shift+Enter** opens it and all descendants, up to 50 URLs, in a browser group named after the parent. Browser/profile/container differences split batches just as for group actions. Expansion is remembered, and private expansion is cleared when private rows are hidden or locked. Search stays flat and shows parent names.

Grouped bookmarks automatically join a matching native browser tab group. Turn this off under **Settings → Behavior → Sync bookmark groups to browser tab groups**. Group headers offer **Open group in browser** and **Close group tabs**; rows display native group names/colors when reported by the companion. Explicit group opening works with the automatic setting off.

Group actions support up to 50 bookmarks. Different browsers, profiles, or containers use separate batches; same-name groups in a browser window can be reused. Closing removes all eligible tabs in the matching native group, including tabs you added manually. A partial failure is reported without retrying. Update/reload the companion to v1.0.4 and accept its new `tabGroups` permission. Unsupported browsers open regular tabs with a notice. Private/incognito launch options bypass native grouping.


Use BookmarkEditor for Chrome/Edge profile directories (such as `Default` or `Profile 1`) and Firefox/Mullvad container names. Settings → Browsers configures defaults and advanced arguments. Per-bookmark choices override defaults. Container support needs the Gecko companion and enabled containers; an unavailable container opens normally with a note. Private/incognito opens a new window and bypasses tab reuse.

Chrome profile names are directory names, not necessarily the display names shown by Chrome. Profiles are selected by CLI on process launch; companion reuse targets a connected instance. Install a companion in every profile and verify warm-browser behavior on your machine.

The first load of a v1.0 config creates a `config.json.bak.<timestamp>` backup before upgrading to v1.1. Legacy encrypted vaults load without a prompt and adopt the new inner format on the next successful edit.

## Verify / test

Keep `%APPDATA%\BrowserDock` restricted to your Windows user account using its file permissions (ACLs), and never share `settings.auth_token`: it is a bearer credential for local companion access. A copied `vault.enc` can be attacked offline, so use a strong passphrase of at least eight characters rather than a numeric PIN; the three-attempt lockout protects only this running app. DPAPI-wrapping the pairing token is not implemented.

```sh
npm run check            # Svelte + TypeScript diagnostics
npm run test:ui          # frontend search/URL unit tests
npm run test:extension   # companion protocol tests (also: npm run build:extension first after editing extension/src)
cargo test --locked --manifest-path src-tauri/core/Cargo.toml  # Rust core tests; needs cargo
```

## Troubleshooting

Companion v1.0.9 adds **Connection diagnostics** on its options page. If a browser intermittently disconnects, inspect the recent reason codes and recovery durations there. The last 50 events stay within the browser session and contain no URLs or pairing tokens. Update/reload the companion and rebuild/restart the desktop app to receive both sides of the recovery-timing improvements. The dock briefly shows **reconnecting** when a previously connected browser disappears; tab reuse is unavailable for the missing connection during that time.

| Symptom | Fix |
| :--- | :--- |
| `cargo` not found | Install Rust MSVC toolchain and reopen the terminal |
| `npm.ps1 cannot be loaded…` | PowerShell execution policy is blocking npm — use `npm.cmd …`, or `powershell -ExecutionPolicy Bypass`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Summon shortcut does nothing | Another app owns it — change it in Settings (applies after restart); tray still works |
| Companion shows disconnected | Dock not running, stale pairing, or extension disabled — re-copy the pairing code from Settings → Companion (if the dock logged a port change after a conflict, re-pair every companion to the new port) |
| "Invalid config.json" on start | Edit was malformed — fix the JSON (the file is never overwritten); delete only as a last resort (regenerates with a fresh token, breaking pairings) |
| Vault locked message right after 3 wrong tries | 30 s lockout by design; wait and retry |

## Repository map (for humans and agents)

| File | Purpose |
| :--- | :--- |
| [`SPECIFICATION.md`](SPECIFICATION.md) | Authoritative architecture, schemas, IPC protocol |
| [`PROGRESS.md`](PROGRESS.md) | Build status shared across AI agents |
| [`docs/README.md`](docs/README.md) | Task-specific references and historical plans |
| [`BUGS.md`](BUGS.md) | Historical bug audit and resolutions |
| [`extension/README.md`](extension/README.md) | Companion install, pairing, behavior limits |
| [`docs/phase-6-7.md`](docs/phase-6-7.md) | Dock and vault usage notes |
| [`.agents/skills/browser-dock-builder/SKILL.md`](.agents/skills/browser-dock-builder/SKILL.md) | Implementation skill, with identical discovery copies in `.codex/` and `.opencode/` |

To save the current page, click the companion toolbar button, edit its title, choose a public group (or Ungrouped), and select **Save to BrowserDock**. Use companion v1.0.11 with an updated desktop. After reconnecting or changing pairing, refresh an open capture popup before saving. Capture keeps the connected browser and Firefox/Mullvad container; private-window tabs must be managed through the dock vault. If the save outcome is unknown, inspect the dock before saving again. Connection settings remain available from the popup.
