# BrowserDock current status

Current implementation reviewed and hardened 2026-10-02 for forgiving organization, portable library import/backup, companion bookmark capture, launch previews, browser-aware setup and companion background recovery. Earlier records below remain historical evidence.

## Code review fixes (2026-10-02)

- Restore recovery now preflights every required snapshot before replacing files. A pending journal blocks normal config/vault writes, exports, capture and vault creation/unlock; a running process cannot recover using stale in-memory config. This prevents later recovery from discarding acknowledged edits or restoring inconsistent pairing state. Export serialization is bounded to the 12 MB restore limit and borrows public data rather than cloning large future fields.
- Companion v1.0.11 binds capture drafts to a random connection context, rejecting stale drafts after reconnect, pairing changes or background restart. Desktop capture enforces the 1000-entry public limit, including unreadable entries, while allowing duplicates at the limit. The server wire schema remains compatible; both distributions and Chromium/Gecko/source archives were regenerated.
- Drag completion reloads authoritative scoped data and cannot roll back over a concurrent capture/edit refresh. Stale private reorder/undo replies cannot recreate editors or change new-session undo state; late public saves/deletes cannot close a newer editor. Lock clears private selection metadata, destination-group drafts and profile hints immediately, and old hint replies are ignored.
- Fixed 280 px Settings overflow by constraining grid tracks and allowing tab/content shrinkage. The Library smoke now checks the Settings panel itself for overflow.
- Regression tests reproduced the capture limit/context, pending recovery/export bounds and controller races before fixes. Passed: 116 Rust core tests, 44 UI tests, 107 extension tests, Svelte check with zero diagnostics, production build, Windows MSVC-target app check, touched Rust formatting and `git diff --check`. Organization/portable, existing browser and tree/theme rendered smokes passed. Core Clippy retains the four existing warnings; Windows compilation retains the existing GNU compiler warning.
- Rendered smokes mock desktop IPC. Native Windows file/download/recovery, real-browser companion acceptance, memory and installer validation remain pending.

## Forgiving organization and portable library (2026-10-01)

- Added one-step undo for public/private bookmark deletion and moves, including editor parent/group/order changes. Public snapshots preserve unknown fields and reject intervening changes; private snapshots remain inside the unlocked vault, never enter its payload, and are dropped/zeroized on lock/expiry. Failed writes retain undo. Row selection moves multiple roots/subtrees atomically within one scope, with rollback on failure and private selection cleanup on lock.
- Settings → Library previews inert browser-exported HTML, reports rejected entries, checks duplicate/group counts and atomically imports public bookmarks. Exact destination duplicates are skipped, folder names can become groups, and existing unknown/unreadable public entries are retained. Limits: 4 MB HTML, 1000 links, existing bookmark/group bounds.
- Local JSON library backup retains public bookmark fields/groups and byte-for-byte encrypted vault data; machine settings, browser paths, routing rules and pairing credentials are excluded. Restore previews counts, requires explicit replacement confirmation, optionally replaces the vault, locks private state and keeps local recovery copies. A journal rolls back failed/interrupted two-file restores before startup reads config.
- Passed: 111 Rust core tests (12 new organization/portable tests), 39 UI tests, Svelte check with zero diagnostics, production build, Windows MSVC-target app check, touched Rust formatting and `git diff --check`. New rendered organization/portable smoke and existing browser smoke passed, covering undo, failed bulk moves, stale private completion, inert HTML, preview/commit, backup download, restore confirmation and 280/400/800 px layouts. Core Clippy retains the four existing warnings; Windows check retains the existing GNU compiler warning.
- Rendered smokes mock desktop IPC. Native Windows file selection/download and restore recovery, real browser-export compatibility, foregrounding/tray/DPI, installer and memory acceptance remain pending. Encrypted archive contents are authenticated only on unlock with their original password. No extension protocol or vault/config format changed.

## Capture reply validation (2026-10-01)

