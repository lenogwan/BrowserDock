# BrowserDock Progress Log (shared by all agents)

> Antigravity (`.agents/`), Codex CLI (`.codex/`), OpenCode (`.opencode/`) —
> read this file before starting work so phases aren't duplicated.

## Status as of 2026-09-13

- [x] **Phase 1 — Project scaffolding (Tauri v2 + Svelte 5 + Tailwind): DONE**
  - Tauri v2 (SvelteKit `svelte-ts` template, static-adapter SPA) + Tailwind v3 + `lucide-svelte` + `fuse.js`.
  - Key files: `package.json`, `tailwind.config.js`, `postcss.config.js`, `src/app.css`, `src/routes/+layout.svelte`, `src/routes/+page.svelte` (400px dock pill placeholder).
- [x] **Phase 2 — Window config + Win32 integration: DONE**
  - `src-tauri/tauri.conf.json`: 400×56, frameless, `alwaysOnTop`, `skipTaskbar:true`, `transparent:true`, `shadow:false`, `visible:false` + show-after-center, restrictive CSP (`ipc:` + `ws://127.0.0.1:49222` only).
  - `src-tauri/src/win32_helper.rs`: corrected `HWND(*mut c_void)` + `AttachThreadInput`/`AllowSetForegroundWindow` foreground-lock workaround.
  - `src-tauri/src/lib.rs` (`dock_status`, `focus_window`), `src-tauri/Cargo.toml` (pinned deps incl. `single-instance`, `global-shortcut`, `zeroize`, `directories 6.0`), `src-tauri/capabilities/default.json`.
- [x] **Spec/skill audit fixes (14 items) applied to `SPECIFICATION.md` + all 3 skill copies (sha256 `46287b0d…`, verified identical).**

- [x] **Phase 3 — IMPLEMENTED; native Windows smoke checks pending.** `launcher.rs`, `config.rs`, `routing.rs`, `detection.rs` provide configuration reader/atomic writer, registry/default-path detection, ordered glob routing, manual overrides and URL-last launching. `src-tauri/core/` builds the library independently; Tauri exposes `detect_browsers`, `route_url`, `launch_url`. Usage and smoke checklist: [`docs/phase-3.md`](docs/phase-3.md).
- Phase 3 also corrects existing integration imports: `tauri::Manager` and `AttachThreadInput` from `Win32::System::Threading`.

## Verification
- `npm install` OK · `npm run check` → 0 errors, 0 warnings · `npm run build` → `build/` OK.
- Temporary Rust 1.98.1 toolchain installed under `/tmp` for this session. Phase 3 core tests: **10 passed**, including real process spawning. Clippy with warnings denied: passed. Windows core/test compile check: passed (`x86_64-pc-windows-msvc`).
- Full Tauri Windows cross-check attempted; blocked in resource compilation by missing `llvm-rc`. Native Windows registry/process/UI behavior remains unverified. Frontend checks rerun: 0 errors/warnings; production build passed.
- Additional Windows Rust metadata check passed for the actual `src-tauri/src/lib.rs`, using compiled Tauri/plugin dependencies and generated build metadata. This verifies command handlers/macros and the Win32 helper, but does not replace resource compilation, linking or native runtime tests. Core formatting check passed.
- Independent code review found no material phase 3 issues.

