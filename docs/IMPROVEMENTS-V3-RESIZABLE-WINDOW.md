# Resizable Dock Window — Handover Spec for Implementing Agent

> Historical design/audit record. Read [current status](../PROGRESS.md) first. Original checkboxes, line numbers, environment limits and proposed fixes below are not a current work queue; use SPECIFICATION for current contracts.

**Status:** Implemented; retained design record. Native acceptance remains pending (see PROGRESS).
**Date:** 2026-09-13
**Base:** post-V2 tree (`config.json` version `"1.1.0"`, V2 settings `hide_on_open` + `opacity` present)
**Scope:** 1 feature — user-resizable dock window (width + height). No crypto, protocol, or telemetry changes.

Related files (verify before coding):
- Window declaration: `src-tauri/tauri.conf.json:13-29` (`width: 400`, `height: 56`, `resizable: false`, `decorations: false`, `transparent: true`)
- Programmatic sizing: `src-tauri/src/desktop.rs:26-57` (`dock_resize` forces `LogicalSize(400, h)`, clamps `6..available max 560`, re-anchors snapped edge, clamps into work area)
- Position persist: `src-tauri/src/desktop.rs:86-126` (`dock_save_position`; persists position only, never size)
- Startup restore: `src-tauri/src/desktop.rs:205-229` (restores position, forces height 56, shows window)
- Fixed-width styling: `src/routes/+page.svelte:619-646` (`main { width: 400px; height: 56px }`, `main.expanded { height: 100vh }`), `src/routes/+page.svelte:114-118` (`$effect` calls `dock_resize` on every height change)
- Drag-to-move: `src/routes/+page.svelte:438-450` (`startDragging` on grip), capabilities `src-tauri/capabilities/default.json` (has `allow-start-dragging`, no size permissions — keep it that way by resizing through a backend command, not frontend window API)
- Strip mode: `+page.svelte:321-340` (`leave()` collapses to 6px strip when `auto_hide`)

---

## 1. Requirement

The dock window is currently fixed at 400px wide (`resizable: false`) with backend-driven height. Users want to resize it themselves — both width and height — and have the size survive restarts.

## 2. Required behavior

### 2.1 Resize interaction
- A visible resize grip in the bottom-right corner of the dock (pill and expanded states), plus a `nwse-resize` cursor. Dragging it live-resizes the window in both dimensions.
- Implementation must go through a **new backend Tauri command** (e.g. `dock_set_size { width, height }`), NOT frontend `getCurrentWindow().setSize` — this avoids adding window capability permissions and keeps all clamping/anchoring logic in one place (`desktop.rs` next to `dock_resize`).
- Throttle: frontend sends updates on pointermove (rAF-throttled is fine); backend applies immediately. No debounce-then-jump — resize must feel live.
- Resize is disabled while in strip mode (`strip == true`): the 6px strip has no grip. Waking the strip restores the stored user size.

### 2.2 Size model (the core design — follow exactly)
- **Width is fully manual.** Default `400`, min `280`, max `800`. Changing views, queries, or settings panels MUST NOT alter the width. `dock_resize` must stop forcing `400` and instead preserve the current window width (read via `outer_size` + scale factor, same technique already used for edge anchoring).
- **Height has two modes:**
  - *Auto (default):* today's behavior — `dock_resize` sets height from view (`56` pill, `440–560` expanded, `6` strip). This is what fresh installs and all existing users get.
  - *Manual:* entered the first time the user drags the grip vertically (or sets height in Settings). In manual mode, changes between expanded views MUST NOT resize the height; panel content scrolls internally (`.panel-content` already has `overflow-y: auto`). A "Reset to auto size" button in Settings (and double-click on the grip) clears manual mode and returns to auto.
- Persist: `settings.window_size: { "width": 400, "height": null }` (`height: null` = auto mode) plus the existing keys untouched. Old configs without the key behave as `{400, null}`.
- Collapse override (corrected 2026-09-15): Collapse always shrinks the native window to 56px, preserving the saved manual height for expansion. The 6px auto-hide strip also overrides manual height.
- Startup: after the existing position restore, apply stored width and the 56px pill height; restore saved manual height when expanded. Strip/auto_hide state is orthogonal and unchanged.

