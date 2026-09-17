# BrowserDock Improvements V2 — Handover Spec for Implementing Agent

**Status:** Draft for implementation (hand to next AI agent)
**Date:** 2026-09-13
**Base version:** `0.1.0` (`SPECIFICATION.md` v1.0.0, `config.json` version `"1.0.0"`)
**Scope:** 4 user-reported items. No crypto-scheme changes. No telemetry changes (all traffic stays on `127.0.0.1`).

Related files (verify before coding):
- Post-launch hide: `src/routes/+page.svelte:192-222` (`open()` → `dock_hide`), `src-tauri/src/desktop.rs:20-25,231-256`, `src-tauri/src/lib.rs:39-60`
- Settings: `src/lib/SettingsPanel.svelte`, `src/lib/types.ts:16-22`, `src-tauri/src/runtime.rs:22-63,306-361`, `src-tauri/src/config.rs:47-83`
- Bookmarks/list: `src/lib/BookmarkList.svelte`, `src/lib/BookmarkEditor.svelte`, `src-tauri/src/vault.rs:12-51` (Bookmark), `src-tauri/src/runtime.rs:210-305`
- Launch/routing: `src-tauri/src/launcher.rs`, `src-tauri/src/dispatch.rs`, `src-tauri/src/config.rs:11-45` (Browser), extension protocol in `SPECIFICATION.md §4`, `src-tauri/src/ws_protocol.rs`, `src-tauri/src/ws_server.rs`
- Styling: `src/app.css:4-10` (`--surface: #171c1ef5`), `src/routes/+page.svelte:619-646` (`main` pill styles)

**Conventions carried over:** memory <40 MB, Tauri v2 + Svelte 5 + Tailwind, `config.json` at `%APPDATA%/BrowserDock/config.json`, `vault.enc` binary layout unchanged (salt[0..16] + nonce[16..28] + ct||tag), `FOCUS_OR_OPEN` field names are authoritative (do not rename existing fields).

---

## 1. Fix: "Always on top" ≠ "auto-hide on open"

### 1.1 Problem
Dock hides every time a link is opened even when Settings → "Always on top" is ON. User expectation: with Always-on-top ON the dock should stay visible after launch.

### 1.2 Root cause (current behavior)
- `always_on_top` only controls Win32 z-order (`WS_EX_TOPMOST` via `window.set_always_on_top`, see `src-tauri/src/runtime.rs:347-349`, `src-tauri/src/desktop.rs:205-207`). It never meant "stay visible".
- `open()` in `src/routes/+page.svelte:204-216` **unconditionally** clears the query, collapses, sets `dockVisible=false`, and calls `invoke("dock_hide")` on every successful launch. There is no setting gating this.
- Copy in `SettingsPanel.svelte:37-42` ("Keep the dock within reach") reinforces the confusion.

### 1.3 Required behavior
Split into three orthogonal settings:

| Setting | Meaning | Default |
|---|---|---|
| `always_on_top` (existing) | Window z-order topmost | `true` (unchanged) |
| `hide_on_open` (**new**) | Hide dock window after a successful `open_url` | `true` (preserves current behavior) |
| `auto_hide` (existing) | Collapse to thin strip on pointer-leave when idle | `false` (unchanged) |

