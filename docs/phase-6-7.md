# Vault and desktop dock

Phase 6 adds the encrypted private bookmark vault; phase 7 connects the search UI, bookmark management, settings, shortcuts, tray and dock positioning.

## Use

Run `npm install` and `npm run tauri dev` on a Windows development machine with Rust MSVC, the Windows SDK and WebView2. `npm run dev` alone is an interface preview; it cannot save bookmarks or unlock the vault.

- Type a bookmark title/tag or an HTTP(S) URL; bare domains get `https://`.
- Use Up/Down and Enter to select and launch. Shift+Enter requests a new tab. Alt+F/M/C/E or Alt+1/2/3/4 selects a browser override; clicking the selected chip clears it.
- Add and edit public bookmarks from All bookmarks, or private bookmarks from the unlocked Vault. The save destination is fixed when editing to prevent accidental publication of private bookmarks.
- Open Vault to create a passphrase or unlock it. Creation requires at least eight characters and rejects numeric-only secrets. There is no recovery service; retain the passphrase and back up `vault.enc` if needed.
- Three failed unlock attempts impose a 30-second in-process lockout. Settings control inactivity locking (1–120 minutes, default five). Status polling does not count as activity.
- Ctrl+Shift+Space summons the dock. Escape hides it; a second Escape within 400 ms panic-locks. Ctrl+Alt+L locks and hides immediately. The lock icon and tray Lock Vault also lock. If Windows cannot register the temporary Escape shortcut, the first Escape locks as a safe fallback.
- The tray provides Show / Hide, Lock Vault, Settings and Exit. Shortcut edits take effect after restarting. An unavailable shortcut leaves the dock/tray usable and shows a message in the dock.
- Drag the grip to move the dock. Settings can snap it to the nearest monitor work-area edge, enable auto-hide to a hover strip, and toggle always-on-top. Saved edge anchoring is retained through expansion and collapse.

## Storage and security boundary

`%APPDATA%\BrowserDock\config.json` stores public bookmarks/settings and the companion token. The UI receives an explicit settings subset without that token. Private bookmarks are stored only in adjacent `vault.enc`.

The vault format is the specification's 16-byte salt, 12-byte random nonce, and AES-256-GCM ciphertext with appended tag. Argon2id uses 19456 KiB, two passes, one lane and a 32-byte key. Each save generates a fresh nonce and atomically replaces the ciphertext file. Creation never overwrites an existing vault; failed persistence does not change in-memory bookmarks.

Rust owns zeroizing keys, Argon2 working memory, serialized plaintext buffers and bookmark strings. Lock drops private state. The webview unmounts private results, password forms and editors and drops its references; JavaScript immutable strings and WebView2 garbage collection do not offer deterministic memory wiping. No private data is written to localStorage, browser storage, frontend caches or application logs. OS paging, crash dumps, browser history and browser process memory are outside this vault's protection.

Pending authentication and private mutations are checked against a lock generation. A pending lock blocks new authentication until cleanup finishes. The frontend discards private responses from an earlier generation. A browser operation already sent before panic cannot be recalled; panic does not close browser tabs.

The in-app lockout resets on app restart and cannot prevent offline guessing of a copied vault. Private companion tab inventory is separate from vault storage: an extension explicitly opted into private tabs may still report those tabs after vault lock. See `extension/README.md`.

## Checks

```sh
cargo test --manifest-path src-tauri/core/Cargo.toml
cargo clippy --manifest-path src-tauri/core/Cargo.toml --all-targets -- -D warnings
npm run test:ui
npm run test:extension
npm run check
npm run build
```

`test/browser-smoke.mjs` runs the actual Svelte UI in Chromium against an injected Tauri IPC boundary. With Playwright installed and `npm run dev` running, run `node test/browser-smoke.mjs`. An external Playwright module may be supplied with `BROWSERDOCK_PLAYWRIGHT_MODULE`. These UI tests complement the real Rust vault/transport tests; they do not execute Tauri or Win32.

## Native Windows acceptance

Before distribution, verify all four browsers with companions, minimized-window focus, no duplicate open on ambiguous timeouts, global summon and both panic gestures, shortcut conflicts, tray actions, position restore across monitors/DPI changes, and bottom-edge auto-hide. Unlock, leave idle for the configured timeout, and confirm private DOM/results disappear; repeat while editing and during authentication. Check ciphertext on disk and measure release-process memory against the under-40-MB target. UI/metadata tests cannot establish Windows resource use or foreground behavior.

Build installers on Windows with `npm run package:windows`, or trigger the
**Windows installers** GitHub Actions workflow. The output contains a per-user
NSIS setup executable and an MSI alternative, both configured with the offline
WebView2 installer. The installer bundles companion resources for staging through Settings;
browser installation and pairing remain separate user steps. A companion ZIP is also available. Configuration remains in
`%APPDATA%\BrowserDock`, not beside the executable. Packages are unsigned unless
an Authenticode signing command is configured.


## Verification recorded on 2026-09-13

35 Rust tests and 33 JavaScript unit tests passed; the Chromium smoke test passed; Svelte reported no errors or warnings; the production frontend build passed. Core and Windows Tauri checks passed after LLVM and the MSVC SDK were made available under `/tmp`; Linux cross-compilation produced `browserdock.exe`. Installer bundling and Windows UI acceptance still need to run on a native Windows runner. Two independent reviewers examined the vault/session coordination and dock controls, and material findings were corrected.
