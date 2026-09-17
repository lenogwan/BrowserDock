# BrowserDock Bug Report + Fix Plan (shared by all agents)

Latest QA resolutions and remaining native release gates are tracked in [PRE-HANDOVER-REVIEW.md](docs/PRE-HANDOVER-REVIEW.md). The historical verification counts below describe the earlier audit, not the latest release candidate.

> For Antigravity (`.agents/`), Codex CLI (`.codex/`), OpenCode (`.opencode/`) — read before fixing.
> **Audit date:** 2026-09-12 · **Scope:** full program (Rust backend, Svelte frontend, extension, configs).
> **Status: audited and corrected 2026-09-13.** This report was read against an earlier tree; several items were already fixed before this pass. The remaining reproducible findings were corrected and verified with the Rust, frontend, extension and browser smoke suites.

## Verification performed (read-only)
- `npm run check` → 0 errors, 0 warnings. `npm run test:extension` → 29/29 pass. `npm run test:ui` → 4/4 pass.
- `node extension/build.mjs` to temp dir + diff: built `chromium/` + `gecko/` outputs are **in sync** with `extension/src/` (no drift).
- Rust could NOT be compiled here (no `cargo` on this Linux host). All Rust findings below are from code reading and MUST be confirmed with `cargo test -p browserdock-launcher` and `cargo check` on Windows.

## Findings (ranked)

### MED-1 · Transient accept error kills the companion server forever
- **Where:** `src-tauri/src/ws_server.rs:282-283` — `let Ok((stream, _)) = accepted else { break; };`
- **Bug:** any transient `accept()` error (EMFILE, ECONNABORTED, …) `break`s the whole accept loop → `serve()` exits, registry cleared, companions can never reconnect until app restart. No log, no UI signal.
- **Plan:** `continue` on transient errors; only `break` on fatal ones (or after N consecutive failures with backoff). Emit the failure into `companion_status.error` so the UI can show it.

### MED-2 · Companion port fallback is invisible to the user
- **Where:** `src-tauri/src/ws_server.rs:121-132` (`eprintln!` only) + `src-tauri/src/lib.rs:153-161`.
- **Bug:** when `49222` is occupied the server binds the next free port and rewrites `config.json`, but the only notice is `eprintln!` (lost under `windows_subsystem`). The extension is manually paired to a port, so companions silently stay disconnected and the user is never told the new port.
- **Plan:** surface `port` + a "re-pair companions to port X" hint: push into `startup_errors`/`DockData.warnings` (already rendered by `get_dock_data` → `+page.svelte:154`) and/or a Settings pairing panel showing `auth_token` port. Document re-pairing in `extension/README.md`.

### MED-3 · `desktop::initialize` fails the whole app on best-effort ops
- **Where:** `src-tauri/src/desktop.rs:195-209` (`?` on `set_always_on_top`, `set_position`, `dock_resize`, `show`, `tray.build`).
- **Bug:** a transient failure in any of these (e.g. no system tray, window-manager hiccup) propagates out of Tauri `setup` → **app refuses to start**.
- **Plan:** make each best-effort: on error, push a message to `startup_errors` (same pattern as shortcut failures at `desktop.rs:150-154`) and continue. Reserve `?`/abort for truly fatal paths.

### LOW-4 · Single-Esc shows vault "locked" while backend stays unlocked
- **Where:** `src/routes/+page.svelte:122-133` (`clearPrivate` sets `vault.locked=true` locally) + `218-228` (single `Esc` → `clearPrivate()` + `dock_escape`, which only locks on the *second* press).
- **Bug:** the lock-dot is a security indicator; after one `Esc` it reports locked while `vault_status` would still report unlocked. Self-heals on next summon (`refreshVault`), but misleading in between.
- **Plan:** on `Esc`, clear `privateBookmarks`/`query`/`view` (good hygiene, keep) but do NOT set `vault.locked=true`; let the `vault-locked` event (already wired at `+page.svelte:361`) be the sole writer of the locked indicator.

### LOW-5 · `focus_window` IPC takes an arbitrary HWND and is never called
- **Where:** `src-tauri/src/lib.rs:108-111`; grep confirms zero frontend callers.
- **Bug:** dead command that lets any webview JS restore/foreground an arbitrary OS window. Low risk (local webview only) but unjustified attack surface.
- **Plan:** delete the command (and its `invoke_handler` entry). If a future feature needs it, re-add with validation (e.g. only HWNDs belonging to configured browser processes).

### LOW-6 · Leftover `greet` demo command still registered
- **Where:** `src-tauri/src/lib.rs:98-101,122`.
- **Bug:** template leftover, uncalled (grep-verified), widens IPC surface.
- **Plan:** delete `greet` + its handler entry.

### LOW-7 · Window title is still the Tauri template default
- **Where:** `src/app.html:7` — `<title>Tauri + SvelteKit + Typescript App</title>`.
- **Plan:** set to `BrowserDock`.

### LOW-8 · Overlapping drag-finish poll loops on rapid drags
- **Where:** `src/routes/+page.svelte:424-431` (reassigns `dragTimer` without clearing) + `296-308` (`finishDrag` re-arms itself).
- **Bug:** quick successive drags spawn parallel 120 ms poll loops → duplicate `dock_save_position` config rewrites.
- **Plan:** `if (dragTimer) clearTimeout(dragTimer)` before reassigning; guard `finishDrag` with a single in-flight flag.

### LOW-9 · Stale browser override survives a successful open
- **Where:** `src/routes/+page.svelte:189-217` (`open()` clears `query` but not `override`).
- **Bug:** next summon silently routes through the previous `Alt+F/M/C/E` override.
- **Plan:** reset `override = null` on successful open (keep it on error).

