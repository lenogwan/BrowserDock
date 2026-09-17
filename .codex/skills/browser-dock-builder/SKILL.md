---
name: browser-dock-builder
description: >-
  Use this skill to implement, maintain, and extend BrowserDock on Windows.
  Guides the complete architecture using Tauri v2 (Rust backend), Svelte 5/Tailwind CSS
  (always-on-top floating dock), the WebSocket-based cross-browser companion extension
  for tab focusing, and the Argon2id + AES-256-GCM encrypted private vault.
---

# BrowserDock Implementation & Engineering Skill

This skill guides an AI developer agent through the end-to-end implementation of **BrowserDock**: a high-performance, lightweight Windows launcher and bookmark manager that routes URLs to designated browsers (Firefox, Mullvad, Chrome, Edge), focuses existing tabs via a companion extension, and secures sensitive bookmarks behind an encrypted PIN vault.

Detailed technical architecture and data schemas are defined in [SPECIFICATION.md](../../../SPECIFICATION.md).

---

## Current V2 implementation invariants

Read [SPECIFICATION.md §3–5](../../../SPECIFICATION.md) and [the V2 requirements](../../../docs/IMPROVEMENTS-V2.md) before changing settings, groups or launch options. The older scaffolding examples below describe initial construction; maintain the existing core/app separation instead of copying all core dependencies into the Tauri app crate.

- Config writes use version `1.1.0`; accept legacy `1.0.0` and create a byte-for-byte `config.json.bak.<timestamp>` before migration. Preserve unknown fields and unreadable raw bookmarks.
- `always_on_top` controls z-order, `hide_on_open` (default true) controls successful post-launch hiding, and `auto_hide` controls pointer-leave collapse. Keep these independent. Background opacity is `0.3–1.0`, default `1.0`; preview without persisting until Save, and never fade text/borders with element opacity.
- Public groups belong in config; private groups/options belong only in the encrypted vault. Vault plaintext is `{version:2,bookmarks,groups}`; accept legacy arrays/version-1 envelopes. Keep the salt/nonce/ciphertext binary layout unchanged. Zeroize new private strings and reject cancelled private mutations/fallback launches using the session gate.
- Bookmark `group_id` is nullable and `sort_order` is normalized per group. Deleting a group ungroups bookmarks. Scope every UI key, drag target and lookup by public/private as well as ID. Provide keyboard group assignment and group up/down ordering.
- Resolve bookmark/rule/browser options before launch using current DesktopState config. Profiles apply to Chrome/Edge, containers to Firefox/Mullvad; empty options inherit defaults. Incognito skips companion focus reuse. Pass validated CLI args separately and the URL last.
- `FOCUS_OR_OPEN` adds optional `container`/`profile`; Gecko tab inventory adds `cookieStoreId`. Gecko alone has `contextualIdentities`/`cookies` permissions and broadcasts `CONTAINERS_LIST`. Missing containers permit plain fallback with a visible note; ambiguous timeout/disconnect errors must not create duplicate tabs.
- Desktop IPC adds `save_group`, `delete_group`, `move_bookmark`, `save_browser`, `route_details`, and `browser_profiles`; `route_url` remains a string response. `vault_list` returns `{bookmarks,groups}`, with frontend legacy-array fallback. `open_url` accepts bookmark identity and explicit private scope.
- Validate with core tests (`cargo test --manifest-path src-tauri/core/Cargo.toml`), Svelte checks, UI/extension suites, browser smoke and Windows-target compilation. Native Windows focus/tray/memory/profile behavior still needs target-machine acceptance.

---

## 1. Tech Stack & Environment Prerequisites

* **Core Runtime:** Tauri v2 (`@tauri-apps/cli@2`, `tauri@2.x`)
* **Backend:** Rust (2021 edition) with `windows-rs`, `tokio`, `tokio-tungstenite`, `aes-gcm`, `argon2`, `serde`, `serde_json`
* **Frontend:** Svelte 5 + TypeScript + Vite + Tailwind CSS + Lucide Icons
* **Browser Extension:** Cross-browser WebExtension (Manifest V3 for Chromium: Chrome/Edge, and Gecko-compatible for Firefox/Mullvad)
* **Target OS:** Windows 10/11 (MSVC toolchain, WebView2 runtime)

---

## 2. Step-by-Step Implementation Runbook