- Background and popup now treat missing or malformed save replies as uncertain, disabling repeat saves. Only a valid explicit rejection permits correcting and resubmitting the draft; successful replies must identify SAVED or ALREADY_SAVED.
- Regression tests reproduced the unsafe retry behavior before the fix. Passed: all 106 extension tests and rebuild of both browser distributions. Chromium/Gecko/source archives were regenerated. No Rust or dock UI code changed; native Windows and real-browser acceptance remain pending.

## Companion bookmark capture (2026-10-01)

- Completed companion v1.0.10 toolbar popup: current public HTTP(S) tab, editable title, existing public group/Ungrouped and explicit save. Connection settings remain accessible. Captures retain authenticated browser identity and Firefox/Mullvad container; private tabs are rejected before desktop requests and vault data is never accessed.
- Desktop negotiates `capture_public_v1`, validates current groups/options, appends root bookmarks with atomic config writes and preserves unknown/unreadable public data. Duplicate destinations return unchanged; IDs cannot overwrite other destinations. Successful captures emit an event to refresh the dock.
- Added capture regression coverage for popup sender isolation, private/unsafe tabs, navigation, duplicate and failed writes, stale groups, connection changes and uncertain outcomes. Every interrupted runtime save now disables retries regardless of the browser's exception wording.
- Passed: 104 extension tests, 99 Rust core tests (including five capture tests and live authenticated capture transport), 37 UI tests, Svelte check with zero diagnostics, production build, rendered browser smoke with capture refresh, Windows MSVC app check, touched Rust formatting, distribution rebuild and v1.0.10 extension packaging. Core Clippy completes with only the four existing warnings in unchanged code; the Windows check retains the existing GNU compiler warning.
- Both browser distributions and Chromium/Gecko/source archives are generated. Native Windows and real Firefox/Chrome/Edge/Mullvad popup/container acceptance remain pending; rendered dock tests mock desktop IPC. No memory measurement, installer validation or Mozilla signing was performed.

## Launch preview and browser setup (2026-10-01)

- Expanded search previews Enter for the selected bookmark/URL, resolving browser overrides, profiles, containers and private windows through existing IPC. Site-match hints distinguish switching from opening; uncertain connection/inventory and connected-profile cases say Open or switch. Stale route results and private-state cleanup are guarded.
- Companion setup includes detected/configured or connected browsers and remembers which ones users exclude. Readiness is based on selected browsers, with Connected/Reconnecting/Setup needed states and a configuration shortcut. Test connection performs fresh, instance-scoped control-frame probes against all connected instances of one browser, with a five-second deadline and no tab actions; existing companion versions remain compatible.
- Passed: 37 UI tests, 94 Rust core tests including three new live probe tests, Svelte check, production build, Windows MSVC-target app check and rendered browser smoke covering setup choices, connection-test success/failure, recovery, URL/override previews, stale route replies, vault cleanup and 280/400/800 px layouts. Rust formatting passes. Core Clippy retains the four existing warnings in unchanged code; Windows check retains the existing GNU compiler warning.
- Rendered tests mock desktop IPC; the live Rust tests cover transport. Native Windows foregrounding and real-browser acceptance remain unverified. No extension version or source change was needed for these two features.

## Companion background reliability (2026-10-01)

