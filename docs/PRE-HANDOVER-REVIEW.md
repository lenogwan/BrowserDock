# Pre-Handover Review — Bugs & Security (read before implementing IMPROVEMENTS-V2)

## Windows bookmark drag-and-drop fix — 2026-09-14

The main webview now sets `dragDropEnabled: false`. Tauri's native file-drop handler defaults to enabled and must be disabled for frontend HTML5 drag-and-drop on Windows (confirmed in the installed Tauri configuration schema and Rust source). Browser-only smoke tests do not exercise this native interception. A regression checks the effective Windows window configuration, including platform overrides. Rebuild/reinstall the desktop executable to apply this window-creation setting; updating source files alone does not change an already installed binary.

## Resolution pass — 2026-09-13

Code fixes and automated checks are complete. Native Windows acceptance remains a release gate; this document does not certify an installer for release.

| Finding | Resolution |
| --- | --- |
| R1 | Confirmed tray/menu construction is inside a fallible closure; failure records a warning and does not abort window initialization. |
| R2 | Removed unused `detect_browsers` and `launch_url` desktop commands and handler entries. Internal detection/core APIs remain available. |
| R3 | Duplicate public bookmark IDs reject config load/save with an actionable error, preserving the original file byte-for-byte. No silent deduplication or bookmark loss. Regression covers both load and save. |
| R4 | Native hide/Escape return errors. Post-launch UI hide state changes only on success; failed Escape restores visible UI. Show/focus failures are recorded and emitted as `dock-error`. Rendered tests cover hide/Escape failure recovery. |
| R5 | Kept browser API failures fail-closed. Added a regression proving rejected private-window creation never retries as a normal window. Missing containers retain the explicitly designed plain-open fallback; ambiguous/API failures do not. Native Firefox/Mullvad no-window acceptance still requires Windows. |
| R6 | README and specification now explain Windows user ACLs, bearer-token sharing risk, offline vault attacks and strong passphrases. DPAPI wrapping remains a follow-up. |
| R7 | Removed unused WebSocket access from desktop CSP (frontend uses IPC). Extensions retain loopback port-wildcard CSP. Option validation now rejects malformed profiles/containers with `ERROR_INVALID_REQUEST` while keeping a healthy connection usable. |
| R8 | Replaced reversed `min_by` with explicit highest-score selection and stable ID tie-breaking; added entry-ID fallback for older WebViews; pasted URLs trim surrounding spaces while rejecting controls. Visibility/opacity already apply live. Open-dot remains an indicator, never a routing authority. |

Verified: Rust core 49/49, frontend unit tests 9/9, extension tests 33/33, Svelte diagnostics zero errors/warnings, production frontend build, rendered Chromium smoke (including failed hide/Escape), Windows-target Tauri check and Clippy with `-D warnings`. The cross-check uses the local LLVM resource compiler; it emits the existing GNU-target build-script warning but finishes successfully.

Before release, run the native Windows checklist below, especially actual Firefox/Mullvad private/container behavior, foregrounding, tray-less startup, double-Escape timing, memory usage, and installer acceptance. No release package was published in this pass.

---

**Date:** 2026-09-13 · **Base:** v0.1.0 · **Prior audit:** `BUGS.md` (states all MED/LOW fixed + verified)
**Scope of this pass:** re-verified every `BUGS.md` claim against the current tree + hunted for remaining/new issues, with emphasis on the 4 V2 items (hide behavior, opacity, groups, profiles/containers).
**Method:** code reading only (no `cargo` on this host). Rust findings MUST be confirmed on Windows with `cargo test -p browserdock-launcher`, `cargo check`, `npm run check`, `npm run test:ui`, `npm run test:extension`.

## 1. Verification of BUGS.md claims

| Claim | Current state |
|---|---|
| MED-1 accept-loop `break` | FIXED — `ws_server.rs:293-298` now `continue`s with backoff sleep + logs |
| MED-2 port-fallback warning | FIXED — `start_configured` writes `ws_port_warning`, surfaced via `startup_errors` → `get_dock_data.warnings` |
| MED-3 best-effort init | **PARTIALLY OPEN** — window ops now record-and-continue, but tray/menu construction (`desktop.rs:166-170`, `MenuItem::with_id`/`Menu::with_items` with `?`) still aborts whole `setup` on failure. See R1 |
| LOW-4 Esc lock indicator | FIXED — `keydown` Escape calls `clearPrivate(false)`; only `vault-locked` event sets `locked=true` |
| LOW-5 `focus_window` / LOW-6 `greet` | FIXED — both gone from `lib.rs` |
| LOW-7 title / LOW-8 drag timer / LOW-9 override reset / LOW-11 poll gating / LOW-12 invalid-bookmark warnings / LOW-13 localhost URLs / LOW-14 Edge subdomain rule / LOW-15 UUID expect | All FIXED as described |