### Phase 1: Tauri Project Initialization
> Note (verified Sep 2026): `svelte-ts` now scaffolds a SvelteKit app
> (`src/routes/`, `adapter-static`), not plain Vite+Svelte. That is accepted —
> keep the static-adapter SPA output (`frontendDist: ../build`). Do NOT
> overwrite existing repo docs. Scaffold to a temp dir then copy
> (`package.json`, `src/`, `src-tauri/`, configs) if the workspace root is
> non-empty, since `create-tauri-app` refuses non-empty dirs without `--force`.
> Pin Tailwind to v3 (`tailwindcss@3`, `tailwind.config.js` + `postcss.config.js`);
> v4 uses a different Vite-plugin setup.
Run the initialization in the workspace root:
```bash
npm create tauri-app@latest . -- --template svelte-ts --manager npm
npm install -D tailwindcss@3 postcss autoprefixer lucide-svelte fuse.js
npx tailwindcss init -p
```

In `src-tauri/Cargo.toml`, add required dependencies:
```toml
[dependencies]
tauri = { version = "2.0", features = ["tray-icon"] }
tauri-plugin-shell = "2.0"
tauri-plugin-single-instance = "2"
tauri-plugin-global-shortcut = "2"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1.38", features = ["full"] }
tokio-tungstenite = "0.23"
futures-util = "0.3"
aes-gcm = "0.10"
argon2 = "0.5"
rand = "0.8"
directories = "6.0"
uuid = { version = "1.8", features = ["v4"] }
zeroize = "1.8"

[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_UI_WindowsAndMessaging",
    "Win32_Foundation",
    "Win32_System_Threading"
] }
```
> `directories` 5.x is deprecated — use 6.x. `Win32_System_Threading` is
> required for the `AttachThreadInput` foreground-lock workaround in Phase 2.
> `zeroize` is required for vault key cleanup in Phase 6.

### Phase 2: Window Configuration & Win32 Integration
Configure `src-tauri/tauri.conf.json` for an always-on-top, frameless floating pill (authoritative geometry: 400x56; `skipTaskbar: true` maps to `WS_EX_TOOLWINDOW`; `shadow: false` because WebView2 transparent windows cannot cast shadows; `visible: false` + show-after-center avoids white flash; CSP must allow `ipc:` and `ws://127.0.0.1`):
```json
{
  "app": {
    "windows": [
      {
        "title": "BrowserDock",
        "label": "main",
        "width": 400,
        "height": 56,
        "decorations": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "resizable": false,
        "transparent": true,
        "shadow": false,
        "center": true,
        "visible": false,
        "focus": true
      }
    ],
    "security": {
      "csp": "default-src 'self' ipc: http://ipc.localhost; connect-src ipc: http://ipc.localhost ws://127.0.0.1:49222; style-src 'self' 'unsafe-inline'; script-src 'self';"
    }
  }
}
```

#### Windows API Focus Helper (`src-tauri/src/win32_helper.rs`):
When a tab is focused in a browser, Windows requires `SetForegroundWindow` to bring the browser to the front. Note: the call alone usually FAILS due to the foreground-lock timeout — the `AttachThreadInput` + `AllowSetForegroundWindow` sequence below is required, and the extension's `windows.update({focused:true})` remains the more reliable path:
```rust
#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, HWND};
#[cfg(windows)]
use windows::Win32::System::Threading::GetCurrentThreadId;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, AttachThreadInput, BringWindowToTop,
    GetForegroundWindow, GetWindowThreadProcessId,
    SetForegroundWindow, ShowWindow, SW_RESTORE,
};

pub fn bring_window_to_front(hwnd_val: isize) -> bool {
    #[cfg(windows)]
    unsafe {
        // Correct: HWND wraps *mut c_void, NOT `as *mut _`.
        let hwnd = HWND(hwnd_val as *mut core::ffi::c_void);
        if hwnd.0.is_null() {
            return false;
        }
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let fg = GetForegroundWindow();
        let cur = GetCurrentThreadId();
        let mut pid = 0u32;
        let fg_thread = GetWindowThreadProcessId(fg, Some(&mut pid));
        let attached = fg_thread != 0
            && fg_thread != cur
            && AttachThreadInput(cur, fg_thread, BOOL(1)) == BOOL(1);
        let _ = AllowSetForegroundWindow(u32::MAX); // ASFW_ANY
        let ok = SetForegroundWindow(hwnd).as_bool();
        let _ = BringWindowToTop(hwnd);
        if attached {
            let _ = AttachThreadInput(cur, fg_thread, BOOL(0));
        }
        ok
    }
    #[cfg(not(windows))]
    { false }
}
```

---