- Companion v1.0.9 retains the 20-second heartbeat and one-minute recovery alarm, extends missing-reply tolerance to 90 seconds, and reconnects immediately when the alarm replaces a stale socket. Desktop idle eviction is now 120 seconds, avoiding the previous shared 60-second boundary. Five-second command deadlines and no-replay guarantees are unchanged.
- Options expose the last 50 connection events (fixed reason codes, timestamps and optional recovery durations) using browser session storage across background restarts, with memory fallback. No URLs, titles, credentials or raw exceptions are retained. The options page shows reconnecting between attempts; the dock gives recently missing browser instances a bounded 15-second reconnecting indication without retaining their inventory.
- Passed: rebuilt both distributions, 96 extension tests, 32 UI tests, Svelte check with zero diagnostics, production build, Rust core suite including live transport, touched Rust formatting, and the rendered browser smoke including connection loss/recovery. Core Clippy completed with four pre-existing warnings in unchanged code in `pairing.rs`, `ws_server.rs` and `launcher.rs`.
- Verification used an existing Rust toolchain and Chromium runtime libraries under `/tmp`; they are not repository dependencies. The rendered smoke uses mocked desktop IPC. No native Windows run or multi-hour unfocused-browser acceptance was performed, and the original intermittent disconnect cause is not established. Both the desktop and companion need updating for the full timing change; use the options diagnostics during native acceptance.

## Implemented

