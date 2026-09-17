# Phase 3: configuration, detection and launching

The launcher library lives at `src-tauri/src/launcher.rs`, with configuration,
routing and detection in adjacent modules. `src-tauri/core/Cargo.toml` builds these
modules independently of Tauri for testing. The desktop application depends on it.

On startup, BrowserDock reads `%APPDATA%/BrowserDock/config.json`. A missing file
is created with specification defaults, a fresh UUID authentication token and
detected browser paths. An invalid existing file is preserved; launch and route
commands return its load error. Edit the file while the app is closed and restart
to load changes. `Config::save` validates and atomically replaces it, retaining
unknown fields. Settings, tokens and bookmarks are not exposed by phase 3 IPC.

Detection checks per-user and machine `SOFTWARE\Clients\StartMenuInternet` keys
in both registry views, then Program Files and local application directories.
Registry arguments are never executed. Only existing browser executables are
returned. Portable/custom installations use an absolute `exe_path` and `args`
array. An empty built-in path triggers discovery at launch; a nonempty custom
path is retained and returns an error if missing.

Routing supports host-only globs (`docs.google.com`, `*.onion`) and scheme/host/path
globs (`*://*.google.com/*`). `*` matches any run, `?` one character. Hosts are case
insensitive; paths, queries and fragments are case sensitive. Host globs cannot
consume paths or query strings. Host matching ignores URL ports; do not include
ports in rule patterns. Lower priority wins, then ascending rule ID. No match
selects Firefox. Defaults include `check.torproject.org` → Mullvad to satisfy the
builder runbook's verification example. There is no implicit regex mode.

Only absolute HTTP(S) URLs without credentials or control characters are accepted.
An explicit browser selection overrides rules. Missing targets never silently
fall back to a different browser after selection.

## Tauri commands

```typescript
import { invoke } from '@tauri-apps/api/core';

const installed = await invoke('detect_browsers'); // Browser[] per spec schema

// Preview does not require the target browser to be installed.
const target = await invoke<string>('route_url', {
  url: 'https://docs.google.com',
}); // chrome

// Omit browserId to use routing; supply it for bookmarks/manual overrides.
const launched = await invoke<string>('launch_url', {
  url: 'https://example.org', browserId: 'edge',
}); // edge, if spawning succeeds
```

Launching uses `Command`, separate arguments and the normalized URL last.
Firefox defaults to `-new-tab`; Chrome/Edge use normal instance reuse. Success
confirms process creation, not page loading. Browser output is discarded and
children are reaped in the background. Phase 4 adds extension dispatch before
this process fallback; search/keyboard UI remains phase 7.

## Verification

```sh
cargo test --manifest-path src-tauri/core/Cargo.toml
cargo clippy --manifest-path src-tauri/core/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/core/Cargo.toml --check
cargo check --manifest-path src-tauri/core/Cargo.toml --target x86_64-pc-windows-msvc --all-targets
npm run check
npm run build
```

On Windows with MSVC build tools and WebView2:

1. Run `cargo check --manifest-path src-tauri/Cargo.toml` and `npm run tauri dev`.
2. Confirm first-run config generation, then restart and confirm the token and
   custom paths remain unchanged.
3. Invoke `detect_browsers` and compare with installed browser paths.
4. Launch `https://docs.google.com` (Chrome), `https://check.torproject.org`
   (Mullvad), and `https://example.org` (Firefox), with browsers stopped/running.
5. Supply `browserId: 'edge'` and verify it overrides a Google routing rule.
6. Set a missing executable path and confirm an error without another browser opening.
7. Verify paths with spaces and URLs containing `&` open correctly.

Linux cannot establish native browser behavior. The full Windows cross-build on
this host stops in Tauri's resource step because `llvm-rc` is unavailable; core
Windows compilation is checked separately. An additional direct Rust metadata
check of the real Tauri entry module passed with compiled Windows dependencies
and generated Tauri build metadata, covering command handlers and the Win32 helper.
It does not verify resource compilation, linking or runtime behavior.

API references: [winreg](https://docs.rs/winreg/0.55.0/winreg/) and
[url parsing](https://docs.rs/url/2.5.8/url/).