## Next up
- [x] **Phases 4–5 — IMPLEMENTED; native Windows validation pending.** Authenticated loopback WebSocket server, instance-keyed tab registry, bounded inventories/queues, correlated focus/open dispatch, and persisted port fallback are integrated with Tauri. Separate Chromium/Gecko companions include explicit pairing, reconnect/heartbeat, and opt-in private-tab access. Installation and manual checks: [`extension/README.md`](extension/README.md).
- Fresh verification on 2026-09-12: **22 Rust tests passed** (10 launcher, 11 WebSocket, 1 production JavaScript-to-Rust integration); **29 extension tests passed**. Extension distributions rebuilt. Core Clippy with warnings denied and formatting passed. Windows core/test compile check passed. Svelte check reported 0 errors/warnings; production frontend build passed.
- Full Tauri Windows check remains blocked by missing `llvm-rc` during resource compilation. This run does not verify the final Tauri application, native foregrounding, actual browser extension loading, or memory usage. See the companion manual Windows checklist before shipping.
- [x] **Phase 6 — Private Vault & Crypto Engine: IMPLEMENTED & VERIFIED**
  - Argon2id key derivation (`m=19456 KiB, t=2, p=1`, 32-byte key) and AES-256-GCM encryption (`salt(16) || nonce(12) || ciphertext||tag`).
  - Key, buffer, and bookmark string memory wiping on drop using `zeroize::Zeroizing`.
  - Atomic persistence via `tempfile::NamedTempFile` with `sync_all()` (`persist_noclobber` on create ensures existing vaults are never overwritten).
  - 3-consecutive-failure 30-second lockout, monotonic inactivity timeout (configurable 1–120 min, default 5 min), panic wipe ticketing (`SessionGate`).
  - 12 Rust tests passed (8 in `phase6.rs`, 4 in `session.rs`).

- [x] **Phase 7 — Frontend UI, System Tray & Desktop Controls: IMPLEMENTED & VERIFIED**
  - Svelte 5 + Tailwind compact dock (400×56 collapsed, expandable to 410–560px for search results, vault unlock/creation, bookmark CRUD, and settings).
  - Fuzzy bookmark search via `fuse.js`, direct URL routing, browser indicator badges and hotkey overrides (`Alt+F/M/C/E`, `Alt+1..4`), `Shift+Enter` force-new-tab, active tab open indicators.
  - Bookmark editor (public vs private bookmark CRUD) with client & server validation.
  - Global shortcuts (`Ctrl+Shift+Space` summon, `Ctrl+Alt+L` panic, double-`Esc` 400ms panic lock), system tray menu (Show/Hide, Lock Vault, Settings, Exit).
  - Screen edge snapping (`left`, `right`, `top`, `bottom`), auto-hide to hover strip, monitor work area clamping.
  - 4 UI unit tests in `test/search.test.mjs`, full Playwright browser smoke test passed in `test/browser-smoke.mjs`.
  - Svelte check: 0 errors, 0 warnings; production frontend build passed into `build/`.
  - Full Windows MSVC `cargo check` and `cargo clippy` passed on `src-tauri` using `llvm-rc`.
  - Detailed usage and manual Windows acceptance checklist: [`docs/phase-6-7.md`](docs/phase-6-7.md).

## Verification Summary (All Phases 1–7)
- **34 Rust tests passed** (10 Phase 3 launcher/routing, 11 Phase 4 WebSocket server, 1 live Node-to-Rust companion integration, 8 Phase 6 vault crypto, 4 session gate).
- **33 JavaScript tests passed** (29 extension tests, 4 UI search/routing tests).
- **Browser UI smoke test passed** (Playwright Chromium: search, routing, force-new-tab, bookmark CRUD, Escape restore, panic clearing, stale private response discard, auto-hide, layout).
- **Windows MSVC compilation check passed** (`cargo check --target x86_64-pc-windows-msvc` and `cargo clippy` with warnings denied on both `core` and `src-tauri`).
- **Frontend checks passed** (`npm run check` → 0 errors, 0 warnings; `npm run build` → `build/` OK).
- **Remaining validation**: Native Windows runtime smoke verification on actual Windows hardware/VM with real browser installations and live `SetForegroundWindow` lock testing (see [`docs/phase-6-7.md`](docs/phase-6-7.md) and [`extension/README.md`](extension/README.md)).

## Rules
- Keep the 3 skill copies in sync: edit `.agents/skills/browser-dock-builder/SKILL.md`, then `cp` to `.codex/...` and `.opencode/...`, re-verify with `sha256sum`.
- Update this log when finishing a phase.