Rules:
1. After successful `open_url`: if `hide_on_open == true` → current behavior exactly (clear query/override, `expanded=false`, `dock_hide`). If `false` → do NOT call `dock_hide`; keep window visible and focused; still clear `query`/`override`; show `notice="Opened in <browser>"`; keep `expanded` as-is (if expanded, stay expanded; if pill-only, stay pill). Never steal focus back from the browser beyond current behavior (don't call `set_focus` after launch).
2. Failed launch → never hide, regardless of `hide_on_open`; show `error` as today.
3. `Esc` single-press → hide (unchanged, `dock_escape`). Tray Show/Hide → unchanged. `auto_hide` strip logic (`enter()`/`leave()` in `+page.svelte:321-340`) unchanged and independent.
4. Update Settings copy: "Always on top" sublabel → "Keep window above other windows (z-order)". New toggle: "Hide after opening link" sublabel → "Hide the dock every time a link is opened. Turn off to keep it on screen."

### 1.4 Schema / code changes
- `config.json` default settings add `"hide_on_open": true`. `Settings::from_config` (`runtime.rs:31-63`) and TS `Settings` (`src/lib/types.ts:16-22`) add `hide_on_open: boolean` with `unwrap_or(true)` fallback for old configs (backward compatible, no migration prompt).
- `save_settings` validation unchanged except persisting the new key (generic map insert already covers it — verify).
- `+page.svelte:open()` gates the `dock_hide` block on `settings.hide_on_open`.
- `SettingsPanel.svelte` adds the toggle bound to `form.hide_on_open`.

### 1.5 Acceptance criteria
- [ ] Fresh install: opening a link hides dock (default `true`).
- [ ] `hide_on_open=false` + `always_on_top=true`: opening link keeps dock visible, notice shows target browser, query cleared, no `dock_hide` IPC emitted.
- [ ] `hide_on_open=false` + failed launch (bad exe path): error shown, dock stays visible.
- [ ] Toggling `always_on_top` alone never changes hide behavior; toggling `hide_on_open` never changes z-order.
- [ ] Old `config.json` without the key loads fine and behaves as `true`.

---

## 2. Setting: interface opacity

### 2.1 Requirement
User-configurable dock opacity in Settings, live preview, persisted across restarts, applies to both pill and expanded panel.

### 2.2 Design decisions (implementing agent: follow exactly)
- **CSS-only implementation.** Do NOT use OS window-opacity APIs (keeps it cross-platform, avoids WebView2 transparency pitfalls; `transparent:true` + `shadow:false` in `tauri.conf.json` stays as-is).
- Range `0.30–1.00`, step `0.05`, default `1.00`. Stored as float `settings.opacity`.
- Apply as `background` alpha, NOT `opacity:` on `main` — full-element `opacity` would wash out text and break contrast. Implementation: derive surface color from existing `--surface: #171c1ef5`:
  - Introduce `--dock-opacity` (the setting value) and compute `main { background: color-mix(in srgb, #171c1e calc(var(--dock-opacity)*100%), transparent) }` with fallback `background: var(--surface)` for runtimes without `color-mix`. Border stays opaque for legibility.
  - Alternative if `color-mix` is rejected in review: set inline `style="--dock-opacity: X"` on `main` and use `rgba(23,28,30,calc(0.96 * X))`-style background. Either is acceptable; do not set `main{opacity:X}`.
- Respect `prefers-reduced-motion`: opacity change must be instant (no transition) under reduced motion; otherwise a ≤120 ms transition is allowed.

### 2.3 Schema / code changes
- `config.json` defaults add `"opacity": 1.0`. Rust `Settings` struct + `from_config` add `opacity: f64` with `as_f64().unwrap_or(1.0).clamp(0.3, 1.0)`. TS `Settings` adds `opacity: number`. `save_settings` rejects values outside `0.3–1.0` with `"Opacity must be 30–100%"`.
- `SettingsPanel.svelte`: slider `<input type="range" min="30" max="100" step="5">` + numeric `%` readout bound to `Math.round(form.opacity*100)`, live-updates a preview swatch. Save persists; changing slider before Save previews only (do not persist on input).
- `+page.svelte` / `app.css`: bind `--dock-opacity` from `settings.opacity`; load path (`loadPublic` → `settings`) must apply it immediately on startup.
- Old configs without key → `1.0`.

### 2.4 Acceptance criteria
- [ ] Slider 30–100% persists to `config.json` and survives restart.
- [ ] 100% == today's look; 30% still keeps text readable (borders/text not faded, only panel background translucent).
- [ ] Out-of-range values in hand-edited `config.json` clamp to range, never crash.
- [ ] Reduced-motion users see instant change, no animation.

---

## 3. Feature: bookmark groups + drag & drop between groups

### 3.1 Requirement
Group concept for bookmarks ("tabs" in user's words = dock entries). Users create/rename/delete groups, drag & drop bookmarks between groups, reorder within a group. Works for public and vault (private) bookmarks.

### 3.2 Data model
```json
// config.json additions (public scope)
"groups": [
  { "id": "grp-work", "name": "Work", "color": "#b8edc9", "sort_order": 0, "collapsed": false },
  { "id": "grp-daily", "name": "Daily", "color": "", "sort_order": 1, "collapsed": false }
]
// bookmark additions (public bookmarks[] AND vault payload)
{ "id": "bm-1", "title": "GitHub", "url": "...", "target_browser": "firefox",
  "tags": [], "icon": "github", "group_id": "grp-work", "sort_order": 0 }
```
Rules:
- `group_id: string | null` (`null`/missing = "Ungrouped", always rendered last). `sort_order: u32` (stable order within group; ties broken by `title` asc, then `id` asc).
- Public groups live in `config.json`. **Private groups must live inside `vault.enc`**, not `config.json` (otherwise group names leak metadata about private bookmarks). Vault plaintext JSON evolves from `Bookmark[]` to envelope `{ "bookmarks": [...], "groups": [...] }`; reader MUST accept both (legacy array → `groups: []`, all `group_id: null`).
- Limits: ≤50 groups per scope, name 1–64 chars, colors optional hex. Deleting a group moves its bookmarks to Ungrouped (never deletes bookmarks implicitly).
- `config.version`: bump to `"1.1.0"`. `Config::validate` accepts `"1.0.0"` and `"1.1.0"`; on load of `1.0.0`, backfill `groups: []`, `group_id: null`, `sort_order: index`, then save as `1.1.0`. Vault envelope gets its own inner `version: 1` → `2` with the same tolerant reader.

### 3.3 IPC (additive — do not rename existing commands)
- `save_group { group, private: bool }`, `delete_group { id, private: bool }` (reassigns to Ungrouped), `move_bookmark { id, group_id: string|null, index: u32, private: bool }` (reorders; backend renormalizes `sort_order` 0..n).
- `get_dock_data` returns `groups: Group[]`; `vault_list` returns `{ bookmarks, groups }` (or keep returning bookmarks + add `vault_groups` — pick one and document; frontend must handle both during transition — prefer single envelope change with legacy fallback).
- All mutations validate: group exists (unless null), index clamped, vault ops require unlocked gate (`state.gate.valid`), private ops call `notify_lock` like `save_bookmark` does.

### 3.4 UI/UX
- Collapsed pill/search behavior unchanged. Expanded panel → grouped sections when query is empty: group header (color dot, name, count, collapse chevron, drag target highlight) + cards. When query non-empty → flat filtered list (as today) with small group-name badge per row.
- Drag & drop: HTML5 `draggable` rows + group drop zones; support touch/pointer fallback via existing edit flow (BookmarkEditor gains a "Group" `<select>` including Ungrouped — this is also the keyboard/a11y path). During drag: highlight target group, show insertion line; on drop call `move_bookmark`; on failure, revert order and show error (optimistic update with rollback).
- Group management UI: "＋ Group" button in panel nav (next to Add bookmark); inline rename on double-click or via small popover; delete with confirm (bookmarks → Ungrouped). `sort_order` of groups: drag group headers to reorder (nice-to-have; at minimum provide up/down in group editor if header DnD is cut — state the cut explicitly in PR).
- Search (`search.js`/`fuse.js`): group names participate as a low-weight fuzzy key; `openInBrowser` dot logic unchanged.

### 3.5 Acceptance criteria
- [ ] Create/rename/delete/reorder groups (public + locked-vault scope separately); persists across restart.
- [ ] Drag bookmark A from Group X to Group Y (same scope) → persists; drag within group reorders → persists.
- [ ] Deleting Group X keeps its bookmarks under Ungrouped.
- [ ] Search with query still finds items regardless of group; group badge shown.
- [ ] Vault locked → private groups/bookmarks fully unmounted (same zeroize discipline as today); no group names in `config.json` or logs.
- [ ] Legacy `config.json` v1.0.0 and legacy vault array payload migrate silently, no data loss.
- [ ] Keyboard-only user can move a bookmark between groups via BookmarkEditor select.

---

## 4. Feature: per-browser launch options — Firefox containers & Chrome/Edge profiles

### 4.1 Requirement
Per-browser (and per-bookmark override) launch options. User examples: open in Firefox "work" container tab; open in Chrome "Ray" profile.

### 4.2 Key platform facts (do not re-discover; design around them)
- **Chrome/Edge profiles ARE selectable via CLI**: `--profile-directory="Profile 1"` (or `"Default"`). Must be passed on process spawn before the URL. Profile names are directory names under the browser user-data dir — free-text with a datalist hint, not a hardcoded enum. If the browser is already running under a different profile, Chromium may ignore the flag and open in the running profile — this is a Chromium limitation; document it in UI hint text.
- **Firefox/Mullvad containers CANNOT be selected via CLI.** Containers (`contextualIdentities`, `cookieStoreId`) require the companion WebExtension: `tabs.create({ url, cookieStoreId })` / `tabs.query` filtering by `cookieStoreId`. Therefore container support = extension + WS protocol work, with CLI fallback = plain open (and a user-visible note "container needs companion connected").
- Mullvad Browser spoofs UA — extension must keep using explicit `browser` id (already required by SPEC §2.4), never UA sniffing.

### 4.3 Data model
```json
// per-browser defaults (config.json browsers[])
{ "id": "chrome", "name": "Google Chrome", "exe_path": "...", "args": [],
  "color": "#4285F4",
  "profile": "Profile 1",
  "extra_args": ["--disable-features=Foo"] }
// per-bookmark override (public bookmarks[] AND vault Bookmark)
{ "id": "bm-9", "title": "Docs", "url": "https://docs.google.com",
  "target_browser": "chrome",
  "browser_options": { "profile": "Ray", "container": null, "incognito": false } }
```
- `Browser` gains `profile?: string` (Chrome/Edge only; ignored for Gecko), `extra_args?: string[]` (advanced, appended after `args`). Keep `args` for compat.
- `Bookmark` gains `browser_options?: { profile?: string, container?: string, incognito?: bool }`. Resolution precedence: bookmark option → browser default → none. `container` only honored for `firefox`/`mullvad`; `profile` only for `chrome`/`edge`; mismatched keys are ignored (not errors) but surfaced as hints in the editor.
- Validation: profile/container names 1–128 chars, charset `[A-Za-z0-9 _.-]`; `incognito` → Chromium `--incognito` / Firefox `-private-window` (new window semantics — warn user it bypasses tab-focus reuse).
- `routing_rules[]` MAY optionally gain `browser_options` in this version — RECOMMENDED to include if cheap (same shape), because users route `*.google.com → chrome/Ray`. If cut, state it as follow-up.

### 4.4 Backend (`launcher.rs` / `dispatch.rs` / `config.rs`)
- `LaunchPlan` gains `resolved_profile/containers/incognito` for observability (no URL logging — existing `build_command` discipline stays).
- `build_command`: for Chromium targets with resolved profile → insert `--profile-directory=<profile>` before URL; with `incognito` → `--incognito`; append `extra_args` (cap 20 items, 256 chars each, reject shell metachars — args are passed as argv, never shell). For Firefox `incognito` → `-private-window` (document: forces new window, skips companion focus path).
- `dispatch::open_url` signature gains the resolved options (from bookmark if `open_url` is called with a bookmark id, else from routing/browser default — see IPC). Companion-first path retained: if companion handles it, CLI flags are skipped (correct — flags only matter for cold start).
- `Config::validate`: unknown `target_browser` still errors (existing); profile/container charset validated; `firefox` fallback requirement unchanged.

### 4.5 Extension + WS protocol (additive)
- `FOCUS_OR_OPEN` gains optional `container?: string` (container name or cookieStoreId) and `profile?: string` (hint for display/routing only). Existing fields unchanged. Example:
  ```json
  { "id": "req-101", "action": "FOCUS_OR_OPEN", "url": "https://example.com",
    "match_mode": "domain_or_exact", "container": "work", "profile": "Ray" }
  ```
- Gecko extension: needs `contextualIdentities` permission in its manifest variant only (never into Chromium MV3 manifest — single combined manifest is already forbidden by SPEC §4.1). Resolve name→`cookieStoreId` via `contextualIdentities.query`; match existing tabs by domain AND `cookieStoreId`; create with `tabs.create({url, cookieStoreId})`. If container missing/not found → `result: "ERROR_CONTAINER_NOT_FOUND"`, fallback: backend opens plain tab (and UI notes it).
- Chromium extension: `profile` is informational; tab ops unchanged. Multi-profile targeting beyond "whichever instance is connected" is out of scope — document: "for reliable Chrome profiles, keep a companion installed in each profile; cold-start CLI flag handles the rest."
- `TABS_SYNC` gains optional `cookieStoreId` per tab (Gecko only) so the dock's open-dot can distinguish same-URL-different-container. Cap sizes per SPEC §4.2 stay.

### 4.6 UI
- `BookmarkEditor.svelte`: "Open with" browser select stays; add contextual second row: if Chromium → "Profile" text input + datalist (Default, Profile 1, Ray, …) + "use browser default" empty state; if Gecko → "Container" text input (placeholder `e.g. work`) + hint "Requires companion extension; plain tab otherwise". Add "Private/incognito" checkbox with warning about focus-reuse bypass.
- Settings gains a "Browsers" section (new or extended `SettingsPanel`): per-browser `exe_path` (read-only hint if registry-detected), `profile` (Chromium), `extra_args` (advanced, monospace). Keep it collapsed/advanced to avoid overwhelming users.
- Result rows + URL-preview row show resolved target as `chrome · Ray` / `firefox · work` instead of bare id (update `route-name`/`target` rendering in `+page.svelte` and `BookmarkList.svelte`).
- `Alt+1..4` overrides unchanged; `route_url` preview should reflect resolved defaults (return `{ browser, profile, container }` or keep string + add `route_details` command — pick one, keep `route_url` backward compatible).

### 4.7 IPC sketch (finalize names in PR, keep additive)
- `open_url { url, browser_id?, forceNewTab?, bookmark_id? }` — backend resolves bookmark → options → target. If `bookmark_id` omitted, resolve from routing rule + browser defaults.
- `route_url` unchanged + new `route_details { url, browser_id? } → { browser_id, profile?, container? }`.
- New `browser_profiles { browser_id } → string[]` (best-effort: parse Chromium `Local State` for profile dirs; Firefox: list containers via companion `CONTAINERS_LIST` or return [] when disconnected — never fail hard).

### 4.8 Acceptance criteria
- [ ] Chrome bookmark with profile "Ray": cold start spawns with `--profile-directory="Ray"`; when companion connected and tab open in that instance → focuses (documented limitation otherwise).
- [ ] Firefox bookmark with container "work": companion connected → opens/focuses tab in `work` container; companion disconnected → plain open + notice "Container needs companion; opened normally".
- [ ] Unknown container name → `ERROR_CONTAINER_NOT_FOUND` → fallback open + visible note, no crash.
- [ ] Per-bookmark option overrides browser default; empty option uses default.
- [ ] Hand-edited invalid profile/container chars rejected with clear error at save.
- [ ] No URLs, profiles-as-secrets, or PINs in logs (keep existing null-stdio + no-log discipline).

---

## 5. Cross-cutting requirements (all 4 items)

1. **Migration safety:** never lose bookmarks on upgrade. `config.json` tolerant reader (missing keys → defaults above); backup `config.json.bak.<timestamp>` before any version bump write. Vault envelope tolerant reader (array or envelope).
2. **Security:** no PIN/secret logging; private groups/options stay inside `vault.enc`; `auth_token` handling unchanged; lock/zeroize paths cover new in-memory group/option structs (`Drop` zeroize where secrets adjacent — profiles/containers are not secrets but keep them out of logs anyway).
3. **Tests (implementing agent must add/update):**
   - Rust (`src-tauri/core/tests/` + unit): settings defaults/back-compat (hide_on_open, opacity clamp), group CRUD/move/renumber, migration v1.0.0→1.1.0, profile/container validation + argv building (`--profile-directory` position before URL, metachar rejection), container routing precedence.
   - Frontend (`test/*.test.mjs`, `extension/test/*.test.mjs`): opacity slider persistence mock, grouped move optimistic-rollback, `FOCUS_OR_OPEN` with container + `TABS_SYNC` with `cookieStoreId`, `route_details` display `browser · profile`.
   - Manual on Windows 10/11: Always-on-top z-order vs hide matrix; opacity 30/100; drag between groups (mouse + keyboard); Firefox container + Chrome profile cold-start vs companion-focus.
4. **Docs to update in the same PR:** `SPECIFICATION.md` (§3.1 settings/browsers/bookmarks/groups, §4.2 protocol options, §5 UX), the Builder Skill runbook if it duplicates schemas, and `README.md` settings table if present.
5. **Suggested implementation order:** (1) hide_on_open — smallest, (2) opacity — small, (3) groups — largest UI, (4) profiles/containers — largest backend+extension. Ship (1)+(2) first if splitting PRs.

## 6. Explicit non-goals
- No tab-group sync *from* browsers into the dock (groups are dock-side bookmark organizers, not browser tab-group mirrors).
- No per-profile separate `exe_path`; profiles share the browser binary.
- No container support for Chromium, no Chrome-profile enforcement on warm tabs beyond connected instance.
- No opacity below 30% (legibility floor), no per-group opacity.

## 7. Handover checklist for implementing agent
- [ ] Read `SPECIFICATION.md`, this file, and the file:line references in the header before coding.
- [ ] Implement §1 + §2 first, demo, then §3, then §4.
- [ ] Keep every IPC/protocol change additive; note any deviation in the PR.
- [ ] Run `npm run check`, Rust tests, and `test:ui`/`test:extension` suites; paste results in PR.
- [ ] State clearly what was cut (e.g., routing-rule options, group-header drag reorder, `browser_profiles` listing) as follow-ups.