## 2. Remaining / new findings (fix or consciously accept before V2)

### R1 · `desktop::initialize` still aborts startup on tray/menu errors (MED-3 remainder)
- **Where:** `src-tauri/src/desktop.rs:166-170` — `?` on `MenuItem::with_id`, `Menu::with_items`.
- **Impact:** no system tray / menu failure → `setup` returns `Err` → app won't start, same crash class MED-3 was about.
- **Fix:** same `record()` + continue pattern used two lines below for shortcuts; tray becomes optional, app still runs.

### R2 · Dead IPC commands widen attack surface (same class as removed `greet`)
- **Where:** `src-tauri/src/lib.rs:62-95` — `detect_browsers` and `launch_url` have **zero frontend callers** (grep-verified; frontend only uses `open_url`, `route_url`, `companion_status`).
- `launch_url` is a second, less-safe launcher: it bypasses `forceNewTab`/outcome reporting that `open_url` has. `detect_browsers` exposes local paths with no caller.
- **Fix:** delete both + handler entries before V2 adds even more commands (`save_group`, `route_details`, …). If kept, justify in PR.

### R3 · Public bookmarks have no ID-uniqueness validation (will break V2 groups)
- **Where:** `Config::validate` (`config.rs:99-125`) checks browser/rule IDs but never bookmark IDs; `runtime.rs:save_bookmark` public path matches "first id wins".
- `vault.rs:241-253` enforces unique IDs for private bookmarks, but a hand-edited `config.json` with duplicate public IDs edits/deletes the wrong row silently.
- **Fix (V2 prerequisite):** enforce unique public IDs on load (warn + dedupe or reject with backup) and on save; `move_bookmark` must rely on unique IDs.

### R4 · `dock_hide` / window ops fail silently
- **Where:** `desktop.rs:21-25` (`let _ = w.hide()`), `summon` (`let _` on show/focus/emit).
- **Impact:** if hide/show fails, UI state (`dockVisible`) and real window diverge — directly relevant to V2 item 1 (hide_on_open). User can't tell which mode they're in.
- **Fix:** return `Result` from `dock_hide`, surface errors to UI `error` field; log failures.

### R5 · Firefox `windows.create({incognito})` still unverified (BUGS must-verify #2, now load-bearing for V2 item 4)
- **Where:** `extension/src/core.js:204-216`.
- If Firefox/Mullvad rejects `incognito`, the no-window path returns `ERROR_BROWSER_API` and `dispatch.rs` does **not** fall back to process launch — open fails outright.
- **Fix before V2 containers:** test on Windows; on failure, catch and fall back to normal window or `launch_browser`. V2's container design inherits this path — decide fallback semantics now (`ERROR_CONTAINER_NOT_FOUND` → plain open, per V2 spec §4.5).

### R6 · File-permission threat model is undocumented in-app (auth_token + vault.enc)
- `auth_token` (UUID bearer) lives in plaintext `config.json`; any local process/user can read it and impersonate a companion (Origin check allows missing-Origin native clients — `ws_server.rs:334-348`). `vault.enc` is copyable for offline brute force (in-app 3-strikes/30 s does not transfer).
- Crypto itself is sound (Argon2id m=19 MiB/t=2 + AES-256-GCM, random salt/nonce, generic unlock errors, constant-time token compare, atomic temp-file writes, `Zeroizing` backend keys).
- **Fix:** not code — V2 docs + README must state: Windows user-ACL on `%APPDATA%\BrowserDock`, no `auth_token` sharing, minimum 8-char non-numeric secret rationale. Consider DPAPI-wrapped token as follow-up (state as non-goal if cut).