### Phase 3: Browser Launching & Domain Routing
Create `src-tauri/src/launcher.rs`:
1. **Registry Detection:** Query `HKLM\SOFTWARE\Clients\StartMenuInternet` or default paths for Firefox, Mullvad, Chrome, Edge.
2. **Process Spawn Fallback:** If browser is not running or extension is not connected. Pass `extra_args` first and the URL last (Firefox: `firefox.exe -new-tab <url>`; Chrome/Edge rely on single-instance default — `chrome.exe <url>` reuses the running window):
3. **Rule Evaluator:** Match URL against configured glob rules (case-insensitive host; `*` = any run, `?` = one char; `*://` = any scheme), sorted by `priority` ascending (lower wins, first match wins, `id` ascending breaks ties). No match => fallback `firefox`.
   ```rust
   pub fn launch_browser(exe_path: &str, url: &str, extra_args: &[String]) -> Result<(), String> {
       let mut cmd = std::process::Command::new(exe_path);
       for arg in extra_args {
           cmd.arg(arg);
       }
       cmd.arg(url);
       cmd.spawn().map_err(|e| e.to_string())?;
       Ok(())
   }
   ```
3. **Rule Evaluator:** Match URL against configured glob/regex rules to select the target browser automatically. (See corrected semantics above.)

---

### Phase 4: Embedded WebSocket Server for Tab Focus
Create `src-tauri/src/ws_server.rs`:
* Spawn a background Tokio task listening on `127.0.0.1:{ws_port}` (`ws_port` from `config.json`, default `49222`; on `EADDRINUSE` try next free port and log it — never hardcode in the extension).
* Require `{type:AUTH, token, browser, instance_id}` within 5s; close violators. `token` MUST equal `config.json.auth_token` (constant-time compare).
* Maintain a thread-safe registry keyed by per-connection `instance_id`, NOT bare `browser_id`: `Arc<Mutex<HashMap<String /*instance_id*/, (String /*browser*/, Tx)>>>` with an mpsc `Tx` per socket (`SplitSink` is neither `Clone` nor directly shareable). Firefox+Mullvad may share `browser`-family but MUST occupy separate entries.
* Route incoming commands (authoritative names from SPECIFICATION.md §4.2):
  * `TABS_SYNC`: Update internal cache of open tabs (debounced ≥500 ms, ≤200 tabs/message).
  * `FOCUS_OR_OPEN` with `{id, action, url, match_mode}`: Request extension to switch to matching URL or open a new tab; reply shape is `{id, status:SUCCESS, result:FOCUSED_EXISTING|OPENED_NEW_TAB, ...}`.

---

### Phase 5: Cross-Browser Companion Extension
Create `extension/` directory with TWO builds (never one manifest with both keys — that is invalid):
- `extension/chromium/manifest.json` (Chrome/Edge): MV3 with `background.service_worker`.
- `extension/gecko/manifest.json` (Firefox/Mullvad): `background.scripts` + `browser_specific_settings.gecko`.

#### `extension/chromium/manifest.json` (Gecko variant mirrors it with `scripts`):
```json
{
  "manifest_version": 3,
  "name": "BrowserDock Companion",
  "version": "1.0.0",
  "description": "Enables BrowserDock to focus and switch tabs natively.",
  "permissions": ["tabs", "windows"],
  "host_permissions": ["*://*/*"],
  "background": {
    "service_worker": "background.js"
  }
}
```
> Gecko `manifest.json` uses `"background": { "scripts": ["background.js"] }` plus `"browser_specific_settings": { "gecko": { "id": "browserdock@example.com" } }` instead.

#### `extension/background.js` (both builds; `BROWSER_ID` + `AUTH_TOKEN` injected at install/pairing time — never UA-sniff: Mullvad spoofs UA):
```javascript
// Injected per install: e.g. "firefox" | "mullvad" | "chrome" | "edge"
const BROWSER_ID = "__BROWSER_ID__";
// Pasted once from %APPDATA%/BrowserDock/config.json auth_token during pairing
const AUTH_TOKEN = "__AUTH_TOKEN__";
// Port from config (default 49222)
const WS_URL = "ws://127.0.0.1:49222";
let socket = null;
const INSTANCE_ID = crypto.randomUUID();

function connect() {
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "AUTH", token: AUTH_TOKEN, browser: BROWSER_ID, instance_id: INSTANCE_ID }));
  };

  socket.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.action === "FOCUS_OR_OPEN") {
      // Authoritative fields: data.url + data.match_mode (NOT data.target_domain).
      const tabs = await chrome.tabs.query({});
      const target = tabs.find(t => t.url && t.url.includes(data.url));

      if (target) {
        await chrome.tabs.update(target.id, { active: true });
        await chrome.windows.update(target.windowId, { focused: true });
        // Authoritative reply shape (NOT {status:FOCUSED}).
        socket.send(JSON.stringify({ id: data.id, status: "SUCCESS", result: "FOCUSED_EXISTING", window_id: target.windowId, tab_id: target.id }));
      } else {
        const newTab = await chrome.tabs.create({ url: data.url });
        socket.send(JSON.stringify({ id: data.id, status: "SUCCESS", result: "OPENED_NEW_TAB", window_id: newTab.windowId, tab_id: newTab.id }));
      }
    }
  };

  socket.onclose = () => setTimeout(connect, 3000);
}

connect();
```
> `TABS_SYNC` broadcasts from the extension MUST be debounced (≥500 ms), capped (≤200 tabs), URL-truncated (≤2 KB).