### 2.3 CSS changes
- `main { width: 400px }` → `width: 100%` (fill the WebView window; the window is the sized entity, not the div). Keep `max-width` unbounded — the backend clamp is authoritative.
- `main.expanded { height: 100vh }` stays (fills manual or auto height alike).
- Grip styling: 16×16 corner area, subtle dots/chevron in `--muted`, `touch-action: none` during drag, hidden in strip mode. Respect `prefers-reduced-motion` (no grip animation; resize itself is instant by nature).

### 2.4 Snapping / edge interplay
- When `dock_position.snapped` is true with an `edge`, resizing must keep the anchored edge pinned (extend the existing `position_at_edge` + `clamp` helpers: after `set_size`, re-pin to the stored edge — same pattern `dock_resize` already uses).
- `dock_save_position` continues to persist position; extend it (or the new command) to persist size in the same write so drag-move + resize never produce torn state. One config write per gesture end (pointerup), not per pointermove — apply live in memory, persist on release.

### 2.5 Validation (backend, fail-closed)
- Non-finite, zero, or negative inputs → `Err("Dock size must be finite")` (mirror the `dock_resize` finite check).
- Clamp width `280–800`, height `56–<work-area height>` (reuse the monitor work-area lookup in `dock_resize`; never exceed it, never go off-screen — reuse `clamp`).
- `save_settings` / config `validate()` must accept and preserve `window_size`; hand-edited garbage clamps on load, never crashes, and produces a dock warning like other tolerant reads.

## 3. IPC (additive — do not rename existing commands)
- `dock_set_size { width: f64, height: f64 | null } → Result<(), String>` (`null` height = return to auto mode and re-run auto-fit once). Called live during drag (apply) — persistence happens on a trailing `dock_save_position`-style flush at pointerup; define the exact split in the PR but keep it to ≤1 config write per gesture.
- `get_dock_data` includes `window_size` inside `settings` (it already ships the whole `Settings` struct — just extend the struct).
- Keep `dock_resize` signature unchanged; change only its internals (preserve width, retain manual height between expanded views, honor pill/strip collapse).

## 4. Settings UI
- New "Window size" section in `SettingsPanel.svelte`: numeric width input (280–800) + height input-or-“Auto” toggle + "Reset to auto size" button. Live-apply width on input (through the same command, not persisted until Save — mirror the V2 opacity preview pattern: preview without persisting, Save commits, unmount discards).
- Keep the section compact; advanced browser settings stay where they are.

## 5. Acceptance criteria
- [ ] Fresh install: 400px wide, auto height — pixel-identical to today.
- [ ] Drag grip horizontally → width changes live between 280–800, persists across restart, never reset by view/search/settings navigation.
- [ ] Drag grip vertically → height becomes manual, persists, view changes no longer alter it, content scrolls.
- [ ] Double-click grip (or Reset button) → back to auto height; next view change re-fits.
- [ ] Snapped-to-edge + resize → docked edge stays pinned, window never leaves the work area, including multi-monitor (verify on Windows with 125%/150% scaling).
- [ ] Strip mode: no grip, wake restores user width/manual height.
- [ ] Old `config.json` without `window_size` loads as `{400, auto}`; corrupt values clamp with a warning, no crash, no data loss.
- [ ] No new capability entries; no frontend window-API size calls.

## 6. Tests (implementing agent must add)
- Rust: clamp matrix (below-min, above-max, non-finite, off-work-area), manual/auto mode transitions, migration of missing key, one-write-per-gesture persistence.
- Frontend (`test/*.test.mjs`): size-state machine (auto → manual → reset), grip hidden in strip, preview-discard on unmount — mock `invoke`, no Tauri runtime needed.
- Manual on Windows 10/11: drag smoothness, snapped-edge pinning, 125%/150% DPI, multi-monitor move + resize, restart persistence, `auto_hide` strip interplay.

## 7. Explicit non-goals
- No per-view/per-tab sizes, no minimum-content-size auto-grow in manual mode (scroll instead).
- No fullscreen/maximize support (`resizable` stays frameless-driven; do not enable decorations).
- No keyboard-driven resize beyond the Settings numeric inputs (the inputs ARE the a11y path — state if cut).
- No changes to `dock_drag_finished` move-polling beyond reuse.

## 8. Handover checklist
- [ ] Read this file + the file:line references in the header before coding.
- [ ] Keep changes additive; note any deviation (e.g. if `dock_save_position` signature changes) in the PR.
- [ ] Run `npm run check`, Rust `cargo test -p browserdock-launcher` + clippy, `test:ui`/`test:extension`, production build; paste results in PR.
- [ ] State cuts explicitly as follow-ups.