### R7 · CSP hardcodes WS port 49222; fallback port + V2 protocol fields need review
- **Where:** `src-tauri/tauri.conf.json:31` (`connect-src … ws://127.0.0.1:49222`). Port fallback (now warned, good) makes this stale; frontend doesn't open WS today so harmless, but any V2 frontend WS use would break on fallback ports.
- Extension CSP (`ws://127.0.0.1:*`) is correctly broad — keep; do not "tighten" to a single port or fallback pairing breaks.
- V2 `FOCUS_OR_OPEN` gains `container`/`profile`, `TABS_SYNC` gains `cookieStoreId`: extend `Response::valid`/`TabSync::valid` allow-lists the same strict way (length caps, charset), and keep `receive()` fail-closed behavior.

### R8 · V2-sensitive code smells to clean while touching the code
- `focus_or_open` instance selection (`ws_server.rs:204-221`) uses `min_by` with a reversed comparator to mean max-score — correct but fragile; rewrite as `max_by` + explicit tiebreak before adding container/profile scoring.
- `receive()` drops the whole connection on any malformed frame — keep strict, but prefer returning `ERROR_INVALID_REQUEST` for bad `FOCUS_OR_OPEN` (protocol-level) vs dropping (transport-level), so one bad V2 field can't kill a healthy companion.
- `save_settings` applies `always_on_top` live but shortcuts need restart (already messaged). V2's `hide_on_open`/`opacity` MUST apply live — specify in V2 §5.4 and implement (CSS var + gate flag, no restart).
- `add()` uses `crypto.randomUUID()` (`+page.svelte:267`) with no fallback — older WebViews throw; add `try/catch` with a counter-fallback ID generator.
- `directUrl` doesn't `trim()` before `new URL` — leading/trailing spaces silently yield "no Open URL row"; trim input first (control-char rejection stays).
- `openInBrowser` matches by hostname only — fine as an *indicator*, but V2 must not reuse it for container-aware routing decisions (same URL in two containers must not alias).

## 3. What was checked and cleared (no action)
- Vault lockout (3 fails → 30 s, checked pre-derive), generic unlock errors (no oracle), `Zeroizing` on keys/plaintext, atomic config/vault writes with `persist_noclobber` on create, `parse_url` rejects credentials/control chars/non-HTTP(S), glob matcher is linear (no regex ReDoS), WS binds `127.0.0.1` only with per-connection UUID registry + 5 s AUTH timeout + 60 s idle + 32-conn cap + 1 MB message cap + 200-tab/2 KB-URL sync caps, constant-time token compare, canonical-UUID duplicate protection, no `http` exfiltration (only `127.0.0.1`), no `{@html}` sinks (Svelte auto-escapes titles/URLs/errors), backend never logs secrets (null-stdio spawn), close-to-tray re-locks vault, single-Esc no longer fakes the lock indicator, Chromium/Gecko manifests stay separate (never merged), `includePrivate` opt-in defaults off.
- Accepted: frontend passphrase lives in JS strings until GC (minimized via prompt clear in `VaultModal.svelte:24-26`); V2 must extend the same discipline to group/option structs and keep private group names inside `vault.enc` only.

## 4. Recommended order for the implementing agent
1. R1 + R2 + R4 (robustness/IPC hygiene, tiny) and Windows-verify R5 — do these *with* V2 item 1 since they touch the same hide/launch paths.
2. R3 (uniqueness) as part of V2 groups data-model work — blocks `move_bookmark`.
3. R6 docs (one paragraph in README + SPEC) + R7 CSP/validation notes as part of V2 profiles/containers protocol work.
4. R8 cleanups opportunistically in the same diffs; do not batch unrelated refactors.

## 5. Windows verification checklist (still required, unchanged from BUGS.md)
- `cargo test -p browserdock-launcher`, `cargo check`, Clippy; `npm run check`, `test:ui`, `test:extension`, production build.
- R5 Firefox incognito behavior; double-Esc panic timing; Argon2 memory profile; tray-less environment startup (validates R1 fix); `crypto.randomUUID` availability in target WebView2.

## 6. V3 resizable window implementation

The dock window is resizable with a 280–800 px width range and persisted `window_size` settings. Height remains automatic unless the user drags the grip or selects a manual height in Settings; live drag updates are throttled with `requestAnimationFrame`, and commit/cancel commands keep the OS window and configuration synchronized. Snapped edge positioning is preserved while resizing, and strip mode hides the resize grip.