---

### Phase 6: Private Vault (Argon2id + AES-256-GCM)
File layout (authoritative, cf. SPECIFICATION.md §3.2): `[0..16] salt | [16..28] nonce | [28..N] ciphertext||tag`. There is NO standalone `[28..44] tag` slice — `aes-gcm` appends the 16-byte tag to the ciphertext.
Create `src-tauri/src/crypto.rs`:
* **Key Derivation:** Argon2id(`m=19456 KiB, t=2, p=1`) → 32-byte key from `salt:&[u8;16]` + secret. Reject secrets < 8 chars / numeric-only PINs at set-time (offline-brute-forceable).
  ```rust
  use argon2::{Argon2, PasswordHasher};
  use argon2::password_hash::SaltString;
  use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};

  pub fn derive_key(pin: &str, salt: &[u8]) -> [u8; 32] {
      // Derive 256-bit symmetric key using Argon2id (see params above)
  }

  pub fn encrypt_vault(data: &[u8], key: &[u8; 32]) -> Vec<u8> {
      // Generate 16-byte salt + 12-byte random nonce, encrypt with Aes256Gcm, emit salt || nonce || ciphertext||tag
  }

  pub fn decrypt_vault(blob: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
      // Split salt/nonce/ciphertext||tag, decrypt with Aes256Gcm (fail closed on tag mismatch)
  }
  ```
* **Memory Sanitation:** `zeroize` derived keys + plaintext buffers upon lock/timeout; drop decrypted bookmarks (unmount DOM, exclude from search — only ciphertext bytes may remain).
* **Auto-Lock:** In Tauri, register a Tokio interval timer (`vault_timeout_minutes`, default 5) that resets upon user activity. If timer expires, discard memory key and emit `vault-locked` event to frontend.

---

### Phase 7: Svelte 5 Frontend Implementation
Create the UI components in `src/`:
1. `src/lib/SearchBar.svelte`: Autocomplete input, keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`). Input MUST autofocus on summon (with `svelte-ignore a11y_autofocus` + comment, since a launcher requires focus).
2. `src/lib/BrowserBadge.svelte`: Visual indicators for `[F]`, `[M]`, `[C]`, `[E]` with hotkey labels.
3. `src/lib/VaultModal.svelte`: passphrase input (min 8 chars; reject numeric-only PINs) with shake animation on invalid secret; 3 consecutive failures => 30 s lockout (in-app only — does not protect copied `vault.enc`).
4. `src/lib/BookmarkList.svelte`: Fuzzy search results with target browser icons and "currently open" indicator dots.
Global hotkey default is `Ctrl+Shift+Space` (never `Alt+Space` — Windows window-menu conflict) via `tauri-plugin-global-shortcut`; single `Esc` hides, double-`Esc` (≤400 ms) panic-locks the vault.

---

## 3. Verification & Validation Checklist

Before handing off or shipping milestones, verify:
- [ ] **Always-on-Top:** App stays on top of full-screen browser windows without flickering.
- [ ] **Memory Usage:** Verify task manager shows `< 40 MB RAM` for `BrowserDock.exe`.
- [ ] **Domain Routing:** Pasting `https://docs.google.com` launches/routes to Chrome; `https://check.torproject.org` routes to Mullvad.
- [ ] **Tab Focus:** Clicking an already open GitHub bookmark brings Firefox directly to that tab instead of opening a duplicate tab.
- [ ] **Vault Security:** Inspecting `%APPDATA%/BrowserDock/vault.enc` in a hex editor shows pure ciphertext; no URLs or titles visible in plaintext.
- [ ] **Panic Lock:** Double-pressing `Esc` immediately re-locks the vault and resets search filter.