- Phases 1–7: Windows Tauri dock, routing/config, authenticated companion, encrypted vault, Svelte UI, tray and shortcuts. Preserve `src-tauri/core` as the independently testable library.
- V2: independent visibility controls, opacity preview, public/private groups, migration backups and browser profile/container options.
- V3: persisted width/manual expanded height, live resize with commit/cancel, pill/strip overrides and edge anchoring.
- QA/UI: unused IPC removed, errors surfaced, Windows HTML5 drag enabled, icon/accessibility and narrow-width improvements.
- Companion reliability (v1.0.3): bounded command deadlines, connection-owned queues, negotiated paged inventory, reduced redundant traffic, live pairing status; close-tabs and Edge windowless fallback are documented in SPEC §4.
- Companion lifecycle hardening (v1.0.6, 2026-09-26): the browser alarm actively probes healthy sockets and replaces stale/half-open connections after background suspension or sleep/resume, without replaying ambiguous commands. Real multi-hour Firefox/Chrome acceptance remains pending.
- Browser-aware dock chips (2026-09-26): the collapsed header shows shortcuts only for detected or manually configured browser executables; missing browsers remain configurable in Settings and retain their keyboard override contract.
- Native tab groups (companion v1.0.4): default-on automatic grouping with Settings toggle, group open/close actions, title/color badges, container-aware inventory, feature-detected fallback, bounded batches and private-session cancellation. See [current contract](SPECIFICATION.md#422-native-browser-tab-groups-companion-v104) and [implementation plan](docs/browser-tab-groups-plan.md).
- Cold-start group/subtree open (2026-09-22): ungroupable open batches launch one process per argv chunk with every URL as trailing arguments, then wait bounded (~10 s) for the browser's companion and regroup natively; background-only Edge hands off pre-mutation and focus/group errors name the companion result code. Rust suites for this change still need a Windows run (no toolchain in the Linux sandbox).
- Nested bookmarks: root/child/grandchild trees, validated same-scope parent editing and drag nesting, sibling order, delete/reparent, expansion memory with private cleanup, and explicit subtree opening through the guarded group dispatcher. Normal opening remains one URL; subtree opening allows 50 URLs including the parent. See [implementation plan](docs/deep-groups-plan.md) and SPEC §3.1/§4.3/§5.2.
- Subtree routing (v0.4.0, 2026-09-25): descendants inherit browser/profile/container on nest and through following parent edits, while incognito remains per bookmark and grandfathered divergences expose a Custom/Follow parent editor path. Bulk subtree/group opens and close matching resolve through each top-level root, with solo opens retaining stored child routing. See [implementation plan](docs/subtree-routing-plan.md) and SPEC §3.1/§4.3/§5.2.
- Large-library responsiveness (2026-09-25): section assembly and backend tree validation use indexed linear passes, grouped views reuse their existing trees, native tab-group badges use a per-snapshot lookup, bookmark hosts are parsed once, drag hover reuses the live tree index, and virtual-list scroll updates are coalesced per animation frame without a forced geometry read on every event.
- Appearance: Sage Mint, Nord Frost, Midnight Amber, Tokyo Violet and Rosé Pine, with immediate preview, save/discard, legacy `dark` fallback and shared CSS tokens. See [implementation plan](docs/theme-settings-plan.md) and SPEC §3.1/§5.2.
- UI readability (2026-09-24): the expanded panel and search field gain a background fill as dock opacity drops, while group headings sit closer to their rows. The opacity preview explains this behavior; see SPEC §5.2.
- Codebase reorganization (2026-09-24): Svelte components and helpers live in feature folders, desktop IPC in typed command/event modules, and route state in bookmark, vault, settings, companion and window controllers. Tauri shell commands live under `src-tauri/src/commands/`; extension protocol, inventory, actions and connection source are separate and both browser distributions were rebuilt. IPC names, storage formats and extension message shapes remain unchanged. See SPEC §6.
- Windows packaging: EXE/MSI build automation, bundled companion resources and pairing helpers. See [installer guide](docs/windows-installer.md).

## Remaining acceptance and limitations

### Companion lifecycle verification (2026-09-26)

- Passed: deterministic rebuild of both companion distributions and 93 extension tests, including alarm probes for healthy, stale authenticated and stuck unauthenticated sockets.
- The Rust core suite was not run because `cargo` is unavailable in this Linux environment; the Rust server and wire schema did not change. Real multi-hour Firefox/Chrome testing, sleep/resume and native Windows acceptance remain pending.

### Browser-aware chip verification (2026-09-26)

- Passed: Svelte check with zero diagnostics, 30 UI tests and the production frontend build. The browser smoke fixture covers a Firefox/Edge-only installation and asserts that Mullvad/Chrome chips are absent.
- The rendered browser smoke could not launch in this Linux environment because the available Chromium binary is missing `libnspr4.so`; native Windows rendering remains pending.

The code changes in [SPEC §6](SPECIFICATION.md#6-codebase-reorganization) are implemented. Native Windows acceptance in phase 7 remains pending, so the refactor is not release-accepted. The dependency map below records the phase 1 baseline.

### Refactor baseline (2026-09-24)

| Area | Before refactor | Implemented owner/check |
| --- | --- | --- |
| Public bookmarks, groups, settings and browsers | `+page.svelte` loads and saves through Tauri commands; Rust `lib.rs` and `runtime.rs` read/write the config | Frontend feature folders, typed IPC, route controllers; Svelte check, UI tests, build and rendered smoke |
| Private bookmarks, groups and vault status | `+page.svelte` keeps separate arrays and generation guards; Rust `runtime.rs` owns the session gate and vault | Vault controller and Rust command modules; private-flow smoke and core session tests |
| Startup, summon, hide, resize and keyboard focus | `+page.svelte`, Rust `desktop.rs`, `runtime.rs` and `window_sizing.rs` | Dock controller and shell modules; rendered smoke, Windows target check and native acceptance |
| Search, tree order and opens | `src/lib/search.js`, `trees.js`, `groups.js`, `+page.svelte`; Rust `lib.rs` dispatches through core routing/dispatch | Bookmark feature and typed commands; UI/core tests and smoke |
| Companion polling and events | `+page.svelte` invokes `companion_tabs_digest` every second and listens for four Tauri events; Rust `ws_server.rs` owns loopback transport | Companion controller, typed events, shell commands; UI mocks and core transport tests |
| Extension source/build | `extension/src/core.js` plus `background.js`/`options.js`; `extension/build.mjs` concatenates classic scripts into Chromium/Gecko distributions | Source modules; rebuild, extension tests and Rust protocol tests |

Native Windows foregrounding, tray, DPI, browser profiles/containers/private windows, memory and installer behavior remain acceptance gaps. Relevant commands are `npm run check`, `npm run test:ui`, `npm run build`, rendered smoke with Playwright, `cargo test --locked --manifest-path src-tauri/core/Cargo.toml`, Windows-target app check, `npm run build:extension` and `npm run test:extension`.

### Refactor verification (2026-09-24)

- Passed: Svelte check (zero diagnostics), 27 UI tests, production frontend build, all three rendered smokes (`browser-smoke`, `tab-groups-smoke`, `deep-groups-themes-smoke`), 86 Rust core tests including live JS/Rust transport, Windows MSVC-target app check, touched Rust formatting check, extension rebuild and 90 extension tests.
- Windows-target app Clippy completed with one warning in untouched `runtime.rs` (`needless_borrows_for_generic_args`). The browser smoke was updated to target the actual focusable row button, current Settings tabs and resize controls, and the flat virtualized list; it now passes.
- Rendered smokes use mocked desktop IPC. Cross-compilation does not verify native foregrounding, tray, DPI, browser profiles/containers/private windows, memory or installer behavior. No native Windows acceptance or memory measurement was performed.
- Windows CI exposed a CRLF checkout failure in the extension module import validator. The build now accepts LF and CRLF source, with a Windows-line-ending regression test. The extension rebuild and 91 extension tests pass locally; the Windows CI rerun is pending.

Native Windows checks remain required before release: real browser/profile/container/private-window behavior, foregrounding/minimized windows, shortcuts/panic timing, tray failures, drag/resize/DPI/multi-monitor behavior, memory target and clean install/upgrade/uninstall. See [dock checklist](docs/phase-6-7.md#native-windows-acceptance), [companion checklist](extension/README.md#manual-windows-validation) and [release checklist](docs/windows-installer.md#release-validation).

### Subtree routing verification (2026-09-25)

- Passed: 91 Rust core tests, including nest/edit/un-nest/delete propagation, grandfathered solo versus bulk routing, family-specific option filtering, coerced group close and incognito batch separation; 29 UI tests; Svelte check with zero diagnostics; production frontend build; and the rendered nested-bookmark/theme smoke at 280–800 px with inherited, Custom and Follow parent editor states plus the root-browser tooltip.
- The Windows MSVC-target application check passed with the existing GNU-compiler warning. Core Clippy on Rust 1.98 reached only four existing warnings in untouched `pairing.rs`, `ws_server.rs` and `launcher.rs`; no warning points to this change.
- The rendered smoke uses mocked desktop IPC. Native Windows browser/profile/container/private-window behavior, foregrounding, DPI, memory and installer acceptance remain manual; no extension source or protocol changed, so companion distributions were not rebuilt.

### Large-library performance verification (2026-09-25)

- A local Node synthetic run with 1,000 bookmarks and 50 groups reduced 100 uncached section builds from about 68 ms to 32 ms. Reusing the tree index reduced 500 drag eligibility checks from about 92 ms to 0.1 ms. With 2,000 unmatched companion tabs, indexing reduced 1,050 native-group lookups from about 21 ms to 5 ms including index construction. These timings are comparative development measurements, not Windows acceptance data.
- Passed: 91 Rust core tests, 29 UI tests, Svelte check with zero diagnostics, production frontend build, Windows MSVC-target app check, and all three rendered browser, nested-bookmark/theme and tab-group smokes.

The 2026-09-24 readability change passed Svelte check, 27 UI tests, production build and the rendered nested-bookmark/theme smoke at 280–800px, including the 30% opacity surface check. Desktop IPC was mocked; contrast over arbitrary desktop windows and native Windows rendering still need visual acceptance.

Chromium companion profile hints do not enforce a profile. Pairing tokens are plaintext bearer credentials protected by user ACLs; DPAPI wrapping is a follow-up. The vault does not protect browser history/process memory or copied ciphertext against offline guessing. See SPEC §3–4 and the dock security boundary.

## Current nested-bookmark and theme verification (2026-09-22)

- Passed: 80 Rust core tests (including 7 nested-bookmark tests and live JS/Rust transport), 27 UI tests, Svelte check with zero diagnostics, production frontend build, and Windows MSVC-target app cross-check.
- Rendered [nested-bookmark/theme smoke](test/deep-groups-themes-smoke.mjs) passed parent-only/subtree opens, focused-row and search keyboard shortcuts, expansion persistence, flat search with parent badges, parent editing, drag hover intent/cancel/scope checks, failed-move rollback, private lock/stale completion cleanup, all five themes, preview/save/discard, opacity, 280/400/800px layout and touch controls. The smoke waits for the opacity transition and tolerates browser alpha rounding. Desktop IPC is mocked; native behavior is not established by this check.
- Touched Rust files pass formatting checks. Core Clippy completes with the two existing warnings in untouched `pairing.rs` and `launcher.rs`; the Windows cross-check retains the existing GNU-compiler warning. No companion source changed in this completion pass; extension counts below are earlier evidence.
- Theme token tests check foreground, muted and button contrast against opaque base colors only. Transparency over arbitrary desktop backgrounds, native Windows drag/DPI/foregrounding, real browser grouping, memory usage and installer acceptance remain pending. No new memory measurement or installer build was performed.

## Earlier tab-group verification (2026-09-22)

- Fixed collapsed-group fallback: when native grouping is unavailable or fails, activate the first opened/reused tab. Successful collapsed groups retain their collapsed behavior; requests are still never replayed.
- Passed: 83 extension tests, 20 UI tests, 8 Rust tab-group tests, Svelte check (zero diagnostics), and production frontend build. The new fallback regression failed before the fix and passed afterward. Both companion distributions were rebuilt.
- Native Windows/browser acceptance remains pending. The prior rendered smoke, full core suite and Windows cross-check below were not rerun for this companion-only fix.

## Earlier tab-group verification (2026-09-20)

- Passed: 72 Rust core tests (including live JS/Rust transport and 8 group tests), 81 extension tests, 20 UI tests, Svelte check (zero diagnostics), production frontend build, and Windows app cross-check.
- Rendered [tab-group smoke](test/tab-groups-smoke.mjs) passed open/close IPC, failure notice, native badges, settings persistence, private lock handling and 280/400/800 px header layout using mocked desktop IPC. Run against `npm run dev` with Playwright installed; it does not replace native browser acceptance.
- Touched Rust files formatted. Core Clippy completed with two existing warnings in untouched `pairing.rs` and `launcher.rs`; no new warnings. Windows cross-check used the available `/tmp` Rust/LLVM tooling and emitted the existing GNU-target build warning. Loopback tests and Chromium smoke required execution outside the sandbox.
- Chromium and Gecko distributions rebuilt. Reload companion v1.0.4 and accept the new `tabGroups` permission. Real Firefox/Chrome/Edge/Mullvad grouping, collapsed-state behavior, private/container windows, permission upgrades and native memory remain acceptance work. Batches are limited to 50 bookmarks and are not atomic; failures can leave partial work without retry.

## Recorded evidence

These are historical results, not current pass guarantees:

| Record | Evidence and limits |
| --- | --- |
| [QA resolution, 2026-09-13](docs/PRE-HANDOVER-REVIEW.md) | 49 core / 9 UI / 33 extension tests, Svelte/build/smoke and Windows check/Clippy passed; native acceptance pending |
| [UI pass, 2026-09-15](docs/UI-OPTIMIZATION-HANDOVER.md) | 13 UI tests, Svelte/build/rendered smoke passed; native visual/accessibility checks pending |
| [Companion reliability pass](docs/companion-improvements-plan.md) | 64 core / 18 UI / 61 extension tests, Svelte and Windows check passed; real extension smoke blocked by Linux libraries |

Earlier missing-`llvm-rc` reports were superseded by successful Windows cross-checks. Temporary `/tmp` tooling may no longer exist; inspect the environment before reuse. Run checks appropriate to the next change and record actual results/limits here when status changes. Historical plans are indexed in [docs/README.md](docs/README.md); their unchecked boxes do not mean features are missing.