### LOW-10 · Snap-to-edge can use a stale window size
- **Where:** `src-tauri/src/desktop.rs:47-52` — `set_size` then immediately `outer_size()`.
- **Bug:** `set_size` applies asynchronously; `position_at_edge` may snap using the pre-resize size (off by the height delta).
- **Plan:** compute the expected outer size from the requested logical size × monitor scale factor instead of re-reading, or re-read after yielding to the event loop.

### LOW-11 · 1 s full-tab polling over IPC, even when hidden
- **Where:** `src/routes/+page.svelte:379-397` (`companion_status` ships every tab of every instance each second).
- **Bug:** unnecessary IPC/CPU/battery cost; ships all tab URLs/titles (sensitive) at 1 Hz regardless of visibility.
- **Plan:** poll at lower rate when `strip`/hidden, skip when `document.hidden`, and/or have the backend push `instances-changed` events only on diff instead of full snapshots.

### LOW-12 · Invalid public bookmarks vanish silently
- **Where:** `src-tauri/src/runtime.rs:77-81` (`filter_map(... .ok())`).
- **Bug:** corrupt entries are dropped with no signal; user thinks bookmarks disappeared.
- **Plan:** count drops and append to `warnings` (already rendered in UI).

### LOW-13 · `localhost:port` URLs can't be opened from the dock
- **Where:** `src/lib/search.js:16` — schemeless input containing `:` is rejected, so `localhost:3000` yields no "Open URL" row.
- **Plan:** accept `localhost`/`127.0.0.1`/`[::1]` (with optional port) as valid schemeless hosts, defaulting to `http://`.

### LOW-14 · Default rule misses subdomains of the Edge target
- **Where:** `src-tauri/src/config.rs:73` — pattern `*://forbidden-site.org/*`.
- **Bug:** `sub.forbidden-site.org` falls through to Firefox; almost certainly intended `*.forbidden-site.org`.
- **Plan:** fix default to `*://*.forbidden-site.org/*` (keep a comment that bare host needs its own rule under component-wise matching).

### LOW-15 · `expect()` in an async connection task
- **Where:** `src-tauri/src/ws_server.rs:355-357` (`.expect("validated UUID")`).
- **Bug:** safe today (`Auth::valid` checks first), but a future validation change turns it into a task panic. 
- **Plan:** replace with graceful `return` on parse failure.

### LOW-16 · App-crate dependency duplication (build hygiene vs 40 MB goal)
- **Where:** `src-tauri/Cargo.toml:23-31` (`tokio full`, `aes-gcm`, `argon2`, `rand`, `directories`, `uuid` duplicate `core`'s narrower deps).
- **Note:** `tokio` (used in `desktop.rs`/`runtime.rs`) and `zeroize` (used in `runtime.rs`) are justified; the rest look unused by the app crate and only cost build time/binary weight.
- **Plan:** audit with `cargo machete`/`udeps` on Windows; drop what the app crate doesn't reference. No runtime behavior change expected — verify with `cargo check` + size comparison.

## Must-verify on Windows (not bugs yet, need a Windows run)
1. `cargo test -p browserdock-launcher` (suites: `phase3/4/6`, `session`, `companion_live`) — unrunnable here.
2. `windows.create({ incognito })` support in Firefox/Mullvad (`extension/src/core.js:209`) — if unsupported, Mullvad's no-window path returns `ERROR_BROWSER_API` and (by design, `dispatch.rs`) does NOT fall back to process launch. Confirm behavior; if it fails, catch and fall back to a normal window or `launch_browser`.
3. Double-`Esc` panic timing: global `Escape` registration propagation vs fast second press (`desktop.rs:214-238`). If flaky, track first-`Esc` timestamp in backend state instead of relying on registration timing.
4. `argon2::Block` import + `Params::new(19456, 2, 1, …)` compile/memory profile on target machines (`crypto.rs:10-23`).

## Accepted limitations (no action)
- Frontend passphrase lives in immutable JS strings until GC (cleared promptly in `VaultModal.svelte:24-26`; backend uses `Zeroizing`). Inherent to webview; already minimized.
- Extension CSP allows `ws://127.0.0.1:*` (any local port) — required for the port-fallback design; localhost-only so acceptable.
- Open-tab indicator matches by hostname only (`search.js:33-50`) — coarse by design (indicator, not router).

## Suggested fix order for whoever picks this up
1. MED-1 + MED-3 (robustness/crash class) + confirm Windows verify-list.
2. MED-2 (user-visible pairing breakage).
3. LOW-4, LOW-5, LOW-6 (security-indicator + IPC hygiene).
4. LOW-7…LOW-16 (UX/polish), each independently committable.

## Verification result

Fixed in this pass: MED-1, MED-2, MED-3, LOW-4, LOW-5, LOW-6, LOW-7, LOW-8, LOW-9, LOW-11, LOW-12, LOW-13, LOW-14 and LOW-15. LOW-10 now yields after an asynchronous resize before edge positioning. LOW-16 remains build hygiene rather than a demonstrated runtime defect; app dependencies were retained where used by Tauri/runtime or target-specific integrations.

The Rust core suite passes 35 tests including QA regressions, JavaScript suites pass 33 tests, the rendered Chromium smoke test passes, Svelte check reports zero diagnostics, the production frontend build passes, and Windows-target Tauri check/Clippy pass. Native Windows foregrounding, tray, browser-extension installation, memory, and installer acceptance still require a Windows machine.
